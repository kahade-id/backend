import { Injectable } from '@nestjs/common';
import { MembershipRank, Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { SEARCH_MAX_RESULTS } from '../../common/constants/app.constants';

@Injectable()
export class UserSearchService {
  constructor(private prisma: PrismaService) {}

  async searchUsers(query: string, filters: {
    minRating?: number;
    minTransactions?: number;
    isKycVerified?: boolean;
    membershipRank?: string;
  }, page: number, limit: number, viewerId?: string): Promise<object> {
    const safePage = Math.max(1, page);
    const safeLimit = Math.min(Math.max(1, limit), SEARCH_MAX_RESULTS);
    const skip = (safePage - 1) * safeLimit;

    const where: Prisma.UserWhereInput = {
      isActive: true,
      isBanned: false,
      profileVisible: true,
      deletedAt: null,
    };

    if (viewerId) {
      const blocks = await this.prisma.blockList.findMany({
        where: { OR: [{ blockerId: viewerId }, { blockedId: viewerId }] },
        select: { blockerId: true, blockedId: true },
      });
      const blockedIds = new Set<string>();
      for (const b of blocks) {
        if (b.blockerId !== viewerId) blockedIds.add(b.blockerId);
        if (b.blockedId !== viewerId) blockedIds.add(b.blockedId);
      }
      if (blockedIds.size > 0) {
        where.id = { notIn: Array.from(blockedIds) };
      }
    }

    if (query) {
      const sanitizedQuery = query.replace(/[<>&"']/g, '').trim();
      if (sanitizedQuery.length > 0) {
        const tsQuery = sanitizedQuery
          .split(/\s+/)
          .filter(w => w.length > 0)
          .map(w => w.replace(/[^a-zA-Z0-9]/g, ''))
          .filter(w => w.length > 0)
          .join(' & ');

        if (tsQuery.length > 0) {
          where.OR = [
            { username: { contains: tsQuery, mode: 'insensitive' } },
            { fullName: { contains: tsQuery, mode: 'insensitive' } },
          ];
        } else {
          where.OR = [
            { username: { startsWith: sanitizedQuery.toLowerCase(), mode: 'insensitive' } },
            { fullName: { startsWith: sanitizedQuery, mode: 'insensitive' } },
          ];
        }
      }
    }

    if (filters.minRating !== undefined) {
      where.averageRating = { gte: filters.minRating };
    }
    if (filters.minTransactions !== undefined) {
      where.totalOrdersCompleted = { gte: filters.minTransactions };
    }
    if (filters.isKycVerified) {
      where.kycStatus = 'APPROVED';
    }
    if (filters.membershipRank) {
      where.membershipRank = filters.membershipRank as MembershipRank;
    }

    const [users, total] = await Promise.all([
      this.prisma.user.findMany({
        where,
        orderBy: [{ totalOrdersCompleted: 'desc' }, { averageRating: 'desc' }],
        skip,
        take: safeLimit,
        select: {
          userId: true,
          username: true,
          fullName: true,
          avatarUrl: true,
          bio: true,
          membershipRank: true,
          averageRating: true,
          totalRatingCount: true,
          totalOrdersCompleted: true,
          kycStatus: true,
          isVip: true,
          createdAt: true,
          _count: { select: { followers: true } },
        },
      }),
      this.prisma.user.count({ where }),
    ]);

    return {
      data: users.map(u => ({
        userId: u.userId,
        username: u.username,
        fullName: u.fullName,
        avatarUrl: u.avatarUrl,
        bio: u.bio,
        membershipRank: u.membershipRank,
        avgRating: u.averageRating,
        ratingCount: u.totalRatingCount,
        totalOrdersCompleted: u.totalOrdersCompleted,
        isKycVerified: u.kycStatus === 'APPROVED',
        isVip: u.isVip,
        followersCount: u._count.followers,
        memberSince: u.createdAt,
      })),
      total,
      page: safePage,
      limit: safeLimit,
      totalPages: Math.ceil(total / safeLimit),
    };
  }
}
