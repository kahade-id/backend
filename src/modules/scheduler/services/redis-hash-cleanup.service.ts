import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { randomUUID } from 'crypto';
import { RedisService } from '../../../redis/redis.service';
import { ensureRedisAvailable } from '../../../common/utils/redis-health.util';
import { safeErrorMessage, startLockRenewal } from '../../../common/utils/background-reliability.util';

// SCH-006/SCH-027: Explicit allowlist of hash keys eligible for cleanup.
// Only these exact keys are touched — no pattern/glob matching.
const CLEANUP_HASH_KEYS = ['email_queue_failures', 'referral:failed_rewards'] as const;

@Injectable()
export class RedisHashCleanupService {
  private readonly logger = new Logger(RedisHashCleanupService.name);
  private readonly RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

  constructor(private redis: RedisService) {}

  // SCH-017: Runs at 03:30 WIB (20:30 UTC) daily for Redis hash cleanup
  @Cron('30 20 * * *', { name: 'redis-hash-cleanup', timeZone: 'UTC' })
  async cleanupUnboundedHashes(): Promise<void> {
    if (!(await ensureRedisAvailable(this.redis, 'redis-hash-cleanup'))) return;

    const lockKey = 'cron_lock:redis_hash_cleanup';
    const lockToken = randomUUID();
    const lockTtlSeconds = 3600;
    const acquired = await this.redis.setNx(lockKey, lockToken, lockTtlSeconds);
    if (!acquired) return;
    const lease = startLockRenewal(this.redis, lockKey, lockToken, lockTtlSeconds, this.logger);

    const startedAt = Date.now();
    this.logger.log('Starting Redis hash cleanup...');
    const cutoff = Date.now() - this.RETENTION_MS;

    try {
      const results: Record<string, number> = {};
      for (const hashKey of CLEANUP_HASH_KEYS) {
        if (lease.lost()) break;
        results[hashKey] = await this.cleanupHash(hashKey, cutoff);
      }

      const durationMs = Date.now() - startedAt;
      this.logger.log(
        `Redis hash cleanup completed (${durationMs}ms): ` +
        Object.entries(results).map(([k, v]) => `${k}=${v}`).join(', '),
      );

      await this.redis.setex('cron_heartbeat:redis_hash_cleanup', 86400, JSON.stringify({
        ranAt: new Date().toISOString(),
        results,
        durationMs,
      })).catch((err) => this.logger.warn(`silent-catch: ${err instanceof Error ? err.message : String(err)}`));
    } catch (error) {
      const message = safeErrorMessage(error);
      this.logger.error(`Redis hash cleanup FAILED: ${message}`);
      await this.redis.setex('cron_alert:redis_hash_cleanup_failed', 3600, JSON.stringify({ failedAt: new Date().toISOString(), error: message })).catch((alertError: unknown) => this.logger.warn(`silent-catch: ${safeErrorMessage(alertError)}`));
    } finally {
      lease.stop();
      await this.redis.releaseLock(lockKey, lockToken).catch((err) => this.logger.warn(`silent-catch: ${safeErrorMessage(err)}`));
    }
  }

  private async cleanupHash(hashKey: string, cutoffMs: number): Promise<number> {
    try {
      const entries = await this.redis.hgetall(hashKey, { throwOnError: true });
      if (!entries) return 0;
      const fieldsToDelete: string[] = [];

      for (const [field, value] of Object.entries(entries)) {
        try {
          const parsed = JSON.parse(value);
          const failedAt = parsed.failedAt ? new Date(parsed.failedAt).getTime() : 0;
          if (failedAt > 0 && failedAt < cutoffMs) {
            fieldsToDelete.push(field);
          } else if (failedAt === 0) {
            fieldsToDelete.push(field);
          }
        } catch {
          fieldsToDelete.push(field);
        }
      }

      if (fieldsToDelete.length > 0) {
        await this.redis.hdel(hashKey, ...fieldsToDelete);
      }

      return fieldsToDelete.length;
    } catch (error) {
      this.logger.error(`Failed to cleanup Redis hash ${hashKey}`, error);
      throw error;
    }
  }
}
