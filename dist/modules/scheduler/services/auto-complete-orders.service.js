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
var AutoCompleteDeliveredOrdersService_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.AutoCompleteDeliveredOrdersService = void 0;
const common_1 = require("@nestjs/common");
const schedule_1 = require("@nestjs/schedule");
const client_1 = require("@prisma/client");
const crypto_1 = require("crypto");
const notification_category_map_1 = require("../../notifications/notification-category.map");
const prisma_service_1 = require("../../../prisma/prisma.service");
const redis_service_1 = require("../../../redis/redis.service");
const wallet_tx_serial_service_1 = require("../../../common/services/wallet-tx-serial.service");
const referral_service_1 = require("../../referral/referral.service");
const membership_rank_service_1 = require("../../orders/membership-rank.service");
const fee_calculator_service_1 = require("../../orders/fee-calculator.service");
const id_generator_util_1 = require("../../../common/utils/id-generator.util");
const redis_health_util_1 = require("../../../common/utils/redis-health.util");
const currency_util_1 = require("../../../common/utils/currency.util");
const app_constants_1 = require("../../../common/constants/app.constants");
const DEFER_PREFIX = 'DEFER_AUTO_COMPLETE:';
let AutoCompleteDeliveredOrdersService = AutoCompleteDeliveredOrdersService_1 = class AutoCompleteDeliveredOrdersService {
    constructor(prisma, redis, walletTxSerialService, referralService, membershipRankService, feeCalculator) {
        this.prisma = prisma;
        this.redis = redis;
        this.walletTxSerialService = walletTxSerialService;
        this.referralService = referralService;
        this.membershipRankService = membershipRankService;
        this.feeCalculator = feeCalculator;
        this.logger = new common_1.Logger(AutoCompleteDeliveredOrdersService_1.name);
    }
    runRealtimeBestEffort(task, label) {
        try {
            task();
        }
        catch (error) {
            this.logger.warn(`${label} realtime side effect failed: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    async autoComplete() {
        if (!(await (0, redis_health_util_1.ensureRedisAvailable)(this.redis, 'auto-complete-orders')))
            return;
        const lockKey = 'cron_lock:auto_complete_orders';
        const lockToken = (0, crypto_1.randomUUID)();
        const acquired = await this.redis.setNx(lockKey, lockToken, 3600);
        if (!acquired)
            return;
        let lockLost = false;
        const lockRenewalInterval = setInterval(async () => {
            const renewed = await this.redis.renewLock(lockKey, lockToken, 3600);
            if (!renewed) {
                lockLost = true;
                clearInterval(lockRenewalInterval);
                this.logger.warn('Auto-complete lock ownership was lost; stopping after the current order.');
            }
        }, 60_000);
        const now = new Date();
        try {
            let hasMore = true;
            while (hasMore) {
                if (lockLost || await this.redis.get(lockKey) !== lockToken) {
                    this.logger.warn('Auto-complete lock ownership was lost; aborting before the next batch.');
                    return;
                }
                const orders = await this.prisma.order.findMany({
                    where: {
                        status: client_1.OrderStatus.IN_DELIVERY,
                        deliveryDeadlineAt: { lt: now },
                        dispute: { is: null },
                        deliveryProofs: {
                            none: {
                                status: 'SUBMITTED',
                                reviewWindowEnd: { gt: now },
                            },
                        },
                    },
                    take: 50,
                });
                if (orders.length === 0) {
                    hasMore = false;
                    break;
                }
                hasMore = orders.length === 50;
                this.logger.log(`Found ${orders.length} orders past delivery deadline — auto-completing.`);
                for (const order of orders) {
                    if (lockLost)
                        break;
                    try {
                        const graceKey = `auto_complete_grace:${order.id}`;
                        const alreadyExtended = await this.redis.get(graceKey);
                        let releaseTxSerial = null;
                        let receiveTxSerial = null;
                        let feeTxSerial = null;
                        const outcome = await this.withSerializableRetry(() => this.prisma.$transaction(async (tx) => {
                            const freshOrder = await tx.order.findUnique({
                                where: { id: order.id },
                                select: { status: true, deliveryDeadlineAt: true, dispute: { select: { id: true } } },
                            });
                            if (!freshOrder || freshOrder.status !== client_1.OrderStatus.IN_DELIVERY || !freshOrder.deliveryDeadlineAt || freshOrder.deliveryDeadlineAt >= now || freshOrder.dispute) {
                                return;
                            }
                            const acceptedProof = await tx.deliveryProof.findFirst({
                                where: { orderId: order.id, status: 'ACCEPTED' },
                                select: { id: true },
                            });
                            if (!acceptedProof) {
                                const submittedProof = await tx.deliveryProof.findFirst({
                                    where: { orderId: order.id, status: 'SUBMITTED', reviewWindowEnd: { gt: now } },
                                    select: { id: true, status: true },
                                });
                                if (!submittedProof) {
                                    const rejectedProof = await tx.deliveryProof.findFirst({
                                        where: { orderId: order.id, status: { in: ['REJECTED'] } },
                                        select: { id: true },
                                    });
                                    if (!rejectedProof) {
                                        this.logger.warn(`Skipping auto-complete for order ${order.orderId}: no delivery proof at all`);
                                        return;
                                    }
                                }
                                if (!submittedProof) {
                                    this.logger.log(`Order ${order.orderId} has only rejected/expired proofs and no accepted proof — seller must resubmit. Skipping.`);
                                    return;
                                }
                                if (alreadyExtended) {
                                    this.logger.log(`Grace period already granted for order ${order.orderId} — now auto-completing with SUBMITTED proof`);
                                }
                                else {
                                    const graceEnd = new Date(now.getTime() + app_constants_1.AUTO_COMPLETE_GRACE_PERIOD_HOURS * 60 * 60 * 1000);
                                    const extensionGranted = await tx.order.updateMany({
                                        where: { id: order.id, status: client_1.OrderStatus.IN_DELIVERY },
                                        data: { deliveryDeadlineAt: graceEnd },
                                    });
                                    if (extensionGranted.count === 0)
                                        return;
                                    await tx.notification.create({
                                        data: {
                                            notifId: (0, id_generator_util_1.generateNotifId)(),
                                            userId: order.buyerId,
                                            type: client_1.NotificationType.ORDER_DELIVERED,
                                            category: (0, notification_category_map_1.getCategoryForType)(client_1.NotificationType.ORDER_DELIVERED),
                                            title: 'Segera Review Bukti Pengiriman',
                                            body: `Deadline order "${order.title}" sudah lewat tapi Anda belum review bukti pengiriman. Anda punya waktu ${app_constants_1.AUTO_COMPLETE_GRACE_PERIOD_HOURS} jam lagi sebelum order otomatis diselesaikan.`,
                                            isRead: false,
                                        },
                                    });
                                    return { gracePeriodExtended: true };
                                }
                            }
                            const updated = await tx.order.updateMany({
                                where: { id: order.id, status: client_1.OrderStatus.IN_DELIVERY },
                                data: { status: client_1.OrderStatus.COMPLETED, completedAt: new Date() },
                            });
                            if (updated.count === 0)
                                return;
                            const buyerWalletLookup = await tx.wallet.findUnique({ where: { userId: order.buyerId }, select: { id: true } });
                            const sellerWalletLookup = await tx.wallet.findUnique({ where: { userId: order.sellerId }, select: { id: true } });
                            if (!buyerWalletLookup)
                                throw new Error(`Buyer wallet not found: ${order.buyerId}`);
                            if (!sellerWalletLookup)
                                throw new Error(`Seller wallet not found: ${order.sellerId}`);
                            const [firstId, secondId] = [buyerWalletLookup.id, sellerWalletLookup.id].sort();
                            await tx.$queryRaw `SELECT id FROM wallets WHERE id IN (${firstId}, ${secondId}) ORDER BY id FOR UPDATE`;
                            const buyerWallet = await tx.wallet.findUnique({ where: { id: buyerWalletLookup.id } });
                            const sellerWallet = await tx.wallet.findUnique({ where: { id: sellerWalletLookup.id } });
                            if (!buyerWallet)
                                throw new Error(`Buyer wallet not found after lock: ${order.buyerId}`);
                            if (!sellerWallet)
                                throw new Error(`Seller wallet not found after lock: ${order.sellerId}`);
                            if (buyerWallet.isLocked) {
                                throw new Error(`${DEFER_PREFIX}buyer wallet is locked — escrow release deferred`);
                            }
                            if (sellerWallet.isLocked) {
                                throw new Error(`${DEFER_PREFIX}seller wallet is locked — escrow release deferred`);
                            }
                            const escrowLock = await tx.walletTransaction.findFirst({
                                where: { orderId: order.id, type: client_1.WalletTransactionType.ORDER_LOCK, status: client_1.WalletTransactionStatus.SUCCESS },
                                select: { amount: true },
                            });
                            if (!escrowLock || escrowLock.amount !== order.buyerPayAmount) {
                                throw new Error(`ESCROW_LOCK_MISSING: auto-complete blocked for order ${order.orderId}`);
                            }
                            if (releaseTxSerial === null)
                                releaseTxSerial = await this.walletTxSerialService.getNext();
                            if (receiveTxSerial === null)
                                receiveTxSerial = await this.walletTxSerialService.getNext();
                            if (order.feeAmount > BigInt(0) && feeTxSerial === null)
                                feeTxSerial = await this.walletTxSerialService.getNext();
                            const buyerUpdated = await tx.wallet.updateMany({
                                where: { id: buyerWallet.id, version: buyerWallet.version, escrowBalance: { gte: order.buyerPayAmount } },
                                data: {
                                    escrowBalance: { decrement: order.buyerPayAmount },
                                    totalBalance: { decrement: order.buyerPayAmount },
                                    version: { increment: 1 },
                                },
                            });
                            if (buyerUpdated.count === 0)
                                throw new Error(`OCC conflict on buyer wallet for order ${order.orderId}`);
                            const sellerUpdated = await tx.wallet.updateMany({
                                where: { id: sellerWallet.id, version: sellerWallet.version },
                                data: {
                                    availableBalance: { increment: order.sellerReceiveAmount },
                                    totalBalance: { increment: order.sellerReceiveAmount },
                                    version: { increment: 1 },
                                },
                            });
                            if (sellerUpdated.count === 0)
                                throw new Error(`OCC conflict on seller wallet for order ${order.orderId}`);
                            const buyerBalanceBefore = buyerWallet.escrowBalance;
                            const buyerBalanceAfter = buyerWallet.escrowBalance - order.buyerPayAmount;
                            const sellerBalanceBefore = sellerWallet.availableBalance;
                            const sellerBalanceAfter = sellerWallet.availableBalance + order.sellerReceiveAmount;
                            const releaseTxId = (0, id_generator_util_1.generateWalletTxId)(releaseTxSerial);
                            const receiveTxId = (0, id_generator_util_1.generateWalletTxId)(receiveTxSerial);
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
                                    description: `Auto-completed order ${order.orderId} — escrow released from buyer`,
                                },
                            });
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
                                    description: `Auto-completed order ${order.orderId} — funds received by seller`,
                                },
                            });
                            if (order.feeAmount > BigInt(0) && feeTxSerial !== null) {
                                const feeBalanceBefore = buyerWallet.totalBalance;
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
                                        description: `Platform fee for auto-completed order ${order.orderId}`,
                                    },
                                });
                            }
                            await this.referralService.createReferralRewardIfEligible(order.buyerId, order.feeAmount, order.id, tx);
                            await this.referralService.createReferralRewardIfEligible(order.sellerId, order.feeAmount, order.id, tx);
                            if (order.isKahadePlus && order.feeAmount > BigInt(0)) {
                                try {
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
                                catch (err) {
                                    if (err instanceof client_1.Prisma.PrismaClientKnownRequestError ||
                                        err instanceof client_1.Prisma.PrismaClientUnknownRequestError ||
                                        err instanceof client_1.Prisma.PrismaClientRustPanicError) {
                                        throw err;
                                    }
                                    this.logger.warn(`Failed to track fee savings for auto-completed order ${order.orderId}: ${err instanceof Error ? err.message : String(err)}`);
                                }
                            }
                            await tx.orderStatusHistory.create({
                                data: {
                                    orderId: order.id,
                                    fromStatus: client_1.OrderStatus.IN_DELIVERY,
                                    toStatus: client_1.OrderStatus.COMPLETED,
                                    changedBy: 'SYSTEM',
                                    changedByType: client_1.ActorType.SYSTEM,
                                    reason: 'Auto-completed: delivery deadline passed without dispute',
                                },
                            });
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
                            await this.membershipRankService.checkAndUpdateMembershipRank(tx, order.buyerId);
                            await this.membershipRankService.checkAndUpdateMembershipRank(tx, order.sellerId);
                            this.logger.log(`Auto-completed order ${order.orderId}`);
                            return { completed: true };
                        }, { isolationLevel: client_1.Prisma.TransactionIsolationLevel.Serializable }), `AUTO_COMPLETE:${order.orderId}`);
                        if (outcome && 'gracePeriodExtended' in outcome) {
                            await this.redis
                                .setex(graceKey, app_constants_1.AUTO_COMPLETE_GRACE_PERIOD_HOURS * 3600 + 3600, '1')
                                .catch((err) => this.logger.warn(`silent-catch: ${err instanceof Error ? err.message : String(err)}`));
                            this.runRealtimeBestEffort(() => this.prisma.emitNotificationCreated({
                                userId: order.buyerId,
                                title: 'Segera Review Bukti Pengiriman',
                                body: `Deadline order "${order.title}" diperpanjang ${app_constants_1.AUTO_COMPLETE_GRACE_PERIOD_HOURS} jam — segera review bukti pengiriman.`,
                                data: { type: 'ORDER_DELIVERED', orderId: order.orderId },
                            }), `AUTO_COMPLETE_GRACE_NOTIFICATION orderId=${order.orderId}`);
                            this.logger.log(`Extended deadline by ${app_constants_1.AUTO_COMPLETE_GRACE_PERIOD_HOURS}h for order ${order.orderId}: proof is SUBMITTED but not reviewed`);
                            continue;
                        }
                        if (!outcome?.completed)
                            continue;
                        const postAmountIdr = (0, currency_util_1.toIdr)(order.sellerReceiveAmount).toLocaleString('id-ID');
                        this.prisma.notification.create({
                            data: {
                                notifId: (0, id_generator_util_1.generateNotifId)(),
                                userId: order.buyerId,
                                type: client_1.NotificationType.ORDER_COMPLETED,
                                category: (0, notification_category_map_1.getCategoryForType)(client_1.NotificationType.ORDER_COMPLETED),
                                title: 'Order Auto-Completed',
                                body: `Order "${order.title}" has been auto-completed because the delivery deadline has passed.`,
                                isRead: false,
                            },
                        }).catch((notificationError) => this.logger.warn(`silent-catch: auto-complete buyer notification failed: ${notificationError instanceof Error ? notificationError.message : String(notificationError)}`));
                        this.prisma.notification.create({
                            data: {
                                notifId: (0, id_generator_util_1.generateNotifId)(),
                                userId: order.sellerId,
                                type: client_1.NotificationType.ORDER_PAYMENT_RECEIVED,
                                category: (0, notification_category_map_1.getCategoryForType)(client_1.NotificationType.ORDER_PAYMENT_RECEIVED),
                                title: 'Funds Received',
                                body: `Order "${order.title}" completed. Rp ${postAmountIdr} has been credited to your wallet.`,
                                isRead: false,
                            },
                        }).catch((notificationError) => this.logger.warn(`silent-catch: auto-complete seller notification failed: ${notificationError instanceof Error ? notificationError.message : String(notificationError)}`));
                        this.runRealtimeBestEffort(() => this.prisma.emitNotificationCreated({ userId: order.buyerId, title: 'Order Auto-Completed', body: `Order "${order.title}" has been auto-completed because the delivery deadline has passed.`, data: { type: 'ORDER_COMPLETED', orderId: order.orderId } }), `AUTO_COMPLETE_BUYER_NOTIFICATION orderId=${order.orderId}`);
                        this.runRealtimeBestEffort(() => this.prisma.emitNotificationCreated({ userId: order.sellerId, title: 'Funds Received', body: `Order "${order.title}" completed. Rp ${postAmountIdr} has been credited to your wallet.`, data: { type: 'WALLET_FUNDS_RELEASED', orderId: order.orderId } }), `AUTO_COMPLETE_SELLER_NOTIFICATION orderId=${order.orderId}`);
                        await this.redis.del(`auto_complete_failures:${order.id}`).catch((err) => this.logger.warn(`silent-catch: ${err instanceof Error ? err.message : String(err)}`));
                    }
                    catch (err) {
                        const errMsg = err instanceof Error ? err.message : String(err);
                        if (errMsg.startsWith(DEFER_PREFIX)) {
                            this.logger.warn(`Deferred auto-complete for order ${order.orderId}: ${errMsg.slice(DEFER_PREFIX.length)}`);
                            continue;
                        }
                        this.logger.error(`Failed to auto-complete order ${order.orderId}: ${errMsg}`);
                        const failureKey = `auto_complete_failures:${order.id}`;
                        const failCount = await this.redis.incr(failureKey).catch(() => 0);
                        if (failCount === 1) {
                            await this.redis.expire(failureKey, 7 * 24 * 3600).catch((err) => this.logger.warn(`silent-catch: ${err instanceof Error ? err.message : String(err)}`));
                        }
                        const FAILURE_ALERT_THRESHOLD = 3;
                        if (failCount >= FAILURE_ALERT_THRESHOLD) {
                            this.logger.error(`CRITICAL: Order ${order.orderId} has failed auto-complete ${failCount} times. ` +
                                `Manual intervention required. Error: ${errMsg}`);
                        }
                    }
                }
            }
        }
        catch (error) {
            this.logger.error('AutoCompleteDeliveredOrders FAILED', error);
        }
        finally {
            clearInterval(lockRenewalInterval);
            await this.redis.releaseLock(lockKey, lockToken).catch((err) => this.logger.warn(`silent-catch: ${err instanceof Error ? err.message : String(err)}`));
        }
    }
    async withSerializableRetry(operation, label) {
        const maxRetries = 3;
        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                return await operation();
            }
            catch (error) {
                const retryable = error instanceof client_1.Prisma.PrismaClientKnownRequestError
                    ? error.code === 'P2034'
                    : error instanceof client_1.Prisma.PrismaClientUnknownRequestError
                        && /40001|40p01|serialization|deadlock/i.test(error.message);
                if (!retryable || attempt === maxRetries)
                    throw error;
                this.logger.warn(`${label}_RETRY attempt=${attempt}/${maxRetries}`);
                await new Promise((resolve) => setTimeout(resolve, 100 * Math.pow(2, attempt - 1) + (0, crypto_1.randomInt)(0, 50)));
            }
        }
        throw new Error(`${label} exhausted retry loop`);
    }
};
exports.AutoCompleteDeliveredOrdersService = AutoCompleteDeliveredOrdersService;
__decorate([
    (0, schedule_1.Cron)('0 * * * *', { name: 'auto-complete-orders' }),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", Promise)
], AutoCompleteDeliveredOrdersService.prototype, "autoComplete", null);
exports.AutoCompleteDeliveredOrdersService = AutoCompleteDeliveredOrdersService = AutoCompleteDeliveredOrdersService_1 = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [prisma_service_1.PrismaService,
        redis_service_1.RedisService,
        wallet_tx_serial_service_1.WalletTxSerialService,
        referral_service_1.ReferralService,
        membership_rank_service_1.MembershipRankService,
        fee_calculator_service_1.FeeCalculatorService])
], AutoCompleteDeliveredOrdersService);
