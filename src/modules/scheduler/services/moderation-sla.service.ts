import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { randomUUID } from 'crypto';
import { RedisService } from '../../../redis/redis.service';
import { cronJitter } from '../../../common/utils/cron-jitter.util';
import { ensureRedisAvailable } from '../../../common/utils/redis-health.util';
import { AdminShowcaseReportsService } from '../../admin/showcase-reports/admin-showcase-reports.service';

/**
 * GAP-F (G419/G423): scheduler ringan untuk lifecycle moderasi laporan etalase.
 *
 * - `escalateOverdueModeration` (tiap 30 menit): assignment yang melewati
 *   slaDueAt → tandai escalated + event ESCALATED (aktor sistem).
 * - `autoRestoreTemporaryRestrictions` (tiap jam penuh): RESTRICT_TEMPORARY
 *   yang restrictUntil-nya sudah lewat → kembalikan isActive item + event
 *   RESTORED + notifikasi pemilik.
 *
 * Keduanya idempoten (flag escalated / pengecekan event RESTORED) dan memakai
 * distributed lock Redis mengikuti pola scheduler lain (proof-expiry).
 * No-op aman bila tabel fragment moderasi belum di-merge (safeRead → fallback).
 */
@Injectable()
export class ModerationSlaService {
  private readonly logger = new Logger(ModerationSlaService.name);

  constructor(
    private readonly redis: RedisService,
    private readonly moderation: AdminShowcaseReportsService,
  ) {}

  private async withLock(lockKey: string, ttlSeconds: number, task: () => Promise<void>): Promise<void> {
    if (!(await ensureRedisAvailable(this.redis, 'moderation-sla'))) return;
    const lockToken = randomUUID();
    const acquired = await this.redis.setNx(lockKey, lockToken, ttlSeconds);
    if (!acquired) return;
    try {
      await task();
    } catch (error: unknown) {
      this.logger.error(
        `ModerationSlaService ${lockKey} FAILED: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  @Cron('*/30 * * * *', { name: 'moderation-sla-escalation' })
  async escalateOverdueModeration(): Promise<void> {
    await cronJitter(10_000);
    await this.withLock('cron_lock:moderation_sla_escalation', 1800, async () => {
      const { escalated } = await this.moderation.escalateOverdueAssignments();
      if (escalated > 0) {
        this.logger.log(`Escalated ${escalated} overdue moderation assignment(s)`);
      }
    });
  }

  @Cron('0 * * * *', { name: 'moderation-auto-restore' })
  async autoRestoreTemporaryRestrictions(): Promise<void> {
    await cronJitter(10_000);
    await this.withLock('cron_lock:moderation_auto_restore', 1800, async () => {
      const { restored } = await this.moderation.autoRestoreExpiredRestrictions();
      if (restored > 0) {
        this.logger.log(`Auto-restored ${restored} showcase item(s) after temporary restriction`);
      }
    });
  }
}
