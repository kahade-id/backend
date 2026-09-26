import { Injectable } from '@nestjs/common';
import { MembershipRank, Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { SEARCH_MAX_RESULTS } from '../../common/constants/app.constants';
import { escapeLikePattern } from '../../common/utils/search.util';
import { VerificationBadgeService } from './verification-badge.service';

@Injectable()
export class UserSearchService {
  constructor(
    private prisma: PrismaService,
    private verificationBadgeService: VerificationBadgeService,
  ) {}

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
        // T1 (audit Discovery 2026-09-26): tiap kata harus muncul (AND) di
        // username ATAU fullName. Versi lama menggabung kata dengan ' & '
        // lalu memakainya di LIKE `contains` — string literal seperti
        // "budi & santoso" tidak pernah cocok di mana pun, sehingga pencarian
        // user multi-kata selalu kosong di endpoint ini.
        const words = sanitizedQuery
          .split(/\s+/)
          .map(w => w.replace(/[^\p{L}\p{N}]/gu, ''))
          .filter(w => w.length > 0);

        if (words.length > 0) {
          where.AND = words.map(w => ({
            OR: [
              { username: { contains: escapeLikePattern(w), mode: 'insensitive' } },
              { fullName: { contains: escapeLikePattern(w), mode: 'insensitive' } },
            ],
          }));
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
        orderBy: [{ totalOrdersCompleted: 'desc' }, { averageRating: 'desc' }, { id: 'asc' }], // R2-L: id tiebreak for equal-rank users
        skip,
        take: safeLimit,
        select: {
          id: true,
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

    // R1 (audit 2026-09-26): sealTier disematkan agar <VerifiedSeal> bisa
    // dirender di hasil discover tanpa N+1 request badge.
    const sealTierMap = await this.verificationBadgeService.getSealTierMap(
      users.map((u) => u.id),
    );

    // DC-006 (audit Discovery 2026-09-26): status follow untuk viewer —
    // satu query untuk semua hasil (bukan N+1). Tanpa ini tombol follow di
    // tab Jelajahi selalu "Ikuti" dan state optimistis hilang saat refresh.
    const followingSet = new Set<string>();
    if (viewerId && users.length > 0) {
      const follows = await this.prisma.follow.findMany({
        where: {
          followerId: viewerId,
          followingId: { in: users.map((u) => u.id) },
        },
        select: { followingId: true },
      });
      for (const f of follows) followingSet.add(f.followingId);
    }

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
        sealTier: sealTierMap.get(u.id) ?? null,
        isVip: u.isVip,
        followersCount: u._count.followers,
        memberSince: u.createdAt,
        following: followingSet.has(u.id),
      })),
      total,
      page: safePage,
      limit: safeLimit,
      totalPages: Math.ceil(total / safeLimit),
    };
  }
}
