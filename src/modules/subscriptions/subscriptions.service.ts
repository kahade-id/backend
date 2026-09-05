import {
  Injectable,
  NotFoundException,
  ConflictException,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service';
import { RedisService } from '../../redis/redis.service';
import {
  Subscription,
  SubscriptionPlan,
  SubscriptionStatus,
  WalletTransactionType,
  WalletTransactionStatus,
  UserAuditAction,
  Prisma,
} from '@prisma/client';
import { createPaginatedResponse, PaginatedResponse } from '../../common/dto/pagination.dto';
import { WalletTxSerialService } from '../../common/services/wallet-tx-serial.service';
import { WalletService } from '../wallet/wallet.service';
import { AuditLogService } from '../../common/services/audit-log.service';
import { generateWalletTxId } from '../../common/utils/id-generator.util';
import * as ErrorCodes from '../../common/constants/error-codes';
import { toIdr, toSen } from '../../common/utils/currency.util';
import { SUBSCRIPTION_PLANS_CACHE } from '../../common/constants/redis-keys';
import {
  SUBSCRIPTION_MONTHLY_PRICE,
  SUBSCRIPTION_ANNUAL_PRICE,
} from '../../common/constants/app.constants';

const SUBSCRIPTION_PLANS_TTL = 300;

const PLAN_METADATA: Record<SubscriptionPlan, { durationDays: number; label: string }> = {
  MONTHLY: { durationDays: 30, label: 'Kahade Plus Monthly' },
  ANNUAL: { durationDays: 366, label: 'Kahade Plus Annual' },
};

@Injectable()
export class SubscriptionsService {
  private readonly logger = new Logger(SubscriptionsService.name);
  private readonly planPricing: Record<
    SubscriptionPlan,
    { price: bigint; durationDays: number; label: string }
  >;

  constructor(
    private prisma: PrismaService,
    private walletTxSerialService: WalletTxSerialService,
    private walletService: WalletService,
    private configService: ConfigService,
    private redis: RedisService,
    private auditLogService: AuditLogService,
  ) {
    const monthlyPriceSen =
      this.configService.get<number>('app.subscriptionMonthlyPriceSen') ??
      SUBSCRIPTION_MONTHLY_PRICE * 100;
    const annualPriceSen =
      this.configService.get<number>('app.subscriptionAnnualPriceSen') ??
      SUBSCRIPTION_ANNUAL_PRICE * 100;
    this.planPricing = {
      MONTHLY: { price: BigInt(monthlyPriceSen), ...PLAN_METADATA.MONTHLY },
      ANNUAL: { price: BigInt(annualPriceSen), ...PLAN_METADATA.ANNUAL },
    };
  }

  async getStatus(userId: string): Promise<Record<string, unknown>> {
    const subscription = await this.prisma.subscription.findFirst({
      where: {
        userId,
        status: {
          in: [
            SubscriptionStatus.ACTIVE,
            SubscriptionStatus.CANCELLED,
            SubscriptionStatus.SUSPENDED,
          ],
        },
        currentPeriodEnd: { gt: new Date() },
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });

    if (!subscription) {
      return {
        isActive: false,
        plan: null,
        currentPeriodStart: null,
        currentPeriodEnd: null,
        feeSavingsUsed: 0,
        feeSavingsLimit: 0,
        feeSavingsRemaining: 0,
        isAutoRenew: false,
      };
    }

    const feeSavingsRemaining =
      subscription.feeSavingsLimit > subscription.feeSavingsUsed
        ? subscription.feeSavingsLimit - subscription.feeSavingsUsed
        : BigInt(0);
    const isInGracePeriod = subscription.status === SubscriptionStatus.SUSPENDED;

    return {
      isActive: !isInGracePeriod,
      isInGracePeriod,
      plan: subscription.plan,
      status: subscription.status,
      cancelledAt: subscription.cancelledAt,
      currentPeriodStart: subscription.currentPeriodStart,
      currentPeriodEnd: subscription.currentPeriodEnd,
      feeSavingsUsed: toIdr(subscription.feeSavingsUsed),
      feeSavingsLimit: toIdr(subscription.feeSavingsLimit),
      feeSavingsRemaining: toIdr(feeSavingsRemaining),
      isAutoRenew: subscription.isAutoRenew,
      lastPaymentAt: subscription.lastPaymentAt,
      nextPaymentAt: subscription.nextPaymentAt,
      createdAt: subscription.createdAt,
    };
  }

  async subscribe(
    userId: string,
    plan: SubscriptionPlan,
    pin: string,
    ip?: string,
  ): Promise<Subscription> {
    await this.walletService.verifyPin(userId, pin, ip);

    const planInfo = this.planPricing[plan];
    if (!planInfo) {
      throw new BadRequestException({
        code: ErrorCodes.VALIDATION_ERROR,
        message: 'Invalid subscription plan',
      });
    }
    const walletTxSerial = await this.walletTxSerialService.getNext();

    const now = new Date();
    const periodEnd = new Date(now);
    periodEnd.setDate(periodEnd.getDate() + planInfo.durationDays);

    const subscription = await this.prisma.$transaction(
      async (tx: Prisma.TransactionClient) => {
        const existingPending = await tx.subscription.findFirst({
          where: { userId, status: SubscriptionStatus.PENDING },
          select: { id: true },
        });
        if (existingPending) {
          throw new ConflictException({
            code: ErrorCodes.SUBSCRIPTION_ALREADY_ACTIVE,
            message: 'A subscription payment is already pending',
          });
        }

        const existingActive = await tx.subscription.findFirst({
          where: {
            userId,
            status: {
              in: [
                SubscriptionStatus.ACTIVE,
                SubscriptionStatus.CANCELLED,
                SubscriptionStatus.SUSPENDED,
              ],
            },
            currentPeriodEnd: { gt: new Date() },
          },
        });
        if (existingActive) {
          throw new ConflictException({
            code: ErrorCodes.SUBSCRIPTION_ALREADY_ACTIVE,
            message: 'You already have an active subscription period — use renew instead',
          });
        }

        const walletRows = await tx.$queryRaw<
          Array<{
            id: string;
            userId: string;
            totalBalance: bigint;
            availableBalance: bigint;
            version: number;
          }>
        >`
        SELECT id, "userId", "totalBalance", "availableBalance", version FROM wallets WHERE "userId" = ${userId} FOR UPDATE`;
        const wallet = walletRows[0];
        if (!wallet) {
          throw new BadRequestException({
            code: ErrorCodes.INSUFFICIENT_BALANCE,
            message: 'Wallet not found',
          });
        }

        if (wallet.availableBalance < planInfo.price) {
          throw new BadRequestException({
            code: ErrorCodes.INSUFFICIENT_BALANCE,
            message: 'Insufficient wallet balance for subscription',
          });
        }

        const updated = await tx.wallet.updateMany({
          where: {
            id: wallet.id,
            version: wallet.version,
            availableBalance: { gte: planInfo.price },
          },
          data: {
            availableBalance: { decrement: planInfo.price },
            totalBalance: { decrement: planInfo.price },
            version: { increment: 1 },
          },
        });

        if (updated.count === 0) {
          throw new BadRequestException({
            code: ErrorCodes.INSUFFICIENT_BALANCE,
            message: 'Concurrent wallet update — please retry',
          });
        }

        const balanceBefore = wallet.totalBalance;
        const balanceAfter = wallet.totalBalance - planInfo.price;

        const walletTxId = generateWalletTxId(walletTxSerial);
        await tx.walletTransaction.create({
          data: {
            txId: walletTxId,
            walletId: wallet.id,
            type: WalletTransactionType.SUBSCRIPTION_PAYMENT,
            status: WalletTransactionStatus.SUCCESS,
            amount: planInfo.price,
            balanceBefore,
            balanceAfter,
            description: `${planInfo.label} subscription payment`,
          },
        });

        const feeSavingsLimitIdr = this.configService.get<number>('app.feeSavingsLimit') ?? 5000000;
        const feeSavingsLimitSen = toSen(feeSavingsLimitIdr);

        const sub = await tx.subscription.create({
          data: {
            userId,
            plan,
            status: SubscriptionStatus.ACTIVE,
            price: planInfo.price,
            currentPeriodStart: now,
            currentPeriodEnd: periodEnd,
            isAutoRenew: false,
            lastPaymentAt: now,
            nextPaymentAt: periodEnd,
            feeSavingsLimit: feeSavingsLimitSen,
          },
        });

        await tx.user.update({
          where: { id: userId },
          data: {
            isKahadePlus: true,
            subscriptionExpiresAt: periodEnd,
          },
        });

        return sub;
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );

    this.logger.log(`User ${userId} subscribed to ${plan}, charged ${planInfo.price} sen`);

    this.auditLogService.logUserAction({
      userId,
      action: UserAuditAction.SUBSCRIPTION_STARTED,
      entityType: 'Subscription',
      entityId: subscription.id,
      description: `Subscribed to ${plan} plan`,
    });

    return subscription;
  }

  async cancel(userId: string): Promise<Subscription> {
    const subscription = await this.prisma.subscription.findFirst({
      where: { userId, status: SubscriptionStatus.ACTIVE },
    });

    if (!subscription) {
      throw new NotFoundException({
        code: ErrorCodes.NO_ACTIVE_SUBSCRIPTION,
        message: 'No active subscription found',
      });
    }

    // Mark subscription as CANCELLED (prevents auto-renewal) but keep isKahadePlus=true
    // and subscriptionExpiresAt intact so user retains benefits until currentPeriodEnd.
    // The subscription-expiry scheduler will revoke isKahadePlus when the period ends.
    const updated = await this.prisma.$transaction(
      async tx => {
        const result = await tx.subscription.updateMany({
          where: { id: subscription.id, status: SubscriptionStatus.ACTIVE },
          data: {
            status: SubscriptionStatus.CANCELLED,
            isAutoRenew: false,
            cancelledAt: new Date(),
            cancelReason: 'User requested cancellation',
          },
        });
        if (result.count === 0) {
          throw new ConflictException({
            code: ErrorCodes.OPTIMISTIC_LOCK_CONFLICT,
            message: 'Subscription changed concurrently — please retry',
          });
        }
        const sub = await tx.subscription.findUniqueOrThrow({ where: { id: subscription.id } });

        // Do NOT clear isKahadePlus or subscriptionExpiresAt here — the scheduler
        // (subscription-expiry.service.ts) handles that when currentPeriodEnd passes.

        return sub;
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );

    this.auditLogService.logUserAction({
      userId,
      action: UserAuditAction.SUBSCRIPTION_CANCELLED,
      entityType: 'Subscription',
      entityId: updated.id,
      description: `Cancelled ${updated.plan} subscription`,
    });

    return updated;
  }

  async getHistory(
    userId: string,
    page: number,
    limit: number,
  ): Promise<PaginatedResponse<Record<string, unknown>>> {
    const safePage = Math.max(1, Number.isFinite(page) ? Math.trunc(page) : 1);
    const safeLimit = Math.min(100, Math.max(1, Number.isFinite(limit) ? Math.trunc(limit) : 20));
    const skip = (safePage - 1) * safeLimit;

    const [data, total] = await Promise.all([
      this.prisma.subscription.findMany({
        where: { userId },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip,
        take: safeLimit,
      }),
      this.prisma.subscription.count({ where: { userId } }),
    ]);

    const serialized = data.map(sub => ({
      id: sub.id,
      plan: sub.plan,
      status: sub.status,
      price: toIdr(sub.price),
      currentPeriodStart: sub.currentPeriodStart,
      currentPeriodEnd: sub.currentPeriodEnd,
      isAutoRenew: sub.isAutoRenew,
      cancelledAt: sub.cancelledAt,
      lastPaymentAt: sub.lastPaymentAt,
      feeSavingsUsed: toIdr(sub.feeSavingsUsed),
      feeSavingsLimit: toIdr(sub.feeSavingsLimit),
      createdAt: sub.createdAt,
    }));

    return createPaginatedResponse(serialized, total, safePage, safeLimit);
  }

  async getBenefits(userId: string): Promise<Record<string, unknown>> {
    const subscription = await this.prisma.subscription.findFirst({
      where: {
        userId,
        status: {
          in: [
            SubscriptionStatus.ACTIVE,
            SubscriptionStatus.CANCELLED,
            SubscriptionStatus.SUSPENDED,
          ],
        },
        currentPeriodEnd: { gt: new Date() },
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });

    if (!subscription) {
      throw new NotFoundException({
        code: ErrorCodes.NO_ACTIVE_SUBSCRIPTION,
        message: 'No active subscription found',
      });
    }

    const planInfo = this.planPricing[subscription.plan];
    const feeSavingsRemaining =
      subscription.feeSavingsLimit > subscription.feeSavingsUsed
        ? subscription.feeSavingsLimit - subscription.feeSavingsUsed
        : BigInt(0);

    return {
      plan: subscription.plan,
      label: planInfo.label,
      benefits: [
        {
          key: 'fee_savings',
          label: 'Fee Savings',
          description: 'Reduced platform fees on transactions',
        },
        {
          key: 'priority_support',
          label: 'Priority Support',
          description: 'Faster customer support response',
        },
        { key: 'badge', label: 'Kahade Plus Badge', description: 'Exclusive profile badge' },
      ],
      feeSavingsUsed: toIdr(subscription.feeSavingsUsed),
      feeSavingsLimit: toIdr(subscription.feeSavingsLimit),
      feeSavingsRemaining: toIdr(feeSavingsRemaining),
      currentPeriodEnd: subscription.currentPeriodEnd,
    };
  }

  async renew(userId: string, pin: string, ip?: string): Promise<Subscription> {
    await this.walletService.verifyPin(userId, pin, ip);

    const subscription = await this.prisma.subscription.findFirst({
      where: {
        userId,
        status: {
          in: [
            SubscriptionStatus.ACTIVE,
            SubscriptionStatus.CANCELLED,
            SubscriptionStatus.SUSPENDED,
          ],
        },
        currentPeriodEnd: { gt: new Date() },
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });

    if (!subscription) {
      throw new NotFoundException({
        code: ErrorCodes.NO_ACTIVE_SUBSCRIPTION,
        message: 'No active subscription found',
      });
    }
    if (
      subscription.status === SubscriptionStatus.CANCELLED &&
      subscription.cancelReason === 'Force cancelled by admin'
    ) {
      throw new ConflictException({
        code: ErrorCodes.INVALID_STATUS,
        message: 'This subscription was cancelled by an administrator',
      });
    }

    const planInfo = this.planPricing[subscription.plan];
    const walletTxSerial = await this.walletTxSerialService.getNext();
    const renewBase =
      subscription.status === SubscriptionStatus.SUSPENDED
        ? new Date()
        : new Date(subscription.currentPeriodEnd ?? new Date());
    const newPeriodEnd = new Date(renewBase);
    newPeriodEnd.setDate(newPeriodEnd.getDate() + planInfo.durationDays);
    const now = new Date();

    const updated = await this.prisma.$transaction(
      async (tx: Prisma.TransactionClient) => {
        const walletRows = await tx.$queryRaw<
          Array<{
            id: string;
            userId: string;
            totalBalance: bigint;
            availableBalance: bigint;
            version: number;
          }>
        >`
        SELECT id, "userId", "totalBalance", "availableBalance", version FROM wallets WHERE "userId" = ${userId} FOR UPDATE`;
        const wallet = walletRows[0];
        if (!wallet) {
          throw new BadRequestException({
            code: ErrorCodes.INSUFFICIENT_BALANCE,
            message: 'Wallet not found',
          });
        }

        if (wallet.availableBalance < planInfo.price) {
          throw new BadRequestException({
            code: ErrorCodes.INSUFFICIENT_BALANCE,
            message: 'Insufficient wallet balance for subscription renewal',
          });
        }

        const walletUpdated = await tx.wallet.updateMany({
          where: {
            id: wallet.id,
            version: wallet.version,
            availableBalance: { gte: planInfo.price },
          },
          data: {
            availableBalance: { decrement: planInfo.price },
            totalBalance: { decrement: planInfo.price },
            version: { increment: 1 },
          },
        });

        if (walletUpdated.count === 0) {
          throw new BadRequestException({
            code: ErrorCodes.OPTIMISTIC_LOCK_CONFLICT,
            message: 'Concurrent wallet update — please retry',
          });
        }

        const walletTxId = generateWalletTxId(walletTxSerial);
        const renewBalanceBefore = wallet.totalBalance;
        const renewBalanceAfter = wallet.totalBalance - planInfo.price;
        await tx.walletTransaction.create({
          data: {
            txId: walletTxId,
            walletId: wallet.id,
            type: WalletTransactionType.SUBSCRIPTION_PAYMENT,
            status: WalletTransactionStatus.SUCCESS,
            amount: planInfo.price,
            balanceBefore: renewBalanceBefore,
            balanceAfter: renewBalanceAfter,
            description: `${planInfo.label} subscription renewal`,
          },
        });

        const feeSavingsLimitIdr = this.configService.get<number>('app.feeSavingsLimit') ?? 5000000;
        const feeSavingsLimitSen = toSen(feeSavingsLimitIdr);

        const subUpdated = await tx.subscription.updateMany({
          where: {
            id: subscription.id,
            status: {
              in: [
                SubscriptionStatus.ACTIVE,
                SubscriptionStatus.CANCELLED,
                SubscriptionStatus.SUSPENDED,
              ],
            },
            currentPeriodEnd: subscription.currentPeriodEnd,
          },
          data: {
            status: SubscriptionStatus.ACTIVE,
            isAutoRenew: subscription.isAutoRenew,
            currentPeriodStart: now,
            currentPeriodEnd: newPeriodEnd,
            lastPaymentAt: now,
            nextPaymentAt: newPeriodEnd,
            feeSavingsUsed: BigInt(0),
            feeSavingsLimit: feeSavingsLimitSen,
            cancelledAt: null,
            cancelReason: null,
          },
        });
        if (subUpdated.count === 0) {
          throw new ConflictException({
            code: ErrorCodes.OPTIMISTIC_LOCK_CONFLICT,
            message: 'Subscription was already renewed — please retry',
          });
        }
        const sub = await tx.subscription.findUniqueOrThrow({ where: { id: subscription.id } });

        await tx.user.update({
          where: { id: userId },
          data: {
            isKahadePlus: true,
            subscriptionExpiresAt: newPeriodEnd,
          },
        });

        return sub;
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );

    this.logger.log(`User ${userId} renewed ${subscription.plan}, charged ${planInfo.price} sen`);
    this.auditLogService.logUserAction({
      userId,
      action: UserAuditAction.SUBSCRIPTION_STARTED,
      entityType: 'Subscription',
      entityId: subscription.id,
      description: `Renewed ${subscription.plan} subscription (previous feeSavingsUsed: ${subscription.feeSavingsUsed ?? 0} sen)`,
    });
    return updated;
  }

  async getPlans(): Promise<
    Array<{
      plan: string;
      label: string;
      price: number;
      durationDays: number;
      feeSavingsLimit: number;
    }>
  > {
    type PlanEntry = {
      plan: string;
      label: string;
      price: number;
      durationDays: number;
      feeSavingsLimit: number;
    };
    const cacheKey = `${SUBSCRIPTION_PLANS_CACHE}:plans`;
    const cached = await this.redis.get(cacheKey);
    if (cached) {
      try {
        return JSON.parse(cached) as PlanEntry[];
      } catch (_) {
        await this.redis.del(cacheKey);
      }
    }
    const feeSavingsLimit = this.configService.get<number>('app.feeSavingsLimit') ?? 5000000;
    const plans = Object.entries(this.planPricing).map(([plan, info]) => ({
      plan,
      label: info.label,
      price: toIdr(info.price),
      durationDays: info.durationDays,
      feeSavingsLimit,
    }));
    await this.redis.setex(cacheKey, SUBSCRIPTION_PLANS_TTL, JSON.stringify(plans));
    return plans;
  }
}
