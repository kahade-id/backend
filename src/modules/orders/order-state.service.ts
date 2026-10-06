import { Injectable, BadRequestException, ConflictException, ForbiddenException, Logger } from '@nestjs/common';
import { randomInt } from 'crypto';
import { PrismaService } from '../../prisma/prisma.service';
import { RedisService } from '../../redis/redis.service';
import { WalletService } from '../wallet/wallet.service';
import { WalletModeService } from '../wallet-mode/wallet-mode.service';
import { ReferralService } from '../referral/referral.service';
import { RealtimeService } from '../realtime/realtime.service';
import { MembershipRankService } from './membership-rank.service';
import { OrderStatus, OrderCancelReason, ActorType, WalletTransactionType, WalletTransactionStatus, SubscriptionStatus, NotificationType, Prisma, VoucherType, EscrowDisbursementScope, EscrowDisbursementStatus } from '@prisma/client';
import { addDays, resolveDeliveryDeadlineAt, resolveProcessingDeadlineAt } from '../../common/utils/date.util';
import { rollbackOrderVoucherUsage } from '../../common/utils/voucher-rollback.util';
import { generateWalletTxId } from '../../common/utils/id-generator.util';
import { formatSen } from '../../common/utils/currency.util';
// SYS-C-105: copy notifikasi mengikuti bahasa preferensi penerima.
import { renderNotificationCopy, resolveNotificationLanguage } from '../notifications/notification-copy.service';
import { creditCashbackIfEligible, planDanaCashback, executeDanaCashback, DanaCashbackIntent } from '../../common/utils/cashback-credit.util';
import { EscrowDisbursementService } from '../no-wallet/escrow-disbursement.service';
import { WalletTxSerialService } from '../../common/services/wallet-tx-serial.service';
import { DanaDirectRefundService, deriveDanaRefundNo } from '../no-wallet/dana-direct-refund.service';
import { MilestonesService } from '../milestones/milestones.service';
import { FeeCalculatorService } from './fee-calculator.service';
import { NotificationQueueService } from '../queue/notification-queue.service';
import { OrderQrisPaymentService } from '../payment/order-qris-payment.service';
import * as ErrorCodes from '../../common/constants/error-codes';
import { PAYMENT_DEADLINE_DAYS, PROCESSING_DEADLINE_DAYS, PREORDER_DEFAULT_DEADLINE_DAYS, MAX_ESCROW_BALANCE } from '../../common/constants/app.constants';
import { withSpan } from '../../common/tracing/tracing';
// GAP-C (G176): aktivasi milestone setelah escrow lock — no-op untuk order
// satu tahap existing.
import { activateMilestonesForOrderTx } from '../milestones/milestone-activation';
import { computePatunganRebateTx, createPatunganRebateLedgerTx } from '../commerce/patungan-rebate';
// (katalog GAP-D G256/G257 dihapus total 2026-10-04 — hook reservasi stok dibuang)
import { Optional } from '@nestjs/common';
import { ActionLocationService, type ActionLocationContext } from '../action-location/action-location.service';
// Batch 43 BE-CHAT: pesan sistem otomatis di room order (best-effort).
// Dipanggil via registry statis — bukan import service, agar tidak ada
// circular DI antara modul orders dan chat.
import { ChatOrderHooks } from '../chat/chat-order-hooks';
import { CommerceOrderHooks } from '../commerce/commerce-order-hooks';

const VALID_CANCEL_REASONS = [
  'CHANGED_MIND',
  'WRONG_DETAILS',
  'DUPLICATE_ORDER',
  'MUTUAL_AGREEMENT',
  'COUNTERPART_UNRESPONSIVE',
  'OTHER',
] as const;

const ALLOWED_TRANSITIONS: Record<string, string[]> = {
  [OrderStatus.WAITING_CONFIRMATION]: [OrderStatus.WAITING_PAYMENT, OrderStatus.CANCELLED],
  [OrderStatus.WAITING_PAYMENT]: [OrderStatus.PROCESSING, OrderStatus.CANCELLED],
  [OrderStatus.PROCESSING]: [OrderStatus.IN_DELIVERY, OrderStatus.CANCELLED],
  [OrderStatus.IN_DELIVERY]: [OrderStatus.COMPLETED, OrderStatus.DISPUTED, OrderStatus.CANCELLED],
  [OrderStatus.COMPLETED]: [OrderStatus.DISPUTED],
  [OrderStatus.CANCELLED]: [],
  [OrderStatus.DISPUTED]: [OrderStatus.COMPLETED, OrderStatus.CANCELLED],
};

export interface ConfirmOrderResult {
  orderId: string;
  status: 'WAITING_PAYMENT' | 'CANCELLED';
}

export interface PayOrderResult {
  orderId: string;
  status: 'PROCESSING';
  walletTxId: string;
}

export interface CancelOrderResult {
  orderId: string;
  status: 'CANCELLED';
}

export interface CompleteOrderResult {
  orderId: string;
  status: 'COMPLETED';
}

@Injectable()
export class OrderStateService {
  private readonly logger = new Logger(OrderStateService.name);

  constructor(
    private prisma: PrismaService,
    private redis: RedisService,
    private walletService: WalletService,
    private walletMode: WalletModeService,
    private orderQrisPaymentService: OrderQrisPaymentService,
    @Optional() private danaDirectRefundService: DanaDirectRefundService,
    // E1 no-wallet (2026-09-30): WAJIB tersedia di mode no-wallet — fail-fast
    // saat startup bila tidak ter-wire, bukan fail-closed saat transaksi.
    private escrowDisbursementService: EscrowDisbursementService,
    private walletTxSerialService: WalletTxSerialService,
    private referralService: ReferralService,
    private feeCalculator: FeeCalculatorService,
    private realtime: RealtimeService,
    private membershipRankService: MembershipRankService,
    private notificationQueue: NotificationQueueService,
    // Lokasi presisi aksi sensitif — @Optional() mengikuti pola lama inventory.
    @Optional() private actionLocationService?: ActionLocationService,
    // M5 no-wallet: order bertahap DANA-direct di-cancel via refund parsial
    // per tahap (MilestonesService), bukan refundOrderEscrow penuh.
    @Optional() private milestonesService?: MilestonesService,
  ) {}

  private validateTransition(from: OrderStatus, to: OrderStatus): void {
    const allowed = ALLOWED_TRANSITIONS[from];
    if (!allowed || !allowed.includes(to)) {
      throw new BadRequestException({
        code: ErrorCodes.INVALID_STATE_TRANSITION,
        message: `Transition from ${from} to ${to} is not allowed`,
      });
    }
  }

  private runPostCommitBestEffort(task: () => Promise<void> | void, label: string): void {
    void Promise.resolve().then(task).catch((error: unknown) => {
      this.logger.warn(`${label} post-commit side effect failed: ${error instanceof Error ? error.message : String(error)}`);
    });
  }

  private runRealtimeBestEffort(task: () => void, label: string): void {
    try {
      task();
    } catch (error: unknown) {
      this.logger.warn(`${label} realtime side effect failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async withSerializableRetry<T>(fn: () => Promise<T>, label: string): Promise<T> {
    const maxRetries = 3;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        return await fn();
      } catch (error: unknown) {
        if (!this.isRetryableDbError(error) || attempt === maxRetries) {
          if (attempt === maxRetries && this.isRetryableDbError(error)) {
            this.logger.error(`${label} failed after ${maxRetries} attempts`, error instanceof Error ? error.stack : String(error));
          }
          throw error;
        }
        this.logger.warn(`${label} retrying attempt=${attempt}/${maxRetries}`);
        await new Promise((resolve) => setTimeout(resolve, 100 * Math.pow(2, attempt - 1) + randomInt(0, 50)));
      }
    }
    throw new Error(`${label}: unreachable`);
  }

  async handleConfirmAction(
    orderId: string,
    userId: string,
    action: 'ACCEPT' | 'REJECT',
    reason?: string,
  ): Promise<ConfirmOrderResult> {
    if (action === 'ACCEPT') {
      await this.confirmOrder(orderId, userId);
    } else {
      await this.rejectOrder(orderId, userId, reason);
    }
    const newStatus = action === 'ACCEPT' ? 'WAITING_PAYMENT' : 'CANCELLED';
    this.runRealtimeBestEffort(() => this.realtime.emitToOrder(orderId, 'order.status_changed', { orderId, status: newStatus }), 'CONFIRM_ACTION_STATUS');

    this.runPostCommitBestEffort(async () => {
      const order = await this.prisma.order.findUnique({ where: { orderId }, select: { buyerId: true, sellerId: true, title: true } });
      if (!order) return;
      const creatorId = order.buyerId === userId ? order.sellerId : order.buyerId;
      const notifType = action === 'ACCEPT' ? NotificationType.ORDER_ACCEPTED : NotificationType.ORDER_REJECTED;
      const title = action === 'ACCEPT' ? 'Order Confirmed' : 'Order Rejected';
      const body = action === 'ACCEPT'
        ? `Order "${order.title}" has been confirmed. Please proceed with payment.`
        : `Order "${order.title}" has been rejected.${reason ? ` Reason: ${reason}` : ''}`;
      await this.notificationQueue.enqueue({ userId: creatorId, type: notifType, title, body, pushData: { type: notifType, orderId } });
    }, 'CONFIRM_ACTION_NOTIFICATION');

    // (katalog dihapus total 2026-10-04 — hook stok inventory dihapus;
    // order tidak pernah punya order lines katalog)

    return { orderId, status: newStatus };
  }

  async handlePayOrder(orderId: string, userId: string, pin?: string, ip?: string, ctx?: ActionLocationContext): Promise<PayOrderResult> {
    // Misi BI-safe (defense in depth — guard juga ada di controller):
    // bayar pakai saldo wallet dilarang saat wallet nonaktif.
    if (!this.walletMode.isWalletEnabled()) {
      throw new ForbiddenException({
        code: 'WALLET_DISABLED',
        message: 'Pembayaran via saldo wallet nonaktif — bayar escrow langsung via DANA (POST :orderId/pay-dana).',
      });
    }
    if (!pin) {
      throw new BadRequestException({
        code: ErrorCodes.UNAUTHORIZED,
        message: 'Wallet PIN is required for order payment. Please update your app to the latest version.',
      });
    }
    await this.walletService.verifyPin(userId, pin, ip);
    const { walletTxId } = await this.payOrder(orderId, userId);
    this.runRealtimeBestEffort(() => this.realtime.emitToOrder(orderId, 'order.status_changed', { orderId, status: 'PROCESSING' }), 'PAY_ORDER_STATUS');

    // Lokasi presisi tiap aksi sensitif — best-effort, tidak pernah throw.
    await this.actionLocationService?.logAction({
      userId,
      actionType: 'ORDER_PAY',
      referenceType: 'ORDER',
      referenceId: orderId,
      location: ctx?.location,
      ipAddress: ctx?.ipAddress ?? ip,
      deviceId: ctx?.deviceId,
    });

    this.runPostCommitBestEffort(async () => {
      const order = await this.prisma.order.findUnique({ where: { orderId }, select: { sellerId: true, title: true, buyerPayAmount: true } });
      if (!order) return;
      // SYS-C-105: copy mengikuti bahasa preferensi seller.
      const payCopy = renderNotificationCopy(
        NotificationType.ORDER_PAYMENT_RECEIVED,
        await resolveNotificationLanguage(this.prisma, order.sellerId),
        { amount: formatSen(order.buyerPayAmount), orderTitle: order.title },
      );
      await this.notificationQueue.enqueue({ userId: order.sellerId, type: NotificationType.ORDER_PAYMENT_RECEIVED, title: payCopy.title, body: payCopy.body, pushData: { type: 'ORDER_PAYMENT_RECEIVED', orderId } });
    }, 'PAY_ORDER_NOTIFICATION');

    // Batch 43 BE-CHAT: pesan sistem "bayar diterima" di room order.
    this.runPostCommitBestEffort(() => ChatOrderHooks.emit(orderId, 'ORDER_PAID'), 'CHAT_ORDER_PAID_SYSTEM_MSG');
    // POIN 2 (2026-10-04): peserta jastip/patungan yang order-nya dibuat via
    // create-order ditandai PAID saat pembayaran terkonfirmasi (best-effort;
    // fallback idempoten: scheduler commerce syncPaidParticipants).
    this.runPostCommitBestEffort(() => CommerceOrderHooks.emitOrderPaid(orderId), 'COMMERCE_ORDER_PAID_SYNC');

    return { orderId, status: 'PROCESSING', walletTxId };
  }

  /**
   * G479: span bisnis order.complete — membungkus handleCompleteOrderTx.
   * Atribut span hanya yang aman (tanpa judul order / nama user).
   */
  async handleCompleteOrder(orderId: string, userId: string, ctx?: ActionLocationContext): Promise<CompleteOrderResult> {
    return withSpan('order.complete', async () => {
      const result = await this.handleCompleteOrderTx(orderId, userId);
      // Lokasi presisi tiap aksi sensitif — best-effort, tidak pernah throw.
      await this.actionLocationService?.logAction({
        userId,
        actionType: 'ORDER_CONFIRM_RECEIPT',
        referenceType: 'ORDER',
        referenceId: orderId,
        location: ctx?.location,
        ipAddress: ctx?.ipAddress,
        deviceId: ctx?.deviceId,
      });
      return result;
    }, {
      currency: 'IDR',
    });
  }

  private async handleCompleteOrderTx(orderId: string, userId: string): Promise<CompleteOrderResult> {
    await this.completeOrder(orderId, userId);
    this.runRealtimeBestEffort(() => this.realtime.emitToOrder(orderId, 'order.status_changed', { orderId, status: 'COMPLETED' }), 'COMPLETE_ORDER_STATUS');

    this.runPostCommitBestEffort(async () => {
      const order = await this.prisma.order.findUnique({ where: { orderId }, select: { id: true, buyerId: true, sellerId: true, title: true, sellerReceiveAmount: true } });
      if (!order) return;
      // SYS-C-105: copy mengikuti bahasa preferensi masing-masing penerima.
      const sellerCopy = renderNotificationCopy(
        NotificationType.ORDER_COMPLETED,
        await resolveNotificationLanguage(this.prisma, order.sellerId),
        { orderTitle: order.title, amount: formatSen(order.sellerReceiveAmount) },
      );
      const buyerCopy = renderNotificationCopy(
        NotificationType.WALLET_FUNDS_RELEASED,
        await resolveNotificationLanguage(this.prisma, order.buyerId),
        { orderTitle: order.title, amount: formatSen(order.sellerReceiveAmount) },
      );
      await this.notificationQueue.enqueue({ userId: order.sellerId, type: NotificationType.ORDER_COMPLETED, title: sellerCopy.title, body: sellerCopy.body, pushData: { type: 'ORDER_COMPLETED', orderId } });
      await this.notificationQueue.enqueue({ userId: order.buyerId, type: NotificationType.WALLET_FUNDS_RELEASED, title: buyerCopy.title, body: buyerCopy.body, pushData: { type: 'WALLET_FUNDS_RELEASED', orderId } });
      const cashbackUsage = await this.prisma.voucherUsage.findFirst({
        where: { orderId: order.id, discountApplied: { gt: BigInt(0) }, voucher: { voucherType: VoucherType.WALLET_CASHBACK } },
        select: { userId: true, discountApplied: true },
      });
      if (cashbackUsage) {
        const cashbackCopy = renderNotificationCopy(
          NotificationType.CAMPAIGN_CASHBACK_CREDITED,
          await resolveNotificationLanguage(this.prisma, cashbackUsage.userId),
          { amount: formatSen(cashbackUsage.discountApplied), orderTitle: order.title },
        );
        await this.notificationQueue.enqueue({
          userId: cashbackUsage.userId,
          type: NotificationType.CAMPAIGN_CASHBACK_CREDITED,
          title: cashbackCopy.title,
          body: cashbackCopy.body,
          pushData: { type: 'CAMPAIGN_CASHBACK_CREDITED', orderId },
        });
      }
    }, 'COMPLETE_ORDER_NOTIFICATION');

    // Batch 43 BE-CHAT: pesan sistem "dana dicairkan" + arsip otomatis room.
    this.runPostCommitBestEffort(() => ChatOrderHooks.emit(orderId, 'ORDER_COMPLETED'), 'CHAT_ORDER_COMPLETED_SYSTEM_MSG');

    return { orderId, status: 'COMPLETED' };
  }

  async handleCancelOrder(orderId: string, userId: string, reason: string, note?: string, ctx?: ActionLocationContext): Promise<CancelOrderResult> {
    const normalizedReason = reason.trim().toUpperCase();
    if (!VALID_CANCEL_REASONS.includes(normalizedReason as typeof VALID_CANCEL_REASONS[number])) {
      throw new BadRequestException({
        code: ErrorCodes.INVALID_CANCEL_REASON,
        message: `Invalid cancel reason. Allowed values: ${VALID_CANCEL_REASONS.join(', ')}`,
      });
    }
    await this.cancelOrder(orderId, userId, normalizedReason, note);
    this.runRealtimeBestEffort(() => this.realtime.emitToOrder(orderId, 'order.status_changed', { orderId, status: 'CANCELLED' }), 'CANCEL_ORDER_STATUS');

    // Lokasi presisi tiap aksi sensitif — best-effort, tidak pernah throw.
    await this.actionLocationService?.logAction({
      userId,
      actionType: 'ORDER_CANCEL',
      referenceType: 'ORDER',
      referenceId: orderId,
      location: ctx?.location,
      ipAddress: ctx?.ipAddress,
      deviceId: ctx?.deviceId,
    });

    this.runPostCommitBestEffort(async () => {
      const order = await this.prisma.order.findUnique({ where: { orderId }, select: { buyerId: true, sellerId: true, title: true } });
      if (!order) return;
      const recipientId = order.buyerId === userId ? order.sellerId : order.buyerId;
      // SYS-C-105: copy mengikuti bahasa preferensi penerima.
      const cancelCopy = renderNotificationCopy(
        NotificationType.ORDER_CANCELLED,
        await resolveNotificationLanguage(this.prisma, recipientId),
        { orderTitle: order.title, reason: ` Reason: ${normalizedReason}${note ? `. ${note}` : ''}` },
      );
      await this.notificationQueue.enqueue({ userId: recipientId, type: NotificationType.ORDER_CANCELLED, title: cancelCopy.title, body: cancelCopy.body, pushData: { type: 'ORDER_CANCELLED', orderId } });
    }, 'CANCEL_ORDER_NOTIFICATION');

    return { orderId, status: 'CANCELLED' };
  }

  async confirmOrder(orderId: string, userId: string): Promise<void> {
    await this.withSerializableRetry(() => this.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      // AUDIT-16: exclude soft-deleted orders — every other surface (list views, WS
      // rooms, scheduler crons) filters `deletedAt: null`; without it a deleted order
      // could keep advancing while the crons no longer see it, stranding escrow.
      const order = await tx.order.findFirst({ where: { orderId, deletedAt: null } });

      if (!order) {
        throw new BadRequestException({ code: ErrorCodes.ORDER_NOT_FOUND, message: 'Order not found' });
      }
      const isCounterpart = order.createdByBuyer
        ? order.sellerId === userId
        : order.buyerId === userId;
      if (!isCounterpart) {
        throw new BadRequestException({ code: ErrorCodes.NOT_ORDER_PARTICIPANT, message: 'Not authorized to confirm this order' });
      }
      if (order.status !== OrderStatus.WAITING_CONFIRMATION) {
        throw new BadRequestException({ code: ErrorCodes.INVALID_ORDER_STATUS, message: 'Order is not waiting for confirmation' });
      }
      if (order.confirmationDeadlineAt && Date.now() >= order.confirmationDeadlineAt.getTime()) {
        throw new BadRequestException({ code: ErrorCodes.INVALID_ORDER_STATUS, message: 'Confirmation deadline has passed' });
      }
      this.validateTransition(order.status, OrderStatus.WAITING_PAYMENT);

      const updated = await tx.order.updateMany({
        where: { id: order.id, status: OrderStatus.WAITING_CONFIRMATION, deletedAt: null, OR: [{ confirmationDeadlineAt: null }, { confirmationDeadlineAt: { gt: new Date() } }] },
        data: {
          status: OrderStatus.WAITING_PAYMENT,
          confirmedAt: new Date(),
          paymentDeadlineAt: addDays(new Date(), PAYMENT_DEADLINE_DAYS),
        },
      });

      if (updated.count === 0) {
        throw new BadRequestException({ code: ErrorCodes.INVALID_ORDER_STATUS, message: 'Order status has already changed' });
      }

      const changedByType = order.createdByBuyer ? ActorType.SELLER : ActorType.BUYER;
      await tx.orderStatusHistory.create({
        data: {
          orderId: order.id,
          fromStatus: OrderStatus.WAITING_CONFIRMATION,
          toStatus: OrderStatus.WAITING_PAYMENT,
          changedBy: userId,
          changedByType,
        },
      });
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }), 'CONFIRM_ORDER_TX');
  }

  async rejectOrder(orderId: string, userId: string, reason?: string): Promise<void> {
    await this.withSerializableRetry(() => this.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      const order = await tx.order.findFirst({ where: { orderId, deletedAt: null } }); // AUDIT-16

      if (!order) {
        throw new BadRequestException({ code: ErrorCodes.ORDER_NOT_FOUND, message: 'Order not found' });
      }
      const isCounterpart = order.createdByBuyer
        ? order.sellerId === userId
        : order.buyerId === userId;
      if (!isCounterpart) {
        throw new BadRequestException({ code: ErrorCodes.NOT_ORDER_PARTICIPANT, message: 'Not authorized to reject this order' });
      }
      if (order.status !== OrderStatus.WAITING_CONFIRMATION) {
        throw new BadRequestException({ code: ErrorCodes.INVALID_ORDER_STATUS, message: 'Order is not waiting for confirmation' });
      }
      this.validateTransition(order.status, OrderStatus.CANCELLED);

      const updated = await tx.order.updateMany({
        where: { id: order.id, status: OrderStatus.WAITING_CONFIRMATION, deletedAt: null },
        data: {
          status: OrderStatus.CANCELLED,
          cancelledAt: new Date(),
          cancelReason: 'REJECTED_BY_COUNTERPART',
          cancelNote: reason,
        },
      });

      if (updated.count === 0) {
        throw new BadRequestException({ code: ErrorCodes.INVALID_ORDER_STATUS, message: 'Order status has already changed' });
      }

      const changedByType = order.createdByBuyer ? ActorType.SELLER : ActorType.BUYER;
      await tx.orderStatusHistory.create({
        data: {
          orderId: order.id,
          fromStatus: OrderStatus.WAITING_CONFIRMATION,
          toStatus: OrderStatus.CANCELLED,
          changedBy: userId,
          changedByType,
          reason,
        },
      });

      if (order.voucherId) {
        // SP-034: rollback via helper bersama — kembalikan currentUsage DAN
        // campaign.currentRedemptions.
        await rollbackOrderVoucherUsage(tx, order.id, order.voucherId);
      }

    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }), 'REJECT_ORDER_TX');
  }

  async payOrder(orderId: string, buyerId: string): Promise<{ walletTxId: string }> {
    const order = await this.prisma.order.findFirst({
      where: { orderId, deletedAt: null }, // AUDIT-16
      include: { buyer: { select: { wallet: { select: { id: true } } } } },
    });

    if (!order) {
      throw new BadRequestException({ code: ErrorCodes.ORDER_NOT_FOUND, message: 'Order not found' });
    }
    if (order.status !== OrderStatus.WAITING_PAYMENT) {
      throw new BadRequestException({ code: ErrorCodes.INVALID_ORDER_STATUS, message: 'Order is not waiting for payment' });
    }
    this.validateTransition(order.status, OrderStatus.PROCESSING);
    if (order.buyerId !== buyerId) {
      throw new BadRequestException({ code: ErrorCodes.NOT_ORDER_PARTICIPANT, message: 'Not authorized to pay this order' });
    }
    // Guard against paying an expired order that the scheduler hasn't auto-cancelled yet.
    if (order.paymentDeadlineAt && Date.now() >= order.paymentDeadlineAt.getTime()) {
      throw new BadRequestException({ code: ErrorCodes.ORDER_PAYMENT_EXPIRED, message: 'Payment deadline has passed. The order will be cancelled shortly.' });
    }

    const buyerWalletId = order.buyer?.wallet?.id;
    if (!buyerWalletId) {
      throw new BadRequestException({ code: ErrorCodes.NOT_FOUND, message: 'Buyer wallet not found' });
    }

    let walletTxId!: string;

    const walletTxSerial = await this.getNextWalletTxSerial();

    await this.withSerializableRetry(() => this.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      const freshOrder = await tx.order.findFirst({ where: { id: order.id, deletedAt: null }, select: { status: true, paymentDeadlineAt: true, buyerId: true, buyerPayAmount: true } }); // AUDIT-16
      if (!freshOrder || freshOrder.status !== OrderStatus.WAITING_PAYMENT) {
        throw new BadRequestException({ code: ErrorCodes.INVALID_ORDER_STATUS, message: 'Order is no longer waiting for payment' });
      }
      if (freshOrder.paymentDeadlineAt && Date.now() >= freshOrder.paymentDeadlineAt.getTime()) {
        throw new BadRequestException({ code: ErrorCodes.ORDER_PAYMENT_EXPIRED, message: 'Payment deadline has passed' });
      }
      if (freshOrder.buyerId !== buyerId || freshOrder.buyerPayAmount !== order.buyerPayAmount) {
        throw new ConflictException({ code: ErrorCodes.OPTIMISTIC_LOCK_CONFLICT, message: 'Order payment terms changed, please reload and retry' });
      }

      const wallet = await tx.wallet.findUnique({ where: { id: buyerWalletId } });
      if (!wallet) throw new BadRequestException({ code: ErrorCodes.NOT_FOUND, message: 'Buyer wallet not found' });
      if (wallet.isLocked) {
        throw new BadRequestException({ code: 'WALLET_LOCKED', message: 'Your wallet is locked. Please contact support.' });
      }
      if (wallet.availableBalance < order.buyerPayAmount) {
        throw new BadRequestException({ code: ErrorCodes.INSUFFICIENT_BALANCE, message: 'Insufficient balance for payment' });
      }
      const maxEscrowSen = BigInt(MAX_ESCROW_BALANCE) * BigInt(100);
      if (wallet.escrowBalance + order.buyerPayAmount > maxEscrowSen) {
        throw new BadRequestException({ code: ErrorCodes.ESCROW_LIMIT_EXCEEDED, message: 'Total escrow balance would exceed the maximum limit. Please wait for existing orders to complete.' });
      }
      const updated = await tx.wallet.updateMany({
        where: { id: buyerWalletId, version: wallet.version, availableBalance: { gte: order.buyerPayAmount } },
        data: { availableBalance: { decrement: order.buyerPayAmount }, escrowBalance: { increment: order.buyerPayAmount }, version: { increment: 1 } },
      });
      if (updated.count === 0) {
        throw new BadRequestException({ code: ErrorCodes.OPTIMISTIC_LOCK_CONFLICT, message: 'Concurrent update detected, please retry' });
      }
      walletTxId = generateWalletTxId(walletTxSerial);
      await tx.walletTransaction.create({
        data: {
          txId: walletTxId,
          walletId: buyerWalletId,
          type: WalletTransactionType.ORDER_LOCK,
          status: WalletTransactionStatus.SUCCESS,
          amount: order.buyerPayAmount,
          balanceBefore: wallet.availableBalance,
          balanceAfter: wallet.availableBalance - order.buyerPayAmount,
          orderId: order.id,
          description: `Escrow lock for order ${order.orderId}`,
        },
      });
      // GAP-C (G176): aktivasi milestone SETELAH escrow lock sukses, dalam
      // transaksi yang sama. No-op untuk order tanpa milestone — jalur escrow
      // satu tahap existing tidak berubah.
      await activateMilestonesForOrderTx(tx, order.id);
      const paidAt = new Date();
      const orderUpdated = await tx.order.updateMany({
        where: { id: order.id, status: OrderStatus.WAITING_PAYMENT, deletedAt: null }, // AUDIT-16
        data: {
          status: OrderStatus.PROCESSING,
          paidAt,
          processedAt: paidAt,
          // T3: hormati tanggal eksplisit pilihan user bila masih di masa depan.
          deliveryDeadlineAt: resolveDeliveryDeadlineAt(order.deliveryDeadlineAt, order.deliveryDeadlineDays ?? 3),
          // Wave 3 P0: batas kirim penjual — dipakai sweep expire-unshipped-orders.
          // TX-UNIFIED-V2 (P1-3): PREORDER pakai estimasi (bukan 2 hari) agar
          // preorder yang sah tidak terbatal otomatis oleh sweep.
          processingDeadlineAt: resolveProcessingDeadlineAt(
            order.fulfillment,
            order.preorderEstimatedDate,
            paidAt,
            PROCESSING_DEADLINE_DAYS,
            PREORDER_DEFAULT_DEADLINE_DAYS,
          ),
        },
      });
      if (orderUpdated.count === 0) {
        throw new ConflictException({ code: ErrorCodes.INVALID_ORDER_STATUS, message: 'Order status changed concurrently, please retry' });
      }
      await tx.orderStatusHistory.create({
        data: { orderId: order.id, fromStatus: OrderStatus.WAITING_PAYMENT, toStatus: OrderStatus.PROCESSING, changedBy: buyerId, changedByType: ActorType.BUYER },
      });
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }), 'PAY_ORDER_TX');

    return { walletTxId };
  }

  async completeOrder(orderId: string, buyerId: string, deliveryProofId?: string): Promise<void> {
    const MAX_RETRIES = 3;
    let lastError: unknown;

    /*
     * C-25: the wallet tx serials are drawn OUTSIDE the retry loop.
     *
     * `getNextWalletTxSerial` resolves to a Redis `INCR`
     * (`wallet-tx-serial.service.ts:37` → :53 → :41), so it does NOT roll back when PostgreSQL
     * aborts the transaction. Drawing all three inside the retried body burned up to 9
     * `wallet_tx_serial` values for a single completion and left 6 gaps in the day's
     * `WLT-YYYYMMDD-NNNN` ledger sequence — on the escrow release path, which is exactly where a
     * contiguous audit trail matters most. Same hazard the order serial avoids in
     * `order-links.service.ts` (C-23) and the dispute serial in `delivery-proof.service.ts` (C-24).
     *
     * Hoisting also shortens the transaction: the draw can take a `setNx` + a DB read + a 100 ms
     * sleep on the first serial of the day (`wallet-tx-serial.service.ts:60-90`), and none of that
     * belongs inside an open Serializable transaction.
     *
     * The release and receive serials are unconditional — every committed completion writes both —
     * so they are hoisted outright. The fee serial is drawn lazily because its row is conditional on
     * `feeAmount > 0`: hoisting it too would burn one on every zero-fee (fully vouchered)
     * completion, a gap the pre-fix code produced even with zero retries.
     *
     * GAP-C (G176/G186) preflight: tolak order bermilestone SEBELUM serial dialokasikan,
     * agar pemanggilan salah tidak membakar nomor urut ledger. Guard otoritatif tetap
     * ada di dalam transaksi (lihat bawah); preflight ini hanya optimasi hemat serial.
     */
    const preflight = await this.prisma.order.findFirst({ where: { orderId, deletedAt: null }, select: { id: true } });
    if (preflight) {
      const preCount = await this.prisma.orderMilestone.count({ where: { orderId: preflight.id } });
      if (preCount > 0) {
        throw new BadRequestException({
          code: 'MILESTONE_ORDER_LEGACY_FLOW_FORBIDDEN',
          message: 'Order ini memakai skema milestone bertahap; selesaikan lewat alur milestone, bukan konfirmasi satu tahap',
        });
      }
    }
    const releaseTxSerial = await this.getNextWalletTxSerial();
    const receiveTxSerial = await this.getNextWalletTxSerial();
    let feeSerial: number | null = null;
    const nextFeeTxSerial = async (): Promise<number> => {
      if (feeSerial === null) feeSerial = await this.getNextWalletTxSerial();
      return feeSerial;
    };
    let cashbackSerial: number | null = null;
    const nextCashbackTxSerial = async (): Promise<number> => {
      if (cashbackSerial === null) cashbackSerial = await this.getNextWalletTxSerial();
      return cashbackSerial;
    };
    // M6: serial ledger rebate overfunding patungan — kondisional (hanya bila
    // order yang selesai ditautkan ke peserta patungan & ada overfunding),
    // jadi digambar lazy seperti fee/cashback agar tidak membakar nomor urut.
    let rebateSerial: number | null = null;
    const nextRebateTxSerial = async (): Promise<number> => {
      if (rebateSerial === null) rebateSerial = await this.getNextWalletTxSerial();
      return rebateSerial;
    };
    // SP-047: tandai bila referral reward dikreditkan agar cache leaderboard
    // diinvalidasi SETELAH tx commit (di luar retry loop).
    let referralRewardCredited = false;
    // M4 no-wallet: intent payout cashback DANA (dieksekusi post-commit).
    let danaCashback: { params: { orderDbId: string; orderPublicId: string; source: string }; intent: DanaCashbackIntent } | null = null;
    // E1 (2026-09-30): release escrow DANA untuk order single-stage mode
    // no-wallet — baris PENDING dibuat di dalam tx, settlement dieksekusi
    // post-commit (pola sama M5 milestone).
    let danaEscrowRelease: { orderDbId: string; orderPublicId: string } | null = null;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
    await this.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      const order = await tx.order.findFirst({ where: { orderId, deletedAt: null } }); // AUDIT-16

      if (!order) {
        throw new BadRequestException({ code: ErrorCodes.ORDER_NOT_FOUND, message: 'Order not found' });
      }
      if (order.status !== OrderStatus.IN_DELIVERY) {
        throw new BadRequestException({ code: ErrorCodes.INVALID_ORDER_STATUS, message: 'Order is not in delivery' });
      }
      this.validateTransition(order.status, OrderStatus.COMPLETED);
      if (order.buyerId !== buyerId) {
        throw new BadRequestException({ code: ErrorCodes.NOT_ORDER_PARTICIPANT, message: 'Not authorized to complete this order' });
      }

      // GAP-C (G176/G186): order bermilestone TIDAK BOLEH diselesaikan lewat
      // jalur legacy — dana sudah dicairkan per tahap via milestone flow.
      // Memanggil release penuh di sini akan mencairkan ganda (double-release).
      const milestoneCount = await tx.orderMilestone.count({ where: { orderId: order.id } });
      if (milestoneCount > 0) {
        throw new BadRequestException({
          code: 'MILESTONE_ORDER_LEGACY_FLOW_FORBIDDEN',
          message: 'Order bermilestone diselesaikan lewat alur tahap (accept per milestone), bukan completeOrder.',
        });
      }

      const acceptedProof = await tx.deliveryProof.findFirst({
        where: deliveryProofId
          ? { id: deliveryProofId, orderId: order.id, status: { in: ['SUBMITTED', 'ACCEPTED'] } }
          : { orderId: order.id, status: 'ACCEPTED' },
        select: { id: true, status: true },
      });
      if (!acceptedProof) {
        throw new BadRequestException({ code: ErrorCodes.INVALID_ORDER_STATUS, message: 'At least one delivery proof must be accepted before completing the order' });
      }

      const orderUpdated = await tx.order.updateMany({
        where: { id: order.id, status: OrderStatus.IN_DELIVERY, deletedAt: null }, // AUDIT-16
        data: { status: OrderStatus.COMPLETED, completedAt: new Date() },
      });
      if (orderUpdated.count === 0) {
        throw new ConflictException({ code: ErrorCodes.INVALID_ORDER_STATUS, message: 'Order status changed concurrently, please retry' });
      }

      await tx.orderStatusHistory.create({
        data: {
          orderId: order.id,
          fromStatus: OrderStatus.IN_DELIVERY,
          toStatus: OrderStatus.COMPLETED,
          changedBy: buyerId,
          changedByType: ActorType.BUYER,
        },
      });

      await tx.orderExtensionRequest.updateMany({
        where: { orderId: order.id, status: 'PENDING' },
        data: {
          status: 'REJECTED',
          respondedAt: new Date(),
          rejectionNote: 'Order completed before the extension request was resolved',
        },
      });

      if (deliveryProofId && acceptedProof.status === 'SUBMITTED') {
        const proofUpdated = await tx.deliveryProof.updateMany({
          where: { id: acceptedProof.id, status: 'SUBMITTED' },
          data: { status: 'ACCEPTED', reviewedAt: new Date() },
        });
        if (proofUpdated.count === 0) {
          throw new ConflictException({ code: ErrorCodes.DELIVERY_PROOF_NOT_FOUND, message: 'Delivery proof was reviewed concurrently; please retry' });
        }
      }

      // E1 (2026-09-30): pelepasan escrow bercabang mode.
      // Wallet AKTIF -> blok ledger wallet di bawah (ORDER_LOCK/ORDER_RELEASE/
      // FEE_DEDUCT). Wallet MATI (DANA-direct) -> lewati seluruh blok wallet
      // (tidak ada ORDER_LOCK di mode ini; dulu selalu lempar ESCROW_LOCK_MISSING).
      // Sebagai gantinya buat baris disbursement PENDING yang durable;
      // settlement DANA dieksekusi post-commit (pola sama M5 milestone).
      if (this.walletMode.isWalletEnabled()) {
        const buyerWalletPreLock = await tx.wallet.findUnique({ where: { userId: order.buyerId }, select: { id: true } });
        const sellerWalletPreLock = await tx.wallet.findUnique({ where: { userId: order.sellerId }, select: { id: true } });

        if (!buyerWalletPreLock || !sellerWalletPreLock) {
          throw new BadRequestException({ code: ErrorCodes.NOT_FOUND, message: 'Wallet not found during escrow release' });
        }

        const [firstId, secondId] = [buyerWalletPreLock.id, sellerWalletPreLock.id].sort();
        await tx.$queryRaw`SELECT id FROM wallets WHERE id IN (${firstId}, ${secondId}) ORDER BY id FOR UPDATE`;

        const buyerWallet = await tx.wallet.findUnique({ where: { id: buyerWalletPreLock.id } });
        const sellerWallet = await tx.wallet.findUnique({ where: { id: sellerWalletPreLock.id } });

        if (!buyerWallet || !sellerWallet) {
          throw new BadRequestException({ code: ErrorCodes.NOT_FOUND, message: 'Wallet not found during escrow release' });
        }

        const escrowLock = await tx.walletTransaction.findFirst({
          where: { orderId: order.id, type: WalletTransactionType.ORDER_LOCK, status: WalletTransactionStatus.SUCCESS },
          select: { amount: true },
        });
        if (!escrowLock || escrowLock.amount !== order.buyerPayAmount) {
          throw new ConflictException({ code: ErrorCodes.ESCROW_LOCK_MISSING, message: 'Escrow lock ledger is missing or does not match this order' });
        }

        // Batch 1-money (EO-005): kredit cashback kini via helper bersama idempoten
        // (creditCashbackIfEligible) yang dipanggil setelah update escrow utama di bawah.
        // Update wallet di sini TIDAK lagi melipat cashback — net effect identik.

        if (buyerWallet.isLocked) {
          throw new BadRequestException({ code: 'WALLET_LOCKED', message: 'Buyer wallet is locked. Cannot proceed with escrow release.' });
        }
        if (sellerWallet.isLocked) {
          throw new BadRequestException({ code: 'WALLET_LOCKED', message: 'Seller wallet is locked. Cannot proceed with escrow release.' });
        }

        const buyerBalanceBefore = buyerWallet.escrowBalance;
        const buyerBalanceAfter = buyerWallet.escrowBalance - order.buyerPayAmount;
        const sellerBalanceBefore = sellerWallet.availableBalance;
        // M6: rebate overfunding patungan — kelebihan dana grup dibagi rata ke
        // tiap peserta sebagai pengurang nyata: pembeli terima kembali `rebate`,
        // host terima sellerReceiveAmount − rebate. Dihitung di dalam tx (setelah
        // row lock dompet) dari himpunan peserta PAID/RELEASED yang final.
        const patunganRebate = await computePatunganRebateTx(tx, order.id);
        let rebate = patunganRebate?.rebateSen ?? 0n;
        // Fail-safe: rebate tidak boleh melebihi penerimaan seller — jangan
        // pernah membuat kredit negatif ke host.
        if (rebate > order.sellerReceiveAmount) rebate = order.sellerReceiveAmount;
        const sellerBalanceAfter = sellerWallet.availableBalance + order.sellerReceiveAmount - rebate;
        // Batch 1-money (EO-005): cashback dikredit terpisah via creditCashbackIfEligible
        // setelah update escrow utama — tidak lagi dilipat di sini.
        const buyerWalletData: Prisma.WalletUpdateManyMutationInput = {
          escrowBalance: { decrement: order.buyerPayAmount },
          totalBalance: { decrement: order.buyerPayAmount - rebate },
          version: { increment: 1 },
        };
        if (rebate > 0n) {
          buyerWalletData.availableBalance = { increment: rebate };
        }

        const buyerUpdated = await tx.wallet.updateMany({
          where: { id: buyerWallet.id, version: buyerWallet.version, escrowBalance: { gte: order.buyerPayAmount } },
          data: buyerWalletData,
        });
        if (buyerUpdated.count === 0) {
          throw new ConflictException({ code: ErrorCodes.OPTIMISTIC_LOCK_CONFLICT, message: 'Concurrent escrow release detected, please retry' });
        }

        const sellerUpdated = await tx.wallet.updateMany({
          where: { id: sellerWallet.id, version: sellerWallet.version },
          data: {
            availableBalance: { increment: order.sellerReceiveAmount - rebate },
            totalBalance: { increment: order.sellerReceiveAmount - rebate },
            version: { increment: 1 },
          },
        });
        if (sellerUpdated.count === 0) {
          throw new ConflictException({ code: ErrorCodes.OPTIMISTIC_LOCK_CONFLICT, message: 'Concurrent wallet update on seller detected, please retry' });
        }

        const releaseTxId = generateWalletTxId(releaseTxSerial);
        await tx.walletTransaction.create({
          data: {
            txId: releaseTxId,
            walletId: buyerWallet.id,
            type: WalletTransactionType.ORDER_RELEASE,
            status: WalletTransactionStatus.SUCCESS,
            amount: order.buyerPayAmount,
            balanceBefore: buyerBalanceBefore,
            balanceAfter: buyerBalanceAfter,
            orderId: order.id,
            description: `Escrow released for completed order ${order.orderId}`,
          },
        });

        const receiveTxId = generateWalletTxId(receiveTxSerial);
        await tx.walletTransaction.create({
          data: {
            txId: receiveTxId,
            walletId: sellerWallet.id,
            type: WalletTransactionType.ORDER_RELEASE,
            status: WalletTransactionStatus.SUCCESS,
            amount: order.sellerReceiveAmount - rebate,
            balanceBefore: sellerBalanceBefore,
            balanceAfter: sellerBalanceAfter,
            orderId: order.id,
            description: `Payment received for completed order ${order.orderId}`,
          },
        });

        // M6: baris ledger rebate overfunding patungan (idempoten via guard di
        // computePatunganRebateTx) — bukti bahwa kelebihan dibagi rata dan
        // benar-benar mengurangi beban peserta.
        if (rebate > 0n && patunganRebate) {
          const rebateTxId = generateWalletTxId(await nextRebateTxSerial());
          await createPatunganRebateLedgerTx(tx, {
            txId: rebateTxId,
            buyerWalletId: buyerWallet.id,
            orderDbId: order.id,
            orderPublicId: order.orderId,
            groupId: patunganRebate.groupId,
            rebateSen: rebate,
            buyerAvailableBefore: buyerWallet.availableBalance,
          });
        }

        // Batch 1-money (EO-005): kredit cashback via helper bersama idempoten.
        // Dijalankan setelah update escrow utama agar balanceBefore ledger konsisten.
        // M4 no-wallet: wallet mati -> rencanakan payout DANA (dieksekusi post-commit).
        if (this.walletMode.isWalletEnabled()) {
          await creditCashbackIfEligible(tx, nextCashbackTxSerial, {
            orderDbId: order.id,
            orderPublicId: order.orderId,
            source: 'completeOrder',
          });
        } else {
          const params = { orderDbId: order.id, orderPublicId: order.orderId, source: 'completeOrder' };
          const intent = await planDanaCashback(tx, params);
          danaCashback = intent ? { params, intent } : null;
        }

        // feeAmount = buyerPayAmount − sellerReceiveAmount.
        // The fee amount is removed from the buyer's escrow (already done above via
        // buyerPayAmount decrement) but not credited to the seller. This FEE_DEDUCT
        // record provides the audit trail that accounts for the discrepancy, so
        // the platform revenue is auditable without requiring a separate platform wallet.
        if (order.feeAmount > BigInt(0)) {
          const feeTxId = generateWalletTxId(await nextFeeTxSerial());
          await tx.walletTransaction.create({
            data: {
              txId: feeTxId,
              walletId: buyerWallet.id,
              type: WalletTransactionType.FEE_DEDUCT,
              status: WalletTransactionStatus.SUCCESS,
              amount: order.feeAmount,
              balanceBefore: buyerWallet.totalBalance,
              balanceAfter: buyerWallet.totalBalance - order.feeAmount,
              orderId: order.id,
              description: `Platform fee for order ${order.orderId}`,
            },
          });
        }
      } else {
        if (!this.escrowDisbursementService) {
          throw new BadRequestException({
            code: 'DISBURSEMENT_UNAVAILABLE',
            message: 'Layanan disbursement DANA tidak tersedia — release escrow ditahan (fail-closed).',
          });
        }
        // Fail-closed: tanpa sellerReceiveAmount yang valid, jangan cairkan apa pun.
        if (order.sellerReceiveAmount == null || order.sellerReceiveAmount <= BigInt(0)) {
          throw new BadRequestException({
            code: 'ORDER_NOT_RELEASE_ELIGIBLE',
            message: 'Nominal pencairan escrow tidak valid — release ditahan (fail-closed).',
          });
        }
        const disbKey = `ORDER:${order.id}`;
        const existingDisb = await tx.escrowDisbursement.findUnique({
          where: { idempotencyKey: disbKey },
          select: { id: true },
        });
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
        danaEscrowRelease = { orderDbId: order.id, orderPublicId: order.orderId };
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
            status: { in: [SubscriptionStatus.ACTIVE, SubscriptionStatus.CANCELLED] },
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
      referralRewardCredited = referralRewardCredited || buyerRewardCredited || sellerRewardCredited;

      await this.membershipRankService.checkAndUpdateMembershipRank(tx, order.buyerId);
      await this.membershipRankService.checkAndUpdateMembershipRank(tx, order.sellerId);
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });

        lastError = null;
        break;
      } catch (err: unknown) {
        lastError = err;
        if (!this.isRetryableDbError(err) || attempt === MAX_RETRIES) {
          this.logger.error(`COMPLETE_ORDER_TX_FAILED orderId=${orderId} attempt=${attempt}/${MAX_RETRIES}`, err instanceof Error ? err.stack : String(err));
          break;
        }
        this.logger.warn(`COMPLETE_ORDER_TX_RETRY orderId=${orderId} attempt=${attempt}/${MAX_RETRIES}`);
        const jitter = randomInt(0, 50);
        await new Promise(resolve => setTimeout(resolve, 100 * Math.pow(2, attempt - 1) + jitter));
      }
    }
    if (lastError) throw lastError;

    // SP-047: reward referral mengubah totalRewardEarned → leaderboard cache
    // (900 dtk) harus diinvalidasi setelah commit.
    if (referralRewardCredited) {
      await this.referralService.invalidateLeaderboardCache();
    }

    // M4 no-wallet: eksekusi payout cashback DANA post-commit (idempoten,
    // key CASHBACK:<orderDbId>). Scheduler retryDue() menangani PENDING/FAILED.
    if (danaCashback && this.escrowDisbursementService) {
      const { params, intent } = danaCashback;
      const executor = this.escrowDisbursementService;
      this.runPostCommitBestEffort(
        () => { void executeDanaCashback(executor, params, intent); },
        'cashback-dana',
      );
    }

    // E1 (2026-09-30): eksekusi release escrow DANA post-commit untuk order
    // single-stage mode no-wallet (idempoten, key ORDER:<orderDbId>).
    // Baris PENDING sudah durable di dalam tx -> bila post-commit ini gagal
    // (atau proses mati), scheduler retryDue() mengambil alih (pola M5).
    if (danaEscrowRelease && this.escrowDisbursementService) {
      const { orderDbId, orderPublicId } = danaEscrowRelease;
      const executor = this.escrowDisbursementService;
      this.runPostCommitBestEffort(
        () => {
          void executor
            .releaseForOrder(orderDbId)
            .then((res) => {
              if (res.outcome === 'HELD_NO_BANK') {
                this.logger.warn(
                  `escrow-release-dana ${orderPublicId}: HELD_NO_BANK — menunggu rekening bank seller`,
                );
              }
            });
        },
        'escrow-release-dana',
      );
    }

    // R2-B (audit): completeOrder consumes the Plus fee-savings quota (feeSavingsUsed)
    // inside the tx above. orders.service caches `subscription_status:<userId>` (which
    // carries the remaining quota) for 300 s, so without this delete the buyer kept
    // seeing — and being charged under — a stale quota for up to five minutes.
    await this.redis.del(`subscription_status:${buyerId}`).catch((err: unknown) =>
      this.logger.warn(`Failed to invalidate subscription status cache for ${buyerId}: ${err instanceof Error ? err.message : String(err)}`),
    );
  }

  private isRetryableDbError(err: unknown): boolean {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2034') return true;
    if (err instanceof Prisma.PrismaClientUnknownRequestError) {
      const msg = err.message.toLowerCase();
      if (msg.includes('40001') || msg.includes('serialization') || msg.includes('40p01') || msg.includes('deadlock')) return true;
    }
    return false;
  }

  async cancelOrder(orderId: string, userId: string, reason: string, note?: string): Promise<void> {
    const normalizedText = reason.trim().toUpperCase();
    const normalizedReason = Object.values(OrderCancelReason).includes(normalizedText as OrderCancelReason)
      ? normalizedText as OrderCancelReason
      : OrderCancelReason.USER_MUTUAL_CANCEL;
    await this.withSerializableRetry(() => this.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      const order = await tx.order.findFirst({ where: { orderId, deletedAt: null } }); // AUDIT-16

      if (!order) {
        throw new BadRequestException({ code: ErrorCodes.ORDER_NOT_FOUND, message: 'Order not found' });
      }
      if (order.buyerId !== userId && order.sellerId !== userId) {
        throw new BadRequestException({ code: ErrorCodes.NOT_ORDER_PARTICIPANT, message: 'Not authorized to cancel this order' });
      }

      const isBuyer = order.buyerId === userId;
      const isSeller = order.sellerId === userId;

      let cancellableStatuses: OrderStatus[];
      if (isBuyer) {
        cancellableStatuses = [OrderStatus.WAITING_CONFIRMATION, OrderStatus.WAITING_PAYMENT];
      } else if (isSeller) {
        cancellableStatuses = [OrderStatus.WAITING_CONFIRMATION, OrderStatus.WAITING_PAYMENT];
      } else {
        cancellableStatuses = [];
      }

      if (!cancellableStatuses.includes(order.status)) {
        throw new BadRequestException({
          code: ErrorCodes.INVALID_ORDER_STATUS,
          message: 'Order cannot be cancelled at this stage',
        });
      }
      this.validateTransition(order.status, OrderStatus.CANCELLED);

      const cancelNote = note
        ? `${normalizedReason}: ${note}`
        : `${normalizedReason} — Cancelled by ${isBuyer ? 'buyer' : 'seller'}`;
      const cancelUpdated = await tx.order.updateMany({
        where: { id: order.id, status: { in: cancellableStatuses }, deletedAt: null }, // AUDIT-16
        data: {
          status: OrderStatus.CANCELLED,
          cancelledAt: new Date(),
          cancelReason: normalizedReason,
          cancelNote,
        },
      });

      if (cancelUpdated.count === 0) {
        throw new ConflictException({
          code: ErrorCodes.OPTIMISTIC_LOCK_CONFLICT,
          message: 'Order status has already changed, please retry',
        });
      }

      await tx.orderStatusHistory.create({
        data: {
          orderId: order.id,
          fromStatus: order.status,
          toStatus: OrderStatus.CANCELLED,
          changedBy: userId,
          changedByType: isBuyer ? ActorType.BUYER : ActorType.SELLER,
          reason,
        },
      });

      await tx.orderExtensionRequest.updateMany({
        where: { orderId: order.id, status: 'PENDING' },
        data: {
          status: 'REJECTED',
          respondedAt: new Date(),
          rejectionNote: 'Order cancelled before the extension request was resolved',
        },
      });

      if (order.voucherId) {
        // SP-034: rollback via helper bersama — kembalikan currentUsage DAN
        // campaign.currentRedemptions.
        await rollbackOrderVoucherUsage(tx, order.id, order.voucherId);
      }

      await tx.user.update({
        where: { id: isBuyer ? order.buyerId : order.sellerId },
        data: { totalOrdersCancelled: { increment: 1 } },
      });
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }), 'CANCEL_ORDER_TX');

    await this.orderQrisPaymentService.cancelPendingPaymentForOrder(orderId);
  }


  async adminCancelOrder(
    orderId: string,
    adminId: string,
    reason: string,
    cancelReason: OrderCancelReason = OrderCancelReason.ADMIN_FORCE_CANCEL,
  ): Promise<void> {
    const preflightOrder = await this.prisma.order.findUnique({
      where: { orderId },
      select: { status: true, buyerPayAmount: true },
    });
    if (!preflightOrder) {
      throw new BadRequestException({ code: ErrorCodes.ORDER_NOT_FOUND, message: 'Order not found' });
    }

    const preflightQrisPayment = await this.prisma.paymentTransaction.findFirst({
      where: {
        order: { orderId },
        purpose: 'ORDER_ESCROW',
        status: 'SUCCESS',
      },
      select: { id: true },
    });
    // M3 (no-wallet): order dibayar via DANA-direct (QRIS/VA/BALANCE). Refund
    // TIDAK lewat wallet — ke metode bayar asal via DANA Refund API.
    const preflightDanaPayment = await this.prisma.paymentTransaction.findFirst({
      where: {
        order: { orderId },
        purpose: 'ORDER_ESCROW',
        provider: 'DANA',
        status: 'SUCCESS',
        danaPayKind: { not: null },
      },
      select: { id: true },
    });
    const danaDirectMode = !this.walletMode.isWalletEnabled() && !!preflightDanaPayment;
    const preflightNeedsRefundSerial =
      (preflightOrder.status === OrderStatus.PROCESSING || preflightOrder.status === OrderStatus.IN_DELIVERY) &&
      preflightOrder.buyerPayAmount > BigInt(0) && !preflightQrisPayment && !danaDirectMode;
    let refundTxSerial = preflightNeedsRefundSerial
      ? await this.getNextWalletTxSerial()
      : null;
    let walletTxId!: string;

    await this.withSerializableRetry(() => this.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      const order = await tx.order.findFirst({ where: { orderId, deletedAt: null } }); // AUDIT-16

      if (!order) {
        throw new BadRequestException({ code: ErrorCodes.ORDER_NOT_FOUND, message: 'Order not found' });
      }

      const adminCancellableStatuses: OrderStatus[] = [
        OrderStatus.WAITING_CONFIRMATION,
        OrderStatus.WAITING_PAYMENT,
        OrderStatus.PROCESSING,
        OrderStatus.IN_DELIVERY,
      ];

      if (!adminCancellableStatuses.includes(order.status)) {
        throw new BadRequestException({
          code: ErrorCodes.INVALID_ORDER_STATUS,
          message: `Order cannot be cancelled at status ${order.status}`,
        });
      }

      const adminCancelUpdated = await tx.order.updateMany({
        // SEC-105: shippedAt:null DI DALAM tx — seller yang kirim tepat di
        // jendela race (read ulang → ship → commit) tidak boleh di-cancel +
        // refund penuh (buyer dapat barang + uang). Guard pre-tx saja tidak cukup.
        where: { id: order.id, status: { in: adminCancellableStatuses }, shippedAt: null, deletedAt: null }, // AUDIT-16
        data: {
          status: OrderStatus.CANCELLED,
          cancelledAt: new Date(),
          cancelReason,
          cancelNote: reason,
        },
      });

      if (adminCancelUpdated.count === 0) {
        // Bedakan "sudah dikirim" dari konflik status biasa — caller (mis.
        // sweep expire-unshipped) butuh tahu ini SKIPPED_SHIPPED, bukan error generik.
        const fresh = await tx.order.findUnique({
          where: { id: order.id },
          select: { status: true, shippedAt: true },
        });
        if (fresh?.shippedAt) {
          throw new ConflictException({
            code: 'SKIPPED_SHIPPED',
            message: 'Order sudah dikirim (shippedAt terisi) — pembatalan dibatalkan (fail-closed).',
          });
        }
        throw new ConflictException({
          code: ErrorCodes.OPTIMISTIC_LOCK_CONFLICT,
          message: 'Order status has already changed, please retry',
        });
      }

      if (order.voucherId) {
        // SP-034: rollback via helper bersama — kembalikan currentUsage DAN
        // campaign.currentRedemptions.
        await rollbackOrderVoucherUsage(tx, order.id, order.voucherId);
      }

      await tx.orderStatusHistory.create({
        data: {
          orderId: order.id,
          fromStatus: order.status,
          toStatus: OrderStatus.CANCELLED,
          changedBy: adminId,
          changedByType: ActorType.ADMIN,
          reason,
        },
      });

      const escrowStatuses: OrderStatus[] = [OrderStatus.PROCESSING, OrderStatus.IN_DELIVERY];
      // M3 (no-wallet): DANA-direct tidak punya escrow wallet — refund ke metode
      // bayar asal ditangani post-commit via DanaDirectRefundService.
      if (escrowStatuses.includes(order.status) && order.buyerPayAmount > BigInt(0) && !danaDirectMode) {
        const escrowLock = await tx.walletTransaction.findFirst({
          where: { orderId: order.id, type: WalletTransactionType.ORDER_LOCK, status: WalletTransactionStatus.SUCCESS },
          select: { amount: true },
        });
        if (!escrowLock || escrowLock.amount !== order.buyerPayAmount) {
          throw new ConflictException({ code: ErrorCodes.ESCROW_LOCK_MISSING, message: 'Escrow lock ledger is missing or does not match this order' });
        }
        const qrisOrderPayment = await tx.paymentTransaction.findFirst({
          where: { orderId: order.id, purpose: 'ORDER_ESCROW', status: 'SUCCESS' },
          select: { id: true },
        });
        if (!qrisOrderPayment) {
        // The preflight snapshot can be stale. Allocate once lazily if this fresh transaction
        // discovers that the order entered escrow after the preflight read.
        if (refundTxSerial === null) refundTxSerial = await this.getNextWalletTxSerial();

        const walletLookup = await tx.wallet.findFirst({
          where: { userId: order.buyerId },
          select: { id: true },
        });
        if (!walletLookup) {
          throw new BadRequestException({ code: ErrorCodes.NOT_FOUND, message: 'Buyer wallet not found for escrow refund' });
        }

        /*
         * C-05: take the row lock before reading the balances, like every other escrow-moving
         * path (`completeOrder` :416, `payOrder`, `MutualResolutionService` :295, the
         * auto-complete cron). This one relied on the `version` guard alone. The guard does
         * prevent a double refund — a concurrent writer makes the update match 0 rows — but
         * without the lock the two transactions race to commit and the loser aborts with a
         * bare 40001 serialization failure, which this method has no retry wrapper to absorb
         * and so surfaces to the admin as an opaque 500 on an operation that may or may not
         * have refunded. Locking first makes the second writer wait and then observe the
         * committed state through its own guard.
         */
        await tx.$queryRaw`SELECT id FROM wallets WHERE id = ${walletLookup.id} FOR UPDATE`;

        const buyerWallet = await tx.wallet.findUnique({ where: { id: walletLookup.id } });
        if (!buyerWallet) {
          throw new BadRequestException({ code: ErrorCodes.NOT_FOUND, message: 'Buyer wallet not found for escrow refund' });
        }

        const escrowLock = await tx.walletTransaction.findFirst({
          where: { orderId: order.id, type: WalletTransactionType.ORDER_LOCK, status: WalletTransactionStatus.SUCCESS },
          select: { amount: true },
        });
        if (!escrowLock || escrowLock.amount !== order.buyerPayAmount) {
          throw new ConflictException({ code: ErrorCodes.ESCROW_LOCK_MISSING, message: 'Escrow lock ledger is missing or does not match this order' });
        }

        const refundAmount = order.buyerPayAmount;

        const updated = await tx.wallet.updateMany({
          where: {
            id: buyerWallet.id,
            version: buyerWallet.version,
            escrowBalance: { gte: order.buyerPayAmount },
          },
          data: {
            escrowBalance: { decrement: refundAmount },
            availableBalance: { increment: refundAmount },
            version: { increment: 1 },
          },
        });

        if (updated.count === 0) {
          throw new ConflictException({
            code: ErrorCodes.OPTIMISTIC_LOCK_CONFLICT,
            message: 'Concurrent wallet update detected during escrow refund, please retry',
          });
        }

        walletTxId = generateWalletTxId(refundTxSerial);
        await tx.walletTransaction.create({
          data: {
            txId: walletTxId,
            walletId: buyerWallet.id,
            type: WalletTransactionType.ORDER_REFUND,
            status: WalletTransactionStatus.SUCCESS,
            amount: refundAmount,
            balanceBefore: buyerWallet.availableBalance,
            balanceAfter: buyerWallet.availableBalance + refundAmount,
            orderId: order.id,
            description: `Full escrow refund for admin-cancelled order ${order.orderId} (including platform fee)`,
          },
        });
        }
      }

      // SYS-B-205 (pola SEC-104): baris durable danaRefundAttempt PENDING —
      // dibuat DI DALAM tx yang sama dengan cancel. Eksekusi post-commit via
      // klaim atomik di refundAmount() (PENDING/FAILED → EXECUTING, hanya satu
      // eksekutor menang); crash di antaranya → sweep dana-refund-retry
      // menjemput baris PENDING yang basi.
      //
      // Kunci idempotency deterministik & unik per (order, aksi):
      // `ORDER:<orderDbId>:ADMIN_CANCEL`. Nominal snapshot sisa refund saat
      // rencana; refundAmount() menghitung ulang dari payment segar (fail-closed
      // bila payment tidak lagi eligible).
      //
      // Order bertahap (milestone) TIDAK dibuatkan baris di sini — refundnya
      // di-routing per tahap via adminCancelMilestonesNoWallet post-commit.
      if (danaDirectMode) {
        const milestoneCount = await tx.orderMilestone.count({ where: { orderId: order.id } });
        if (milestoneCount === 0) {
          const danaPayment = await tx.paymentTransaction.findFirst({
            where: { orderId: order.id, provider: 'DANA', status: 'SUCCESS' },
            orderBy: { settledAt: 'desc' },
            select: { id: true, grossAmount: true, refundedAmount: true },
          });
          if (danaPayment) {
            const remaining = danaPayment.grossAmount - (danaPayment.refundedAmount ?? BigInt(0));
            if (remaining > BigInt(0)) {
              const attemptKey = `ORDER:${order.id}:ADMIN_CANCEL`;
              const existingAttempt = await tx.danaRefundAttempt.findUnique({
                where: { idempotencyKey: attemptKey },
                select: { id: true },
              });
              if (!existingAttempt) {
                await tx.danaRefundAttempt.create({
                  data: {
                    idempotencyKey: attemptKey,
                    paymentTransactionId: danaPayment.id,
                    amountSen: remaining,
                    partnerRefundNo: deriveDanaRefundNo(attemptKey),
                    reason: `Admin cancelled order: ${reason}`.slice(0, 500),
                    status: 'PENDING',
                  },
                });
              }
            }
          }
        }
      }
    }), 'ADMIN_CANCEL_ORDER_TX');

    if (danaDirectMode && this.danaDirectRefundService) {
      // SYS-B-205: klaim attempt PENDING yang dibuat di dalam tx cancel di
      // atas (idempoten per ORDER:<orderDbId>:ADMIN_CANCEL). refundAmount()
      // mengklaim atomik PENDING/FAILED → EXECUTING lalu mengeksekusi; bila
      // baris belum ada (mis. payment muncul setelah tx) ia membuatnya
      // seperti jalur biasa. Attempt FAILED / PENDING-basi dicoba ulang cron
      // dana-refund-retry tiap jam.
      const refundService = this.danaDirectRefundService;
      this.runPostCommitBestEffort(async () => {
        const cancelled = await this.prisma.order.findFirst({ where: { orderId }, select: { id: true } });
        if (!cancelled) return;
        // M5: order bertahap → refund parsial DANA per tahap yang belum cair.
        // Tahap yang sudah RELEASED tidak disentuh (refund penuh = over-refund).
        if (this.milestonesService) {
          const routed = await this.milestonesService.adminCancelMilestonesNoWallet(
            cancelled.id,
            adminId,
            reason,
          );
          if (routed.routed) return;
        }
        const danaPayment = await this.prisma.paymentTransaction.findFirst({
          where: { orderId: cancelled.id, provider: 'DANA', status: 'SUCCESS' },
          orderBy: { settledAt: 'desc' },
          select: { id: true },
        });
        if (!danaPayment) return;
        await refundService.refundAmount({
          paymentDbId: danaPayment.id,
          amountSen: null,
          reason: `Admin cancelled order: ${reason}`,
          idempotencyKey: `ORDER:${cancelled.id}:ADMIN_CANCEL`,
        });
      }, 'ADMIN_CANCEL_ORDER_DANA_REFUND');
    } else {
      // Batch 1-money (WF-022): refund provider tetap best-effort di sini agar cancel admin
      // tidak gagal karena provider. Retry ditangani cron refund-reconciliation
      // (refund-reconciliation.service.ts): klaim yang gagal dilepas oleh requestRefund
      // dan dicoba ulang tiap jam; klaim basi yang webhook-nya tak kunjung tiba
      // direkonsiliasi ke status provider.
      await this.orderQrisPaymentService.requestRefundForOrder(orderId, `Admin cancelled order: ${reason}`).catch((error: unknown) => {
        this.logger.error(`ADMIN_CANCEL_QRIS_REFUND_REQUEST_FAILED orderId=${orderId}: ${error instanceof Error ? error.message : String(error)}`);
      });
    }

    this.runRealtimeBestEffort(() => this.realtime.emitToOrder(orderId, 'order.status_changed', { orderId, status: 'CANCELLED' }), 'ADMIN_CANCEL_ORDER_STATUS');

    this.runPostCommitBestEffort(async () => {
      const adminOrder = await this.prisma.order.findUnique({ where: { orderId }, select: { buyerId: true, sellerId: true, title: true, buyerPayAmount: true } });
      if (!adminOrder) return;
      for (const recipientId of [adminOrder.buyerId, adminOrder.sellerId]) {
        // M3 (no-wallet): jangan klaim "kembali ke wallet" — refund ke metode
        // pembayaran asal (DANA Refund API).
        const refundNote = danaDirectMode && recipientId === adminOrder.buyerId
          ? ' Dana akan dikembalikan ke metode pembayaran asal Anda.'
          : '';
        // SYS-C-105: copy mengikuti bahasa preferensi penerima.
        const adminCancelCopy = renderNotificationCopy(
          NotificationType.ORDER_CANCELLED,
          await resolveNotificationLanguage(this.prisma, recipientId),
          { orderTitle: adminOrder.title, reason: `${reason ? ` Reason: ${reason}` : ''}${refundNote}` },
        );
        await this.notificationQueue.enqueue({ userId: recipientId, type: NotificationType.ORDER_CANCELLED, title: adminCancelCopy.title, body: adminCancelCopy.body, pushData: { type: 'ORDER_CANCELLED', orderId } });
      }
      if (danaDirectMode) {
        // Notifikasi WALLET_REFUND_RECEIVED tidak berlaku — refund ke metode
        // bayar asal. Webhook DANA/refund-attempt mencatat status final.
      } else {
      // Buyer wajib tahu dananya kembali ke wallet — tanpa ini user panik
      // mengira uang hangus.
      // SYS-C-105: copy mengikuti bahasa preferensi buyer.
      const refundCopy = renderNotificationCopy(
        NotificationType.WALLET_REFUND_RECEIVED,
        await resolveNotificationLanguage(this.prisma, adminOrder.buyerId),
        { amount: formatSen(adminOrder.buyerPayAmount), orderTitle: adminOrder.title },
      );
      await this.notificationQueue.enqueue({
        userId: adminOrder.buyerId,
        type: NotificationType.WALLET_REFUND_RECEIVED,
        title: refundCopy.title,
        body: refundCopy.body,
        pushData: { type: 'WALLET_REFUND_RECEIVED', orderId },
      });
      }
    }, 'ADMIN_CANCEL_ORDER_NOTIFICATION');
  }

  private async getNextWalletTxSerial(): Promise<number> {
    return this.walletTxSerialService.getNext();
  }

}
