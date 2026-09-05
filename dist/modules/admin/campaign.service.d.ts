import { CampaignType, CampaignStatus } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditLogService } from '../../common/services/audit-log.service';
export declare class CampaignService {
    private prisma;
    private auditLog;
    private readonly logger;
    constructor(prisma: PrismaService, auditLog: AuditLogService);
    createCampaign(adminId: string, dto: {
        name: string;
        description?: string;
        type: CampaignType;
        startsAt: Date;
        endsAt: Date;
        discountValue?: number;
        discountPercent?: number;
        maxDiscount?: number;
        freeTransactions?: number;
        targetAudience?: string;
        maxRedemptions?: number;
    }, ipAddress?: string): Promise<object>;
    getCampaigns(page: number, limit: number, status?: string): Promise<object>;
    getCampaign(campaignId: string): Promise<object>;
    updateCampaign(campaignId: string, adminId: string, dto: {
        name?: string;
        description?: string;
        startsAt?: Date;
        endsAt?: Date;
        maxRedemptions?: number;
        status?: CampaignStatus;
        rolloutPercent?: number;
    }, ipAddress?: string): Promise<object>;
    deleteCampaign(campaignId: string, adminId: string, ipAddress?: string): Promise<{
        message: string;
    }>;
    private formatCampaign;
}
