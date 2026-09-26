import { Logger } from '@nestjs/common';
import * as Sentry from '@sentry/nestjs';
import { RedisService } from '../../redis/redis.service';

const logger = new Logger('ensureRedisAvailable');

export interface EnsureRedisOptions {
  /**
   * Dipanggil (best-effort, error ditangkap) bila Redis tidak tersedia dan
   * cron dilewati. Dipakai job kritis-uang agar skip tidak senyap
   * (CW-014): tanpa ini, auto-complete escrow / rekonsiliasi penarikan /
   * cleanup topup berhenti total tanpa jejak operasional.
   */
  onRedisDown?: () => void | Promise<void>;
}

export async function ensureRedisAvailable(
  redis: RedisService,
  jobName: string,
  opts?: EnsureRedisOptions,
): Promise<boolean> {
  const healthy = await redis.isHealthy();
  if (!healthy) {
    logger.error(`Redis is unreachable — skipping cron job "${jobName}"`);
    if (opts?.onRedisDown) {
      try {
        await opts.onRedisDown();
      } catch (err) {
        logger.warn(
          `onRedisDown handler failed for "${jobName}": ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }
  return healthy;
}

/**
 * CW-014: alert untuk job kritis-uang yang dilewati karena Redis down.
 * Tanpa PII — hanya nama job. Event Sentry (no-op bila SENTRY_DSN tidak
 * diset) + logger.error di atas. Fallback penuh (menjalankan job uang tanpa
 * Redis via DB lock) adalah keputusan infra — DITUNDA, tidak dikerjakan di sini.
 */
export function alertMoneyCronSkippedRedisDown(jobName: string): void {
  Sentry.withScope((scope) => {
    scope.setTag('alert.kind', 'cron_skipped_redis_down');
    scope.setExtra('jobName', jobName);
    Sentry.captureMessage(
      `CRON_SKIPPED_REDIS_DOWN: money-critical job "${jobName}" skipped because Redis is unreachable; manual follow-up may be required`,
      'error',
    );
  });
}
