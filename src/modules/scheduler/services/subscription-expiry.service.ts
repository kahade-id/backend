import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import { randomUUID } from 'crypto';
import { Prisma, SubscriptionPlan, SubscriptionStatus, WalletTransactionType, WalletTransactionStatus, NotificationType } from '@prisma/client';
import { getCategoryForType } from '../../notifications/notification-category.map';
import { PrismaService } from '../../../prisma/prisma.service';
import { RedisService } from '../../../redis/redis.service';
import { cronJitter } from '../../../common/utils/cron-jitter.util';
import { WalletTxSerialService } from '../../../common/services/wallet-tx-serial.service';
import { generateWalletTxId, generateNotifId } from '../../../common/utils/id-generator.util';
import { toSen } from '../../../common/utils/currency.util';
import { SUBSCRIPTION_MONTHLY_PRICE, SUBSCRIPTION_ANNUAL_PRICE } from '../../../common/constants/app.constants';
import { ensureRedisAvailable } from '../../../common/utils/redis-health.util';

const PLAN_METADATA: Record<SubscriptionPlan, { durationDays: number; label: string }> = {
  MONTHLY: { durationDays: 30, label: 'Kahade Plus Monthly' },
  ANNUAL: { durationDays: 366, label: 'Kahade Plus Annual' },
};

const GRACE_PERIOD_DAYS = 3;

@Injectable()
export class SubscriptionExpiryService {
  private readonly logger = new Logger(SubscriptionExpiryService.name);
  private readonly planPricing: Record<SubscriptionPlan, { price: bigint; durationDays: number; label: string }>;

  constructor(
    private prisma: PrismaService,
    private redis: RedisService,
    private walletTxSerialService: WalletTxSerialService,
    private configService: ConfigService,
  ) {
    const monthlyPriceSen = this.configService.get<number>('app.subscriptionMonthlyPriceSen')
      ?? SUBSCRIPTION_MONTHLY_PRICE * 100;
    const annualPriceSen = this.configService.get<number>('app.subscriptionAnnualPriceSen')
      ?? SUBSCRIPTION_ANNUAL_PRICE * 100;
    this.planPricing = {
      MONTHLY: { price: BigInt(monthlyPriceSen), ...PLAN_METADATA.MONTHLY },
      ANNUAL: { price: BigInt(annualPriceSen), ...PLAN_METADATA.ANNUAL },
    };
  }

  // SCH-017: Runs every 15 minutes for subscription expiry + auto-renewal
  @Cron('*/15 * * * *', { name: 'subscription-expiry' })
  async handleExpiredSubscriptions(): Promise<void> {
    await cronJitter(15_000);
    if (!(await ensureRedisAvailable(this.redis, 'subscription-expiry'))) return;

    const lockKey = 'cron_lock:subscription_expiry';
    const lockToken = randomUUID();
    const acquired = await this.redis.setNx(lockKey, lockToken, 600);
    if (!acquired) return;

    const now = new Date();
    try {
      await this.sendExpiryReminders(now);

      await this.processExpiredSubscriptions(now);

      await this.processGracePeriodExpired(now);
    } catch (error) {
      this.logger.error('SubscriptionExpiry FAILED', error);
    } finally {
      await this.redis.releaseLock(lockKey, lockToken).catch((err) => this.logger.warn(`silent-catch: ${err instanceof Error ? err.message : String(err)}`));
    }
  }

  private async tryAutoRenew(sub: { id: string; userId: string; plan: SubscriptionPlan; status: SubscriptionStatus; currentPeriodEnd: Date | null; user: { id: string } }): Promise<'SUCCESS' | 'INSUFFICIENT_BALANCE' | 'TRANSIENT_ERROR'> {
    const planInfo = this.planPricing[sub.plan];
    if (!planInfo) return 'INSUFFICIENT_BALANCE';

    const MAX_OCC_RETRIES = 3;
    for (let attempt = 1; attempt <= MAX_OCC_RETRIES; attempt++) {
      try {
        const walletTxSerial = await this.walletTxSerialService.getNext();
        const now = new Date();
        const renewBase = sub.status === SubscriptionStatus.ACTIVE
          && sub.currentPeriodEnd
          && sub.currentPeriodEnd > now
          ? new Date(sub.currentPeriodEnd)
          : now;
        const newPeriodEnd = new Date(renewBase);
        newPeriodEnd.setDate(newPeriodEnd.getDate() + planInfo.durationDays);
        const feeSavingsLimitIdr = this.configService.get<number>('app.feeSavingsLimit') ?? 5000000;
        const feeSavingsLimitSen = toSen(feeSavingsLimitIdr);

        await this.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
          const wallet = await tx.wallet.findUnique({ where: { userId: sub.userId } });
          if (!wallet || wallet.availableBalance < planInfo.price) {
            throw new Error('INSUFFICIENT_BALANCE');
          }

          const walletUpdated = await tx.wallet.updateMany({
            where: { id: wallet.id, version: wallet.version, availableBalance: { gte: planInfo.price } },
            data: {
              availableBalance: { decrement: planInfo.price },
              totalBalance: { decrement: planInfo.price },
              version: { increment: 1 },
            },
          });

          if (walletUpdated.count === 0) {
            throw new Error('WALLET_OCC_CONFLICT');
          }

          const walletTxId = generateWalletTxId(walletTxSerial);
          await tx.walletTransaction.create({
            data: {
              txId: walletTxId,
              walletId: wallet.id,
              type: WalletTransactionType.SUBSCRIPTION_PAYMENT,
              status: WalletTransactionStatus.SUCCESS,
              amount: planInfo.price,
              balanceBefore: wallet.totalBalance,
              balanceAfter: wallet.totalBalance - planInfo.price,
              description: `${planInfo.label} auto-renewal`,
            },
          });

          const subUpdated = await tx.subscription.updateMany({
            where: {
              id: sub.id,
              status: { in: [SubscriptionStatus.ACTIVE, SubscriptionStatus.SUSPENDED] },
              currentPeriodEnd: sub.currentPeriodEnd,
            },
            data: {
              status: SubscriptionStatus.ACTIVE,
              currentPeriodStart: now,
              currentPeriodEnd: newPeriodEnd,
              lastPaymentAt: now,
              nextPaymentAt: newPeriodEnd,
              feeSavingsUsed: BigInt(0),
              feeSavingsLimit: feeSavingsLimitSen,
              cancelledAt: null,
              cancelReason: null,
            },
          });

          if (subUpdated.count === 0) {
            throw new Error('SUBSCRIPTION_ALREADY_RENEWED');
          }

          await tx.user.update({
            where: { id: sub.user.id },
            data: {
              isKahadePlus: true,
              subscriptionExpiresAt: newPeriodEnd,
            },
          });
        }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });

        try {
          await this.prisma.notification.create({
            data: {
              notifId: generateNotifId(),
              userId: sub.userId,
              type: NotificationType.SUBSCRIPTION_RENEWED,
              category: getCategoryForType(NotificationType.SUBSCRIPTION_RENEWED),
              title: 'Kahade Plus Auto-Renewed',
              body: `Your ${planInfo.label} subscription has been auto-renewed successfully. Enjoy your continued Plus benefits!`,
              isRead: false,
            },
          });
          this.prisma.emitNotificationCreated({ userId: sub.userId, title: 'Kahade Plus Auto-Renewed', body: `Your ${planInfo.label} subscription has been auto-renewed.`, data: { type: 'SUBSCRIPTION_RENEWED' } });
        } catch (notifErr) {
          this.logger.warn(`Auto-renewal succeeded for subscription ${sub.id} but notification failed: ${notifErr instanceof Error ? notifErr.message : String(notifErr)}`);
        }

        return 'SUCCESS';
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        if (message === 'INSUFFICIENT_BALANCE') {
          return 'INSUFFICIENT_BALANCE';
        }
        if (message === 'SUBSCRIPTION_ALREADY_RENEWED') {
          this.logger.log(`Subscription ${sub.id} was already renewed concurrently — skipping.`);
          return 'SUCCESS';
        }
        if (message === 'WALLET_OCC_CONFLICT' && attempt < MAX_OCC_RETRIES) {
          this.logger.warn(`Auto-renewal OCC conflict for subscription ${sub.id} — retry ${attempt}/${MAX_OCC_RETRIES}`);
          await new Promise(resolve => setTimeout(resolve, 50 * attempt));
          continue;
        }
        return 'TRANSIENT_ERROR';
      }
    }
    return 'TRANSIENT_ERROR';
  }

  private async processExpiredSubscriptions(now: Date): Promise<void> {
    const expiredSubs = await this.prisma.subscription.findMany({
      where: {
        status: { in: ['ACTIVE', 'CANCELLED'] },
        currentPeriodEnd: { lt: now },
      },
      include: { user: { select: { id: true } } },
      take: 500,
    });

    if (expiredSubs.length === 0) return;

    this.logger.log(`Found ${expiredSubs.length} expired subscription(s) — processing.`);

    for (const sub of expiredSubs) {
      try {
        if (sub.isAutoRenew && sub.status === SubscriptionStatus.ACTIVE) {
          const renewResult = await this.tryAutoRenew(sub);
          if (renewResult === 'SUCCESS') {
            this.logger.log(`Auto-renewed subscription ${sub.id} for user ${sub.userId}`);
            continue;
          }
          if (renewResult === 'TRANSIENT_ERROR') {
            this.logger.warn(`Auto-renewal transient error for subscription ${sub.id} — will retry next run.`);
            continue;
          }
          this.logger.warn(`Auto-renewal failed for subscription ${sub.id} (insufficient balance) — entering grace period.`);
        }

        const graceBase = sub.currentPeriodEnd ? new Date(sub.currentPeriodEnd) : now;
        const graceEnd = new Date(graceBase.getTime() + GRACE_PERIOD_DAYS * 86_400_000);

        const wasAutoRenewEnabled = sub.isAutoRenew;

        const suspended = await this.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
          const updated = await tx.subscription.updateMany({
            where: {
              id: sub.id,
              status: { in: [SubscriptionStatus.ACTIVE, SubscriptionStatus.CANCELLED] },
              currentPeriodEnd: { lt: now },
            },
            data: {
              status: SubscriptionStatus.SUSPENDED,
              isAutoRenew: wasAutoRenewEnabled,
              currentPeriodEnd: graceEnd,
            },
          });

          if (updated.count === 0) return false;

          await tx.user.update({
            where: { id: sub.user.id },
            data: {
              subscriptionExpiresAt: graceEnd,
            },
          });

          const wasAutoRenewFailure = wasAutoRenewEnabled && sub.status === SubscriptionStatus.ACTIVE;
          await tx.notification.create({
            data: {
              notifId: generateNotifId(),
              userId: sub.userId,
              type: NotificationType.SUBSCRIPTION_EXPIRY_REMINDER,
              category: getCategoryForType(NotificationType.SUBSCRIPTION_EXPIRY_REMINDER),
              title: wasAutoRenewFailure ? 'Auto-Renewal Failed' : 'Kahade Plus Grace Period',
              body: wasAutoRenewFailure
                ? `Your Kahade Plus auto-renewal failed due to insufficient wallet balance. You have ${GRACE_PERIOD_DAYS} days to renew manually before losing your benefits.`
                : `Your Kahade Plus subscription period has ended. You have ${GRACE_PERIOD_DAYS} days to renew before your benefits are revoked.`,
              isRead: false,
            },
          });

          return true;
        });

        if (suspended) {
          this.logger.log(`Subscription ${sub.id} entered ${GRACE_PERIOD_DAYS}-day grace period (SUSPENDED) for user ${sub.userId}`);
          this.prisma.emitNotificationCreated({ userId: sub.userId, title: 'Kahade Plus Grace Period', body: `You have ${GRACE_PERIOD_DAYS} days to renew your subscription.`, data: { type: 'SUBSCRIPTION_EXPIRY_REMINDER' } });
        } else {
          this.logger.log(`Subscription ${sub.id} already modified — skipping grace period.`);
        }
      } catch (err: unknown) {
        this.logger.error(`Failed to process expired subscription ${sub.id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  private async processGracePeriodExpired(now: Date): Promise<void> {
    const suspendedSubs = await this.prisma.subscription.findMany({
      where: {
        status: SubscriptionStatus.SUSPENDED,
      },
      include: { user: { select: { id: true } } },
      take: 500,
    });

    if (suspendedSubs.length === 0) return;

    for (const sub of suspendedSubs) {
      try {
        if (sub.isAutoRenew) {
          const renewResult = await this.tryAutoRenew(sub);
          if (renewResult === 'SUCCESS') {
            this.logger.log(`Auto-renewed SUSPENDED subscription ${sub.id} for user ${sub.userId} during grace period`);
            continue;
          }
          if (renewResult === 'TRANSIENT_ERROR') {
            this.logger.warn(`Auto-renewal transient error for SUSPENDED subscription ${sub.id} — will retry next run.`);
            continue;
          }
          this.logger.warn(`Auto-renewal still failing for SUSPENDED subscription ${sub.id} (insufficient balance).`);
        }

        if (sub.currentPeriodEnd && sub.currentPeriodEnd >= now) {
          continue;
        }

        const expired = await this.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
          const updated = await tx.subscription.updateMany({
            where: {
              id: sub.id,
              status: SubscriptionStatus.SUSPENDED,
              currentPeriodEnd: { lt: now },
            },
            data: {
              status: SubscriptionStatus.EXPIRED,
              isAutoRenew: false,
            },
          });

          if (updated.count === 0) return false;

          await tx.user.update({
            where: { id: sub.user.id },
            data: {
              isKahadePlus: false,
              subscriptionExpiresAt: null,
            },
          });

          await tx.notification.create({
            data: {
              notifId: generateNotifId(),
              userId: sub.userId,
              type: NotificationType.SUBSCRIPTION_EXPIRED,
              category: getCategoryForType(NotificationType.SUBSCRIPTION_EXPIRED),
              title: 'Kahade Plus Subscription Expired',
              body: 'Your Kahade Plus grace period has ended and your subscription is now expired. Service fees will revert to the standard rate. Subscribe again to enjoy lower fees.',
              isRead: false,
            },
          });

          return true;
        });

        if (expired) {
          this.logger.log(`Fully expired subscription ${sub.id} for user ${sub.userId}`);
          this.prisma.emitNotificationCreated({ userId: sub.userId, title: 'Kahade Plus Subscription Expired', body: 'Your Kahade Plus subscription has expired.', data: { type: 'SUBSCRIPTION_EXPIRED' } });
        }
      } catch (err: unknown) {
        this.logger.error(`Failed to expire suspended subscription ${sub.id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  // SCH-026: Pre-expiry notifications at 3 days, 1 day before expiry
  private async sendExpiryReminders(now: Date): Promise<void> {
    const REMINDER_WINDOWS = [
      { days: 3, label: '3 days' },
      { days: 1, label: '1 day' },
    ];
    const reminderRedisPrefix = 'sub_expiry_reminder:';

    for (const window of REMINDER_WINDOWS) {
      const windowStart = new Date(now.getTime() + (window.days - 1) * 86_400_000);
      const windowEnd = new Date(now.getTime() + window.days * 86_400_000);

      const subs = await this.prisma.subscription.findMany({
        where: {
          status: { in: [SubscriptionStatus.ACTIVE, SubscriptionStatus.CANCELLED] },
          isAutoRenew: false,
          currentPeriodEnd: { gte: windowStart, lt: windowEnd },
        },
        select: { id: true, userId: true },
        take: 500,
      });

      for (const sub of subs) {
        const reminderKey = `${reminderRedisPrefix}${sub.id}:${window.days}d`;
        const alreadySent = await this.redis.get(reminderKey);
        if (alreadySent) continue;

        try {
          await this.prisma.notification.create({
            data: {
              notifId: generateNotifId(),
              userId: sub.userId,
              type: NotificationType.SUBSCRIPTION_EXPIRY_REMINDER,
              category: getCategoryForType(NotificationType.SUBSCRIPTION_EXPIRY_REMINDER),
              title: 'Plus Subscription Expiring Soon',
              body: `Your Kahade Plus subscription will expire in ${window.label}. Renew now to keep your Plus benefits active.`,
              isRead: false,
            },
          });
          await this.redis.setex(reminderKey, window.days * 86_400, '1');
          this.logger.log(`Sent ${window.days}-day expiry reminder for subscription ${sub.id} (user ${sub.userId})`);
        } catch (err) {
          this.logger.error(`Failed to send expiry reminder for subscription ${sub.id}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }
  }
}
