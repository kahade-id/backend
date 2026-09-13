import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { randomUUID } from 'crypto';
import { Prisma, SubscriptionStatus } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { RedisService } from '../../../redis/redis.service';
import { cronJitter } from '../../../common/utils/cron-jitter.util';
import { ensureRedisAvailable } from '../../../common/utils/redis-health.util';
import { VerificationBadgeService } from '../../users/verification-badge.service';

@Injectable()
export class SubscriptionAutoResumeService {
  private readonly logger = new Logger(SubscriptionAutoResumeService.name);

  constructor(
    private prisma: PrismaService,
    private redis: RedisService,
    private verificationBadgeService: VerificationBadgeService,
  ) {}

  @Cron('*/5 * * * *', { name: 'subscription-auto-resume' })
  async handleAutoResume(): Promise<void> {
    await cronJitter(10_000);
    if (!(await ensureRedisAvailable(this.redis, 'subscription-auto-resume'))) return;

    const lockKey = 'cron_lock:subscription_auto_resume';
    const lockToken = randomUUID();
    const acquired = await this.redis.setNx(lockKey, lockToken, 600);
    if (!acquired) return;

    try {
      const now = new Date();
      const expiredPaused = await this.prisma.subscription.findMany({
        where: { status: SubscriptionStatus.PAUSED, currentPeriodEnd: { lte: now } },
        orderBy: [{ currentPeriodEnd: 'asc' }, { id: 'asc' }],
        take: 200,
      });
      for (const sub of expiredPaused) {
        const expired = await this.prisma.subscription.updateMany({
          where: { id: sub.id, status: SubscriptionStatus.PAUSED, currentPeriodEnd: { lte: now } },
          data: { status: SubscriptionStatus.EXPIRED, isAutoRenew: false },
        });
        if (expired.count > 0) {
          await this.prisma.user.update({ where: { id: sub.userId }, data: { isKahadePlus: false, subscriptionExpiresAt: null } });
          await this.redis.del(`subscription_status:${sub.userId}`).catch(() => undefined);
          await this.verificationBadgeService.invalidate(sub.userId);
        }
      }

      const due = await this.prisma.subscription.findMany({
        where: {
          status: SubscriptionStatus.PAUSED,
          resumeAt: { lte: now },
          currentPeriodEnd: { gt: now },
        },
        orderBy: [{ resumeAt: 'asc' }, { id: 'asc' }],
        take: 200,
      });
      for (const sub of due) {
        try {
          const resumed = await this.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
            const updated = await tx.subscription.updateMany({
              where: {
                id: sub.id,
                status: SubscriptionStatus.PAUSED,
                resumeAt: { lte: now },
                currentPeriodEnd: { gt: now },
              },
              data: { status: SubscriptionStatus.ACTIVE, pausedAt: null, resumeAt: null },
            });
            if (updated.count === 0) return false;
            await tx.user.update({
              where: { id: sub.userId },
              data: { isKahadePlus: true, subscriptionExpiresAt: sub.currentPeriodEnd },
            });
            return true;
          }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
          if (resumed) {
            await this.redis.del(`subscription_status:${sub.userId}`).catch(() => undefined);
            await this.verificationBadgeService.invalidate(sub.userId);
            this.logger.log(`Auto-resumed subscription ${sub.id} for user ${sub.userId}`);
          }
        } catch (error: unknown) {
          this.logger.error(`Failed to auto-resume subscription ${sub.id}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    } finally {
      await this.redis.releaseLock(lockKey, lockToken).catch((err) => this.logger.warn(`silent-catch: ${err instanceof Error ? err.message : String(err)}`));
    }
  }
}
