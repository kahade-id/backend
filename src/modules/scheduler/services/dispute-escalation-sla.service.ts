import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { randomUUID } from 'crypto';
import { PrismaService } from '../../../prisma/prisma.service';
import { RedisService } from '../../../redis/redis.service';
import { AuditAction, DisputeStatus, NotificationType } from '@prisma/client';
import { getCategoryForType } from '../../notifications/notification-category.map';
import { ensureRedisAvailable } from '../../../common/utils/redis-health.util';
import {
  DISPUTE_ESCALATION_SLA_WARNING_HOURS,
} from '../../../common/constants/app.constants';

/**
 * SCH-DSP-SLA2: Memantau SLA tahap kedua sengketa yang sudah ESCALATED.
 *
 * - Warning: 24 jam sebelum escalationSlaDeadlineAt → notifikasi ke kedua pihak.
 * - Breach: melewati escalationSlaDeadlineAt → tandai isEscalationSlaBreached,
 *   notifikasi urgent ke kedua pihak + audit log untuk admin.
 *
 * Berjalan tiap 30 menit. Best-effort: kegagalan notifikasi tidak membatalkan
 * penandaan SLA.
 */
@Injectable()
export class DisputeEscalationSlaService {
  private readonly logger = new Logger(DisputeEscalationSlaService.name);

  constructor(
    private prisma: PrismaService,
    private redis: RedisService,
  ) {}

  @Cron('*/30 * * * *', { name: 'dispute-escalation-sla' })
  async checkEscalationSla(): Promise<void> {
    if (!(await ensureRedisAvailable(this.redis, 'dispute-escalation-sla'))) return;

    const lockKey = 'cron_lock:dispute_escalation_sla';
    const lockToken = randomUUID();
    const acquired = await this.redis.setNx(lockKey, lockToken, 1800);
    if (!acquired) return;

    const now = new Date();
    try {
      await this.sendWarnings(now);
      await this.markBreaches(now);
    } catch (error) {
      this.logger.error('DisputeEscalationSlaService FAILED', error);
    } finally {
      await this.redis.releaseLock(lockKey, lockToken).catch((err) =>
        this.logger.warn(`silent-catch: ${err instanceof Error ? err.message : String(err)}`),
      );
    }
  }

  private async sendWarnings(now: Date): Promise<void> {
    const warningThreshold = new Date(
      now.getTime() + DISPUTE_ESCALATION_SLA_WARNING_HOURS * 60 * 60 * 1000,
    );

    const due = await this.prisma.dispute.findMany({
      where: {
        status: DisputeStatus.ESCALATED,
        escalationSlaDeadlineAt: { lte: warningThreshold, gt: now },
        escalationSlaWarningSentAt: null,
        deletedAt: null,
      },
      select: {
        id: true,
        disputeId: true,
        escalationSlaDeadlineAt: true,
        order: { select: { buyerId: true, sellerId: true } },
      },
      take: 500,
    });

    for (const dispute of due) {
      try {
        const marked = await this.prisma.dispute.updateMany({
          where: {
            id: dispute.id,
            status: DisputeStatus.ESCALATED,
            escalationSlaWarningSentAt: null,
            deletedAt: null,
          },
          data: { escalationSlaWarningSentAt: now },
        });
        if (marked.count === 0) continue;

        const parties = [dispute.order.buyerId, dispute.order.sellerId];
        const deadlineStr = dispute.escalationSlaDeadlineAt
          ? dispute.escalationSlaDeadlineAt.toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' })
          : 'segera';
        const warningTitle = 'Sengketa butuh putusan admin';
        const warningBody = `Sengketa ${dispute.disputeId} sudah dieskalasi dan menunggu putusan admin. Batas waktu: ${deadlineStr} WIB.`;
        await Promise.all(
          parties.map((partyId) =>
            this.prisma.notification
              .create({
                data: {
                  notifId: randomUUID(),
                  userId: partyId,
                  type: NotificationType.DISPUTE_ESCALATION_SLA_WARNING,
                  category: getCategoryForType(NotificationType.DISPUTE_ESCALATION_SLA_WARNING),
                  title: warningTitle,
                  body: warningBody,
                  isRead: false,
                },
              })
              .then(() => {
                // In-app row saja tidak memicu push — emit agar PushService mengirim push.
                this.prisma.emitNotificationCreated({
                  userId: partyId,
                  title: warningTitle,
                  body: warningBody,
                  data: { type: 'DISPUTE_ESCALATION_SLA_WARNING', disputeId: dispute.disputeId },
                });
              })
              .catch((err: unknown) => {
                this.logger.warn(`silent-catch: ${err instanceof Error ? err.message : String(err)}`);
              }),
          ),
        );
        this.logger.log(`Escalation SLA warning sent for dispute ${dispute.disputeId}.`);
      } catch (err: unknown) {
        this.logger.error(
          `Failed to send escalation SLA warning for ${dispute.disputeId}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  private async markBreaches(now: Date): Promise<void> {
    const breached = await this.prisma.dispute.findMany({
      where: {
        status: DisputeStatus.ESCALATED,
        escalationSlaDeadlineAt: { lt: now },
        isEscalationSlaBreached: false,
        deletedAt: null,
      },
      select: {
        id: true,
        disputeId: true,
        order: { select: { buyerId: true, sellerId: true } },
      },
      take: 500,
    });

    for (const dispute of breached) {
      try {
        const marked = await this.prisma.dispute.updateMany({
          where: {
            id: dispute.id,
            status: DisputeStatus.ESCALATED,
            escalationSlaDeadlineAt: { lt: now },
            isEscalationSlaBreached: false,
            deletedAt: null,
          },
          data: { isEscalationSlaBreached: true },
        });
        if (marked.count === 0) continue;

        this.logger.warn(`Dispute ${dispute.disputeId} breached escalation SLA.`);

        const parties = [dispute.order.buyerId, dispute.order.sellerId];
        const breachTitle = 'Sengketa diprioritaskan ke mediator senior';
        const breachBody = `Sengketa ${dispute.disputeId} melewati batas waktu putusan dan kini ditangani mediator senior. Kami akan segera memberi kabar.`;
        await Promise.all(
          parties.map((partyId) =>
            this.prisma.notification
              .create({
                data: {
                  notifId: randomUUID(),
                  userId: partyId,
                  type: NotificationType.DISPUTE_ESCALATION_SLA_BREACHED,
                  category: getCategoryForType(NotificationType.DISPUTE_ESCALATION_SLA_BREACHED),
                  title: breachTitle,
                  body: breachBody,
                  isRead: false,
                },
              })
              .then(() => {
                // In-app row saja tidak memicu push — emit agar PushService mengirim push.
                this.prisma.emitNotificationCreated({
                  userId: partyId,
                  title: breachTitle,
                  body: breachBody,
                  data: { type: 'DISPUTE_ESCALATION_SLA_BREACHED', disputeId: dispute.disputeId },
                });
              })
              .catch((err: unknown) => {
                this.logger.warn(`silent-catch: ${err instanceof Error ? err.message : String(err)}`);
              }),
          ),
        );

        const targetAdmin =
          (await this.prisma.adminUser.findFirst({
            where: { role: 'SUPER_ADMIN', isActive: true },
            orderBy: { createdAt: 'asc' },
            select: { id: true },
          })) ??
          (await this.prisma.adminUser.findFirst({
            where: { isActive: true },
            orderBy: { createdAt: 'asc' },
            select: { id: true },
          }));
        if (targetAdmin) {
          await this.prisma.adminAuditLog
            .create({
              data: {
                adminId: targetAdmin.id,
                action: AuditAction.DISPUTE_ESCALATED,
                targetType: 'Dispute',
                targetId: dispute.id,
                description: `[SYSTEM] Dispute ${dispute.disputeId} breached escalation SLA (3x24h post-escalation) — requires senior mediator decision.`,
                ipAddress: 'system',
              },
            })
            .catch((err) => {
              this.logger.error(`Failed audit log for escalation-SLA breach ${dispute.disputeId}: ${err?.message || err}`);
            });
          this.logger.error(
            `[ADMIN ALERT] Escalation SLA breached: ${dispute.disputeId} — requires senior mediator decision.`,
          );
        }
      } catch (err: unknown) {
        this.logger.error(
          `Failed to mark escalation SLA breach for ${dispute.disputeId}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }
}
