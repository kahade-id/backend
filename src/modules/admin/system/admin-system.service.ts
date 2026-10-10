import { Injectable, NotFoundException, BadRequestException, ForbiddenException, ConflictException, Logger, OnModuleInit, Optional } from '@nestjs/common';
import { randomBytes, createHash } from 'crypto';
import { PrismaService } from '../../../prisma/prisma.service';
import { RedisService } from '../../../redis/redis.service';
import { AuditLogService } from '../../../common/services/audit-log.service';
import { NotificationQueueService } from '../../queue/notification-queue.service';
import { createPaginatedResponse } from '../../../common/dto/pagination.dto';
import { UpdateConfigDto } from './dto/update-config.dto';
import { BroadcastDto } from './dto/broadcast.dto';
import { AuditLogQueryDto, WebhookLogQueryDto } from './dto/audit-log-query.dto';
import { AuditAction, NotificationCategory, NotificationChannel, NotificationType, Prisma, KycStatus, AdminRole } from '@prisma/client';
import { RealtimeService } from '../../realtime/realtime.service';
import * as ErrorCodes from '../../../common/constants/error-codes';
import { ADMIN_SYSTEM_CONFIGS, FEE_CONFIG_CACHE, SUBSCRIPTION_PLANS_CACHE } from '../../../common/constants/redis-keys';
import { generateNotifId } from '../../../common/utils/id-generator.util';
import { parseDateBoundaryWIB } from '../../../common/utils/date.util';
import { escapeLikePattern } from '../../../common/utils/search.util';
// SYS-B-405: klasifikasi finansial/security eksplisit per key (registry) +
// dual control terpusat via tabel approvals (menggantikan jalur pending Redis
// paralel + deteksi substring FINANCIAL_CONFIG_KEYS).
import { classifySystemConfig } from './system-config.registry';
import { ApprovalsService } from '../approvals/approvals.service';

/**
 * Audit 2026-10-10 (BE-11): judul/isi broadcast adalah TEKS POLOS yang dirender
 * `<Text>` di aplikasi & React di admin — keduanya tidak menafsirkan HTML.
 * `escapeHtml` lama membuat `Promo 'Plus' & lainnya` tampil sebagai
 * `Promo &#39;Plus&#39; &amp; lainnya` di inbox pengguna. Cukup buang karakter
 * kontrol dan rapikan spasi.
 */
function sanitizeBroadcastText(input: string): string {
  return input
    .replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, '')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

const SYSTEM_CONFIG_TTL = 300;
const SYSTEM_CONFIG_LOCK_TTL = 10;
const MAX_ADMIN_PAGE = 100_000;

@Injectable()
export class AdminSystemService implements OnModuleInit {
  private readonly logger = new Logger(AdminSystemService.name);

  constructor(
    private prisma: PrismaService,
    private redis: RedisService,
    private auditLogService: AuditLogService,
    private notificationQueue: NotificationQueueService,
    // SYS-B-405: modul ini mengeksekusi SYSTEM_CONFIG_CHANGE yang disetujui
    // (ApprovalsModule @Global — tanpa import modul).
    private readonly approvals: ApprovalsService,
    // Audit 2026-10-10 (BE-12): broadcast in-app saja memancarkan `notification.new`
    // agar inbox/badge perangkat yang online langsung bergerak. RealtimeModule
    // @Global; opsional agar unit test tanpa gateway tetap jalan.
    @Optional() private readonly realtime?: RealtimeService,
  ) {}

  onModuleInit(): void {
    this.approvals.registerExecutor('SYSTEM_CONFIG_CHANGE', async (ctx) => {
      if (!ctx.targetId) {
        throw new BadRequestException({
          code: ErrorCodes.VALIDATION_ERROR,
          message: 'SYSTEM_CONFIG_CHANGE membutuhkan targetId (key config)',
        });
      }
      const value = typeof ctx.payload.value === 'string' ? ctx.payload.value : '';
      const description = typeof ctx.payload.description === 'string' ? ctx.payload.description : undefined;
      return this.applySystemConfigChange(ctx.targetId, value, description, ctx.decidedBy, ctx.proposedBy, ctx.ipAddress);
    });
  }

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

  async updateConfig(
    key: string,
    dto: UpdateConfigDto,
    adminId: string,
    adminRole: AdminRole,
    ipAddress: string,
  ): Promise<object> {
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

    // SYS-B-405: klasifikasi eksplisit per key (registry), bukan substring.
    // Key finansial ATAU security-gated SELALU via dual control (tabel
    // approvals + step-up di controller) — tidak pernah apply langsung.
    // Key tak dikenal → fail-closed sebagai finansial (lihat registry).
    const classification = classifySystemConfig(key);
    if (classification.financial || classification.securityGated) {
      // Semantik lama: satu usulan pending per key — tolak duplikat.
      const pending = await this.approvals.findPendingByActionTarget('SYSTEM_CONFIG_CHANGE', key);
      if (pending) {
        throw new ConflictException({
          code: 'CONFIG_CHANGE_PENDING',
          message: `A pending change already exists for config '${key}' (approval ${pending.approvalId})`,
        });
      }
      const valueHash = createHash('sha256').update(dto.value).digest('hex').slice(0, 16);
      const approval = await this.approvals.propose({
        actionType: 'SYSTEM_CONFIG_CHANGE',
        targetId: key,
        payload: {
          value: dto.value,
          ...(dto.description !== undefined ? { description: dto.description } : {}),
        },
        // Idempoten per (key, value): nilai sama yang diusulkan ulang
        // mengembalikan approval yang ada; nilai beda butuh usulan baru.
        idempotencyKey: `system-config-change:${key}:${valueHash}`,
        proposedBy: adminId,
        proposerRole: adminRole,
        ipAddress,
      });

      this.auditLogService.logAdminAction({
        adminId,
        action: AuditAction.SYSTEM_CONFIG_CHANGED,
        targetType: 'SystemConfig',
        targetId: existing.id,
        description:
          `Proposed ${classification.securityGated ? 'security-gated' : 'financial'} config change for '${key}' ` +
          `via dual control (approval ${approval.approvalId})`,
        before: { value: existing.value },
        after: { proposedValue: dto.value },
        ipAddress,
      });

      return {
        status: 'pending_approval',
        message:
          `Config '${key}' ${classification.securityGated ? 'bersifat security-gated' : 'bersifat finansial'} — ` +
          `perubahan membutuhkan persetujuan admin kedua via POST /v1/admin/approvals/${approval.approvalId}/approve`,
        approvalId: approval.approvalId,
        expiresAt: approval.expiresAt,
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
      this.redis.del('public:exchange:rates'),
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

  /**
   * SYS-B-405: baca usulan pending dari TABEL approvals — satu-satunya sistem
   * dual control yang tersisa. Rute ini dipertahankan untuk kompatibilitas
   * panel admin; sumber datanya kini approvals, bukan Redis paralel.
   */
  async getPendingConfigChange(key: string): Promise<object | null> {
    const pending = await this.approvals.findPendingByActionTarget('SYSTEM_CONFIG_CHANGE', key);
    if (!pending) return null;
    const full = await this.prisma.adminActionApproval.findUnique({ where: { id: pending.approvalId } });
    const payload = (full?.payload ?? {}) as Record<string, unknown>;
    const existing = await this.prisma.systemConfig.findUnique({ where: { key } });
    return {
      key,
      proposedValue: payload.value ?? null,
      proposedDescription: typeof payload.description === 'string' ? payload.description : null,
      currentValue: existing?.value ?? null,
      proposedBy: pending.proposedBy,
      proposedAt: pending.proposedAt,
      approvalId: pending.approvalId,
    };
  }

  async listPendingConfigChanges(): Promise<object[]> {
    const pendings = await this.approvals.listPending();
    const rows = pendings.filter((p) => p.actionType === 'SYSTEM_CONFIG_CHANGE');
    return Promise.all(
      rows.map(async (p) => {
        const full = await this.prisma.adminActionApproval.findUnique({ where: { id: p.approvalId } });
        const payload = (full?.payload ?? {}) as Record<string, unknown>;
        const existing = p.targetId
          ? await this.prisma.systemConfig.findUnique({ where: { key: p.targetId } })
          : null;
        return {
          key: p.targetId,
          proposedValue: payload.value ?? null,
          proposedDescription: typeof payload.description === 'string' ? payload.description : null,
          currentValue: existing?.value ?? null,
          proposedBy: p.proposedBy,
          proposedAt: p.proposedAt,
          approvalId: p.approvalId,
        };
      }),
    );
  }

  /**
   * SYS-B-405: approve perubahan config finansial/security-gated — diteruskan
   * ke approvals (menjamin: bukan pengusul sendiri, belum kedaluwarsa, lalu
   * eksekusi atomik via executor SYSTEM_CONFIG_CHANGE). Step-up milik
   * approver ditegakkan di controller (StepUpGuard, action systemConfig.update).
   */
  async approveConfigChange(
    key: string,
    approverId: string,
    approverRole: AdminRole,
    ipAddress: string,
  ): Promise<object> {
    const pending = await this.approvals.findPendingByActionTarget('SYSTEM_CONFIG_CHANGE', key);
    if (!pending) {
      throw new NotFoundException({
        code: ErrorCodes.NOT_FOUND,
        message: `No pending config change found for key '${key}'`,
      });
    }
    const result = await this.approvals.approve(pending.approvalId, approverId, approverRole, ipAddress);
    return { ...result, key };
  }

  async rejectConfigChange(
    key: string,
    rejecterId: string,
    rejecterRole: AdminRole,
    ipAddress: string,
  ): Promise<{ message: string }> {
    const pending = await this.approvals.findPendingByActionTarget('SYSTEM_CONFIG_CHANGE', key);
    if (!pending) {
      throw new NotFoundException({
        code: ErrorCodes.NOT_FOUND,
        message: `No pending config change found for key '${key}'`,
      });
    }
    await this.approvals.reject(pending.approvalId, rejecterId, rejecterRole, undefined, ipAddress);
    return { message: `Pending config change for '${key}' has been rejected` };
  }

  /**
   * SYS-B-405: eksekusi perubahan config — HANYA dipanggil dari executor
   * SYSTEM_CONFIG_CHANGE setelah approval dual control (bukan dari endpoint
   * langsung). Nilai sudah divalidasi terhadap dataType saat propose.
   */
  private async applySystemConfigChange(
    key: string,
    value: string,
    description: string | undefined,
    decidedBy: string,
    proposedBy: string,
    ipAddress: string,
  ): Promise<object> {
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
        value,
        description: description !== undefined ? description : existing.description,
        updatedBy: decidedBy,
      },
    });

    await Promise.all([
      this.redis.del(ADMIN_SYSTEM_CONFIGS),
      this.redis.del(FEE_CONFIG_CACHE),
      this.redis.del(SUBSCRIPTION_PLANS_CACHE),
      this.redis.del(`${SUBSCRIPTION_PLANS_CACHE}:plans`),
      this.redis.del('public:system:configs'),
      this.redis.del('public:exchange:rates'),
    ]);

    this.auditLogService.logAdminAction({
      adminId: decidedBy,
      action: AuditAction.SYSTEM_CONFIG_CHANGED,
      targetType: 'SystemConfig',
      targetId: existing.id,
      description: `Approved ${classifySystemConfig(key).securityGated ? 'security-gated' : 'financial'} config change for '${key}' via dual control (proposed by ${proposedBy})`,
      before: { value: existing.value },
      after: { value, approvedBy: decidedBy, proposedBy },
      ipAddress,
    });

    return updated;
  }

  async listAuditLogs(query: AuditLogQueryDto): Promise<object> {
    const { page = 1, limit = 20, action, adminId, targetType, targetId, startDate, endDate } = query;
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

    // ADM-128: exact match pada targetId — jejak versi per entitas.
    if (targetId) {
      where.targetId = targetId;
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
        { source: { contains: escapeLikePattern(search), mode: 'insensitive' } },
        { event: { contains: escapeLikePattern(search), mode: 'insensitive' } },
        { errorMessage: { contains: escapeLikePattern(search), mode: 'insensitive' } },
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
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], // R2-L: stable page ordering
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

      const safeTitle = sanitizeBroadcastText(dto.title ?? '');
      const safeBody = sanitizeBroadcastText(dto.body ?? '');
      if (pushRequested) {
        const QUEUE_BATCH = 500;
        const jobs = batch.map((user) => ({
          userId: user.id,
          type: NotificationType.SYSTEM_ANNOUNCEMENT,
          title: safeTitle,
          body: safeBody,
          // Audit 2026-10-10 (BE-13): bila admin juga meminta in-app, baris inbox
          // dicatat IN_APP (push tetap dikirim oleh worker) — dulu selalu
          // PUSH_NOTIFICATION sehingga laporan kanal salah.
          channel: inAppRequested ? NotificationChannel.IN_APP : NotificationChannel.PUSH_NOTIFICATION,
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
        const notifIds = new Map<string, string>();
        const notifIdFor = (userId: string): string => {
          let id = notifIds.get(userId);
          if (!id) {
            id = generateNotifId();
            notifIds.set(userId, id);
          }
          return id;
        };
        const notifications = batch.map((user) => ({
          notifId: notifIdFor(user.id),
          userId: user.id,
          type: NotificationType.SYSTEM_ANNOUNCEMENT,
          category: NotificationCategory.INFORMASI,
          title: safeTitle,
          body: safeBody,
          channel: NotificationChannel.IN_APP,
          isRead: false,
          // BE-12: tap item → detail notifikasi (format yang dikenal
          // `lib/notification-routing.ts`: `/notifications?notificationId=`).
          actionUrl: `/notifications?notificationId=${encodeURIComponent(notifIdFor(user.id))}`,
        }));
        const INSERT_BATCH = 500;
        for (let i = 0; i < notifications.length; i += INSERT_BATCH) {
          await this.prisma.notification.createMany({
            data: notifications.slice(i, i + INSERT_BATCH),
          });
        }
        // BE-12: beri tahu perangkat yang online (dulu hanya createMany → inbox
        // & badge diam sampai poll). Tidak lewat `emitNotificationCreated` agar
        // PushService tidak ikut mengirim push untuk broadcast in-app saja.
        if (this.realtime) {
          for (const n of notifications) {
            this.realtime.emitToUser(n.userId, 'notification.new', {
              notifId: n.notifId,
              type: n.type,
              title: n.title,
              body: n.body,
              notificationType: n.type,
              notificationCategory: n.category,
              actionUrl: n.actionUrl,
              broadcastId,
            });
          }
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
      // Audit 2026-10-10 (BE-14): jumlah job terantri ikut dicatat — selisih
      // dengan recipientCount = enqueue gagal, dulu tidak terlihat di mana pun.
      description: `Broadcast sent to ${totalRecipients} users (audience: ${dto.targetAudience ?? 'all'}, queued: ${pushRequested ? queuedCount : 'n/a'})`,
      after: { title: dto.title, channels: dto.channels, targetAudience: dto.targetAudience, recipientCount: totalRecipients, queuedCount, pushRequested },
      ipAddress,
    });

    this.logger.log(`Admin ${adminId} sent broadcast to ${totalRecipients} users`);

    return { recipientCount: totalRecipients, queuedCount, pushRequested };
  }
}
