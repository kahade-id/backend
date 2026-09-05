import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { createPaginatedResponse } from '../../../common/dto/pagination.dto';
import { toIdr } from '../../../common/utils/currency.util';

@Injectable()
export class AdminReferralService {
  constructor(private prisma: PrismaService) {}

  async getReferralStats(): Promise<object> {
    const [totalCodes, activeCodes, totalRelations, totalRewards, pendingRewards] =
      await Promise.all([
        this.prisma.referralCode.count(),
        this.prisma.referralCode.count({ where: { isActive: true } }),
        this.prisma.referralRelation.count(),
        this.prisma.referralReward.count(),
        this.prisma.referralReward.count({ where: { isCredited: false } }),
      ]);

    const rewardAggregation = await this.prisma.referralReward.aggregate({
      _sum: {
        rewardAmount: true,
      },
      where: { isCredited: true },
    });

    return {
      totalCodes,
      activeCodes,
      totalRelations,
      totalRewards,
      pendingRewards,
      totalRewardsPaid: toIdr(rewardAggregation._sum.rewardAmount ?? BigInt(0)),
    };
  }

  async listReferralCodes(page: number, limit: number, isActive?: string): Promise<object> {
    const safePage = Math.max(1, Number.isFinite(page) ? Math.trunc(page) : 1);
    const safeLimit = Math.min(100, Math.max(1, Number.isFinite(limit) ? Math.trunc(limit) : 20));
    const skip = (safePage - 1) * safeLimit;

    const normalizedActive =
      typeof isActive === 'string' ? isActive.trim().toLowerCase() : undefined;
    const where: Prisma.ReferralCodeWhereInput = {};
    if (normalizedActive === 'true') where.isActive = true;
    if (normalizedActive === 'false') where.isActive = false;

    const [codes, total] = await Promise.all([
      this.prisma.referralCode.findMany({
        where,
        skip,
        take: safeLimit,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        include: {
          user: {
            select: {
              id: true,
              userId: true,
              username: true,
              fullName: true,
              email: true,
            },
          },
        },
      }),
      this.prisma.referralCode.count({ where }),
    ]);

    const data = codes.map(c => ({
      ...c,
      totalRewardEarned: toIdr(c.totalRewardEarned),
    }));

    return createPaginatedResponse(data, total, safePage, safeLimit);
  }
}
