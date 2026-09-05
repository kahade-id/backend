import { Queue } from 'bull';
import { UserAuditAction, AuditAction } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
export declare const AUDIT_LOG_QUEUE = "audit-log";
export interface LogUserActionParams {
    userId?: string;
    action: UserAuditAction;
    entityType: string;
    entityId: string;
    description: string;
    before?: Record<string, unknown>;
    after?: Record<string, unknown>;
    ipAddress?: string;
    userAgent?: string;
    requestId?: string;
}
export interface LogAdminActionParams {
    adminId: string;
    action: AuditAction;
    targetType?: string;
    targetId?: string;
    description: string;
    before?: Record<string, unknown>;
    after?: Record<string, unknown>;
    ipAddress: string;
    userAgent?: string;
}
export interface AuditLogJobData {
    type: 'user' | 'admin';
    params: LogUserActionParams | LogAdminActionParams;
}
export declare class AuditLogService {
    private prisma;
    private readonly auditQueue?;
    private readonly logger;
    constructor(prisma: PrismaService, auditQueue?: Queue<AuditLogJobData> | undefined);
    logUserAction(params: LogUserActionParams): void;
    logAdminAction(params: LogAdminActionParams): void;
    writeUserAction(params: LogUserActionParams): Promise<void>;
    writeAdminAction(params: LogAdminActionParams): Promise<void>;
    private writeDirectFallback;
}
