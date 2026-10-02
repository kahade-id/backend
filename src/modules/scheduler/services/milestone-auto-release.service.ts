import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { randomUUID } from 'crypto';
import { MilestoneStatus, NotificationType } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { RedisService } from '../../../redis/redis.service';
import { MilestonesService } from '../../milestones/milestones.service';
import { cronJitter } from '../../../common/utils/cron-jitter.util';
import { ensureRedisAvailable } from '../../../common/utils/redis-health.util';
import { generateNotifId } from '../../../common/utils/id-generator.util';
import { getCategoryForType } from '../../notifications/notification-category.map';
import { safeErrorMessage } from '../../../common/utils/background-reliability.util';
import { alertAdminsOnMoneyAnomaly } from '../common/money-alert.util';

/** Pengingat bertahap: H-2 sebelum auto-release (acceptedAt 5–7 hari). */
const REMINDER_AFTER_MS = 5 * 24 * 60 * 60 * 1000;
const AUTO_RELEASE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * SYS-B-307 (audit sistemik ronde 3): cron harian untuk tahap ACCEPTED
 * tanpa timeout.
 *
 * - Pengingat bertahap: tahap ACCEPTED berumur 5–7 hari → notifikasi buyer
 *   (dedup 48 jam) bahwa tahap akan dicairkan otomatis dalam ~2 hari bila
 *   tidak ada tindakan.
 * - Auto-release: tahap ACCEPTED berumur >7 hari → dicairkan otomatis via
 *   `MilestonesService.autoReleaseStaleAccepted()` (jalur release yang sama
 *   dengan release manual — atomik & idempoten).
 * - Fail-closed: tahap yang order-nya tak valid (DISPUTED/dsb) DITAHAN
 *   (tidak dicairkan) dan masuk alert admin — butuh keputusan manusia.
 */
@Injectable()
export class MilestoneAutoReleaseService {
  private readonly logger = new Logger(MilestoneAutoReleaseService.name);

  constructor(
    private prisma: PrismaService,
    private redis: RedisService,
    private milestonesService: MilestonesService,
  ) {}

  // Harian 05:00 WIB — setelah no-wallet-conservation (04:30).
  @Cron('0 5 * * *', { name: 'milestone-auto-release', timeZone: 'Asia/Jakarta' })
  async runMilestoneAutoRelease(): Promise<void> {
    await cronJitter(20_000);
    if (!(await ensureRedisAvailable(this.redis, 'milestone-auto-release'))) return;

    const lockKey = 'cron_lock:milestone_auto_release';
    const lockToken = randomUUID();
    if (!(await this.redis.setNx(lockKey, lockToken, 1200))) return;

    try {
      const reminded = await this.sendUpcomingReleaseReminders();
      const result = await this.milestonesService.autoReleaseStaleAccepted(50);

      if (result.held.length > 0) {
        await alertAdminsOnMoneyAnomaly({
          prisma: this.prisma,
          redis: this.redis,
          logger: this.logger,
          title: `Auto-release tahap DITAHAN: ${result.held.length} tahap`,
          body:
            `${result.held.length} tahap ACCEPTED melewati 7 hari tetapi TIDAK dicairkan otomatis ` +
            `karena order-nya tidak valid (kemungkinan DISPUTED/dibatalkan): ${result.held.slice(0, 10).join(', ')}. ` +
            `Dana ditahan (fail-closed) — butuh keputusan manual/CS, jangan biarkan menggantung.`,
          targetType: 'OrderMilestone',
          targetId: 'milestone-auto-release',
          redisAlertKey: 'milestone_autorelease_held',
        });
      }

      this.logger.log(
        `milestone-auto-release selesai: reminded=${reminded} checked=${result.checked} ` +
          `released=${result.released} skipped=${result.skipped} held=${result.held.length}`,
      );
      await this.redis
        .setex(
          'cron_heartbeat:milestone_auto_release',
          86400,
          JSON.stringify({ ranAt: new Date().toISOString(), reminded, ...result }),
        )
        .catch((err: unknown) => this.logger.warn(`silent-catch: ${safeErrorMessage(err)}`));
    } catch (error) {
      this.logger.error(`milestone-auto-release gagal: ${safeErrorMessage(error)}`);
    } finally {
      await this.redis.releaseLock(lockKey, lockToken).catch(() => undefined);
    }
  }

  /**
   * Pengingat H-2: ACCEPTED berumur 5–7 hari → buyer diingatkan bahwa tahap
   * akan dicairkan otomatis. Dedup via Redis agar tak spam tiap hari.
   */
  private async sendUpcomingReleaseReminders(): Promise<number> {
    const now = Date.now();
    const upcoming = await this.prisma.orderMilestone.findMany({
      where: {
        status: MilestoneStatus.ACCEPTED,
        acceptedAt: {
          lt: new Date(now - REMINDER_AFTER_MS),
          gte: new Date(now - AUTO_RELEASE_AFTER_MS),
        },
      },
      select: {
        id: true,
        seq: true,
        title: true,
        acceptedAt: true,
        order: { select: { buyerId: true, title: true } },
      },
      orderBy: { acceptedAt: 'asc' },
      take: 200,
    });

    let reminded = 0;
    for (const m of upcoming) {
      const dedup = `milestone:autorelease:reminder:${m.id}`;
      if (!(await this.redis.setNx(dedup, '1', 48 * 3600))) continue;
      try {
        await this.prisma.notification.create({
          data: {
            notifId: generateNotifId(),
            userId: m.order.buyerId,
            type: NotificationType.MILESTONE_DEADLINE_REMINDER,
            category: getCategoryForType(NotificationType.MILESTONE_DEADLINE_REMINDER),
            title: 'Tahap Akan Dicairkan Otomatis',
            body:
              `Tahap ${m.seq} "${m.title}" order "${m.order.title}" akan dicairkan otomatis ` +
              `dalam 2 hari. Buka sengketa atau hubungi CS bila ada masalah.`,
            isRead: false,
            refType: 'MILESTONE',
            refId: m.id,
          },
        });
        reminded++;
      } catch (err: unknown) {
        this.logger.warn(`silent-catch: reminder auto-release gagal: ${safeErrorMessage(err)}`);
      }
    }
    return reminded;
  }
}
