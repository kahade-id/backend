"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
var OrderStateService_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.OrderStateService = void 0;
const common_1 = require("@nestjs/common");
const crypto_1 = require("crypto");
const prisma_service_1 = require("../../prisma/prisma.service");
const redis_service_1 = require("../../redis/redis.service");
const wallet_service_1 = require("../wallet/wallet.service");
const referral_service_1 = require("../referral/referral.service");
const realtime_service_1 = require("../realtime/realtime.service");
const membership_rank_service_1 = require("./membership-rank.service");
const client_1 = require("@prisma/client");
const date_util_1 = require("../../common/utils/date.util");
const id_generator_util_1 = require("../../common/utils/id-generator.util");
const wallet_tx_serial_service_1 = require("../../common/services/wallet-tx-serial.service");
const fee_calculator_service_1 = require("./fee-calculator.service");
const notification_queue_service_1 = require("../queue/notification-queue.service");
const order_qris_payment_service_1 = require("../payment/order-qris-payment.service");
const ErrorCodes = __importStar(require("../../common/constants/error-codes"));
const app_constants_1 = require("../../common/constants/app.constants");
const VALID_CANCEL_REASONS = [
    'CHANGED_MIND',
    'WRONG_DETAILS',
    'DUPLICATE_ORDER',
    'MUTUAL_AGREEMENT',
    'COUNTERPART_UNRESPONSIVE',
    'OTHER',
];
const ALLOWED_TRANSITIONS = {
    [client_1.OrderStatus.WAITING_CONFIRMATION]: [client_1.OrderStatus.WAITING_PAYMENT, client_1.OrderStatus.CANCELLED],
    [client_1.OrderStatus.WAITING_PAYMENT]: [client_1.OrderStatus.PROCESSING, client_1.OrderStatus.CANCELLED],
    [client_1.OrderStatus.PROCESSING]: [client_1.OrderStatus.IN_DELIVERY, client_1.OrderStatus.CANCELLED],
    [client_1.OrderStatus.IN_DELIVERY]: [client_1.OrderStatus.COMPLETED, client_1.OrderStatus.DISPUTED, client_1.OrderStatus.CANCELLED],
    [client_1.OrderStatus.COMPLETED]: [client_1.OrderStatus.DISPUTED],
    [client_1.OrderStatus.CANCELLED]: [],
    [client_1.OrderStatus.DISPUTED]: [client_1.OrderStatus.COMPLETED, client_1.OrderStatus.CANCELLED],
};
let OrderStateService = OrderStateService_1 = class OrderStateService {
    constructor(prisma, redis, walletService, orderQrisPaymentService, walletTxSerialService, referralService, feeCalculator, realtime, membershipRankService, notificationQueue) {
        this.prisma = prisma;
        this.redis = redis;
        this.walletService = walletService;
        this.orderQrisPaymentService = orderQrisPaymentService;
        this.walletTxSerialService = walletTxSerialService;
        this.referralService = referralService;
        this.feeCalculator = feeCalculator;
        this.realtime = realtime;
        this.membershipRankService = membershipRankService;
        this.notificationQueue = notificationQueue;
        this.logger = new common_1.Logger(OrderStateService_1.name);
    }
    validateTransition(from, to) {
        const allowed = ALLOWED_TRANSITIONS[from];
        if (!allowed || !allowed.includes(to)) {
            throw new common_1.BadRequestException({
                code: ErrorCodes.INVALID_STATE_TRANSITION,
                message: `Transition from ${from} to ${to} is not allowed`,
            });
        }
    }
    runPostCommitBestEffort(task, label) {
        void Promise.resolve().then(task).catch((error) => {
            this.logger.warn(`${label} post-commit side effect failed: ${error instanceof Error ? error.message : String(error)}`);
        });
    }
    runRealtimeBestEffort(task, label) {
        try {
            task();
        }
        catch (error) {
            this.logger.warn(`${label} realtime side effect failed: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    async withSerializableRetry(fn, label) {
        const maxRetries = 3;
        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                return await fn();
            }
            catch (error) {
                if (!this.isRetryableDbError(error) || attempt === maxRetries) {
                    if (attempt === maxRetries && this.isRetryableDbError(error)) {
                        this.logger.error(`${label} failed after ${maxRetries} attempts`, error instanceof Error ? error.stack : String(error));
                    }
                    throw error;
                }
                this.logger.warn(`${label} retrying attempt=${attempt}/${maxRetries}`);
                await new Promise((resolve) => setTimeout(resolve, 100 * Math.pow(2, attempt - 1) + (0, crypto_1.randomInt)(0, 50)));
            }
        }
        throw new Error(`${label}: unreachable`);
    }
    async handleConfirmAction(orderId, userId, action, reason) {
        if (action === 'ACCEPT') {
            await this.confirmOrder(orderId, userId);
        }
        else {
            await this.rejectOrder(orderId, userId, reason);
        }
        const newStatus = action === 'ACCEPT' ? 'WAITING_PAYMENT' : 'CANCELLED';
        this.runRealtimeBestEffort(() => this.realtime.emitToOrder(orderId, 'order.status_changed', { orderId, status: newStatus }), 'CONFIRM_ACTION_STATUS');
        this.runPostCommitBestEffort(async () => {
            const order = await this.prisma.order.findUnique({ where: { orderId }, select: { buyerId: true, sellerId: true, title: true } });
            if (!order)
                return;
            const creatorId = order.buyerId === userId ? order.sellerId : order.buyerId;
            const notifType = action === 'ACCEPT' ? client_1.NotificationType.ORDER_ACCEPTED : client_1.NotificationType.ORDER_REJECTED;
            const title = action === 'ACCEPT' ? 'Order Confirmed' : 'Order Rejected';
            const body = action === 'ACCEPT'
                ? `Order "${order.title}" has been confirmed. Please proceed with payment.`
                : `Order "${order.title}" has been rejected.${reason ? ` Reason: ${reason}` : ''}`;
            await this.notificationQueue.enqueue({ userId: creatorId, type: notifType, title, body, pushData: { type: notifType, orderId } });
        }, 'CONFIRM_ACTION_NOTIFICATION');
        return { orderId, status: newStatus };
    }
    async handlePayOrder(orderId, userId, pin, ip) {
        if (!pin) {
            throw new common_1.BadRequestException({
                code: ErrorCodes.UNAUTHORIZED,
                message: 'Wallet PIN is required for order payment. Please update your app to the latest version.',
            });
        }
        await this.walletService.verifyPin(userId, pin, ip);
        const { walletTxId } = await this.payOrder(orderId, userId);
        this.runRealtimeBestEffort(() => this.realtime.emitToOrder(orderId, 'order.status_changed', { orderId, status: 'PROCESSING' }), 'PAY_ORDER_STATUS');
        this.runPostCommitBestEffort(async () => {
            const order = await this.prisma.order.findUnique({ where: { orderId }, select: { sellerId: true, title: true } });
            if (!order)
                return;
            await this.notificationQueue.enqueue({ userId: order.sellerId, type: client_1.NotificationType.ORDER_PAYMENT_RECEIVED, title: 'Payment Received', body: `Payment for order "${order.title}" has been received. Please process the order.`, pushData: { type: 'ORDER_PAYMENT_RECEIVED', orderId } });
        }, 'PAY_ORDER_NOTIFICATION');
        return { orderId, status: 'PROCESSING', walletTxId };
    }
    async handleCompleteOrder(orderId, userId) {
        await this.completeOrder(orderId, userId);
        this.runRealtimeBestEffort(() => this.realtime.emitToOrder(orderId, 'order.status_changed', { orderId, status: 'COMPLETED' }), 'COMPLETE_ORDER_STATUS');
        this.runPostCommitBestEffort(async () => {
            const order = await this.prisma.order.findUnique({ where: { orderId }, select: { buyerId: true, sellerId: true, title: true } });
            if (!order)
                return;
            await this.notificationQueue.enqueue({ userId: order.sellerId, type: client_1.NotificationType.ORDER_COMPLETED, title: 'Order Completed', body: `Order "${order.title}" has been completed! Funds have been credited to your wallet.`, pushData: { type: 'ORDER_COMPLETED', orderId } });
            await this.notificationQueue.enqueue({ userId: order.buyerId, type: client_1.NotificationType.WALLET_FUNDS_RELEASED, title: 'Escrow Released', body: `Escrow funds for order "${order.title}" have been released to the seller.`, pushData: { type: 'WALLET_FUNDS_RELEASED', orderId } });
        }, 'COMPLETE_ORDER_NOTIFICATION');
        return { orderId, status: 'COMPLETED' };
    }
    async handleCancelOrder(orderId, userId, reason, note) {
        const normalizedReason = reason.trim().toUpperCase();
        if (!VALID_CANCEL_REASONS.includes(normalizedReason)) {
            throw new common_1.BadRequestException({
                code: ErrorCodes.INVALID_CANCEL_REASON,
                message: `Invalid cancel reason. Allowed values: ${VALID_CANCEL_REASONS.join(', ')}`,
            });
        }
        await this.cancelOrder(orderId, userId, normalizedReason, note);
        this.runRealtimeBestEffort(() => this.realtime.emitToOrder(orderId, 'order.status_changed', { orderId, status: 'CANCELLED' }), 'CANCEL_ORDER_STATUS');
        this.runPostCommitBestEffort(async () => {
            const order = await this.prisma.order.findUnique({ where: { orderId }, select: { buyerId: true, sellerId: true, title: true } });
            if (!order)
                return;
            const recipientId = order.buyerId === userId ? order.sellerId : order.buyerId;
            await this.notificationQueue.enqueue({ userId: recipientId, type: client_1.NotificationType.ORDER_CANCELLED, title: 'Order Cancelled', body: `Order "${order.title}" has been cancelled. Reason: ${normalizedReason}${note ? `. ${note}` : ''}`, pushData: { type: 'ORDER_CANCELLED', orderId } });
        }, 'CANCEL_ORDER_NOTIFICATION');
        return { orderId, status: 'CANCELLED' };
    }
    async confirmOrder(orderId, userId) {
        await this.withSerializableRetry(() => this.prisma.$transaction(async (tx) => {
            const order = await tx.order.findUnique({ where: { orderId } });
            if (!order) {
                throw new common_1.BadRequestException({ code: ErrorCodes.ORDER_NOT_FOUND, message: 'Order not found' });
            }
            const isCounterpart = order.createdByBuyer
                ? order.sellerId === userId
                : order.buyerId === userId;
            if (!isCounterpart) {
                throw new common_1.BadRequestException({ code: ErrorCodes.NOT_ORDER_PARTICIPANT, message: 'Not authorized to confirm this order' });
            }
            if (order.status !== client_1.OrderStatus.WAITING_CONFIRMATION) {
                throw new common_1.BadRequestException({ code: ErrorCodes.INVALID_ORDER_STATUS, message: 'Order is not waiting for confirmation' });
            }
            if (order.confirmationDeadlineAt && Date.now() >= order.confirmationDeadlineAt.getTime()) {
                throw new common_1.BadRequestException({ code: ErrorCodes.INVALID_ORDER_STATUS, message: 'Confirmation deadline has passed' });
            }
            this.validateTransition(order.status, client_1.OrderStatus.WAITING_PAYMENT);
            const updated = await tx.order.updateMany({
                where: { id: order.id, status: client_1.OrderStatus.WAITING_CONFIRMATION, OR: [{ confirmationDeadlineAt: null }, { confirmationDeadlineAt: { gt: new Date() } }] },
                data: {
                    status: client_1.OrderStatus.WAITING_PAYMENT,
                    confirmedAt: new Date(),
                    paymentDeadlineAt: (0, date_util_1.addDays)(new Date(), app_constants_1.PAYMENT_DEADLINE_DAYS),
                },
            });
            if (updated.count === 0) {
                throw new common_1.BadRequestException({ code: ErrorCodes.INVALID_ORDER_STATUS, message: 'Order status has already changed' });
            }
            const changedByType = order.createdByBuyer ? client_1.ActorType.SELLER : client_1.ActorType.BUYER;
            await tx.orderStatusHistory.create({
                data: {
                    orderId: order.id,
                    fromStatus: client_1.OrderStatus.WAITING_CONFIRMATION,
                    toStatus: client_1.OrderStatus.WAITING_PAYMENT,
                    changedBy: userId,
                    changedByType,
                },
            });
        }, { isolationLevel: client_1.Prisma.TransactionIsolationLevel.Serializable }), 'CONFIRM_ORDER_TX');
    }
    async rejectOrder(orderId, userId, reason) {
        await this.withSerializableRetry(() => this.prisma.$transaction(async (tx) => {
            const order = await tx.order.findUnique({ where: { orderId } });
            if (!order) {
                throw new common_1.BadRequestException({ code: ErrorCodes.ORDER_NOT_FOUND, message: 'Order not found' });
            }
            const isCounterpart = order.createdByBuyer
                ? order.sellerId === userId
                : order.buyerId === userId;
            if (!isCounterpart) {
                throw new common_1.BadRequestException({ code: ErrorCodes.NOT_ORDER_PARTICIPANT, message: 'Not authorized to reject this order' });
            }
            if (order.status !== client_1.OrderStatus.WAITING_CONFIRMATION) {
                throw new common_1.BadRequestException({ code: ErrorCodes.INVALID_ORDER_STATUS, message: 'Order is not waiting for confirmation' });
            }
            this.validateTransition(order.status, client_1.OrderStatus.CANCELLED);
            const updated = await tx.order.updateMany({
                where: { id: order.id, status: client_1.OrderStatus.WAITING_CONFIRMATION },
                data: {
                    status: client_1.OrderStatus.CANCELLED,
                    cancelledAt: new Date(),
                    cancelReason: 'REJECTED_BY_COUNTERPART',
                    cancelNote: reason,
                },
            });
            if (updated.count === 0) {
                throw new common_1.BadRequestException({ code: ErrorCodes.INVALID_ORDER_STATUS, message: 'Order status has already changed' });
            }
            const changedByType = order.createdByBuyer ? client_1.ActorType.SELLER : client_1.ActorType.BUYER;
            await tx.orderStatusHistory.create({
                data: {
                    orderId: order.id,
                    fromStatus: client_1.OrderStatus.WAITING_CONFIRMATION,
                    toStatus: client_1.OrderStatus.CANCELLED,
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
        }, { isolationLevel: client_1.Prisma.TransactionIsolationLevel.Serializable }), 'REJECT_ORDER_TX');
    }
    async payOrder(orderId, buyerId) {
        const order = await this.prisma.order.findUnique({
            where: { orderId },
            include: { buyer: { select: { wallet: { select: { id: true } } } } },
        });
        if (!order) {
            throw new common_1.BadRequestException({ code: ErrorCodes.ORDER_NOT_FOUND, message: 'Order not found' });
        }
        if (order.status !== client_1.OrderStatus.WAITING_PAYMENT) {
            throw new common_1.BadRequestException({ code: ErrorCodes.INVALID_ORDER_STATUS, message: 'Order is not waiting for payment' });
        }
        this.validateTransition(order.status, client_1.OrderStatus.PROCESSING);
        if (order.buyerId !== buyerId) {
            throw new common_1.BadRequestException({ code: ErrorCodes.NOT_ORDER_PARTICIPANT, message: 'Not authorized to pay this order' });
        }
        if (order.paymentDeadlineAt && Date.now() >= order.paymentDeadlineAt.getTime()) {
            throw new common_1.BadRequestException({ code: ErrorCodes.ORDER_PAYMENT_EXPIRED, message: 'Payment deadline has passed. The order will be cancelled shortly.' });
        }
        const buyerWalletId = order.buyer?.wallet?.id;
        if (!buyerWalletId) {
            throw new common_1.BadRequestException({ code: ErrorCodes.NOT_FOUND, message: 'Buyer wallet not found' });
        }
        let walletTxId;
        const walletTxSerial = await this.getNextWalletTxSerial();
        await this.withSerializableRetry(() => this.prisma.$transaction(async (tx) => {
            const freshOrder = await tx.order.findUnique({ where: { id: order.id }, select: { status: true, paymentDeadlineAt: true, buyerId: true, buyerPayAmount: true } });
            if (!freshOrder || freshOrder.status !== client_1.OrderStatus.WAITING_PAYMENT) {
                throw new common_1.BadRequestException({ code: ErrorCodes.INVALID_ORDER_STATUS, message: 'Order is no longer waiting for payment' });
            }
            if (freshOrder.paymentDeadlineAt && Date.now() >= freshOrder.paymentDeadlineAt.getTime()) {
                throw new common_1.BadRequestException({ code: ErrorCodes.ORDER_PAYMENT_EXPIRED, message: 'Payment deadline has passed' });
            }
            if (freshOrder.buyerId !== buyerId || freshOrder.buyerPayAmount !== order.buyerPayAmount) {
                throw new common_1.ConflictException({ code: ErrorCodes.OPTIMISTIC_LOCK_CONFLICT, message: 'Order payment terms changed, please reload and retry' });
            }
            const wallet = await tx.wallet.findUnique({ where: { id: buyerWalletId } });
            if (!wallet)
                throw new common_1.BadRequestException({ code: ErrorCodes.NOT_FOUND, message: 'Buyer wallet not found' });
            if (wallet.isLocked) {
                throw new common_1.BadRequestException({ code: 'WALLET_LOCKED', message: 'Your wallet is locked. Please contact support.' });
            }
            if (wallet.availableBalance < order.buyerPayAmount) {
                throw new common_1.BadRequestException({ code: ErrorCodes.INSUFFICIENT_BALANCE, message: 'Insufficient balance for payment' });
            }
            const maxEscrowSen = BigInt(app_constants_1.MAX_ESCROW_BALANCE) * BigInt(100);
            if (wallet.escrowBalance + order.buyerPayAmount > maxEscrowSen) {
                throw new common_1.BadRequestException({ code: ErrorCodes.ESCROW_LIMIT_EXCEEDED, message: 'Total escrow balance would exceed the maximum limit. Please wait for existing orders to complete.' });
            }
            const updated = await tx.wallet.updateMany({
                where: { id: buyerWalletId, version: wallet.version, availableBalance: { gte: order.buyerPayAmount } },
                data: { availableBalance: { decrement: order.buyerPayAmount }, escrowBalance: { increment: order.buyerPayAmount }, version: { increment: 1 } },
            });
            if (updated.count === 0) {
                throw new common_1.BadRequestException({ code: ErrorCodes.OPTIMISTIC_LOCK_CONFLICT, message: 'Concurrent update detected, please retry' });
            }
            walletTxId = (0, id_generator_util_1.generateWalletTxId)(walletTxSerial);
            await tx.walletTransaction.create({
                data: {
                    txId: walletTxId,
                    walletId: buyerWalletId,
                    type: client_1.WalletTransactionType.ORDER_LOCK,
                    status: client_1.WalletTransactionStatus.SUCCESS,
                    amount: order.buyerPayAmount,
                    balanceBefore: wallet.availableBalance,
                    balanceAfter: wallet.availableBalance - order.buyerPayAmount,
                    orderId: order.id,
                    description: `Escrow lock for order ${order.orderId}`,
                },
            });
            const orderUpdated = await tx.order.updateMany({
                where: { id: order.id, status: client_1.OrderStatus.WAITING_PAYMENT },
                data: {
                    status: client_1.OrderStatus.PROCESSING,
                    paidAt: new Date(),
                    processedAt: new Date(),
                    deliveryDeadlineAt: (0, date_util_1.addDays)(new Date(), order.deliveryDeadlineDays ?? 3),
                },
            });
            if (orderUpdated.count === 0) {
                throw new common_1.ConflictException({ code: ErrorCodes.INVALID_ORDER_STATUS, message: 'Order status changed concurrently, please retry' });
            }
            await tx.orderStatusHistory.create({
                data: { orderId: order.id, fromStatus: client_1.OrderStatus.WAITING_PAYMENT, toStatus: client_1.OrderStatus.PROCESSING, changedBy: buyerId, changedByType: client_1.ActorType.BUYER },
            });
        }, { isolationLevel: client_1.Prisma.TransactionIsolationLevel.Serializable }), 'PAY_ORDER_TX');
        return { walletTxId };
    }
    async completeOrder(orderId, buyerId, deliveryProofId) {
        const MAX_RETRIES = 3;
        let lastError;
        const releaseTxSerial = await this.getNextWalletTxSerial();
        const receiveTxSerial = await this.getNextWalletTxSerial();
        let feeSerial = null;
        const nextFeeTxSerial = async () => {
            if (feeSerial === null)
                feeSerial = await this.getNextWalletTxSerial();
            return feeSerial;
        };
        for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
            try {
                await this.prisma.$transaction(async (tx) => {
                    const order = await tx.order.findUnique({ where: { orderId } });
                    if (!order) {
                        throw new common_1.BadRequestException({ code: ErrorCodes.ORDER_NOT_FOUND, message: 'Order not found' });
                    }
                    if (order.status !== client_1.OrderStatus.IN_DELIVERY) {
                        throw new common_1.BadRequestException({ code: ErrorCodes.INVALID_ORDER_STATUS, message: 'Order is not in delivery' });
                    }
                    this.validateTransition(order.status, client_1.OrderStatus.COMPLETED);
                    if (order.buyerId !== buyerId) {
                        throw new common_1.BadRequestException({ code: ErrorCodes.NOT_ORDER_PARTICIPANT, message: 'Not authorized to complete this order' });
                    }
                    const acceptedProof = await tx.deliveryProof.findFirst({
                        where: deliveryProofId
                            ? { id: deliveryProofId, orderId: order.id, status: { in: ['SUBMITTED', 'ACCEPTED'] } }
                            : { orderId: order.id, status: 'ACCEPTED' },
                        select: { id: true, status: true },
                    });
                    if (!acceptedProof) {
                        throw new common_1.BadRequestException({ code: ErrorCodes.INVALID_ORDER_STATUS, message: 'At least one delivery proof must be accepted before completing the order' });
                    }
                    const orderUpdated = await tx.order.updateMany({
                        where: { id: order.id, status: client_1.OrderStatus.IN_DELIVERY },
                        data: { status: client_1.OrderStatus.COMPLETED, completedAt: new Date() },
                    });
                    if (orderUpdated.count === 0) {
                        throw new common_1.ConflictException({ code: ErrorCodes.INVALID_ORDER_STATUS, message: 'Order status changed concurrently, please retry' });
                    }
                    await tx.orderStatusHistory.create({
                        data: {
                            orderId: order.id,
                            fromStatus: client_1.OrderStatus.IN_DELIVERY,
                            toStatus: client_1.OrderStatus.COMPLETED,
                            changedBy: buyerId,
                            changedByType: client_1.ActorType.BUYER,
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
                            throw new common_1.ConflictException({ code: ErrorCodes.DELIVERY_PROOF_NOT_FOUND, message: 'Delivery proof was reviewed concurrently; please retry' });
                        }
                    }
                    const buyerWalletPreLock = await tx.wallet.findUnique({ where: { userId: order.buyerId }, select: { id: true } });
                    const sellerWalletPreLock = await tx.wallet.findUnique({ where: { userId: order.sellerId }, select: { id: true } });
                    if (!buyerWalletPreLock || !sellerWalletPreLock) {
                        throw new common_1.BadRequestException({ code: ErrorCodes.NOT_FOUND, message: 'Wallet not found during escrow release' });
                    }
                    const [firstId, secondId] = [buyerWalletPreLock.id, sellerWalletPreLock.id].sort();
                    await tx.$queryRaw `SELECT id FROM wallets WHERE id IN (${firstId}, ${secondId}) ORDER BY id FOR UPDATE`;
                    const buyerWallet = await tx.wallet.findUnique({ where: { id: buyerWalletPreLock.id } });
                    const sellerWallet = await tx.wallet.findUnique({ where: { id: sellerWalletPreLock.id } });
                    if (!buyerWallet || !sellerWallet) {
                        throw new common_1.BadRequestException({ code: ErrorCodes.NOT_FOUND, message: 'Wallet not found during escrow release' });
                    }
                    const escrowLock = await tx.walletTransaction.findFirst({
                        where: { orderId: order.id, type: client_1.WalletTransactionType.ORDER_LOCK, status: client_1.WalletTransactionStatus.SUCCESS },
                        select: { amount: true },
                    });
                    if (!escrowLock || escrowLock.amount !== order.buyerPayAmount) {
                        throw new common_1.ConflictException({ code: ErrorCodes.ESCROW_LOCK_MISSING, message: 'Escrow lock ledger is missing or does not match this order' });
                    }
                    if (buyerWallet.isLocked) {
                        throw new common_1.BadRequestException({ code: 'WALLET_LOCKED', message: 'Buyer wallet is locked. Cannot proceed with escrow release.' });
                    }
                    if (sellerWallet.isLocked) {
                        throw new common_1.BadRequestException({ code: 'WALLET_LOCKED', message: 'Seller wallet is locked. Cannot proceed with escrow release.' });
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
                        throw new common_1.ConflictException({ code: ErrorCodes.OPTIMISTIC_LOCK_CONFLICT, message: 'Concurrent escrow release detected, please retry' });
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
                        throw new common_1.ConflictException({ code: ErrorCodes.OPTIMISTIC_LOCK_CONFLICT, message: 'Concurrent wallet update on seller detected, please retry' });
                    }
                    const releaseTxId = (0, id_generator_util_1.generateWalletTxId)(releaseTxSerial);
                    await tx.walletTransaction.create({
                        data: {
                            txId: releaseTxId,
                            walletId: buyerWallet.id,
                            type: client_1.WalletTransactionType.ORDER_RELEASE,
                            status: client_1.WalletTransactionStatus.SUCCESS,
                            amount: order.buyerPayAmount,
                            balanceBefore: buyerBalanceBefore,
                            balanceAfter: buyerBalanceAfter,
                            orderId: order.id,
                            description: `Escrow released for completed order ${order.orderId}`,
                        },
                    });
                    const receiveTxId = (0, id_generator_util_1.generateWalletTxId)(receiveTxSerial);
                    await tx.walletTransaction.create({
                        data: {
                            txId: receiveTxId,
                            walletId: sellerWallet.id,
                            type: client_1.WalletTransactionType.ORDER_RELEASE,
                            status: client_1.WalletTransactionStatus.SUCCESS,
                            amount: order.sellerReceiveAmount,
                            balanceBefore: sellerBalanceBefore,
                            balanceAfter: sellerBalanceAfter,
                            orderId: order.id,
                            description: `Payment received for completed order ${order.orderId}`,
                        },
                    });
                    if (order.feeAmount > BigInt(0)) {
                        const feeTxId = (0, id_generator_util_1.generateWalletTxId)(await nextFeeTxSerial());
                        await tx.walletTransaction.create({
                            data: {
                                txId: feeTxId,
                                walletId: buyerWallet.id,
                                type: client_1.WalletTransactionType.FEE_DEDUCT,
                                status: client_1.WalletTransactionStatus.SUCCESS,
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
                                status: { in: [client_1.SubscriptionStatus.ACTIVE, client_1.SubscriptionStatus.CANCELLED] },
                                currentPeriodEnd: { gt: new Date() },
                            },
                            select: { id: true, feeSavingsUsed: true, feeSavingsLimit: true },
                        });
                        if (activeSub && activeSub.feeSavingsUsed < activeSub.feeSavingsLimit) {
                            const feeConfig = await this.feeCalculator.getFeeConfig();
                            const savings = this.feeCalculator.getPlusSavingsSen(order.orderValue, feeConfig);
                            if (savings > BigInt(0)) {
                                await tx.$executeRaw `
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
                }, { isolationLevel: client_1.Prisma.TransactionIsolationLevel.Serializable });
                lastError = null;
                break;
            }
            catch (err) {
                lastError = err;
                if (!this.isRetryableDbError(err) || attempt === MAX_RETRIES) {
                    this.logger.error(`COMPLETE_ORDER_TX_FAILED orderId=${orderId} attempt=${attempt}/${MAX_RETRIES}`, err instanceof Error ? err.stack : String(err));
                    break;
                }
                this.logger.warn(`COMPLETE_ORDER_TX_RETRY orderId=${orderId} attempt=${attempt}/${MAX_RETRIES}`);
                const jitter = (0, crypto_1.randomInt)(0, 50);
                await new Promise(resolve => setTimeout(resolve, 100 * Math.pow(2, attempt - 1) + jitter));
            }
        }
        if (lastError)
            throw lastError;
    }
    isRetryableDbError(err) {
        if (err instanceof client_1.Prisma.PrismaClientKnownRequestError && err.code === 'P2034')
            return true;
        if (err instanceof client_1.Prisma.PrismaClientUnknownRequestError) {
            const msg = err.message.toLowerCase();
            if (msg.includes('40001') || msg.includes('serialization') || msg.includes('40p01') || msg.includes('deadlock'))
                return true;
        }
        return false;
    }
    async cancelOrder(orderId, userId, reason, note) {
        const normalizedText = reason.trim().toUpperCase();
        const normalizedReason = Object.values(client_1.OrderCancelReason).includes(normalizedText)
            ? normalizedText
            : client_1.OrderCancelReason.USER_MUTUAL_CANCEL;
        await this.withSerializableRetry(() => this.prisma.$transaction(async (tx) => {
            const order = await tx.order.findUnique({ where: { orderId } });
            if (!order) {
                throw new common_1.BadRequestException({ code: ErrorCodes.ORDER_NOT_FOUND, message: 'Order not found' });
            }
            if (order.buyerId !== userId && order.sellerId !== userId) {
                throw new common_1.BadRequestException({ code: ErrorCodes.NOT_ORDER_PARTICIPANT, message: 'Not authorized to cancel this order' });
            }
            const isBuyer = order.buyerId === userId;
            const isSeller = order.sellerId === userId;
            let cancellableStatuses;
            if (isBuyer) {
                cancellableStatuses = [client_1.OrderStatus.WAITING_CONFIRMATION, client_1.OrderStatus.WAITING_PAYMENT];
            }
            else if (isSeller) {
                cancellableStatuses = [client_1.OrderStatus.WAITING_CONFIRMATION, client_1.OrderStatus.WAITING_PAYMENT];
            }
            else {
                cancellableStatuses = [];
            }
            if (!cancellableStatuses.includes(order.status)) {
                throw new common_1.BadRequestException({
                    code: ErrorCodes.INVALID_ORDER_STATUS,
                    message: 'Order cannot be cancelled at this stage',
                });
            }
            this.validateTransition(order.status, client_1.OrderStatus.CANCELLED);
            const cancelNote = note
                ? `${normalizedReason}: ${note}`
                : `${normalizedReason} — Cancelled by ${isBuyer ? 'buyer' : 'seller'}`;
            const cancelUpdated = await tx.order.updateMany({
                where: { id: order.id, status: { in: cancellableStatuses } },
                data: {
                    status: client_1.OrderStatus.CANCELLED,
                    cancelledAt: new Date(),
                    cancelReason: normalizedReason,
                    cancelNote,
                },
            });
            if (cancelUpdated.count === 0) {
                throw new common_1.ConflictException({
                    code: ErrorCodes.OPTIMISTIC_LOCK_CONFLICT,
                    message: 'Order status has already changed, please retry',
                });
            }
            await tx.orderStatusHistory.create({
                data: {
                    orderId: order.id,
                    fromStatus: order.status,
                    toStatus: client_1.OrderStatus.CANCELLED,
                    changedBy: userId,
                    changedByType: isBuyer ? client_1.ActorType.BUYER : client_1.ActorType.SELLER,
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
        }, { isolationLevel: client_1.Prisma.TransactionIsolationLevel.Serializable }), 'CANCEL_ORDER_TX');
        await this.orderQrisPaymentService.cancelPendingPaymentForOrder(orderId);
    }
    async adminCancelOrder(orderId, adminId, reason) {
        const preflightOrder = await this.prisma.order.findUnique({
            where: { orderId },
            select: { status: true, buyerPayAmount: true },
        });
        if (!preflightOrder) {
            throw new common_1.BadRequestException({ code: ErrorCodes.ORDER_NOT_FOUND, message: 'Order not found' });
        }
        const preflightQrisPayment = await this.prisma.paymentTransaction.findFirst({
            where: {
                order: { orderId },
                purpose: 'ORDER_ESCROW',
                status: 'SUCCESS',
            },
            select: { id: true },
        });
        const preflightNeedsRefundSerial = (preflightOrder.status === client_1.OrderStatus.PROCESSING || preflightOrder.status === client_1.OrderStatus.IN_DELIVERY) &&
            preflightOrder.buyerPayAmount > BigInt(0) && !preflightQrisPayment;
        let refundTxSerial = preflightNeedsRefundSerial
            ? await this.getNextWalletTxSerial()
            : null;
        let walletTxId;
        await this.withSerializableRetry(() => this.prisma.$transaction(async (tx) => {
            const order = await tx.order.findUnique({ where: { orderId } });
            if (!order) {
                throw new common_1.BadRequestException({ code: ErrorCodes.ORDER_NOT_FOUND, message: 'Order not found' });
            }
            const adminCancellableStatuses = [
                client_1.OrderStatus.WAITING_CONFIRMATION,
                client_1.OrderStatus.WAITING_PAYMENT,
                client_1.OrderStatus.PROCESSING,
                client_1.OrderStatus.IN_DELIVERY,
            ];
            if (!adminCancellableStatuses.includes(order.status)) {
                throw new common_1.BadRequestException({
                    code: ErrorCodes.INVALID_ORDER_STATUS,
                    message: `Order cannot be cancelled at status ${order.status}`,
                });
            }
            const adminCancelUpdated = await tx.order.updateMany({
                where: { id: order.id, status: { in: adminCancellableStatuses } },
                data: {
                    status: client_1.OrderStatus.CANCELLED,
                    cancelledAt: new Date(),
                    cancelReason: 'ADMIN_FORCE_CANCEL',
                    cancelNote: reason,
                },
            });
            if (adminCancelUpdated.count === 0) {
                throw new common_1.ConflictException({
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
                    toStatus: client_1.OrderStatus.CANCELLED,
                    changedBy: adminId,
                    changedByType: client_1.ActorType.ADMIN,
                    reason,
                },
            });
            const escrowStatuses = [client_1.OrderStatus.PROCESSING, client_1.OrderStatus.IN_DELIVERY];
            if (escrowStatuses.includes(order.status) && order.buyerPayAmount > BigInt(0)) {
                const escrowLock = await tx.walletTransaction.findFirst({
                    where: { orderId: order.id, type: client_1.WalletTransactionType.ORDER_LOCK, status: client_1.WalletTransactionStatus.SUCCESS },
                    select: { amount: true },
                });
                if (!escrowLock || escrowLock.amount !== order.buyerPayAmount) {
                    throw new common_1.ConflictException({ code: ErrorCodes.ESCROW_LOCK_MISSING, message: 'Escrow lock ledger is missing or does not match this order' });
                }
                const qrisOrderPayment = await tx.paymentTransaction.findFirst({
                    where: { orderId: order.id, purpose: 'ORDER_ESCROW', status: 'SUCCESS' },
                    select: { id: true },
                });
                if (!qrisOrderPayment) {
                    if (refundTxSerial === null)
                        refundTxSerial = await this.getNextWalletTxSerial();
                    const walletLookup = await tx.wallet.findFirst({
                        where: { userId: order.buyerId },
                        select: { id: true },
                    });
                    if (!walletLookup) {
                        throw new common_1.BadRequestException({ code: ErrorCodes.NOT_FOUND, message: 'Buyer wallet not found for escrow refund' });
                    }
                    await tx.$queryRaw `SELECT id FROM wallets WHERE id = ${walletLookup.id} FOR UPDATE`;
                    const buyerWallet = await tx.wallet.findUnique({ where: { id: walletLookup.id } });
                    if (!buyerWallet) {
                        throw new common_1.BadRequestException({ code: ErrorCodes.NOT_FOUND, message: 'Buyer wallet not found for escrow refund' });
                    }
                    const escrowLock = await tx.walletTransaction.findFirst({
                        where: { orderId: order.id, type: client_1.WalletTransactionType.ORDER_LOCK, status: client_1.WalletTransactionStatus.SUCCESS },
                        select: { amount: true },
                    });
                    if (!escrowLock || escrowLock.amount !== order.buyerPayAmount) {
                        throw new common_1.ConflictException({ code: ErrorCodes.ESCROW_LOCK_MISSING, message: 'Escrow lock ledger is missing or does not match this order' });
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
                        throw new common_1.ConflictException({
                            code: ErrorCodes.OPTIMISTIC_LOCK_CONFLICT,
                            message: 'Concurrent wallet update detected during escrow refund, please retry',
                        });
                    }
                    walletTxId = (0, id_generator_util_1.generateWalletTxId)(refundTxSerial);
                    await tx.walletTransaction.create({
                        data: {
                            txId: walletTxId,
                            walletId: buyerWallet.id,
                            type: client_1.WalletTransactionType.ORDER_REFUND,
                            status: client_1.WalletTransactionStatus.SUCCESS,
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
        await this.orderQrisPaymentService.requestRefundForOrder(orderId, `Admin cancelled order: ${reason}`).catch((error) => {
            this.logger.error(`ADMIN_CANCEL_QRIS_REFUND_REQUEST_FAILED orderId=${orderId}: ${error instanceof Error ? error.message : String(error)}`);
        });
        this.runRealtimeBestEffort(() => this.realtime.emitToOrder(orderId, 'order.status_changed', { orderId, status: 'CANCELLED' }), 'ADMIN_CANCEL_ORDER_STATUS');
        this.runPostCommitBestEffort(async () => {
            const adminOrder = await this.prisma.order.findUnique({ where: { orderId }, select: { buyerId: true, sellerId: true, title: true } });
            if (!adminOrder)
                return;
            for (const recipientId of [adminOrder.buyerId, adminOrder.sellerId]) {
                await this.notificationQueue.enqueue({ userId: recipientId, type: client_1.NotificationType.ORDER_CANCELLED, title: 'Order Cancelled by Admin', body: `Order "${adminOrder.title}" has been cancelled by an administrator.${reason ? ` Reason: ${reason}` : ''}`, pushData: { type: 'ORDER_CANCELLED', orderId } });
            }
        }, 'ADMIN_CANCEL_ORDER_NOTIFICATION');
    }
    async getNextWalletTxSerial() {
        return this.walletTxSerialService.getNext();
    }
};
exports.OrderStateService = OrderStateService;
exports.OrderStateService = OrderStateService = OrderStateService_1 = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [prisma_service_1.PrismaService,
        redis_service_1.RedisService,
        wallet_service_1.WalletService,
        order_qris_payment_service_1.OrderQrisPaymentService,
        wallet_tx_serial_service_1.WalletTxSerialService,
        referral_service_1.ReferralService,
        fee_calculator_service_1.FeeCalculatorService,
        realtime_service_1.RealtimeService,
        membership_rank_service_1.MembershipRankService,
        notification_queue_service_1.NotificationQueueService])
], OrderStateService);
