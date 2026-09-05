import { Injectable, NotFoundException, BadRequestException, Logger } from '@nestjs/common';
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
} from '@prisma/client';
import { generateWalletTxId, generateReferralCode } from '../../common/utils/id-generator.util';
import { WalletTxSerialService } from '../../common/services/wallet-tx-serial.service';
import { createPaginatedResponse, PaginatedResponse } from '../../common/dto/pagination.dto';
import { toIdr } from '../../common/utils/currency.util';
import * as ErrorCodes from '../../common/constants/error-codes';

const REFERRAL_REWARD_AMOUNT = BigInt(500_000);

@Injectable()
export class ReferralService {
  private readonly logger = new Logger(ReferralService.name);

  constructor(
    private prisma: PrismaService,
    private redis: RedisService,
    private walletTxSerialService: WalletTxSerialService,
    private configService: ConfigService,
  ) {}

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

      return relation;
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

    if (!referralCode) {
      return {
        code: null,
        totalReferrals: 0,
        successfulReferrals: 0,
        totalRewardEarned: 0,
        pendingRewardCount: 0,
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
      }),
      this.prisma.referralReward.count({ where }),
    ]);

    const serialized = data.map(r => ({
      id: r.id,
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

    const serialized = data.map(rel => ({
      ...rel,
      viewerRole: rel.referrerId === userId ? 'REFERRER' : 'REFEREE',
      rewards: rel.rewards?.map(r => ({
        ...r,
        feeAmount: toIdr(r.feeAmount),
        rewardAmount: toIdr(r.rewardAmount),
      })),
    }));

    return createPaginatedResponse(serialized, total, safePage, safeLimit);
  }

  async createReferralRewardIfEligible(
    userId: string,
    feeAmount: bigint,
    orderId: string,
    tx: Prisma.TransactionClient,
  ): Promise<void> {
    const relation = await tx.referralRelation.findUnique({
      where: { refereeId: userId },
    });

    if (!relation) return;

    if (relation.isRewardActive) return;

    const order = await tx.order.findUnique({
      where: { id: orderId },
      select: { status: true },
    });
    if (!order || order.status !== OrderStatus.COMPLETED) {
      this.logger.warn(
        `Referral reward skipped for order ${orderId}: order status is ${order?.status ?? 'NOT_FOUND'}, expected COMPLETED`,
      );
      return;
    }

    const [referrer, referee] = await Promise.all([
      tx.user.findUnique({ where: { id: relation.referrerId }, select: { kycStatus: true } }),
      tx.user.findUnique({ where: { id: relation.refereeId }, select: { kycStatus: true } }),
    ]);

    if (!referrer || referrer.kycStatus !== KycStatus.APPROVED) {
      this.logger.log(
        `Referral reward skipped for order ${orderId}: referrer ${relation.referrerId} not KYC verified`,
      );
      return;
    }

    if (!referee || referee.kycStatus !== KycStatus.APPROVED) {
      this.logger.log(
        `Referral reward skipped for order ${orderId}: referee ${relation.refereeId} not KYC verified`,
      );
      return;
    }

    const referrerCompletedOrders = await tx.order.count({
      where: {
        OR: [{ buyerId: relation.referrerId }, { sellerId: relation.referrerId }],
        status: OrderStatus.COMPLETED,
      },
    });

    if (referrerCompletedOrders < 1) {
      this.logger.log(
        `Referral reward skipped for order ${orderId}: referrer ${relation.referrerId} has no completed transactions`,
      );
      return;
    }

    const refereeCompletedOrders = await tx.order.count({
      where: {
        OR: [{ buyerId: relation.refereeId }, { sellerId: relation.refereeId }],
        status: OrderStatus.COMPLETED,
      },
    });

    if (refereeCompletedOrders !== 1) {
      this.logger.log(
        `Referral reward skipped for order ${orderId}: referee ${relation.refereeId} has ${refereeCompletedOrders} completed transactions (expected exactly 1 — first transaction)`,
      );
      return;
    }

    const walletCount = await tx.wallet.count({
      where: { userId: { in: [relation.referrerId, relation.refereeId] } },
    });
    if (walletCount !== 2) {
      this.logger.warn(
        `Referral reward skipped for order ${orderId}: both referral wallets are required before crediting either side`,
      );
      return;
    }

    const referrerCredited = await this.creditReward(
      relation.referrerId,
      REFERRAL_REWARD_AMOUNT,
      feeAmount,
      orderId,
      relation.id,
      'Referral reward — you invited a new user',
      tx,
    );
    const refereeCredited = await this.creditReward(
      relation.refereeId,
      REFERRAL_REWARD_AMOUNT,
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
      return;
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
      `Referral rewards Rp5.000 each credited to referrer ${relation.referrerId} and referee ${relation.refereeId} for order ${orderId}`,
    );
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

    const lockedWallets = await tx.$queryRaw<Array<{ id: string; totalBalance: bigint }>>`
      SELECT id, "totalBalance" FROM wallets WHERE "userId" = ${userId} FOR UPDATE
    `;
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
}
