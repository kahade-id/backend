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
var AdminOrdersService_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.AdminOrdersService = void 0;
const common_1 = require("@nestjs/common");
const crypto_1 = require("crypto");
const prisma_service_1 = require("../../../prisma/prisma.service");
const client_1 = require("@prisma/client");
const notification_category_map_1 = require("../../notifications/notification-category.map");
const pagination_dto_1 = require("../../../common/dto/pagination.dto");
const audit_log_service_1 = require("../../../common/services/audit-log.service");
const wallet_tx_serial_service_1 = require("../../../common/services/wallet-tx-serial.service");
const id_generator_util_1 = require("../../../common/utils/id-generator.util");
const order_state_service_1 = require("../../orders/order-state.service");
const fee_calculator_service_1 = require("../../orders/fee-calculator.service");
const referral_service_1 = require("../../referral/referral.service");
const membership_rank_service_1 = require("../../orders/membership-rank.service");
const currency_util_1 = require("../../../common/utils/currency.util");
const date_util_1 = require("../../../common/utils/date.util");
const ErrorCodes = __importStar(require("../../../common/constants/error-codes"));
function escapeLikePattern(pattern) {
    return pattern.replace(/[%_\\]/g, '\\$&');
}
function serializeOrder(order) {
    return {
        ...order,
        orderValue: (0, currency_util_1.toIdr)(order.orderValue),
        feeAmount: (0, currency_util_1.toIdr)(order.feeAmount),
        buyerFeeAmount: (0, currency_util_1.toIdr)(order.buyerFeeAmount),
        sellerFeeAmount: (0, currency_util_1.toIdr)(order.sellerFeeAmount),
        buyerPayAmount: (0, currency_util_1.toIdr)(order.buyerPayAmount),
        sellerReceiveAmount: (0, currency_util_1.toIdr)(order.sellerReceiveAmount),
        voucherDiscount: (0, currency_util_1.toIdr)(order.voucherDiscount),
    };
}
let AdminOrdersService = AdminOrdersService_1 = class AdminOrdersService {
    constructor(prisma, auditLog, orderStateService, feeCalculator, walletTxSerialService, referralService, membershipRankService) {
        this.prisma = prisma;
        this.auditLog = auditLog;
        this.orderStateService = orderStateService;
        this.feeCalculator = feeCalculator;
        this.walletTxSerialService = walletTxSerialService;
        this.referralService = referralService;
        this.membershipRankService = membershipRankService;
        this.logger = new common_1.Logger(AdminOrdersService_1.name);
    }
    async withSerializableRetry(fn, label) {
        for (let attempt = 1; attempt <= 3; attempt++) {
            try {
                return await fn();
            }
            catch (error) {
                const retryable = error instanceof client_1.Prisma.PrismaClientKnownRequestError && error.code === 'P2034'
                    || error instanceof client_1.Prisma.PrismaClientUnknownRequestError && /40001|serialization|40p01|deadlock/i.test(error.message);
                if (!retryable || attempt === 3)
                    throw error;
                this.logger.warn(`${label} retrying attempt=${attempt}/3`);
                await new Promise(resolve => setTimeout(resolve, 100 * 2 ** (attempt - 1) + (0, crypto_1.randomInt)(0, 50)));
            }
        }
        throw new Error(`${label}: unreachable`);
    }
    async listOrders(query) {
        const { page = 1, limit = 20, status, startDate, endDate, search, hasEscrow, sortBy, sortOrder } = query;
        const safePage = Math.max(1, Math.trunc(Number.isFinite(page) ? page : 1));
        const safeLimit = Math.min(100, Math.max(1, Math.trunc(Number.isFinite(limit) ? limit : 20)));
        const skip = (safePage - 1) * safeLimit;
        const where = {};
        if (status) {
            where.status = status;
        }
        if (hasEscrow === true) {
            where.walletTransactions = {
                some: { type: client_1.WalletTransactionType.ORDER_LOCK, status: client_1.WalletTransactionStatus.SUCCESS },
            };
        }
        if (startDate || endDate) {
            where.createdAt = {};
            if (startDate)
                where.createdAt.gte = (0, date_util_1.parseDateBoundaryWIB)(startDate, 'start');
            if (endDate)
                where.createdAt.lte = (0, date_util_1.parseDateBoundaryWIB)(endDate, 'end');
        }
        if (search && search.trim()) {
            const searchTerm = escapeLikePattern(search.trim().slice(0, 100));
            where.OR = [
                { orderId: { contains: searchTerm, mode: 'insensitive' } },
                { title: { contains: searchTerm, mode: 'insensitive' } },
            ];
        }
        if (startDate && endDate) {
            const startBoundary = (0, date_util_1.parseDateBoundaryWIB)(startDate, 'start');
            const endBoundary = (0, date_util_1.parseDateBoundaryWIB)(endDate, 'end');
            if (startBoundary && endBoundary && startBoundary > endBoundary) {
                throw new common_1.BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'startDate must be before or equal to endDate' });
            }
        }
        const orderBy = sortBy
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
        return (0, pagination_dto_1.createPaginatedResponse)(orders.map(o => serializeOrder(o)), total, safePage, safeLimit);
    }
    async getOrderDetail(orderId) {
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
            throw new common_1.NotFoundException({ code: ErrorCodes.ORDER_NOT_FOUND, message: 'Order not found' });
        }
        return serializeOrder(order);
    }
    async forceCancel(orderId, adminId, dto, ipAddress = 'unknown') {
        const order = await this.prisma.order.findFirst({
            where: { OR: [{ id: orderId }, { orderId }] },
        });
        if (!order) {
            throw new common_1.NotFoundException({ code: ErrorCodes.ORDER_NOT_FOUND, message: 'Order not found' });
        }
        await this.orderStateService.adminCancelOrder(order.orderId, adminId, dto.reason || 'Admin force cancel');
        this.auditLog.logAdminAction({
            adminId,
            action: client_1.AuditAction.ORDER_FORCE_CANCEL,
            targetType: 'Order',
            targetId: order.orderId,
            description: `Admin force-cancelled order ${order.orderId}`,
            after: { reason: dto.reason },
            ipAddress,
        });
        this.logger.log(`Admin ${adminId} force-cancelled order ${order.orderId}`);
        return { orderId: order.orderId, status: client_1.OrderStatus.CANCELLED };
    }
    async forceComplete(orderId, adminId, dto, ipAddress = 'unknown') {
        const order = await this.prisma.order.findFirst({
            where: { OR: [{ id: orderId }, { orderId }] },
            include: {
                buyer: { select: { wallet: { select: { id: true, availableBalance: true, escrowBalance: true, totalBalance: true, version: true } } } },
                seller: { select: { wallet: { select: { id: true, availableBalance: true, totalBalance: true, version: true } } } },
            },
        });
        if (!order) {
            throw new common_1.NotFoundException({ code: ErrorCodes.ORDER_NOT_FOUND, message: 'Order not found' });
        }
        const completableStatuses = [
            client_1.OrderStatus.PROCESSING,
            client_1.OrderStatus.IN_DELIVERY,
        ];
        if (!completableStatuses.includes(order.status)) {
            throw new common_1.BadRequestException({
                code: ErrorCodes.INVALID_ORDER_STATUS,
                message: `Order cannot be force-completed at status ${order.status}`,
            });
        }
        const orderWithRelations = order;
        const buyerWallet = orderWithRelations.buyer?.wallet;
        const sellerWallet = orderWithRelations.seller?.wallet;
        if (!buyerWallet || !sellerWallet) {
            throw new common_1.BadRequestException({ code: ErrorCodes.NOT_FOUND, message: 'Buyer or seller wallet not found' });
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
        await this.withSerializableRetry(() => this.prisma.$transaction(async (tx) => {
            const orderUpdated = await tx.order.updateMany({
                where: { id: order.id, status: { in: completableStatuses } },
                data: { status: client_1.OrderStatus.COMPLETED, completedAt: new Date() },
            });
            if (orderUpdated.count === 0) {
                throw new common_1.ConflictException({ code: ErrorCodes.INVALID_ORDER_STATUS, message: 'Order status changed concurrently' });
            }
            const escrowLock = await tx.walletTransaction.findFirst({
                where: { orderId: order.id, type: client_1.WalletTransactionType.ORDER_LOCK, status: client_1.WalletTransactionStatus.SUCCESS },
                select: { amount: true },
            });
            if (!escrowLock || escrowLock.amount !== order.buyerPayAmount) {
                throw new common_1.ConflictException({ code: ErrorCodes.ESCROW_LOCK_MISSING, message: 'Escrow lock ledger is missing or does not match this order' });
            }
            const [firstWalletId, secondWalletId] = [buyerWallet.id, sellerWallet.id].sort();
            await tx.$queryRaw `SELECT id FROM wallets WHERE id IN (${firstWalletId}, ${secondWalletId}) ORDER BY id FOR UPDATE`;
            const freshBuyerWallet = await tx.wallet.findUnique({ where: { id: buyerWallet.id } });
            const freshSellerWallet = await tx.wallet.findUnique({ where: { id: sellerWallet.id } });
            if (!freshBuyerWallet || !freshSellerWallet) {
                throw new common_1.BadRequestException({ code: ErrorCodes.NOT_FOUND, message: 'Buyer or seller wallet not found during force-complete' });
            }
            if (freshBuyerWallet.isLocked || freshSellerWallet.isLocked) {
                throw new common_1.ForbiddenException({ code: 'WALLET_LOCKED', message: 'A participant wallet is locked; force-complete is deferred.' });
            }
            await tx.orderStatusHistory.create({
                data: {
                    orderId: order.id,
                    fromStatus: order.status,
                    toStatus: client_1.OrderStatus.COMPLETED,
                    changedBy: adminId,
                    changedByType: client_1.ActorType.ADMIN,
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
                    throw new common_1.BadRequestException({
                        code: ErrorCodes.INSUFFICIENT_BALANCE,
                        message: 'Failed to release escrow — concurrent update or insufficient escrow balance',
                    });
                }
                const releaseTxId = (0, id_generator_util_1.generateWalletTxId)(releaseTxSerial);
                await tx.walletTransaction.create({
                    data: {
                        txId: releaseTxId,
                        walletId: freshBuyerWallet.id,
                        type: client_1.WalletTransactionType.ORDER_RELEASE,
                        status: client_1.WalletTransactionStatus.SUCCESS,
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
                    throw new common_1.BadRequestException({
                        code: ErrorCodes.INSUFFICIENT_BALANCE,
                        message: 'Failed to credit seller wallet — concurrent update detected',
                    });
                }
                const receiveTxId = (0, id_generator_util_1.generateWalletTxId)(receiveTxSerial);
                await tx.walletTransaction.create({
                    data: {
                        txId: receiveTxId,
                        walletId: freshSellerWallet.id,
                        type: client_1.WalletTransactionType.ORDER_RELEASE,
                        status: client_1.WalletTransactionStatus.SUCCESS,
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
                const feeTxId = (0, id_generator_util_1.generateWalletTxId)(feeTxSerial);
                await tx.walletTransaction.create({
                    data: {
                        txId: feeTxId,
                        walletId: buyerWallet.id,
                        type: client_1.WalletTransactionType.FEE_DEDUCT,
                        status: client_1.WalletTransactionStatus.SUCCESS,
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
        }), 'ADMIN_FORCE_COMPLETE_TX');
        this.auditLog.logAdminAction({
            adminId,
            action: client_1.AuditAction.ORDER_FORCE_COMPLETE,
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
                    notifId: (0, id_generator_util_1.generateNotifId)(),
                    userId: recipient.userId,
                    type: client_1.NotificationType.ORDER_COMPLETED,
                    category: (0, notification_category_map_1.getCategoryForType)(client_1.NotificationType.ORDER_COMPLETED),
                    title: recipient.title,
                    body: recipient.body,
                    isRead: false,
                },
            }).catch((err) => this.logger.warn(`silent-catch: admin force-complete notification failed: ${err instanceof Error ? err.message : String(err)}`));
            this.prisma.emitNotificationCreated({ userId: recipient.userId, title: recipient.title, body: recipient.body, data: { type: 'ORDER_COMPLETED', orderId: order.orderId } });
        }
        this.logger.log(`Admin ${adminId} force-completed order ${order.orderId}`);
        return { orderId: order.orderId, status: client_1.OrderStatus.COMPLETED };
    }
};
exports.AdminOrdersService = AdminOrdersService;
exports.AdminOrdersService = AdminOrdersService = AdminOrdersService_1 = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [prisma_service_1.PrismaService,
        audit_log_service_1.AuditLogService,
        order_state_service_1.OrderStateService,
        fee_calculator_service_1.FeeCalculatorService,
        wallet_tx_serial_service_1.WalletTxSerialService,
        referral_service_1.ReferralService,
        membership_rank_service_1.MembershipRankService])
], AdminOrdersService);
