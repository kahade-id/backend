import { Badge } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { PaginatedResponse } from '../../common/dto/pagination.dto';
export type BadgeCatalogItem = Badge & {
    isOwned: boolean;
    earnedAt: Date | null;
};
export declare class BadgesService {
    private prisma;
    constructor(prisma: PrismaService);
    listAllBadges(userId: string, page?: number, limit?: number): Promise<PaginatedResponse<BadgeCatalogItem>>;
    getMyBadges(userId: string, page?: number, limit?: number): Promise<PaginatedResponse<{
        id: string;
        earnedAt: Date;
        badge: Badge;
    }>>;
}
