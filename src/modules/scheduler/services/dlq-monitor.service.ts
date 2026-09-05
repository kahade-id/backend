import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectQueue } from '@nestjs/bull';
import { Queue } from 'bull';
import { randomUUID } from 'crypto';
import { DEAD_LETTER_QUEUE } from '../../queue/queue.constants';
import { RedisService } from '../../../redis/redis.service';
import { ensureRedisAvailable } from '../../../common/utils/redis-health.util';
import { safeErrorMessage, startLockRenewal } from '../../../common/utils/background-reliability.util';

const DLQ_WARN_THRESHOLD = 1;
const DLQ_ERROR_THRESHOLD = 10;
const DLQ_CRITICAL_THRESHOLD = 50;

@Injectable()
export class DlqMonitorService {
  private readonly logger = new Logger(DlqMonitorService.name);

  constructor(
    @InjectQueue(DEAD_LETTER_QUEUE) private readonly dlq: Queue,
    private readonly redis: RedisService,
  ) {}

  @Cron('*/5 * * * *', { name: 'dlq-monitor' })
  async checkDlqDepth(): Promise<void> {
    if (!(await ensureRedisAvailable(this.redis, 'dlq-monitor'))) return;

    const lockKey = 'cron_lock:dlq_monitor';
    const lockToken = randomUUID();
    const lockTtlSeconds = 300;
    const acquired = await this.redis.setNx(lockKey, lockToken, lockTtlSeconds);
    if (!acquired) return;
    const lease = startLockRenewal(this.redis, lockKey, lockToken, lockTtlSeconds, this.logger);

    try {
      if (lease.lost()) return;
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
        this.logger.error(
          `CRITICAL: Dead letter queue depth: ${totalDepth} (waiting=${waiting}, failed=${failed}). ` +
          `Immediate investigation required. Recent jobs: ${JSON.stringify(jobSummaries)}`,
        );
      } else if (totalDepth >= DLQ_ERROR_THRESHOLD) {
        const jobs = await this.dlq.getJobs(['waiting', 'failed'], 0, 5);
        const jobSummaries = jobs.map(j => ({
          id: j.id,
          name: j.name,
          failedReason: j.failedReason?.slice(0, 200),
          timestamp: j.timestamp,
        }));
        this.logger.error(
          `Dead letter queue depth elevated: ${totalDepth} (waiting=${waiting}, failed=${failed}). ` +
          `Recent jobs: ${JSON.stringify(jobSummaries)}`,
        );
      } else if (totalDepth >= DLQ_WARN_THRESHOLD) {
        const jobs = await this.dlq.getJobs(['waiting', 'failed'], 0, 5);
        const jobSummaries = jobs.map(j => ({
          id: j.id,
          name: j.name,
          failedReason: j.failedReason?.slice(0, 200),
          timestamp: j.timestamp,
        }));
        this.logger.warn(
          `Dead letter queue depth: ${totalDepth} (waiting=${waiting}, failed=${failed}). ` +
          `Recent jobs: ${JSON.stringify(jobSummaries)}`,
        );
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
        })).catch((err) => this.logger.warn(`silent-catch: ${safeErrorMessage(err)}`));
      } else {
        // Clear the alert explicitly; otherwise a recovered DLQ remains active
        // for the full TTL and operators receive a stale incident signal.
        await this.redis.del('cron_alert:dlq_depth').catch((err: unknown) => this.logger.warn(`silent-catch: ${safeErrorMessage(err)}`));
      }
    } catch (err) {
      const message = safeErrorMessage(err);
      this.logger.error(`DLQ monitor check failed: ${message}`);
      await this.redis.setex('cron_alert:dlq_monitor_failed', 3600, JSON.stringify({ failedAt: new Date().toISOString(), error: message })).catch((alertError: unknown) => this.logger.warn(`silent-catch: ${safeErrorMessage(alertError)}`));
    } finally {
      lease.stop();
      await this.redis.releaseLock(lockKey, lockToken).catch((err) => this.logger.warn(`silent-catch: ${safeErrorMessage(err)}`));
    }
  }
}
