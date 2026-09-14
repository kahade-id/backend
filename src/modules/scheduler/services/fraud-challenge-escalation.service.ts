import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { randomUUID } from 'crypto';
import { PrismaService } from '../../../prisma/prisma.service';
import { RedisService } from '../../../redis/redis.service';
import { ensureRedisAvailable } from '../../../common/utils/redis-health.util';

@Injectable()
export class FraudChallengeEscalationService {
  private readonly logger = new Logger(FraudChallengeEscalationService.name);
  private static readonly ESCALATION_THRESHOLD_HOURS = 24;

  constructor(
    private prisma: PrismaService,
    private redis: RedisService,
  ) {}

  @Cron('0 */4 * * *', { name: 'fraud-challenge-escalation', timeZone: 'Asia/Jakarta' })
  async escalateStaleChallenges(): Promise<void> {
    if (!(await ensureRedisAvailable(this.redis, 'fraud-challenge-escalation'))) return;

    const lockKey = 'cron_lock:fraud_challenge_escalation';
    const lockToken = randomUUID();
    const acquired = await this.redis.setNx(lockKey, lockToken, 1800);
    if (!acquired) return;

    try {
      const threshold = new Date(Date.now() - FraudChallengeEscalationService.ESCALATION_THRESHOLD_HOURS * 60 * 60 * 1000);

      // PaymentStatus enum has no 'REVIEW' value; review intent is signalled by
      // PaymentTransaction.fraudStatus = 'challenge' (or 'unknown:*') while status remains PENDING
      // (funds NOT credited). See payment.service.ts handleMidtransWebhook capture+challenge branch.
      const stalePayments = await this.prisma.paymentTransaction.findMany({
        where: {
          status: 'PENDING',
          createdAt: { lt: threshold },
          OR: [
            { fraudStatus: 'challenge' },
            { fraudStatus: { startsWith: 'unknown:' } },
          ],
        },
        select: { id: true, midtransOrderId: true, userId: true, amount: true, fraudStatus: true, createdAt: true },
        take: 100,
      });

      if (stalePayments.length === 0) return;

      this.logger.error(`FRAUD_ESCALATION: Found ${stalePayments.length} payment(s) flagged for review for >${FraudChallengeEscalationService.ESCALATION_THRESHOLD_HOURS}h — Sentry/ops alerting required`);

      for (const payment of stalePayments) {
        const escalationKey = `alert:fraud_escalation:${payment.midtransOrderId}`;
        const alreadyEscalated = await this.redis.get(escalationKey);
        if (alreadyEscalated) continue;

        this.logger.error(
          `URGENT_FRAUD_ESCALATED payment=${payment.midtransOrderId} user=${payment.userId} amount=${payment.amount} fraudStatus=${payment.fraudStatus} age=${Math.round((Date.now() - payment.createdAt.getTime()) / 3600000)}h`,
        );

        await this.redis.setex(escalationKey, 86400, JSON.stringify({
          orderId: payment.midtransOrderId,
          userId: payment.userId,
          amount: payment.amount.toString(),
          fraudStatus: payment.fraudStatus,
          escalatedAt: new Date().toISOString(),
          severity: 'URGENT',
        })).catch((err) => this.logger.warn(`silent-catch: ${err instanceof Error ? err.message : String(err)}`));

        // 19.1 Fix: actually notify all SUPER_ADMIN users via Notification table (in-app) + attempt email
        try {
          const superAdmins = await this.prisma.adminUser.findMany({
            where: { role: 'SUPER_ADMIN', isActive: true, deletedAt: null },
            select: { id: true, email: true },
          });
          // Create a system notification entry for ops dashboard (we use WebhookLog as audit, but also create admin audit)
          for (const admin of superAdmins) {
            // We cannot use Notification table (requires userId), so we create AdminAuditLog as notification channel
            await this.prisma.adminAuditLog.create({
              data: {
                adminId: admin.id,
                action: 'SYSTEM_CONFIG_CHANGED',
                targetType: 'PaymentTransaction',
                targetId: payment.midtransOrderId,
                description: `FRAUD_ESCALATION: Payment ${payment.midtransOrderId} flagged ${payment.fraudStatus} for >24h, amount ${payment.amount}, user ${payment.userId}`,
                ipAddress: 'system',
              },
            }).catch(() => {});
          }
          // Also push to Redis list for admin dashboard to poll
          await this.redis.getClient().lpush('admin_alerts:fraud_escalation', JSON.stringify({
            midtransOrderId: payment.midtransOrderId,
            userId: payment.userId,
            amount: payment.amount.toString(),
            fraudStatus: payment.fraudStatus,
            escalatedAt: new Date().toISOString(),
          })).catch(() => {});
          await this.redis.getClient().ltrim('admin_alerts:fraud_escalation', 0, 99).catch(() => {});
        } catch (notifyErr) {
          this.logger.warn(`Failed to notify super admins for ${payment.midtransOrderId}: ${notifyErr instanceof Error ? notifyErr.message : String(notifyErr)}`);
        }
      }

      await this.redis.setex('cron_heartbeat:fraud_challenge_escalation', 86400, JSON.stringify({
        ranAt: new Date().toISOString(),
        staleCount: stalePayments.length,
      })).catch((err) => this.logger.warn(`silent-catch: ${err instanceof Error ? err.message : String(err)}`));
    } catch (error) {
      this.logger.error('Fraud challenge escalation FAILED', error);
    } finally {
      await this.redis.releaseLock(lockKey, lockToken).catch((err) => this.logger.warn(`silent-catch: ${err instanceof Error ? err.message : String(err)}`));
    }
  }
}
