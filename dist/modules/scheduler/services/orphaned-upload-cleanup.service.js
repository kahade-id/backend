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
var OrphanedUploadCleanupService_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.OrphanedUploadCleanupService = void 0;
const common_1 = require("@nestjs/common");
const schedule_1 = require("@nestjs/schedule");
const crypto_1 = require("crypto");
const config_1 = require("@nestjs/config");
const client_s3_1 = require("@aws-sdk/client-s3");
const redis_service_1 = require("../../../redis/redis.service");
const redis_health_util_1 = require("../../../common/utils/redis-health.util");
const date_util_1 = require("../../../common/utils/date.util");
const background_reliability_util_1 = require("../../../common/utils/background-reliability.util");
let OrphanedUploadCleanupService = OrphanedUploadCleanupService_1 = class OrphanedUploadCleanupService {
    constructor(redis, configService) {
        this.redis = redis;
        this.configService = configService;
        this.logger = new common_1.Logger(OrphanedUploadCleanupService_1.name);
        this._s3Client = null;
    }
    getS3Client() {
        if (this._s3Client)
            return this._s3Client;
        const accessKeyId = this.configService.get('r2.accessKeyId');
        const secretAccessKey = this.configService.get('r2.secretAccessKey');
        const endpointUrl = this.configService.get('r2.endpointUrl');
        if (!accessKeyId || !secretAccessKey || !endpointUrl) {
            throw new Error('R2 credentials not configured — orphaned upload cleanup unavailable');
        }
        this._s3Client = new client_s3_1.S3Client({
            region: 'auto',
            endpoint: endpointUrl,
            credentials: { accessKeyId, secretAccessKey },
            forcePathStyle: true,
        });
        return this._s3Client;
    }
    async cleanupOrphanedUploads() {
        if (!(await (0, redis_health_util_1.ensureRedisAvailable)(this.redis, 'orphaned-upload-cleanup')))
            return;
        const today = (0, date_util_1.formatWIBDate)();
        const lockKey = `cron_lock:orphaned_upload_cleanup:${today}`;
        const lockToken = (0, crypto_1.randomUUID)();
        const lockTtlSeconds = 1800;
        const acquired = await this.redis.setNx(lockKey, lockToken, lockTtlSeconds);
        if (!acquired)
            return;
        const lease = (0, background_reliability_util_1.startLockRenewal)(this.redis, lockKey, lockToken, lockTtlSeconds, this.logger);
        this.logger.log('Starting orphaned upload cleanup...');
        try {
            const buckets = [
                this.configService.get('r2.bucketPublic'),
                this.configService.get('r2.bucketPrivate'),
            ].filter(Boolean);
            let totalDeleted = 0;
            const thresholdHours = this.configService.get('app.orphanUploadThresholdHours') ?? 24;
            const cutoffMs = Date.now() - thresholdHours * 60 * 60 * 1000;
            const destructiveDeleteEnabled = this.configService.get('app.orphanCleanupEnabled') === true;
            if (!destructiveDeleteEnabled) {
                this.logger.warn('Orphan upload cleanup running in DRY-RUN mode — set ORPHAN_CLEANUP_ENABLED=true ONLY after a DB reference check is implemented in cleanupBucket().');
            }
            for (const bucket of buckets) {
                if (lease.lost())
                    throw new Error('Orphaned upload cleanup lease lost');
                totalDeleted += await this.cleanupBucket(bucket, cutoffMs, destructiveDeleteEnabled);
            }
            this.logger.log(`Orphaned upload cleanup completed: ${totalDeleted} files ${destructiveDeleteEnabled ? 'deleted' : 'WOULD-be-deleted (dry-run)'}`);
            await this.redis.setex('cron_heartbeat:orphaned_upload_cleanup', 86400, JSON.stringify({ ranAt: new Date().toISOString(), totalDeleted, dryRun: !destructiveDeleteEnabled })).catch((err) => this.logger.warn(`Failed to write orphan cleanup heartbeat: ${(0, background_reliability_util_1.safeErrorMessage)(err)}`));
        }
        catch (error) {
            const message = (0, background_reliability_util_1.safeErrorMessage)(error);
            this.logger.error(`Orphaned upload cleanup FAILED: ${message}`);
            await this.redis.setex('cron_alert:orphaned_upload_cleanup_failed', 3600, JSON.stringify({ failedAt: new Date().toISOString(), error: message })).catch((alertError) => this.logger.warn(`Failed to write orphan cleanup failure alert: ${(0, background_reliability_util_1.safeErrorMessage)(alertError)}`));
            throw error;
        }
        finally {
            lease.stop();
            await this.redis.releaseLock(lockKey, lockToken).catch((err) => this.logger.warn(`silent-catch: ${(0, background_reliability_util_1.safeErrorMessage)(err)}`));
        }
    }
    async cleanupBucket(bucket, cutoffMs, destructiveDeleteEnabled) {
        let deleted = 0;
        let continuationToken;
        const s3 = this.getS3Client();
        do {
            const listCmd = new client_s3_1.ListObjectsV2Command({
                Bucket: bucket,
                Prefix: 'uploads/',
                MaxKeys: 1000,
                ContinuationToken: continuationToken,
            });
            const listResult = await s3.send(listCmd);
            continuationToken = listResult.NextContinuationToken;
            if (!listResult.Contents || listResult.Contents.length === 0)
                break;
            const orphanedKeys = [];
            for (const obj of listResult.Contents) {
                if (!obj.Key || !obj.LastModified)
                    continue;
                if (obj.LastModified.getTime() > cutoffMs)
                    continue;
                const segments = obj.Key.split('/');
                if (segments.length < 3)
                    continue;
                const userId = segments[2];
                const confirmedKey = `confirmed_upload:${userId}:${obj.Key}`;
                try {
                    const isConfirmed = await this.redis.get(confirmedKey, { throwOnError: true });
                    if (!isConfirmed) {
                        orphanedKeys.push(obj.Key);
                    }
                }
                catch {
                    this.logger.error(`Redis became unavailable during cleanup — aborting to prevent deleting confirmed files`);
                    return deleted;
                }
            }
            if (orphanedKeys.length > 0) {
                if (!destructiveDeleteEnabled) {
                    const sample = orphanedKeys.slice(0, 10);
                    this.logger.warn(`DRY-RUN: ${orphanedKeys.length} orphan candidate(s) in bucket ${bucket}; sample: ${sample.join(', ')}${orphanedKeys.length > sample.length ? ', ...' : ''}`);
                    deleted += orphanedKeys.length;
                }
                else {
                    const BATCH = 1000;
                    for (let i = 0; i < orphanedKeys.length; i += BATCH) {
                        const batch = orphanedKeys.slice(i, i + BATCH);
                        const deleteResult = await s3.send(new client_s3_1.DeleteObjectsCommand({
                            Bucket: bucket,
                            Delete: { Objects: batch.map(Key => ({ Key })) },
                        }));
                        if (deleteResult.Errors && deleteResult.Errors.length > 0) {
                            throw new Error(`R2 returned ${deleteResult.Errors.length} deletion errors for bucket ${bucket}`);
                        }
                        deleted += deleteResult.Deleted?.length ?? batch.length;
                    }
                    this.logger.log(`Deleted ${orphanedKeys.length} orphaned files from bucket ${bucket}`);
                }
            }
        } while (continuationToken);
        return deleted;
    }
};
exports.OrphanedUploadCleanupService = OrphanedUploadCleanupService;
__decorate([
    (0, schedule_1.Cron)('0 4 * * *', { name: 'orphaned-upload-cleanup', timeZone: 'UTC' }),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", Promise)
], OrphanedUploadCleanupService.prototype, "cleanupOrphanedUploads", null);
exports.OrphanedUploadCleanupService = OrphanedUploadCleanupService = OrphanedUploadCleanupService_1 = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [redis_service_1.RedisService,
        config_1.ConfigService])
], OrphanedUploadCleanupService);
