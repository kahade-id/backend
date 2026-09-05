import { Injectable, NotFoundException, BadRequestException, ForbiddenException, ConflictException, Logger } from '@nestjs/common';
import { randomBytes } from 'crypto';
import { PrismaService } from '../../../prisma/prisma.service';
import { RedisService } from '../../../redis/redis.service';
import { AuditLogService } from '../../../common/services/audit-log.service';
import { NotificationQueueService } from '../../queue/notification-queue.service';
import { createPaginatedResponse } from '../../../common/dto/pagination.dto';
import { UpdateConfigDto } from './dto/update-config.dto';
import { BroadcastDto } from './dto/broadcast.dto';
import { AuditLogQueryDto, WebhookLogQueryDto } from './dto/audit-log-query.dto';
import { AuditAction, NotificationCategory, NotificationChannel, NotificationType, Prisma, KycStatus } from '@prisma/client';
import { escapeHtml } from '../../../common/utils/sanitize.util';
import * as ErrorCodes from '../../../common/constants/error-codes';
import { ADMIN_SYSTEM_CONFIGS, FEE_CONFIG_CACHE, SUBSCRIPTION_PLANS_CACHE } from '../../../common/constants/redis-keys';
import { generateNotifId } from '../../../common/utils/id-generator.util';
import { parseDateBoundaryWIB } from '../../../common/utils/date.util';

const SYSTEM_CONFIG_TTL = 300;
const SYSTEM_CONFIG_LOCK_TTL = 10;
const PENDING_CONFIG_PREFIX = 'pending_config_change:';
const PENDING_CONFIG_TTL = 86400;
const MAX_ADMIN_PAGE = 100_000;

const FINANCIAL_CONFIG_KEYS = [
  'fee_percentage',
  'platform_fee',
  'commission_rate',
  'kahade_fee_rate',
  'kahade_plus_fee_rate',
  'withdrawal_fee',
  'payment_fee',
  'escrow_fee',
  'fee_savings_limit',
];

@Injectable()
export class AdminSystemService {
  private readonly logger = new Logger(AdminSystemService.name);

  constructor(
    private prisma: PrismaService,
    private redis: RedisService,
    private auditLogService: AuditLogService,
    private notificationQueue: NotificationQueueService,
  ) {}

  async listConfigs(): Promise<object[]> {
    // 1. Return from cache if available
    const cached = await this.redis.get(ADMIN_SYSTEM_CONFIGS);
    if (cached) {
      try {
        return JSON.parse(cached) as object[];
      } catch (_) {
        await this.redis.del(ADMIN_SYSTEM_CONFIGS);
      }
    }

    // 2. Acquire a short-lived mutex with a random ownership token to prevent cache stampede.
    //    setNx re-throws on Redis failure; we catch and track `redisDown` to skip the
    //    spin-wait (no point waiting for cache that can never be populated).
    const lockKey = `${ADMIN_SYSTEM_CONFIGS}:lock`;
    const lockToken = randomBytes(16).toString('hex');
    let lockAcquired = false;
    let redisDown = false;
    try {
      lockAcquired = await this.redis.setNx(lockKey, lockToken, SYSTEM_CONFIG_LOCK_TTL);
    } catch (_) {
      redisDown = true; // Redis unavailable — fall through to direct DB read
    }

    if (!lockAcquired) {
      // Spin-wait only makes sense when another process holds the lock and will
      // eventually write to the cache. Skip it entirely when Redis is down.
      if (!redisDown) {
        for (let i = 0; i < 5; i++) {
          await new Promise<void>((resolve) => setTimeout(resolve, 200));
          const retry = await this.redis.get(ADMIN_SYSTEM_CONFIGS);
          if (retry) {
            try { return JSON.parse(retry) as object[]; } catch (_) { break; }
          }
        }
      }
      // Non-owner (or Redis down): query DB directly without touching the lock
      return this.prisma.systemConfig.findMany({ orderBy: { key: 'asc' }, take: 100 });
    }

    // Lock owner: query DB, write cache, then release lock using compare-and-delete
    // so a TTL-expired lock owned by a new process is not deleted.
    try {
      const configs = await this.prisma.systemConfig.findMany({
        orderBy: { key: 'asc' },
        take: 100,
      });
      await this.redis.setex(ADMIN_SYSTEM_CONFIGS, SYSTEM_CONFIG_TTL, JSON.stringify(configs));
      return configs;
    } finally {
      await this.redis.releaseLock(lockKey, lockToken);
    }
  }

  private isFinancialConfig(key: string): boolean {
    const lowerKey = key.toLowerCase();
    return FINANCIAL_CONFIG_KEYS.some(fk => lowerKey.includes(fk));
  }

  private validateConfigValue(key: string, value: string, dataType: string): void {
    if (dataType === 'NUMBER') {
      const parsed = Number(value.trim());
      if (!Number.isFinite(parsed)) {
        throw new BadRequestException({
          code: ErrorCodes.VALIDATION_ERROR,
          message: `Value "${value}" is not a valid number for config key "${key}" (dataType: NUMBER)`,
        });
      }
      if (parsed < 0) {
        throw new BadRequestException({
          code: ErrorCodes.VALIDATION_ERROR,
          message: `Numeric config "${key}" cannot be negative`,
        });
      }
      if (parsed > 1_000_000_000) {
        throw new BadRequestException({
          code: ErrorCodes.VALIDATION_ERROR,
          message: `Numeric config "${key}" exceeds maximum allowed value (1,000,000,000)`,
        });
      }
    } else if (dataType === 'BOOLEAN') {
      if (!['true', 'false'].includes(value.toLowerCase())) {
        throw new BadRequestException({
          code: ErrorCodes.VALIDATION_ERROR,
          message: `Value "${value}" must be "true" or "false" for config key "${key}" (dataType: BOOLEAN)`,
        });
      }
    } else if (dataType === 'JSON') {
      try {
        JSON.parse(value);
      } catch {
        throw new BadRequestException({
          code: ErrorCodes.VALIDATION_ERROR,
          message: `Value for config key "${key}" is not valid JSON`,
        });
      }
    }
  }

  async updateConfig(key: string, dto: UpdateConfigDto, adminId: string, ipAddress: string): Promise<object> {
    const existing = await this.prisma.systemConfig.findUnique({
      where: { key },
    });

    if (!existing) {
      throw new NotFoundException({
        code: ErrorCodes.NOT_FOUND,
        message: `System config with key '${key}' not found`,
      });
    }

    this.validateConfigValue(key, dto.value, existing.dataType);

    if (this.isFinancialConfig(key)) {
      const pendingKey = `${PENDING_CONFIG_PREFIX}${key}`;
      const pendingChange = {
        key,
        proposedValue: dto.value,
        proposedDescription: dto.description,
        currentValue: existing.value,
        currentDescription: existing.description,
        proposedBy: adminId,
        proposedAt: new Date().toISOString(),
        ipAddress,
      };
      const claimed = await this.redis.setNx(pendingKey, JSON.stringify(pendingChange), PENDING_CONFIG_TTL, { throwOnError: true });
      if (!claimed) {
        throw new ConflictException({ code: 'CONFIG_CHANGE_PENDING', message: `A pending change already exists for config '${key}'` });
      }

      this.auditLogService.logAdminAction({
        adminId,
        action: AuditAction.SYSTEM_CONFIG_CHANGED,
        targetType: 'SystemConfig',
        targetId: existing.id,
        description: `Proposed financial config change for '${key}' (pending approval)`,
        before: { value: existing.value },
        after: { proposedValue: dto.value },
        ipAddress,
      });

      return {
        status: 'pending_approval',
        message: `Financial config '${key}' change requires approval from another admin`,
        proposedValue: dto.value,
        currentValue: existing.value,
      };
    }

    const before = { value: existing.value, description: existing.description };

    const updated = await this.prisma.systemConfig.update({
      where: { key },
      data: {
        value: dto.value,
        description: dto.description !== undefined ? dto.description : existing.description,
        updatedBy: adminId,
      },
    });

    await Promise.all([
      this.redis.del(ADMIN_SYSTEM_CONFIGS),
      this.redis.del(FEE_CONFIG_CACHE),
      this.redis.del(SUBSCRIPTION_PLANS_CACHE),
      this.redis.del(`${SUBSCRIPTION_PLANS_CACHE}:plans`),
      this.redis.del('public:system:configs'),
    ]);

    this.auditLogService.logAdminAction({
      adminId,
      action: AuditAction.SYSTEM_CONFIG_CHANGED,
      targetType: 'SystemConfig',
      targetId: existing.id,
      description: `Updated system config '${key}'`,
      before,
      after: { value: dto.value, description: updated.description },
      ipAddress,
    });

    return updated;
  }

  async getPendingConfigChange(key: string): Promise<object | null> {
    const pendingKey = `${PENDING_CONFIG_PREFIX}${key}`;
    const raw = await this.redis.get(pendingKey);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as object;
    } catch {
      return null;
    }
  }

  async listPendingConfigChanges(): Promise<object[]> {
    const keys = await this.redis.scan(`${PENDING_CONFIG_PREFIX}*`);
    const results: object[] = [];
    const prefix = this.redis.getPrefix();
    for (const rawKey of keys) {
      const key = rawKey.startsWith(prefix) ? rawKey.slice(prefix.length) : rawKey;
      const raw = await this.redis.get(key);
      if (raw) {
        try {
          results.push(JSON.parse(raw) as object);
        } catch {
          this.logger.warn(`Failed to parse pending config JSON for key: ${rawKey}`);
        }
      }
    }
    return results;
  }

  async approveConfigChange(key: string, approverId: string, ipAddress: string): Promise<object> {
    const lockKey = `${PENDING_CONFIG_PREFIX}${key}:lock`;
    const lockToken = randomBytes(16).toString('hex');
    if (!await this.redis.setNx(lockKey, lockToken, SYSTEM_CONFIG_LOCK_TTL, { throwOnError: true })) {
      throw new ConflictException({ code: 'CONFIG_CHANGE_IN_PROGRESS', message: 'This config change is already being processed' });
    }
    try {
      const pendingKey = `${PENDING_CONFIG_PREFIX}${key}`;
    const raw = await this.redis.get(pendingKey);
    if (!raw) {
      throw new NotFoundException({
        code: ErrorCodes.NOT_FOUND,
        message: `No pending config change found for key '${key}'`,
      });
    }

    const pending = JSON.parse(raw) as {
      key: string;
      proposedValue: string;
      proposedDescription?: string;
      currentValue: string;
      currentDescription?: string;
      proposedBy: string;
      proposedAt: string;
      ipAddress: string;
    };

    if (pending.proposedBy === approverId) {
      throw new ForbiddenException({
        code: ErrorCodes.FORBIDDEN,
        message: 'Cannot approve your own config change. A different admin must approve.',
      });
    }

    const existing = await this.prisma.systemConfig.findUnique({ where: { key } });
    if (!existing) {
      throw new NotFoundException({
        code: ErrorCodes.NOT_FOUND,
        message: `System config with key '${key}' not found`,
      });
    }

    const updated = await this.prisma.systemConfig.update({
      where: { key },
      data: {
        value: pending.proposedValue,
        description: pending.proposedDescription !== undefined ? pending.proposedDescription : existing.description,
        updatedBy: approverId,
      },
    });

    await Promise.all([
      this.redis.del(ADMIN_SYSTEM_CONFIGS),
      this.redis.del(FEE_CONFIG_CACHE),
      this.redis.del(SUBSCRIPTION_PLANS_CACHE),
      this.redis.del(`${SUBSCRIPTION_PLANS_CACHE}:plans`),
      this.redis.del('public:system:configs'),
      this.redis.del(pendingKey),
    ]);

    this.auditLogService.logAdminAction({
      adminId: approverId,
      action: AuditAction.SYSTEM_CONFIG_CHANGED,
      targetType: 'SystemConfig',
      targetId: existing.id,
      description: `Approved financial config change for '${key}' (proposed by ${pending.proposedBy})`,
      before: { value: pending.currentValue },
      after: { value: pending.proposedValue, approvedBy: approverId, proposedBy: pending.proposedBy },
      ipAddress,
    });

    return updated;
    } finally {
      await this.redis.releaseLock(lockKey, lockToken);
    }
  }

  async rejectConfigChange(key: string, rejecterId: string, ipAddress: string): Promise<{ message: string }> {
    const lockKey = `${PENDING_CONFIG_PREFIX}${key}:lock`;
    const lockToken = randomBytes(16).toString('hex');
    if (!await this.redis.setNx(lockKey, lockToken, SYSTEM_CONFIG_LOCK_TTL, { throwOnError: true })) {
      throw new ConflictException({ code: 'CONFIG_CHANGE_IN_PROGRESS', message: 'This config change is already being processed' });
    }
    try {
      const pendingKey = `${PENDING_CONFIG_PREFIX}${key}`;
    const raw = await this.redis.get(pendingKey);
    if (!raw) {
      throw new NotFoundException({
        code: ErrorCodes.NOT_FOUND,
        message: `No pending config change found for key '${key}'`,
      });
    }

    const pending = JSON.parse(raw) as { proposedBy: string; proposedValue: string };

    await this.redis.del(pendingKey);

    const existing = await this.prisma.systemConfig.findUnique({ where: { key } });

    this.auditLogService.logAdminAction({
      adminId: rejecterId,
      action: AuditAction.SYSTEM_CONFIG_CHANGED,
      targetType: 'SystemConfig',
      targetId: existing?.id ?? key,
      description: `Rejected financial config change for '${key}' (proposed by ${pending.proposedBy})`,
      after: { rejectedValue: pending.proposedValue, rejectedBy: rejecterId },
      ipAddress,
    });

    return { message: `Pending config change for '${key}' has been rejected` };
    } finally {
      await this.redis.releaseLock(lockKey, lockToken);
    }
  }

  async listAuditLogs(query: AuditLogQueryDto): Promise<object> {
    const { page = 1, limit = 20, action, adminId, targetType, startDate, endDate } = query;
    const safeLimit = Math.min(limit, 100);
    const safePage = Math.min(Math.max(page, 1), MAX_ADMIN_PAGE);
    const skip = (safePage - 1) * safeLimit;

    const where: Prisma.AdminAuditLogWhereInput = {};

    if (action) {
      where.action = action as AuditAction;
    }

    if (adminId) {
      where.adminId = adminId;
    }

    if (targetType) {
      where.targetType = targetType;
    }

    if (startDate || endDate) {
      where.createdAt = {};
      if (startDate) (where.createdAt as Prisma.DateTimeFilter).gte = parseDateBoundaryWIB(startDate, 'start');
      if (endDate) (where.createdAt as Prisma.DateTimeFilter).lte = parseDateBoundaryWIB(endDate, 'end');
    }

    const [data, total] = await Promise.all([
      this.prisma.adminAuditLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: safeLimit,
        include: {
          admin: {
            select: { id: true, fullName: true, role: true },
          },
        },
      }),
      this.prisma.adminAuditLog.count({ where }),
    ]);

    return createPaginatedResponse(data, total, safePage, safeLimit);
  }

  async listWebhookLogs(query: WebhookLogQueryDto): Promise<object> {
    const { page = 1, limit = 20, source, isProcessed, deadLettered, search, startDate, endDate } = query;
    const safeLimit = Math.min(limit, 100);
    const safePage = Math.min(Math.max(page, 1), MAX_ADMIN_PAGE);
    const skip = (safePage - 1) * safeLimit;

    const where: Prisma.WebhookLogWhereInput = {};

    if (source) {
      where.source = source;
    }

    if (isProcessed !== undefined) {
      where.isProcessed = isProcessed === 'true';
    }

    if (deadLettered !== undefined) {
      where.deadLetteredAt = deadLettered === 'true' ? { not: null } : null;
    }

    if (search) {
      where.OR = [
        { source: { contains: search, mode: 'insensitive' } },
        { event: { contains: search, mode: 'insensitive' } },
        { errorMessage: { contains: search, mode: 'insensitive' } },
      ];
    }

    if (startDate || endDate) {
      where.createdAt = {};
      if (startDate) (where.createdAt as Prisma.DateTimeFilter).gte = parseDateBoundaryWIB(startDate, 'start');
      if (endDate) (where.createdAt as Prisma.DateTimeFilter).lte = parseDateBoundaryWIB(endDate, 'end');
    }

    const [data, total] = await Promise.all([
      this.prisma.webhookLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: safeLimit,
      }),
      this.prisma.webhookLog.count({ where }),
    ]);

    return createPaginatedResponse(data, total, safePage, safeLimit);
  }

  async retryDeadLetterWebhook(id: string, adminId: string, ipAddress: string): Promise<object> {
    const existing = await this.prisma.webhookLog.findUnique({ where: { id } });
    if (!existing) {
      throw new NotFoundException({ code: 'WEBHOOK_LOG_NOT_FOUND', message: 'Webhook log not found' });
    }
    if (existing.isProcessed) {
      throw new BadRequestException({ code: 'WEBHOOK_ALREADY_PROCESSED', message: 'Processed webhook cannot be retried' });
    }
    if (!existing.deadLetteredAt || String(existing.errorMessage ?? '').startsWith('MANUAL_RESOLUTION:')) {
      throw new BadRequestException({ code: 'WEBHOOK_NOT_DEAD_LETTERED', message: 'Only unresolved dead-letter webhooks can be retried' });
    }

    const updated = await this.prisma.webhookLog.updateMany({
      where: { id, isProcessed: false },
      data: {
        retryCount: 0,
        lastAttemptAt: null,
        nextRetryAt: new Date(),
        deadLetteredAt: null,
        errorMessage: null,
      },
    });
    if (updated.count === 0) {
      throw new BadRequestException({ code: 'WEBHOOK_RETRY_CONFLICT', message: 'Webhook state changed; reload and try again' });
    }

    this.auditLogService.logAdminAction({
      adminId,
      action: AuditAction.ADMIN_ACTION,
      targetType: 'WebhookLog',
      targetId: id,
      description: `Manually requeued dead-letter webhook ${id}`,
      before: { retryCount: existing.retryCount, deadLetteredAt: existing.deadLetteredAt, errorMessage: existing.errorMessage },
      after: { retryCount: 0, nextRetryAt: 'now', deadLetteredAt: null },
      ipAddress,
    });

    return { id, status: 'queued', message: 'Webhook queued for retry' };
  }

  async resolveDeadLetterWebhook(id: string, adminId: string, ipAddress: string, resolution: string): Promise<object> {
    const existing = await this.prisma.webhookLog.findUnique({ where: { id } });
    if (!existing) {
      throw new NotFoundException({ code: 'WEBHOOK_LOG_NOT_FOUND', message: 'Webhook log not found' });
    }
    if (existing.isProcessed) {
      throw new BadRequestException({ code: 'WEBHOOK_ALREADY_PROCESSED', message: 'Processed webhook needs no resolution' });
    }
    if (!existing.deadLetteredAt || String(existing.errorMessage ?? '').startsWith('MANUAL_RESOLUTION:')) {
      throw new BadRequestException({ code: 'WEBHOOK_NOT_DEAD_LETTERED', message: 'Only unresolved dead-letter webhooks can be resolved' });
    }

    const safeResolution = resolution.trim().slice(0, 500);
    if (!safeResolution) {
      throw new BadRequestException({ code: 'WEBHOOK_RESOLUTION_REQUIRED', message: 'Resolution is required' });
    }

    const updated = await this.prisma.webhookLog.updateMany({
      where: { id, isProcessed: false },
      data: {
        deadLetteredAt: new Date(),
        nextRetryAt: null,
        errorMessage: `MANUAL_RESOLUTION: ${safeResolution}`,
      },
    });
    if (updated.count === 0) {
      throw new BadRequestException({ code: 'WEBHOOK_RESOLVE_CONFLICT', message: 'Webhook state changed; reload and try again' });
    }

    this.auditLogService.logAdminAction({
      adminId,
      action: AuditAction.ADMIN_ACTION,
      targetType: 'WebhookLog',
      targetId: id,
      description: `Manually resolved dead-letter webhook ${id}`,
      before: { retryCount: existing.retryCount, deadLetteredAt: existing.deadLetteredAt, errorMessage: existing.errorMessage },
      after: { deadLetteredAt: 'now', resolution: safeResolution },
      ipAddress,
    });

    return { id, status: 'resolved', message: 'Webhook marked as manually resolved' };
  }

  async sendBroadcast(dto: BroadcastDto, adminId: string, ipAddress: string): Promise<{ recipientCount: number; queuedCount: number; pushRequested: boolean }> {
    const where: Prisma.UserWhereInput = { deletedAt: null };
    const pushRequested = dto.channels.includes('push');
    const inAppRequested = dto.channels.includes('in_app');

    switch (dto.targetAudience) {
      case 'active':
        where.lastLoginAt = { gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) };
        break;
      case 'kahade_plus':
        where.subscriptions = { some: { status: 'ACTIVE', currentPeriodEnd: { gt: new Date() } } };
        break;
      case 'verified':
        where.kycStatus = KycStatus.APPROVED;
        break;
    }

    const broadcastId = `broadcast-${randomBytes(12).toString('hex')}`;
    const FETCH_BATCH = 10_000;
    const STAGE_DELAY_MS = 2_000;
    let totalRecipients = 0;
    let queuedCount = 0;
    let cursor: string | undefined;
    let batchNumber = 0;

    const progressKey = `broadcast_progress:${broadcastId}`;

    while (true) {
      const batch = await this.prisma.user.findMany({
        where,
        select: { id: true },
        take: FETCH_BATCH,
        ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
        orderBy: { id: 'asc' },
      });

      if (batch.length === 0) break;
      cursor = batch[batch.length - 1].id;
      totalRecipients += batch.length;
      batchNumber++;

      if (batchNumber > 1) {
        await new Promise<void>((resolve) => setTimeout(resolve, STAGE_DELAY_MS));
      }

      const safeTitle = escapeHtml(dto.title ?? '');
      const safeBody = escapeHtml(dto.body ?? '');
      if (pushRequested) {
        const QUEUE_BATCH = 500;
        const jobs = batch.map((user) => ({
          userId: user.id,
          type: NotificationType.SYSTEM_ANNOUNCEMENT,
          title: safeTitle,
          body: safeBody,
          channel: NotificationChannel.PUSH_NOTIFICATION,
          actionUrl: '/notifications',
          pushData: {
            notificationType: NotificationType.SYSTEM_ANNOUNCEMENT,
            notificationCategory: NotificationCategory.INFORMASI,
            broadcastId,
          },
        }));
        for (let i = 0; i < jobs.length; i += QUEUE_BATCH) {
          queuedCount += await this.notificationQueue.enqueueMany(jobs.slice(i, i + QUEUE_BATCH));
        }
      } else if (inAppRequested) {
        const notifications = batch.map((user) => ({
          notifId: generateNotifId(),
          userId: user.id,
          type: NotificationType.SYSTEM_ANNOUNCEMENT,
          category: NotificationCategory.INFORMASI,
          title: safeTitle,
          body: safeBody,
          channel: NotificationChannel.IN_APP,
          isRead: false,
        }));
        const INSERT_BATCH = 500;
        for (let i = 0; i < notifications.length; i += INSERT_BATCH) {
          await this.prisma.notification.createMany({
            data: notifications.slice(i, i + INSERT_BATCH),
          });
        }
      }

      this.logger.log(`Broadcast ${broadcastId}: batch ${batchNumber} processed (${batch.length} users, ${totalRecipients} total so far)`);
      await this.redis.set(progressKey, JSON.stringify({ cursor, totalRecipients, batchNumber, updatedAt: new Date().toISOString() }), 86400);

      if (batch.length < FETCH_BATCH) break;
    }

    if (totalRecipients === 0) {
      return { recipientCount: 0, queuedCount: 0, pushRequested };
    }

    this.auditLogService.logAdminAction({
      adminId,
      action: AuditAction.BROADCAST_SENT,
      targetType: 'Broadcast',
      targetId: broadcastId,
      description: `Broadcast sent to ${totalRecipients} users (audience: ${dto.targetAudience ?? 'all'})`,
      after: { title: dto.title, channels: dto.channels, targetAudience: dto.targetAudience, recipientCount: totalRecipients },
      ipAddress,
    });

    this.logger.log(`Admin ${adminId} sent broadcast to ${totalRecipients} users`);

    return { recipientCount: totalRecipients, queuedCount, pushRequested };
  }
}
