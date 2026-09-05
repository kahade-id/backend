import { ReferralCode, ReferralRelation } from '@prisma/client';
import { ReferralService } from './referral.service';
import { ApplyReferralDto } from './dto/apply-referral.dto';
import { PaginationDto, PaginatedResponse } from '../../common/dto/pagination.dto';
export declare class ReferralController {
    private referralService;
    constructor(referralService: ReferralService);
    getMyCode(userId: string): Promise<ReferralCode>;
    applyCode(userId: string, dto: ApplyReferralDto): Promise<ReferralRelation>;
    getStats(userId: string): Promise<Record<string, unknown>>;
    getRewards(userId: string, query: PaginationDto): Promise<PaginatedResponse<Record<string, unknown>>>;
    regenerateCode(userId: string): Promise<ReferralCode>;
    getHistory(userId: string, query: PaginationDto): Promise<PaginatedResponse<Record<string, unknown>>>;
}
