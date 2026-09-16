import {
  Injectable,
  NotFoundException,
  ConflictException,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service';
import { RedisService } from '../../redis/redis.service';
import {
  Subscription,
  SubscriptionPlan,
  SubscriptionStatus,
  WalletTransactionType,
  WalletTransactionStatus,
  UserAuditAction,
  Prisma,
  Campaign,
  CampaignStatus,
  CampaignType,
  MembershipRank,
} from '@prisma/client';
import { createPaginatedResponse, PaginatedResponse } from '../../common/dto/pagination.dto';
import { WalletTxSerialService } from '../../common/services/wallet-tx-serial.service';
import { WalletService } from '../wallet/wallet.service';
import { AuditLogService } from '../../common/services/audit-log.service';
import { VerificationBadgeService } from '../users/verification-badge.service';
import { generateWalletTxId } from '../../common/utils/id-generator.util';
import * as ErrorCodes from '../../common/constants/error-codes';
import { toIdr, toSen } from '../../common/utils/currency.util';
import { SUBSCRIPTION_PLANS_CACHE } from '../../common/constants/redis-keys';
import {
  SUBSCRIPTION_MONTHLY_PRICE,
  SUBSCRIPTION_ANNUAL_PRICE,
} from '../../common/constants/app.constants';

const SUBSCRIPTION_PLANS_TTL = 300;

const RANK_ORDER: MembershipRank[] = [MembershipRank.BRONZE, MembershipRank.SILVER, MembershipRank.GOLD, MembershipRank.PLATINUM, MembershipRank.DIAMOND];

const PLAN_METADATA: Record<SubscriptionPlan, { durationDays: number; label: string }> = {
  MONTHLY: { durationDays: 30, label: 'Kahade Plus Monthly' },
  ANNUAL: { durationDays: 366, label: 'Kahade Plus Annual' },
};

@Injectable()
export class SubscriptionsService {
  private readonly logger = new Logger(SubscriptionsService.name);
  private readonly planPricing: Record<
    SubscriptionPlan,
    { price: bigint; durationDays: number; label: string }
  >;

  constructor(
    private prisma: PrismaService,
    private walletTxSerialService: WalletTxSerialService,
    private walletService: WalletService,
    private configService: ConfigService,
    private redis: RedisService,
    private auditLogService: AuditLogService,
    private verificationBadgeService: VerificationBadgeService,
  ) {
    const monthlyPriceSen =
      this.configService.get<number>('app.subscriptionMonthlyPriceSen') ??
      SUBSCRIPTION_MONTHLY_PRICE * 100;
    const annualPriceSen =
      this.configService.get<number>('app.subscriptionAnnualPriceSen') ??
      SUBSCRIPTION_ANNUAL_PRICE * 100;
    this.planPricing = {
      MONTHLY: { price: BigInt(monthlyPriceSen), ...PLAN_METADATA.MONTHLY },
      ANNUAL: { price: BigInt(annualPriceSen), ...PLAN_METADATA.ANNUAL },
    };
  }

  /**
   * Section 1(c): `kahadePlusSince` = tanggal PERTAMA kali user jadi Plus.
   * Dikembalikan sebagai patch object supaya bisa di-spread ke `tx.user.update`.
   * Kalau sudah terisi, tidak diubah sama sekali.
   */
  private async buildKahadePlusSinceData(
    tx: Prisma.TransactionClient,
    userId: string,
    since: Date,
  ): Promise<{ kahadePlusSince?: Date }> {
    const user = await tx.user.findUnique({ where: { id: userId }, select: { kahadePlusSince: true } });
    return user?.kahadePlusSince ? {} : { kahadePlusSince: since };
  }

  private getTrialDays(): number {
    return Math.min(30, Math.max(1, Math.trunc(this.configService.get<number>('app.subscriptionTrialDays') ?? 7)));
  }

  private async isDormantUser(userId: string, totalOrdersCompleted: number, days: number): Promise<boolean> {
    if (totalOrdersCompleted <= 0) return false;
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const recentCompleted = await this.prisma.order.count({
      where: {
        status: 'COMPLETED',
        deletedAt: null,
        completedAt: { gte: cutoff },
        OR: [{ buyerId: userId }, { sellerId: userId }],
      },
    });
    return recentCompleted === 0;
  }

  private isRankEligible(current: MembershipRank, minimum?: MembershipRank | null): boolean {
    if (!minimum) return true;
    return RANK_ORDER.indexOf(current) >= RANK_ORDER.indexOf(minimum);
  }

  private async resolveSubscriptionCampaign(
    userId: string,
    promoCode: string | undefined,
    priceSen: bigint,
  ): Promise<{ campaign: Campaign | null; discountSen: bigint }> {
    const normalized = promoCode?.trim().toUpperCase();
    if (!normalized) return { campaign: null, discountSen: BigInt(0) };
    if (!/^[A-Z0-9_-]{3,32}$/.test(normalized)) {
      throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Promo code is invalid' });
    }

    const now = new Date();
    const campaign = await this.prisma.campaign.findFirst({
      where: {
        promoCode: normalized,
        type: CampaignType.SUBSCRIPTION_DISCOUNT,
        status: CampaignStatus.ACTIVE,
        startsAt: { lte: now },
        endsAt: { gt: now },
      },
    });
    if (!campaign) {
      throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Subscription promo code is not active' });
    }
    if (campaign.maxRedemptions !== null && campaign.currentRedemptions >= campaign.maxRedemptions) {
      throw new BadRequestException({ code: ErrorCodes.VOUCHER_USAGE_LIMIT_REACHED, message: 'Promo code has reached its maximum redemptions' });
    }

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { membershipRank: true, totalOrdersCompleted: true },
    });
    if (!user) throw new NotFoundException({ code: ErrorCodes.USER_NOT_FOUND, message: 'User not found' });
    if (!this.isRankEligible(user.membershipRank, campaign.targetMinRank)) {
      throw new BadRequestException({ code: ErrorCodes.VOUCHER_NOT_APPLICABLE, message: 'Promo code is not available for your membership rank' });
    }
    if (campaign.targetNewUserOnly && user.totalOrdersCompleted > 0) {
      throw new BadRequestException({ code: ErrorCodes.VOUCHER_NOT_APPLICABLE, message: 'Promo code is only available for new users' });
    }
    if (campaign.targetDormantDays !== null && !(await this.isDormantUser(userId, user.totalOrdersCompleted, campaign.targetDormantDays))) {
      throw new BadRequestException({ code: ErrorCodes.VOUCHER_NOT_APPLICABLE, message: 'Promo code is only available for dormant users' });
    }

    let discountSen = BigInt(0);
    if (campaign.discountValue !== null) {
      discountSen = campaign.discountValue;
    } else if (campaign.discountPercent !== null) {
      const percentBps = BigInt(Math.round(Number(campaign.discountPercent) * 100));
      discountSen = (priceSen * percentBps) / BigInt(10_000);
      if (campaign.maxDiscount !== null && discountSen > campaign.maxDiscount) discountSen = campaign.maxDiscount;
    }
    if (discountSen > priceSen) discountSen = priceSen;
    return { campaign, discountSen };
  }

  async getStatus(userId: string): Promise<Record<string, unknown>> {
    const subscription = await this.prisma.subscription.findFirst({
      where: {
        userId,
        status: {
          in: [
            SubscriptionStatus.ACTIVE,
            SubscriptionStatus.CANCELLED,
            SubscriptionStatus.SUSPENDED,
            SubscriptionStatus.PAUSED,
          ],
        },
        currentPeriodEnd: { gt: new Date() },
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });

    if (!subscription) {
      return {
        isActive: false,
        plan: null,
        currentPeriodStart: null,
        currentPeriodEnd: null,
        feeSavingsUsed: 0,
        feeSavingsLimit: 0,
        feeSavingsRemaining: 0,
        isAutoRenew: false,
      };
    }

    const feeSavingsRemaining =
      subscription.feeSavingsLimit > subscription.feeSavingsUsed
        ? subscription.feeSavingsLimit - subscription.feeSavingsUsed
        : BigInt(0);
    const isInGracePeriod = subscription.status === SubscriptionStatus.SUSPENDED;
    const isPaused = subscription.status === SubscriptionStatus.PAUSED;

    return {
      isActive: !isInGracePeriod && !isPaused,
      isInGracePeriod,
      isPaused,
      plan: subscription.plan,
      status: subscription.status,
      cancelledAt: subscription.cancelledAt,
      currentPeriodStart: subscription.currentPeriodStart,
      currentPeriodEnd: subscription.currentPeriodEnd,
      trialEndsAt: subscription.trialEndsAt,
      pausedAt: subscription.pausedAt,
      resumeAt: subscription.resumeAt,
      feeSavingsUsed: toIdr(subscription.feeSavingsUsed),
      feeSavingsLimit: toIdr(subscription.feeSavingsLimit),
      feeSavingsRemaining: toIdr(feeSavingsRemaining),
      isAutoRenew: subscription.isAutoRenew,
      lastPaymentAt: subscription.lastPaymentAt,
      nextPaymentAt: subscription.nextPaymentAt,
      createdAt: subscription.createdAt,
    };
  }

  async subscribe(
    userId: string,
    plan: SubscriptionPlan,
    pin?: string,
    ip?: string,
    options: { promoCode?: string; useTrial?: boolean } = {},
  ): Promise<Subscription> {
    const planInfo = this.planPricing[plan];
    if (!planInfo) {
      throw new BadRequestException({
        code: ErrorCodes.VALIDATION_ERROR,
        message: 'Invalid subscription plan',
      });
    }

    const wantsTrial = options.useTrial === true;
    if (wantsTrial) {
      const priorTrial = await this.prisma.subscription.findFirst({
        where: { userId, trialEndsAt: { not: null } },
        select: { id: true },
      });
      if (priorTrial) {
        throw new ConflictException({
          code: ErrorCodes.SUBSCRIPTION_ALREADY_ACTIVE,
          message: 'Free trial has already been used for this account',
        });
      }
    }

    const campaignDiscount = wantsTrial
      ? { campaign: null, discountSen: BigInt(0) }
      : await this.resolveSubscriptionCampaign(userId, options.promoCode, planInfo.price);
    const effectivePrice = wantsTrial
      ? BigInt(0)
      : planInfo.price - campaignDiscount.discountSen;
    if (effectivePrice < BigInt(0)) {
      throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Invalid subscription price after discount' });
    }
    if (effectivePrice > BigInt(0)) {
      if (!pin) {
        throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Wallet PIN is required for paid subscriptions' });
      }
      await this.walletService.verifyPin(userId, pin, ip);
    }

    const walletTxSerial = effectivePrice > BigInt(0) ? await this.walletTxSerialService.getNext() : null;

    const now = new Date();
    const periodEnd = new Date(now);
    periodEnd.setDate(periodEnd.getDate() + (wantsTrial ? this.getTrialDays() : planInfo.durationDays));

    const subscription = await this.prisma.$transaction(
      async (tx: Prisma.TransactionClient) => {
        if (wantsTrial) {
          const priorTrialInsideTx = await tx.subscription.findFirst({
            where: { userId, trialEndsAt: { not: null } },
            select: { id: true },
          });
          if (priorTrialInsideTx) {
            throw new ConflictException({
              code: ErrorCodes.SUBSCRIPTION_ALREADY_ACTIVE,
              message: 'Free trial has already been used for this account',
            });
          }
        }

        const existingPending = await tx.subscription.findFirst({
          where: { userId, status: SubscriptionStatus.PENDING },
          select: { id: true },
        });
        if (existingPending) {
          throw new ConflictException({
            code: ErrorCodes.SUBSCRIPTION_ALREADY_ACTIVE,
            message: 'A subscription payment is already pending',
          });
        }

        const existingActive = await tx.subscription.findFirst({
          where: {
            userId,
            status: {
              in: [
                SubscriptionStatus.ACTIVE,
                SubscriptionStatus.CANCELLED,
                SubscriptionStatus.SUSPENDED,
                SubscriptionStatus.PAUSED,
              ],
            },
            currentPeriodEnd: { gt: new Date() },
          },
        });
        if (existingActive) {
          throw new ConflictException({
            code: ErrorCodes.SUBSCRIPTION_ALREADY_ACTIVE,
            message: 'You already have an active subscription period — use renew instead',
          });
        }

        let walletId: string | null = null;
        let balanceBefore = BigInt(0);
        let balanceAfter = BigInt(0);
        if (effectivePrice > BigInt(0)) {
          const walletRows = await tx.$queryRaw<
            Array<{
              id: string;
              userId: string;
              totalBalance: bigint;
              availableBalance: bigint;
              version: number;
            }>
          >`
          SELECT id, "userId", "totalBalance", "availableBalance", version FROM wallets WHERE "userId" = ${userId} FOR UPDATE`;
          const wallet = walletRows[0];
          if (!wallet) {
            throw new BadRequestException({
              code: ErrorCodes.INSUFFICIENT_BALANCE,
              message: 'Wallet not found',
            });
          }

          if (wallet.availableBalance < effectivePrice) {
            throw new BadRequestException({
              code: ErrorCodes.INSUFFICIENT_BALANCE,
              message: 'Insufficient wallet balance for subscription',
            });
          }

          const updated = await tx.wallet.updateMany({
            where: {
              id: wallet.id,
              version: wallet.version,
              availableBalance: { gte: effectivePrice },
            },
            data: {
              availableBalance: { decrement: effectivePrice },
              totalBalance: { decrement: effectivePrice },
              version: { increment: 1 },
            },
          });

          if (updated.count === 0) {
            throw new BadRequestException({
              code: ErrorCodes.INSUFFICIENT_BALANCE,
              message: 'Concurrent wallet update — please retry',
            });
          }

          walletId = wallet.id;
          balanceBefore = wallet.totalBalance;
          balanceAfter = wallet.totalBalance - effectivePrice;
        }

        if (campaignDiscount.campaign) {
          const campaignUpdated = await tx.campaign.updateMany({
            where: {
              id: campaignDiscount.campaign.id,
              status: CampaignStatus.ACTIVE,
              OR: [
                { maxRedemptions: null },
                { currentRedemptions: { lt: campaignDiscount.campaign.maxRedemptions as number } },
              ],
            },
            data: { currentRedemptions: { increment: 1 } },
          });
          if (campaignUpdated.count === 0) {
            throw new BadRequestException({ code: ErrorCodes.VOUCHER_USAGE_LIMIT_REACHED, message: 'Promo code has reached its maximum redemptions' });
          }
        }

        if (walletId && walletTxSerial !== null) {
          const walletTxId = generateWalletTxId(walletTxSerial);
          await tx.walletTransaction.create({
            data: {
              txId: walletTxId,
              walletId,
              type: WalletTransactionType.SUBSCRIPTION_PAYMENT,
              status: WalletTransactionStatus.SUCCESS,
              amount: effectivePrice,
              balanceBefore,
              balanceAfter,
              description: `${planInfo.label} subscription payment${campaignDiscount.discountSen > BigInt(0) ? ` (discount Rp ${toIdr(campaignDiscount.discountSen).toLocaleString('id-ID')})` : ''}`,
            },
          });
        }

        const feeSavingsLimitIdr = this.configService.get<number>('app.feeSavingsLimit') ?? 5000000;
        const feeSavingsLimitSen = toSen(feeSavingsLimitIdr);

        const sub = await tx.subscription.create({
          data: {
            userId,
            plan,
            status: SubscriptionStatus.ACTIVE,
            price: effectivePrice,
            originalPrice: campaignDiscount.discountSen > BigInt(0) || wantsTrial ? planInfo.price : null,
            trialEndsAt: wantsTrial ? periodEnd : null,
            currentPeriodStart: now,
            currentPeriodEnd: periodEnd,
            isAutoRenew: false,
            lastPaymentAt: effectivePrice > BigInt(0) ? now : null,
            nextPaymentAt: periodEnd,
            feeSavingsLimit: feeSavingsLimitSen,
          },
        });

        // kahadePlusSince hanya diisi saat PERTAMA kali subscribe dan tidak pernah
        // di-reset — dipakai badge "Kahade+" dan bagian "Tentang" di profil publik.
        await tx.user.update({
          where: { id: userId },
          data: {
            isKahadePlus: true,
            subscriptionExpiresAt: periodEnd,
            ...(await this.buildKahadePlusSinceData(tx, userId, now)),
          },
        });

        return sub;
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );

    // AUDIT-24: orders.service caches `subscription_status:<userId>` for 300 s to decide
    // fee discounts at order creation; without invalidation here (and in cancel/renew and
    // the expiry cron) a just-purchased or just-expired Plus state kept applying stale
    // rates inside that window.
    await this.redis.del(`subscription_status:${userId}`).catch((err: unknown) =>
      this.logger.warn(`Failed to invalidate subscription status cache for ${userId}: ${err instanceof Error ? err.message : String(err)}`),
    );

    // Section 1: badge "Kahade+" juga read-through cache — invalidasi post-commit
    // supaya badge langsung muncul tanpa menunggu TTL.
    await this.verificationBadgeService.invalidate(userId);

    this.logger.log(`User ${userId} subscribed to ${plan}, charged ${effectivePrice} sen`);

    this.auditLogService.logUserAction({
      userId,
      action: UserAuditAction.SUBSCRIPTION_STARTED,
      entityType: 'Subscription',
      entityId: subscription.id,
      description: `Subscribed to ${plan} plan${wantsTrial ? ' using free trial' : ''}`,
    });

    return subscription;
  }

  async cancel(userId: string): Promise<Subscription> {
    const subscription = await this.prisma.subscription.findFirst({
      where: { userId, status: SubscriptionStatus.ACTIVE },
    });

    if (!subscription) {
      throw new NotFoundException({
        code: ErrorCodes.NO_ACTIVE_SUBSCRIPTION,
        message: 'No active subscription found',
      });
    }

    // Mark subscription as CANCELLED (prevents auto-renewal) but keep isKahadePlus=true
    // and subscriptionExpiresAt intact so user retains benefits until currentPeriodEnd.
    // The subscription-expiry scheduler will revoke isKahadePlus when the period ends.
    const updated = await this.prisma.$transaction(
      async tx => {
        const result = await tx.subscription.updateMany({
          where: { id: subscription.id, status: SubscriptionStatus.ACTIVE },
          data: {
            status: SubscriptionStatus.CANCELLED,
            isAutoRenew: false,
            cancelledAt: new Date(),
            cancelReason: 'User requested cancellation',
          },
        });
        if (result.count === 0) {
          throw new ConflictException({
            code: ErrorCodes.OPTIMISTIC_LOCK_CONFLICT,
            message: 'Subscription changed concurrently — please retry',
          });
        }
        const sub = await tx.subscription.findUniqueOrThrow({ where: { id: subscription.id } });

        // Do NOT clear isKahadePlus or subscriptionExpiresAt here — the scheduler
        // (subscription-expiry.service.ts) handles that when currentPeriodEnd passes.

        return sub;
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );

    // AUDIT-24: drop the 300 s order-creation cache as soon as entitlement changes.
    await this.redis.del(`subscription_status:${userId}`).catch(() => undefined);
    // Cancellation TIDAK langsung mencabut Plus (benefit bertahan sampai
    // currentPeriodEnd), tapi badge cache tetap di-refresh supaya state terbaru
    // terbaca tanpa menunggu TTL.
    await this.verificationBadgeService.invalidate(userId);

    this.auditLogService.logUserAction({
      userId,
      action: UserAuditAction.SUBSCRIPTION_CANCELLED,
      entityType: 'Subscription',
      entityId: updated.id,
      description: `Cancelled ${updated.plan} subscription`,
    });

    return updated;
  }

  async pause(userId: string, resumeAt?: Date): Promise<Subscription> {
    if (resumeAt !== undefined && (!Number.isFinite(resumeAt.getTime()) || resumeAt <= new Date())) {
      throw new BadRequestException({ code: ErrorCodes.INVALID_DATE_RANGE, message: 'resumeAt must be a future date' });
    }
    const subscription = await this.prisma.subscription.findFirst({
      where: { userId, status: SubscriptionStatus.ACTIVE, currentPeriodEnd: { gt: new Date() } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
    if (!subscription) {
      throw new NotFoundException({ code: ErrorCodes.NO_ACTIVE_SUBSCRIPTION, message: 'No active subscription found' });
    }

    const now = new Date();
    const updated = await this.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      const result = await tx.subscription.updateMany({
        where: { id: subscription.id, status: SubscriptionStatus.ACTIVE, currentPeriodEnd: { gt: now } },
        data: {
          status: SubscriptionStatus.PAUSED,
          pausedAt: now,
          resumeAt: resumeAt ?? null,
          isAutoRenew: false,
        },
      });
      if (result.count === 0) {
        throw new ConflictException({ code: ErrorCodes.OPTIMISTIC_LOCK_CONFLICT, message: 'Subscription changed concurrently — please retry' });
      }
      await tx.user.update({
        where: { id: userId },
        data: { isKahadePlus: false },
      });
      return tx.subscription.findUniqueOrThrow({ where: { id: subscription.id } });
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });

    await this.redis.del(`subscription_status:${userId}`).catch(() => undefined);
    await this.verificationBadgeService.invalidate(userId);
    this.auditLogService.logUserAction({
      userId,
      action: UserAuditAction.SUBSCRIPTION_CANCELLED,
      entityType: 'Subscription',
      entityId: updated.id,
      description: `Paused ${updated.plan} subscription`,
    });
    return updated;
  }

  async resume(userId: string): Promise<Subscription> {
    const subscription = await this.prisma.subscription.findFirst({
      where: { userId, status: SubscriptionStatus.PAUSED, currentPeriodEnd: { gt: new Date() } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
    if (!subscription) {
      throw new NotFoundException({ code: ErrorCodes.NO_ACTIVE_SUBSCRIPTION, message: 'No paused subscription found' });
    }
    return this.resumeSubscriptionById(subscription.id);
  }

  async resumeSubscriptionById(subscriptionId: string): Promise<Subscription> {
    const now = new Date();
    const updated = await this.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      const subscription = await tx.subscription.findUnique({ where: { id: subscriptionId } });
      if (!subscription || subscription.status !== SubscriptionStatus.PAUSED || !subscription.currentPeriodEnd || subscription.currentPeriodEnd <= now) {
        throw new NotFoundException({ code: ErrorCodes.NO_ACTIVE_SUBSCRIPTION, message: 'No resumable subscription found' });
      }
      const result = await tx.subscription.updateMany({
        where: { id: subscription.id, status: SubscriptionStatus.PAUSED, currentPeriodEnd: { gt: now } },
        data: { status: SubscriptionStatus.ACTIVE, pausedAt: null, resumeAt: null },
      });
      if (result.count === 0) {
        throw new ConflictException({ code: ErrorCodes.OPTIMISTIC_LOCK_CONFLICT, message: 'Subscription changed concurrently — please retry' });
      }
      await tx.user.update({
        where: { id: subscription.userId },
        data: { isKahadePlus: true, subscriptionExpiresAt: subscription.currentPeriodEnd },
      });
      return tx.subscription.findUniqueOrThrow({ where: { id: subscription.id } });
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });

    await this.redis.del(`subscription_status:${updated.userId}`).catch(() => undefined);
    await this.verificationBadgeService.invalidate(updated.userId);
    this.auditLogService.logUserAction({
      userId: updated.userId,
      action: UserAuditAction.SUBSCRIPTION_STARTED,
      entityType: 'Subscription',
      entityId: updated.id,
      description: `Resumed ${updated.plan} subscription`,
    });
    return updated;
  }

  async getHistory(
    userId: string,
    page: number,
    limit: number,
  ): Promise<PaginatedResponse<Record<string, unknown>>> {
    const safePage = Math.max(1, Number.isFinite(page) ? Math.trunc(page) : 1);
    const safeLimit = Math.min(100, Math.max(1, Number.isFinite(limit) ? Math.trunc(limit) : 20));
    const skip = (safePage - 1) * safeLimit;

    const [data, total] = await Promise.all([
      this.prisma.subscription.findMany({
        where: { userId },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip,
        take: safeLimit,
      }),
      this.prisma.subscription.count({ where: { userId } }),
    ]);

    const serialized = data.map(sub => ({
      id: sub.id,
      plan: sub.plan,
      status: sub.status,
      price: toIdr(sub.price),
      originalPrice: sub.originalPrice != null ? toIdr(sub.originalPrice) : null,
      trialEndsAt: sub.trialEndsAt,
      pausedAt: sub.pausedAt,
      resumeAt: sub.resumeAt,
      currentPeriodStart: sub.currentPeriodStart,
      currentPeriodEnd: sub.currentPeriodEnd,
      isAutoRenew: sub.isAutoRenew,
      cancelledAt: sub.cancelledAt,
      lastPaymentAt: sub.lastPaymentAt,
      feeSavingsUsed: toIdr(sub.feeSavingsUsed),
      feeSavingsLimit: toIdr(sub.feeSavingsLimit),
      createdAt: sub.createdAt,
    }));

    return createPaginatedResponse(serialized, total, safePage, safeLimit);
  }

  async getBenefits(userId: string): Promise<Record<string, unknown>> {
    const subscription = await this.prisma.subscription.findFirst({
      where: {
        userId,
        status: {
          in: [
            SubscriptionStatus.ACTIVE,
            SubscriptionStatus.CANCELLED,
            SubscriptionStatus.SUSPENDED,
          ],
        },
        currentPeriodEnd: { gt: new Date() },
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });

    if (!subscription) {
      throw new NotFoundException({
        code: ErrorCodes.NO_ACTIVE_SUBSCRIPTION,
        message: 'No active subscription found',
      });
    }

    const planInfo = this.planPricing[subscription.plan];
    const feeSavingsRemaining =
      subscription.feeSavingsLimit > subscription.feeSavingsUsed
        ? subscription.feeSavingsLimit - subscription.feeSavingsUsed
        : BigInt(0);

    return {
      plan: subscription.plan,
      label: planInfo.label,
      benefits: [
        {
          key: 'fee_savings',
          label: 'Fee Savings',
          description: 'Reduced platform fees on transactions',
        },
        {
          key: 'priority_support',
          label: 'Priority Support',
          description: 'Faster customer support response',
        },
        { key: 'badge', label: 'Kahade Plus Badge', description: 'Exclusive profile badge' },
      ],
      feeSavingsUsed: toIdr(subscription.feeSavingsUsed),
      feeSavingsLimit: toIdr(subscription.feeSavingsLimit),
      feeSavingsRemaining: toIdr(feeSavingsRemaining),
      currentPeriodEnd: subscription.currentPeriodEnd,
    };
  }

  async renew(userId: string, pin: string, ip?: string): Promise<Subscription> {
    await this.walletService.verifyPin(userId, pin, ip);

    const subscription = await this.prisma.subscription.findFirst({
      where: {
        userId,
        status: {
          in: [
            SubscriptionStatus.ACTIVE,
            SubscriptionStatus.CANCELLED,
            SubscriptionStatus.SUSPENDED,
          ],
        },
        currentPeriodEnd: { gt: new Date() },
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });

    if (!subscription) {
      throw new NotFoundException({
        code: ErrorCodes.NO_ACTIVE_SUBSCRIPTION,
        message: 'No active subscription found',
      });
    }
    if (
      subscription.status === SubscriptionStatus.CANCELLED &&
      subscription.cancelReason === 'Force cancelled by admin'
    ) {
      throw new ConflictException({
        code: ErrorCodes.INVALID_STATUS,
        message: 'This subscription was cancelled by an administrator',
      });
    }

    const planInfo = this.planPricing[subscription.plan];
    const walletTxSerial = await this.walletTxSerialService.getNext();
    const renewBase =
      subscription.status === SubscriptionStatus.SUSPENDED
        ? new Date()
        : new Date(subscription.currentPeriodEnd ?? new Date());
    const newPeriodEnd = new Date(renewBase);
    newPeriodEnd.setDate(newPeriodEnd.getDate() + planInfo.durationDays);
    const now = new Date();

    const updated = await this.prisma.$transaction(
      async (tx: Prisma.TransactionClient) => {
        const walletRows = await tx.$queryRaw<
          Array<{
            id: string;
            userId: string;
            totalBalance: bigint;
            availableBalance: bigint;
            version: number;
          }>
        >`
        SELECT id, "userId", "totalBalance", "availableBalance", version FROM wallets WHERE "userId" = ${userId} FOR UPDATE`;
        const wallet = walletRows[0];
        if (!wallet) {
          throw new BadRequestException({
            code: ErrorCodes.INSUFFICIENT_BALANCE,
            message: 'Wallet not found',
          });
        }

        if (wallet.availableBalance < planInfo.price) {
          throw new BadRequestException({
            code: ErrorCodes.INSUFFICIENT_BALANCE,
            message: 'Insufficient wallet balance for subscription renewal',
          });
        }

        const walletUpdated = await tx.wallet.updateMany({
          where: {
            id: wallet.id,
            version: wallet.version,
            availableBalance: { gte: planInfo.price },
          },
          data: {
            availableBalance: { decrement: planInfo.price },
            totalBalance: { decrement: planInfo.price },
            version: { increment: 1 },
          },
        });

        if (walletUpdated.count === 0) {
          throw new BadRequestException({
            code: ErrorCodes.OPTIMISTIC_LOCK_CONFLICT,
            message: 'Concurrent wallet update — please retry',
          });
        }

        const walletTxId = generateWalletTxId(walletTxSerial);
        const renewBalanceBefore = wallet.totalBalance;
        const renewBalanceAfter = wallet.totalBalance - planInfo.price;
        await tx.walletTransaction.create({
          data: {
            txId: walletTxId,
            walletId: wallet.id,
            type: WalletTransactionType.SUBSCRIPTION_PAYMENT,
            status: WalletTransactionStatus.SUCCESS,
            amount: planInfo.price,
            balanceBefore: renewBalanceBefore,
            balanceAfter: renewBalanceAfter,
            description: `${planInfo.label} subscription renewal`,
          },
        });

        const feeSavingsLimitIdr = this.configService.get<number>('app.feeSavingsLimit') ?? 5000000;
        const feeSavingsLimitSen = toSen(feeSavingsLimitIdr);

        const subUpdated = await tx.subscription.updateMany({
          where: {
            id: subscription.id,
            status: {
              in: [
                SubscriptionStatus.ACTIVE,
                SubscriptionStatus.CANCELLED,
                SubscriptionStatus.SUSPENDED,
              ],
            },
            currentPeriodEnd: subscription.currentPeriodEnd,
          },
          data: {
            status: SubscriptionStatus.ACTIVE,
            isAutoRenew: subscription.isAutoRenew,
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
          throw new ConflictException({
            code: ErrorCodes.OPTIMISTIC_LOCK_CONFLICT,
            message: 'Subscription was already renewed — please retry',
          });
        }
        const sub = await tx.subscription.findUniqueOrThrow({ where: { id: subscription.id } });

        await tx.user.update({
          where: { id: userId },
          data: {
            isKahadePlus: true,
            subscriptionExpiresAt: newPeriodEnd,
            // Renewal tidak mengubah kahadePlusSince, kecuali akun legacy yang
            // belum punya nilainya (kolom ini baru ada sejak Section 1).
            ...(await this.buildKahadePlusSinceData(tx, userId, new Date())),
          },
        });

        return sub;
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );

    // AUDIT-24: see subscribe() — keep order-fee decisions honest after renewal.
    await this.redis.del(`subscription_status:${userId}`).catch(() => undefined);
    await this.verificationBadgeService.invalidate(userId);
    this.logger.log(`User ${userId} renewed ${subscription.plan}, charged ${planInfo.price} sen`);
    this.auditLogService.logUserAction({
      userId,
      action: UserAuditAction.SUBSCRIPTION_STARTED,
      entityType: 'Subscription',
      entityId: subscription.id,
      description: `Renewed ${subscription.plan} subscription (previous feeSavingsUsed: ${subscription.feeSavingsUsed ?? 0} sen)`,
    });
    return updated;
  }

  async getPlans(): Promise<
    Array<{
      plan: string;
      label: string;
      price: number;
      durationDays: number;
      feeSavingsLimit: number;
    }>
  > {
    type PlanEntry = {
      plan: string;
      label: string;
      price: number;
      durationDays: number;
      feeSavingsLimit: number;
    };
    const cacheKey = `${SUBSCRIPTION_PLANS_CACHE}:plans`;
    const cached = await this.redis.get(cacheKey);
    if (cached) {
      try {
        return JSON.parse(cached) as PlanEntry[];
      } catch (_) {
        await this.redis.del(cacheKey);
      }
    }
    const feeSavingsLimit = this.configService.get<number>('app.feeSavingsLimit') ?? 5000000;
    const plans = Object.entries(this.planPricing).map(([plan, info]) => ({
      plan,
      label: info.label,
      price: toIdr(info.price),
      durationDays: info.durationDays,
      feeSavingsLimit,
    }));
    await this.redis.setex(cacheKey, SUBSCRIPTION_PLANS_TTL, JSON.stringify(plans));
    return plans;
  }

  // 11.1 Subscription upgrade proration
  async upgradeSubscription(userId: string, newPlan: SubscriptionPlan, pin: string, ip?: string): Promise<object> {
    await this.walletService.verifyPin(userId, pin, ip);
    const current = await this.prisma.subscription.findFirst({
      where: { userId, status: { in: [SubscriptionStatus.ACTIVE, SubscriptionStatus.CANCELLED] }, currentPeriodEnd: { gt: new Date() } },
      orderBy: { createdAt: 'desc' },
    });
    if (!current) throw new NotFoundException({ code: ErrorCodes.NO_ACTIVE_SUBSCRIPTION, message: 'No active subscription' });
    if (!current.currentPeriodStart || !current.currentPeriodEnd) {
      throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Subscription period is not initialized' });
    }
    if (current.plan === newPlan) throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Already on this plan' });

    const currentPlanInfo = this.planPricing[current.plan];
    const newPlanInfo = this.planPricing[newPlan];
    if (!newPlanInfo) throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Invalid plan' });

    // Proration: calculate remaining value of current plan
    const now = new Date();
    const totalDuration = current.currentPeriodEnd.getTime() - current.currentPeriodStart.getTime();
    const remaining = current.currentPeriodEnd.getTime() - now.getTime();
    const remainingRatio = remaining / totalDuration;
    const remainingValue = BigInt(Math.floor(Number(current.price) * remainingRatio));
    const priceDiff = newPlanInfo.price - remainingValue;
    const chargeAmount = priceDiff > 0 ? priceDiff : BigInt(0);

    if (chargeAmount > 0) {
      const walletRows = await this.prisma.$queryRaw<Array<{ id: string; totalBalance: bigint; availableBalance: bigint; version: number }>>`
        SELECT id, \"totalBalance\", \"availableBalance\", version FROM wallets WHERE \"userId\" = ${userId} FOR UPDATE
      `;
      const wallet = walletRows[0];
      if (!wallet || wallet.availableBalance < chargeAmount) throw new BadRequestException({ code: ErrorCodes.INSUFFICIENT_BALANCE, message: 'Insufficient balance for upgrade' });
    }

    const serial = await this.walletTxSerialService.getNext();
    const updated = await this.prisma.$transaction(async (tx) => {
      if (chargeAmount > 0) {
        const w = await tx.wallet.findUnique({ where: { userId } });
        if (!w) throw new BadRequestException({ code: ErrorCodes.WALLET_NOT_FOUND, message: 'Wallet not found' });
        await tx.wallet.update({ where: { id: w.id }, data: { availableBalance: { decrement: chargeAmount }, totalBalance: { decrement: chargeAmount }, version: { increment: 1 } } });
        await tx.walletTransaction.create({
          data: {
            txId: generateWalletTxId(serial),
            walletId: w.id,
            type: WalletTransactionType.SUBSCRIPTION_PAYMENT,
            status: WalletTransactionStatus.SUCCESS,
            amount: chargeAmount,
            balanceBefore: w.totalBalance,
            balanceAfter: w.totalBalance - chargeAmount,
            description: `Upgrade from ${current.plan} to ${newPlan} (prorated)`,
          },
        });
      }
      const newEnd = new Date(now);
      newEnd.setDate(newEnd.getDate() + newPlanInfo.durationDays);
      const sub = await tx.subscription.update({
        where: { id: current.id },
        data: {
          plan: newPlan,
          price: newPlanInfo.price,
          currentPeriodStart: now,
          currentPeriodEnd: newEnd,
          nextPaymentAt: newEnd,
        },
      });
      await tx.user.update({ where: { id: userId }, data: { subscriptionExpiresAt: newEnd } });
      return sub;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });

    await this.redis.del(`subscription_status:${userId}`).catch(() => {});
    await this.verificationBadgeService.invalidate(userId);
    return { subscription: updated, charged: toIdr(chargeAmount), proratedCredit: toIdr(remainingValue) };
  }
}
