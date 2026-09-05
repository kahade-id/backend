import { Badge } from '@prisma/client';
import { BadgesService } from './badges.service';
import { PaginationDto, PaginatedResponse } from '../../common/dto/pagination.dto';
export declare class BadgesController {
    private readonly badgesService;
    constructor(badgesService: BadgesService);
    listBadges(userId: string, pagination: PaginationDto): ReturnType<BadgesService['listAllBadges']>;
    getMyBadges(userId: string, pagination: PaginationDto): Promise<PaginatedResponse<{
        id: string;
        earnedAt: Date;
        badge: Badge;
    }>>;
}
