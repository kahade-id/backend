import { Injectable, BadRequestException, NotFoundException, ForbiddenException, ConflictException, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service';
import { RedisService } from '../../redis/redis.service';
import { RealtimeService } from '../realtime/realtime.service';
import { FeeCalculatorService } from './fee-calculator.service';
import { OrderStatus, KycStatus, FeeResponsibility, DeadlineExtensionStatus, ActorType, OrderType, SubscriptionStatus, NotificationType, Prisma, Voucher } from '@prisma/client';
import { generateOrderId } from '../../common/utils/id-generator.util';
import { toSen, toIdr } from '../../common/utils/currency.util';
import { safeBigIntToNumber } from '../../common/utils/bigint.util';
import { addDays, formatWIBDate, toWIB } from '../../common/utils/date.util';
import { ORDER_SERIAL, ORDER_AVG_DURATIONS_CACHE } from '../../common/constants/redis-keys';
import { NotificationQueueService } from '../queue/notification-queue.service';
import * as ErrorCodes from '../../common/constants/error-codes';
import { CONFIRMATION_DEADLINE_DAYS, KYC_THRESHOLD, CONFIRMATION_DEADLINE_DAYS_MAP, ORDER_MIN_VALUE, ORDER_MAX_VALUE, DELIVERY_DEADLINE_DAYS_MIN, DELIVERY_DEADLINE_DAYS_MAX, POST_COMPLETION_DISPUTE_WINDOW_HOURS } from '../../common/constants/app.constants';

function escapeLikePattern(pattern: string): string {
  return pattern.replace(/[%_\\]/g, '\\$&');
}

const ORDER_COUNTERPART_COOLDOWN_SECONDS = 60;

function getConfirmationDeadlineDays(orderType: OrderType): number {
  return CONFIRMATION_DEADLINE_DAYS_MAP[orderType] ?? CONFIRMATION_DEADLINE_DAYS;
}

const ORDER_CREATE_MAX_RETRIES = 3;
const ORDER_TRANSITION_MAX_RETRIES = 3;

@Injectable()
export class OrdersService {
  private readonly logger = new Logger(OrdersService.name);

  private readonly configuredMinOrderValue: number;
  private readonly configuredMaxOrderValue: number;

  constructor(
    private prisma: PrismaService,
    private redis: RedisService,
    private realtime: RealtimeService,
    private feeCalculator: FeeCalculatorService,
    private configService: ConfigService,
    private notificationQueue: NotificationQueueService,
  ) {
    this.configuredMinOrderValue = this.configService.get<number>('app.orderMinValue') ?? ORDER_MIN_VALUE;
    this.configuredMaxOrderValue = this.configService.get<number>('app.orderMaxValue') ?? ORDER_MAX_VALUE;
  }

  private isRetryableDbError(error: unknown): boolean {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2034') return true;
    if (error instanceof Prisma.PrismaClientUnknownRequestError) {
      const message = error.message.toLowerCase();
      return message.includes('40001') || message.includes('serialization') || message.includes('40p01') || message.includes('deadlock');
    }
    return false;
  }

  private async withSerializableRetry<T>(operation: () => Promise<T>, label: string): Promise<T> {
    for (let attempt = 1; attempt <= ORDER_TRANSITION_MAX_RETRIES; attempt++) {
      try {
        return await operation();
      } catch (error: unknown) {
        if (!this.isRetryableDbError(error) || attempt === ORDER_TRANSITION_MAX_RETRIES) {
          if (this.isRetryableDbError(error)) this.logger.error(`${label} failed after ${attempt} attempts`, error instanceof Error ? error.stack : String(error));
          throw error;
        }
        this.logger.warn(`${label} retrying attempt=${attempt}/${ORDER_TRANSITION_MAX_RETRIES}`);
        await new Promise((resolve) => setTimeout(resolve, 100 * Math.pow(2, attempt - 1)));
      }
    }
    throw new Error(`${label}: retry loop exhausted`);
  }

  private enqueueOrderNotificationBestEffort(payload: Parameters<NotificationQueueService['enqueue']>[0], context: string): void {
    void this.notificationQueue.enqueue(payload).catch((error: unknown) => {
      this.logger.warn(`${context} notification enqueue failed: ${error instanceof Error ? error.message : String(error)}`);
    });
  }

  private runRealtimeBestEffort(task: () => void, context: string): void {
    try {
      task();
    } catch (error: unknown) {
      this.logger.warn(`${context} realtime side effect failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async createOrder(
    userId: string,
    dto: {
      role: 'BUYER' | 'SELLER';
      counterpartUsername: string;
      title: string;
      description: string;
      orderType: OrderType;
      orderValue: number;
      deliveryDeadlineDays: number;
      feeResponsibility: FeeResponsibility;
      voucherCode?: string;
    },
  ): Promise<{
    orderId: string;
    status: OrderStatus;
    feeCalculation: {
      feeRate: number;
      feeAmount: number;
      buyerFeeAmount: number;
      sellerFeeAmount: number;
      buyerPayAmount: number;
      sellerReceiveAmount: number;
      voucherDiscount: number;
    };
    confirmationDeadlineAt: Date | null;
  }> {
    if (!Number.isSafeInteger(dto.orderValue) || dto.orderValue < this.configuredMinOrderValue || dto.orderValue > this.configuredMaxOrderValue) {
      throw new BadRequestException({
        code: ErrorCodes.VALIDATION_ERROR,
        message: `Order value must be between Rp ${this.configuredMinOrderValue.toLocaleString()} and Rp ${this.configuredMaxOrderValue.toLocaleString()}`,
      });
    }

    if (!Number.isSafeInteger(dto.deliveryDeadlineDays) || dto.deliveryDeadlineDays < DELIVERY_DEADLINE_DAYS_MIN || dto.deliveryDeadlineDays > DELIVERY_DEADLINE_DAYS_MAX) {
      throw new BadRequestException({
        code: ErrorCodes.VALIDATION_ERROR,
        message: `Delivery deadline must be between ${DELIVERY_DEADLINE_DAYS_MIN} and ${DELIVERY_DEADLINE_DAYS_MAX} days`,
      });
    }

    const sanitizedTitle = (typeof dto.title === 'string' ? dto.title : '').replace(/[<>"'&]/g, '').trim();
    const sanitizedDescription = (typeof dto.description === 'string' ? dto.description : '').replace(/[<>"'&]/g, '').trim();
    if (sanitizedTitle.length < 3 || sanitizedTitle.length > 100) {
      throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Order title must be between 3 and 100 characters after sanitization' });
    }
    if (sanitizedDescription.length < 10 || sanitizedDescription.length > 500) {
      throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Order description must be between 10 and 500 characters after sanitization' });
    }

    const KYC_THRESHOLD_IDR = KYC_THRESHOLD;

    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { id: true, isActive: true, isBanned: true, kycStatus: true, isKahadePlus: true, totalOrdersCompleted: true, fullName: true, username: true } });
    if (!user) throw new NotFoundException({ code: ErrorCodes.USER_NOT_FOUND, message: 'User not found' });
    if (!user.isActive || user.isBanned) {
      throw new ForbiddenException({ code: ErrorCodes.COUNTERPART_SUSPENDED, message: 'Your account is suspended' });
    }

    const rateLimitKey = `order_create_rate:${userId}`;
    const client = this.redis.getClient();
    const redisRateLimitKey = `${this.redis.getPrefix()}${rateLimitKey}`;
    const rateLimitScript = `
      local current = redis.call("INCR", KEYS[1])
      if current == 1 then
        redis.call("EXPIRE", KEYS[1], ARGV[1])
      end
      return current
    `;
    const rateLimit = this.configService.get<number>('app.orderCreateRateLimit') ?? 5;
    const rateWindowSec = this.configService.get<number>('app.orderCreateRateWindowSec') ?? 60;
    const orderRateCount = await client.eval(rateLimitScript, 1, redisRateLimitKey, String(rateWindowSec)) as number;
    if (orderRateCount > rateLimit) {
      throw new BadRequestException({ code: ErrorCodes.RATE_LIMIT_EXCEEDED, message: 'Too many order creation attempts. Please wait before trying again.' });
    }

    if (dto.orderValue >= KYC_THRESHOLD_IDR && user.kycStatus !== KycStatus.APPROVED) {
      throw new ForbiddenException({ code: ErrorCodes.KYC_REQUIRED, message: 'KYC verification required for orders of Rp 2.000.000 and above' });
    }

    const normalizedCounterpartUsername = typeof dto.counterpartUsername === 'string' ? dto.counterpartUsername.trim().toLowerCase() : '';
    if (normalizedCounterpartUsername.length < 3 || normalizedCounterpartUsername.length > 50) {
      throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Counterpart username must be between 3 and 50 characters' });
    }
    const counterpart = await this.prisma.user.findUnique({ where: { username: normalizedCounterpartUsername } });
    if (!counterpart) throw new NotFoundException({ code: ErrorCodes.USER_NOT_FOUND, message: 'Counterpart not found' });
    if (!counterpart.isActive || counterpart.isBanned) {
      throw new ForbiddenException({ code: ErrorCodes.COUNTERPART_SUSPENDED, message: 'Counterpart account is suspended' });
    }
    if (counterpart.id === userId) throw new BadRequestException({ code: ErrorCodes.CANNOT_ORDER_SELF, message: 'Cannot create order with yourself' });
    if (dto.orderValue >= KYC_THRESHOLD_IDR && counterpart.kycStatus !== KycStatus.APPROVED) {
      throw new ForbiddenException({ code: ErrorCodes.KYC_REQUIRED, message: 'Counterpart must complete KYC verification for orders of Rp 2.000.000 and above' });
    }

    const cooldownKey = `order_counterpart_cooldown:${[userId, counterpart.id].sort().join(':')}`;
    const cooldownAcquired = await this.redis.setNx(cooldownKey, '1', ORDER_COUNTERPART_COOLDOWN_SECONDS);
    if (!cooldownAcquired) {
      throw new BadRequestException({
        code: ErrorCodes.ORDER_COUNTERPART_COOLDOWN,
        message: 'Please wait before creating another order with the same counterpart',
      });
    }

    // Pre-fetch fee config from Redis cache (single round-trip for the whole request)
    const feeConfig = await this.feeCalculator.getFeeConfig();

    let effectiveKahadePlus = user.isKahadePlus;
    if (effectiveKahadePlus) {
      const subCacheKey = `subscription_status:${userId}`;
      const cachedSub = await this.redis.get(subCacheKey);
      if (cachedSub !== null) {
        effectiveKahadePlus = cachedSub === '1';
      } else {
        const activeSub = await this.prisma.subscription.findFirst({
          where: {
            userId,
            status: { in: [SubscriptionStatus.ACTIVE, SubscriptionStatus.CANCELLED] },
            currentPeriodEnd: { gt: new Date() },
          },
          select: { feeSavingsUsed: true, feeSavingsLimit: true },
        });
        if (!activeSub || activeSub.feeSavingsUsed >= activeSub.feeSavingsLimit) {
          effectiveKahadePlus = false;
        }
        await this.redis.set(subCacheKey, effectiveKahadePlus ? '1' : '0', 300);
      }
    }

    const buyerId = dto.role === 'BUYER' ? userId : counterpart.id;
    const sellerId = dto.role === 'SELLER' ? userId : counterpart.id;

    let order: Awaited<ReturnType<typeof this.prisma.order.create>> | undefined;
    let feeCalculation: ReturnType<typeof this.feeCalculator.calculateFee> | undefined;
    try {
    for (let attempt = 0; attempt < ORDER_CREATE_MAX_RETRIES; attempt++) {
      const orderId = generateOrderId(await this.getNextOrderSerial());
      try {
        const txResult = await this.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
          const [txUser, txCounterpart] = await Promise.all([
            tx.user.findUnique({ where: { id: userId }, select: { id: true, isActive: true, isBanned: true, kycStatus: true } }),
            tx.user.findUnique({ where: { id: counterpart.id }, select: { id: true, isActive: true, isBanned: true, kycStatus: true } }),
          ]);
          if (!txUser || !txUser.isActive || txUser.isBanned) {
            throw new ForbiddenException({ code: ErrorCodes.COUNTERPART_SUSPENDED, message: 'Your account is suspended' });
          }
          if (!txCounterpart || !txCounterpart.isActive || txCounterpart.isBanned) {
            throw new ForbiddenException({ code: ErrorCodes.COUNTERPART_SUSPENDED, message: 'Counterpart account is suspended' });
          }

          if (dto.orderValue >= KYC_THRESHOLD_IDR && txUser.kycStatus !== KycStatus.APPROVED) {
            throw new ForbiddenException({ code: ErrorCodes.KYC_REQUIRED, message: 'KYC verification required for orders of Rp 2.000.000 and above' });
          }
          if (dto.orderValue >= KYC_THRESHOLD_IDR && txCounterpart.kycStatus !== KycStatus.APPROVED) {
            throw new ForbiddenException({ code: ErrorCodes.KYC_REQUIRED, message: 'Counterpart must complete KYC verification for orders of Rp 2.000.000 and above' });
          }

          const block = await tx.blockList.findFirst({
            where: { OR: [{ blockerId: userId, blockedId: counterpart.id }, { blockerId: counterpart.id, blockedId: userId }] },
          });
          if (block) throw new BadRequestException({ code: ErrorCodes.USER_BLOCKED, message: 'Cannot create order with blocked user' });

          let voucherDiscountSen = BigInt(0);
          let resolvedVoucher: Voucher | null = null;

          if (dto.voucherCode) {
            const [voucher] = await tx.$queryRaw<Array<Voucher>>`
              SELECT * FROM "vouchers"
              WHERE "code" = ${dto.voucherCode.trim().toUpperCase()}
              LIMIT 1
              FOR UPDATE
            `;
            if (!voucher) {
              throw new NotFoundException({ code: ErrorCodes.VOUCHER_NOT_FOUND, message: 'Voucher not found' });
            }
            const now = new Date();
            if (!voucher.isActive || now < voucher.validFrom || now > voucher.validUntil) {
              throw new BadRequestException({ code: ErrorCodes.VOUCHER_EXPIRED, message: 'Voucher is expired or inactive' });
            }
            {
              if (voucher.maxUsageTotal != null && voucher.currentUsage >= voucher.maxUsageTotal) {
                throw new BadRequestException({ code: ErrorCodes.VOUCHER_USAGE_LIMIT_REACHED, message: 'Voucher has reached its maximum usage limit' });
              }

              if (voucher.applicableTo && voucher.applicableTo !== 'ALL') {
                const isBuyer = dto.role === 'BUYER';
                if (voucher.applicableTo === 'BUYER_ONLY' && !isBuyer) {
                  throw new BadRequestException({ code: ErrorCodes.VOUCHER_NOT_APPLICABLE, message: 'This voucher is only available for buyers' });
                }
                if (voucher.applicableTo === 'SELLER_ONLY' && isBuyer) {
                  throw new BadRequestException({ code: ErrorCodes.VOUCHER_NOT_APPLICABLE, message: 'This voucher is only available for sellers' });
                }
                if (voucher.applicableTo === 'NEW_USER' && user.totalOrdersCompleted > 0) {
                  throw new BadRequestException({ code: ErrorCodes.VOUCHER_NOT_APPLICABLE, message: 'This voucher is only available for new users' });
                }
              }

              if (voucher.minOrderValue !== null && toSen(dto.orderValue) < voucher.minOrderValue) {
                throw new BadRequestException({ code: ErrorCodes.VOUCHER_NOT_APPLICABLE, message: 'Order value does not meet the minimum requirement for this voucher' });
              }

              if (voucher.maxUsagePerUser != null) {
                // PostgreSQL does not permit FOR UPDATE on an aggregate query. The
                // voucher row is already locked above, so lock the concrete usage
                // rows and count them in memory instead. That serializes every use
                // of this voucher while keeping per-user enforcement valid.
                const userUsageRows = await tx.$queryRaw<Array<{ id: string }>>`
                  SELECT "id" FROM "voucher_usages"
                  WHERE "voucherId" = ${voucher.id} AND "userId" = ${userId}
                  FOR UPDATE
                `;
                if (userUsageRows.length >= voucher.maxUsagePerUser) {
                  throw new BadRequestException({
                    code: ErrorCodes.VOUCHER_USAGE_LIMIT_REACHED,
                    message: 'You have reached the per-user usage limit for this voucher',
                  });
                }
              }

              if (voucher.voucherType === 'FEE_DISCOUNT_PERCENT' && voucher.discountPercent != null) {
                // Voucher % is applied against the CLAMPED standard fee (the
                // "fee before reductions" contract), not the raw orderValue ×
                // rate.  Otherwise small orders get under-discounted (their
                // standard fee is clamped UP to the Rp 5.000 floor) and large
                // orders get over-discounted (clamped DOWN to the Rp 250.000
                // ceiling).
                const orderValueSen = toSen(dto.orderValue);
                const baseFeeSen = this.feeCalculator.getStandardFeeSen(orderValueSen, feeConfig);
                const percentBps = BigInt(Math.round(Number(voucher.discountPercent) * 100));
                voucherDiscountSen = (baseFeeSen * percentBps) / BigInt(10_000);
                if (voucher.maxDiscountAmount !== null && voucherDiscountSen > voucher.maxDiscountAmount) {
                  voucherDiscountSen = voucher.maxDiscountAmount;
                }
              } else {
                voucherDiscountSen = BigInt(Number(voucher.discountAmount ?? 0));
              }
              resolvedVoucher = voucher;
            }
          }

          const txFeeCalc = this.feeCalculator.calculateFee({
            orderValue: dto.orderValue,
            feeResponsibility: dto.feeResponsibility,
            isKahadePlus: effectiveKahadePlus,
            voucherDiscountSen,
          }, feeConfig);

          const deadlineDays = getConfirmationDeadlineDays(dto.orderType);
          const confirmationDeadlineAt = toWIB().add(deadlineDays, 'day').toDate();

          const newOrder = await tx.order.create({
            data: {
              orderId, buyerId, sellerId,
              title: sanitizedTitle, description: sanitizedDescription,
              orderType: dto.orderType, orderValue: toSen(dto.orderValue),
              feeAmount: txFeeCalc.feeAmount,
              feeResponsibility: dto.feeResponsibility,
              buyerFeeAmount: txFeeCalc.buyerFeeAmount,
              sellerFeeAmount: txFeeCalc.sellerFeeAmount,
              buyerPayAmount: txFeeCalc.buyerPayAmount,
              sellerReceiveAmount: txFeeCalc.sellerReceiveAmount,
              isKahadePlus: effectiveKahadePlus,
              feeRate: txFeeCalc.feeRate,
              deliveryDeadlineDays: dto.deliveryDeadlineDays,
              confirmationDeadlineAt,
              voucherDiscount: txFeeCalc.voucherDiscount,
              voucherId: resolvedVoucher?.id ?? null,
              createdByBuyer: dto.role === 'BUYER',
            },
          });

          if (resolvedVoucher) {
            await tx.voucherUsage.create({
              data: {
                voucherId: resolvedVoucher.id,
                userId,
                orderId: newOrder.id,
                discountApplied: txFeeCalc.voucherDiscount,
              },
            });

            const updatedVoucher = await tx.voucher.updateMany({
              where: {
                id: resolvedVoucher.id,
                OR: [
                  { maxUsageTotal: null },
                  { currentUsage: { lt: resolvedVoucher.maxUsageTotal as number } },
                ],
              },
              data: { currentUsage: { increment: 1 } },
            });

            if (updatedVoucher.count === 0) {
              throw new BadRequestException({
                code: ErrorCodes.VOUCHER_USAGE_LIMIT_REACHED,
                message: 'Voucher has reached its maximum usage limit',
              });
            }
          }

          await tx.chatRoom.create({ data: { orderId: newOrder.id } });
          await tx.orderStatusHistory.create({
            data: {
              orderId: newOrder.id,
              fromStatus: null,
              toStatus: OrderStatus.WAITING_CONFIRMATION,
              changedBy: userId,
              changedByType: dto.role === 'BUYER' ? ActorType.BUYER : ActorType.SELLER,
              reason: 'Order created',
            },
          });
          return { order: newOrder, feeCalc: txFeeCalc };
        }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
        order = txResult.order;
        feeCalculation = txResult.feeCalc;
        break;
      } catch (err: unknown) {
        if (
          err instanceof Prisma.PrismaClientKnownRequestError &&
          (err.code === 'P2002' || err.code === 'P2034') &&
          attempt < ORDER_CREATE_MAX_RETRIES - 1
        ) {
          const backoffMs = Math.min(100 * Math.pow(2, attempt), 2000);
          this.logger.warn(`Order create transient conflict (${err.code}) on attempt ${attempt + 1}, retrying in ${backoffMs}ms`);
          await new Promise(resolve => setTimeout(resolve, backoffMs));
          continue;
        }
        throw err;
      }
    }

    if (!order || !feeCalculation) {
      throw new BadRequestException({ code: ErrorCodes.ORDER_NOT_FOUND, message: 'Failed to create order after retries' });
    }
    } catch (err) {
      await this.redis.del(cooldownKey).catch((err) => this.logger.warn(`silent-catch: ${err instanceof Error ? err.message : String(err)}`));
      throw err;
    }

    if (effectiveKahadePlus) {
      const subCacheKey = `subscription_status:${userId}`;
      await this.redis.del(subCacheKey);
    }

    const counterpartId = dto.role === 'BUYER' ? sellerId : buyerId;
    const creatorName = (user.fullName || user.username || 'User').replace(/[<>"'&]/g, '');
    const notifTitle = sanitizedTitle.slice(0, 100);

    try {
      const prefs = await this.prisma.notificationPreference.findUnique({ where: { userId: counterpartId } });
      const shouldNotify = !prefs || this.isOrderNotificationEnabled(prefs);
      if (shouldNotify) {
        const escapedBody = this.escapePushBody(`${creatorName} created a new order "${notifTitle}" worth Rp ${dto.orderValue.toLocaleString('id-ID')}. Please confirm.`);
        await this.notificationQueue.enqueue({
          userId: counterpartId,
          type: NotificationType.ORDER_NEW,
          title: 'New Order',
          body: escapedBody,
          pushData: { type: 'ORDER_NEW', orderId: order.orderId },
        });
      }
    } catch (error: unknown) {
      this.logger.warn(`CREATE_ORDER notification failed after commit: ${error instanceof Error ? error.message : String(error)}`);
    }

    // Money values are stored in `sen` (BigInt). IDR has no fractional unit in
    // practice, so divide BigInt → BigInt then cast to Number to keep integer
    // precision and avoid floating-point rounding (e.g. 0.1 + 0.2 != 0.3).
    return {
      orderId: order.orderId,
      status: order.status,
      feeCalculation: {
        feeRate: feeCalculation.feeRate,
        feeAmount: safeBigIntToNumber(feeCalculation.feeAmount / 100n),
        buyerFeeAmount: safeBigIntToNumber(feeCalculation.buyerFeeAmount / 100n),
        sellerFeeAmount: safeBigIntToNumber(feeCalculation.sellerFeeAmount / 100n),
        buyerPayAmount: safeBigIntToNumber(feeCalculation.buyerPayAmount / 100n),
        sellerReceiveAmount: safeBigIntToNumber(feeCalculation.sellerReceiveAmount / 100n),
        voucherDiscount: safeBigIntToNumber(feeCalculation.voucherDiscount / 100n),
      },
      confirmationDeadlineAt: order.confirmationDeadlineAt,
    };
  }

  private isOrderNotificationEnabled(prefs: { orderInApp: boolean; orderPush: boolean }): boolean {
    return prefs.orderInApp || prefs.orderPush;
  }

  private escapePushBody(text: string): string {
    return text.replace(/[\u0000-\u001F\u007F\u200E\u200F\u202A-\u202E\u2066-\u2069]/g, '').replace(/[\\]/g, '\\\\').replace(/"/g, '\\"');
  }

  private static readonly ACTIVE_STATUSES: OrderStatus[] = [
    OrderStatus.WAITING_CONFIRMATION,
    OrderStatus.WAITING_PAYMENT,
    OrderStatus.PROCESSING,
    OrderStatus.IN_DELIVERY,
  ];

  async getOrders(userId: string, page: number, limit: number, status?: OrderStatus, role?: 'BUYER' | 'SELLER' | 'ALL', search?: string): Promise<{
    orders: {
      orderId: string;
      orderNumber: string;
      title: string;
      description: string;
      status: OrderStatus;
      orderType: OrderType;
      orderValue: number;
      buyerPayAmount: number;
      sellerReceiveAmount: number;
      buyer: { userId: string; username: string | null; fullName: string | null; avatarUrl: string | null };
      seller: { userId: string; username: string | null; fullName: string | null; avatarUrl: string | null };
      role: 'BUYER' | 'SELLER';
      createdAt: Date;
    }[];
    total: number;
    page: number;
    limit: number;
  }> {
    const safePage = Math.max(1, Math.trunc(Number.isFinite(page) ? page : 1));
    const safeLimit = Math.min(100, Math.max(1, Math.trunc(Number.isFinite(limit) ? limit : 20)));
    const skip = (safePage - 1) * safeLimit;
    const where: Prisma.OrderWhereInput = {};
    const orConditions: Prisma.OrderWhereInput[] = [];

    if (role !== undefined && role !== 'BUYER' && role !== 'SELLER' && role !== 'ALL') {
      throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Role must be BUYER, SELLER, or ALL' });
    }
    if (role === 'BUYER') {
      orConditions.push({ buyerId: userId });
    } else if (role === 'SELLER') {
      orConditions.push({ sellerId: userId });
    } else {
      orConditions.push({ buyerId: userId });
      orConditions.push({ sellerId: userId });
    }

    if (orConditions.length > 0) where.OR = orConditions;

    if (status) {
      const statusStr = String(status).toUpperCase();
      if (statusStr === 'ACTIVE') {
        where.status = { in: OrdersService.ACTIVE_STATUSES };
      } else if (Object.values(OrderStatus).includes(statusStr as OrderStatus)) {
        where.status = statusStr as OrderStatus;
      } else {
        throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Invalid order status filter' });
      }
    }

    if (search && search.trim().length > 0) {
      const searchTerm = escapeLikePattern(search.trim().slice(0, 100));
      where.AND = [
        ...(Array.isArray(where.AND) ? where.AND : where.AND ? [where.AND] : []),
        {
          OR: [
            { orderId: { contains: searchTerm, mode: 'insensitive' } },
            { title: { contains: searchTerm, mode: 'insensitive' } },
            { description: { contains: searchTerm, mode: 'insensitive' } },
          ],
        },
      ];
    }

    const [orders, total] = await Promise.all([
      this.prisma.order.findMany({
        where, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], skip, take: safeLimit,
        include: {
          buyer: { select: { userId: true, username: true, fullName: true, avatarUrl: true } },
          seller: { select: { userId: true, username: true, fullName: true, avatarUrl: true } },
        },
      }),
      this.prisma.order.count({ where }),
    ]);

    return {
      orders: orders.map((order) => ({
        orderId: order.orderId, orderNumber: order.orderId,
        title: order.title, description: order.description, status: order.status,
        orderType: order.orderType,
        orderValue: toIdr(order.orderValue),
        buyerPayAmount: toIdr(order.buyerPayAmount),
        sellerReceiveAmount: toIdr(order.sellerReceiveAmount),
        ...(order.status === OrderStatus.CANCELLED ? { cancelReason: order.cancelReason ?? null } : {}),
        buyer: order.buyer, seller: order.seller,
        role: order.buyerId === userId ? 'BUYER' : 'SELLER',
        createdAt: order.createdAt,
      })),
      total, page: safePage, limit: safeLimit,
    };
  }

  async getOrderDetail(userId: string, orderId: string): Promise<{ order: object }> {
    const order = await this.prisma.order.findFirst({
      where: { orderId },
      include: {
        buyer: { select: { userId: true, username: true, fullName: true, avatarUrl: true, kycStatus: true, averageRating: true, totalOrdersCompleted: true } },
        seller: { select: { userId: true, username: true, fullName: true, avatarUrl: true, kycStatus: true, averageRating: true, totalOrdersCompleted: true } },
        voucher: { select: { code: true, name: true } },
        statusHistories: { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], select: { id: true, fromStatus: true, toStatus: true, changedByType: true, reason: true, createdAt: true } },
        dispute: { select: { id: true, status: true } },
        chatRoom: { select: { id: true } },
      },
    });

    if (!order) throw new NotFoundException({ code: ErrorCodes.ORDER_NOT_FOUND, message: 'Order not found' });
    if (order.buyerId !== userId && order.sellerId !== userId) {
      throw new ForbiddenException({ code: ErrorCodes.NOT_ORDER_PARTICIPANT, message: 'Not authorized to view this order' });
    }

    const existingRating = await this.prisma.rating.findUnique({
      where: { orderId_giverId: { orderId: order.id, giverId: userId } },
    });

    return {
      order: {
        orderId: order.orderId, title: order.title, description: order.description,
        orderType: order.orderType, status: order.status,
        ...(order.status === OrderStatus.CANCELLED ? {
          cancelReason: order.cancelReason ?? null,
          cancelNote: order.cancelNote ?? null,
        } : {}),
        orderValue: toIdr(order.orderValue), feeAmount: toIdr(order.feeAmount),
        feeResponsibility: order.feeResponsibility,
        buyerFeeAmount: toIdr(order.buyerFeeAmount), sellerFeeAmount: toIdr(order.sellerFeeAmount),
        buyerPayAmount: toIdr(order.buyerPayAmount), sellerReceiveAmount: toIdr(order.sellerReceiveAmount),
        voucherDiscount: toIdr(order.voucherDiscount), isKahadePlus: order.isKahadePlus,
        feeRate: order.feeRate, deliveryDeadlineDays: order.deliveryDeadlineDays,
        deliveryDeadlineAt: order.deliveryDeadlineAt,
        paymentDeadlineAt: order.paymentDeadlineAt,
        confirmationDeadlineAt: order.confirmationDeadlineAt ?? null,
        processingDeadlineAt: order.processingDeadlineAt ?? null,
        trackingNumber: order.trackingNumber, courierName: order.courierName,
        trackingNotes: order.trackingNotes ?? null,
        createdByRole: order.createdByBuyer ? 'BUYER' : 'SELLER',
        createdAt: order.createdAt, confirmedAt: order.confirmedAt,
        paidAt: order.paidAt, completedAt: order.completedAt,
        cancelledAt: order.cancelledAt,
        shippedAt: order.shippedAt ?? null, processedAt: order.processedAt ?? null, disputedAt: order.disputedAt ?? null,
        updatedAt: order.updatedAt ?? order.createdAt,
        postCompletionDisputeDeadlineAt: order.completedAt
          ? new Date(order.completedAt.getTime() + POST_COMPLETION_DISPUTE_WINDOW_HOURS * 60 * 60 * 1000)
          : null,
        buyer: order.buyer, seller: order.seller, voucher: order.voucher,
        chatRoomId: order.chatRoom?.id ?? null,
        hasRated: !!existingRating,
        hasDispute: order.dispute !== null,
        disputeId: order.dispute?.id ?? null,
        dispute: order.dispute ? { id: order.dispute.id, status: order.dispute.status } : null,
        statusHistories: order.statusHistories ?? [],
      },
    };
  }

  async getOrderSummary(userId: string): Promise<{
    asBuyer: { count: number; totalValue: number };
    asSeller: { count: number; totalValue: number };
    inDispute: number;
    pendingExtensions: number;
  }> {
    const buyerStatuses = [OrderStatus.WAITING_PAYMENT, OrderStatus.PROCESSING, OrderStatus.IN_DELIVERY];
    const sellerStatuses = [OrderStatus.WAITING_CONFIRMATION, OrderStatus.PROCESSING, OrderStatus.IN_DELIVERY];

    const [buyerAgg, sellerAgg, inDispute, pendingExtensions] = await Promise.all([
      this.prisma.order.aggregate({
        where: { buyerId: userId, status: { in: buyerStatuses } },
        _count: true,
        _sum: { buyerPayAmount: true },
      }),
      this.prisma.order.aggregate({
        where: { sellerId: userId, status: { in: sellerStatuses } },
        _count: true,
        _sum: { sellerReceiveAmount: true },
      }),
      this.prisma.order.count({ where: { OR: [{ buyerId: userId }, { sellerId: userId }], status: OrderStatus.DISPUTED } }),
      this.prisma.orderExtensionRequest.count({
        where: {
          order: { OR: [{ buyerId: userId }, { sellerId: userId }] },
          status: DeadlineExtensionStatus.PENDING,
        },
      }),
    ]);

    const buyerTotalValue = toIdr(buyerAgg._sum.buyerPayAmount ?? BigInt(0));
    const sellerTotalValue = toIdr(sellerAgg._sum.sellerReceiveAmount ?? BigInt(0));

    return {
      asBuyer: { count: buyerAgg._count, totalValue: buyerTotalValue },
      asSeller: { count: sellerAgg._count, totalValue: sellerTotalValue },
      inDispute,
      pendingExtensions,
    };
  }

  async calculateFee(dto: { orderValue: number; feeResponsibility: FeeResponsibility; voucherCode?: string; role?: 'BUYER' | 'SELLER' }, userId: string): Promise<{
    feeRate: number;
    feeAmount: number;
    buyerFeeAmount: number;
    sellerFeeAmount: number;
    buyerPayAmount: number;
    sellerReceiveAmount: number;
    voucherDiscount: number;
    isKahadePlusApplied: boolean;
  }> {
    if (!Number.isSafeInteger(dto.orderValue) || dto.orderValue < this.configuredMinOrderValue || dto.orderValue > this.configuredMaxOrderValue) {
      throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: `Order value must be an integer between Rp ${this.configuredMinOrderValue.toLocaleString('id-ID')} and Rp ${this.configuredMaxOrderValue.toLocaleString('id-ID')}` });
    }
    if (!Object.values(FeeResponsibility).includes(dto.feeResponsibility)) {
      throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Invalid fee responsibility' });
    }
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException({ code: ErrorCodes.USER_NOT_FOUND, message: 'User not found' });

    let voucherDiscountSen = BigInt(0);
    const feeConfig = await this.feeCalculator.getFeeConfig();

    let effectiveKahadePlusEst = user.isKahadePlus;
    if (effectiveKahadePlusEst) {
      const activeSub = await this.prisma.subscription.findFirst({
        where: {
          userId,
          status: { in: [SubscriptionStatus.ACTIVE, SubscriptionStatus.CANCELLED] },
          currentPeriodEnd: { gt: new Date() },
        },
        select: { feeSavingsUsed: true, feeSavingsLimit: true },
      });
      if (!activeSub || activeSub.feeSavingsUsed >= activeSub.feeSavingsLimit) {
        effectiveKahadePlusEst = false;
      }
    }

    if (dto.voucherCode) {
      const voucherCode = dto.voucherCode.trim().toUpperCase();
      if (voucherCode.length > 50) {
        throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Voucher code is too long' });
      }
      const voucher = await this.prisma.voucher.findFirst({
        where: {
          code: voucherCode,
          isActive: true,
          validFrom: { lte: new Date() },
          validUntil: { gte: new Date() },
        },
      });
      if (voucher) {
        if (voucher.maxUsageTotal != null && voucher.currentUsage >= voucher.maxUsageTotal) {
          throw new BadRequestException({ code: ErrorCodes.VOUCHER_USAGE_LIMIT_REACHED, message: 'Voucher has reached its maximum usage limit' });
        }

        if (voucher.maxUsagePerUser != null) {
          const userUsageCount = await this.prisma.voucherUsage.count({
            where: { voucherId: voucher.id, userId },
          });
          if (userUsageCount >= voucher.maxUsagePerUser) {
            throw new BadRequestException({
              code: ErrorCodes.VOUCHER_USAGE_LIMIT_REACHED,
              message: 'You have reached the per-user usage limit for this voucher',
            });
          }
        }

        if (voucher.minOrderValue !== null && toSen(dto.orderValue) < voucher.minOrderValue) {
          throw new BadRequestException({ code: ErrorCodes.VOUCHER_NOT_APPLICABLE, message: 'Order value does not meet the minimum requirement for this voucher' });
        }

        if (voucher.applicableTo && voucher.applicableTo !== 'ALL') {
          if (voucher.applicableTo === 'NEW_USER' && user.totalOrdersCompleted > 0) {
            throw new BadRequestException({ code: ErrorCodes.VOUCHER_NOT_APPLICABLE, message: 'This voucher is only available for new users' });
          }
          if (voucher.applicableTo === 'BUYER_ONLY' || voucher.applicableTo === 'SELLER_ONLY') {
            if (!dto.role) {
              throw new BadRequestException({ code: ErrorCodes.VOUCHER_NOT_APPLICABLE, message: `This voucher is only for ${voucher.applicableTo === 'BUYER_ONLY' ? 'buyers' : 'sellers'}. Please specify your role.` });
            }
            const isBuyer = dto.role === 'BUYER';
            if (voucher.applicableTo === 'BUYER_ONLY' && !isBuyer) {
              throw new BadRequestException({ code: ErrorCodes.VOUCHER_NOT_APPLICABLE, message: 'This voucher is only available for buyers' });
            }
            if (voucher.applicableTo === 'SELLER_ONLY' && isBuyer) {
              throw new BadRequestException({ code: ErrorCodes.VOUCHER_NOT_APPLICABLE, message: 'This voucher is only available for sellers' });
            }
          }
        }

        if (voucher.voucherType === 'FEE_DISCOUNT_PERCENT' && voucher.discountPercent != null) {
          // See note in createOrder: voucher % is applied against the clamped
          // standard fee, not raw orderValue × rate.
          const orderValueSen = toSen(dto.orderValue);
          const baseFeeSen = this.feeCalculator.getStandardFeeSen(orderValueSen, feeConfig);
          const percentBps = BigInt(Math.round(Number(voucher.discountPercent) * 100));
          voucherDiscountSen = (baseFeeSen * percentBps) / BigInt(10_000);
          if (voucher.maxDiscountAmount !== null && voucherDiscountSen > voucher.maxDiscountAmount) {
            voucherDiscountSen = voucher.maxDiscountAmount;
          }
        } else {
          voucherDiscountSen = BigInt(Number(voucher.discountAmount ?? 0));
        }
      }
    }

    const feeCalculation = this.feeCalculator.calculateFee({
      orderValue: dto.orderValue,
      feeResponsibility: dto.feeResponsibility,
      isKahadePlus: effectiveKahadePlusEst,
      voucherDiscountSen,
    }, feeConfig);

    // BigInt-first division preserves precision; cast only at the end.
    return {
      feeRate: feeCalculation.feeRate,
      feeAmount: safeBigIntToNumber(feeCalculation.feeAmount / 100n),
      buyerFeeAmount: safeBigIntToNumber(feeCalculation.buyerFeeAmount / 100n),
      sellerFeeAmount: safeBigIntToNumber(feeCalculation.sellerFeeAmount / 100n),
      buyerPayAmount: safeBigIntToNumber(feeCalculation.buyerPayAmount / 100n),
      sellerReceiveAmount: safeBigIntToNumber(feeCalculation.sellerReceiveAmount / 100n),
      voucherDiscount: safeBigIntToNumber(feeCalculation.voucherDiscount / 100n),
      isKahadePlusApplied: effectiveKahadePlusEst,
    };
  }

  private async getNextOrderSerial(): Promise<number> {
    const today = formatWIBDate().replace(/-/g, '');
    const key = ORDER_SERIAL(today);
    const redisClient = this.redis.getClient();
    const redisKey = `${this.redis.getPrefix()}${key}`;

    const atomicScript = `
      local current = redis.call("INCR", KEYS[1])
      if current == 1 then
        redis.call("EXPIRE", KEYS[1], ARGV[1])
      end
      return current
    `;
    const serial = await redisClient.eval(atomicScript, 1, redisKey, (86400 * 2).toString()) as number;

    if (serial === 1) {
      const syncLockKey = `order_serial_sync:${today}`;
      const lockAcquired = await this.redis.setNx(syncLockKey, '1', 60);
      if (lockAcquired) {
        try {
          const maxOrder = await this.prisma.order.findFirst({
            where: { orderId: { startsWith: `ORD-${today}-` } },
            orderBy: { orderId: 'desc' },
            select: { orderId: true },
          });
          if (maxOrder) {
            const parts = maxOrder.orderId.split('-');
            const existingSerial = parseInt(parts[2], 10);
            if (existingSerial >= 1) {
              const setIfHigherScript = `
                local current = tonumber(redis.call("get", KEYS[1]) or "0")
                local desired = tonumber(ARGV[1])
                if desired > current then
                  redis.call("set", KEYS[1], ARGV[1])
                  redis.call("expire", KEYS[1], ARGV[2])
                  return desired
                end
                return current
              `;
              const newSerial = await redisClient.eval(setIfHigherScript, 1, redisKey, (existingSerial + 1).toString(), (86400 * 2).toString()) as number;
              return newSerial;
            }
          }
        } finally {
          await this.redis.del(syncLockKey);
        }
      } else {
        await new Promise(r => setTimeout(r, 50));
        return await redisClient.eval(atomicScript, 1, redisKey, (86400 * 2).toString()) as number;
      }
    }
    return serial;
  }

  async validateCounterpart(userId: string, counterpartUsername: string): Promise<{
    user: {
      username: string | null;
      fullName: string | null;
      avatarUrl: string | null;
      isKycVerified: boolean;
      membershipRank: string;
      avgRating: unknown;
    } | null;
    isBlocked: boolean;
    canCreateOrder: boolean;
    reason?: string;
  }> {
    const normalizedUsername = typeof counterpartUsername === 'string' ? counterpartUsername.trim().toLowerCase() : '';
    if (normalizedUsername.length < 3 || normalizedUsername.length > 50) {
      throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Username must be between 3 and 50 characters' });
    }
    const counterpart = await this.prisma.user.findUnique({
      where: { username: normalizedUsername },
      select: {
        id: true, username: true, fullName: true, avatarUrl: true,
        isActive: true, isBanned: true, kycStatus: true,
        membershipRank: true, averageRating: true, totalOrdersCompleted: true,
      },
    });

    if (!counterpart) {
      return { user: null, isBlocked: false, canCreateOrder: false, reason: 'USER_NOT_FOUND' };
    }

    if (counterpart.id === userId) {
      throw new BadRequestException({ code: ErrorCodes.CANNOT_ORDER_SELF, message: 'Cannot validate yourself as a counterpart' });
    }

    const block = await this.prisma.blockList.findFirst({
      where: { OR: [{ blockerId: userId, blockedId: counterpart.id }, { blockerId: counterpart.id, blockedId: userId }] },
    });

    const canCreateOrder = counterpart.isActive && !counterpart.isBanned && !block;

    return {
      user: {
        username: counterpart.username,
        fullName: counterpart.fullName,
        avatarUrl: counterpart.avatarUrl,
        isKycVerified: counterpart.kycStatus === KycStatus.APPROVED,
        membershipRank: counterpart.membershipRank,
        avgRating: counterpart.averageRating,
      },
      isBlocked: !!block,
      canCreateOrder,
    };
  }

  async processOrder(orderId: string, sellerId: string): Promise<{ orderId: string; status: string }> {
    let buyerId: string | undefined;
    let orderType: OrderType | undefined;
    await this.withSerializableRetry(() => this.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      const order = await tx.order.findFirst({
        where: { orderId, sellerId },
      });
      if (!order) {
        const exists = await tx.order.findUnique({ where: { orderId }, select: { id: true } });
        if (!exists) throw new NotFoundException({ code: ErrorCodes.ORDER_NOT_FOUND, message: 'Order not found' });
        throw new ForbiddenException({ code: ErrorCodes.NOT_ORDER_PARTICIPANT, message: 'Not authorized' });
      }
      if (order.status !== OrderStatus.PROCESSING) throw new BadRequestException({ code: ErrorCodes.INVALID_ORDER_STATUS, message: 'Order is not in PROCESSING status' });

      if (order.orderType === OrderType.PHYSICAL_GOODS && (!order.trackingNumber || !order.courierName)) {
        throw new BadRequestException({
          code: ErrorCodes.VALIDATION_ERROR,
          message: 'Tracking number and courier must be provided before marking a physical order as in delivery',
        });
      }

      buyerId = order.buyerId;
      orderType = order.orderType;
      const now = new Date();
      const deliveryDeadlineAt = order.deliveryDeadlineAt ?? addDays(now, order.deliveryDeadlineDays);

      const updated = await tx.order.updateMany({ where: { id: order.id, status: OrderStatus.PROCESSING }, data: { status: OrderStatus.IN_DELIVERY, shippedAt: order.shippedAt ?? now, processedAt: order.processedAt ?? now, deliveryDeadlineAt } });
      if (updated.count === 0) {
        throw new BadRequestException({ code: ErrorCodes.INVALID_ORDER_STATUS, message: 'Order status has already changed' });
      }
      await tx.orderStatusHistory.create({ data: { orderId: order.id, fromStatus: OrderStatus.PROCESSING, toStatus: OrderStatus.IN_DELIVERY, changedBy: sellerId, changedByType: ActorType.SELLER } });

    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }), 'PROCESS_ORDER_TX');
    if (buyerId) {
      const isPhysicalOrder = orderType === OrderType.PHYSICAL_GOODS;
      const notificationType = isPhysicalOrder ? NotificationType.ORDER_SHIPPED : NotificationType.ORDER_DELIVERED;
      this.enqueueOrderNotificationBestEffort({
        userId: buyerId,
        type: notificationType,
        title: isPhysicalOrder ? 'Order Shipped' : 'Order Ready for Review',
        body: isPhysicalOrder
          ? `Order ${orderId} has been shipped by the seller. Please check the tracking number.`
          : `Order ${orderId} is ready for your delivery-proof review.`,
        pushData: { type: notificationType, orderId },
      }, `PROCESS_ORDER orderId=${orderId}`);
    }
    this.runRealtimeBestEffort(() => this.realtime.emitToOrder(orderId, 'order.status_changed', { orderId, status: 'IN_DELIVERY' }), `PROCESS_ORDER_STATUS orderId=${orderId}`);
    this.runRealtimeBestEffort(() => this.realtime.emitToOrder(orderId, 'order.status', { orderId, status: 'IN_DELIVERY' }), `PROCESS_ORDER_STATUS_LEGACY orderId=${orderId}`);
    return { orderId, status: 'IN_DELIVERY' };
  }

  async updateShipping(orderId: string, sellerId: string, dto: { trackingNumber?: string; courierName?: string; trackingNotes?: string }): Promise<{ orderId: string; trackingNumber: string | null; courierName: string | null }> {
    const validStatuses: OrderStatus[] = [OrderStatus.PROCESSING, OrderStatus.IN_DELIVERY];

    const result = await this.withSerializableRetry(() => this.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      const order = await tx.order.findUnique({ where: { orderId } });
      if (!order) throw new NotFoundException({ code: ErrorCodes.ORDER_NOT_FOUND, message: 'Order not found' });
      if (order.sellerId !== sellerId) throw new ForbiddenException({ code: ErrorCodes.NOT_ORDER_PARTICIPANT, message: 'Not authorized' });

      if (!validStatuses.includes(order.status)) {
        throw new BadRequestException({
          code: ErrorCodes.INVALID_ORDER_STATUS,
          message: 'Order is not in a valid status for shipping update',
        });
      }

      await tx.$queryRaw`SELECT id FROM orders WHERE id = ${order.id} FOR UPDATE`;
      const freshOrder = await tx.order.findUnique({ where: { id: order.id } });
      if (!freshOrder || !validStatuses.includes(freshOrder.status) || freshOrder.sellerId !== sellerId) {
        throw new BadRequestException({ code: ErrorCodes.INVALID_ORDER_STATUS, message: 'Order is no longer available for shipping update' });
      }
      const trackingNumber = dto.trackingNumber?.trim() || null;
      const courierName = dto.courierName?.trim() || null;
      if (freshOrder.orderType === OrderType.PHYSICAL_GOODS && (!trackingNumber || !courierName)) {
        throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Tracking number and courier are required for physical orders' });
      }
      if (freshOrder.orderType !== OrderType.PHYSICAL_GOODS && (trackingNumber !== null || courierName !== null)) {
        throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Tracking number and courier are only valid for physical orders' });
      }

      const updated = await tx.order.updateMany({
        where: { id: order.id, status: freshOrder.status },
        data: {
          trackingNumber,
          courierName,
          ...(dto.trackingNotes !== undefined ? { trackingNotes: dto.trackingNotes.trim() || null } : {}),
        },
      });

      if (updated.count === 0) {
        throw new ConflictException({ code: ErrorCodes.OPTIMISTIC_LOCK_CONFLICT, message: 'Order status has already changed' });
      }

      await tx.orderStatusHistory.create({
        data: {
          orderId: order.id,
          fromStatus: freshOrder.status,
          toStatus: freshOrder.status,
          changedBy: sellerId,
          changedByType: ActorType.SELLER,
          reason: 'SHIPPING_DETAILS_UPDATED',
          metadata: { trackingNumber: Boolean(trackingNumber), courierName: Boolean(courierName) },
        },
      });
      return { trackingNumber, courierName };
    }), 'UPDATE_SHIPPING_TX');

    return { orderId, ...result };
  }

  async getOrderHistory(orderId: string, userId: string, page: number = 1, limit: number = 20): Promise<{
    data: object[];
    total: number;
    page: number;
    limit: number;
    totalPages: number;
  }> {
    const safePage = Math.max(1, Math.trunc(Number.isFinite(page) ? page : 1));
    const safeLimit = Math.min(100, Math.max(1, Math.trunc(Number.isFinite(limit) ? limit : 20)));
    const skip = (safePage - 1) * safeLimit;

    const order = await this.prisma.order.findUnique({ where: { orderId } });
    if (!order) throw new NotFoundException({ code: ErrorCodes.ORDER_NOT_FOUND, message: 'Order not found' });
    if (order.buyerId !== userId && order.sellerId !== userId) throw new ForbiddenException({ code: ErrorCodes.NOT_ORDER_PARTICIPANT, message: 'Not authorized' });

    const [history, total] = await Promise.all([
      this.prisma.orderStatusHistory.findMany({
        where: { orderId: order.id },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip,
        take: safeLimit,
      }),
      this.prisma.orderStatusHistory.count({ where: { orderId: order.id } }),
    ]);

    return {
      data: history.map(({ id: _id, ...rest }) => rest),
      total,
      page: safePage,
      limit: safeLimit,
      totalPages: Math.ceil(total / safeLimit),
    };
  }

  async getAverageDurations(): Promise<Record<string, number>> {
    const cached = await this.redis.get(ORDER_AVG_DURATIONS_CACHE);
    if (cached) {
      try {
        const parsed: unknown = JSON.parse(cached);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, number>;
      } catch {
        // ignore parse error, recalculate
      }
    }

    const rows = await this.prisma.$queryRaw<Array<{ from_status: string; avg_hours: number }>>`
      WITH completed_orders AS (
        SELECT id, "createdAt" AS order_created_at FROM "orders" WHERE "status" = 'COMPLETED'::"OrderStatus"
      ),
      all_transitions AS (
        SELECT
          h."orderId",
          h."toStatus"::text AS "toStatus",
          h."createdAt",
          LEAD(h."createdAt") OVER (PARTITION BY h."orderId" ORDER BY h."createdAt" ASC) AS next_ts
        FROM "order_status_histories" h
        INNER JOIN completed_orders co ON co.id = h."orderId"
      ),
      creation_durations AS (
        SELECT
          co.id AS "orderId",
          'WAITING_CONFIRMATION'::text AS "toStatus",
          co.order_created_at AS "createdAt",
          MIN(h."createdAt") AS next_ts
        FROM completed_orders co
        INNER JOIN "order_status_histories" h ON h."orderId" = co.id
        GROUP BY co.id, co.order_created_at
      ),
      combined AS (
        SELECT "orderId", "toStatus", "createdAt", next_ts
        FROM all_transitions
        WHERE "toStatus" IN ('WAITING_CONFIRMATION', 'WAITING_PAYMENT', 'PROCESSING', 'IN_DELIVERY')
          AND next_ts IS NOT NULL
        UNION ALL
        SELECT "orderId", "toStatus", "createdAt", next_ts
        FROM creation_durations
        WHERE next_ts IS NOT NULL
      )
      SELECT
        c."toStatus" AS from_status,
        AVG(EXTRACT(EPOCH FROM (c.next_ts - c."createdAt")) / 3600) AS avg_hours
      FROM combined c
      GROUP BY c."toStatus"
    `;

    const result: Record<string, number> = {};
    for (const row of rows) {
      if (row.avg_hours != null && !isNaN(Number(row.avg_hours))) {
        result[row.from_status] = Math.round(Number(row.avg_hours) * 10) / 10;
      }
    }

    await this.redis.set(ORDER_AVG_DURATIONS_CACHE, JSON.stringify(result), 3600);

    return result;
  }
}
