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
var NotificationArchivalService_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.NotificationArchivalService = void 0;
const common_1 = require("@nestjs/common");
const config_1 = require("@nestjs/config");
const schedule_1 = require("@nestjs/schedule");
const crypto_1 = require("crypto");
const prisma_service_1 = require("../../../prisma/prisma.service");
const redis_service_1 = require("../../../redis/redis.service");
const cron_jitter_util_1 = require("../../../common/utils/cron-jitter.util");
const redis_health_util_1 = require("../../../common/utils/redis-health.util");
const background_reliability_util_1 = require("../../../common/utils/background-reliability.util");
const date_util_1 = require("../../../common/utils/date.util");
let NotificationArchivalService = NotificationArchivalService_1 = class NotificationArchivalService {
    constructor(prisma, redis, configService) {
        this.prisma = prisma;
        this.redis = redis;
        this.configService = configService;
        this.logger = new common_1.Logger(NotificationArchivalService_1.name);
        this.retentionReadDays = this.configService.get('app.retentionReadNotificationDays') ?? 30;
        this.retentionUnreadDays = this.configService.get('app.retentionUnreadNotificationDays') ?? 90;
    }
    async archiveOldNotifications() {
        await (0, cron_jitter_util_1.cronJitter)(30_000);
        if (!(await (0, redis_health_util_1.ensureRedisAvailable)(this.redis, 'notification-archival')))
            return;
        const today = (0, date_util_1.formatWIBDate)();
        const lockKey = `cron_lock:notification_archival:${today}`;
        const lockToken = (0, crypto_1.randomUUID)();
        const lockTtlSeconds = 1800;
        const acquired = await this.redis.setNx(lockKey, lockToken, lockTtlSeconds);
        if (!acquired) {
            this.logger.log('Notification archival skipped — another instance already executing.');
            return;
        }
        const lease = (0, background_reliability_util_1.startLockRenewal)(this.redis, lockKey, lockToken, lockTtlSeconds, this.logger);
        const startedAt = Date.now();
        this.logger.log('Starting notification archival...');
        const now = new Date();
        const readCutoff = new Date(now.getTime() - this.retentionReadDays * 24 * 60 * 60 * 1000);
        const unreadCutoff = new Date(now.getTime() - this.retentionUnreadDays * 24 * 60 * 60 * 1000);
        try {
            const BATCH_SIZE = 1000;
            let totalArchived = 0;
            let batchCount;
            do {
                if (lease.lost())
                    throw new Error('Notification archival lease lost');
                const batch = await this.prisma.notification.findMany({
                    where: { createdAt: { lt: readCutoff }, isRead: true },
                    select: { id: true },
                    take: BATCH_SIZE,
                });
                batchCount = batch.length;
                if (batchCount > 0) {
                    await this.prisma.notification.deleteMany({
                        where: { id: { in: batch.map(n => n.id) } },
                    });
                    totalArchived += batchCount;
                }
            } while (batchCount === BATCH_SIZE);
            let unreadBatchCount = 0;
            do {
                if (lease.lost())
                    throw new Error('Notification archival lease lost');
                const unreadBatch = await this.prisma.notification.findMany({
                    where: { createdAt: { lt: unreadCutoff }, isRead: false },
                    select: { id: true },
                    take: BATCH_SIZE,
                });
                unreadBatchCount = unreadBatch.length;
                if (unreadBatchCount > 0) {
                    await this.prisma.notification.deleteMany({ where: { id: { in: unreadBatch.map(n => n.id) } } });
                    totalArchived += unreadBatchCount;
                }
            } while (unreadBatchCount === BATCH_SIZE);
            const durationMs = Date.now() - startedAt;
            this.logger.log(`Notification archival completed (${durationMs}ms): ${totalArchived} notifications archived (read cutoff=${this.retentionReadDays}d, unread cutoff=${this.retentionUnreadDays}d).`);
            await this.redis.setex(`cron_heartbeat:notification_archival`, 86400, JSON.stringify({
                ranAt: new Date().toISOString(),
                totalArchived,
                durationMs,
            })).catch((err) => this.logger.warn(`silent-catch: ${err instanceof Error ? err.message : String(err)}`));
        }
        catch (error) {
            const message = (0, background_reliability_util_1.safeErrorMessage)(error);
            this.logger.error(`Notification archival FAILED: ${message}`);
            throw error;
        }
        finally {
            lease.stop();
            await this.redis.releaseLock(lockKey, lockToken).catch((err) => this.logger.warn(`silent-catch: ${(0, background_reliability_util_1.safeErrorMessage)(err)}`));
        }
    }
};
exports.NotificationArchivalService = NotificationArchivalService;
__decorate([
    (0, schedule_1.Cron)('0 3 * * *', { name: 'notification-archival', timeZone: 'UTC' }),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", Promise)
], NotificationArchivalService.prototype, "archiveOldNotifications", null);
exports.NotificationArchivalService = NotificationArchivalService = NotificationArchivalService_1 = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [prisma_service_1.PrismaService,
        redis_service_1.RedisService,
        config_1.ConfigService])
], NotificationArchivalService);
