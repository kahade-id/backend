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
var ExpireUnpaidOrdersService_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.ExpireUnpaidOrdersService = void 0;
const common_1 = require("@nestjs/common");
const schedule_1 = require("@nestjs/schedule");
const client_1 = require("@prisma/client");
const crypto_1 = require("crypto");
const notification_category_map_1 = require("../../notifications/notification-category.map");
const prisma_service_1 = require("../../../prisma/prisma.service");
const redis_service_1 = require("../../../redis/redis.service");
const id_generator_util_1 = require("../../../common/utils/id-generator.util");
const redis_health_util_1 = require("../../../common/utils/redis-health.util");
let ExpireUnpaidOrdersService = ExpireUnpaidOrdersService_1 = class ExpireUnpaidOrdersService {
    constructor(prisma, redis) {
        this.prisma = prisma;
        this.redis = redis;
        this.logger = new common_1.Logger(ExpireUnpaidOrdersService_1.name);
    }
    emitRealtimeBestEffort(payload, label) {
        try {
            this.prisma.emitNotificationCreated(payload);
        }
        catch (error) {
            this.logger.warn(`${label} realtime notification failed: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    async expireUnpaidOrders() {
        if (!(await (0, redis_health_util_1.ensureRedisAvailable)(this.redis, 'expire-unpaid-orders')))
            return;
        const lockKey = 'cron_lock:expire_unpaid_orders';
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
                this.logger.warn('Expire unpaid orders lock ownership was lost; stopping after the current batch.');
            }
        }, 60_000);
        const now = new Date();
        try {
            let hasMore = true;
            while (hasMore) {
                if (lockLost || await this.redis.get(lockKey) !== lockToken) {
                    this.logger.warn('Expire unpaid orders lock ownership was lost; aborting before the next batch.');
                    return;
                }
                const expiredOrders = await this.prisma.order.findMany({
                    where: {
                        status: client_1.OrderStatus.WAITING_PAYMENT,
                        paymentDeadlineAt: { lt: now },
                    },
                    select: { id: true, orderId: true, title: true, buyerId: true, sellerId: true, voucherId: true },
                    take: 500,
                });
                if (expiredOrders.length === 0) {
                    hasMore = false;
                    break;
                }
                hasMore = expiredOrders.length === 500;
                this.logger.log(`Found ${expiredOrders.length} unpaid orders past deadline — expiring.`);
                for (const order of expiredOrders) {
                    try {
                        const didExpire = await this.prisma.$transaction(async (tx) => {
                            const updated = await tx.order.updateMany({
                                where: { id: order.id, status: client_1.OrderStatus.WAITING_PAYMENT, paymentDeadlineAt: { lt: now } },
                                data: {
                                    status: client_1.OrderStatus.CANCELLED,
                                    cancelledAt: new Date(),
                                    cancelReason: 'TIMEOUT_PAYMENT',
                                },
                            });
                            if (updated.count === 0)
                                return false;
                            await tx.orderStatusHistory.create({
                                data: {
                                    orderId: order.id,
                                    fromStatus: client_1.OrderStatus.WAITING_PAYMENT,
                                    toStatus: client_1.OrderStatus.CANCELLED,
                                    changedBy: 'SYSTEM',
                                    changedByType: client_1.ActorType.SYSTEM,
                                    reason: 'Auto-expired: payment deadline exceeded',
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
                        if (!didExpire)
                            continue;
                        this.prisma.notification.create({
                            data: {
                                notifId: (0, id_generator_util_1.generateNotifId)(),
                                userId: order.buyerId,
                                type: client_1.NotificationType.ORDER_CANCELLED_TIMEOUT,
                                category: (0, notification_category_map_1.getCategoryForType)(client_1.NotificationType.ORDER_CANCELLED_TIMEOUT),
                                title: 'Order Cancelled',
                                body: `Order "${order.title}" has been cancelled because the payment deadline has passed.`,
                                isRead: false,
                            },
                        }).catch((notificationError) => this.logger.warn(`silent-catch: unpaid buyer notification failed: ${notificationError instanceof Error ? notificationError.message : String(notificationError)}`));
                        this.prisma.notification.create({
                            data: {
                                notifId: (0, id_generator_util_1.generateNotifId)(),
                                userId: order.sellerId,
                                type: client_1.NotificationType.ORDER_CANCELLED_TIMEOUT,
                                category: (0, notification_category_map_1.getCategoryForType)(client_1.NotificationType.ORDER_CANCELLED_TIMEOUT),
                                title: 'Order Cancelled',
                                body: `Order "${order.title}" has been cancelled because the buyer did not pay before the deadline.`,
                                isRead: false,
                            },
                        }).catch((notificationError) => this.logger.warn(`silent-catch: unpaid seller notification failed: ${notificationError instanceof Error ? notificationError.message : String(notificationError)}`));
                        this.emitRealtimeBestEffort({
                            userId: order.buyerId,
                            title: 'Order Cancelled',
                            body: `Order "${order.title}" has been cancelled because the payment deadline has passed.`,
                            data: { type: 'ORDER_CANCELLED', orderId: order.orderId },
                        }, 'EXPIRE_UNPAID_BUYER');
                        this.emitRealtimeBestEffort({
                            userId: order.sellerId,
                            title: 'Order Cancelled',
                            body: `Order "${order.title}" has been cancelled because the buyer did not pay before the deadline.`,
                            data: { type: 'ORDER_CANCELLED', orderId: order.orderId },
                        }, 'EXPIRE_UNPAID_SELLER');
                        this.logger.log(`Expired unpaid order ${order.orderId}`);
                    }
                    catch (err) {
                        const errMsg = err instanceof Error ? err.message : String(err);
                        this.logger.error(`Failed to expire order ${order.orderId}: ${errMsg}`);
                    }
                }
            }
        }
        catch (error) {
            this.logger.error('ExpireUnpaidOrders FAILED', error);
        }
        finally {
            clearInterval(lockRenewalInterval);
            await this.redis.releaseLock(lockKey, lockToken).catch((err) => this.logger.warn(`silent-catch: ${err instanceof Error ? err.message : String(err)}`));
        }
    }
};
exports.ExpireUnpaidOrdersService = ExpireUnpaidOrdersService;
__decorate([
    (0, schedule_1.Cron)('*/10 * * * *', { name: 'expire-unpaid-orders' }),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", Promise)
], ExpireUnpaidOrdersService.prototype, "expireUnpaidOrders", null);
exports.ExpireUnpaidOrdersService = ExpireUnpaidOrdersService = ExpireUnpaidOrdersService_1 = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [prisma_service_1.PrismaService,
        redis_service_1.RedisService])
], ExpireUnpaidOrdersService);
