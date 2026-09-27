import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../../../prisma/prisma.service';
import { RedisService } from '../../../redis/redis.service';
import { randomUUID } from 'crypto';
import { ensureRedisAvailable } from '../../../common/utils/redis-health.util';
import { safeErrorMessage } from '../../../common/utils/background-reliability.util';
import { JastipService } from './jastip.service';
import { PatunganService } from './patungan.service';

/**
 * BE-COMMERCE (2026-10-01) — item 4 & cron pendukung item 13/14:
 * - Scheduled publish etalase: item isActive=false + scheduledAt <= now
 *   → isActive=true (publish otomatis saat waktunya tiba).
 * - Jastip: tutup trip yang deadline-nya lewat.
 * - Patungan: proses deadline (gagal → refund; contest selesai → released).
 *
 * Didaftarkan sebagai provider di CommerceModule — @nestjs/schedule
 * (ScheduleModule.forRoot di AppModule) otomatis menjalankan @Cron.
 */
@Injectable()
export class CommerceSchedulerService {
  private readonly logger = new Logger(CommerceSchedulerService.name);

  constructor(
    private prisma: PrismaService,
    private redis: RedisService,
    private jastipService: JastipService,
    private patunganService: PatunganService,
  ) {}

  private async withLock(lockKey: string, ttlSec: number, fn: () => Promise<void>): Promise<void> {
    if (!(await ensureRedisAvailable(this.redis, 'commerce-scheduler'))) return;
    const token = randomUUID();
    const acquired = await this.redis.setNx(lockKey, token, ttlSec);
    if (!acquired) return;
    try {
      await fn();
    } catch (error) {
      this.logger.error(`Commerce scheduler gagal: ${safeErrorMessage(error)}`);
    } finally {
      const current = await this.redis.get(lockKey).catch(() => null);
      if (current === token) await this.redis.del(lockKey).catch(() => undefined);
    }
  }

  /** Item 4: publish etalase terjadwal — tiap 1 menit. */
  @Cron('*/1 * * * *', { name: 'commerce-scheduled-publish' })
  async publishScheduledShowcases(): Promise<void> {
    await this.withLock('cron_lock:commerce_scheduled_publish', 120, async () => {
      const now = new Date();
      const due = await this.prisma.userShowcase.findMany({
        where: { isActive: false, deletedAt: null, scheduledAt: { lte: now } },
        select: { id: true },
        take: 100,
      });
      for (const item of due) {
        // Guard scheduledAt di WHERE update: item yang di-unpublish manual
        // setelah dibaca tidak ikut ter-publish (fail closed).
        await this.prisma.userShowcase.updateMany({
          where: { id: item.id, isActive: false, scheduledAt: { lte: now }, deletedAt: null },
          data: { isActive: true, scheduledAt: null },
        });
      }
      if (due.length > 0) this.logger.log(`Scheduled publish: ${due.length} etalase dipublish`);
    });
  }

  /** Item 13: tutup trip jastip yang deadline-nya lewat — tiap 5 menit. */
  @Cron('*/5 * * * *', { name: 'commerce-jastip-deadlines' })
  async closeJastipDeadlines(): Promise<void> {
    await this.withLock('cron_lock:commerce_jastip_deadlines', 300, async () => {
      const closed = await this.jastipService.closeExpiredTrips();
      if (closed > 0) this.logger.log(`Jastip: ${closed} trip ditutup (deadline lewat)`);
    });
  }

  /** Item 14: proses deadline patungan — tiap 5 menit. */
  @Cron('*/5 * * * *', { name: 'commerce-patungan-deadlines' })
  async processPatunganDeadlines(): Promise<void> {
    await this.withLock('cron_lock:commerce_patungan_deadlines', 300, async () => {
      const { failed, released } = await this.patunganService.processDeadlines();
      if (failed > 0 || released > 0) {
        this.logger.log(`Patungan: ${failed} grup gagal (refund), ${released} grup released`);
      }
    });
  }
}
