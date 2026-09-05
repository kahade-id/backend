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
var DeadlineReminderService_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.DeadlineReminderService = void 0;
const common_1 = require("@nestjs/common");
const schedule_1 = require("@nestjs/schedule");
const client_1 = require("@prisma/client");
const crypto_1 = require("crypto");
const notification_category_map_1 = require("../../notifications/notification-category.map");
const prisma_service_1 = require("../../../prisma/prisma.service");
const redis_service_1 = require("../../../redis/redis.service");
const id_generator_util_1 = require("../../../common/utils/id-generator.util");
const redis_health_util_1 = require("../../../common/utils/redis-health.util");
const REMINDER_WINDOWS_HOURS = [48, 24, 6];
let DeadlineReminderService = DeadlineReminderService_1 = class DeadlineReminderService {
    constructor(prisma, redis) {
        this.prisma = prisma;
        this.redis = redis;
        this.logger = new common_1.Logger(DeadlineReminderService_1.name);
    }
    async isReminderStillEligible(orderId, audience, now) {
        try {
            const order = await this.prisma.order.findUnique({
                where: { id: orderId },
                select: {
                    status: true,
                    deliveryDeadlineAt: true,
                    dispute: { select: { id: true } },
                    deliveryProofs: { where: { status: 'SUBMITTED' }, select: { id: true }, take: 1 },
                },
            });
            if (!order || !order.deliveryDeadlineAt || order.deliveryDeadlineAt <= now || order.dispute)
                return false;
            if (audience === 'buyer')
                return order.status === client_1.OrderStatus.IN_DELIVERY && order.deliveryProofs.length > 0;
            return (order.status === client_1.OrderStatus.PROCESSING || order.status === client_1.OrderStatus.IN_DELIVERY) && order.deliveryProofs.length === 0;
        }
        catch (error) {
            this.logger.warn(`Reminder eligibility check failed for ${orderId}: ${error instanceof Error ? error.message : String(error)}`);
            return false;
        }
    }
    async sendDeadlineReminders() {
        if (!(await (0, redis_health_util_1.ensureRedisAvailable)(this.redis, 'deadline-reminders')))
            return;
        const lockKey = 'cron_lock:deadline_reminders';
        const lockToken = (0, crypto_1.randomUUID)();
        const acquired = await this.redis.setNx(lockKey, lockToken, 900);
        if (!acquired)
            return;
        const now = new Date();
        try {
            for (const hoursBeforeDeadline of REMINDER_WINDOWS_HOURS) {
                const windowStart = new Date(now.getTime() + (hoursBeforeDeadline - 1) * 60 * 60 * 1000);
                const windowEnd = new Date(now.getTime() + hoursBeforeDeadline * 60 * 60 * 1000);
                const buyerOrders = await this.prisma.order.findMany({
                    where: {
                        status: client_1.OrderStatus.IN_DELIVERY,
                        deliveryDeadlineAt: { gte: windowStart, lt: windowEnd },
                        dispute: { is: null },
                        deliveryProofs: {
                            some: { status: 'SUBMITTED' },
                        },
                    },
                    select: { id: true, orderId: true, buyerId: true, title: true },
                    take: 200,
                });
                for (const order of buyerOrders) {
                    if (!(await this.isReminderStillEligible(order.id, 'buyer', now)))
                        continue;
                    const dedupKey = `reminder:deadline:${order.id}:${hoursBeforeDeadline}h:buyer`;
                    const claimed = await this.redis.setNx(dedupKey, '1', hoursBeforeDeadline * 3600);
                    if (!claimed)
                        continue;
                    try {
                        let title;
                        let body;
                        if (hoursBeforeDeadline <= 6) {
                            title = '⚠️ Deadline Segera Berakhir';
                            body = `Order "${order.title}" akan otomatis diselesaikan dalam ${hoursBeforeDeadline} jam. Segera review bukti pengiriman sekarang.`;
                        }
                        else if (hoursBeforeDeadline <= 24) {
                            title = 'Reminder: Review Bukti Pengiriman';
                            body = `Order "${order.title}" akan otomatis diselesaikan besok. Pastikan Anda sudah review bukti pengiriman.`;
                        }
                        else {
                            title = 'Reminder: Bukti Pengiriman Menunggu Review';
                            body = `Bukti pengiriman untuk order "${order.title}" belum Anda review. Deadline dalam 2 hari.`;
                        }
                        await this.prisma.notification.create({
                            data: {
                                notifId: (0, id_generator_util_1.generateNotifId)(),
                                userId: order.buyerId,
                                type: client_1.NotificationType.ORDER_DELIVERED,
                                category: (0, notification_category_map_1.getCategoryForType)(client_1.NotificationType.ORDER_DELIVERED),
                                title,
                                body,
                                isRead: false,
                            },
                        });
                        try {
                            this.prisma.emitNotificationCreated({
                                userId: order.buyerId,
                                title,
                                body,
                                data: { type: 'ORDER_DELIVERED', orderId: order.orderId },
                            });
                        }
                        catch (error) {
                            this.logger.warn(`Buyer reminder realtime emit failed: ${error instanceof Error ? error.message : String(error)}`);
                        }
                    }
                    catch (err) {
                        await this.redis.del(dedupKey).catch((cleanupError) => this.logger.warn(`Reminder dedup rollback failed: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`));
                        this.logger.error(`Failed to send ${hoursBeforeDeadline}h buyer reminder for order ${order.orderId}: ${err instanceof Error ? err.message : String(err)}`);
                    }
                }
                const sellerOrders = await this.prisma.order.findMany({
                    where: {
                        status: { in: [client_1.OrderStatus.PROCESSING, client_1.OrderStatus.IN_DELIVERY] },
                        deliveryDeadlineAt: { gte: windowStart, lt: windowEnd },
                        dispute: { is: null },
                        deliveryProofs: {
                            none: { status: 'SUBMITTED' },
                        },
                    },
                    select: { id: true, orderId: true, sellerId: true, title: true, status: true },
                    take: 200,
                });
                for (const order of sellerOrders) {
                    if (!(await this.isReminderStillEligible(order.id, 'seller', now)))
                        continue;
                    const dedupKey = `reminder:deadline:${order.id}:${hoursBeforeDeadline}h:seller`;
                    const claimed = await this.redis.setNx(dedupKey, '1', hoursBeforeDeadline * 3600);
                    if (!claimed)
                        continue;
                    try {
                        let title;
                        let body;
                        if (hoursBeforeDeadline <= 6) {
                            title = '⚠️ Segera Kirim Bukti Pengiriman';
                            body = `Deadline order "${order.title}" tinggal ${hoursBeforeDeadline} jam lagi. Segera kirim bukti pengiriman sebelum order otomatis dibatalkan.`;
                        }
                        else if (hoursBeforeDeadline <= 24) {
                            title = 'Reminder: Kirim Bukti Pengiriman';
                            body = `Deadline order "${order.title}" besok. Pastikan Anda sudah mengirim bukti pengiriman.`;
                        }
                        else {
                            title = 'Reminder: Belum Ada Bukti Pengiriman';
                            body = `Order "${order.title}" belum memiliki bukti pengiriman. Deadline dalam 2 hari.`;
                        }
                        await this.prisma.notification.create({
                            data: {
                                notifId: (0, id_generator_util_1.generateNotifId)(),
                                userId: order.sellerId,
                                type: client_1.NotificationType.ORDER_DEADLINE_REMINDER,
                                category: (0, notification_category_map_1.getCategoryForType)(client_1.NotificationType.ORDER_DEADLINE_REMINDER),
                                title,
                                body,
                                isRead: false,
                            },
                        });
                        try {
                            this.prisma.emitNotificationCreated({
                                userId: order.sellerId,
                                title,
                                body,
                                data: { type: 'ORDER_DEADLINE_REMINDER', orderId: order.orderId },
                            });
                        }
                        catch (error) {
                            this.logger.warn(`Seller reminder realtime emit failed: ${error instanceof Error ? error.message : String(error)}`);
                        }
                    }
                    catch (err) {
                        await this.redis.del(dedupKey).catch((cleanupError) => this.logger.warn(`Reminder dedup rollback failed: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`));
                        this.logger.error(`Failed to send ${hoursBeforeDeadline}h seller reminder for order ${order.orderId}: ${err instanceof Error ? err.message : String(err)}`);
                    }
                }
            }
        }
        catch (error) {
            this.logger.error('DeadlineReminderService FAILED', error);
        }
        finally {
            await this.redis.releaseLock(lockKey, lockToken).catch((err) => this.logger.warn(`silent-catch: ${err instanceof Error ? err.message : String(err)}`));
        }
    }
};
exports.DeadlineReminderService = DeadlineReminderService;
__decorate([
    (0, schedule_1.Cron)('*/30 * * * *', { name: 'deadline-reminders' }),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", Promise)
], DeadlineReminderService.prototype, "sendDeadlineReminders", null);
exports.DeadlineReminderService = DeadlineReminderService = DeadlineReminderService_1 = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [prisma_service_1.PrismaService,
        redis_service_1.RedisService])
], DeadlineReminderService);
