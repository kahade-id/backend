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
var RedisHashCleanupService_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.RedisHashCleanupService = void 0;
const common_1 = require("@nestjs/common");
const schedule_1 = require("@nestjs/schedule");
const crypto_1 = require("crypto");
const redis_service_1 = require("../../../redis/redis.service");
const redis_health_util_1 = require("../../../common/utils/redis-health.util");
const background_reliability_util_1 = require("../../../common/utils/background-reliability.util");
const CLEANUP_HASH_KEYS = ['email_queue_failures', 'referral:failed_rewards'];
let RedisHashCleanupService = RedisHashCleanupService_1 = class RedisHashCleanupService {
    constructor(redis) {
        this.redis = redis;
        this.logger = new common_1.Logger(RedisHashCleanupService_1.name);
        this.RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
    }
    async cleanupUnboundedHashes() {
        if (!(await (0, redis_health_util_1.ensureRedisAvailable)(this.redis, 'redis-hash-cleanup')))
            return;
        const lockKey = 'cron_lock:redis_hash_cleanup';
        const lockToken = (0, crypto_1.randomUUID)();
        const lockTtlSeconds = 3600;
        const acquired = await this.redis.setNx(lockKey, lockToken, lockTtlSeconds);
        if (!acquired)
            return;
        const lease = (0, background_reliability_util_1.startLockRenewal)(this.redis, lockKey, lockToken, lockTtlSeconds, this.logger);
        const startedAt = Date.now();
        this.logger.log('Starting Redis hash cleanup...');
        const cutoff = Date.now() - this.RETENTION_MS;
        try {
            const results = {};
            for (const hashKey of CLEANUP_HASH_KEYS) {
                if (lease.lost())
                    break;
                results[hashKey] = await this.cleanupHash(hashKey, cutoff);
            }
            const durationMs = Date.now() - startedAt;
            this.logger.log(`Redis hash cleanup completed (${durationMs}ms): ` +
                Object.entries(results).map(([k, v]) => `${k}=${v}`).join(', '));
            await this.redis.setex('cron_heartbeat:redis_hash_cleanup', 86400, JSON.stringify({
                ranAt: new Date().toISOString(),
                results,
                durationMs,
            })).catch((err) => this.logger.warn(`silent-catch: ${err instanceof Error ? err.message : String(err)}`));
        }
        catch (error) {
            const message = (0, background_reliability_util_1.safeErrorMessage)(error);
            this.logger.error(`Redis hash cleanup FAILED: ${message}`);
            await this.redis.setex('cron_alert:redis_hash_cleanup_failed', 3600, JSON.stringify({ failedAt: new Date().toISOString(), error: message })).catch((alertError) => this.logger.warn(`silent-catch: ${(0, background_reliability_util_1.safeErrorMessage)(alertError)}`));
        }
        finally {
            lease.stop();
            await this.redis.releaseLock(lockKey, lockToken).catch((err) => this.logger.warn(`silent-catch: ${(0, background_reliability_util_1.safeErrorMessage)(err)}`));
        }
    }
    async cleanupHash(hashKey, cutoffMs) {
        try {
            const entries = await this.redis.hgetall(hashKey, { throwOnError: true });
            if (!entries)
                return 0;
            const fieldsToDelete = [];
            for (const [field, value] of Object.entries(entries)) {
                try {
                    const parsed = JSON.parse(value);
                    const failedAt = parsed.failedAt ? new Date(parsed.failedAt).getTime() : 0;
                    if (failedAt > 0 && failedAt < cutoffMs) {
                        fieldsToDelete.push(field);
                    }
                    else if (failedAt === 0) {
                        fieldsToDelete.push(field);
                    }
                }
                catch {
                    fieldsToDelete.push(field);
                }
            }
            if (fieldsToDelete.length > 0) {
                await this.redis.hdel(hashKey, ...fieldsToDelete);
            }
            return fieldsToDelete.length;
        }
        catch (error) {
            this.logger.error(`Failed to cleanup Redis hash ${hashKey}`, error);
            throw error;
        }
    }
};
exports.RedisHashCleanupService = RedisHashCleanupService;
__decorate([
    (0, schedule_1.Cron)('30 20 * * *', { name: 'redis-hash-cleanup', timeZone: 'UTC' }),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", Promise)
], RedisHashCleanupService.prototype, "cleanupUnboundedHashes", null);
exports.RedisHashCleanupService = RedisHashCleanupService = RedisHashCleanupService_1 = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [redis_service_1.RedisService])
], RedisHashCleanupService);
