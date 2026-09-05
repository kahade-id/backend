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
var ExpireUnconfirmedOrdersService_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.ExpireUnconfirmedOrdersService = void 0;
const common_1 = require("@nestjs/common");
const schedule_1 = require("@nestjs/schedule");
const client_1 = require("@prisma/client");
const crypto_1 = require("crypto");
const notification_category_map_1 = require("../../notifications/notification-category.map");
const prisma_service_1 = require("../../../prisma/prisma.service");
const redis_service_1 = require("../../../redis/redis.service");
const id_generator_util_1 = require("../../../common/utils/id-generator.util");
const redis_health_util_1 = require("../../../common/utils/redis-health.util");
let ExpireUnconfirmedOrdersService = ExpireUnconfirmedOrdersService_1 = class ExpireUnconfirmedOrdersService {
    constructor(prisma, redis) {
        this.prisma = prisma;
        this.redis = redis;
        this.logger = new common_1.Logger(ExpireUnconfirmedOrdersService_1.name);
    }
    emitRealtimeBestEffort(payload, label) {
        try {
            this.prisma.emitNotificationCreated(payload);
        }
        catch (error) {
            this.logger.warn(`${label} realtime notification failed: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    async expireUnconfirmedOrders() {
        if (!(await (0, redis_health_util_1.ensureRedisAvailable)(this.redis, 'expire-unconfirmed-orders')))
            return;
        const lockKey = 'cron_lock:expire_unconfirmed_orders';
        const lockToken = (0, crypto_1.randomUUID)();
        const acquired = await this.redis.setNx(lockKey, lockToken, 600);
        if (!acquired)
            return;
        let lockLost = false;
        const lockRenewalInterval = setInterval(async () => {
            const renewed = await this.redis.renewLock(lockKey, lockToken, 600);
            if (!renewed) {
                lockLost = true;
                clearInterval(lockRenewalInterval);
                this.logger.warn('Expire unconfirmed orders lock ownership was lost; stopping after the current batch.');
            }
        }, 60_000);
        const now = new Date();
        try {
            let hasMore = true;
            while (hasMore) {
                if (lockLost || await this.redis.get(lockKey) !== lockToken) {
                    this.logger.warn('Expire unconfirmed orders lock ownership was lost; aborting before the next batch.');
                    return;
                }
                const expiredOrders = await this.prisma.order.findMany({
                    where: {
                        status: client_1.OrderStatus.WAITING_CONFIRMATION,
                        confirmationDeadlineAt: { lt: now },
                    },
                    select: { id: true, orderId: true, title: true, buyerId: true, sellerId: true, createdByBuyer: true, voucherId: true },
                    take: 500,
                });
                if (expiredOrders.length === 0) {
                    hasMore = false;
                    break;
                }
                hasMore = expiredOrders.length === 500;
                this.logger.log(`Found ${expiredOrders.length} unconfirmed orders past deadline — expiring.`);
                for (const order of expiredOrders) {
                    const notifyUserId = order.createdByBuyer ? order.buyerId : order.sellerId;
                    try {
                        const didExpire = await this.prisma.$transaction(async (tx) => {
                            const updated = await tx.order.updateMany({
                                where: { id: order.id, status: client_1.OrderStatus.WAITING_CONFIRMATION, confirmationDeadlineAt: { lt: now } },
                                data: {
                                    status: client_1.OrderStatus.CANCELLED,
                                    cancelledAt: new Date(),
                                    cancelReason: 'TIMEOUT_CONFIRMATION',
                                },
                            });
                            if (updated.count === 0)
                                return false;
                            await tx.orderStatusHistory.create({
                                data: {
                                    orderId: order.id,
                                    fromStatus: client_1.OrderStatus.WAITING_CONFIRMATION,
                                    toStatus: client_1.OrderStatus.CANCELLED,
                                    changedBy: 'SYSTEM',
                                    changedByType: client_1.ActorType.SYSTEM,
                                    reason: 'Auto-expired: confirmation deadline exceeded',
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
                            return true;
                        }, { isolationLevel: client_1.Prisma.TransactionIsolationLevel.Serializable });
                        if (didExpire) {
                            this.prisma.notification.create({
                                data: {
                                    notifId: (0, id_generator_util_1.generateNotifId)(),
                                    userId: notifyUserId,
                                    type: client_1.NotificationType.ORDER_CANCELLED_TIMEOUT,
                                    category: (0, notification_category_map_1.getCategoryForType)(client_1.NotificationType.ORDER_CANCELLED_TIMEOUT),
                                    title: 'Order Cancelled',
                                    body: `Order "${order.title}" has been cancelled because the confirmation deadline has passed.`,
                                    isRead: false,
                                },
                            }).catch((notificationError) => this.logger.warn(`silent-catch: unconfirmed expiry notification failed: ${notificationError instanceof Error ? notificationError.message : String(notificationError)}`));
                            this.emitRealtimeBestEffort({
                                userId: notifyUserId,
                                title: 'Order Cancelled',
                                body: `Order "${order.title}" has been cancelled because the confirmation deadline has passed.`,
                                data: { type: 'ORDER_CANCELLED_TIMEOUT', orderId: order.orderId },
                            }, 'EXPIRE_UNCONFIRMED');
                            this.logger.log(`Expired unconfirmed order ${order.orderId}`);
                        }
                    }
                    catch (err) {
                        const errMsg = err instanceof Error ? err.message : String(err);
                        this.logger.error(`Failed to expire unconfirmed order ${order.orderId}: ${errMsg}`);
                    }
                }
            }
        }
        catch (error) {
            this.logger.error('ExpireUnconfirmedOrders FAILED', error);
        }
        finally {
            clearInterval(lockRenewalInterval);
            await this.redis.releaseLock(lockKey, lockToken).catch((err) => this.logger.warn(`silent-catch: ${err instanceof Error ? err.message : String(err)}`));
        }
    }
};
exports.ExpireUnconfirmedOrdersService = ExpireUnconfirmedOrdersService;
__decorate([
    (0, schedule_1.Cron)('*/10 * * * *', { name: 'expire-unconfirmed-orders' }),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", Promise)
], ExpireUnconfirmedOrdersService.prototype, "expireUnconfirmedOrders", null);
exports.ExpireUnconfirmedOrdersService = ExpireUnconfirmedOrdersService = ExpireUnconfirmedOrdersService_1 = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [prisma_service_1.PrismaService,
        redis_service_1.RedisService])
], ExpireUnconfirmedOrdersService);
