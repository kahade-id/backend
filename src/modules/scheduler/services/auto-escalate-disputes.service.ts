import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { randomUUID } from 'crypto';
import { PrismaService } from '../../../prisma/prisma.service';
import { RedisService } from '../../../redis/redis.service';
import { AuditAction, DisputeStatus, MembershipRank, NotificationType } from '@prisma/client';
import { getCategoryForType } from '../../notifications/notification-category.map';
import { ensureRedisAvailable } from '../../../common/utils/redis-health.util';

const RANK_PRIORITY: Record<MembershipRank, number> = {
  BRONZE: 0,
  SILVER: 0,
  GOLD: 1,
  PLATINUM: 2,
  DIAMOND: 3,
};

@Injectable()
export class AutoEscalateDisputesService {
  private readonly logger = new Logger(AutoEscalateDisputesService.name);

  constructor(
    private prisma: PrismaService,
    private redis: RedisService,
  ) {}

  // SCH-017: Runs every hour to escalate SLA-breached disputes
  @Cron('0 * * * *', { name: 'auto-escalate-disputes' })
  async escalateBreachedDisputes(): Promise<void> {
    if (!(await ensureRedisAvailable(this.redis, 'auto-escalate-disputes'))) return;

    const lockKey = 'cron_lock:auto_escalate_disputes';
    const lockToken = randomUUID();
    const acquired = await this.redis.setNx(lockKey, lockToken, 1800);
    if (!acquired) return;

    const now = new Date();
    try {
      const escalatableStatuses: DisputeStatus[] = [
        DisputeStatus.OPEN,
        DisputeStatus.ASSIGNED,
        DisputeStatus.UNDER_REVIEW,
        DisputeStatus.WAITING_RESPONSE,
      ];

      while (true) {
      const breached = (await this.prisma.dispute.findMany({
        where: {
          status: { in: escalatableStatuses },
          slaDeadlineAt: { lt: now },
          isSlaBreached: false,
          deletedAt: null,
        },
        select: {
          id: true,
          disputeId: true,
          status: true,
          order: {
            select: {
              buyerId: true,
              sellerId: true,
              buyer: { select: { membershipRank: true } },
              seller: { select: { membershipRank: true } },
            },
          },
        },
        orderBy: [{ slaDeadlineAt: 'asc' }, { id: 'asc' }],
        take: 500,
      })).sort((a, b) => {
        const aPriority = Math.max(RANK_PRIORITY[a.order.buyer.membershipRank], RANK_PRIORITY[a.order.seller.membershipRank]);
        const bPriority = Math.max(RANK_PRIORITY[b.order.buyer.membershipRank], RANK_PRIORITY[b.order.seller.membershipRank]);
        return bPriority - aPriority;
      });

      if (breached.length === 0) break;

      this.logger.log(`Auto-escalating ${breached.length} SLA-breached dispute(s).`);
      let escalatedInBatch = 0;

      for (const dispute of breached) {
        try {
          const updated = await this.prisma.dispute.updateMany({
            where: {
              id: dispute.id,
              status: { in: escalatableStatuses },
              slaDeadlineAt: { lt: now },
              isSlaBreached: false,
              deletedAt: null,
            },
            data: {
              status: DisputeStatus.ESCALATED,
              isSlaBreached: true,
            },
          });
          if (updated.count > 0) {
            escalatedInBatch += updated.count;
            this.logger.warn(`Dispute ${dispute.disputeId} escalated due to SLA breach.`);

            // NOTIF-DSP-03: para pihak wajib tahu sengketanya dieskalasi otomatis.
            // Best-effort: kegagalan notifikasi tidak membatalkan eskalasi.
            const escalatedParties = [dispute.order.buyerId, dispute.order.sellerId];
            await Promise.all(escalatedParties.map((partyId) =>
              this.prisma.notification.create({
                data: {
                  notifId: randomUUID(),
                  userId: partyId,
                  type: NotificationType.DISPUTE_ESCALATED,
                  category: getCategoryForType(NotificationType.DISPUTE_ESCALATED),
                  title: 'Sengketa dieskalasi',
                  body: `Sengketa ${dispute.disputeId} melewati batas waktu penanganan dan kini diprioritaskan ke tim mediator.`,
                  isRead: false,
                },
              }).catch((err: unknown) => {
                this.logger.warn(`silent-catch: ${err instanceof Error ? err.message : String(err)}`);
              }),
            ));

            const systemAdmin = await this.prisma.adminUser.findFirst({
              where: { role: 'SUPER_ADMIN', isActive: true },
              orderBy: { createdAt: 'asc' },
              select: { id: true },
            });
            const targetAdmin = systemAdmin ?? await this.prisma.adminUser.findFirst({
              where: { isActive: true },
              orderBy: { createdAt: 'asc' },
              select: { id: true },
            });
            if (targetAdmin) {
              await this.prisma.adminAuditLog.create({
                data: {
                  adminId: targetAdmin.id,
                  action: AuditAction.DISPUTE_ESCALATED,
                  targetType: 'Dispute',
                  targetId: dispute.id,
                  description: `[SYSTEM] Dispute ${dispute.disputeId} auto-escalated — SLA breached. Requires immediate attention.${!systemAdmin ? ' (No SUPER_ADMIN available)' : ''}`,
                  ipAddress: 'system',
                },
              }).catch((err) => {
                this.logger.error(`Failed to create audit log for escalated dispute ${dispute.disputeId}: ${err?.message || err}`);
              });

              this.logger.error(`[ADMIN ALERT] Dispute SLA Breached: ${dispute.disputeId} auto-escalated — requires immediate admin attention.`);
            } else {
              this.logger.warn(`No active admin found for escalation of dispute ${dispute.disputeId}`);
            }
          }
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          this.logger.error(`Failed to escalate dispute ${dispute.disputeId}: ${msg}`);
        }
      }
      if (breached.length < 500 || escalatedInBatch === 0) break;
      }
    } catch (error) {
      this.logger.error('AutoEscalateDisputes FAILED', error);
    } finally {
      await this.redis.releaseLock(lockKey, lockToken).catch((err) => this.logger.warn(`silent-catch: ${err instanceof Error ? err.message : String(err)}`));
    }
  }
}
