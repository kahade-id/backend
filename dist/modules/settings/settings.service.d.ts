import { Queue } from 'bull';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditLogService } from '../../common/services/audit-log.service';
import { RedisService } from '../../redis/redis.service';
import { PaginatedResponse } from '../../common/dto/pagination.dto';
import { ReportUserSettingsDto } from './dto/report-user.dto';
import { UploadService } from '../upload/upload.service';
import { NotificationQueueService } from '../queue/notification-queue.service';
import { EmailJobData } from '../queue/processors/email.processor';
export declare class SettingsService {
    private prisma;
    private auditLog;
    private redis;
    private configService;
    private uploadService;
    private notificationQueue;
    private readonly emailQueue;
    constructor(prisma: PrismaService, auditLog: AuditLogService, redis: RedisService, configService: ConfigService, uploadService: UploadService, notificationQueue: NotificationQueueService, emailQueue: Queue<EmailJobData>);
    listBlockedUsers(userId: string, page: number, limit: number): Promise<PaginatedResponse<Record<string, unknown>>>;
    blockUser(blockerId: string, blockedId: string): Promise<{
        message: string;
    }>;
    unblockUser(blockerId: string, blockedId: string): Promise<{
        message: string;
    }>;
    reportUser(reporterId: string, dto: ReportUserSettingsDto): Promise<{
        message: string;
        reportId: string;
    }>;
    listMyReports(userId: string, page: number, limit: number): Promise<PaginatedResponse<Record<string, unknown>>>;
    private privacyKey;
    private languageKey;
    getPrivacySettings(userId: string): Promise<{
        profileVisible: boolean;
        showOnlineStatus: boolean;
    }>;
    updatePrivacySettings(userId: string, dto: {
        profileVisible?: boolean;
        showOnlineStatus?: boolean;
    }): Promise<{
        profileVisible: boolean;
        showOnlineStatus: boolean;
        message: string;
    }>;
    getLanguage(userId: string): Promise<{
        language: string;
    }>;
    updateLanguage(userId: string, language: string): Promise<{
        language: string;
        message: string;
    }>;
    requestDataExport(userId: string): Promise<{
        message: string;
        downloadUrl: string;
        expiresAt: Date;
    }>;
    private maskIpAddress;
}
