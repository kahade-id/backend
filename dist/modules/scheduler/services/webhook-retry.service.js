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
var WebhookRetryService_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.WebhookRetryService = void 0;
const common_1 = require("@nestjs/common");
const config_1 = require("@nestjs/config");
const schedule_1 = require("@nestjs/schedule");
const crypto_1 = require("crypto");
const prisma_service_1 = require("../../../prisma/prisma.service");
const redis_service_1 = require("../../../redis/redis.service");
const redis_health_util_1 = require("../../../common/utils/redis-health.util");
const cron_jitter_util_1 = require("../../../common/utils/cron-jitter.util");
const payment_service_1 = require("../../payment/payment.service");
const webhook_retry_constants_1 = require("../../payment/webhook-retry.constants");
const background_reliability_util_1 = require("../../../common/utils/background-reliability.util");
const WEBHOOK_RETRY_LOCK_KEY = 'cron_lock:webhook_inbox_retry';
const WEBHOOK_RETRY_LOCK_TTL_SECONDS = 110;
const DEFAULT_BATCH_SIZE = 25;
let WebhookRetryService = WebhookRetryService_1 = class WebhookRetryService {
    constructor(prisma, redis, paymentService, configService) {
        this.prisma = prisma;
        this.redis = redis;
        this.paymentService = paymentService;
        this.configService = configService;
        this.logger = new common_1.Logger(WebhookRetryService_1.name);
        const configuredBatchSize = this.configService.get('app.webhookRetryBatchSize') ?? DEFAULT_BATCH_SIZE;
        this.batchSize = Math.min(Math.max(Math.trunc(configuredBatchSize), 1), 100);
    }
    async retryFailedWebhooks() {
        await (0, cron_jitter_util_1.cronJitter)(10_000);
        if (!(await (0, redis_health_util_1.ensureRedisAvailable)(this.redis, 'webhook-inbox-retry')))
            return;
        const lockToken = (0, crypto_1.randomUUID)();
        if (!(await this.redis.setNx(WEBHOOK_RETRY_LOCK_KEY, lockToken, WEBHOOK_RETRY_LOCK_TTL_SECONDS))) {
            return;
        }
        const startedAt = Date.now();
        const stats = { fetched: 0, processed: 0, failed: 0, deadLettered: 0 };
        const lease = (0, background_reliability_util_1.startLockRenewal)(this.redis, WEBHOOK_RETRY_LOCK_KEY, lockToken, WEBHOOK_RETRY_LOCK_TTL_SECONDS, this.logger);
        try {
            const now = new Date();
            const candidates = await this.prisma.webhookLog.findMany({
                where: {
                    source: 'MIDTRANS',
                    isProcessed: false,
                    deadLetteredAt: null,
                    retryCount: { lt: webhook_retry_constants_1.MAX_WEBHOOK_ATTEMPTS },
                    ipAddress: { not: null },
                    OR: [
                        { nextRetryAt: null },
                        { nextRetryAt: { lte: now } },
                    ],
                },
                orderBy: [{ nextRetryAt: 'asc' }, { createdAt: 'asc' }],
                take: this.batchSize,
            });
            stats.fetched = candidates.length;
            for (const candidate of candidates) {
                if (lease.lost()) {
                    this.logger.warn('Webhook retry stopped because the Redis lease was lost.');
                    break;
                }
                try {
                    await this.paymentService.handleMidtransWebhook(candidate.payload, candidate.ipAddress);
                    stats.processed += 1;
                }
                catch (error) {
                    stats.failed += 1;
                    const message = (0, background_reliability_util_1.safeErrorMessage)(error);
                    const attempt = Math.max(candidate.retryCount + 1, 1);
                    const deadLettered = attempt >= webhook_retry_constants_1.MAX_WEBHOOK_ATTEMPTS;
                    if (deadLettered)
                        stats.deadLettered += 1;
                    await this.prisma.webhookLog.updateMany({
                        where: { id: candidate.id, isProcessed: false, retryCount: candidate.retryCount },
                        data: {
                            retryCount: { increment: 1 },
                            errorMessage: message,
                            lastAttemptAt: new Date(),
                            nextRetryAt: deadLettered ? null : (0, webhook_retry_constants_1.getWebhookRetryAt)(attempt),
                            deadLetteredAt: deadLettered ? new Date() : null,
                        },
                    }).catch((updateError) => {
                        this.logger.error(`Failed to schedule webhook retry id=${candidate.id}: ${updateError instanceof Error ? updateError.message : String(updateError)}`);
                    });
                    this.logger.warn(`Webhook retry failed id=${candidate.id} attempt=${attempt}/${webhook_retry_constants_1.MAX_WEBHOOK_ATTEMPTS} deadLettered=${deadLettered}: ${message}`);
                }
            }
            const [retryableBacklog, deadLetterBacklog] = await Promise.all([
                this.prisma.webhookLog.count({
                    where: {
                        source: 'MIDTRANS',
                        isProcessed: false,
                        deadLetteredAt: null,
                        retryCount: { lt: webhook_retry_constants_1.MAX_WEBHOOK_ATTEMPTS },
                        OR: [{ nextRetryAt: null }, { nextRetryAt: { lte: new Date() } }],
                    },
                }),
                this.prisma.webhookLog.count({
                    where: { source: 'MIDTRANS', isProcessed: false, deadLetteredAt: { not: null } },
                }),
            ]);
            if (deadLetterBacklog > 0) {
                await this.redis.setex('cron_alert:webhook_inbox_dead_letter', 3600, JSON.stringify({
                    raisedAt: new Date().toISOString(),
                    count: deadLetterBacklog,
                })).catch((error) => this.logger.warn(`Failed to write webhook dead-letter alert: ${error instanceof Error ? error.message : String(error)}`));
                this.logger.error(`Webhook dead-letter backlog is ${deadLetterBacklog}`);
            }
            else {
                await this.redis.del('cron_alert:webhook_inbox_dead_letter').catch((error) => this.logger.warn(`Failed to clear webhook dead-letter alert: ${error instanceof Error ? error.message : String(error)}`));
            }
            if (retryableBacklog > this.batchSize * 4) {
                this.logger.warn(`Webhook retry backlog is high: ${retryableBacklog} eligible rows`);
            }
            await this.redis.setex('cron_heartbeat:webhook_inbox_retry', 86400, JSON.stringify({
                ranAt: new Date().toISOString(),
                stats: { ...stats, retryableBacklog, deadLetterBacklog },
                durationMs: Date.now() - startedAt,
            })).catch((error) => this.logger.warn(`Failed to write webhook retry heartbeat: ${error instanceof Error ? error.message : String(error)}`));
        }
        catch (error) {
            const message = (0, background_reliability_util_1.safeErrorMessage)(error);
            this.logger.error(`Webhook retry worker failed: ${message}`);
            await this.redis.setex('cron_alert:webhook_inbox_retry_failed', 3600, JSON.stringify({ failedAt: new Date().toISOString(), error: message })).catch((alertError) => this.logger.warn(`Failed to write webhook retry failure alert: ${(0, background_reliability_util_1.safeErrorMessage)(alertError)}`));
        }
        finally {
            lease.stop();
            await this.redis.releaseLock(WEBHOOK_RETRY_LOCK_KEY, lockToken).catch((error) => this.logger.warn(`Failed to release webhook retry lock: ${(0, background_reliability_util_1.safeErrorMessage)(error)}`));
        }
    }
};
exports.WebhookRetryService = WebhookRetryService;
__decorate([
    (0, schedule_1.Cron)('*/2 * * * *', { name: 'webhook-inbox-retry', timeZone: 'UTC' }),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", Promise)
], WebhookRetryService.prototype, "retryFailedWebhooks", null);
exports.WebhookRetryService = WebhookRetryService = WebhookRetryService_1 = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [prisma_service_1.PrismaService,
        redis_service_1.RedisService,
        payment_service_1.PaymentService,
        config_1.ConfigService])
], WebhookRetryService);
