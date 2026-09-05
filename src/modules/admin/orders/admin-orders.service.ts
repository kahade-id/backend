import { Injectable, NotFoundException, BadRequestException, ConflictException, ForbiddenException, Logger } from '@nestjs/common';
import { randomInt } from 'crypto';
import { PrismaService } from '../../../prisma/prisma.service';
import { OrderStatus, AuditAction, Prisma, ActorType, WalletTransactionType, WalletTransactionStatus, NotificationType } from '@prisma/client';
import { getCategoryForType } from '../../notifications/notification-category.map';
import { createPaginatedResponse, PaginatedResponse } from '../../../common/dto/pagination.dto';
import { AuditLogService } from '../../../common/services/audit-log.service';
import { WalletTxSerialService } from '../../../common/services/wallet-tx-serial.service';
import { generateWalletTxId, generateNotifId } from '../../../common/utils/id-generator.util';
import { OrderStateService } from '../../orders/order-state.service';
import { FeeCalculatorService } from '../../orders/fee-calculator.service';
import { ReferralService } from '../../referral/referral.service';
import { MembershipRankService } from '../../orders/membership-rank.service';
import { AdminOrderQueryDto, ForceActionDto } from './dto/admin-order-query.dto';
import { toIdr } from '../../../common/utils/currency.util';
import { parseDateBoundaryWIB } from '../../../common/utils/date.util';
import * as ErrorCodes from '../../../common/constants/error-codes';

function escapeLikePattern(pattern: string): string {
  return pattern.replace(/[%_\\]/g, '\\$&');
}

function serializeOrder(order: Record<string, unknown>): Record<string, unknown> {
  return {
    ...order,
    orderValue: toIdr(order.orderValue as bigint),
    feeAmount: toIdr(order.feeAmount as bigint),
    buyerFeeAmount: toIdr(order.buyerFeeAmount as bigint),
    sellerFeeAmount: toIdr(order.sellerFeeAmount as bigint),
    buyerPayAmount: toIdr(order.buyerPayAmount as bigint),
    sellerReceiveAmount: toIdr(order.sellerReceiveAmount as bigint),
    voucherDiscount: toIdr(order.voucherDiscount as bigint),
  };
}

@Injectable()
export class AdminOrdersService {
  private readonly logger = new Logger(AdminOrdersService.name);

  constructor(
    private prisma: PrismaService,
    private auditLog: AuditLogService,
    private orderStateService: OrderStateService,
    private feeCalculator: FeeCalculatorService,
    private walletTxSerialService: WalletTxSerialService,
    private referralService: ReferralService,
    private membershipRankService: MembershipRankService,
  ) {}

  private async withSerializableRetry<T>(fn: () => Promise<T>, label: string): Promise<T> {
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        return await fn();
      } catch (error: unknown) {
        const retryable = error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2034'
          || error instanceof Prisma.PrismaClientUnknownRequestError && /40001|serialization|40p01|deadlock/i.test(error.message);
        if (!retryable || attempt === 3) throw error;
        this.logger.warn(`${label} retrying attempt=${attempt}/3`);
        await new Promise(resolve => setTimeout(resolve, 100 * 2 ** (attempt - 1) + randomInt(0, 50)));
      }
    }
    throw new Error(`${label}: unreachable`);
  }

  async listOrders(query: AdminOrderQueryDto): Promise<PaginatedResponse<Record<string, unknown>>> {
    const { page = 1, limit = 20, status, startDate, endDate, search, hasEscrow, sortBy, sortOrder } = query;
    const safePage = Math.max(1, Math.trunc(Number.isFinite(page) ? page : 1));
    const safeLimit = Math.min(100, Math.max(1, Math.trunc(Number.isFinite(limit) ? limit : 20)));
    const skip = (safePage - 1) * safeLimit;

    const where: Prisma.OrderWhereInput = {};

    if (status) {
      where.status = status;
    }

    if (hasEscrow === true) {
      where.walletTransactions = {
        some: { type: WalletTransactionType.ORDER_LOCK, status: WalletTransactionStatus.SUCCESS },
      };
    }

    if (startDate || endDate) {
      where.createdAt = {};
      if (startDate) where.createdAt.gte = parseDateBoundaryWIB(startDate, 'start');
      if (endDate) where.createdAt.lte = parseDateBoundaryWIB(endDate, 'end');
    }

    if (search && search.trim()) {
      const searchTerm = escapeLikePattern(search.trim().slice(0, 100));
      where.OR = [
        { orderId: { contains: searchTerm, mode: 'insensitive' } },
        { title: { contains: searchTerm, mode: 'insensitive' } },
      ];
    }
    if (startDate && endDate) {
      const startBoundary = parseDateBoundaryWIB(startDate, 'start');
      const endBoundary = parseDateBoundaryWIB(endDate, 'end');
      if (startBoundary && endBoundary && startBoundary > endBoundary) {
        throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'startDate must be before or equal to endDate' });
      }
    }

    const orderBy: Prisma.OrderOrderByWithRelationInput | Prisma.OrderOrderByWithRelationInput[] = sortBy
      ? [{ [sortBy]: sortOrder ?? 'desc' }, { id: 'desc' }]
      : [{ createdAt: 'desc' }, { id: 'desc' }];

    const [orders, total] = await Promise.all([
      this.prisma.order.findMany({
        where,
        skip,
        take: safeLimit,
        orderBy,
        include: {
          buyer: { select: { userId: true, fullName: true, email: true } },
          seller: { select: { userId: true, fullName: true, email: true } },
        },
      }),
      this.prisma.order.count({ where }),
    ]);

    return createPaginatedResponse(orders.map(o => serializeOrder(o as unknown as Record<string, unknown>)), total, safePage, safeLimit);
  }

  async getOrderDetail(orderId: string): Promise<Record<string, unknown>> {
    const order = await this.prisma.order.findFirst({
      where: { OR: [{ id: orderId }, { orderId }] },
      include: {
        buyer: { select: { userId: true, username: true, fullName: true, email: true, kycStatus: true, averageRating: true, avatarUrl: true } },
        seller: { select: { userId: true, username: true, fullName: true, email: true, kycStatus: true, averageRating: true, avatarUrl: true } },
        statusHistories: { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] },
        walletTransactions: { orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] },
        dispute: true,
        ratings: true,
        extensionRequests: { orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] },
      },
    });

    if (!order) {
      throw new NotFoundException({ code: ErrorCodes.ORDER_NOT_FOUND, message: 'Order not found' });
    }

    return serializeOrder(order as unknown as Record<string, unknown>);
  }

  async forceCancel(orderId: string, adminId: string, dto: ForceActionDto, ipAddress: string = 'unknown'): Promise<{ orderId: string; status: OrderStatus }> {
    const order = await this.prisma.order.findFirst({
      where: { OR: [{ id: orderId }, { orderId }] },
    });

    if (!order) {
      throw new NotFoundException({ code: ErrorCodes.ORDER_NOT_FOUND, message: 'Order not found' });
    }

    await this.orderStateService.adminCancelOrder(
      order.orderId,
      adminId,
      dto.reason || 'Admin force cancel',
    );

    this.auditLog.logAdminAction({
      adminId,
      action: AuditAction.ORDER_FORCE_CANCEL,
      targetType: 'Order',
      targetId: order.orderId,
      description: `Admin force-cancelled order ${order.orderId}`,
      after: { reason: dto.reason },
      ipAddress,
    });

    this.logger.log(`Admin ${adminId} force-cancelled order ${order.orderId}`);

    return { orderId: order.orderId, status: OrderStatus.CANCELLED };
  }

  async forceComplete(orderId: string, adminId: string, dto: ForceActionDto, ipAddress: string = 'unknown'): Promise<{ orderId: string; status: OrderStatus }> {
    const order = await this.prisma.order.findFirst({
      where: { OR: [{ id: orderId }, { orderId }] },
      include: {
        buyer: { select: { wallet: { select: { id: true, availableBalance: true, escrowBalance: true, totalBalance: true, version: true } } } },
        seller: { select: { wallet: { select: { id: true, availableBalance: true, totalBalance: true, version: true } } } },
      },
    });

    if (!order) {
      throw new NotFoundException({ code: ErrorCodes.ORDER_NOT_FOUND, message: 'Order not found' });
    }

    // Disputed orders must be resolved through the dispute decision flow. This
    // path always releases the pre-completion buyer escrow and is therefore not
    // safe for a post-completion dispute whose source is seller escrow.
    const completableStatuses: OrderStatus[] = [
      OrderStatus.PROCESSING,
      OrderStatus.IN_DELIVERY,
    ];

    if (!completableStatuses.includes(order.status)) {
      throw new BadRequestException({
        code: ErrorCodes.INVALID_ORDER_STATUS,
        message: `Order cannot be force-completed at status ${order.status}`,
      });
    }

    const orderWithRelations = order as typeof order & {
      buyer: { wallet: { id: string; availableBalance: bigint; escrowBalance: bigint; totalBalance: bigint; version: number } | null };
      seller: { wallet: { id: string; availableBalance: bigint; totalBalance: bigint; version: number } | null };
    };
    const buyerWallet = orderWithRelations.buyer?.wallet;
    const sellerWallet = orderWithRelations.seller?.wallet;

    if (!buyerWallet || !sellerWallet) {
      throw new BadRequestException({ code: ErrorCodes.NOT_FOUND, message: 'Buyer or seller wallet not found' });
    }

    const releaseTxSerial = order.buyerPayAmount > BigInt(0)
      ? await this.walletTxSerialService.getNext()
      : 0;
    const receiveTxSerial = order.buyerPayAmount > BigInt(0)
      ? await this.walletTxSerialService.getNext()
      : 0;
    const feeTxSerial = order.feeAmount > BigInt(0)
      ? await this.walletTxSerialService.getNext()
      : null;

    await this.withSerializableRetry(() => this.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      const orderUpdated = await tx.order.updateMany({
        where: { id: order.id, status: { in: completableStatuses } },
        data: { status: OrderStatus.COMPLETED, completedAt: new Date() },
      });
      if (orderUpdated.count === 0) {
        throw new ConflictException({ code: ErrorCodes.INVALID_ORDER_STATUS, message: 'Order status changed concurrently' });
      }

      const escrowLock = await tx.walletTransaction.findFirst({
        where: { orderId: order.id, type: WalletTransactionType.ORDER_LOCK, status: WalletTransactionStatus.SUCCESS },
        select: { amount: true },
      });
      if (!escrowLock || escrowLock.amount !== order.buyerPayAmount) {
        throw new ConflictException({ code: ErrorCodes.ESCROW_LOCK_MISSING, message: 'Escrow lock ledger is missing or does not match this order' });
      }

      const [firstWalletId, secondWalletId] = [buyerWallet.id, sellerWallet.id].sort();
      await tx.$queryRaw`SELECT id FROM wallets WHERE id IN (${firstWalletId}, ${secondWalletId}) ORDER BY id FOR UPDATE`;
      const freshBuyerWallet = await tx.wallet.findUnique({ where: { id: buyerWallet.id } });
      const freshSellerWallet = await tx.wallet.findUnique({ where: { id: sellerWallet.id } });
      if (!freshBuyerWallet || !freshSellerWallet) {
        throw new BadRequestException({ code: ErrorCodes.NOT_FOUND, message: 'Buyer or seller wallet not found during force-complete' });
      }
      if (freshBuyerWallet.isLocked || freshSellerWallet.isLocked) {
        throw new ForbiddenException({ code: 'WALLET_LOCKED', message: 'A participant wallet is locked; force-complete is deferred.' });
      }

      await tx.orderStatusHistory.create({
        data: {
          orderId: order.id,
          fromStatus: order.status,
          toStatus: OrderStatus.COMPLETED,
          changedBy: adminId,
          changedByType: ActorType.ADMIN,
          reason: dto.reason || 'Admin force complete',
        },
      });

      await tx.orderExtensionRequest.updateMany({
        where: { orderId: order.id, status: 'PENDING' },
        data: {
          status: 'REJECTED',
          respondedAt: new Date(),
          rejectionNote: 'Order force-completed before the extension request was resolved',
        },
      });
      await tx.deliveryProof.updateMany({
        where: { orderId: order.id, status: 'SUBMITTED' },
        data: { status: 'ACCEPTED', reviewedAt: new Date() },
      });

      if (order.buyerPayAmount > BigInt(0)) {
        const buyerUpdated = await tx.wallet.updateMany({
          where: { id: freshBuyerWallet.id, version: freshBuyerWallet.version, escrowBalance: { gte: order.buyerPayAmount } },
          data: {
            escrowBalance: { decrement: order.buyerPayAmount },
            totalBalance: { decrement: order.buyerPayAmount },
            version: { increment: 1 },
          },
        });

        if (buyerUpdated.count === 0) {
          throw new BadRequestException({
            code: ErrorCodes.INSUFFICIENT_BALANCE,
            message: 'Failed to release escrow — concurrent update or insufficient escrow balance',
          });
        }

        const releaseTxId = generateWalletTxId(releaseTxSerial);
        await tx.walletTransaction.create({
          data: {
            txId: releaseTxId,
            walletId: freshBuyerWallet.id,
            type: WalletTransactionType.ORDER_RELEASE,
            status: WalletTransactionStatus.SUCCESS,
            amount: order.buyerPayAmount,
            balanceBefore: freshBuyerWallet.totalBalance,
            balanceAfter: freshBuyerWallet.totalBalance - order.buyerPayAmount,
            orderId: order.id,
            description: `Admin force-complete: escrow released for order ${order.orderId}`,
          },
        });

        const sellerUpdated = await tx.wallet.updateMany({
          where: { id: freshSellerWallet.id, version: freshSellerWallet.version },
          data: {
            availableBalance: { increment: order.sellerReceiveAmount },
            totalBalance: { increment: order.sellerReceiveAmount },
            version: { increment: 1 },
          },
        });

        if (sellerUpdated.count === 0) {
          throw new BadRequestException({
            code: ErrorCodes.INSUFFICIENT_BALANCE,
            message: 'Failed to credit seller wallet — concurrent update detected',
          });
        }

        const receiveTxId = generateWalletTxId(receiveTxSerial);
        await tx.walletTransaction.create({
          data: {
            txId: receiveTxId,
            walletId: freshSellerWallet.id,
            type: WalletTransactionType.ORDER_RELEASE,
            status: WalletTransactionStatus.SUCCESS,
            amount: order.sellerReceiveAmount,
            balanceBefore: freshSellerWallet.totalBalance,
            balanceAfter: freshSellerWallet.totalBalance + order.sellerReceiveAmount,
            orderId: order.id,
            description: `Admin force-complete: payment received for order ${order.orderId}`,
          },
        });
      }

      if (order.feeAmount > BigInt(0) && feeTxSerial !== null) {
        const feeBalanceBefore = freshBuyerWallet.totalBalance;
        const feeTxId = generateWalletTxId(feeTxSerial);
        await tx.walletTransaction.create({
          data: {
            txId: feeTxId,
            walletId: buyerWallet.id,
            type: WalletTransactionType.FEE_DEDUCT,
            status: WalletTransactionStatus.SUCCESS,
            amount: order.feeAmount,
            balanceBefore: feeBalanceBefore,
            balanceAfter: feeBalanceBefore - order.feeAmount,
            orderId: order.id,
            description: `Platform fee for admin force-completed order ${order.orderId}`,
          },
        });
      }

      await Promise.all([
        tx.user.update({
          where: { id: order.buyerId },
          data: {
            totalOrdersCompleted: { increment: 1 },
            totalOrdersAsBuyer: { increment: 1 },
            totalTransactionValue: { increment: order.orderValue },
          },
        }),
        tx.user.update({
          where: { id: order.sellerId },
          data: {
            totalOrdersCompleted: { increment: 1 },
            totalOrdersAsSeller: { increment: 1 },
            totalTransactionValue: { increment: order.orderValue },
          },
        }),
      ]);

      if (order.isKahadePlus && order.feeAmount > BigInt(0)) {
        const activeSub = await tx.subscription.findFirst({
          where: {
            userId: order.buyerId,
            status: { in: ['ACTIVE', 'CANCELLED'] },
            currentPeriodEnd: { gt: new Date() },
          },
          select: { id: true, feeSavingsUsed: true, feeSavingsLimit: true },
        });
        if (activeSub && activeSub.feeSavingsUsed < activeSub.feeSavingsLimit) {
          const feeConfig = await this.feeCalculator.getFeeConfig();
          const savings = this.feeCalculator.getPlusSavingsSen(order.orderValue, feeConfig);
          if (savings > BigInt(0)) {
            await tx.$executeRaw`
              UPDATE "subscriptions"
              SET "feeSavingsUsed" = LEAST("feeSavingsUsed" + ${savings}::bigint, "feeSavingsLimit")
              WHERE "id" = ${activeSub.id}
                AND "feeSavingsUsed" < "feeSavingsLimit"
            `;
          }
        }
      }

      await this.referralService.createReferralRewardIfEligible(order.buyerId, order.feeAmount, order.id, tx);
      await this.referralService.createReferralRewardIfEligible(order.sellerId, order.feeAmount, order.id, tx);

      await this.membershipRankService.checkAndUpdateMembershipRank(tx, order.buyerId);
      await this.membershipRankService.checkAndUpdateMembershipRank(tx, order.sellerId);
    }), 'ADMIN_FORCE_COMPLETE_TX');

    this.auditLog.logAdminAction({
      adminId,
      action: AuditAction.ORDER_FORCE_COMPLETE,
      targetType: 'Order',
      targetId: order.orderId,
      description: `Admin force-completed order ${order.orderId}`,
      after: { reason: dto.reason },
      ipAddress,
    });

    const recipients = [
      { userId: order.buyerId, title: 'Order Completed by Admin', body: `Order "${order.title}" has been completed by the Kahade team.` },
      { userId: order.sellerId, title: 'Funds Released by Admin', body: `Order "${order.title}" has been completed and funds have been released to your wallet.` },
    ];
    for (const recipient of recipients) {
      this.prisma.notification.create({
        data: {
          notifId: generateNotifId(),
          userId: recipient.userId,
          type: NotificationType.ORDER_COMPLETED,
          category: getCategoryForType(NotificationType.ORDER_COMPLETED),
          title: recipient.title,
          body: recipient.body,
          isRead: false,
        },
      }).catch((err: unknown) => this.logger.warn(`silent-catch: admin force-complete notification failed: ${err instanceof Error ? err.message : String(err)}`));
      this.prisma.emitNotificationCreated({ userId: recipient.userId, title: recipient.title, body: recipient.body, data: { type: 'ORDER_COMPLETED', orderId: order.orderId } });
    }

    this.logger.log(`Admin ${adminId} force-completed order ${order.orderId}`);

    return { orderId: order.orderId, status: OrderStatus.COMPLETED };
  }
}
