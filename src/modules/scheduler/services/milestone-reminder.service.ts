// GAP-C (G182): pengingat deadline & review milestone.
//
// - Tahap SUBMITTED dengan reviewDeadline < 24 jam → ingatkan buyer.
// - Deadline tahap terlewati (belum submit) → ingatkan buyer + seller.
// - reviewDeadline terlewati → ingatkan buyer (terima/minta revisi/sengketa).
//
// TIDAK ada auto-accept: keputusan produk — melewati reviewDeadline tidak
// otomatis menerima tahap. Hanya pengingat.
import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { randomUUID } from 'crypto';
import { MilestoneStatus, NotificationType } from '@prisma/client';
import { getCategoryForType } from '../../notifications/notification-category.map';
import { PrismaService } from '../../../prisma/prisma.service';
import { RedisService } from '../../../redis/redis.service';
import { generateNotifId } from '../../../common/utils/id-generator.util';
import { ensureRedisAvailable } from '../../../common/utils/redis-health.util';
import { safeErrorMessage } from '../../../common/utils/background-reliability.util';

@Injectable()
export class MilestoneReminderService {
  private readonly logger = new Logger(MilestoneReminderService.name);

  constructor(
    private prisma: PrismaService,
    private redis: RedisService,
  ) {}

  private async notify(userId: string, type: NotificationType, title: string, body: string, milestoneId: string) {
    try {
      await this.prisma.notification.create({
        data: {
          notifId: generateNotifId(),
          userId,
          type,
          category: getCategoryForType(type),
          title,
          body,
          isRead: false,
          refType: 'MILESTONE',
          refId: milestoneId,
        },
      });
    } catch (err: unknown) {
      this.logger.warn(`silent-catch: milestone reminder notification failed: ${safeErrorMessage(err)}`);
    }
  }

  @Cron('*/30 * * * *', { name: 'milestone-reminders', timeZone: 'Asia/Jakarta' })
  async sendMilestoneReminders(): Promise<void> {
    if (!(await ensureRedisAvailable(this.redis, 'milestone-reminders'))) return;

    const lockKey = 'cron_lock:milestone_reminders';
    const lockToken = randomUUID();
    const acquired = await this.redis.setNx(lockKey, lockToken, 1500);
    if (!acquired) return;

    const now = new Date();
    try {
      // 1. Review hampir kedaluwarsa (< 24 jam) → buyer.
      const reviewSoon = await this.prisma.orderMilestone.findMany({
        where: {
          status: MilestoneStatus.SUBMITTED,
          reviewDeadline: { gt: now, lt: new Date(now.getTime() + 24 * 60 * 60 * 1000) },
        },
        select: { id: true, seq: true, title: true, reviewDeadline: true, order: { select: { buyerId: true, title: true } } },
        take: 200,
      });
      for (const m of reviewSoon) {
        const dedup = `reminder:milestone:review:${m.id}`;
        if (!(await this.redis.setNx(dedup, '1', 24 * 3600))) continue;
        await this.notify(
          m.order.buyerId,
          NotificationType.MILESTONE_DEADLINE_REMINDER,
          'Segera Tinjau Tahap',
          `Tahap ${m.seq} "${m.title}" order "${m.order.title}" menunggu tinjauan Anda. Batas tinjau kurang dari 24 jam.`,
          m.id,
        );
      }

      // 2. reviewDeadline terlewati tapi belum diputuskan → buyer (+ seller info).
      const reviewOverdue = await this.prisma.orderMilestone.findMany({
        where: { status: MilestoneStatus.SUBMITTED, reviewDeadline: { lt: now } },
        select: { id: true, seq: true, title: true, order: { select: { buyerId: true, sellerId: true, title: true } } },
        take: 200,
      });
      for (const m of reviewOverdue) {
        const dedup = `reminder:milestone:review-overdue:${m.id}`;
        if (!(await this.redis.setNx(dedup, '1', 24 * 3600))) continue;
        await this.notify(
          m.order.buyerId,
          NotificationType.MILESTONE_DEADLINE_REMINDER,
          'Batas Tinjau Tahap Terlewati',
          `Tahap ${m.seq} "${m.title}" belum Anda putuskan. Silakan terima, minta revisi, atau buka sengketa. Tahap TIDAK diterima otomatis.`,
          m.id,
        );
      }

      // 3. Deadline pengerjaan terlewati (belum diserahkan) → buyer + seller.
      const workOverdue = await this.prisma.orderMilestone.findMany({
        where: {
          status: { in: [MilestoneStatus.AWAITING_ACTIVATION, MilestoneStatus.REVISION_REQUESTED] },
          deadline: { lt: now },
        },
        select: { id: true, seq: true, title: true, order: { select: { buyerId: true, sellerId: true, title: true } } },
        take: 200,
      });
      for (const m of workOverdue) {
        const dedup = `reminder:milestone:work-overdue:${m.id}`;
        if (!(await this.redis.setNx(dedup, '1', 24 * 3600))) continue;
        await this.notify(
          m.order.sellerId,
          NotificationType.MILESTONE_DEADLINE_REMINDER,
          'Deadline Tahap Terlewati',
          `Tahap ${m.seq} "${m.title}" order "${m.order.title}" melewati deadline. Segera serahkan hasil atau ajukan perpanjangan.`,
          m.id,
        );
        await this.notify(
          m.order.buyerId,
          NotificationType.MILESTONE_DEADLINE_REMINDER,
          'Keterlambatan Tahap',
          `Tahap ${m.seq} "${m.title}" order "${m.order.title}" melewati deadline pengerjaan.`,
          m.id,
        );
      }

      this.logger.log(
        `Milestone reminders selesai: reviewSoon=${reviewSoon.length}, reviewOverdue=${reviewOverdue.length}, workOverdue=${workOverdue.length}.`,
      );
    } catch (error) {
      this.logger.error(`Milestone reminders gagal: ${safeErrorMessage(error)}`);
      throw error;
    } finally {
      await this.redis.del(lockKey).catch(() => undefined);
    }
  }
}
