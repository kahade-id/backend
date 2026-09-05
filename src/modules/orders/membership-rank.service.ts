import { Injectable, Logger } from '@nestjs/common';
import { MembershipRank, Prisma } from '@prisma/client';

const RANK_THRESHOLDS: { rank: MembershipRank; minOrders: number }[] = [
  { rank: MembershipRank.DIAMOND, minOrders: 200 },
  { rank: MembershipRank.PLATINUM, minOrders: 100 },
  { rank: MembershipRank.GOLD, minOrders: 50 },
  { rank: MembershipRank.SILVER, minOrders: 20 },
  { rank: MembershipRank.BRONZE, minOrders: 0 },
];

const RANK_ORDER: Record<MembershipRank, number> = {
  BRONZE: 0,
  SILVER: 1,
  GOLD: 2,
  PLATINUM: 3,
  DIAMOND: 4,
};

@Injectable()
export class MembershipRankService {
  private readonly logger = new Logger(MembershipRankService.name);

  async checkAndUpdateMembershipRank(tx: Prisma.TransactionClient, userId: string): Promise<void> {
    try {
      const user = await tx.user.findUnique({
        where: { id: userId },
        select: {
          membershipRank: true,
          totalOrdersCompleted: true,
          totalTransactionValue: true,
          createdAt: true,
        },
      });
      if (!user) return;

      const newRank = RANK_THRESHOLDS.find(t => user.totalOrdersCompleted >= t.minOrders)?.rank ?? MembershipRank.BRONZE;

      if (RANK_ORDER[newRank] > RANK_ORDER[user.membershipRank]) {
        const memberDays = Math.floor((Date.now() - user.createdAt.getTime()) / (1000 * 60 * 60 * 24));

        await tx.user.update({
          where: { id: userId },
          data: { membershipRank: newRank, rankUpdatedAt: new Date() },
        });

        const ratingAgg = await tx.rating.aggregate({
          where: { receiverId: userId },
          _avg: { stars: true },
        });

        await tx.membershipRankHistory.create({
          data: {
            userId,
            fromRank: user.membershipRank,
            toRank: newRank,
            reason: `Reached ${user.totalOrdersCompleted} completed orders`,
            totalOrders: user.totalOrdersCompleted,
            totalValue: user.totalTransactionValue,
            averageRating: ratingAgg._avg?.stars ?? 0,
            memberDays,
          },
        });

        this.logger.log(`User ${userId} ranked up: ${user.membershipRank} → ${newRank}`);
      }
    } catch (err) {
      /*
       * C-22: this runs on the caller's `tx`, inside the caller's Serializable transaction
       * (`order-state.service.ts:562`, `admin-orders.service.ts:343`,
       * `auto-complete-orders.service.ts:332` — all three at the very end, after the order status,
       * escrow release, wallet writes and referral rewards).
       *
       * Swallowing a *database* error here is both futile and harmful. Futile because PostgreSQL
       * has already aborted the transaction — every later statement on this `tx` fails with 25P02
       * and the whole completion rolls back regardless of what we do with the JS exception, so
       * there is no order completion left to protect. Harmful because the caller wraps its
       * transaction in a retry loop keyed on `isRetryableDbError` (P2034 / 40001 / 40P01 /
       * deadlock): a serialization conflict landing on the rank write is exactly the case that
       * loop exists to retry, and catching it here means the loop never sees a retryable error.
       * The completion then fails — or, worse, reports success for a transaction the server rolled
       * back — instead of simply retrying and succeeding.
       *
       * A plain JS fault (a bad enum lookup, a null `createdAt`) does not touch the connection and
       * leaves the transaction healthy, so for those the original best-effort intent still holds
       * and still applies: log and continue.
       */
      if (
        err instanceof Prisma.PrismaClientKnownRequestError ||
        err instanceof Prisma.PrismaClientUnknownRequestError ||
        err instanceof Prisma.PrismaClientRustPanicError
      ) {
        throw err;
      }
      this.logger.error(`Failed to update membership rank for user ${userId}: ${(err as Error).message}`);
    }
  }
}
