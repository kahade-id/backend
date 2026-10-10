import { Injectable, NotFoundException, BadRequestException, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service';
import { RedisService } from '../../redis/redis.service';
import {
  Prisma,
  ReferralCode,
  ReferralRelation,
  WalletTransactionType,
  WalletTransactionStatus,
  KycStatus,
  OrderStatus,
  MembershipRank,
  EscrowDisbursementScope,
  NotificationType,
} from '@prisma/client';
import { generateWalletTxId, generateReferralCode } from '../../common/utils/id-generator.util';
import { WalletTxSerialService } from '../../common/services/wallet-tx-serial.service';
import { createPaginatedResponse, PaginatedResponse } from '../../common/dto/pagination.dto';
import { toIdr, formatSen } from '../../common/utils/currency.util';
import * as ErrorCodes from '../../common/constants/error-codes';
import { REFERRAL_LEADERBOARD_CACHE } from '../../common/constants/redis-keys';
// M4 no-wallet: payout referral via disbursement DANA bila wallet mati.
import { WalletModeService } from '../wallet-mode/wallet-mode.service';
import { EscrowDisbursementService } from '../no-wallet/escrow-disbursement.service';
// Audit referral 2026-10-10: B13 notifikasi reward, B18 deteksi lonjakan bersama.
import { NotificationQueueService } from '../queue/notification-queue.service';
import { renderNotificationCopy, resolveNotificationLanguage } from '../notifications/notification-copy.service';
import { flagReferralBurstIfNeeded } from '../../common/utils/referral-burst.util';

const REFERRAL_REWARD_TIERS: Record<MembershipRank, bigint> = {
  BRONZE: BigInt(500_000),
  SILVER: BigInt(500_000),
  GOLD: BigInt(1_000_000),
  PLATINUM: BigInt(1_500_000),
  DIAMOND: BigInt(1_500_000),
};
const REFERRAL_LEADERBOARD_TTL = 900;

@Injectable()
export class ReferralService {
  private readonly logger = new Logger(ReferralService.name);

  constructor(
    private prisma: PrismaService,
    private redis: RedisService,
    private walletTxSerialService: WalletTxSerialService,
    private configService: ConfigService,
    // M4 no-wallet: opsional agar modul lama tanpa wiring tetap jalan (fail-closed di pemakaian).
    @Optional() private walletMode: WalletModeService | null,
    @Optional() private disbursement: EscrowDisbursementService | null,
    // B13: opsional agar konstruksi manual di spec lama tetap jalan.
    @Optional() private notificationQueue: NotificationQueueService | null,
  ) {}

  private getRewardAmountForRank(rank: MembershipRank): bigint {
    return REFERRAL_REWARD_TIERS[rank] ?? REFERRAL_REWARD_TIERS.BRONZE;
  }

  /** B18: logika dipusatkan di util bersama (dipakai juga oleh registrasi). */
  private async flagReferralBurstIfNeeded(referrerId: string, relationId: string): Promise<void> {
    await flagReferralBurstIfNeeded(
      { prisma: this.prisma, redis: this.redis, logger: this.logger },
      referrerId,
      relationId,
    );
  }

  async refreshLeaderboard(limit = 50): Promise<Array<Record<string, unknown>>> {
    const safeLimit = Math.min(100, Math.max(1, Math.trunc(Number(limit) || 50)));
    const leaders = await this.prisma.referralCode.findMany({
      where: { user: { deletedAt: null, isActive: true, isBanned: false } },
      orderBy: [{ totalRewardEarned: 'desc' }, { totalReferrals: 'desc' }, { id: 'asc' }],
      take: safeLimit,
      include: {
        user: { select: { userId: true, username: true, fullName: true, avatarUrl: true, membershipRank: true } },
      },
    });
    const relationCounts = await this.prisma.referralRelation.groupBy({
      by: ['referrerId'],
      where: { referrerId: { in: leaders.map(l => l.userId) }, isRewardActive: true },
      _count: { _all: true },
    });
    const successfulByUser = new Map(relationCounts.map(row => [row.referrerId, row._count._all]));
    // B15: `code` user lain TIDAK diekspos — bisa dipanen untuk membanjiri
    // relasi (memicu flag review korban). FE tidak memakainya.
    const data = leaders.map((leader, index) => ({
      rank: index + 1,
      user: leader.user,
      totalReferrals: leader.totalReferrals,
      successfulReferrals: successfulByUser.get(leader.userId) ?? 0,
      totalRewardEarned: toIdr(leader.totalRewardEarned),
    }));
    await this.redis.setex(REFERRAL_LEADERBOARD_CACHE('all_time', safeLimit), REFERRAL_LEADERBOARD_TTL, JSON.stringify(data));
    return data;
  }

  async getLeaderboard(limit = 50): Promise<Array<Record<string, unknown>>> {
    const safeLimit = Math.min(100, Math.max(1, Math.trunc(Number(limit) || 50)));
    const cacheKey = REFERRAL_LEADERBOARD_CACHE('all_time', safeLimit);
    const cached = await this.redis.get(cacheKey);
    if (cached) {
      try {
        return JSON.parse(cached) as Array<Record<string, unknown>>;
      } catch (_) {
        await this.redis.del(cacheKey);
      }
    }
    return this.refreshLeaderboard(safeLimit);
  }

  /**
   * SP-047: leaderboard di-cache 900 dtk — invalidasi saat reward dikreditkan
   * agar peringkat langsung mencerminkan totalRewardEarned terbaru.
   * Best-effort: kegagalan Redis tidak menggagalkan alur order.
   */
  async invalidateLeaderboardCache(): Promise<void> {
    try {
      await this.redis.delPattern('referral:leaderboard:*');
    } catch (err: unknown) {
      this.logger.warn(`Failed to invalidate referral leaderboard cache: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async getOrCreateCode(userId: string): Promise<ReferralCode> {
    const existing = await this.prisma.referralCode.findUnique({ where: { userId } });
    if (existing) return existing;

    const MAX_RETRIES = 3;
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      const code = generateReferralCode();
      try {
        return await this.prisma.referralCode.upsert({
          where: { userId },
          update: {},
          create: {
            userId,
            code,
          },
        });
      } catch (err: unknown) {
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
          this.logger.warn(`Referral code collision on attempt ${attempt + 1}, retrying...`);
          continue;
        }
        throw err;
      }
    }
    throw new BadRequestException({
      code: 'REFERRAL_CODE_GEN_FAILED',
      message: 'Failed to generate a unique referral code',
    });
  }

  async applyCode(userId: string, code: string): Promise<ReferralRelation> {
    const normalizedCode = code.trim().toUpperCase();
    const MAX_REFERRALS_PER_CODE = this.configService.get<number>('app.maxReferralsPerCode') ?? 100;

    try {
      const relation = await this.prisma.$transaction(
        async tx => {
          const referralCode = await tx.referralCode.findUnique({
            where: { code: normalizedCode },
            include: { user: { select: { id: true, userId: true } } },
          });

          if (!referralCode || !referralCode.isActive) {
            throw new NotFoundException({
              code: ErrorCodes.REFERRAL_CODE_NOT_FOUND,
              message: 'Referral code not found or inactive',
            });
          }

          if (referralCode.userId === userId) {
            throw new BadRequestException({
              code: ErrorCodes.REFERRAL_SELF,
              message: 'Cannot use your own referral code',
            });
          }

          const existingRelation = await tx.referralRelation.findUnique({
            where: { refereeId: userId },
          });

          if (existingRelation) {
            throw new BadRequestException({
              code: ErrorCodes.REFERRAL_ALREADY_APPLIED,
              message: 'You have already applied a referral code',
            });
          }

          // B19: program referral = "hadiah saat transaksi PERTAMA referee selesai"
          // (createReferralRewardIfEligible mensyaratkan tepat 1 order selesai).
          // Akun yang sudah pernah bertransaksi tidak akan pernah memenuhi syarat —
          // dulu tetap boleh apply lalu tersangkut "Menunggu syarat" selamanya.
          const applicant = await tx.user.findUnique({
            where: { id: userId },
            select: { totalOrdersCompleted: true },
          });
          if (!applicant) {
            throw new NotFoundException({ code: ErrorCodes.USER_NOT_FOUND, message: 'User not found' });
          }
          if (applicant.totalOrdersCompleted > 0) {
            throw new BadRequestException({
              code: ErrorCodes.REFERRAL_NOT_NEW_USER,
              message: 'Referral codes can only be applied by accounts without completed transactions',
            });
          }

          let currentReferrerId = referralCode.userId;
          const visited = new Set<string>([userId]);
          for (let depth = 0; depth < 10; depth++) {
            if (visited.has(currentReferrerId)) {
              throw new BadRequestException({
                code: 'CIRCULAR_REFERRAL',
                message: 'Circular referral is not allowed',
              });
            }
            visited.add(currentReferrerId);
            const upstream = await tx.referralRelation.findFirst({
              where: { refereeId: currentReferrerId },
              select: { referrerId: true },
            });
            if (!upstream) break;
            currentReferrerId = upstream.referrerId;
          }

          const codeUpdated = await tx.referralCode.updateMany({
            where: {
              id: referralCode.id,
              isActive: true,
              totalReferrals: { lt: MAX_REFERRALS_PER_CODE },
            },
            data: {
              totalReferrals: { increment: 1 },
            },
          });
          if (codeUpdated.count === 0) {
            throw new BadRequestException({
              code: 'REFERRAL_LIMIT_REACHED',
              message:
                'This referral code has reached its maximum usage limit or is no longer active',
            });
          }

          const rel = await tx.referralRelation.create({
            data: {
              referralCodeId: referralCode.id,
              referrerId: referralCode.userId,
              refereeId: userId,
            },
          });

          return rel;
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      );

      await this.flagReferralBurstIfNeeded(relation.referrerId, relation.id);
      return (await this.prisma.referralRelation.findUnique({ where: { id: relation.id } })) ?? relation;
    } catch (err: unknown) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new BadRequestException({
          code: ErrorCodes.REFERRAL_ALREADY_APPLIED,
          message: 'You have already applied a referral code',
        });
      }
      throw err;
    }
  }

  async getStats(userId: string): Promise<Record<string, unknown>> {
    const referralCode = await this.prisma.referralCode.findUnique({
      where: { userId },
    });

    // B16: batas kuota dari config, bukan hardcode 100.
    const maxSlots = this.configService.get<number>('app.maxReferralsPerCode') ?? 100;
    if (!referralCode) {
      return {
        code: null,
        totalReferrals: 0,
        successfulReferrals: 0,
        totalRewardEarned: 0,
        pendingRewardCount: 0,
        remainingSlots: maxSlots,
        maxSlots,
      };
    }

    const [totalReferrals, successfulReferrals, pendingRewardCount] = await Promise.all([
      this.prisma.referralRelation.count({
        where: { referrerId: userId },
      }),
      this.prisma.referralRelation.count({
        where: { referrerId: userId, isRewardActive: true },
      }),
      this.prisma.referralReward.count({
        where: {
          referrerId: userId,
          isCredited: false,
        },
      }),
    ]);

    return {
      code: referralCode.code,
      totalReferrals,
      successfulReferrals,
      totalRewardEarned: toIdr(referralCode.totalRewardEarned),
      pendingRewardCount,
      remainingSlots: Math.max(0, maxSlots - totalReferrals),
      maxSlots,
    };
  }

  async getRewards(
    userId: string,
    page: number,
    limit: number,
  ): Promise<PaginatedResponse<Record<string, unknown>>> {
    const safePage = Math.max(1, Math.trunc(Number(page) || 1));
    const safeLimit = Math.min(100, Math.max(1, Math.trunc(Number(limit) || 20)));
    const where = { referrerId: userId };

    const [data, total] = await Promise.all([
      this.prisma.referralReward.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (safePage - 1) * safeLimit,
        take: safeLimit,
        // B23: bedakan reward pengundang vs bonus sambutan referee.
        include: { relation: { select: { referrerId: true } } },
      }),
      this.prisma.referralReward.count({ where }),
    ]);

    const serialized = data.map(r => ({
      id: r.id,
      // `referrerId` baris = PENERIMA reward (lihat creditReward); dibandingkan
      // dengan referrer relasi untuk menentukan sisi.
      kind: r.relation && r.relation.referrerId === r.referrerId ? 'REFERRER' : 'REFEREE',
      feeAmount: toIdr(r.feeAmount),
      rewardAmount: toIdr(r.rewardAmount),
      isCredited: r.isCredited,
      creditedAt: r.creditedAt,
      createdAt: r.createdAt,
    }));

    return createPaginatedResponse(serialized, total, safePage, safeLimit);
  }

  async regenerateCode(userId: string): Promise<ReferralCode> {
    const existing = await this.prisma.referralCode.findUnique({ where: { userId } });
    if (existing) {
      this.logger.warn(
        `[REFERRAL] User ${userId} regenerating referral code. Old code "${existing.code}" is now invalidated. Previously shared links will stop working.`,
      );
    }

    const MAX_RETRIES = 3;
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      const newCode = generateReferralCode();
      try {
        return await this.prisma.referralCode.upsert({
          where: { userId },
          // C-13: do NOT reset `totalReferrals` here. `ReferralCode.userId` is `@unique`
          // (`schema.prisma:1629`), so this row is per-user, and `totalReferrals` is the only
          // thing enforcing MAX_REFERRALS_PER_CODE — `applyCode` guards on
          // `totalReferrals: { lt: MAX }` (`:106`). Resetting it let any user at the cap call
          // POST /v1/referral/regenerate (self-service, 3/hour) to clear the counter and keep
          // referring without bound, each qualifying referral paying out 2 x Rp 5.000 of
          // platform funds (`:343-344`). The counter stays cumulative per user, matching the
          // authoritative `referralRelation.count({ referrerId })` that `getStats` reports
          // (`:155-157`) and that is never reset (relations are `onDelete: Restrict`).
          update: { code: newCode, isActive: true },
          create: {
            userId,
            code: newCode,
            isActive: true,
          },
        });
      } catch (err: unknown) {
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
          this.logger.warn(
            `Referral code collision on regeneration attempt ${attempt + 1}, retrying...`,
          );
          continue;
        }
        throw err;
      }
    }
    throw new BadRequestException({
      code: 'REFERRAL_CODE_GEN_FAILED',
      message: 'Failed to generate a unique referral code',
    });
  }

  async getHistory(
    userId: string,
    page: number,
    limit: number,
  ): Promise<PaginatedResponse<Record<string, unknown>>> {
    const safePage = Math.max(1, Math.trunc(Number(page) || 1));
    const safeLimit = Math.min(100, Math.max(1, Math.trunc(Number(limit) || 20)));
    const where = {
      OR: [{ referrerId: userId }, { refereeId: userId }],
    };

    const [data, total] = await Promise.all([
      this.prisma.referralRelation.findMany({
        where,
        include: {
          referrer: { select: { userId: true, username: true, fullName: true } },
          referee: { select: { userId: true, username: true, fullName: true } },
          rewards: {
            select: {
              id: true,
              feeAmount: true,
              rewardAmount: true,
              isCredited: true,
              creditedAt: true,
              createdAt: true,
            },
            take: 20,
            orderBy: [{ createdAt: 'desc' as const }, { id: 'desc' as const }],
          },
        },
        orderBy: [{ appliedAt: 'desc' }, { id: 'desc' }],
        skip: (safePage - 1) * safeLimit,
        take: safeLimit,
      }),
      this.prisma.referralRelation.count({ where }),
    ]);

    // B14: whitelist — dulu `...rel` ikut membocorkan flaggedForReview,
    // reviewReason, referralCodeId, dan id internal kedua pihak.
    const serialized = data.map(rel => ({
      id: rel.id,
      viewerRole: rel.referrerId === userId ? 'REFERRER' : 'REFEREE',
      referrer: rel.referrer,
      referee: rel.referee,
      isRewardActive: rel.isRewardActive,
      appliedAt: rel.appliedAt,
      rewardActivatedAt: rel.rewardActivatedAt,
      rewards: rel.rewards?.map(r => ({
        ...r,
        feeAmount: toIdr(r.feeAmount),
        rewardAmount: toIdr(r.rewardAmount),
      })),
    }));

    return createPaginatedResponse(serialized, total, safePage, safeLimit);
  }

  /**
   * SP-047: mengembalikan true bila reward berhasil dikreditkan — pemanggil
   * memakai ini untuk invalidasi cache leaderboard SETELAH transaksi commit
   * (invalidasi di dalam tx berisiko di-repopulate cache basi sebelum commit).
   */
  async createReferralRewardIfEligible(
    userId: string,
    feeAmount: bigint,
    orderId: string,
    tx: Prisma.TransactionClient,
  ): Promise<boolean> {
    const relation = await tx.referralRelation.findUnique({
      where: { refereeId: userId },
    });

    if (!relation) return false;

    if (relation.isRewardActive) return false;

    const order = await tx.order.findUnique({
      where: { id: orderId },
      select: { status: true, buyerId: true, sellerId: true },
    });
    if (!order || order.status !== OrderStatus.COMPLETED) {
      this.logger.warn(
        `Referral reward skipped for order ${orderId}: order status is ${order?.status ?? 'NOT_FOUND'}, expected COMPLETED`,
      );
      return false;
    }

    // B12: transaksi antara referee dan pengundangnya sendiri tidak memicu
    // reward — A mengajak B lalu A↔B bertransaksi fee minimum Rp2.500 akan
    // membayar 2×Rp5.000 (rugi bersih platform). Transaksi pertama referee
    // harus dengan pihak ketiga.
    const counterpartId = order.buyerId === userId ? order.sellerId : order.buyerId;
    if (counterpartId && counterpartId === relation.referrerId) {
      this.logger.warn(
        `Referral reward skipped for order ${orderId}: counterpart is the referrer ${relation.referrerId} (self-dealing)`,
      );
      return false;
    }

    const [referrer, referee] = await Promise.all([
      tx.user.findUnique({ where: { id: relation.referrerId }, select: { kycStatus: true, membershipRank: true } }),
      tx.user.findUnique({ where: { id: relation.refereeId }, select: { kycStatus: true } }),
    ]);

    if (!referrer || referrer.kycStatus !== KycStatus.APPROVED) {
      this.logger.log(
        `Referral reward skipped for order ${orderId}: referrer ${relation.referrerId} not KYC verified`,
      );
      return false;
    }

    if (!referee || referee.kycStatus !== KycStatus.APPROVED) {
      this.logger.log(
        `Referral reward skipped for order ${orderId}: referee ${relation.refereeId} not KYC verified`,
      );
      return false;
    }

    const referrerCompletedOrders = await tx.order.count({
      where: {
        OR: [{ buyerId: relation.referrerId }, { sellerId: relation.referrerId }],
        status: OrderStatus.COMPLETED,
        deletedAt: null,
      },
    });

    if (referrerCompletedOrders < 1) {
      this.logger.log(
        `Referral reward skipped for order ${orderId}: referrer ${relation.referrerId} has no completed transactions`,
      );
      return false;
    }

    const refereeCompletedOrders = await tx.order.count({
      where: {
        OR: [{ buyerId: relation.refereeId }, { sellerId: relation.refereeId }],
        status: OrderStatus.COMPLETED,
        deletedAt: null,
      },
    });

    if (refereeCompletedOrders !== 1) {
      this.logger.log(
        `Referral reward skipped for order ${orderId}: referee ${relation.refereeId} has ${refereeCompletedOrders} completed transactions (expected exactly 1 — first transaction)`,
      );
      return false;
    }

    // M4 no-wallet: bila wallet mati, reward tidak butuh wallet — payout via
    // disbursement DANA ke rekening bank. Gate wallet hanya untuk mode lama.
    const walletEnabled = this.walletMode?.isWalletEnabled() ?? true;
    if (walletEnabled) {
      const walletCount = await tx.wallet.count({
        where: { userId: { in: [relation.referrerId, relation.refereeId] } },
      });
      if (walletCount !== 2) {
        this.logger.warn(
          `Referral reward skipped for order ${orderId}: both referral wallets are required before crediting either side`,
        );
        return false;
      }
    }

    const rewardAmount = this.getRewardAmountForRank(referrer.membershipRank);

    const referrerCredited = await this.creditReward(
      relation.referrerId,
      rewardAmount,
      feeAmount,
      orderId,
      relation.id,
      'Referral reward — you invited a new user',
      tx,
    );
    const refereeCredited = await this.creditReward(
      relation.refereeId,
      rewardAmount,
      feeAmount,
      orderId,
      relation.id,
      'Referral reward — welcome bonus for your first transaction',
      tx,
    );

    if (!referrerCredited || !refereeCredited) {
      this.logger.warn(
        `Referral reward partially failed for order ${orderId}: referrer=${referrerCredited}, referee=${refereeCredited} — relation NOT activated`,
      );
      return false;
    }

    await tx.referralRelation.update({
      where: { id: relation.id },
      data: {
        isRewardActive: true,
        rewardActivatedAt: new Date(),
        isReferrerKyc: true,
        isRefereeKyc: true,
      },
    });

    this.logger.log(
      `Referral rewards ${formatSen(rewardAmount)} each credited to referrer ${relation.referrerId} and referee ${relation.refereeId} for order ${orderId}`,
    );
    return true;
  }

  private async creditReward(
    userId: string,
    amount: bigint,
    feeAmount: bigint,
    orderId: string,
    relationId: string,
    description: string,
    tx: Prisma.TransactionClient,
  ): Promise<boolean> {
    const existingReward = await tx.referralReward.findFirst({
      where: { triggeredByOrderId: orderId, referrerId: userId },
      select: { id: true, isCredited: true },
    });
    if (existingReward) {
      this.logger.warn(
        `Referral reward already exists for order ${orderId} user ${userId} — skipping duplicate`,
      );
      return existingReward.isCredited;
    }

    // M4 no-wallet: dipindah ke atas — wallet mati → lewati lock wallet.
    const walletEnabled = this.walletMode?.isWalletEnabled() ?? true;

    const lockedWallets = walletEnabled
      ? await tx.$queryRaw<Array<{ id: string; totalBalance: bigint }>>`
        SELECT id, "totalBalance" FROM wallets WHERE "userId" = ${userId} FOR UPDATE
      `
      : [{ id: 'no-wallet', totalBalance: BigInt(0) }];
    const lockedWallet = lockedWallets[0];
    if (!lockedWallet) {
      this.logger.warn(`User ${userId} has no wallet — skipping reward credit`);
      return false;
    }

    const reward = await tx.referralReward.create({
      data: {
        relationId,
        referrerId: userId,
        triggeredByOrderId: orderId,
        feeAmount,
        rewardAmount: amount,
        isCredited: false,
        creditedAt: null,
      },
    });

    // M4 no-wallet: wallet mati → TIDAK menyentuh wallet. Reward diklaim
    // (baris idempoten di atas); payout aktual via disbursement DANA yang
    // didorong scheduler payoutPendingReferralRewards (durable + idempoten).
    if (!walletEnabled) {
      await tx.referralCode.updateMany({
        where: { userId },
        data: { totalRewardEarned: { increment: amount } },
      });
      this.logger.log(
        `Referral reward ${formatSen(amount)} diklaim untuk user ${userId} (order ${orderId}) — payout DANA dijadwalkan via scheduler`,
      );
      return true;
    }

    const walletTxSerial = await this.walletTxSerialService.getNext();
    const walletTxId = generateWalletTxId(walletTxSerial);

    await tx.wallet.update({
      where: { id: lockedWallet.id },
      data: {
        availableBalance: { increment: amount },
        totalBalance: { increment: amount },
        version: { increment: 1 },
      },
    });

    await tx.walletTransaction.create({
      data: {
        txId: walletTxId,
        walletId: lockedWallet.id,
        type: WalletTransactionType.REFERRAL_REWARD,
        status: WalletTransactionStatus.SUCCESS,
        amount,
        balanceBefore: lockedWallet.totalBalance,
        balanceAfter: lockedWallet.totalBalance + amount,
        orderId,
        description,
      },
    });

    await tx.referralReward.update({
      where: { id: reward.id },
      data: { isCredited: true, creditedAt: new Date() },
    });

    await tx.referralCode.updateMany({
      where: { userId },
      data: { totalRewardEarned: { increment: amount } },
    });

    return true;
  }

  /**
   * B13: notifikasi REFERRAL_REWARD_RECEIVED untuk semua penerima reward yang
   * dipicu order ini. Dipanggil POST-COMMIT oleh ketiga jalur completion
   * (buyer confirm, auto-complete, admin force-complete) — template sudah ada
   * di notification-copy.service.ts tetapi tidak pernah di-enqueue. Best-effort.
   */
  async notifyRewardsForOrder(orderPublicId: string): Promise<void> {
    if (!this.notificationQueue) return;
    try {
      const rewards = await this.prisma.referralReward.findMany({
        where: { triggeredByOrder: { orderId: orderPublicId } },
        select: { referrerId: true, rewardAmount: true },
      });
      for (const reward of rewards) {
        const copy = renderNotificationCopy(
          NotificationType.REFERRAL_REWARD_RECEIVED,
          await resolveNotificationLanguage(this.prisma, reward.referrerId),
          { amount: formatSen(reward.rewardAmount) },
        );
        await this.notificationQueue.enqueue({
          userId: reward.referrerId,
          type: NotificationType.REFERRAL_REWARD_RECEIVED,
          title: copy.title,
          body: copy.body,
          pushData: { type: 'REFERRAL_REWARD_RECEIVED', orderId: orderPublicId },
        });
      }
    } catch (error: unknown) {
      this.logger.warn(
        `silent-catch: referral reward notification failed for order ${orderPublicId}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * M4 no-wallet — didorong scheduler (cron dana-refund-retry): bayarkan
   * referralReward yang sudah diklaim tetapi belum cair (`isCredited=false`)
   * via disbursement DANA scope REFERRAL.
   *
   * Idempoten: kunci `REFERRAL:<rewardId>` stabil; `isCredited` hanya menjadi
   * true setelah disbursement benar-benar RELEASED. Tanpa rekening bank
   * terverifikasi → HELD_NO_BANK (fail-closed, tidak hangus, dicoba lagi).
   */
  async payoutPendingReferralRewards(limit = 50): Promise<{ attempted: number; released: number }> {
    if (!this.disbursement) {
      throw new Error('REFERRAL_PAYOUT_UNAVAILABLE');
    }
    const pending = await this.prisma.referralReward.findMany({
      where: { isCredited: false },
      orderBy: { createdAt: 'asc' },
      take: limit,
      select: { id: true, referrerId: true, rewardAmount: true, triggeredByOrderId: true },
    });
    let released = 0;
    for (const reward of pending) {
      try {
        const result = await this.disbursement.releaseFunds({
          idempotencyKey: `REFERRAL:${reward.id}`,
          scope: EscrowDisbursementScope.REFERRAL,
          sellerId: reward.referrerId, // penerima payout
          amountSen: reward.rewardAmount,
          reason: `Referral reward — order ${reward.triggeredByOrderId}`,
        });
        if (result.outcome === 'RELEASED') {
          await this.prisma.referralReward.update({
            where: { id: reward.id },
            data: { isCredited: true, creditedAt: new Date() },
          });
          released++;
        }
      } catch (e) {
        this.logger.warn(
          `Payout referral gagal: reward=${reward.id}: ${(e as Error).message}`,
        );
      }
    }
    return { attempted: pending.length, released };
  }
}
