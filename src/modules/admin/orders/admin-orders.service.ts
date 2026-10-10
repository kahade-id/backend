import { Injectable, NotFoundException, BadRequestException, ConflictException, ForbiddenException, UnauthorizedException, Logger, Optional } from '@nestjs/common';
import { randomInt } from 'crypto';
import { PrismaService } from '../../../prisma/prisma.service';
import { bcryptCompare } from '../../../common/utils/crypto.util';
import { OrderStatus, AuditAction, Prisma, ActorType, WalletTransactionType, WalletTransactionStatus, NotificationType, DisputeStatus, PaymentProvider, PaymentPurpose, PaymentStatus, EscrowDisbursementScope, EscrowDisbursementStatus } from '@prisma/client';
import { getCategoryForType } from '../../notifications/notification-category.map';
// SYS-C-105: copy notifikasi mengikuti bahasa preferensi penerima.
import { renderNotificationCopy, resolveNotificationLanguage } from '../../notifications/notification-copy.service';
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
// P2: samarkan email buyer/seller untuk role non-SUPER_ADMIN.
import { applyUserMask } from '../../../common/maskPiiByRole';
import { AdminOrderQueryDto, ForceActionDto, ForceActionWithReauthDto } from './dto/admin-order-query.dto';
import { toIdr, formatSen } from '../../../common/utils/currency.util';
import { decryptPiiSafe } from '../../../common/utils/pii.util';
import { parseDateBoundaryWIB } from '../../../common/utils/date.util';
import * as ErrorCodes from '../../../common/constants/error-codes';
import { escapeLikePattern } from '../../../common/utils/search.util';
import { DashboardService } from '../dashboard/dashboard.service';

function serializeOrder(order: Record<string, unknown>, adminRole?: string): Record<string, unknown> {
  // P2: samarkan email buyer/seller untuk role non-SUPER_ADMIN.
  const buyer = order.buyer as Record<string, unknown> | null | undefined;
  const seller = order.seller as Record<string, unknown> | null | undefined;
  return {
    ...order,
    buyer: buyer ? { ...buyer, ...applyUserMask(adminRole, { email: buyer.email as string | null, phoneNumber: null }) } : buyer,
    seller: seller ? { ...seller, ...applyUserMask(adminRole, { email: seller.email as string | null, phoneNumber: null }) } : seller,
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

  async listOrders(query: AdminOrderQueryDto, adminRole?: string): Promise<PaginatedResponse<Record<string, unknown>>> {
    const { page = 1, limit = 20, status, kind, fulfillment, participantMode, category, startDate, endDate, search, hasEscrow, sortBy, sortOrder } = query;
    const safePage = Math.max(1, Math.trunc(Number.isFinite(page) ? page : 1));
    const safeLimit = Math.min(100, Math.max(1, Math.trunc(Number.isFinite(limit) ? limit : 20)));
    const skip = (safePage - 1) * safeLimit;

    const where: Prisma.OrderWhereInput = {};

    if (status) {
      where.status = status;
    }

    // POIN 2 (2026-10-04): filter jenis transaksi escrow.
    // DEPRECATED (2026-10-06, TX-UNIFIED-V2): tetap didukung via kolom lama (dual-write).
    if (kind) {
      where.orderKind = kind;
    }

    // TX-UNIFIED-V2 (2026-10-06): filter 3 dimensi independen.
    if (fulfillment) {
      where.fulfillment = fulfillment;
    }
    if (participantMode) {
      where.participantMode = participantMode;
    }
    if (category) {
      where.category = category;
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

    return createPaginatedResponse(orders.map(o => serializeOrder(o as unknown as Record<string, unknown>, adminRole)), total, safePage, safeLimit);
  }

  async getOrderDetail(orderId: string, adminRole?: string): Promise<Record<string, unknown>> {
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
        // MFE-012/MFE-013: expose jejak finansial DANA-direct di order detail
        // admin — lifecycle charge (payKind, partnerReferenceNo, fee, gross,
        // refund). Catatan: EscrowDisbursement TIDAK punya @relation balik ke
        // Order di skema (hanya kolom orderId), jadi antrean disbursement
        // di-query terpisah setelah order ditemukan, bukan via include.
        paymentTransactions: {
          where: { provider: PaymentProvider.DANA },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          select: {
            id: true,
            midtransOrderId: true,
            purpose: true,
            method: true,
            status: true,
            amount: true,
            paymentFee: true,
            grossAmount: true,
            refundedAmount: true,
            refundReference: true,
            danaPayKind: true,
            danaPartnerReferenceNo: true,
            danaReferenceNo: true,
            paidAt: true,
            failedAt: true,
            createdAt: true,
          },
        },
      },
    });

    if (!order) {
      throw new NotFoundException({ code: ErrorCodes.ORDER_NOT_FOUND, message: 'Order not found' });
    }

    // Antrean disbursement escrow untuk order ini (query terpisah — bukan
    // relation Prisma). Diurut terbaru dulu; select dibatasi ke field yang
    // relevan untuk panel admin.
    const orderDisbursements = await this.prisma.escrowDisbursement.findMany({
      where: { orderId: order.id },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: {
        id: true,
        scope: true,
        status: true,
        amountSen: true,
        heldReason: true,
        lastError: true,
        danaReferenceNo: true,
        releasedAt: true,
        createdAt: true,
      },
    });

    const result = serializeOrder(order as unknown as Record<string, unknown>, adminRole);

    // MFE-012/MFE-013: mapping ter-serialisasi untuk admin FE —
    // danaPayments berisi snapshot DANA-direct per order (BigInt→IDR).
    // Raw paymentTransactions/escrowDisbursements di-keep (backward compat
    // dengan konsumen lama); danaPayments adalah view yang diformat.
    result.danaPayments = (order.paymentTransactions as Array<Record<string, unknown>>).map(pt => ({
      id: pt.id as string,
      partnerReferenceNo: pt.midtransOrderId as string,
      payKind: (pt.danaPayKind as string | null) ?? 'UNKNOWN',
      purpose: pt.purpose as string,
      status: pt.status as string,
      amount: toIdr(pt.amount as bigint),
      providerFee: toIdr(pt.paymentFee as bigint),
      grossAmount: toIdr(pt.grossAmount as bigint),
      refundedAmount: toIdr(pt.refundedAmount as bigint),
      refundReference: (pt.refundReference as string | null) ?? null,
      danaPartnerReferenceNo: (pt.danaPartnerReferenceNo as string | null) ?? null,
      danaReferenceNo: (pt.danaReferenceNo as string | null) ?? null,
      paidAt: pt.paidAt ? (pt.paidAt as Date).toISOString() : null,
      failedAt: pt.failedAt ? (pt.failedAt as Date).toISOString() : null,
      createdAt: (pt.createdAt as Date).toISOString(),
    }));
    result.escrowDisbursementsList = (orderDisbursements as Array<Record<string, unknown>>).map(d => ({
      id: d.id as string,
      scope: d.scope as string,
      status: d.status as string,
      amount: toIdr(d.amountSen as bigint),
      heldReason: (d.heldReason as string | null) ?? null,
      lastError: (d.lastError as string | null) ?? null,
      danaReferenceNo: (d.danaReferenceNo as string | null) ?? null,
      releasedAt: d.releasedAt ? (d.releasedAt as Date).toISOString() : null,
      createdAt: (d.createdAt as Date).toISOString(),
    }));

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
  async cancelUnshipped(orderId: string, adminId: string, dto: ForceActionWithReauthDto, ipAddress: string = 'unknown'): Promise<{ orderId: string; status: string; outcome: string; detail?: string }> {
    // SEC-603: cancel-unshipped menggerakkan escrow (cancel + auto-refund) —
    // wajib re-auth password server-side seperti force-cancel/force-complete.
    await this.verifyAdminPasswordForForceAction(adminId, dto.password, 'cancel-unshipped', orderId, ipAddress);
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

    // Audit transaksi 2026-10-10 (force-complete no-wallet): di produksi
    // (WALLET_ENABLED=false) order dibayar DANA-direct — tidak ada wallet
    // maupun ledger ORDER_LOCK, sehingga force-complete selalu gagal
    // (NOT_FOUND / ESCROW_LOCK_MISSING). Jalur no-wallet: selesaikan order +
    // buat baris EscrowDisbursement PENDING di dalam tx (durable, pola
    // completeOrder E1), cairkan ke bank seller post-commit (idempoten
    // ORDER:<id>; cron retryDue menjemput bila gagal).
    const walletEnabledForComplete = this.walletMode?.isWalletEnabled() ?? true;
    const danaEscrowPayment = walletEnabledForComplete
      ? null
      : await this.prisma.paymentTransaction.findFirst({
          where: {
            orderId: order.id,
            purpose: PaymentPurpose.ORDER_ESCROW,
            provider: PaymentProvider.DANA,
            status: PaymentStatus.SUCCESS,
            danaPayKind: { not: null },
          },
          select: { id: true },
        });
    const noWalletPath = !walletEnabledForComplete && danaEscrowPayment !== null;
    if (noWalletPath && !this.disbursement) {
      throw new BadRequestException({
        code: 'DISBURSEMENT_UNAVAILABLE',
        message: 'Layanan disbursement DANA tidak tersedia — force-complete ditahan (fail-closed).',
      });
    }
    if (!noWalletPath && (!buyerWallet || !sellerWallet)) {
      throw new BadRequestException({ code: ErrorCodes.NOT_FOUND, message: 'Buyer or seller wallet not found' });
    }

    const releaseTxSerial = !noWalletPath && order.buyerPayAmount > BigInt(0)
      ? await this.walletTxSerialService.getNext()
      : 0;
    const receiveTxSerial = !noWalletPath && order.buyerPayAmount > BigInt(0)
      ? await this.walletTxSerialService.getNext()
      : 0;
    const feeTxSerial = !noWalletPath && order.feeAmount > BigInt(0)
      ? await this.walletTxSerialService.getNext()
      : null;
    type ForceCompleteCashbackPlan = {
      cashbackResult: Awaited<ReturnType<typeof creditCashbackIfEligible>> | null;
      danaCashback: {
        params: { orderDbId: string; orderPublicId: string; source: string };
        intent: NonNullable<Awaited<ReturnType<typeof planDanaCashback>>>;
      } | null;
    };

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

      let freshBuyerWallet!: NonNullable<Awaited<ReturnType<typeof tx.wallet.findUnique>>>;
      let freshSellerWallet!: NonNullable<Awaited<ReturnType<typeof tx.wallet.findUnique>>>;
      if (!noWalletPath) {
        const escrowLock = await tx.walletTransaction.findFirst({
          where: { orderId: order.id, type: WalletTransactionType.ORDER_LOCK, status: WalletTransactionStatus.SUCCESS },
          select: { amount: true },
        });
        if (!escrowLock || escrowLock.amount !== order.buyerPayAmount) {
          throw new ConflictException({ code: ErrorCodes.ESCROW_LOCK_MISSING, message: 'Escrow lock ledger is missing or does not match this order' });
        }

        const [firstWalletId, secondWalletId] = [buyerWallet!.id, sellerWallet!.id].sort();
        await tx.$queryRaw`SELECT id FROM wallets WHERE id IN (${firstWalletId}, ${secondWalletId}) ORDER BY id FOR UPDATE`;
        const lockedBuyerWallet = await tx.wallet.findUnique({ where: { id: buyerWallet!.id } });
        const lockedSellerWallet = await tx.wallet.findUnique({ where: { id: sellerWallet!.id } });
        if (!lockedBuyerWallet || !lockedSellerWallet) {
          throw new BadRequestException({ code: ErrorCodes.NOT_FOUND, message: 'Buyer or seller wallet not found during force-complete' });
        }
        if (lockedBuyerWallet.isLocked || lockedSellerWallet.isLocked) {
          throw new ForbiddenException({ code: 'WALLET_LOCKED', message: 'A participant wallet is locked; force-complete is deferred.' });
        }
        freshBuyerWallet = lockedBuyerWallet;
        freshSellerWallet = lockedSellerWallet;
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

      let cashbackPlan: ForceCompleteCashbackPlan = { cashbackResult: null, danaCashback: null };
      if (noWalletPath) {
        // Fail-closed: tanpa sellerReceiveAmount valid, jangan cairkan apa pun.
        if (order.sellerReceiveAmount == null || order.sellerReceiveAmount <= BigInt(0)) {
          throw new BadRequestException({
            code: 'ORDER_NOT_RELEASE_ELIGIBLE',
            message: 'Nominal pencairan escrow tidak valid — force-complete ditahan (fail-closed).',
          });
        }
        // K6: jejak durable pergerakan dana dibuat DI DALAM tx status — tidak
        // ada jalan uang bergerak (atau gagal bergerak) tanpa baris ledger.
        const disbKey = `ORDER:${order.id}`;
        const existingDisb = await tx.escrowDisbursement.findUnique({ where: { idempotencyKey: disbKey }, select: { id: true } });
        if (!existingDisb) {
          await tx.escrowDisbursement.create({
            data: {
              idempotencyKey: disbKey,
              scope: EscrowDisbursementScope.ORDER_ESCROW,
              orderId: order.id,
              sellerId: order.sellerId,
              amountSen: order.sellerReceiveAmount,
              status: EscrowDisbursementStatus.PENDING,
            },
          });
        }
        const params = { orderDbId: order.id, orderPublicId: order.orderId, source: 'force-complete' };
        const intent = await planDanaCashback(tx, params);
        cashbackPlan = { cashbackResult: null, danaCashback: intent ? { params, intent } : null };
      } else if (order.buyerPayAmount > BigInt(0)) {
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
        // Audit 2026-10-10: blok ini dulu `return` lebih awal dari callback tx
        // sehingga ledger FEE_DEDUCT, statistik user, kuota Plus, reward
        // referral, dan rank TIDAK PERNAH ditulis pada force-complete.
        const walletEnabled = this.walletMode?.isWalletEnabled() ?? true;
        if (walletEnabled) {
          const cashbackResult = await creditCashbackIfEligible(tx, () => this.walletTxSerialService.getNext(), {
            orderDbId: order.id,
            orderPublicId: order.orderId,
            source: 'force-complete',
          });
          cashbackPlan = { cashbackResult, danaCashback: null };
        } else {
          const params = { orderDbId: order.id, orderPublicId: order.orderId, source: 'force-complete' };
          const intent = await planDanaCashback(tx, params);
          cashbackPlan = { cashbackResult: null, danaCashback: intent ? { params, intent } : null };
        }
      }

      if (!noWalletPath && order.feeAmount > BigInt(0) && feeTxSerial !== null) {
        const feeBalanceBefore = freshBuyerWallet.totalBalance;
        const feeTxId = generateWalletTxId(feeTxSerial);
        await tx.walletTransaction.create({
          data: {
            txId: feeTxId,
            walletId: freshBuyerWallet.id,
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
      return cashbackPlan;
    }), 'ADMIN_FORCE_COMPLETE_TX');

    // Force-complete no-wallet: cairkan escrow ke bank seller post-commit.
    // Baris PENDING sudah durable; kegagalan di sini dijemput cron retryDue.
    if (noWalletPath && this.disbursement) {
      try {
        const release = await this.disbursement.releaseForOrder(order.id);
        this.logger.log(`Admin force-complete no-wallet: release order ${order.orderId} → ${release.outcome}`);
      } catch (err: unknown) {
        this.logger.error(
          `FORCE_COMPLETE_NO_WALLET_RELEASE_FAILED order=${order.orderId}: ${err instanceof Error ? err.message : String(err)} — retry via cron retryDue`,
        );
      }
    }

    if (referralRewardCredited) {
      await this.referralService.invalidateLeaderboardCache();
      // B13: beri tahu penerima reward (post-commit, best-effort).
      await this.referralService.notifyRewardsForOrder(orderId);
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
      { userId: order.buyerId, role: 'buyer' as const },
      { userId: order.sellerId, role: 'seller' as const },
    ];
    for (const recipient of recipients) {
      // SYS-C-105: copy mengikuti bahasa preferensi masing-masing penerima.
      const copy = renderNotificationCopy(
        NotificationType.ORDER_COMPLETED,
        await resolveNotificationLanguage(this.prisma, recipient.userId),
        { orderTitle: order.title, amount: formatSen(order.sellerReceiveAmount) },
      );
      this.prisma.notification.create({
        data: {
          notifId: generateNotifId(),
          userId: recipient.userId,
          type: NotificationType.ORDER_COMPLETED,
          category: getCategoryForType(NotificationType.ORDER_COMPLETED),
          title: copy.title,
          body: copy.body,
          isRead: false,
        },
      }).catch((err: unknown) => this.logger.warn(`silent-catch: admin force-complete notification failed: ${err instanceof Error ? err.message : String(err)}`));
      this.prisma.emitNotificationCreated({ userId: recipient.userId, title: copy.title, body: copy.body, data: { type: 'ORDER_COMPLETED', orderId: order.orderId } });
    }

    this.logger.log(`Admin ${adminId} force-completed order ${order.orderId}`);

    // M4 no-wallet: eksekusi payout cashback DANA post-tx (idempoten).
    const forceCompleteDana = forceCompleteCashback?.danaCashback ?? null;
    const forceCompleteCashbackResult = forceCompleteCashback?.cashbackResult ?? null;
    if (forceCompleteDana && this.disbursement) {
      try {
        const danaRes = await executeDanaCashback(this.disbursement, forceCompleteDana.params, forceCompleteDana.intent);
        if (danaRes.outcome === 'RELEASED') {
          const cashbackIdr = formatSen(forceCompleteDana.intent.amountSen);
          // SYS-C-105: copy mengikuti bahasa preferensi penerima.
          const danaCashbackCopy = renderNotificationCopy(
            NotificationType.CAMPAIGN_CASHBACK_CREDITED,
            await resolveNotificationLanguage(this.prisma, forceCompleteDana.intent.userId),
            { amount: cashbackIdr, orderTitle: order.title },
          );
          await this.prisma.notification.create({
            data: {
              notifId: generateNotifId(),
              userId: forceCompleteDana.intent.userId,
              type: NotificationType.CAMPAIGN_CASHBACK_CREDITED,
              category: getCategoryForType(NotificationType.CAMPAIGN_CASHBACK_CREDITED),
              title: danaCashbackCopy.title,
              body: danaCashbackCopy.body,
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
      const cashbackIdr = formatSen(forceCompleteCashbackResult.amount);
      // SYS-C-105: copy mengikuti bahasa preferensi penerima.
      const walletCashbackCopy = renderNotificationCopy(
        NotificationType.CAMPAIGN_CASHBACK_CREDITED,
        await resolveNotificationLanguage(this.prisma, forceCompleteCashbackResult.userId),
        { amount: cashbackIdr, orderTitle: order.title },
      );
      this.prisma.notification.create({
        data: {
          notifId: generateNotifId(),
          userId: forceCompleteCashbackResult.userId,
          type: NotificationType.CAMPAIGN_CASHBACK_CREDITED,
          category: getCategoryForType(NotificationType.CAMPAIGN_CASHBACK_CREDITED),
          title: walletCashbackCopy.title,
          body: walletCashbackCopy.body,
          isRead: false,
        },
      }).catch((err: unknown) => this.logger.warn(`silent-catch: admin force-complete cashback notification failed: ${err instanceof Error ? err.message : String(err)}`));
    }

    // AW-018: activeOrders/completedOrders di summary dashboard berubah.
    await this.dashboard.invalidateSummaryCache();

    return { orderId: order.orderId, status: OrderStatus.COMPLETED };
  }
}
