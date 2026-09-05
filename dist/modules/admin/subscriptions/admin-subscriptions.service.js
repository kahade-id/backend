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
var AdminSubscriptionsService_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.AdminSubscriptionsService = void 0;
const common_1 = require("@nestjs/common");
const prisma_service_1 = require("../../../prisma/prisma.service");
const audit_log_service_1 = require("../../../common/services/audit-log.service");
const midtrans_service_1 = require("../../payment/midtrans.service");
const pagination_dto_1 = require("../../../common/dto/pagination.dto");
const client_1 = require("@prisma/client");
const currency_util_1 = require("../../../common/utils/currency.util");
const ErrorCodes = __importStar(require("../../../common/constants/error-codes"));
let AdminSubscriptionsService = AdminSubscriptionsService_1 = class AdminSubscriptionsService {
    constructor(prisma, auditLog, midtransService) {
        this.prisma = prisma;
        this.auditLog = auditLog;
        this.midtransService = midtransService;
        this.logger = new common_1.Logger(AdminSubscriptionsService_1.name);
    }
    async listSubscriptions(page, limit, status, plan) {
        const safePage = Math.max(1, Number.isFinite(page) ? Math.trunc(page) : 1);
        const safeLimit = Math.min(100, Math.max(1, Number.isFinite(limit) ? Math.trunc(limit) : 20));
        const skip = (safePage - 1) * safeLimit;
        const where = {};
        const normalizedStatus = status?.trim().toUpperCase();
        const normalizedPlan = plan?.trim().toUpperCase();
        if (normalizedStatus) {
            const validStatuses = ['ACTIVE', 'CANCELLED', 'EXPIRED', 'PENDING', 'SUSPENDED'];
            if (!validStatuses.includes(normalizedStatus)) {
                throw new common_1.BadRequestException({
                    code: ErrorCodes.INVALID_STATUS,
                    message: `Invalid subscription status: ${normalizedStatus}. Valid values: ${validStatuses.join(', ')}`,
                });
            }
            where.status = normalizedStatus;
        }
        if (normalizedPlan) {
            const validPlans = ['MONTHLY', 'ANNUAL'];
            if (!validPlans.includes(normalizedPlan)) {
                throw new common_1.BadRequestException({
                    code: ErrorCodes.INVALID_STATUS,
                    message: `Invalid subscription plan: ${normalizedPlan}. Valid values: ${validPlans.join(', ')}`,
                });
            }
            where.plan = normalizedPlan;
        }
        const [subscriptions, total] = await Promise.all([
            this.prisma.subscription.findMany({
                where,
                skip,
                take: safeLimit,
                orderBy: { createdAt: 'desc' },
                include: {
                    user: {
                        select: {
                            id: true,
                            userId: true,
                            username: true,
                            fullName: true,
                            email: true,
                        },
                    },
                },
            }),
            this.prisma.subscription.count({ where }),
        ]);
        const data = subscriptions.map(s => ({
            ...s,
            price: (0, currency_util_1.toIdr)(s.price),
            feeSavingsUsed: (0, currency_util_1.toIdr)(s.feeSavingsUsed),
            feeSavingsLimit: (0, currency_util_1.toIdr)(s.feeSavingsLimit),
        }));
        return (0, pagination_dto_1.createPaginatedResponse)(data, total, safePage, safeLimit);
    }
    async getSubscriptionDetail(subId) {
        const subscription = await this.prisma.subscription.findUnique({
            where: { id: subId },
            include: {
                user: {
                    select: {
                        id: true,
                        userId: true,
                        username: true,
                        fullName: true,
                        email: true,
                        isKahadePlus: true,
                        subscriptionExpiresAt: true,
                    },
                },
                paymentTx: true,
            },
        });
        if (!subscription) {
            throw new common_1.NotFoundException({
                code: ErrorCodes.SUBSCRIPTION_NOT_FOUND,
                message: 'Subscription not found',
            });
        }
        return {
            ...subscription,
            price: (0, currency_util_1.toIdr)(subscription.price),
            feeSavingsUsed: (0, currency_util_1.toIdr)(subscription.feeSavingsUsed),
            feeSavingsLimit: (0, currency_util_1.toIdr)(subscription.feeSavingsLimit),
        };
    }
    async forceCancelSubscription(subId, adminId, ipAddress) {
        const subscription = await this.prisma.subscription.findUnique({
            where: { id: subId },
        });
        if (!subscription) {
            throw new common_1.NotFoundException({
                code: ErrorCodes.SUBSCRIPTION_NOT_FOUND,
                message: 'Subscription not found',
            });
        }
        if (subscription.status !== 'ACTIVE' && subscription.status !== 'PENDING') {
            throw new common_1.BadRequestException({
                code: ErrorCodes.INVALID_STATUS,
                message: 'Subscription is not active or pending',
            });
        }
        const updated = await this.prisma.$transaction(async (tx) => {
            const result = await tx.subscription.updateMany({
                where: { id: subId, status: { in: ['ACTIVE', 'PENDING'] } },
                data: {
                    status: 'CANCELLED',
                    cancelledAt: new Date(),
                    cancelReason: 'Force cancelled by admin',
                },
            });
            if (result.count === 0) {
                throw new common_1.BadRequestException({
                    code: ErrorCodes.INVALID_STATUS,
                    message: 'Subscription is no longer active or pending',
                });
            }
            const sub = await tx.subscription.findUniqueOrThrow({ where: { id: subId } });
            const now = new Date();
            const remaining = await tx.subscription.findFirst({
                where: {
                    userId: subscription.userId,
                    id: { not: subId },
                    status: { in: ['ACTIVE', 'CANCELLED', 'SUSPENDED'] },
                    currentPeriodEnd: { gt: now },
                },
                orderBy: { currentPeriodEnd: 'desc' },
                select: { currentPeriodEnd: true },
            });
            await tx.user.update({
                where: { id: subscription.userId },
                data: {
                    isKahadePlus: Boolean(remaining),
                    subscriptionExpiresAt: remaining?.currentPeriodEnd ?? null,
                },
            });
            return sub;
        }, { isolationLevel: client_1.Prisma.TransactionIsolationLevel.Serializable });
        let paymentProviderSynced = false;
        let midtransOrderId = null;
        if (subscription.paymentTxId) {
            const paymentTx = await this.prisma.paymentTransaction.findUnique({
                where: { id: subscription.paymentTxId },
                select: { midtransOrderId: true },
            });
            midtransOrderId = paymentTx?.midtransOrderId ?? null;
        }
        if (midtransOrderId) {
            try {
                await this.midtransService.cancelTransaction(midtransOrderId);
                paymentProviderSynced = true;
                this.logger.log(`Payment provider notified: cancelled Midtrans transaction ${midtransOrderId} for subscription ${subId}`);
            }
            catch (err) {
                this.logger.warn(`Failed to cancel Midtrans transaction ${midtransOrderId} for subscription ${subId}: ${err.message}. ` +
                    `Manual reconciliation may be required.`);
            }
        }
        else {
            this.logger.warn(`No linked Midtrans transaction found for subscription ${subId}. ` +
                `Payment provider could not be notified. Manual reconciliation may be required.`);
        }
        this.auditLog.logAdminAction({
            adminId,
            action: client_1.AuditAction.ADMIN_ACTION,
            targetType: 'Subscription',
            targetId: subId,
            description: `Force cancelled subscription ${subId} for user ${subscription.userId}. Payment provider synced: ${paymentProviderSynced}.`,
            after: {
                paymentProviderSynced,
                midtransOrderId,
                note: paymentProviderSynced
                    ? 'Midtrans transaction cancelled successfully.'
                    : 'Payment provider sync failed or no linked transaction. Manual reconciliation may be required.',
            },
            ipAddress,
        });
        return {
            message: paymentProviderSynced
                ? 'Subscription cancelled successfully and payment provider notified.'
                : 'Subscription cancelled successfully. Warning: Payment provider sync failed — manual reconciliation may be required.',
            subscriptionId: updated.id,
            status: updated.status,
        };
    }
};
exports.AdminSubscriptionsService = AdminSubscriptionsService;
exports.AdminSubscriptionsService = AdminSubscriptionsService = AdminSubscriptionsService_1 = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [prisma_service_1.PrismaService,
        audit_log_service_1.AuditLogService,
        midtrans_service_1.MidtransService])
], AdminSubscriptionsService);
