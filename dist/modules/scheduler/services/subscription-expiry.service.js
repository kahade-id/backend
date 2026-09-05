"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
var SubscriptionExpiryService_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.SubscriptionExpiryService = void 0;
const common_1 = require("@nestjs/common");
const config_1 = require("@nestjs/config");
const schedule_1 = require("@nestjs/schedule");
const crypto_1 = require("crypto");
const client_1 = require("@prisma/client");
const notification_category_map_1 = require("../../notifications/notification-category.map");
const prisma_service_1 = require("../../../prisma/prisma.service");
const redis_service_1 = require("../../../redis/redis.service");
const cron_jitter_util_1 = require("../../../common/utils/cron-jitter.util");
const wallet_tx_serial_service_1 = require("../../../common/services/wallet-tx-serial.service");
const id_generator_util_1 = require("../../../common/utils/id-generator.util");
const currency_util_1 = require("../../../common/utils/currency.util");
const app_constants_1 = require("../../../common/constants/app.constants");
const redis_health_util_1 = require("../../../common/utils/redis-health.util");
const PLAN_METADATA = {
    MONTHLY: { durationDays: 30, label: 'Kahade Plus Monthly' },
    ANNUAL: { durationDays: 366, label: 'Kahade Plus Annual' },
};
const GRACE_PERIOD_DAYS = 3;
let SubscriptionExpiryService = SubscriptionExpiryService_1 = class SubscriptionExpiryService {
    constructor(prisma, redis, walletTxSerialService, configService) {
        this.prisma = prisma;
        this.redis = redis;
        this.walletTxSerialService = walletTxSerialService;
        this.configService = configService;
        this.logger = new common_1.Logger(SubscriptionExpiryService_1.name);
        const monthlyPriceSen = this.configService.get('app.subscriptionMonthlyPriceSen')
            ?? app_constants_1.SUBSCRIPTION_MONTHLY_PRICE * 100;
        const annualPriceSen = this.configService.get('app.subscriptionAnnualPriceSen')
            ?? app_constants_1.SUBSCRIPTION_ANNUAL_PRICE * 100;
        this.planPricing = {
            MONTHLY: { price: BigInt(monthlyPriceSen), ...PLAN_METADATA.MONTHLY },
            ANNUAL: { price: BigInt(annualPriceSen), ...PLAN_METADATA.ANNUAL },
        };
    }
    async handleExpiredSubscriptions() {
        await (0, cron_jitter_util_1.cronJitter)(15_000);
        if (!(await (0, redis_health_util_1.ensureRedisAvailable)(this.redis, 'subscription-expiry')))
            return;
        const lockKey = 'cron_lock:subscription_expiry';
        const lockToken = (0, crypto_1.randomUUID)();
        const acquired = await this.redis.setNx(lockKey, lockToken, 600);
        if (!acquired)
            return;
        const now = new Date();
        try {
            await this.sendExpiryReminders(now);
            await this.processExpiredSubscriptions(now);
            await this.processGracePeriodExpired(now);
        }
        catch (error) {
            this.logger.error('SubscriptionExpiry FAILED', error);
        }
        finally {
            await this.redis.releaseLock(lockKey, lockToken).catch((err) => this.logger.warn(`silent-catch: ${err instanceof Error ? err.message : String(err)}`));
        }
    }
    async tryAutoRenew(sub) {
        const planInfo = this.planPricing[sub.plan];
        if (!planInfo)
            return 'INSUFFICIENT_BALANCE';
        const MAX_OCC_RETRIES = 3;
        for (let attempt = 1; attempt <= MAX_OCC_RETRIES; attempt++) {
            try {
                const walletTxSerial = await this.walletTxSerialService.getNext();
                const now = new Date();
                const renewBase = sub.status === client_1.SubscriptionStatus.ACTIVE
                    && sub.currentPeriodEnd
                    && sub.currentPeriodEnd > now
                    ? new Date(sub.currentPeriodEnd)
                    : now;
                const newPeriodEnd = new Date(renewBase);
                newPeriodEnd.setDate(newPeriodEnd.getDate() + planInfo.durationDays);
                const feeSavingsLimitIdr = this.configService.get('app.feeSavingsLimit') ?? 5000000;
                const feeSavingsLimitSen = (0, currency_util_1.toSen)(feeSavingsLimitIdr);
                await this.prisma.$transaction(async (tx) => {
                    const wallet = await tx.wallet.findUnique({ where: { userId: sub.userId } });
                    if (!wallet || wallet.availableBalance < planInfo.price) {
                        throw new Error('INSUFFICIENT_BALANCE');
                    }
                    const walletUpdated = await tx.wallet.updateMany({
                        where: { id: wallet.id, version: wallet.version, availableBalance: { gte: planInfo.price } },
                        data: {
                            availableBalance: { decrement: planInfo.price },
                            totalBalance: { decrement: planInfo.price },
                            version: { increment: 1 },
                        },
                    });
                    if (walletUpdated.count === 0) {
                        throw new Error('WALLET_OCC_CONFLICT');
                    }
                    const walletTxId = (0, id_generator_util_1.generateWalletTxId)(walletTxSerial);
                    await tx.walletTransaction.create({
                        data: {
                            txId: walletTxId,
                            walletId: wallet.id,
                            type: client_1.WalletTransactionType.SUBSCRIPTION_PAYMENT,
                            status: client_1.WalletTransactionStatus.SUCCESS,
                            amount: planInfo.price,
                            balanceBefore: wallet.totalBalance,
                            balanceAfter: wallet.totalBalance - planInfo.price,
                            description: `${planInfo.label} auto-renewal`,
                        },
                    });
                    const subUpdated = await tx.subscription.updateMany({
                        where: {
                            id: sub.id,
                            status: { in: [client_1.SubscriptionStatus.ACTIVE, client_1.SubscriptionStatus.SUSPENDED] },
                            currentPeriodEnd: sub.currentPeriodEnd,
                        },
                        data: {
                            status: client_1.SubscriptionStatus.ACTIVE,
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
                        throw new Error('SUBSCRIPTION_ALREADY_RENEWED');
                    }
                    await tx.user.update({
                        where: { id: sub.user.id },
                        data: {
                            isKahadePlus: true,
                            subscriptionExpiresAt: newPeriodEnd,
                        },
                    });
                }, { isolationLevel: client_1.Prisma.TransactionIsolationLevel.Serializable });
                try {
                    await this.prisma.notification.create({
                        data: {
                            notifId: (0, id_generator_util_1.generateNotifId)(),
                            userId: sub.userId,
                            type: client_1.NotificationType.SUBSCRIPTION_RENEWED,
                            category: (0, notification_category_map_1.getCategoryForType)(client_1.NotificationType.SUBSCRIPTION_RENEWED),
                            title: 'Kahade Plus Auto-Renewed',
                            body: `Your ${planInfo.label} subscription has been auto-renewed successfully. Enjoy your continued Plus benefits!`,
                            isRead: false,
                        },
                    });
                    this.prisma.emitNotificationCreated({ userId: sub.userId, title: 'Kahade Plus Auto-Renewed', body: `Your ${planInfo.label} subscription has been auto-renewed.`, data: { type: 'SUBSCRIPTION_RENEWED' } });
                }
                catch (notifErr) {
                    this.logger.warn(`Auto-renewal succeeded for subscription ${sub.id} but notification failed: ${notifErr instanceof Error ? notifErr.message : String(notifErr)}`);
                }
                return 'SUCCESS';
            }
            catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                if (message === 'INSUFFICIENT_BALANCE') {
                    return 'INSUFFICIENT_BALANCE';
                }
                if (message === 'SUBSCRIPTION_ALREADY_RENEWED') {
                    this.logger.log(`Subscription ${sub.id} was already renewed concurrently — skipping.`);
                    return 'SUCCESS';
                }
                if (message === 'WALLET_OCC_CONFLICT' && attempt < MAX_OCC_RETRIES) {
                    this.logger.warn(`Auto-renewal OCC conflict for subscription ${sub.id} — retry ${attempt}/${MAX_OCC_RETRIES}`);
                    await new Promise(resolve => setTimeout(resolve, 50 * attempt));
                    continue;
                }
                return 'TRANSIENT_ERROR';
            }
        }
        return 'TRANSIENT_ERROR';
    }
    async processExpiredSubscriptions(now) {
        const expiredSubs = await this.prisma.subscription.findMany({
            where: {
                status: { in: ['ACTIVE', 'CANCELLED'] },
                currentPeriodEnd: { lt: now },
            },
            include: { user: { select: { id: true } } },
            take: 500,
        });
        if (expiredSubs.length === 0)
            return;
        this.logger.log(`Found ${expiredSubs.length} expired subscription(s) — processing.`);
        for (const sub of expiredSubs) {
            try {
                if (sub.isAutoRenew && sub.status === client_1.SubscriptionStatus.ACTIVE) {
                    const renewResult = await this.tryAutoRenew(sub);
                    if (renewResult === 'SUCCESS') {
                        this.logger.log(`Auto-renewed subscription ${sub.id} for user ${sub.userId}`);
                        continue;
                    }
                    if (renewResult === 'TRANSIENT_ERROR') {
                        this.logger.warn(`Auto-renewal transient error for subscription ${sub.id} — will retry next run.`);
                        continue;
                    }
                    this.logger.warn(`Auto-renewal failed for subscription ${sub.id} (insufficient balance) — entering grace period.`);
                }
                const graceBase = sub.currentPeriodEnd ? new Date(sub.currentPeriodEnd) : now;
                const graceEnd = new Date(graceBase.getTime() + GRACE_PERIOD_DAYS * 86_400_000);
                const wasAutoRenewEnabled = sub.isAutoRenew;
                const suspended = await this.prisma.$transaction(async (tx) => {
                    const updated = await tx.subscription.updateMany({
                        where: {
                            id: sub.id,
                            status: { in: [client_1.SubscriptionStatus.ACTIVE, client_1.SubscriptionStatus.CANCELLED] },
                            currentPeriodEnd: { lt: now },
                        },
                        data: {
                            status: client_1.SubscriptionStatus.SUSPENDED,
                            isAutoRenew: wasAutoRenewEnabled,
                            currentPeriodEnd: graceEnd,
                        },
                    });
                    if (updated.count === 0)
                        return false;
                    await tx.user.update({
                        where: { id: sub.user.id },
                        data: {
                            subscriptionExpiresAt: graceEnd,
                        },
                    });
                    const wasAutoRenewFailure = wasAutoRenewEnabled && sub.status === client_1.SubscriptionStatus.ACTIVE;
                    await tx.notification.create({
                        data: {
                            notifId: (0, id_generator_util_1.generateNotifId)(),
                            userId: sub.userId,
                            type: client_1.NotificationType.SUBSCRIPTION_EXPIRY_REMINDER,
                            category: (0, notification_category_map_1.getCategoryForType)(client_1.NotificationType.SUBSCRIPTION_EXPIRY_REMINDER),
                            title: wasAutoRenewFailure ? 'Auto-Renewal Failed' : 'Kahade Plus Grace Period',
                            body: wasAutoRenewFailure
                                ? `Your Kahade Plus auto-renewal failed due to insufficient wallet balance. You have ${GRACE_PERIOD_DAYS} days to renew manually before losing your benefits.`
                                : `Your Kahade Plus subscription period has ended. You have ${GRACE_PERIOD_DAYS} days to renew before your benefits are revoked.`,
                            isRead: false,
                        },
                    });
                    return true;
                });
                if (suspended) {
                    this.logger.log(`Subscription ${sub.id} entered ${GRACE_PERIOD_DAYS}-day grace period (SUSPENDED) for user ${sub.userId}`);
                    this.prisma.emitNotificationCreated({ userId: sub.userId, title: 'Kahade Plus Grace Period', body: `You have ${GRACE_PERIOD_DAYS} days to renew your subscription.`, data: { type: 'SUBSCRIPTION_EXPIRY_REMINDER' } });
                }
                else {
                    this.logger.log(`Subscription ${sub.id} already modified — skipping grace period.`);
                }
            }
            catch (err) {
                this.logger.error(`Failed to process expired subscription ${sub.id}: ${err instanceof Error ? err.message : String(err)}`);
            }
        }
    }
    async processGracePeriodExpired(now) {
        const suspendedSubs = await this.prisma.subscription.findMany({
            where: {
                status: client_1.SubscriptionStatus.SUSPENDED,
            },
            include: { user: { select: { id: true } } },
            take: 500,
        });
        if (suspendedSubs.length === 0)
            return;
        for (const sub of suspendedSubs) {
            try {
                if (sub.isAutoRenew) {
                    const renewResult = await this.tryAutoRenew(sub);
                    if (renewResult === 'SUCCESS') {
                        this.logger.log(`Auto-renewed SUSPENDED subscription ${sub.id} for user ${sub.userId} during grace period`);
                        continue;
                    }
                    if (renewResult === 'TRANSIENT_ERROR') {
                        this.logger.warn(`Auto-renewal transient error for SUSPENDED subscription ${sub.id} — will retry next run.`);
                        continue;
                    }
                    this.logger.warn(`Auto-renewal still failing for SUSPENDED subscription ${sub.id} (insufficient balance).`);
                }
                if (sub.currentPeriodEnd && sub.currentPeriodEnd >= now) {
                    continue;
                }
                const expired = await this.prisma.$transaction(async (tx) => {
                    const updated = await tx.subscription.updateMany({
                        where: {
                            id: sub.id,
                            status: client_1.SubscriptionStatus.SUSPENDED,
                            currentPeriodEnd: { lt: now },
                        },
                        data: {
                            status: client_1.SubscriptionStatus.EXPIRED,
                            isAutoRenew: false,
                        },
                    });
                    if (updated.count === 0)
                        return false;
                    await tx.user.update({
                        where: { id: sub.user.id },
                        data: {
                            isKahadePlus: false,
                            subscriptionExpiresAt: null,
                        },
                    });
                    await tx.notification.create({
                        data: {
                            notifId: (0, id_generator_util_1.generateNotifId)(),
                            userId: sub.userId,
                            type: client_1.NotificationType.SUBSCRIPTION_EXPIRED,
                            category: (0, notification_category_map_1.getCategoryForType)(client_1.NotificationType.SUBSCRIPTION_EXPIRED),
                            title: 'Kahade Plus Subscription Expired',
                            body: 'Your Kahade Plus grace period has ended and your subscription is now expired. Service fees will revert to the standard rate. Subscribe again to enjoy lower fees.',
                            isRead: false,
                        },
                    });
                    return true;
                });
                if (expired) {
                    this.logger.log(`Fully expired subscription ${sub.id} for user ${sub.userId}`);
                    this.prisma.emitNotificationCreated({ userId: sub.userId, title: 'Kahade Plus Subscription Expired', body: 'Your Kahade Plus subscription has expired.', data: { type: 'SUBSCRIPTION_EXPIRED' } });
                }
            }
            catch (err) {
                this.logger.error(`Failed to expire suspended subscription ${sub.id}: ${err instanceof Error ? err.message : String(err)}`);
            }
        }
    }
    async sendExpiryReminders(now) {
        const REMINDER_WINDOWS = [
            { days: 3, label: '3 days' },
            { days: 1, label: '1 day' },
        ];
        const reminderRedisPrefix = 'sub_expiry_reminder:';
        for (const window of REMINDER_WINDOWS) {
            const windowStart = new Date(now.getTime() + (window.days - 1) * 86_400_000);
            const windowEnd = new Date(now.getTime() + window.days * 86_400_000);
            const subs = await this.prisma.subscription.findMany({
                where: {
                    status: { in: [client_1.SubscriptionStatus.ACTIVE, client_1.SubscriptionStatus.CANCELLED] },
                    isAutoRenew: false,
                    currentPeriodEnd: { gte: windowStart, lt: windowEnd },
                },
                select: { id: true, userId: true },
                take: 500,
            });
            for (const sub of subs) {
                const reminderKey = `${reminderRedisPrefix}${sub.id}:${window.days}d`;
                const alreadySent = await this.redis.get(reminderKey);
                if (alreadySent)
                    continue;
                try {
                    await this.prisma.notification.create({
                        data: {
                            notifId: (0, id_generator_util_1.generateNotifId)(),
                            userId: sub.userId,
                            type: client_1.NotificationType.SUBSCRIPTION_EXPIRY_REMINDER,
                            category: (0, notification_category_map_1.getCategoryForType)(client_1.NotificationType.SUBSCRIPTION_EXPIRY_REMINDER),
                            title: 'Plus Subscription Expiring Soon',
                            body: `Your Kahade Plus subscription will expire in ${window.label}. Renew now to keep your Plus benefits active.`,
                            isRead: false,
                        },
                    });
                    await this.redis.setex(reminderKey, window.days * 86_400, '1');
                    this.logger.log(`Sent ${window.days}-day expiry reminder for subscription ${sub.id} (user ${sub.userId})`);
                }
                catch (err) {
                    this.logger.error(`Failed to send expiry reminder for subscription ${sub.id}: ${err instanceof Error ? err.message : String(err)}`);
                }
            }
        }
    }
};
exports.SubscriptionExpiryService = SubscriptionExpiryService;
__decorate([
    (0, schedule_1.Cron)('*/15 * * * *', { name: 'subscription-expiry' }),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", Promise)
], SubscriptionExpiryService.prototype, "handleExpiredSubscriptions", null);
exports.SubscriptionExpiryService = SubscriptionExpiryService = SubscriptionExpiryService_1 = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [prisma_service_1.PrismaService,
        redis_service_1.RedisService,
        wallet_tx_serial_service_1.WalletTxSerialService,
        config_1.ConfigService])
], SubscriptionExpiryService);
