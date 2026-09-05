import { AdminBadgesService } from './admin-badges.service';
import { CreateBadgeDto, UpdateBadgeDto } from './dto/create-badge.dto';
import { PaginationDto } from '../../../common/dto/pagination.dto';
import { Request } from 'express';
export declare class AdminBadgesController {
    private readonly service;
    constructor(service: AdminBadgesService);
    listBadges(pagination: PaginationDto): Promise<object>;
    getBadgeDetail(badgeId: string): Promise<object>;
    createBadge(dto: CreateBadgeDto, adminId: string, req: Request): Promise<object>;
    updateBadge(badgeId: string, dto: UpdateBadgeDto, adminId: string, req: Request): Promise<object>;
    deleteBadge(badgeId: string, adminId: string, req: Request): Promise<{
        message: string;
    }>;
    awardBadge(badgeId: string, userId: string, adminId: string, req: Request): Promise<object>;
    revokeBadge(badgeId: string, userId: string, adminId: string, req: Request): Promise<{
        message: string;
    }>;
}
