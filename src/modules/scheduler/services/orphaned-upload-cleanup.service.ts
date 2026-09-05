import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { randomUUID } from 'crypto';
import { ConfigService } from '@nestjs/config';
import { S3Client, ListObjectsV2Command, DeleteObjectsCommand } from '@aws-sdk/client-s3';
import { RedisService } from '../../../redis/redis.service';
import { ensureRedisAvailable } from '../../../common/utils/redis-health.util';
import { formatWIBDate } from '../../../common/utils/date.util';
import { safeErrorMessage, startLockRenewal } from '../../../common/utils/background-reliability.util';

@Injectable()
export class OrphanedUploadCleanupService {
  private readonly logger = new Logger(OrphanedUploadCleanupService.name);
  private _s3Client: S3Client | null = null;

  constructor(
    private redis: RedisService,
    private configService: ConfigService,
  ) {}

  private getS3Client(): S3Client {
    if (this._s3Client) return this._s3Client;
    const accessKeyId = this.configService.get<string>('r2.accessKeyId');
    const secretAccessKey = this.configService.get<string>('r2.secretAccessKey');
    const endpointUrl = this.configService.get<string>('r2.endpointUrl');
    if (!accessKeyId || !secretAccessKey || !endpointUrl) {
      throw new Error('R2 credentials not configured — orphaned upload cleanup unavailable');
    }
    this._s3Client = new S3Client({
      region: 'auto',
      endpoint: endpointUrl,
      credentials: { accessKeyId, secretAccessKey },
      forcePathStyle: true,
    });
    return this._s3Client;
  }

  // SCH-017/SCH-028: Runs at 11:00 WIB (04:00 UTC) daily with conservative 24-hour orphan window
  @Cron('0 4 * * *', { name: 'orphaned-upload-cleanup', timeZone: 'UTC' })
  async cleanupOrphanedUploads(): Promise<void> {
    if (!(await ensureRedisAvailable(this.redis, 'orphaned-upload-cleanup'))) return;

    const today = formatWIBDate();
    const lockKey = `cron_lock:orphaned_upload_cleanup:${today}`;
    const lockToken = randomUUID();
    const lockTtlSeconds = 1800;
    const acquired = await this.redis.setNx(lockKey, lockToken, lockTtlSeconds);
    if (!acquired) return;
    const lease = startLockRenewal(this.redis, lockKey, lockToken, lockTtlSeconds, this.logger);

    this.logger.log('Starting orphaned upload cleanup...');

    try {
      const buckets = [
        this.configService.get<string>('r2.bucketPublic'),
        this.configService.get<string>('r2.bucketPrivate'),
      ].filter(Boolean) as string[];

      let totalDeleted = 0;
      // SCH-028: Conservative orphan detection window (configurable, default 24h)
      const thresholdHours = this.configService.get<number>('app.orphanUploadThresholdHours') ?? 24;
      const cutoffMs = Date.now() - thresholdHours * 60 * 60 * 1000;

      // SECURITY: orphan-detection currently relies ONLY on a 24h Redis key
      // (`confirmed_upload:<userId>:<key>`) which is deleted on consume by
      // verifyEvidenceFileKeys/verifyEvidenceFileKeysBatch and naturally
      // expires after 24h. Files persisted into DB tables (DisputeEvidence,
      // DeliveryProof, User.kycKtpUrl/kycSelfieUrl/avatarUrl, etc.) at the
      // same `uploads/` prefix would therefore be wrongly classified as
      // orphan once their Redis key is gone. Until cleanupBucket() is updated
      // with per-table DB existence checks, the destructive S3 delete is
      // gated behind ORPHAN_CLEANUP_ENABLED — defaulting to DRY-RUN.
      const destructiveDeleteEnabled = this.configService.get<boolean>('app.orphanCleanupEnabled') === true;
      if (!destructiveDeleteEnabled) {
        this.logger.warn('Orphan upload cleanup running in DRY-RUN mode — set ORPHAN_CLEANUP_ENABLED=true ONLY after a DB reference check is implemented in cleanupBucket().');
      }

      for (const bucket of buckets) {
        if (lease.lost()) throw new Error('Orphaned upload cleanup lease lost');
        totalDeleted += await this.cleanupBucket(bucket, cutoffMs, destructiveDeleteEnabled);
      }

      this.logger.log(`Orphaned upload cleanup completed: ${totalDeleted} files ${destructiveDeleteEnabled ? 'deleted' : 'WOULD-be-deleted (dry-run)'}`);
      await this.redis.setex('cron_heartbeat:orphaned_upload_cleanup', 86400, JSON.stringify({ ranAt: new Date().toISOString(), totalDeleted, dryRun: !destructiveDeleteEnabled })).catch((err: unknown) => this.logger.warn(`Failed to write orphan cleanup heartbeat: ${safeErrorMessage(err)}`));
    } catch (error) {
      const message = safeErrorMessage(error);
      this.logger.error(`Orphaned upload cleanup FAILED: ${message}`);
      await this.redis.setex('cron_alert:orphaned_upload_cleanup_failed', 3600, JSON.stringify({ failedAt: new Date().toISOString(), error: message })).catch((alertError: unknown) => this.logger.warn(`Failed to write orphan cleanup failure alert: ${safeErrorMessage(alertError)}`));
      throw error;
    } finally {
      lease.stop();
      await this.redis.releaseLock(lockKey, lockToken).catch((err) => this.logger.warn(`silent-catch: ${safeErrorMessage(err)}`));
    }
  }

  private async cleanupBucket(bucket: string, cutoffMs: number, destructiveDeleteEnabled: boolean): Promise<number> {
    let deleted = 0;
    let continuationToken: string | undefined;
    const s3 = this.getS3Client();

    do {
      const listCmd = new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: 'uploads/',
        MaxKeys: 1000,
        ContinuationToken: continuationToken,
      });

      const listResult = await s3.send(listCmd);
      continuationToken = listResult.NextContinuationToken;

      if (!listResult.Contents || listResult.Contents.length === 0) break;

      const orphanedKeys: string[] = [];

      for (const obj of listResult.Contents) {
        if (!obj.Key || !obj.LastModified) continue;
        if (obj.LastModified.getTime() > cutoffMs) continue;

        const segments = obj.Key.split('/');
        if (segments.length < 3) continue;
        const userId = segments[2];

        const confirmedKey = `confirmed_upload:${userId}:${obj.Key}`;
        try {
          const isConfirmed = await this.redis.get(confirmedKey, { throwOnError: true });
          if (!isConfirmed) {
            orphanedKeys.push(obj.Key);
          }
        } catch {
          this.logger.error(`Redis became unavailable during cleanup — aborting to prevent deleting confirmed files`);
          return deleted;
        }
      }

      if (orphanedKeys.length > 0) {
        if (!destructiveDeleteEnabled) {
          // DRY-RUN: log a sample of candidates so ops can audit before
          // enabling destructive deletion. Counted into `deleted` for parity.
          const sample = orphanedKeys.slice(0, 10);
          this.logger.warn(`DRY-RUN: ${orphanedKeys.length} orphan candidate(s) in bucket ${bucket}; sample: ${sample.join(', ')}${orphanedKeys.length > sample.length ? ', ...' : ''}`);
          deleted += orphanedKeys.length;
        } else {
          const BATCH = 1000;
          for (let i = 0; i < orphanedKeys.length; i += BATCH) {
            const batch = orphanedKeys.slice(i, i + BATCH);
            const deleteResult = await s3.send(new DeleteObjectsCommand({
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
}
