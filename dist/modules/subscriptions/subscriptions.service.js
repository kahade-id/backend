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
var SubscriptionsService_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.SubscriptionsService = void 0;
const common_1 = require("@nestjs/common");
const config_1 = require("@nestjs/config");
const prisma_service_1 = require("../../prisma/prisma.service");
const redis_service_1 = require("../../redis/redis.service");
const client_1 = require("@prisma/client");
const pagination_dto_1 = require("../../common/dto/pagination.dto");
const wallet_tx_serial_service_1 = require("../../common/services/wallet-tx-serial.service");
const wallet_service_1 = require("../wallet/wallet.service");
const audit_log_service_1 = require("../../common/services/audit-log.service");
const id_generator_util_1 = require("../../common/utils/id-generator.util");
const ErrorCodes = __importStar(require("../../common/constants/error-codes"));
const currency_util_1 = require("../../common/utils/currency.util");
const redis_keys_1 = require("../../common/constants/redis-keys");
const app_constants_1 = require("../../common/constants/app.constants");
const SUBSCRIPTION_PLANS_TTL = 300;
const PLAN_METADATA = {
    MONTHLY: { durationDays: 30, label: 'Kahade Plus Monthly' },
    ANNUAL: { durationDays: 366, label: 'Kahade Plus Annual' },
};
let SubscriptionsService = SubscriptionsService_1 = class SubscriptionsService {
    constructor(prisma, walletTxSerialService, walletService, configService, redis, auditLogService) {
        this.prisma = prisma;
        this.walletTxSerialService = walletTxSerialService;
        this.walletService = walletService;
        this.configService = configService;
        this.redis = redis;
        this.auditLogService = auditLogService;
        this.logger = new common_1.Logger(SubscriptionsService_1.name);
        const monthlyPriceSen = this.configService.get('app.subscriptionMonthlyPriceSen') ??
            app_constants_1.SUBSCRIPTION_MONTHLY_PRICE * 100;
        const annualPriceSen = this.configService.get('app.subscriptionAnnualPriceSen') ??
            app_constants_1.SUBSCRIPTION_ANNUAL_PRICE * 100;
        this.planPricing = {
            MONTHLY: { price: BigInt(monthlyPriceSen), ...PLAN_METADATA.MONTHLY },
            ANNUAL: { price: BigInt(annualPriceSen), ...PLAN_METADATA.ANNUAL },
        };
    }
    async getStatus(userId) {
        const subscription = await this.prisma.subscription.findFirst({
            where: {
                userId,
                status: {
                    in: [
                        client_1.SubscriptionStatus.ACTIVE,
                        client_1.SubscriptionStatus.CANCELLED,
                        client_1.SubscriptionStatus.SUSPENDED,
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
        const feeSavingsRemaining = subscription.feeSavingsLimit > subscription.feeSavingsUsed
            ? subscription.feeSavingsLimit - subscription.feeSavingsUsed
            : BigInt(0);
        const isInGracePeriod = subscription.status === client_1.SubscriptionStatus.SUSPENDED;
        return {
            isActive: !isInGracePeriod,
            isInGracePeriod,
            plan: subscription.plan,
            status: subscription.status,
            cancelledAt: subscription.cancelledAt,
            currentPeriodStart: subscription.currentPeriodStart,
            currentPeriodEnd: subscription.currentPeriodEnd,
            feeSavingsUsed: (0, currency_util_1.toIdr)(subscription.feeSavingsUsed),
            feeSavingsLimit: (0, currency_util_1.toIdr)(subscription.feeSavingsLimit),
            feeSavingsRemaining: (0, currency_util_1.toIdr)(feeSavingsRemaining),
            isAutoRenew: subscription.isAutoRenew,
            lastPaymentAt: subscription.lastPaymentAt,
            nextPaymentAt: subscription.nextPaymentAt,
            createdAt: subscription.createdAt,
        };
    }
    async subscribe(userId, plan, pin, ip) {
        await this.walletService.verifyPin(userId, pin, ip);
        const planInfo = this.planPricing[plan];
        if (!planInfo) {
            throw new common_1.BadRequestException({
                code: ErrorCodes.VALIDATION_ERROR,
                message: 'Invalid subscription plan',
            });
        }
        const walletTxSerial = await this.walletTxSerialService.getNext();
        const now = new Date();
        const periodEnd = new Date(now);
        periodEnd.setDate(periodEnd.getDate() + planInfo.durationDays);
        const subscription = await this.prisma.$transaction(async (tx) => {
            const existingPending = await tx.subscription.findFirst({
                where: { userId, status: client_1.SubscriptionStatus.PENDING },
                select: { id: true },
            });
            if (existingPending) {
                throw new common_1.ConflictException({
                    code: ErrorCodes.SUBSCRIPTION_ALREADY_ACTIVE,
                    message: 'A subscription payment is already pending',
                });
            }
            const existingActive = await tx.subscription.findFirst({
                where: {
                    userId,
                    status: {
                        in: [
                            client_1.SubscriptionStatus.ACTIVE,
                            client_1.SubscriptionStatus.CANCELLED,
                            client_1.SubscriptionStatus.SUSPENDED,
                        ],
                    },
                    currentPeriodEnd: { gt: new Date() },
                },
            });
            if (existingActive) {
                throw new common_1.ConflictException({
                    code: ErrorCodes.SUBSCRIPTION_ALREADY_ACTIVE,
                    message: 'You already have an active subscription period — use renew instead',
                });
            }
            const walletRows = await tx.$queryRaw `
        SELECT id, "userId", "totalBalance", "availableBalance", version FROM wallets WHERE "userId" = ${userId} FOR UPDATE`;
            const wallet = walletRows[0];
            if (!wallet) {
                throw new common_1.BadRequestException({
                    code: ErrorCodes.INSUFFICIENT_BALANCE,
                    message: 'Wallet not found',
                });
            }
            if (wallet.availableBalance < planInfo.price) {
                throw new common_1.BadRequestException({
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
                throw new common_1.BadRequestException({
                    code: ErrorCodes.INSUFFICIENT_BALANCE,
                    message: 'Concurrent wallet update — please retry',
                });
            }
            const balanceBefore = wallet.totalBalance;
            const balanceAfter = wallet.totalBalance - planInfo.price;
            const walletTxId = (0, id_generator_util_1.generateWalletTxId)(walletTxSerial);
            await tx.walletTransaction.create({
                data: {
                    txId: walletTxId,
                    walletId: wallet.id,
                    type: client_1.WalletTransactionType.SUBSCRIPTION_PAYMENT,
                    status: client_1.WalletTransactionStatus.SUCCESS,
                    amount: planInfo.price,
                    balanceBefore,
                    balanceAfter,
                    description: `${planInfo.label} subscription payment`,
                },
            });
            const feeSavingsLimitIdr = this.configService.get('app.feeSavingsLimit') ?? 5000000;
            const feeSavingsLimitSen = (0, currency_util_1.toSen)(feeSavingsLimitIdr);
            const sub = await tx.subscription.create({
                data: {
                    userId,
                    plan,
                    status: client_1.SubscriptionStatus.ACTIVE,
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
        }, { isolationLevel: client_1.Prisma.TransactionIsolationLevel.Serializable });
        this.logger.log(`User ${userId} subscribed to ${plan}, charged ${planInfo.price} sen`);
        this.auditLogService.logUserAction({
            userId,
            action: client_1.UserAuditAction.SUBSCRIPTION_STARTED,
            entityType: 'Subscription',
            entityId: subscription.id,
            description: `Subscribed to ${plan} plan`,
        });
        return subscription;
    }
    async cancel(userId) {
        const subscription = await this.prisma.subscription.findFirst({
            where: { userId, status: client_1.SubscriptionStatus.ACTIVE },
        });
        if (!subscription) {
            throw new common_1.NotFoundException({
                code: ErrorCodes.NO_ACTIVE_SUBSCRIPTION,
                message: 'No active subscription found',
            });
        }
        const updated = await this.prisma.$transaction(async (tx) => {
            const result = await tx.subscription.updateMany({
                where: { id: subscription.id, status: client_1.SubscriptionStatus.ACTIVE },
                data: {
                    status: client_1.SubscriptionStatus.CANCELLED,
                    isAutoRenew: false,
                    cancelledAt: new Date(),
                    cancelReason: 'User requested cancellation',
                },
            });
            if (result.count === 0) {
                throw new common_1.ConflictException({
                    code: ErrorCodes.OPTIMISTIC_LOCK_CONFLICT,
                    message: 'Subscription changed concurrently — please retry',
                });
            }
            const sub = await tx.subscription.findUniqueOrThrow({ where: { id: subscription.id } });
            return sub;
        }, { isolationLevel: client_1.Prisma.TransactionIsolationLevel.Serializable });
        this.auditLogService.logUserAction({
            userId,
            action: client_1.UserAuditAction.SUBSCRIPTION_CANCELLED,
            entityType: 'Subscription',
            entityId: updated.id,
            description: `Cancelled ${updated.plan} subscription`,
        });
        return updated;
    }
    async getHistory(userId, page, limit) {
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
            price: (0, currency_util_1.toIdr)(sub.price),
            currentPeriodStart: sub.currentPeriodStart,
            currentPeriodEnd: sub.currentPeriodEnd,
            isAutoRenew: sub.isAutoRenew,
            cancelledAt: sub.cancelledAt,
            lastPaymentAt: sub.lastPaymentAt,
            feeSavingsUsed: (0, currency_util_1.toIdr)(sub.feeSavingsUsed),
            feeSavingsLimit: (0, currency_util_1.toIdr)(sub.feeSavingsLimit),
            createdAt: sub.createdAt,
        }));
        return (0, pagination_dto_1.createPaginatedResponse)(serialized, total, safePage, safeLimit);
    }
    async getBenefits(userId) {
        const subscription = await this.prisma.subscription.findFirst({
            where: {
                userId,
                status: {
                    in: [
                        client_1.SubscriptionStatus.ACTIVE,
                        client_1.SubscriptionStatus.CANCELLED,
                        client_1.SubscriptionStatus.SUSPENDED,
                    ],
                },
                currentPeriodEnd: { gt: new Date() },
            },
            orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        });
        if (!subscription) {
            throw new common_1.NotFoundException({
                code: ErrorCodes.NO_ACTIVE_SUBSCRIPTION,
                message: 'No active subscription found',
            });
        }
        const planInfo = this.planPricing[subscription.plan];
        const feeSavingsRemaining = subscription.feeSavingsLimit > subscription.feeSavingsUsed
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
            feeSavingsUsed: (0, currency_util_1.toIdr)(subscription.feeSavingsUsed),
            feeSavingsLimit: (0, currency_util_1.toIdr)(subscription.feeSavingsLimit),
            feeSavingsRemaining: (0, currency_util_1.toIdr)(feeSavingsRemaining),
            currentPeriodEnd: subscription.currentPeriodEnd,
        };
    }
    async renew(userId, pin, ip) {
        await this.walletService.verifyPin(userId, pin, ip);
        const subscription = await this.prisma.subscription.findFirst({
            where: {
                userId,
                status: {
                    in: [
                        client_1.SubscriptionStatus.ACTIVE,
                        client_1.SubscriptionStatus.CANCELLED,
                        client_1.SubscriptionStatus.SUSPENDED,
                    ],
                },
                currentPeriodEnd: { gt: new Date() },
            },
            orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        });
        if (!subscription) {
            throw new common_1.NotFoundException({
                code: ErrorCodes.NO_ACTIVE_SUBSCRIPTION,
                message: 'No active subscription found',
            });
        }
        if (subscription.status === client_1.SubscriptionStatus.CANCELLED &&
            subscription.cancelReason === 'Force cancelled by admin') {
            throw new common_1.ConflictException({
                code: ErrorCodes.INVALID_STATUS,
                message: 'This subscription was cancelled by an administrator',
            });
        }
        const planInfo = this.planPricing[subscription.plan];
        const walletTxSerial = await this.walletTxSerialService.getNext();
        const renewBase = subscription.status === client_1.SubscriptionStatus.SUSPENDED
            ? new Date()
            : new Date(subscription.currentPeriodEnd ?? new Date());
        const newPeriodEnd = new Date(renewBase);
        newPeriodEnd.setDate(newPeriodEnd.getDate() + planInfo.durationDays);
        const now = new Date();
        const updated = await this.prisma.$transaction(async (tx) => {
            const walletRows = await tx.$queryRaw `
        SELECT id, "userId", "totalBalance", "availableBalance", version FROM wallets WHERE "userId" = ${userId} FOR UPDATE`;
            const wallet = walletRows[0];
            if (!wallet) {
                throw new common_1.BadRequestException({
                    code: ErrorCodes.INSUFFICIENT_BALANCE,
                    message: 'Wallet not found',
                });
            }
            if (wallet.availableBalance < planInfo.price) {
                throw new common_1.BadRequestException({
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
                throw new common_1.BadRequestException({
                    code: ErrorCodes.OPTIMISTIC_LOCK_CONFLICT,
                    message: 'Concurrent wallet update — please retry',
                });
            }
            const walletTxId = (0, id_generator_util_1.generateWalletTxId)(walletTxSerial);
            const renewBalanceBefore = wallet.totalBalance;
            const renewBalanceAfter = wallet.totalBalance - planInfo.price;
            await tx.walletTransaction.create({
                data: {
                    txId: walletTxId,
                    walletId: wallet.id,
                    type: client_1.WalletTransactionType.SUBSCRIPTION_PAYMENT,
                    status: client_1.WalletTransactionStatus.SUCCESS,
                    amount: planInfo.price,
                    balanceBefore: renewBalanceBefore,
                    balanceAfter: renewBalanceAfter,
                    description: `${planInfo.label} subscription renewal`,
                },
            });
            const feeSavingsLimitIdr = this.configService.get('app.feeSavingsLimit') ?? 5000000;
            const feeSavingsLimitSen = (0, currency_util_1.toSen)(feeSavingsLimitIdr);
            const subUpdated = await tx.subscription.updateMany({
                where: {
                    id: subscription.id,
                    status: {
                        in: [
                            client_1.SubscriptionStatus.ACTIVE,
                            client_1.SubscriptionStatus.CANCELLED,
                            client_1.SubscriptionStatus.SUSPENDED,
                        ],
                    },
                    currentPeriodEnd: subscription.currentPeriodEnd,
                },
                data: {
                    status: client_1.SubscriptionStatus.ACTIVE,
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
                throw new common_1.ConflictException({
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
        }, { isolationLevel: client_1.Prisma.TransactionIsolationLevel.Serializable });
        this.logger.log(`User ${userId} renewed ${subscription.plan}, charged ${planInfo.price} sen`);
        this.auditLogService.logUserAction({
            userId,
            action: client_1.UserAuditAction.SUBSCRIPTION_STARTED,
            entityType: 'Subscription',
            entityId: subscription.id,
            description: `Renewed ${subscription.plan} subscription (previous feeSavingsUsed: ${subscription.feeSavingsUsed ?? 0} sen)`,
        });
        return updated;
    }
    async getPlans() {
        const cacheKey = `${redis_keys_1.SUBSCRIPTION_PLANS_CACHE}:plans`;
        const cached = await this.redis.get(cacheKey);
        if (cached) {
            try {
                return JSON.parse(cached);
            }
            catch (_) {
                await this.redis.del(cacheKey);
            }
        }
        const feeSavingsLimit = this.configService.get('app.feeSavingsLimit') ?? 5000000;
        const plans = Object.entries(this.planPricing).map(([plan, info]) => ({
            plan,
            label: info.label,
            price: (0, currency_util_1.toIdr)(info.price),
            durationDays: info.durationDays,
            feeSavingsLimit,
        }));
        await this.redis.setex(cacheKey, SUBSCRIPTION_PLANS_TTL, JSON.stringify(plans));
        return plans;
    }
};
exports.SubscriptionsService = SubscriptionsService;
exports.SubscriptionsService = SubscriptionsService = SubscriptionsService_1 = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [prisma_service_1.PrismaService,
        wallet_tx_serial_service_1.WalletTxSerialService,
        wallet_service_1.WalletService,
        config_1.ConfigService,
        redis_service_1.RedisService,
        audit_log_service_1.AuditLogService])
], SubscriptionsService);
