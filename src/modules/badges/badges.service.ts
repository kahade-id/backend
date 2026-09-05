import { Injectable } from '@nestjs/common';
import { Badge } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { createPaginatedResponse, PaginatedResponse } from '../../common/dto/pagination.dto';

export type BadgeCatalogItem = Badge & { isOwned: boolean; earnedAt: Date | null };

@Injectable()
export class BadgesService {
  constructor(private prisma: PrismaService) {}

  async listAllBadges(
    userId: string,
    page = 1,
    limit = 20,
  ): Promise<PaginatedResponse<BadgeCatalogItem>> {
    const safePage = Math.max(1, Number.isFinite(page) ? Math.floor(page) : 1);
    const safeLimit = Math.min(100, Math.max(1, Number.isFinite(limit) ? Math.floor(limit) : 20));
    const skip = (safePage - 1) * safeLimit;

    const [badges, total] = await Promise.all([
      this.prisma.badge.findMany({
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        skip,
        take: safeLimit,
        include: {
          userBadges: {
            where: { userId },
            select: { earnedAt: true },
            take: 1,
          },
        },
      }),
      this.prisma.badge.count(),
    ]);

    const mapped = badges.map(({ userBadges, ...badge }) => ({
      ...badge,
      isOwned: userBadges.length > 0,
      earnedAt: userBadges[0]?.earnedAt ?? null,
    }));

    return createPaginatedResponse(mapped, total, safePage, safeLimit);
  }

  async getMyBadges(
    userId: string,
    page = 1,
    limit = 50,
  ): Promise<PaginatedResponse<{ id: string; earnedAt: Date; badge: Badge }>> {
    const safePage = Math.max(1, Number.isFinite(page) ? Math.floor(page) : 1);
    const safeLimit = Math.min(100, Math.max(1, Number.isFinite(limit) ? Math.floor(limit) : 50));
    const skip = (safePage - 1) * safeLimit;

    const [userBadges, total] = await Promise.all([
      this.prisma.userBadge.findMany({
        where: { userId },
        include: { badge: true },
        orderBy: [{ earnedAt: 'desc' }, { id: 'desc' }],
        skip,
        take: safeLimit,
      }),
      this.prisma.userBadge.count({ where: { userId } }),
    ]);

    const mapped = userBadges.map(ub => ({
      id: ub.id,
      earnedAt: ub.earnedAt,
      badge: ub.badge,
    }));

    return createPaginatedResponse(mapped, total, safePage, safeLimit);
  }
}
