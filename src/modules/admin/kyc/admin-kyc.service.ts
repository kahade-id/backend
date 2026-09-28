import { Prisma, NotificationType, AuditAction } from '@prisma/client';
import { getCategoryForType } from '../../notifications/notification-category.map';
import {
  Injectable,
  NotFoundException,
  BadRequestException,
  UnauthorizedException,
  ConflictException,
  Logger,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bull';
import { Queue } from 'bull';
import { PrismaService } from '../../../prisma/prisma.service';
import { RedisService } from '../../../redis/redis.service';
import { AuditLogService } from '../../../common/services/audit-log.service';
import { UploadService } from '../../upload/upload.service';
import { VerificationBadgeService } from '../../users/verification-badge.service';
import { createPaginatedResponse, PaginatedResponse } from '../../../common/dto/pagination.dto';
import { decryptAES, bcryptCompare } from '../../../common/utils/crypto.util';
import { generateNotifId } from '../../../common/utils/id-generator.util';
import { escapeHtml } from '../../../common/utils/sanitize.util';
import { EMAIL_QUEUE, EmailJobData } from '../../queue/processors/email.processor';
import * as ErrorCodes from '../../../common/constants/error-codes';
import { DashboardService } from '../dashboard/dashboard.service';
import {
  slaElapsedMs,
  slaRemainingMs,
  slaStatus,
  accumulatePauseOnResume,
  getEffectiveSlaConfig,
  SLA_SCOPES,
  DEFAULT_SLA_HOURS,
  type SlaConfigLike,
  type SlaTrackable,
} from './sla.util';
import { KycQueueQueryDto } from './dto/kyc-queue-query.dto';
import { UpdateSlaConfigDto } from './dto/sla-config.dto';

@Injectable()
export class AdminKycService {
  private readonly logger = new Logger(AdminKycService.name);
  constructor(
    private prisma: PrismaService,
    private redis: RedisService,
    private auditLog: AuditLogService,
    private uploadService: UploadService,
    private verificationBadgeService: VerificationBadgeService,
    @InjectQueue(EMAIL_QUEUE) private readonly emailQueue: Queue<EmailJobData>,
    // AW-018: invalidasi cache summary dashboard (via helper terpusat).
    private readonly dashboard: DashboardService,
  ) {}

  private async invalidateKycCache(userId: string): Promise<void> {
    try {
      await this.redis.del(`guard:kyc:${userId}`);
    } catch (err) {
      this.logger.warn(`Failed to invalidate KYC cache for user ${userId}`, err);
    }
    // Section 1: badge KYC_VERIFIED dihitung dari kycStatus dan ikut di-cache
    // (TTL pendek). Keputusan approve/reject/revoke harus langsung terlihat di
    // profil publik, jadi cache badge di-drop di sini juga — post-commit.
    await this.verificationBadgeService.invalidate(userId);
  }

  private normalizeOptionalText(value?: string): string | null {
    const normalized = value?.trim();
    return normalized ? normalized : null;
  }

  private normalizeRequiredText(value: string, field: string): string {
    const normalized = value.trim();
    if (!normalized) {
      throw new BadRequestException({
        code: ErrorCodes.VALIDATION_ERROR,
        message: `${field} must contain non-whitespace text`,
      });
    }
    return normalized;
  }

  /**
   * GAP-E (G282–G292): antrean KYC diperkaya info SLA per baris + filter
   * slaBreached / rentang umur / reviewer yang ditugaskan.
   */
  async getKycQueue(
    query: KycQueueQueryDto,
  ): Promise<PaginatedResponse<Record<string, unknown>>> {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const safePage = Number.isFinite(page) ? Math.max(1, Math.floor(page)) : 1;
    const safeLimit = Number.isFinite(limit) ? Math.min(100, Math.max(1, Math.floor(limit))) : 20;
    const skip = (safePage - 1) * safeLimit;

    const status = query.status;
    const validStatuses = ['PENDING', 'APPROVED', 'REJECTED', 'REVOKED'];
    if (status && !validStatuses.includes(status)) {
      throw new BadRequestException({
        code: ErrorCodes.INVALID_STATUS,
        message: `Invalid KYC status: ${status}. Valid values: ${validStatuses.join(', ')}`,
      });
    }

    const where: Prisma.KycRequestWhereInput = {};
    if (status) where.status = status as Prisma.EnumKycStatusFilter;
    if (query.slaBreached === true) where.slaBreachedAt = { not: null };
    if (query.slaBreached === false) where.slaBreachedAt = null;
    if (query.minAgeHours != null || query.maxAgeHours != null) {
      const and: Prisma.KycRequestWhereInput[] = [];
      if (query.minAgeHours != null) {
        const cutoff = new Date(Date.now() - query.minAgeHours * 3_600_000);
        and.push({
          OR: [
            { slaStartedAt: { lte: cutoff } },
            { AND: [{ slaStartedAt: null }, { createdAt: { lte: cutoff } }] },
          ],
        });
      }
      if (query.maxAgeHours != null) {
        const cutoff = new Date(Date.now() - query.maxAgeHours * 3_600_000);
        and.push({
          OR: [
            { slaStartedAt: { gte: cutoff } },
            { AND: [{ slaStartedAt: null }, { createdAt: { gte: cutoff } }] },
          ],
        });
      }
      where.AND = and;
    }
    if (query.assigned === 'unassigned') where.assignedReviewerId = null;
    else if (query.assigned) where.assignedReviewerId = query.assigned;

    // ADM-015: pencarian teks — kycId atau identitas pemohon.
    if (query.search?.trim()) {
      const s = query.search.trim();
      where.OR = [
        { kycId: { contains: s, mode: 'insensitive' } },
        {
          user: {
            OR: [
              { email: { contains: s, mode: 'insensitive' } },
              { fullName: { contains: s, mode: 'insensitive' } },
              { userId: { contains: s, mode: 'insensitive' } },
              { username: { contains: s, mode: 'insensitive' } },
            ],
          },
        },
      ];
    }

    // ADM-006: filter status SLA di sisi server — EKSAK, bukan aproksimasi.
    // Aproksimasi umur via SQL dapat bertentangan dengan slaStatus() saat
    // mode business-hours / jeda terakumulasi berlaku (baris bisa cocok
    // filter padahal status tampilnya beda, atau sebaliknya). Maka saat
    // `slaStatus` diminta: ambil kandidat dengan filter dasar, hitung status
    // EKSAK via buildSlaView, filter di memori, total dari hasil filter,
    // lalu paginasi. Konvensi disjoint (sama seperti tampilan baris):
    //   PAUSED    <=> sla.paused === true
    //   OK/MENDEKATI/BREACHED <=> sla.paused === false && sla.status === nilai
    if (query.slaStatus) {
      const slaWanted = query.slaStatus;
      const selectFields = {
        id: true,
        kycId: true,
        userId: true,
        status: true,
        rejectionReason: true,
        attemptNumber: true,
        createdAt: true,
        reviewedAt: true,
        reviewedBy: true,
        slaStartedAt: true,
        slaPausedAt: true,
        slaPausedAccumMs: true,
        slaBreachedAt: true,
        assignedReviewerId: true,
        user: { select: { userId: true, email: true, fullName: true } },
        reviewer: { select: { adminId: true, fullName: true } },
      } as const;
      const candidates = await this.prisma.kycRequest.findMany({
        where,
        orderBy: { createdAt: 'asc' },
        select: selectFields,
      });
      const slaConfig = await getEffectiveSlaConfig(this.prisma, 'KYC_PERSONAL');
      const slaNow = new Date();
      const matched = candidates.filter((r) => {
        const view = this.buildSlaView(r, slaNow, slaConfig);
        if (slaWanted === 'PAUSED') return view.paused === true;
        if (view.paused === true) return false;
        return view.status === slaWanted;
      });
      const total = matched.length;
      const pageRows = matched.slice(skip, skip + safeLimit);
      const reviewerIds = [...new Set(pageRows.map(r => r.assignedReviewerId).filter((v): v is string => !!v))];
      const reviewerMap = await this.getAdminNameMap(reviewerIds);
      const rows = pageRows.map(r => ({
        ...r,
        sla: this.buildSlaView(r, slaNow, slaConfig),
        assignedReviewer: r.assignedReviewerId
          ? (reviewerMap.get(r.assignedReviewerId) ?? { adminId: r.assignedReviewerId, fullName: null })
          : null,
      }));
      return createPaginatedResponse(rows, total, safePage, safeLimit);
    }

    const [requests, total] = await Promise.all([
      this.prisma.kycRequest.findMany({
        where,
        skip,
        take: safeLimit,
        orderBy: { createdAt: 'asc' },
        select: {
          id: true,
          kycId: true,
          userId: true,
          status: true,
          rejectionReason: true,
          attemptNumber: true,
          createdAt: true,
          reviewedAt: true,
          reviewedBy: true,
          slaStartedAt: true,
          slaPausedAt: true,
          slaPausedAccumMs: true,
          slaBreachedAt: true,
          assignedReviewerId: true,
          user: { select: { userId: true, email: true, fullName: true } },
          reviewer: { select: { adminId: true, fullName: true } },
        },
      }),
      this.prisma.kycRequest.count({ where }),
    ]);

    const config = await getEffectiveSlaConfig(this.prisma, 'KYC_PERSONAL');
    const now = new Date();
    const reviewerIds = [...new Set(requests.map(r => r.assignedReviewerId).filter((v): v is string => !!v))];
    const reviewerMap = await this.getAdminNameMap(reviewerIds);

    const rows = requests.map(r => ({
      ...r,
      sla: this.buildSlaView(r, now, config),
      assignedReviewer: r.assignedReviewerId
        ? (reviewerMap.get(r.assignedReviewerId) ?? { adminId: r.assignedReviewerId, fullName: null })
        : null,
    }));

    return createPaginatedResponse(rows, total, safePage, safeLimit);
  }

  /** Peta id admin → { adminId, fullName } untuk label reviewer. */
  private async getAdminNameMap(ids: string[]): Promise<Map<string, { adminId: string; fullName: string | null }>> {
    const map = new Map<string, { adminId: string; fullName: string | null }>();
    if (ids.length === 0) return map;
    const admins = await this.prisma.adminUser.findMany({
      where: { id: { in: ids } },
      select: { id: true, adminId: true, fullName: true },
    });
    for (const a of admins) map.set(a.id, { adminId: a.adminId, fullName: a.fullName });
    return map;
  }

  /** Tampilan SLA per baris — jam dihitung live dari config efektif. */
  private buildSlaView(
    r: SlaTrackable & { createdAt: Date; slaBreachedAt?: Date | null },
    now: Date,
    config: SlaConfigLike,
  ): Record<string, unknown> {
    const track: SlaTrackable = {
      slaStartedAt: r.slaStartedAt ?? r.createdAt,
      slaPausedAt: r.slaPausedAt,
      slaPausedAccumMs: r.slaPausedAccumMs,
    };
    return {
      startedAt: track.slaStartedAt,
      paused: !!r.slaPausedAt,
      breachedAt: r.slaBreachedAt ?? null,
      elapsedMs: slaElapsedMs(track, now, config),
      remainingMs: slaRemainingMs(track, now, config),
      status: slaStatus(track, now, config),
      slaHours: config.slaHours,
      useBusinessHours: config.useBusinessHours,
    };
  }

  async approveKyc(
    kycId: string,
    adminId: string,
    notes?: string,
    ipAddress: string = 'internal',
  ): Promise<Record<string, unknown>> {
    const normalizedNotes = this.normalizeOptionalText(notes);
    const request = await this.prisma.kycRequest.findFirst({
      where: { OR: [{ id: kycId }, { kycId }] },
      include: { user: { select: { id: true, userId: true, email: true, fullName: true } } },
    });
    if (!request)
      throw new NotFoundException({
        code: ErrorCodes.KYC_NOT_FOUND,
        message: 'KYC request not found',
      });
    if (request.status !== 'PENDING') {
      throw new BadRequestException({
        code: ErrorCodes.INVALID_STATUS,
        message: `KYC is already ${request.status}`,
      });
    }

    const updated = await this.prisma.$transaction(
      async (tx: Prisma.TransactionClient) => {
        const guard = await tx.kycRequest.updateMany({
          where: { id: request.id, status: 'PENDING' },
          data: {
            status: 'APPROVED',
            reviewedBy: adminId,
            reviewedAt: new Date(),
            adminNotes: normalizedNotes,
          },
        });
        if (guard.count === 0) {
          throw new BadRequestException({
            code: ErrorCodes.INVALID_STATUS,
            message: 'KYC request was already processed by another admin',
          });
        }
        const result = await tx.kycRequest.findUniqueOrThrow({ where: { id: request.id } });

        await tx.user.update({
          where: { id: request.userId },
          data: {
            kycStatus: 'APPROVED',
            kycApprovedAt: new Date(),
          },
        });

        return result;
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );

    await this.invalidateKycCache(request.userId);
    this.auditLog.logAdminAction({
      adminId,
      action: AuditAction.KYC_APPROVED,
      targetType: 'KYC_REQUEST',
      targetId: kycId,
      description: `KYC ${kycId} approved for user ${request.userId}${normalizedNotes ? ': ' + normalizedNotes : ''}`,
      ipAddress,
    });

    void this.prisma.notification
      .create({
        data: {
          notifId: generateNotifId(),
          userId: request.userId,
          type: NotificationType.KYC_APPROVED,
          category: getCategoryForType(NotificationType.KYC_APPROVED),
          title: 'KYC Verification Approved',
          body: 'Congratulations! Your identity has been successfully verified. You can now perform escrow transactions.',
          isRead: false,
        },
      })
      .catch((error: unknown) =>
        this.logger.warn(
          `KYC approval notification failed after commit: ${error instanceof Error ? error.message : String(error)}`,
        ),
      );

    this.prisma.emitNotificationCreated({
      userId: request.userId,
      title: 'KYC Verification Approved',
      body: 'Congratulations! Your identity has been successfully verified. You can now perform escrow transactions.',
      data: { type: 'KYC_APPROVED' },
    });

    if (request.user?.email) {
      this.emailQueue
        .add(
          'send',
          {
            to: request.user.email,
            subject: 'Kahade — Your KYC Verification Has Been Approved',
            templateName: 'kyc-approved',
            templateContext: { name: request.user.fullName ?? 'User' },
          },
          { attempts: 3, backoff: { type: 'exponential', delay: 5000 } },
        )
        .catch(err => {
          this.logger.error(`Failed to queue KYC approval email for ${request.user?.email}`, err);
        });
    }

    // AW-018: pendingKyc / verifiedUsers di summary dashboard bisa berubah.
    await this.dashboard.invalidateSummaryCache();

    return updated;
  }

  async rejectKyc(
    kycId: string,
    adminId: string,
    reason: string,
    notes?: string,
    ipAddress: string = 'internal',
  ): Promise<Record<string, unknown>> {
    const normalizedReason = this.normalizeRequiredText(reason, 'Rejection reason');
    const normalizedNotes = this.normalizeOptionalText(notes);
    const request = await this.prisma.kycRequest.findFirst({
      where: { OR: [{ id: kycId }, { kycId }] },
      include: { user: { select: { id: true, userId: true, email: true, fullName: true } } },
    });
    if (!request)
      throw new NotFoundException({
        code: ErrorCodes.KYC_NOT_FOUND,
        message: 'KYC request not found',
      });
    if (request.status !== 'PENDING') {
      throw new BadRequestException({
        code: ErrorCodes.INVALID_STATUS,
        message: `KYC is already ${request.status}`,
      });
    }

    const updated = await this.prisma.$transaction(
      async (tx: Prisma.TransactionClient) => {
        const guard = await tx.kycRequest.updateMany({
          where: { id: request.id, status: 'PENDING' },
          data: {
            status: 'REJECTED',
            reviewedBy: adminId,
            reviewedAt: new Date(),
            rejectionReason: normalizedReason,
            adminNotes: normalizedNotes,
          },
        });
        if (guard.count === 0) {
          throw new BadRequestException({
            code: ErrorCodes.INVALID_STATUS,
            message: 'KYC request was already processed by another admin',
          });
        }
        const result = await tx.kycRequest.findUniqueOrThrow({ where: { id: request.id } });

        await tx.user.update({
          where: { id: request.userId },
          data: {
            kycStatus: 'REJECTED',
            kycApprovedAt: null,
          },
        });

        return result;
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );

    await this.invalidateKycCache(request.userId);
    this.auditLog.logAdminAction({
      adminId,
      action: AuditAction.KYC_REJECTED,
      targetType: 'KYC_REQUEST',
      targetId: kycId,
      description: `KYC ${kycId} rejected for user ${request.userId}: ${normalizedReason}`,
      ipAddress,
    });

    const safeReason = escapeHtml(normalizedReason);
    void this.prisma.notification
      .create({
        data: {
          notifId: generateNotifId(),
          userId: request.userId,
          type: NotificationType.KYC_REJECTED,
          category: getCategoryForType(NotificationType.KYC_REJECTED),
          title: 'KYC Verification Rejected',
          body: `Your KYC application could not be approved. Reason: ${safeReason}. Please resubmit with the correct documents.`,
          isRead: false,
        },
      })
      .catch((error: unknown) =>
        this.logger.warn(
          `KYC rejection notification failed after commit: ${error instanceof Error ? error.message : String(error)}`,
        ),
      );

    const safeReasonForPush = escapeHtml(normalizedReason);
    this.prisma.emitNotificationCreated({
      userId: request.userId,
      title: 'KYC Verification Rejected',
      body: `Your KYC application could not be approved. Reason: ${safeReasonForPush}. Please resubmit with the correct documents.`,
      data: { type: 'KYC_REJECTED' },
    });

    if (request.user?.email) {
      const safeReasonForEmail = escapeHtml(normalizedReason);
      const safeNotesForEmail = normalizedNotes ? escapeHtml(normalizedNotes) : undefined;
      this.emailQueue
        .add(
          'send',
          {
            to: request.user.email,
            subject: 'Kahade — Your KYC Verification Was Not Approved',
            templateName: 'kyc-rejected',
            templateContext: {
              name: request.user.fullName ?? 'User',
              reason: safeReasonForEmail,
              notes: safeNotesForEmail,
            },
          },
          { attempts: 3, backoff: { type: 'exponential', delay: 5000 } },
        )
        .catch(err => {
          this.logger.error(`Failed to queue KYC rejection email for ${request.user?.email}`, err);
        });
    }

    // AW-018: pendingKyc di summary dashboard bisa berubah.
    await this.dashboard.invalidateSummaryCache();

    return updated;
  }

  async revokeKyc(
    kycId: string,
    adminId: string,
    reason: string,
    ipAddress: string = 'internal',
  ): Promise<Record<string, unknown>> {
    const normalizedReason = this.normalizeRequiredText(reason, 'Revocation reason');
    const request = await this.prisma.kycRequest.findFirst({
      where: { OR: [{ id: kycId }, { kycId }] },
      include: { user: { select: { id: true, userId: true, email: true, fullName: true } } },
    });
    if (!request)
      throw new NotFoundException({
        code: ErrorCodes.KYC_NOT_FOUND,
        message: 'KYC request not found',
      });
    if (request.status !== 'APPROVED') {
      throw new BadRequestException({
        code: ErrorCodes.INVALID_STATUS,
        message: `KYC can only be revoked from APPROVED status, current: ${request.status}`,
      });
    }

    const updated = await this.prisma.$transaction(
      async (tx: Prisma.TransactionClient) => {
        const guard = await tx.kycRequest.updateMany({
          where: { id: request.id, status: 'APPROVED' },
          data: {
            status: 'REVOKED',
            reviewedBy: adminId,
            reviewedAt: new Date(),
            rejectionReason: normalizedReason,
          },
        });
        if (guard.count === 0) {
          throw new BadRequestException({
            code: ErrorCodes.INVALID_STATUS,
            message: 'KYC request was already processed by another admin',
          });
        }
        const result = await tx.kycRequest.findUniqueOrThrow({ where: { id: request.id } });

        await tx.user.update({
          where: { id: request.userId },
          data: {
            kycStatus: 'REVOKED',
            kycApprovedAt: null,
          },
        });

        return result;
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );

    await this.invalidateKycCache(request.userId);
    this.auditLog.logAdminAction({
      adminId,
      action: AuditAction.KYC_REVOKED,
      targetType: 'KYC_REQUEST',
      targetId: kycId,
      description: `KYC ${kycId} revoked for user ${request.userId}: ${normalizedReason}`,
      ipAddress,
    });

    const safeRevokeReason = escapeHtml(normalizedReason);
    void this.prisma.notification
      .create({
        data: {
          notifId: generateNotifId(),
          userId: request.userId,
          type: NotificationType.KYC_REVOKED,
          category: getCategoryForType(NotificationType.KYC_REVOKED),
          title: 'KYC Verification Revoked',
          body: `Your KYC verification has been revoked. Reason: ${safeRevokeReason}. Please contact customer support for more information.`,
          isRead: false,
        },
      })
      .catch((error: unknown) =>
        this.logger.warn(
          `KYC revocation notification failed after commit: ${error instanceof Error ? error.message : String(error)}`,
        ),
      );

    const safeRevokeReasonForPush = escapeHtml(normalizedReason);
    this.prisma.emitNotificationCreated({
      userId: request.userId,
      title: 'KYC Verification Revoked',
      body: `Your KYC verification has been revoked. Reason: ${safeRevokeReasonForPush}. Please contact customer support for more information.`,
      data: { type: 'KYC_REVOKED' },
    });

    if (request.user?.email) {
      const safeReasonForEmail = escapeHtml(normalizedReason);
      this.emailQueue
        .add(
          'send',
          {
            to: request.user.email,
            subject: 'Kahade — Your KYC Verification Has Been Revoked',
            templateName: 'kyc-revoked',
            templateContext: { name: request.user.fullName ?? 'User', reason: safeReasonForEmail },
          },
          { attempts: 3, backoff: { type: 'exponential', delay: 5000 } },
        )
        .catch(err => {
          this.logger.error(`Failed to queue KYC revocation email for ${request.user?.email}`, err);
        });
    }

    // AW-018: verifiedUsers di summary dashboard bisa berubah.
    await this.dashboard.invalidateSummaryCache();

    return updated;
  }

  async getKycDetail(
    kycId: string,
    adminId?: string,
    ipAddress?: string,
  ): Promise<Record<string, unknown>> {
    const request = await this.prisma.kycRequest.findFirst({
      where: { OR: [{ id: kycId }, { kycId }] },
      select: {
        id: true,
        kycId: true,
        userId: true,
        status: true,
        rejectionReason: true,
        adminNotes: true,
        attemptNumber: true,
        submittedIp: true,
        createdAt: true,
        reviewedAt: true,
        reviewedBy: true,
        slaStartedAt: true,
        slaPausedAt: true,
        slaPausedAccumMs: true,
        slaBreachedAt: true,
        assignedReviewerId: true,
        user: { select: { userId: true, email: true, fullName: true } },
        reviewer: { select: { adminId: true, fullName: true } },
      },
    });
    if (!request)
      throw new NotFoundException({
        code: ErrorCodes.KYC_NOT_FOUND,
        message: 'KYC request not found',
      });

    if (adminId) {
      this.auditLog.logAdminAction({
        adminId,
        action: AuditAction.ADMIN_ACTION,
        targetType: 'KYC_REQUEST',
        targetId: kycId,
        description: `Admin viewed KYC detail for ${kycId} (user ${request.userId})`,
        ipAddress: ipAddress ?? 'unknown',
      });
    }

    // GAP-E (G293–G300): info SLA live + riwayat penugasan + catatan reviewer
    // sebelumnya (NIK/nomor telepon di-mask).
    const config = await getEffectiveSlaConfig(this.prisma, 'KYC_PERSONAL');
    const now = new Date();

    const assignments = await this.prisma.kycReviewAssignment.findMany({
      where: { kycRequestId: request.id },
      orderBy: { assignedAt: 'desc' },
      take: 10,
    });
    const assignmentAdminIds = [
      ...new Set(
        [...assignments.map(a => a.adminId), ...assignments.map(a => a.assignedBy)].filter(
          (v): v is string => !!v,
        ),
      ),
    ];
    const assignmentNameMap = await this.getAdminNameMap(assignmentAdminIds);
    const assignmentHistory = assignments.map(a => ({
      id: a.id,
      admin: assignmentNameMap.get(a.adminId) ?? { adminId: a.adminId, fullName: null },
      assignedBy: assignmentNameMap.get(a.assignedBy) ?? { adminId: a.assignedBy, fullName: null },
      assignedAt: a.assignedAt,
      releasedAt: a.releasedAt,
      active: a.active,
    }));

    const rawNotes = await this.prisma.adminAuditLog.findMany({
      where: {
        targetType: 'KYC_REQUEST',
        OR: [{ targetId: request.id }, { targetId: request.kycId }],
      },
      select: { id: true, adminId: true, action: true, description: true, createdAt: true },
      orderBy: { createdAt: 'desc' },
      take: 20,
    });
    const noteAdminIds = [...new Set(rawNotes.map(n => n.adminId).filter((v): v is string => !!v))];
    const noteNameMap = await this.getAdminNameMap(noteAdminIds);
    const reviewerNotes = rawNotes.map(n => ({
      id: n.id,
      admin: n.adminId ? (noteNameMap.get(n.adminId) ?? { adminId: n.adminId, fullName: null }) : null,
      action: n.action,
      description: this.maskSensitiveDigits(n.description ?? ''),
      createdAt: n.createdAt,
    }));

    return {
      ...request,
      sla: this.buildSlaView(request, now, config),
      assignedReviewer: request.assignedReviewerId
        ? (assignmentNameMap.get(request.assignedReviewerId) ?? {
            adminId: request.assignedReviewerId,
            fullName: null,
          })
        : null,
      assignmentHistory,
      reviewerNotes,
    };
  }

  /**
   * Masking NIK (16 digit) & nomor telepon di teks bebas catatan reviewer —
   * catatan tidak boleh membocorkan PII mentah ke UI.
   */
  private maskSensitiveDigits(text: string): string {
    return text
      .replace(/\b\d{16,}\b/g, '••••••••••••••••')
      .replace(/\b(?:\+?62|0)8\d{7,12}\b/g, '••••••••');
  }

  async getDocumentUrls(
    kycId: string,
    adminId: string,
    ipAddress: string = 'unknown',
    adminPassword?: string,
  ): Promise<{ ktpUrl: string | null; selfieUrl: string | null; livenessUrl: string | null; documentType: string | null; partialErrors?: string[] }> {
    if (!adminPassword) {
      throw new UnauthorizedException({
        code: ErrorCodes.UNAUTHORIZED,
        message: 'Re-authentication required to access KYC documents. Provide your password.',
      });
    }

    const admin = await this.prisma.adminUser.findUnique({ where: { id: adminId } });
    if (!admin) {
      throw new UnauthorizedException({
        code: ErrorCodes.UNAUTHORIZED,
        message: 'Admin not found',
      });
    }

    const isPasswordValid = await bcryptCompare(adminPassword, admin.password);
    if (!isPasswordValid) {
      this.auditLog.logAdminAction({
        adminId,
        action: AuditAction.ADMIN_ACTION,
        targetType: 'KYC_REQUEST',
        targetId: kycId,
        description: `Failed re-authentication attempt for KYC document access (${kycId})`,
        ipAddress,
      });
      throw new UnauthorizedException({
        code: ErrorCodes.INVALID_CREDENTIALS,
        message: 'Invalid password for re-authentication',
      });
    }

    const request = await this.prisma.kycRequest.findFirst({
      where: { OR: [{ id: kycId }, { kycId }] },
    });
    if (!request)
      throw new NotFoundException({
        code: ErrorCodes.KYC_NOT_FOUND,
        message: 'KYC request not found',
      });

    // KYC-006 fix: decrypt each document independently so a single corrupted
    // ciphertext doesn't prevent the admin from accessing the other (valid) document.
    let ktpFileKey: string | null = null;
    let selfieFileKey: string | null = null;
    let livenessFileKey: string | null = null;
    const decryptErrors: string[] = [];

    try {
      ktpFileKey = await decryptAES(request.ktpPhotoUrl);
    } catch (err) {
      decryptErrors.push('KTP photo is unavailable');
      this.logger.error(`[AdminKycService] KTP photo decryption failed for kycId=${kycId}`, err);
    }
    try {
      selfieFileKey = await decryptAES(request.selfiePhotoUrl);
    } catch (err) {
      decryptErrors.push('Selfie photo is unavailable');
      this.logger.error(`[AdminKycService] Selfie photo decryption failed for kycId=${kycId}`, err);
    }
    // 03-#6: liveness key kini disimpan — dekripsi independen seperti dokumen lain.
    if (request.livenessFileKey) {
      try {
        livenessFileKey = await decryptAES(request.livenessFileKey);
      } catch (err) {
        decryptErrors.push('Liveness video is unavailable');
        this.logger.error(`[AdminKycService] Liveness decryption failed for kycId=${kycId}`, err);
      }
    }

    if (!ktpFileKey && !selfieFileKey) {
      throw new BadRequestException({
        code: ErrorCodes.INTERNAL_SERVER_ERROR,
        message: 'Both document decryption failed. Data may be corrupted.',
      });
    }

    let ktpUrl: string | null = null;
    let selfieUrl: string | null = null;
    let livenessUrl: string | null = null;
    if (ktpFileKey) {
      try {
        ktpUrl = await this.uploadService.generateDownloadUrl(ktpFileKey, 300);
      } catch (err) {
        this.logger.error(
          `[AdminKycService] KTP signed URL generation failed for kycId=${kycId}`,
          err,
        );
        decryptErrors.push('KTP download URL is unavailable');
      }
    }
    if (selfieFileKey) {
      try {
        selfieUrl = await this.uploadService.generateDownloadUrl(selfieFileKey, 300);
      } catch (err) {
        this.logger.error(
          `[AdminKycService] Selfie signed URL generation failed for kycId=${kycId}`,
          err,
        );
        decryptErrors.push('Selfie download URL is unavailable');
      }
    }
    if (livenessFileKey) {
      try {
        livenessUrl = await this.uploadService.generateDownloadUrl(livenessFileKey, 300);
      } catch (err) {
        this.logger.error(
          `[AdminKycService] Liveness signed URL generation failed for kycId=${kycId}`,
          err,
        );
        decryptErrors.push('Liveness download URL is unavailable');
      }
    }

    this.auditLog.logAdminAction({
      adminId,
      action: AuditAction.KYC_DOCUMENTS_ACCESSED,
      targetType: 'KYC_REQUEST',
      targetId: kycId,
      description: `Admin accessed KYC documents for ${kycId} (user ${request.userId}) after re-authentication`,
      ipAddress,
    });

    // GAP-E (G297): kegagalan unduh dokumen dicatat dengan marker khusus agar
    // daftar "perlu perhatian" bisa dibangun TANPA membuka key storage.
    if (decryptErrors.length > 0) {
      this.auditLog.logAdminAction({
        adminId,
        action: AuditAction.ADMIN_ACTION,
        targetType: 'KYC_REQUEST',
        targetId: kycId,
        description: `[KYC-DOC-FAIL] ${kycId}: ${decryptErrors.join('; ')}`,
        ipAddress,
      });
    }

    return {
      ktpUrl,
      selfieUrl,
      livenessUrl,
      documentType: request.documentType ?? null,
      ...(decryptErrors.length > 0 ? { partialErrors: decryptErrors } : {}),
    };
  }

  /**
   * Guard bulk: cegah aksi bila status item berubah sejak daftar dimuat
   * (expectedStatus dari UI). Item yang tidak cocok masuk `failed` agar bisa
   * di-retry setelah daftar dimuat ulang.
   */
  private async assertExpectedStatus(kycId: string, expectedStatus: string): Promise<void> {
    const current = await this.prisma.kycRequest.findFirst({
      where: { OR: [{ id: kycId }, { kycId }] },
      select: { status: true },
    });
    if (!current)
      throw new NotFoundException({
        code: ErrorCodes.KYC_NOT_FOUND,
        message: 'KYC request not found',
      });
    if (current.status !== expectedStatus) {
      throw new ConflictException({
        code: ErrorCodes.KYC_STATUS_CHANGED,
        message: `Status berubah sejak daftar dimuat (kini: ${current.status}). Muat ulang daftar sebelum melanjutkan.`,
      });
    }
  }

  async bulkApproveKyc(
    kycIds: string[],
    adminId: string,
    notes?: string,
    ipAddress: string = 'internal',
    expectedStatus?: string,
  ): Promise<{ approved: string[]; failed: { id: string; reason: string }[] }> {
    const approved: string[] = [];
    const failed: { id: string; reason: string }[] = [];
    for (const id of kycIds.slice(0, 50)) {
      try {
        if (expectedStatus) await this.assertExpectedStatus(id, expectedStatus);
        await this.approveKyc(id, adminId, notes, ipAddress);
        approved.push(id);
      } catch (e) {
        failed.push({ id, reason: e instanceof Error ? e.message : String(e) });
      }
    }
    return { approved, failed };
  }

  async bulkRejectKyc(
    kycIds: string[],
    adminId: string,
    reason: string,
    notes?: string,
    ipAddress: string = 'internal',
    expectedStatus?: string,
  ): Promise<{ rejected: string[]; failed: { id: string; reason: string }[] }> {
    const rejected: string[] = [];
    const failed: { id: string; reason: string }[] = [];
    for (const id of kycIds.slice(0, 50)) {
      try {
        if (expectedStatus) await this.assertExpectedStatus(id, expectedStatus);
        await this.rejectKyc(id, adminId, reason, notes, ipAddress);
        rejected.push(id);
      } catch (e) {
        failed.push({ id, reason: e instanceof Error ? e.message : String(e) });
      }
    }
    return { rejected, failed };
  }

  // ============================================================
  // === GAP-E (G276–G300): SLA operasional & operasi antrean ===
  // ============================================================

  /**
   * G276–G278: config SLA efektif per scope. Seed default 48 jam kalender
   * saat pertama dibaca (bukan konstanta UI).
   */
  async getSlaConfig(): Promise<Record<string, unknown>> {
    const configs: Record<string, unknown> = {};
    for (const scope of SLA_SCOPES) {
      const config = await getEffectiveSlaConfig(this.prisma, scope);
      const row = await this.prisma.operationalSlaConfig.findUnique({ where: { scope } });
      configs[scope] = {
        scope,
        slaHours: config.slaHours,
        useBusinessHours: config.useBusinessHours,
        updatedAt: row?.updatedAt ?? null,
        updatedBy: row?.updatedBy ?? null,
      };
    }
    return {
      configs,
      businessHoursDefinition: 'Senin–Jumat 09:00–17:00 WIB',
      defaultSlaHours: DEFAULT_SLA_HOURS,
    };
  }

  /**
   * G277–G278: ubah config SLA + tulis OperationalSlaConfigAudit + audit log
   * SLA_CONFIG_UPDATED. changeReason wajib (divalidasi DTO).
   */
  async updateSlaConfig(
    dto: UpdateSlaConfigDto,
    adminId: string,
    ipAddress: string = 'internal',
  ): Promise<Record<string, unknown>> {
    const before = await getEffectiveSlaConfig(this.prisma, dto.scope);
    const reason = dto.changeReason.trim();

    const updated = await this.prisma.$transaction(async (tx) => {
      const config = await tx.operationalSlaConfig.upsert({
        where: { scope: dto.scope },
        update: {
          slaHours: dto.slaHours,
          useBusinessHours: dto.useBusinessHours,
          updatedBy: adminId,
          changeReason: reason,
        },
        create: {
          scope: dto.scope,
          slaHours: dto.slaHours,
          useBusinessHours: dto.useBusinessHours,
          updatedBy: adminId,
          changeReason: reason,
        },
      });
      await tx.operationalSlaConfigAudit.create({
        data: {
          configId: config.id,
          slaHours: dto.slaHours,
          useBusinessHours: dto.useBusinessHours,
          changedBy: adminId,
          changeReason: reason,
        },
      });
      return config;
    });

    const modeLabel = (useBusiness: boolean) => (useBusiness ? 'jam kerja' : 'jam kalender');
    this.auditLog.logAdminAction({
      adminId,
      action: AuditAction.SLA_CONFIG_UPDATED,
      targetType: 'OPERATIONAL_SLA_CONFIG',
      targetId: updated.id,
      description:
        `SLA ${dto.scope}: ${before.slaHours} jam (${modeLabel(before.useBusinessHours)}) → ` +
        `${dto.slaHours} jam (${modeLabel(dto.useBusinessHours)}). Alasan: ${reason}`,
      ipAddress,
    });

    return {
      scope: updated.scope,
      slaHours: updated.slaHours,
      useBusinessHours: updated.useBusinessHours,
      updatedAt: updated.updatedAt,
      updatedBy: updated.updatedBy,
    };
  }

  /** Ambil KycRequest by id/kycId — helper untuk endpoint G279–G300. */
  private async findKycOrThrow(kycId: string) {
    const request = await this.prisma.kycRequest.findFirst({
      where: { OR: [{ id: kycId }, { kycId }] },
      select: {
        id: true,
        kycId: true,
        userId: true,
        status: true,
        adminNotes: true,
        slaStartedAt: true,
        slaPausedAt: true,
        slaPausedAccumMs: true,
        createdAt: true,
      },
    });
    if (!request)
      throw new NotFoundException({
        code: ErrorCodes.KYC_NOT_FOUND,
        message: 'KYC request not found',
      });
    return request;
  }

  /**
   * ADM-004: daftar reviewer yang dapat ditugaskan (KYC_ADMIN / SUPER_ADMIN
   * aktif) — hanya id + nama + role, TANPA email/PII berlebih.
   * Boleh dibaca KYC_ADMIN (role utama modul ini) maupun SUPER_ADMIN.
   */
  async listReviewers(): Promise<object> {
    const reviewers = await this.prisma.adminUser.findMany({
      where: {
        isActive: true,
        deletedAt: null,
        role: { in: ['KYC_ADMIN', 'SUPER_ADMIN'] },
      },
      orderBy: { fullName: 'asc' },
      select: { id: true, adminId: true, fullName: true, role: true },
    });
    return { data: reviewers, total: reviewers.length };
  }

  /**
   * G293: tugaskan reviewer. Penugasan aktif lama dinonaktifkan
   * (riwayat tetap tersimpan), audit KYC_REVIEW_ASSIGNED.
   */
  async assignReviewer(
    kycId: string,
    targetAdminId: string,
    adminId: string,
    ipAddress: string = 'internal',
  ): Promise<Record<string, unknown>> {
    const request = await this.findKycOrThrow(kycId);

    // Terima DB id maupun public adminId (mis. "ADMIN-00001") dari UI.
    const target = await this.prisma.adminUser.findFirst({
      where: {
        OR: [{ id: targetAdminId }, { adminId: targetAdminId }],
      },
      select: { id: true, adminId: true, fullName: true, role: true, isActive: true, deletedAt: true },
    });
    if (!target)
      throw new NotFoundException({
        code: ErrorCodes.KYC_REVIEWER_NOT_FOUND,
        message: 'Reviewer admin not found',
      });
    if (!target.isActive || target.deletedAt)
      throw new BadRequestException({
        code: ErrorCodes.KYC_REVIEWER_INACTIVE,
        message: 'Reviewer admin is not active',
      });
    if (target.role !== 'KYC_ADMIN' && target.role !== 'SUPER_ADMIN')
      throw new BadRequestException({
        code: ErrorCodes.KYC_REVIEWER_WRONG_ROLE,
        message: 'Reviewer must have KYC_ADMIN or SUPER_ADMIN role',
      });

    const now = new Date();
    const assignment = await this.prisma.$transaction(async (tx) => {
      await tx.kycReviewAssignment.updateMany({
        where: { kycRequestId: request.id, active: true },
        data: { active: false, releasedAt: now },
      });
      const created = await tx.kycReviewAssignment.create({
        data: { kycRequestId: request.id, adminId: target.id, assignedBy: adminId },
      });
      await tx.kycRequest.update({
        where: { id: request.id },
        data: { assignedReviewerId: target.id },
      });
      return created;
    });

    this.auditLog.logAdminAction({
      adminId,
      action: AuditAction.KYC_REVIEW_ASSIGNED,
      targetType: 'KYC_REQUEST',
      targetId: kycId,
      description: `KYC ${request.kycId} assigned to reviewer ${target.adminId} (${target.fullName ?? 'admin'})`,
      ipAddress,
    });

    return {
      assignmentId: assignment.id,
      kycRequestId: request.id,
      adminId: target.id,
      reviewerAdminId: target.adminId,
      assignedAt: assignment.assignedAt,
    };
  }

  /** G293: lepas penugasan reviewer aktif. */
  async releaseReviewer(
    kycId: string,
    adminId: string,
    ipAddress: string = 'internal',
  ): Promise<Record<string, unknown>> {
    const request = await this.findKycOrThrow(kycId);
    const now = new Date();

    const released = await this.prisma.$transaction(async (tx) => {
      const active = await tx.kycReviewAssignment.findFirst({
        where: { kycRequestId: request.id, active: true },
        select: { id: true, adminId: true },
      });
      if (!active)
        throw new NotFoundException({
          code: ErrorCodes.KYC_NO_ACTIVE_ASSIGNMENT,
          message: 'No active reviewer assignment for this KYC request',
        });
      await tx.kycReviewAssignment.updateMany({
        where: { kycRequestId: request.id, active: true },
        data: { active: false, releasedAt: now },
      });
      await tx.kycRequest.update({
        where: { id: request.id },
        data: { assignedReviewerId: null },
      });
      return active;
    });

    this.auditLog.logAdminAction({
      adminId,
      action: AuditAction.ADMIN_ACTION,
      targetType: 'KYC_REQUEST',
      targetId: kycId,
      description: `KYC ${request.kycId}: reviewer assignment released (was ${released.adminId})`,
      ipAddress,
    });

    return { released: true, kycRequestId: request.id, releasedAt: now };
  }

  /**
   * G279: admin meminta dokumen tambahan → SLA DIJEDA (slaPausedAt = now).
   * Pengguna diberi tahu via notifikasi agar melengkapi dokumen.
   */
  async requestDocuments(
    kycId: string,
    adminId: string,
    message: string,
    notes: string | undefined,
    ipAddress: string = 'internal',
  ): Promise<Record<string, unknown>> {
    const request = await this.findKycOrThrow(kycId);
    if (request.status !== 'PENDING')
      throw new BadRequestException({
        code: ErrorCodes.INVALID_STATUS,
        message: 'Additional documents can only be requested for PENDING requests',
      });
    if (request.slaPausedAt)
      throw new BadRequestException({
        code: ErrorCodes.KYC_ALREADY_PAUSED,
        message: 'SLA is already paused for this request',
      });

    const now = new Date();
    const wibStamp = now.toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' });
    const entry =
      `[Dokumen tambahan diminta — ${wibStamp} WIB]\n${message.trim()}` +
      (notes?.trim() ? `\nCatatan internal: ${notes.trim()}` : '');
    const adminNotes = request.adminNotes ? `${request.adminNotes}\n\n${entry}` : entry;

    await this.prisma.kycRequest.update({
      where: { id: request.id },
      data: { slaPausedAt: now, adminNotes },
    });

    this.auditLog.logAdminAction({
      adminId,
      action: AuditAction.ADMIN_ACTION,
      targetType: 'KYC_REQUEST',
      targetId: kycId,
      description: `KYC ${request.kycId}: dokumen tambahan diminta — SLA dijeda. Pesan: ${message.trim()}`,
      ipAddress,
    });

    // Beri tahu pengguna agar melengkapi dokumen (kanal notifikasi existing).
    const title = 'Dokumen tambahan diperlukan';
    const body =
      'Tim kami membutuhkan dokumen tambahan untuk verifikasi identitas Anda. ' +
      'Silakan lengkapi melalui aplikasi agar proses verifikasi dapat dilanjutkan.';
    void this.prisma.notification
      .create({
        data: {
          notifId: generateNotifId(),
          userId: request.userId,
          type: NotificationType.KYC_RESUBMIT_REMINDER,
          category: getCategoryForType(NotificationType.KYC_RESUBMIT_REMINDER),
          title,
          body,
          isRead: false,
        },
      })
      .then(() => {
        this.prisma.emitNotificationCreated({
          userId: request.userId,
          title,
          body,
          data: { type: 'KYC_RESUBMIT_REMINDER', kycId: request.kycId },
        });
      })
      .catch((error: unknown) =>
        this.logger.warn(
          `KYC document-request notification failed: ${error instanceof Error ? error.message : String(error)}`,
        ),
      );

    return { paused: true, kycRequestId: request.id, slaPausedAt: now };
  }

  /**
   * G279: lanjutkan SLA yang dijeda (akumulasi jeda dalam satuan jam SLA).
   * Dipakai admin saat dokumen diterima via kanal lain; jalur utama resume
   * otomatis adalah endpoint pengguna /v1/kyc/:id/supplement-documents.
   */
  async resumeSla(
    kycId: string,
    adminId: string,
    ipAddress: string = 'internal',
  ): Promise<Record<string, unknown>> {
    const request = await this.findKycOrThrow(kycId);
    if (request.status !== 'PENDING')
      throw new BadRequestException({
        code: ErrorCodes.INVALID_STATUS,
        message: 'SLA can only be resumed for PENDING requests',
      });
    if (!request.slaPausedAt)
      throw new BadRequestException({
        code: ErrorCodes.KYC_NOT_PAUSED,
        message: 'SLA is not paused for this request',
      });

    const config = await getEffectiveSlaConfig(this.prisma, 'KYC_PERSONAL');
    const now = new Date();
    const { accumMs } = accumulatePauseOnResume(request, now, config.useBusinessHours);

    await this.prisma.kycRequest.update({
      where: { id: request.id },
      data: { slaPausedAt: null, slaPausedAccumMs: BigInt(accumMs) },
    });

    this.auditLog.logAdminAction({
      adminId,
      action: AuditAction.ADMIN_ACTION,
      targetType: 'KYC_REQUEST',
      targetId: kycId,
      description: `KYC ${request.kycId}: SLA dilanjutkan — akumulasi jeda ${Math.round(accumMs / 3_600_000)} jam SLA`,
      ipAddress,
    });

    return { resumed: true, kycRequestId: request.id, pausedAccumMs: accumMs };
  }

  /** Pembulatan 2 desimal untuk metrik. */
  private round2(n: number | null): number | null {
    return n === null ? null : Math.round(n * 100) / 100;
  }

  /**
   * G294: metrik waktu review — median/p50/p95 per status dalam periode
   * (param from/to). Tanpa NIK/dokumen — hanya agregat durasi.
   */
  async getKycMetrics(from?: string, to?: string): Promise<Record<string, unknown>> {
    const toDate = to ? new Date(to) : new Date();
    const fromDate = from ? new Date(from) : new Date(toDate.getTime() - 30 * 24 * 3_600_000);
    if (Number.isNaN(fromDate.getTime()) || Number.isNaN(toDate.getTime()) || fromDate > toDate) {
      throw new BadRequestException({
        code: ErrorCodes.VALIDATION_ERROR,
        message: 'Invalid period: from must be <= to (ISO 8601)',
      });
    }

    // AW-005 (perf-fix): agregat + persentil dihitung di SQL via
    // percentile_cont — tidak lagi menarik hingga 5000 baris ke memori Node.
    // Baris berdurasi negatif (reviewedAt < start) dikecualikan, paritas
    // dengan logika lama. Kolom fisik: "reviewedAt"/"createdAt" camelCase,
    // "sla_started_at" via @map.
    const metricRows = await this.prisma.$queryRaw<
      Array<{
        status: string;
        count: bigint;
        p50: number | null;
        p95: number | null;
        avg: number | null;
        min: number | null;
        max: number | null;
      }>
    >`
      SELECT status,
             COUNT(*) AS "count",
             percentile_cont(0.5) WITHIN GROUP (ORDER BY hours) AS "p50",
             percentile_cont(0.95) WITHIN GROUP (ORDER BY hours) AS "p95",
             AVG(hours) AS "avg",
             MIN(hours) AS "min",
             MAX(hours) AS "max"
      FROM (
        SELECT status,
               EXTRACT(EPOCH FROM ("reviewedAt" - COALESCE("sla_started_at", "createdAt"))) / 3600.0 AS hours
        FROM "kyc_requests"
        WHERE "reviewedAt" >= ${fromDate}
          AND "reviewedAt" <= ${toDate}
          AND status IN ('APPROVED', 'REJECTED', 'REVOKED')
          AND "reviewedAt" >= COALESCE("sla_started_at", "createdAt")
      ) AS t
      GROUP BY status
    `;

    const reviewTimeHours: Record<string, unknown> = {};
    for (const r of metricRows) {
      reviewTimeHours[r.status] = {
        count: Number(r.count),
        p50: this.round2(r.p50),
        p95: this.round2(r.p95),
        avg: this.round2(r.avg),
        min: this.round2(r.min),
        max: this.round2(r.max),
      };
    }

    // Snapshot antrean saat ini (untuk runbook backlog).
    const now = new Date();
    const config = await getEffectiveSlaConfig(this.prisma, 'KYC_PERSONAL');
    const pending = await this.prisma.kycRequest.findMany({
      where: { status: 'PENDING' },
      select: {
        slaStartedAt: true,
        slaPausedAt: true,
        slaPausedAccumMs: true,
        slaBreachedAt: true,
        createdAt: true,
      },
      take: 2000,
    });
    let breached = 0;
    let warning = 0;
    let oldestMs = 0;
    for (const r of pending) {
      const track: SlaTrackable = {
        slaStartedAt: r.slaStartedAt ?? r.createdAt,
        slaPausedAt: r.slaPausedAt,
        slaPausedAccumMs: r.slaPausedAccumMs,
      };
      const st = slaStatus(track, now, config);
      if (st === 'BREACHED') breached += 1;
      else if (st === 'MENDEKATI') warning += 1;
      const elapsed = slaElapsedMs(track, now, config) ?? 0;
      if (elapsed > oldestMs) oldestMs = elapsed;
    }

    return {
      period: { from: fromDate.toISOString(), to: toDate.toISOString() },
      reviewTimeHours,
      queue: {
        pending: pending.length,
        breached,
        warning,
        oldestElapsedMs: Math.round(oldestMs),
        slaHours: config.slaHours,
        useBusinessHours: config.useBusinessHours,
      },
    };
  }

  private attentionRowSelect() {
    return {
      id: true,
      kycId: true,
      userId: true,
      status: true,
      attemptNumber: true,
      createdAt: true,
      slaStartedAt: true,
      slaPausedAt: true,
      slaPausedAccumMs: true,
      slaBreachedAt: true,
      assignedReviewerId: true,
      user: { select: { userId: true, email: true, fullName: true } },
    } as const;
  }

  /**
   * G295–G299: daftar "perlu perhatian" —
   * (1) SLA breached / mendekati, (2) dokumen gagal diunduh (dari jejak audit,
   * tanpa membuka key storage), (3) antrean re-check dokumen identitas tua.
   */
  async getAttention(): Promise<Record<string, unknown>> {
    const now = new Date();
    const config = await getEffectiveSlaConfig(this.prisma, 'KYC_PERSONAL');

    const breachedRows = await this.prisma.kycRequest.findMany({
      where: { status: 'PENDING', slaBreachedAt: { not: null } },
      select: this.attentionRowSelect(),
      orderBy: { slaBreachedAt: 'asc' },
      take: 100,
    });

    const pendingRows = await this.prisma.kycRequest.findMany({
      where: { status: 'PENDING', slaBreachedAt: null },
      select: this.attentionRowSelect(),
      orderBy: { createdAt: 'asc' },
      take: 500,
    });
    const warningRows = pendingRows
      .filter(r =>
        slaStatus(
          {
            slaStartedAt: r.slaStartedAt ?? r.createdAt,
            slaPausedAt: r.slaPausedAt,
            slaPausedAccumMs: r.slaPausedAccumMs,
          },
          now,
          config,
        ) === 'MENDEKATI',
      )
      .slice(0, 100);

    const reviewerIds = [
      ...new Set(
        [...breachedRows, ...warningRows]
          .map(r => r.assignedReviewerId)
          .filter((v): v is string => !!v),
      ),
    ];
    const reviewerMap = await this.getAdminNameMap(reviewerIds);
    const toRow = (r: (typeof breachedRows)[number]) => ({
      id: r.id,
      kycId: r.kycId,
      userId: r.userId,
      user: r.user,
      status: r.status,
      attemptNumber: r.attemptNumber,
      createdAt: r.createdAt,
      sla: this.buildSlaView(r, now, config),
      assignedReviewer: r.assignedReviewerId
        ? (reviewerMap.get(r.assignedReviewerId) ?? { adminId: r.assignedReviewerId, fullName: null })
        : null,
    });

    // (2) Dokumen gagal diunduh — dari marker audit [KYC-DOC-FAIL] 14 hari terakhir.
    const failSince = new Date(now.getTime() - 14 * 24 * 3_600_000);
    const failLogs = await this.prisma.adminAuditLog.findMany({
      where: {
        targetType: 'KYC_REQUEST',
        description: { startsWith: '[KYC-DOC-FAIL]' },
        createdAt: { gte: failSince },
      },
      select: { targetId: true, description: true, createdAt: true },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
    const seenTargets = new Set<string>();
    const failTargetIds: string[] = [];
    for (const log of failLogs) {
      if (log.targetId && !seenTargets.has(log.targetId)) {
        seenTargets.add(log.targetId);
        failTargetIds.push(log.targetId);
      }
    }
    let docFailures: Record<string, unknown>[] = [];
    if (failTargetIds.length > 0) {
      const failRequests = await this.prisma.kycRequest.findMany({
        where: {
          status: 'PENDING',
          OR: [{ id: { in: failTargetIds } }, { kycId: { in: failTargetIds } }],
        },
        select: this.attentionRowSelect(),
        take: 100,
      });
      const lastErrorByTarget = new Map<string, { at: Date; errors: string }>();
      for (const log of failLogs) {
        if (log.targetId && !lastErrorByTarget.has(log.targetId)) {
          lastErrorByTarget.set(log.targetId, {
            at: log.createdAt,
            errors: (log.description ?? '').replace(/^\[KYC-DOC-FAIL\]\s*\S+:\s*/, ''),
          });
        }
      }
      docFailures = failRequests.map(r => ({
        ...toRow(r),
        lastFailureAt: lastErrorByTarget.get(r.id)?.at ?? lastErrorByTarget.get(r.kycId)?.at ?? null,
        lastErrors:
          lastErrorByTarget.get(r.id)?.errors ?? lastErrorByTarget.get(r.kycId)?.errors ?? null,
      }));
    }

    // (3) Antrean re-check: pengajuan PENDING dengan dokumen identitas tua (>30 hari).
    const recheckCutoff = new Date(now.getTime() - 30 * 24 * 3_600_000);
    const recheckRows = await this.prisma.kycRequest.findMany({
      where: { status: 'PENDING', createdAt: { lt: recheckCutoff } },
      select: this.attentionRowSelect(),
      orderBy: { createdAt: 'asc' },
      take: 50,
    });
    const recheckReviewerIds = [
      ...new Set(recheckRows.map(r => r.assignedReviewerId).filter((v): v is string => !!v)),
    ];
    const recheckReviewerMap = await this.getAdminNameMap(recheckReviewerIds);

    return {
      generatedAt: now.toISOString(),
      sla: {
        breached: breachedRows.map(toRow),
        warning: warningRows.map(toRow),
      },
      docFailures,
      recheckQueue: recheckRows.map(r => ({
        ...toRow(r),
        ageDays: Math.floor((now.getTime() - r.createdAt.getTime()) / (24 * 3_600_000)),
        assignedReviewer: r.assignedReviewerId
          ? (recheckReviewerMap.get(r.assignedReviewerId) ?? {
              adminId: r.assignedReviewerId,
              fullName: null,
            })
          : null,
      })),
      recheckThresholdDays: 30,
    };
  }
}
