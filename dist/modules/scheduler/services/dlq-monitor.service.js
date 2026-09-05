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
var __param = (this && this.__param) || function (paramIndex, decorator) {
    return function (target, key) { decorator(target, key, paramIndex); }
};
var DlqMonitorService_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.DlqMonitorService = void 0;
const common_1 = require("@nestjs/common");
const schedule_1 = require("@nestjs/schedule");
const bull_1 = require("@nestjs/bull");
const crypto_1 = require("crypto");
const queue_constants_1 = require("../../queue/queue.constants");
const redis_service_1 = require("../../../redis/redis.service");
const redis_health_util_1 = require("../../../common/utils/redis-health.util");
const background_reliability_util_1 = require("../../../common/utils/background-reliability.util");
const DLQ_WARN_THRESHOLD = 1;
const DLQ_ERROR_THRESHOLD = 10;
const DLQ_CRITICAL_THRESHOLD = 50;
let DlqMonitorService = DlqMonitorService_1 = class DlqMonitorService {
    constructor(dlq, redis) {
        this.dlq = dlq;
        this.redis = redis;
        this.logger = new common_1.Logger(DlqMonitorService_1.name);
    }
    async checkDlqDepth() {
        if (!(await (0, redis_health_util_1.ensureRedisAvailable)(this.redis, 'dlq-monitor')))
            return;
        const lockKey = 'cron_lock:dlq_monitor';
        const lockToken = (0, crypto_1.randomUUID)();
        const lockTtlSeconds = 300;
        const acquired = await this.redis.setNx(lockKey, lockToken, lockTtlSeconds);
        if (!acquired)
            return;
        const lease = (0, background_reliability_util_1.startLockRenewal)(this.redis, lockKey, lockToken, lockTtlSeconds, this.logger);
        try {
            if (lease.lost())
                return;
            const [waiting, failed] = await Promise.all([
                this.dlq.getWaitingCount(),
                this.dlq.getFailedCount(),
            ]);
            const totalDepth = waiting + failed;
            if (totalDepth >= DLQ_CRITICAL_THRESHOLD) {
                const jobs = await this.dlq.getJobs(['waiting', 'failed'], 0, 10);
                const jobSummaries = jobs.map(j => ({
                    id: j.id,
                    name: j.name,
                    failedReason: j.failedReason?.slice(0, 200),
                    timestamp: j.timestamp,
                }));
                this.logger.error(`CRITICAL: Dead letter queue depth: ${totalDepth} (waiting=${waiting}, failed=${failed}). ` +
                    `Immediate investigation required. Recent jobs: ${JSON.stringify(jobSummaries)}`);
            }
            else if (totalDepth >= DLQ_ERROR_THRESHOLD) {
                const jobs = await this.dlq.getJobs(['waiting', 'failed'], 0, 5);
                const jobSummaries = jobs.map(j => ({
                    id: j.id,
                    name: j.name,
                    failedReason: j.failedReason?.slice(0, 200),
                    timestamp: j.timestamp,
                }));
                this.logger.error(`Dead letter queue depth elevated: ${totalDepth} (waiting=${waiting}, failed=${failed}). ` +
                    `Recent jobs: ${JSON.stringify(jobSummaries)}`);
            }
            else if (totalDepth >= DLQ_WARN_THRESHOLD) {
                const jobs = await this.dlq.getJobs(['waiting', 'failed'], 0, 5);
                const jobSummaries = jobs.map(j => ({
                    id: j.id,
                    name: j.name,
                    failedReason: j.failedReason?.slice(0, 200),
                    timestamp: j.timestamp,
                }));
                this.logger.warn(`Dead letter queue depth: ${totalDepth} (waiting=${waiting}, failed=${failed}). ` +
                    `Recent jobs: ${JSON.stringify(jobSummaries)}`);
            }
            await this.redis.setex('cron_heartbeat:dlq_monitor', 600, JSON.stringify({
                ranAt: new Date().toISOString(),
                totalDepth,
                waiting,
                failed,
            })).catch((err) => this.logger.warn(`silent-catch: ${err instanceof Error ? err.message : String(err)}`));
            if (totalDepth >= DLQ_ERROR_THRESHOLD) {
                await this.redis.setex('cron_alert:dlq_depth', 3600, JSON.stringify({
                    alertAt: new Date().toISOString(),
                    totalDepth,
                    waiting,
                    failed,
                })).catch((err) => this.logger.warn(`silent-catch: ${(0, background_reliability_util_1.safeErrorMessage)(err)}`));
            }
            else {
                await this.redis.del('cron_alert:dlq_depth').catch((err) => this.logger.warn(`silent-catch: ${(0, background_reliability_util_1.safeErrorMessage)(err)}`));
            }
        }
        catch (err) {
            const message = (0, background_reliability_util_1.safeErrorMessage)(err);
            this.logger.error(`DLQ monitor check failed: ${message}`);
            await this.redis.setex('cron_alert:dlq_monitor_failed', 3600, JSON.stringify({ failedAt: new Date().toISOString(), error: message })).catch((alertError) => this.logger.warn(`silent-catch: ${(0, background_reliability_util_1.safeErrorMessage)(alertError)}`));
        }
        finally {
            lease.stop();
            await this.redis.releaseLock(lockKey, lockToken).catch((err) => this.logger.warn(`silent-catch: ${(0, background_reliability_util_1.safeErrorMessage)(err)}`));
        }
    }
};
exports.DlqMonitorService = DlqMonitorService;
__decorate([
    (0, schedule_1.Cron)('*/5 * * * *', { name: 'dlq-monitor' }),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", Promise)
], DlqMonitorService.prototype, "checkDlqDepth", null);
exports.DlqMonitorService = DlqMonitorService = DlqMonitorService_1 = __decorate([
    (0, common_1.Injectable)(),
    __param(0, (0, bull_1.InjectQueue)(queue_constants_1.DEAD_LETTER_QUEUE)),
    __metadata("design:paramtypes", [Object, redis_service_1.RedisService])
], DlqMonitorService);
