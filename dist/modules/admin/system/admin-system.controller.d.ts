import { AdminSystemService } from './admin-system.service';
import { UpdateConfigDto } from './dto/update-config.dto';
import { BroadcastDto } from './dto/broadcast.dto';
import { AuditLogQueryDto, WebhookLogQueryDto } from './dto/audit-log-query.dto';
import { WebhookDeadLetterResolutionDto } from './dto/webhook-dead-letter.dto';
import { Request } from 'express';
export declare class AdminSystemController {
    private readonly service;
    constructor(service: AdminSystemService);
    listConfigs(): Promise<object[]>;
    updateConfig(key: string, dto: UpdateConfigDto, adminId: string, req: Request): Promise<object>;
    listPendingConfigChanges(): Promise<object[]>;
    approveConfigChange(key: string, adminId: string, req: Request): Promise<object>;
    rejectConfigChange(key: string, adminId: string, req: Request): Promise<{
        message: string;
    }>;
    listAuditLogs(query: AuditLogQueryDto): Promise<object>;
    listWebhookLogs(query: WebhookLogQueryDto): Promise<object>;
    retryDeadLetterWebhook(id: string, adminId: string, req: Request): Promise<object>;
    resolveDeadLetterWebhook(id: string, dto: WebhookDeadLetterResolutionDto, adminId: string, req: Request): Promise<object>;
    sendBroadcast(dto: BroadcastDto, adminId: string, req: Request): Promise<{
        recipientCount: number;
    }>;
}
