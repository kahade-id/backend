import { Processor, Process, InjectQueue, OnQueueFailed } from '@nestjs/bull';
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Job, Queue } from 'bull';
import { randomUUID } from 'crypto';
import { RedisService } from '../../../redis/redis.service';
import { ensureRedisAvailable } from '../../../common/utils/redis-health.util';
import { safeErrorMessage } from '../../../common/utils/background-reliability.util';
import { CommerceRefundService } from '../services/commerce-refund.service';

export const COMMERCE_REFUND_QUEUE = 'commerce-refund';

/**
 * M2 (SEC-B ronde 2) — Bull repeatable job tiap 5 menit: eksekusi refund
 * untuk peserta patungan/jastip berstatus REFUND_REQUIRED.
 *
 * Keputusan user FINAL: auto-refund OTOMATIS via scheduler + endpoint admin
 * manual sebagai fallback SLA. Job ini idempoten (guard transisi status di
 * CommerceRefundService) dan di-lock via Redis agar multi-replika tidak
 * dobel sweep.
 */
@Injectable()
@Processor(COMMERCE_REFUND_QUEUE)
export class CommerceRefundProcessor implements OnModuleInit {
  private readonly logger = new Logger(CommerceRefundProcessor.name);

  constructor(
    @InjectQueue(COMMERCE_REFUND_QUEUE) private readonly queue: Queue,
    private readonly refundService: CommerceRefundService,
    private readonly redis: RedisService,
  ) {}

  async onModuleInit(): Promise<void> {
    // Repeatable job — Bull dedupe berdasarkan jobId, aman di-rerun tiap boot.
    await this.queue.add(
      'sweep',
      {},
      {
        jobId: 'commerce-refund-sweep',
        repeat: { every: 5 * 60 * 1000 },
        removeOnComplete: 20,
        removeOnFail: 20,
      },
    );
  }

  @Process('sweep')
  async handleSweep(_job: Job): Promise<void> {
    if (!(await ensureRedisAvailable(this.redis, 'commerce-refund-sweep'))) return;
    const lockKey = 'cron_lock:commerce_refund_sweep';
    const token = randomUUID();
    const acquired = await this.redis.setNx(lockKey, token, 300);
    if (!acquired) return;
    try {
      const counts = await this.refundService.sweepDueRefunds(50);
      if (counts.refunded > 0 || counts.failed > 0 || counts.skipped > 0) {
        this.logger.log(
          `Commerce refund sweep: ${counts.refunded} refunded, ${counts.already} already, ${counts.skipped} skipped, ${counts.failed} failed`,
        );
      }
    } catch (error) {
      this.logger.error(`Commerce refund sweep gagal: ${safeErrorMessage(error)}`);
      throw error;
    } finally {
      const current = await this.redis.get(lockKey).catch(() => null);
      if (current === token) await this.redis.del(lockKey).catch(() => undefined);
    }
  }

  @OnQueueFailed()
  onFailed(job: Job, error: Error): void {
    this.logger.error(`Commerce refund job ${job.id} gagal: ${safeErrorMessage(error)}`);
  }
}
