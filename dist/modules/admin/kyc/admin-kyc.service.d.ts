import { Queue } from 'bull';
import { PrismaService } from '../../../prisma/prisma.service';
import { RedisService } from '../../../redis/redis.service';
import { AuditLogService } from '../../../common/services/audit-log.service';
import { UploadService } from '../../upload/upload.service';
import { PaginatedResponse } from '../../../common/dto/pagination.dto';
import { EmailJobData } from '../../queue/processors/email.processor';
export declare class AdminKycService {
    private prisma;
    private redis;
    private auditLog;
    private uploadService;
    private readonly emailQueue;
    private readonly logger;
    constructor(prisma: PrismaService, redis: RedisService, auditLog: AuditLogService, uploadService: UploadService, emailQueue: Queue<EmailJobData>);
    private invalidateKycCache;
    private normalizeOptionalText;
    private normalizeRequiredText;
    getKycQueue(page?: number, limit?: number, status?: string): Promise<PaginatedResponse<Record<string, unknown>>>;
    approveKyc(kycId: string, adminId: string, notes?: string, ipAddress?: string): Promise<Record<string, unknown>>;
    rejectKyc(kycId: string, adminId: string, reason: string, notes?: string, ipAddress?: string): Promise<Record<string, unknown>>;
    revokeKyc(kycId: string, adminId: string, reason: string, ipAddress?: string): Promise<Record<string, unknown>>;
    getKycDetail(kycId: string, adminId?: string, ipAddress?: string): Promise<Record<string, unknown>>;
    getDocumentUrls(kycId: string, adminId: string, ipAddress?: string, adminPassword?: string): Promise<{
        ktpUrl: string | null;
        selfieUrl: string | null;
        partialErrors?: string[];
    }>;
}
