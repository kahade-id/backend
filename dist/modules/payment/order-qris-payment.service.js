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
var OrderQrisPaymentService_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.OrderQrisPaymentService = void 0;
const common_1 = require("@nestjs/common");
const config_1 = require("@nestjs/config");
const client_1 = require("@prisma/client");
const ErrorCodes = __importStar(require("../../common/constants/error-codes"));
const app_constants_1 = require("../../common/constants/app.constants");
const wallet_tx_serial_service_1 = require("../../common/services/wallet-tx-serial.service");
const currency_util_1 = require("../../common/utils/currency.util");
const date_util_1 = require("../../common/utils/date.util");
const id_generator_util_1 = require("../../common/utils/id-generator.util");
const prisma_service_1 = require("../../prisma/prisma.service");
const midtrans_service_1 = require("./midtrans.service");
const DEFAULT_QRIS_EXPIRY_MINUTES = 30;
let OrderQrisPaymentService = OrderQrisPaymentService_1 = class OrderQrisPaymentService {
    constructor(prisma, midtrans, config, walletTxSerialService) {
        this.prisma = prisma;
        this.midtrans = midtrans;
        this.config = config;
        this.walletTxSerialService = walletTxSerialService;
        this.logger = new common_1.Logger(OrderQrisPaymentService_1.name);
    }
    qrisFee(amount) {
        const percentage = this.config.get('app.paymentFeeQrisPercent') ?? 0.7;
        const basisPoints = Math.round(percentage * 100);
        return Math.ceil((amount * basisPoints) / 10_000);
    }
    expiryAt() {
        const configured = this.config.get('app.orderQrisExpiryMinutes') ?? DEFAULT_QRIS_EXPIRY_MINUTES;
        const minutes = Math.min(Math.max(Math.floor(configured), 5), 24 * 60);
        return new Date(Date.now() + minutes * 60_000);
    }
    parseGrossAmountToSen(raw) {
        if (!/^\d+(?:\.\d{1,2})?$/.test(raw)) {
            throw new common_1.BadRequestException({
                code: 'WEBHOOK_INVALID_GROSS_AMOUNT',
                message: 'Invalid provider gross amount',
            });
        }
        const [whole, fraction = ''] = raw.split('.');
        return BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
    }
    serializePayment(payment) {
        const instructions = payment.providerInstructions;
        const qrString = instructions &&
            typeof instructions === 'object' &&
            !Array.isArray(instructions) &&
            typeof instructions.qrString === 'string'
            ? instructions.qrString
            : null;
        const qrCodeUrl = instructions &&
            typeof instructions === 'object' &&
            !Array.isArray(instructions) &&
            typeof instructions.qrCodeUrl === 'string'
            ? instructions.qrCodeUrl
            : null;
        return {
            paymentTxId: payment.midtransOrderId,
            orderId: '',
            status: payment.status,
            escrowAmount: (0, currency_util_1.toIdr)(payment.amount),
            providerFee: (0, currency_util_1.toIdr)(payment.paymentFee),
            grossAmount: (0, currency_util_1.toIdr)(payment.grossAmount),
            qrString,
            qrCodeUrl,
            expiryTime: payment.expiredAt ?? new Date(),
        };
    }
    async initiate(orderId, buyerId) {
        const order = await this.prisma.order.findUnique({
            where: { orderId },
            include: { buyer: { select: { id: true, email: true, fullName: true } } },
        });
        if (!order)
            throw new common_1.BadRequestException({
                code: ErrorCodes.ORDER_NOT_FOUND,
                message: 'Order not found',
            });
        if (order.buyerId !== buyerId)
            throw new common_1.BadRequestException({
                code: ErrorCodes.NOT_ORDER_PARTICIPANT,
                message: 'Not authorized to pay this order',
            });
        if (order.status !== client_1.OrderStatus.WAITING_PAYMENT) {
            throw new common_1.BadRequestException({
                code: ErrorCodes.INVALID_ORDER_STATUS,
                message: 'Order is not waiting for payment',
            });
        }
        if (order.paymentDeadlineAt && Date.now() >= order.paymentDeadlineAt.getTime()) {
            throw new common_1.BadRequestException({
                code: ErrorCodes.ORDER_PAYMENT_EXPIRED,
                message: 'Payment deadline has passed',
            });
        }
        const now = new Date();
        const activePayment = await this.prisma.paymentTransaction.findFirst({
            where: {
                orderId: order.id,
                purpose: client_1.PaymentPurpose.ORDER_ESCROW,
                status: client_1.PaymentStatus.PENDING,
                OR: [{ expiredAt: { gt: now } }, { expiredAt: null }],
            },
            orderBy: { createdAt: 'desc' },
            select: {
                midtransOrderId: true,
                status: true,
                amount: true,
                paymentFee: true,
                grossAmount: true,
                expiredAt: true,
                providerInstructions: true,
            },
        });
        if (activePayment) {
            const instructions = activePayment.providerInstructions;
            const hasQrInstructions = instructions &&
                typeof instructions === 'object' &&
                !Array.isArray(instructions) &&
                typeof instructions.qrCodeUrl === 'string' &&
                instructions.qrCodeUrl.length > 0;
            if (!hasQrInstructions) {
                throw new common_1.ServiceUnavailableException({
                    code: 'QRIS_INSTRUCTIONS_PENDING',
                    message: 'QRIS payment is still being reconciled. Check payment status before retrying.',
                });
            }
            return { ...this.serializePayment(activePayment), orderId };
        }
        const escrowAmount = (0, currency_util_1.toIdr)(order.buyerPayAmount);
        const providerFee = this.qrisFee(escrowAmount);
        const grossAmount = escrowAmount + providerFee;
        const expiredAt = this.expiryAt();
        const paymentTxId = (0, id_generator_util_1.generatePaymentTxId)(await this.walletTxSerialService.getNextForPrefix('payment_serial'));
        const payment = await this.prisma.$transaction(async (tx) => {
            await tx.paymentTransaction.updateMany({
                where: {
                    orderId: order.id,
                    purpose: client_1.PaymentPurpose.ORDER_ESCROW,
                    status: client_1.PaymentStatus.PENDING,
                    expiredAt: { lte: now },
                },
                data: { status: client_1.PaymentStatus.EXPIRED, failedAt: now },
            });
            return tx.paymentTransaction.create({
                data: {
                    midtransOrderId: paymentTxId,
                    userId: buyerId,
                    orderId: order.id,
                    purpose: client_1.PaymentPurpose.ORDER_ESCROW,
                    method: client_1.PaymentMethod.QRIS,
                    status: client_1.PaymentStatus.PENDING,
                    amount: order.buyerPayAmount,
                    paymentFee: (0, currency_util_1.toSen)(providerFee),
                    grossAmount: (0, currency_util_1.toSen)(grossAmount),
                    expiredAt,
                },
                select: { id: true },
            });
        });
        try {
            const charge = await this.midtrans.chargeTransaction({
                orderId: paymentTxId,
                grossAmount,
                paymentMethod: client_1.PaymentMethod.QRIS,
                userEmail: order.buyer.email ?? '',
                fullName: order.buyer.fullName ?? 'Kahade User',
            });
            if (charge.grossAmount &&
                this.parseGrossAmountToSen(charge.grossAmount) !== (0, currency_util_1.toSen)(grossAmount)) {
                throw new common_1.ServiceUnavailableException({
                    code: 'QRIS_GROSS_AMOUNT_MISMATCH',
                    message: 'Payment provider returned a different gross amount',
                });
            }
            if (!charge.transactionId || !charge.qrCodeUrl) {
                throw new common_1.ServiceUnavailableException({
                    code: 'QRIS_INSTRUCTIONS_UNAVAILABLE',
                    message: 'QRIS provider did not return complete payment instructions',
                });
            }
            const chargeExpiry = charge.expiryTime ? new Date(charge.expiryTime) : expiredAt;
            const instructions = {
                qrString: charge.qrString ?? null,
                qrCodeUrl: charge.qrCodeUrl ?? null,
                actions: charge.actions ?? [],
                paymentType: charge.paymentType,
                providerTransactionId: charge.transactionId,
            };
            const updated = await this.prisma.paymentTransaction.update({
                where: { id: payment.id },
                data: {
                    providerInstructions: instructions,
                    qrCodeUrl: charge.qrCodeUrl,
                    expiredAt: Number.isNaN(chargeExpiry.getTime()) ? expiredAt : chargeExpiry,
                },
                select: {
                    midtransOrderId: true,
                    status: true,
                    amount: true,
                    paymentFee: true,
                    grossAmount: true,
                    expiredAt: true,
                    providerInstructions: true,
                },
            });
            return { ...this.serializePayment(updated), orderId };
        }
        catch (error) {
            this.logger.error(`QRIS order charge requires reconciliation: order=${orderId} payment=${paymentTxId}`, error instanceof Error ? error.stack : error);
            throw error;
        }
    }
    async getStatus(orderId, buyerId) {
        const order = await this.prisma.order.findUnique({
            where: { orderId },
            select: { id: true, buyerId: true },
        });
        if (!order)
            throw new common_1.BadRequestException({
                code: ErrorCodes.ORDER_NOT_FOUND,
                message: 'Order not found',
            });
        if (order.buyerId !== buyerId)
            throw new common_1.BadRequestException({
                code: ErrorCodes.NOT_ORDER_PARTICIPANT,
                message: 'Not authorized to view this payment',
            });
        const payment = await this.prisma.paymentTransaction.findFirst({
            where: { orderId: order.id, purpose: client_1.PaymentPurpose.ORDER_ESCROW },
            orderBy: { createdAt: 'desc' },
            select: {
                midtransOrderId: true,
                status: true,
                amount: true,
                paymentFee: true,
                grossAmount: true,
                expiredAt: true,
                providerInstructions: true,
            },
        });
        return payment ? { ...this.serializePayment(payment), orderId } : null;
    }
    async handleSettlement(midtransOrderId, grossAmount) {
        const payment = await this.prisma.paymentTransaction.findUnique({
            where: { midtransOrderId },
            select: { id: true, purpose: true, grossAmount: true },
        });
        if (!payment || payment.purpose !== client_1.PaymentPurpose.ORDER_ESCROW) {
            throw new common_1.BadRequestException({
                code: 'ORDER_QRIS_PAYMENT_NOT_FOUND',
                message: 'QRIS order payment not found',
            });
        }
        if (payment.grossAmount !== this.parseGrossAmountToSen(grossAmount)) {
            throw new common_1.BadRequestException({
                code: 'WEBHOOK_AMOUNT_MISMATCH',
                message: 'Provider gross amount does not match the QRIS order payment',
            });
        }
        const walletTxSerial = await this.walletTxSerialService.getNext();
        let refundReason = null;
        await this.prisma.$transaction(async (tx) => {
            const freshPayment = await tx.paymentTransaction.findUnique({
                where: { id: payment.id },
                include: { order: true },
            });
            if (!freshPayment || freshPayment.status !== client_1.PaymentStatus.PENDING)
                return;
            const order = freshPayment.order;
            if (!order) {
                await tx.paymentTransaction.update({
                    where: { id: freshPayment.id },
                    data: { status: client_1.PaymentStatus.SUCCESS, paidAt: new Date(), settledAt: new Date() },
                });
                refundReason = 'Order payment is no longer linked to an order';
                return;
            }
            if (order.status !== client_1.OrderStatus.WAITING_PAYMENT ||
                (order.paymentDeadlineAt && Date.now() >= order.paymentDeadlineAt.getTime())) {
                await tx.paymentTransaction.update({
                    where: { id: freshPayment.id },
                    data: { status: client_1.PaymentStatus.SUCCESS, paidAt: new Date(), settledAt: new Date() },
                });
                refundReason = 'Order is no longer eligible to receive an escrow payment';
                return;
            }
            const wallet = await tx.wallet.findUnique({ where: { userId: order.buyerId } });
            if (!wallet || wallet.isLocked) {
                await tx.paymentTransaction.update({
                    where: { id: freshPayment.id },
                    data: { status: client_1.PaymentStatus.SUCCESS, paidAt: new Date(), settledAt: new Date() },
                });
                refundReason = 'Buyer wallet cannot receive escrow funds';
                return;
            }
            const maxEscrowSen = BigInt(app_constants_1.MAX_ESCROW_BALANCE) * 100n;
            if (wallet.escrowBalance + freshPayment.amount > maxEscrowSen) {
                await tx.paymentTransaction.update({
                    where: { id: freshPayment.id },
                    data: { status: client_1.PaymentStatus.SUCCESS, paidAt: new Date(), settledAt: new Date() },
                });
                refundReason = 'Buyer escrow balance limit would be exceeded';
                return;
            }
            const walletUpdated = await tx.wallet.updateMany({
                where: { id: wallet.id, version: wallet.version },
                data: {
                    escrowBalance: { increment: freshPayment.amount },
                    totalBalance: { increment: freshPayment.amount },
                    version: { increment: 1 },
                },
            });
            if (walletUpdated.count !== 1) {
                throw new common_1.ConflictException({
                    code: ErrorCodes.OPTIMISTIC_LOCK_CONFLICT,
                    message: 'Concurrent wallet update detected, retry settlement',
                });
            }
            await tx.walletTransaction.create({
                data: {
                    txId: (0, id_generator_util_1.generateWalletTxId)(walletTxSerial),
                    walletId: wallet.id,
                    type: client_1.WalletTransactionType.ORDER_LOCK,
                    status: client_1.WalletTransactionStatus.SUCCESS,
                    amount: freshPayment.amount,
                    balanceBefore: wallet.totalBalance,
                    balanceAfter: wallet.totalBalance + freshPayment.amount,
                    orderId: order.id,
                    paymentTxId: freshPayment.id,
                    description: `QRIS escrow lock for order ${order.orderId}`,
                    metadata: { paymentSource: 'QRIS', providerFee: (0, currency_util_1.toIdr)(freshPayment.paymentFee) },
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
            if (orderUpdated.count !== 1) {
                throw new common_1.ConflictException({
                    code: ErrorCodes.OPTIMISTIC_LOCK_CONFLICT,
                    message: 'Order status changed during settlement, retry settlement',
                });
            }
            await tx.orderStatusHistory.create({
                data: {
                    orderId: order.id,
                    fromStatus: client_1.OrderStatus.WAITING_PAYMENT,
                    toStatus: client_1.OrderStatus.PROCESSING,
                    changedBy: order.buyerId,
                    changedByType: client_1.ActorType.BUYER,
                    reason: 'QRIS payment settled',
                },
            });
            await tx.paymentTransaction.update({
                where: { id: freshPayment.id },
                data: { status: client_1.PaymentStatus.SUCCESS, paidAt: new Date(), settledAt: new Date() },
            });
        }, { isolationLevel: client_1.Prisma.TransactionIsolationLevel.Serializable });
        if (refundReason) {
            await this.requestRefund(midtransOrderId, refundReason);
        }
    }
    async handleFailure(midtransOrderId, providerStatus) {
        const status = providerStatus.toLowerCase() === 'expire' ? client_1.PaymentStatus.EXPIRED : client_1.PaymentStatus.FAILED;
        await this.prisma.paymentTransaction.updateMany({
            where: {
                midtransOrderId,
                purpose: client_1.PaymentPurpose.ORDER_ESCROW,
                status: client_1.PaymentStatus.PENDING,
            },
            data: { status, failedAt: new Date() },
        });
    }
    async requestRefund(midtransOrderId, reason) {
        const payment = await this.prisma.paymentTransaction.findUnique({ where: { midtransOrderId } });
        if (!payment ||
            payment.purpose !== client_1.PaymentPurpose.ORDER_ESCROW ||
            payment.status === client_1.PaymentStatus.REFUNDED)
            return;
        const refundReference = payment.refundReference ?? `RFD-${payment.id}`;
        const claimTime = new Date();
        const claimed = await this.prisma.paymentTransaction.updateMany({
            where: { id: payment.id, refundRequestedAt: null },
            data: { refundRequestedAt: claimTime, refundReference, refundReason: reason.slice(0, 500) },
        });
        if (claimed.count !== 1)
            return;
        try {
            await this.midtrans.refundTransaction(midtransOrderId, (0, currency_util_1.toIdr)(payment.grossAmount), refundReference, reason.slice(0, 200));
        }
        catch (error) {
            await this.prisma.paymentTransaction
                .updateMany({
                where: { id: payment.id, refundRequestedAt: claimTime },
                data: { refundRequestedAt: null },
            })
                .catch(releaseError => this.logger.error(`Failed to release refund claim for ${midtransOrderId}: ${releaseError instanceof Error ? releaseError.message : String(releaseError)}`));
            throw error;
        }
    }
    async requestRefundForOrder(orderId, reason) {
        const payment = await this.prisma.paymentTransaction.findFirst({
            where: {
                order: { orderId },
                purpose: client_1.PaymentPurpose.ORDER_ESCROW,
                status: client_1.PaymentStatus.SUCCESS,
            },
            orderBy: { settledAt: 'desc' },
            select: { midtransOrderId: true },
        });
        if (payment)
            await this.requestRefund(payment.midtransOrderId, reason);
    }
    async cancelPendingPaymentForOrder(orderId) {
        const payment = await this.prisma.paymentTransaction.findFirst({
            where: {
                order: { orderId },
                purpose: client_1.PaymentPurpose.ORDER_ESCROW,
                status: client_1.PaymentStatus.PENDING,
            },
            orderBy: { createdAt: 'desc' },
            select: { midtransOrderId: true },
        });
        if (!payment)
            return;
        try {
            await this.midtrans.cancelTransaction(payment.midtransOrderId);
        }
        catch (error) {
            this.logger.warn(`Provider QRIS cancellation could not be confirmed for ${payment.midtransOrderId}: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    async handleRefund(midtransOrderId, refundReference) {
        const payment = await this.prisma.paymentTransaction.findUnique({
            where: { midtransOrderId },
            include: { order: true },
        });
        if (!payment ||
            payment.purpose !== client_1.PaymentPurpose.ORDER_ESCROW ||
            payment.status === client_1.PaymentStatus.REFUNDED)
            return;
        const order = payment.order;
        if (!order || order.status !== client_1.OrderStatus.CANCELLED) {
            throw new common_1.ServiceUnavailableException({
                code: 'ORDER_QRIS_REFUND_REQUIRES_REVIEW',
                message: 'QRIS refund for a non-cancelled order requires manual review',
            });
        }
        const refundSerial = await this.walletTxSerialService.getNext();
        await this.prisma.$transaction(async (tx) => {
            const freshPayment = await tx.paymentTransaction.findUnique({ where: { id: payment.id } });
            if (!freshPayment || freshPayment.status === client_1.PaymentStatus.REFUNDED)
                return;
            const escrowLock = await tx.walletTransaction.findFirst({
                where: {
                    paymentTxId: freshPayment.id,
                    type: client_1.WalletTransactionType.ORDER_LOCK,
                    status: client_1.WalletTransactionStatus.SUCCESS,
                },
            });
            if (!escrowLock) {
                throw new common_1.ServiceUnavailableException({
                    code: 'ORDER_QRIS_REFUND_LEDGER_MISSING',
                    message: 'QRIS refund has no escrow lock ledger; manual reconciliation is required',
                });
            }
            if (escrowLock) {
                const wallet = await tx.wallet.findUnique({ where: { id: escrowLock.walletId } });
                if (!wallet ||
                    wallet.escrowBalance < freshPayment.amount ||
                    wallet.totalBalance < freshPayment.amount) {
                    throw new common_1.ServiceUnavailableException({
                        code: 'ORDER_QRIS_REFUND_LEDGER_INVALID',
                        message: 'QRIS escrow refund requires ledger review',
                    });
                }
                const walletUpdated = await tx.wallet.updateMany({
                    where: {
                        id: wallet.id,
                        version: wallet.version,
                        escrowBalance: { gte: freshPayment.amount },
                        totalBalance: { gte: freshPayment.amount },
                    },
                    data: {
                        escrowBalance: { decrement: freshPayment.amount },
                        totalBalance: { decrement: freshPayment.amount },
                        version: { increment: 1 },
                    },
                });
                if (walletUpdated.count !== 1)
                    throw new common_1.ConflictException({
                        code: ErrorCodes.OPTIMISTIC_LOCK_CONFLICT,
                        message: 'Concurrent wallet refund detected, retry provider webhook',
                    });
                await tx.walletTransaction.create({
                    data: {
                        txId: (0, id_generator_util_1.generateWalletTxId)(refundSerial),
                        walletId: wallet.id,
                        type: client_1.WalletTransactionType.ORDER_REFUND,
                        status: client_1.WalletTransactionStatus.SUCCESS,
                        amount: freshPayment.amount,
                        balanceBefore: wallet.totalBalance,
                        balanceAfter: wallet.totalBalance - freshPayment.amount,
                        orderId: payment.orderId,
                        paymentTxId: freshPayment.id,
                        description: `QRIS refund to original payment channel for order ${order.orderId}`,
                        metadata: { paymentSource: 'QRIS', refundReference },
                    },
                });
            }
            await tx.paymentTransaction.update({
                where: { id: freshPayment.id },
                data: {
                    status: client_1.PaymentStatus.REFUNDED,
                    refundReference,
                    refundRequestedAt: freshPayment.refundRequestedAt ?? new Date(),
                },
            });
        }, { isolationLevel: client_1.Prisma.TransactionIsolationLevel.Serializable });
    }
};
exports.OrderQrisPaymentService = OrderQrisPaymentService;
exports.OrderQrisPaymentService = OrderQrisPaymentService = OrderQrisPaymentService_1 = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [prisma_service_1.PrismaService,
        midtrans_service_1.MidtransService,
        config_1.ConfigService,
        wallet_tx_serial_service_1.WalletTxSerialService])
], OrderQrisPaymentService);
