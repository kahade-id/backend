/**
 * GAP-D retur — scheduler (G208, G222).
 *
 * Self-contained di modul returns (tidak menyentuh scheduler.module existing).
 * - Tiap 30 menit: eskalasi otomatis bila seller melewati SLA respons.
 * - Tiap jam: kedaluwarsakan kirim-balik & klarifikasi yang basi.
 * - Tiap hari 03:00 WIB: purge lampiran melewati masa retensi.
 */
import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { randomUUID } from 'crypto';
import { RedisService } from '../../redis/redis.service';
import { ensureRedisAvailable } from '../../common/utils/redis-health.util';
import { isCronJobDisabled } from '../../common/utils/cron-gate.util';
import { ReturnsService } from './returns.service';

@Injectable()
export class ReturnsSlaService {
  private readonly logger = new Logger(ReturnsSlaService.name);

  constructor(
    private returnsService: ReturnsService,
    private redis: RedisService,
  ) {}

  /**
   * K8 (audit 2026-10-10): semua job retur kini memakai lock Redis (satu
   * instance yang jalan — sebelumnya tanpa lock sehingga dua replika bisa
   * mengeskalasi/mengedaluwarsakan case yang sama bersamaan) + feature-flag
   * CRON_DISABLED_JOBS.
   */
  private async runLocked(jobName: string, ttlSeconds: number, task: () => Promise<void>): Promise<void> {
    if (isCronJobDisabled(jobName)) return;
    if (!(await ensureRedisAvailable(this.redis, jobName))) return;
    const lockKey = `cron_lock:${jobName.replace(/-/g, '_')}`;
    const lockToken = randomUUID();
    const acquired = await this.redis.setNx(lockKey, lockToken, ttlSeconds);
    if (!acquired) return;
    try {
      await task();
    } catch (err) {
      this.logger.error(`${jobName} gagal: ${(err as Error).message}`);
    } finally {
      await this.redis.releaseLock(lockKey, lockToken).catch((err) =>
        this.logger.warn(`silent-catch: ${err instanceof Error ? err.message : String(err)}`),
      );
    }
  }

  @Cron('*/30 * * * *', { name: 'returns-seller-sla' })
  async handleSellerSla(): Promise<void> {
    await this.runLocked('returns-seller-sla', 600, async () => {
      const n = await this.returnsService.expireSellerSla();
      if (n > 0) this.logger.log(`returns-seller-sla: ${n} case dieskalasi otomatis`);
    });
  }

  @Cron('0 * * * *', { name: 'returns-stale-expiry' })
  async handleStaleExpiry(): Promise<void> {
    await this.runLocked('returns-stale-expiry', 600, async () => {
      const n = await this.returnsService.expireStale();
      if (n > 0) this.logger.log(`returns-stale-expiry: ${n} case kedaluwarsa`);
    });
  }

  @Cron('0 3 * * *', { name: 'returns-evidence-purge', timeZone: 'Asia/Jakarta' })
  async handleEvidencePurge(): Promise<void> {
    await this.runLocked('returns-evidence-purge', 1800, async () => {
      const n = await this.returnsService.purgeExpiredEvidence();
      if (n > 0) this.logger.log(`returns-evidence-purge: ${n} lampiran di-purge`);
    });
  }
}
