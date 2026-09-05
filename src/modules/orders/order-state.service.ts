import { Injectable, BadRequestException, ConflictException, Logger } from '@nestjs/common';
import { randomInt } from 'crypto';
import { PrismaService } from '../../prisma/prisma.service';
import { RedisService } from '../../redis/redis.service';
import { WalletService } from '../wallet/wallet.service';
import { ReferralService } from '../referral/referral.service';
import { RealtimeService } from '../realtime/realtime.service';
import { MembershipRankService } from './membership-rank.service';
import { OrderStatus, OrderCancelReason, ActorType, WalletTransactionType, WalletTransactionStatus, SubscriptionStatus, NotificationType, Prisma } from '@prisma/client';
import { addDays } from '../../common/utils/date.util';
import { generateWalletTxId } from '../../common/utils/id-generator.util';
import { WalletTxSerialService } from '../../common/services/wallet-tx-serial.service';
import { FeeCalculatorService } from './fee-calculator.service';
import { NotificationQueueService } from '../queue/notification-queue.service';
import { OrderQrisPaymentService } from '../payment/order-qris-payment.service';
import * as ErrorCodes from '../../common/constants/error-codes';
import { PAYMENT_DEADLINE_DAYS, MAX_ESCROW_BALANCE } from '../../common/constants/app.constants';

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
    private orderQrisPaymentService: OrderQrisPaymentService,
    private walletTxSerialService: WalletTxSerialService,
    private referralService: ReferralService,
    private feeCalculator: FeeCalculatorService,
    private realtime: RealtimeService,
    private membershipRankService: MembershipRankService,
    private notificationQueue: NotificationQueueService,
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

    return { orderId, status: newStatus };
  }

  async handlePayOrder(orderId: string, userId: string, pin?: string, ip?: string): Promise<PayOrderResult> {
    if (!pin) {
      throw new BadRequestException({
        code: ErrorCodes.UNAUTHORIZED,
        message: 'Wallet PIN is required for order payment. Please update your app to the latest version.',
      });
    }
    await this.walletService.verifyPin(userId, pin, ip);
    const { walletTxId } = await this.payOrder(orderId, userId);
    this.runRealtimeBestEffort(() => this.realtime.emitToOrder(orderId, 'order.status_changed', { orderId, status: 'PROCESSING' }), 'PAY_ORDER_STATUS');

    this.runPostCommitBestEffort(async () => {
      const order = await this.prisma.order.findUnique({ where: { orderId }, select: { sellerId: true, title: true } });
      if (!order) return;
      await this.notificationQueue.enqueue({ userId: order.sellerId, type: NotificationType.ORDER_PAYMENT_RECEIVED, title: 'Payment Received', body: `Payment for order "${order.title}" has been received. Please process the order.`, pushData: { type: 'ORDER_PAYMENT_RECEIVED', orderId } });
    }, 'PAY_ORDER_NOTIFICATION');

    return { orderId, status: 'PROCESSING', walletTxId };
  }

  async handleCompleteOrder(orderId: string, userId: string): Promise<CompleteOrderResult> {
    await this.completeOrder(orderId, userId);
    this.runRealtimeBestEffort(() => this.realtime.emitToOrder(orderId, 'order.status_changed', { orderId, status: 'COMPLETED' }), 'COMPLETE_ORDER_STATUS');

    this.runPostCommitBestEffort(async () => {
      const order = await this.prisma.order.findUnique({ where: { orderId }, select: { buyerId: true, sellerId: true, title: true } });
      if (!order) return;
      await this.notificationQueue.enqueue({ userId: order.sellerId, type: NotificationType.ORDER_COMPLETED, title: 'Order Completed', body: `Order "${order.title}" has been completed! Funds have been credited to your wallet.`, pushData: { type: 'ORDER_COMPLETED', orderId } });
      await this.notificationQueue.enqueue({ userId: order.buyerId, type: NotificationType.WALLET_FUNDS_RELEASED, title: 'Escrow Released', body: `Escrow funds for order "${order.title}" have been released to the seller.`, pushData: { type: 'WALLET_FUNDS_RELEASED', orderId } });
    }, 'COMPLETE_ORDER_NOTIFICATION');

    return { orderId, status: 'COMPLETED' };
  }

  async handleCancelOrder(orderId: string, userId: string, reason: string, note?: string): Promise<CancelOrderResult> {
    const normalizedReason = reason.trim().toUpperCase();
    if (!VALID_CANCEL_REASONS.includes(normalizedReason as typeof VALID_CANCEL_REASONS[number])) {
      throw new BadRequestException({
        code: ErrorCodes.INVALID_CANCEL_REASON,
        message: `Invalid cancel reason. Allowed values: ${VALID_CANCEL_REASONS.join(', ')}`,
      });
    }
    await this.cancelOrder(orderId, userId, normalizedReason, note);
    this.runRealtimeBestEffort(() => this.realtime.emitToOrder(orderId, 'order.status_changed', { orderId, status: 'CANCELLED' }), 'CANCEL_ORDER_STATUS');

    this.runPostCommitBestEffort(async () => {
      const order = await this.prisma.order.findUnique({ where: { orderId }, select: { buyerId: true, sellerId: true, title: true } });
      if (!order) return;
      const recipientId = order.buyerId === userId ? order.sellerId : order.buyerId;
      await this.notificationQueue.enqueue({ userId: recipientId, type: NotificationType.ORDER_CANCELLED, title: 'Order Cancelled', body: `Order "${order.title}" has been cancelled. Reason: ${normalizedReason}${note ? `. ${note}` : ''}`, pushData: { type: 'ORDER_CANCELLED', orderId } });
    }, 'CANCEL_ORDER_NOTIFICATION');

    return { orderId, status: 'CANCELLED' };
  }

  async confirmOrder(orderId: string, userId: string): Promise<void> {
    await this.withSerializableRetry(() => this.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      const order = await tx.order.findUnique({ where: { orderId } });

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
        where: { id: order.id, status: OrderStatus.WAITING_CONFIRMATION, OR: [{ confirmationDeadlineAt: null }, { confirmationDeadlineAt: { gt: new Date() } }] },
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
      const order = await tx.order.findUnique({ where: { orderId } });

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
        where: { id: order.id, status: OrderStatus.WAITING_CONFIRMATION },
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
        const deletedVoucherUsage = await tx.voucherUsage.deleteMany({
          where: { orderId: order.id, voucherId: order.voucherId },
        });
        if (deletedVoucherUsage.count > 0) {
          await tx.voucher.updateMany({
            where: { id: order.voucherId, currentUsage: { gt: 0 } },
            data: { currentUsage: { decrement: 1 } },
          });
        }
      }

    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }), 'REJECT_ORDER_TX');
  }

  async payOrder(orderId: string, buyerId: string): Promise<{ walletTxId: string }> {
    const order = await this.prisma.order.findUnique({
      where: { orderId },
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
      const freshOrder = await tx.order.findUnique({ where: { id: order.id }, select: { status: true, paymentDeadlineAt: true, buyerId: true, buyerPayAmount: true } });
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
      const orderUpdated = await tx.order.updateMany({
        where: { id: order.id, status: OrderStatus.WAITING_PAYMENT },
        data: {
          status: OrderStatus.PROCESSING,
          paidAt: new Date(),
          processedAt: new Date(),
          deliveryDeadlineAt: addDays(new Date(), order.deliveryDeadlineDays ?? 3),
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
     */
    const releaseTxSerial = await this.getNextWalletTxSerial();
    const receiveTxSerial = await this.getNextWalletTxSerial();
    let feeSerial: number | null = null;
    const nextFeeTxSerial = async (): Promise<number> => {
      if (feeSerial === null) feeSerial = await this.getNextWalletTxSerial();
      return feeSerial;
    };

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
    await this.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      const order = await tx.order.findUnique({ where: { orderId } });

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
        where: { id: order.id, status: OrderStatus.IN_DELIVERY },
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

      if (buyerWallet.isLocked) {
        throw new BadRequestException({ code: 'WALLET_LOCKED', message: 'Buyer wallet is locked. Cannot proceed with escrow release.' });
      }
      if (sellerWallet.isLocked) {
        throw new BadRequestException({ code: 'WALLET_LOCKED', message: 'Seller wallet is locked. Cannot proceed with escrow release.' });
      }

      const buyerBalanceBefore = buyerWallet.escrowBalance;
      const buyerBalanceAfter = buyerWallet.escrowBalance - order.buyerPayAmount;
      const sellerBalanceBefore = sellerWallet.availableBalance;
      const sellerBalanceAfter = sellerWallet.availableBalance + order.sellerReceiveAmount;

      const buyerUpdated = await tx.wallet.updateMany({
        where: { id: buyerWallet.id, version: buyerWallet.version, escrowBalance: { gte: order.buyerPayAmount } },
        data: {
          escrowBalance: { decrement: order.buyerPayAmount },
          totalBalance: { decrement: order.buyerPayAmount },
          version: { increment: 1 },
        },
      });
      if (buyerUpdated.count === 0) {
        throw new ConflictException({ code: ErrorCodes.OPTIMISTIC_LOCK_CONFLICT, message: 'Concurrent escrow release detected, please retry' });
      }

      const sellerUpdated = await tx.wallet.updateMany({
        where: { id: sellerWallet.id, version: sellerWallet.version },
        data: {
          availableBalance: { increment: order.sellerReceiveAmount },
          totalBalance: { increment: order.sellerReceiveAmount },
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
          amount: order.sellerReceiveAmount,
          balanceBefore: sellerBalanceBefore,
          balanceAfter: sellerBalanceAfter,
          orderId: order.id,
          description: `Payment received for completed order ${order.orderId}`,
        },
      });

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

      await this.referralService.createReferralRewardIfEligible(order.buyerId, order.feeAmount, order.id, tx);
      await this.referralService.createReferralRewardIfEligible(order.sellerId, order.feeAmount, order.id, tx);

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
      const order = await tx.order.findUnique({ where: { orderId } });

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
        where: { id: order.id, status: { in: cancellableStatuses } },
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
        const deletedVoucherUsage = await tx.voucherUsage.deleteMany({
          where: { orderId: order.id, voucherId: order.voucherId },
        });
        if (deletedVoucherUsage.count > 0) {
          await tx.voucher.updateMany({
            where: { id: order.voucherId, currentUsage: { gt: 0 } },
            data: { currentUsage: { decrement: 1 } },
          });
        }
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
    const preflightNeedsRefundSerial =
      (preflightOrder.status === OrderStatus.PROCESSING || preflightOrder.status === OrderStatus.IN_DELIVERY) &&
      preflightOrder.buyerPayAmount > BigInt(0) && !preflightQrisPayment;
    let refundTxSerial = preflightNeedsRefundSerial
      ? await this.getNextWalletTxSerial()
      : null;
    let walletTxId!: string;

    await this.withSerializableRetry(() => this.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      const order = await tx.order.findUnique({ where: { orderId } });

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
        where: { id: order.id, status: { in: adminCancellableStatuses } },
        data: {
          status: OrderStatus.CANCELLED,
          cancelledAt: new Date(),
          cancelReason: 'ADMIN_FORCE_CANCEL',
          cancelNote: reason,
        },
      });

      if (adminCancelUpdated.count === 0) {
        throw new ConflictException({
          code: ErrorCodes.OPTIMISTIC_LOCK_CONFLICT,
          message: 'Order status has already changed, please retry',
        });
      }

      if (order.voucherId) {
        const deletedVoucherUsage = await tx.voucherUsage.deleteMany({
          where: { orderId: order.id, voucherId: order.voucherId },
        });
        if (deletedVoucherUsage.count > 0) {
          await tx.voucher.updateMany({
            where: { id: order.voucherId, currentUsage: { gt: 0 } },
            data: { currentUsage: { decrement: 1 } },
          });
        }
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
      if (escrowStatuses.includes(order.status) && order.buyerPayAmount > BigInt(0)) {
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
    }), 'ADMIN_CANCEL_ORDER_TX');

    await this.orderQrisPaymentService.requestRefundForOrder(orderId, `Admin cancelled order: ${reason}`).catch((error: unknown) => {
      this.logger.error(`ADMIN_CANCEL_QRIS_REFUND_REQUEST_FAILED orderId=${orderId}: ${error instanceof Error ? error.message : String(error)}`);
    });

    this.runRealtimeBestEffort(() => this.realtime.emitToOrder(orderId, 'order.status_changed', { orderId, status: 'CANCELLED' }), 'ADMIN_CANCEL_ORDER_STATUS');

    this.runPostCommitBestEffort(async () => {
      const adminOrder = await this.prisma.order.findUnique({ where: { orderId }, select: { buyerId: true, sellerId: true, title: true } });
      if (!adminOrder) return;
      for (const recipientId of [adminOrder.buyerId, adminOrder.sellerId]) {
        await this.notificationQueue.enqueue({ userId: recipientId, type: NotificationType.ORDER_CANCELLED, title: 'Order Cancelled by Admin', body: `Order "${adminOrder.title}" has been cancelled by an administrator.${reason ? ` Reason: ${reason}` : ''}`, pushData: { type: 'ORDER_CANCELLED', orderId } });
      }
    }, 'ADMIN_CANCEL_ORDER_NOTIFICATION');
  }

  private async getNextWalletTxSerial(): Promise<number> {
    return this.walletTxSerialService.getNext();
  }

}
