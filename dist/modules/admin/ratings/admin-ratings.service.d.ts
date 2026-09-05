import { PrismaService } from '../../../prisma/prisma.service';
import { AuditLogService } from '../../../common/services/audit-log.service';
import { PaginatedResponse } from '../../../common/dto/pagination.dto';
export declare class AdminRatingsService {
    private prisma;
    private auditLog;
    constructor(prisma: PrismaService, auditLog: AuditLogService);
    listRatings(page: number, limit: number, stars?: string, flagged?: string): Promise<PaginatedResponse<Record<string, unknown>>>;
    removeRating(ratingId: string, adminId: string, ipAddress: string, reason: string): Promise<{
        message: string;
        ratingId: string;
    }>;
    unhideRating(ratingId: string, adminId: string, ipAddress: string, reason: string): Promise<{
        message: string;
        ratingId: string;
    }>;
    private recalcReceiverStats;
}
