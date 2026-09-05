import { Injectable, Logger, Optional } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bull';
import { Queue } from 'bull';
import { UserAuditAction, AuditAction, Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';

export const AUDIT_LOG_QUEUE = 'audit-log';

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

/**
 * Append-only audit log service.
 *
 * By design this service only supports `create` operations.
 * No update or delete methods are provided to ensure the integrity
 * of the audit trail. Any attempt to modify or remove audit entries
 * must go through a separate, controlled database migration process
 * with explicit approval.
 *
 * Retries are handled via Bull queue (SEC-021) and exhausted events
 * are forwarded to a dead-letter queue for manual inspection (SEC-020).
 */
@Injectable()
export class AuditLogService {
  private readonly logger = new Logger(AuditLogService.name);

  constructor(
    private prisma: PrismaService,
    @Optional() @InjectQueue(AUDIT_LOG_QUEUE) private readonly auditQueue?: Queue<AuditLogJobData>,
  ) {}

  logUserAction(params: LogUserActionParams): void {
    if (this.auditQueue) {
      this.auditQueue.add('write', { type: 'user', params }, {
        attempts: 3,
        backoff: { type: 'exponential', delay: 1000 },
        removeOnComplete: 100,
        removeOnFail: false,
      }).catch((err: unknown) => {
        this.logger.error(`[AuditLog] Failed to enqueue user audit log (${params.action}): ${(err as Error).message}`);
        this.writeDirectFallback('user', params);
      });
    } else {
      this.writeDirectFallback('user', params);
    }
  }

  logAdminAction(params: LogAdminActionParams): void {
    if (this.auditQueue) {
      this.auditQueue.add('write', { type: 'admin', params }, {
        attempts: 3,
        backoff: { type: 'exponential', delay: 1000 },
        removeOnComplete: 100,
        removeOnFail: false,
      }).catch((err: unknown) => {
        this.logger.error(`[AuditLog] Failed to enqueue admin audit log (${params.action}): ${(err as Error).message}`);
        this.writeDirectFallback('admin', params);
      });
    } else {
      this.writeDirectFallback('admin', params);
    }
  }

  async writeUserAction(params: LogUserActionParams): Promise<void> {
    await this.prisma.auditLog.create({
      data: {
        userId: params.userId ?? null,
        action: params.action,
        entityType: params.entityType,
        entityId: params.entityId,
        description: params.description,
        before: (params.before ?? Prisma.DbNull) as Prisma.InputJsonValue,
        after: (params.after ?? Prisma.DbNull) as Prisma.InputJsonValue,
        ipAddress: params.ipAddress ?? null,
        userAgent: params.userAgent ?? null,
        requestId: params.requestId ?? null,
      },
    });
  }

  async writeAdminAction(params: LogAdminActionParams): Promise<void> {
    await this.prisma.adminAuditLog.create({
      data: {
        adminId: params.adminId,
        action: params.action,
        targetType: params.targetType ?? null,
        targetId: params.targetId ?? null,
        description: params.description,
        before: (params.before ?? Prisma.DbNull) as Prisma.InputJsonValue,
        after: (params.after ?? Prisma.DbNull) as Prisma.InputJsonValue,
        ipAddress: params.ipAddress,
        userAgent: params.userAgent ?? null,
      },
    });
  }

  private writeDirectFallback(type: 'user' | 'admin', params: LogUserActionParams | LogAdminActionParams, attempt = 1): void {
    const label = type === 'user'
      ? `user audit log (${(params as LogUserActionParams).action})`
      : `admin audit log (${(params as LogAdminActionParams).action})`;
    const fn = type === 'user'
      ? () => this.writeUserAction(params as LogUserActionParams)
      : () => this.writeAdminAction(params as LogAdminActionParams);

    fn().catch((err: unknown) => {
      this.logger.error(`[AuditLog] Direct write failed for ${label} (attempt ${attempt}): ${(err as Error).message}`);
      if (attempt < 3) {
        const delay = attempt * 1000;
        setTimeout(() => this.writeDirectFallback(type, params, attempt + 1), delay);
      } else {
        this.logger.error(`[AuditLog] CRITICAL: Exhausted direct retries for ${label} — audit event lost`);
        if (this.auditQueue) {
          this.auditQueue.add('dead-letter-fallback', {
            type,
            params,
            _deadLetterReason: `Direct write exhausted after ${attempt} attempts`,
          } as unknown as AuditLogJobData, {
            attempts: 1,
            removeOnComplete: false,
            removeOnFail: false,
          }).catch(() => {
            this.logger.error(`[AuditLog] CRITICAL: DLQ fallback also failed for ${label} — audit event permanently lost`);
          });
        }
      }
    });
  }
}
