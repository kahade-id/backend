import { PrismaService } from '../../../prisma/prisma.service';
import { RedisService } from '../../../redis/redis.service';
import { AuditLogService } from '../../../common/services/audit-log.service';
import { NotificationQueueService } from '../../queue/notification-queue.service';
import { UpdateConfigDto } from './dto/update-config.dto';
import { BroadcastDto } from './dto/broadcast.dto';
import { AuditLogQueryDto, WebhookLogQueryDto } from './dto/audit-log-query.dto';
export declare class AdminSystemService {
    private prisma;
    private redis;
    private auditLogService;
    private notificationQueue;
    private readonly logger;
    constructor(prisma: PrismaService, redis: RedisService, auditLogService: AuditLogService, notificationQueue: NotificationQueueService);
    listConfigs(): Promise<object[]>;
    private isFinancialConfig;
    private validateConfigValue;
    updateConfig(key: string, dto: UpdateConfigDto, adminId: string, ipAddress: string): Promise<object>;
    getPendingConfigChange(key: string): Promise<object | null>;
    listPendingConfigChanges(): Promise<object[]>;
    approveConfigChange(key: string, approverId: string, ipAddress: string): Promise<object>;
    rejectConfigChange(key: string, rejecterId: string, ipAddress: string): Promise<{
        message: string;
    }>;
    listAuditLogs(query: AuditLogQueryDto): Promise<object>;
    listWebhookLogs(query: WebhookLogQueryDto): Promise<object>;
    retryDeadLetterWebhook(id: string, adminId: string, ipAddress: string): Promise<object>;
    resolveDeadLetterWebhook(id: string, adminId: string, ipAddress: string, resolution: string): Promise<object>;
    sendBroadcast(dto: BroadcastDto, adminId: string, ipAddress: string): Promise<{
        recipientCount: number;
        queuedCount: number;
        pushRequested: boolean;
    }>;
}
