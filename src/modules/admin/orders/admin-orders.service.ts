import { Injectable, NotFoundException, BadRequestException, ConflictException, ForbiddenException, UnauthorizedException, Logger, Optional } from '@nestjs/common';
import { randomInt } from 'crypto';
import { PrismaService } from '../../../prisma/prisma.service';
import { bcryptCompare } from '../../../common/utils/crypto.util';
import { OrderStatus, AuditAction, Prisma, ActorType, WalletTransactionType, WalletTransactionStatus, NotificationType, DisputeStatus } from '@prisma/client';
import { getCategoryForType } from '../../notifications/notification-category.map';
import { createPaginatedResponse, PaginatedResponse } from '../../../common/dto/pagination.dto';
import { AuditLogService } from '../../../common/services/audit-log.service';
import { WalletTxSerialService } from '../../../common/services/wallet-tx-serial.service';
import { RedisService } from '../../../redis/redis.service';
import { generateWalletTxId, generateNotifId } from '../../../common/utils/id-generator.util';
import { creditCashbackIfEligible, planDanaCashback, executeDanaCashback } from '../../../common/utils/cashback-credit.util';
import { WalletModeService } from '../../wallet-mode/wallet-mode.service';
import { EscrowDisbursementService } from '../../no-wallet/escrow-disbursement.service';
import { OrderStateService } from '../../orders/order-state.service';
import { UnshippedOrderCancelService } from '../../orders/unshipped-order-cancel.service';
import { FeeCalculatorService } from '../../orders/fee-calculator.service';
import { ReferralService } from '../../referral/referral.service';
import { MembershipRankService } from '../../orders/membership-rank.service';
import { AdminOrderQueryDto, ForceActionDto, ForceActionWithReauthDto } from './dto/admin-order-query.dto';
import { toIdr } from '../../../common/utils/currency.util';
import { decryptPiiSafe } from '../../../common/utils/pii.util';
import { parseDateBoundaryWIB } from '../../../common/utils/date.util';
import * as ErrorCodes from '../../../common/constants/error-codes';
import { escapeLikePattern } from '../../../common/utils/search.util';
import { DashboardService } from '../dashboard/dashboard.service';

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
    private redis: RedisService,
    private orderStateService: OrderStateService,
    private unshippedCancelService: UnshippedOrderCancelService,
    private feeCalculator: FeeCalculatorService,
    private walletTxSerialService: WalletTxSerialService,
    private referralService: ReferralService,
    private membershipRankService: MembershipRankService,
    // AW-018: invalidasi cache summary dashboard (via helper terpusat).
    private readonly dashboard: DashboardService,
    // M4 no-wallet: payout cashback via disbursement DANA bila wallet mati.
    @Optional() private walletMode: WalletModeService | null,
    @Optional() private disbursement: EscrowDisbursementService | null,
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
        // A3 (audit 2026-09-26): admin sering menerima keluhan berbasis nomor resi —
        // schema sudah mengindeks trackingNumber untuk lookup ini.
        { trackingNumber: { contains: searchTerm, mode: 'insensitive' } },
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

    const result = serializeOrder(order as unknown as Record<string, unknown>);

    // Lokasi presisi buyer (fraud checking) — dekripsi fail-closed, ciphertext
    // mentah TIDAK pernah dikirim ke client.
    const encLat = result.buyerLatitude as string | null | undefined;
    const encLng = result.buyerLongitude as string | null | undefined;
    delete result.buyerLatitude;
    delete result.buyerLongitude;
    delete result.buyerLocationAccuracy;
    if (encLat && encLng) {
      const [lat, lng] = await Promise.all([decryptPiiSafe(encLat), decryptPiiSafe(encLng)]);
      const acc = await decryptPiiSafe(order.buyerLocationAccuracy as string | null | undefined);
      result.buyerLocation = lat !== null && lng !== null
        ? {
            latitude: lat,
            longitude: lng,
            accuracy: acc,
            capturedAt: order.buyerLocationCapturedAt
              ? (order.buyerLocationCapturedAt as Date).toISOString()
              : null,
          }
        : null;
    } else {
      result.buyerLocation = null;
    }

    return result;
  }

  // ADM-404: DISPUTE_ADMIN hanya boleh force-cancel order yang memiliki dispute AKTIF.
  // SUPER_ADMIN tidak dibatasi. Reason wajib (ForceActionDto, min 10 karakter) dan
  // aksi diaudit sebagai ORDER_FORCE_CANCEL.
  /**
   * AUT-013: re-auth password untuk aksi finansial final (force-cancel /
   * force-complete). JWT yang dicuri saja tidak cukup — penyerang harus tahu
   * password admin juga. Kegagalan diaudit (pola yang sama dengan
   * admin-business-verification.service.ts).
   */
  private async verifyAdminPasswordForForceAction(
    adminId: string,
    password: string | undefined,
    action: string,
    orderId: string,
    ipAddress: string,
  ): Promise<void> {
    if (!password) {
      throw new UnauthorizedException({
        code: ErrorCodes.UNAUTHORIZED,
        message: 'Re-authentication required for this action. Provide your password.',
      });
    }
    const admin = await this.prisma.adminUser.findUnique({ where: { id: adminId } });
    if (!admin || !admin.isActive || admin.deletedAt) {
      throw new UnauthorizedException({ code: ErrorCodes.UNAUTHORIZED, message: 'Admin not found' });
    }
    const isPasswordValid = await bcryptCompare(password, admin.password);
    if (!isPasswordValid) {
      // Kegagalan diaudit (pola yang sama dengan forceCancel/forceComplete:
      // fire-and-forget agar kegagalan audit tidak menggagalkan penolakan).
      this.auditLog.logAdminAction({
        adminId,
        action: AuditAction.ADMIN_ACTION,
        targetType: 'Order',
        targetId: orderId,
        description: `Failed re-authentication attempt for force ${action} on order ${orderId}`,
        ipAddress,
      });
      throw new UnauthorizedException({
        code: ErrorCodes.INVALID_CREDENTIALS,
        message: 'Invalid password for re-authentication',
      });
    }
  }

  async forceCancel(orderId: string, adminId: string, adminRole: string, dto: ForceActionWithReauthDto, ipAddress: string = 'unknown'): Promise<{ orderId: string; status: OrderStatus }> {
    // AUT-013: re-auth password SEBELUM menyentuh order.
    await this.verifyAdminPasswordForForceAction(adminId, dto.password, 'cancel', orderId, ipAddress);

    const order = await this.prisma.order.findFirst({
      where: { OR: [{ id: orderId }, { orderId }], deletedAt: null },
    });

    if (!order) {
      throw new NotFoundException({ code: ErrorCodes.ORDER_NOT_FOUND, message: 'Order not found' });
    }

    if (adminRole !== 'SUPER_ADMIN') {
      const activeDispute = await this.prisma.dispute.findFirst({
        where: { orderId: order.id, status: { not: DisputeStatus.RESOLVED } },
        select: { id: true },
      });
      if (!activeDispute) {
        throw new ForbiddenException({
          code: ErrorCodes.INSUFFICIENT_ADMIN_ROLE,
          message: 'Force-cancel di luar konteks sengketa memerlukan SUPER_ADMIN. DISPUTE_ADMIN hanya boleh force-cancel order dengan dispute aktif.',
        });
      }
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

    // AW-018: activeOrders di summary dashboard berubah.
    await this.dashboard.invalidateSummaryCache();

    return { orderId: order.orderId, status: OrderStatus.CANCELLED };
  }

  /**
   * Wave 3 P0 (2026-09-28) — SLA fallback manual untuk sweep
   * expire-unshipped-orders: admin memicu cancel + auto-refund untuk SATU
   * order yang melewati batas kirim tanpa pengiriman.
   *
   * Guard sama persis seperti sweep (status PROCESSING + belum dikirim +
   * lewat batas kirim + tanpa dispute berjalan) — fail closed. Bukan
   * force-cancel buta: order yang belum due / sudah dikirim / dispute
   * ditolak dengan 400.
   */
  async cancelUnshipped(orderId: string, adminId: string, dto: ForceActionDto, ipAddress: string = 'unknown'): Promise<{ orderId: string; status: string; outcome: string; detail?: string }> {
    const result = await this.unshippedCancelService.cancelUnshippedOrder(
      orderId,
      `admin:${adminId}`,
      dto.reason || 'Admin manual cancel: order melewati batas kirim tanpa pengiriman (SLA fallback)',
    );

    this.auditLog.logAdminAction({
      adminId,
      action: AuditAction.ORDER_FORCE_CANCEL,
      targetType: 'Order',
      targetId: result.orderId,
      description: `Admin cancel-unshipped order ${result.orderId} (outcome=${result.outcome})`,
      after: { reason: dto.reason, outcome: result.outcome, detail: result.detail },
      ipAddress,
    });

    this.logger.log(`[SECURITY] Admin ${adminId} cancel-unshipped order ${result.orderId}: ${result.outcome}`);

    // AW-018: activeOrders di summary dashboard berubah bila benar ter-cancel.
    if (result.outcome === 'CANCELLED_REFUNDED') {
      await this.dashboard.invalidateSummaryCache();
    }

    return {
      orderId: result.orderId,
      status: result.outcome === 'CANCELLED_REFUNDED' ? OrderStatus.CANCELLED : 'UNCHANGED',
      outcome: result.outcome,
      detail: result.detail,
    };
  }

  async forceComplete(orderId: string, adminId: string, dto: ForceActionWithReauthDto, ipAddress: string = 'unknown'): Promise<{ orderId: string; status: OrderStatus }> {
    // AUT-013: re-auth password SEBELUM menyentuh order.
    await this.verifyAdminPasswordForForceAction(adminId, dto.password, 'complete', orderId, ipAddress);

    const order = await this.prisma.order.findFirst({
      where: { OR: [{ id: orderId }, { orderId }], deletedAt: null },
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

    // SP-047: tandai bila referral reward dikreditkan agar cache leaderboard
    // diinvalidasi setelah tx commit.
    let referralRewardCredited = false;
    const forceCompleteCashback = await this.withSerializableRetry(() => this.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      const orderUpdated = await tx.order.updateMany({
        where: { id: order.id, status: { in: completableStatuses }, deletedAt: null },
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
            // EO-008: basis komponen saldo yang benar-benar bergerak — escrowBalance
            // untuk sisi buyer (selaras completeOrder user & auto-complete).
            // Delta (= ΔtotalBalance) tidak berubah → rekonsiliasi aman.
            balanceBefore: freshBuyerWallet.escrowBalance,
            balanceAfter: freshBuyerWallet.escrowBalance - order.buyerPayAmount,
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
            // EO-008: basis availableBalance untuk sisi seller (selaras completeOrder).
            balanceBefore: freshSellerWallet.availableBalance,
            balanceAfter: freshSellerWallet.availableBalance + order.sellerReceiveAmount,
            orderId: order.id,
            description: `Admin force-complete: payment received for order ${order.orderId}`,
          },
        });

        // Batch 1-money (EO-005): cashback voucher juga dikredit pada force-complete —
        // sebelumnya hangus diam-diam.
        // M4 no-wallet: wallet mati -> rencanakan payout DANA (eksekusi post-tx).
        const walletEnabled = this.walletMode?.isWalletEnabled() ?? true;
        if (walletEnabled) {
          const cashbackResult = await creditCashbackIfEligible(tx, () => this.walletTxSerialService.getNext(), {
            orderDbId: order.id,
            orderPublicId: order.orderId,
            source: 'force-complete',
          });
          return { cashbackResult, danaCashback: null };
        }
        const params = { orderDbId: order.id, orderPublicId: order.orderId, source: 'force-complete' };
        const intent = await planDanaCashback(tx, params);
        return { cashbackResult: null, danaCashback: intent ? { params, intent } : null };
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

      const buyerRewardCredited = await this.referralService.createReferralRewardIfEligible(order.buyerId, order.feeAmount, order.id, tx);
      const sellerRewardCredited = await this.referralService.createReferralRewardIfEligible(order.sellerId, order.feeAmount, order.id, tx);
      // SP-047: leaderboard cache diinvalidasi di bawah setelah tx commit.
      referralRewardCredited = referralRewardCredited || buyerRewardCredited || sellerRewardCredited;

      await this.membershipRankService.checkAndUpdateMembershipRank(tx, order.buyerId);
      await this.membershipRankService.checkAndUpdateMembershipRank(tx, order.sellerId);
    }), 'ADMIN_FORCE_COMPLETE_TX');

    if (referralRewardCredited) {
      await this.referralService.invalidateLeaderboardCache();
    }

    // R2-B (audit): forceComplete consumes the buyer's Plus fee-savings quota; the
    // `subscription_status:<userId>` cache (300 s, read by orders.service when quoting
    // fees) must be dropped like every other quota-consuming path does.
    await this.redis.del(`subscription_status:${order.buyerId}`).catch((err: unknown) =>
      this.logger.warn(`Failed to invalidate subscription status cache for ${order.buyerId}: ${err instanceof Error ? err.message : String(err)}`),
    );

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

    // M4 no-wallet: eksekusi payout cashback DANA post-tx (idempoten).
    const forceCompleteDana = forceCompleteCashback?.danaCashback ?? null;
    const forceCompleteCashbackResult = forceCompleteCashback?.cashbackResult ?? null;
    if (forceCompleteDana && this.disbursement) {
      try {
        const danaRes = await executeDanaCashback(this.disbursement, forceCompleteDana.params, forceCompleteDana.intent);
        if (danaRes.outcome === 'RELEASED') {
          const cashbackIdr = toIdr(forceCompleteDana.intent.amountSen).toLocaleString('id-ID');
          await this.prisma.notification.create({
            data: {
              notifId: generateNotifId(),
              userId: forceCompleteDana.intent.userId,
              type: NotificationType.CAMPAIGN_CASHBACK_CREDITED,
              category: getCategoryForType(NotificationType.CAMPAIGN_CASHBACK_CREDITED),
              title: 'Cashback Terkirim',
              body: `Cashback Rp ${cashbackIdr} dari order "${order.title}" telah dikirim ke rekening bank Anda.`,
              isRead: false,
            },
          }).catch((err: unknown) => this.logger.warn(`silent-catch: admin force-complete DANA cashback notification failed: ${err instanceof Error ? err.message : String(err)}`));
        }
      } catch (err) {
        // Idempoten — scheduler retryDue() akan mencoba lagi.
        this.logger.warn(`admin force-complete DANA cashback gagal untuk order ${order.orderId}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // Batch 1-money (EO-005): beritahu penerima bila cashback dikredit.
    if (forceCompleteCashbackResult?.credited && forceCompleteCashbackResult.userId) {
      const cashbackIdr = toIdr(forceCompleteCashbackResult.amount).toLocaleString('id-ID');
      this.prisma.notification.create({
        data: {
          notifId: generateNotifId(),
          userId: forceCompleteCashbackResult.userId,
          type: NotificationType.CAMPAIGN_CASHBACK_CREDITED,
          category: getCategoryForType(NotificationType.CAMPAIGN_CASHBACK_CREDITED),
          title: 'Cashback Credited',
          body: `Cashback Rp ${cashbackIdr} from order "${order.title}" has been credited to your wallet.`,
          isRead: false,
        },
      }).catch((err: unknown) => this.logger.warn(`silent-catch: admin force-complete cashback notification failed: ${err instanceof Error ? err.message : String(err)}`));
    }

    // AW-018: activeOrders/completedOrders di summary dashboard berubah.
    await this.dashboard.invalidateSummaryCache();

    return { orderId: order.orderId, status: OrderStatus.COMPLETED };
  }
}
