import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  ConflictException,
  ForbiddenException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { AuditLogService } from '../../../common/services/audit-log.service';
import { createPaginatedResponse } from '../../../common/dto/pagination.dto';
import { AuditAction, Prisma, ReportStatus, NotificationType, UserAuditAction, AdminRole } from '@prisma/client';
import * as ErrorCodes from '../../../common/constants/error-codes';
import { generateNotifId } from '../../../common/utils/id-generator.util';
import { mapWithConcurrency } from '../../../common/utils/bounded-concurrency.util';
import { getCategoryForType } from '../../notifications/notification-category.map';
import { ShowcaseReportAction } from './dto/review-showcase-report.dto';
import { AppealDecision } from './dto/decide-appeal.dto';
import { UploadService } from '../../upload/upload.service';
import {
  moderationDb,
  ModerationPrisma,
  ModerationEventActionValue,
  ModerationReasonCodeValue,
} from './moderation-prisma.types';
import {
  REPORT_STATUS_TRANSITIONS,
  MOD_FINAL_STATUSES,
  MOD_OPEN_STATUSES,
  REOPEN_REASON_MIN_LENGTH,
  APPEAL_REASON_MIN_LENGTH,
  APPEAL_REASON_MAX_LENGTH,
  APPEAL_DECISION_NOTE_MIN_LENGTH,
  REVIEWER_CONFLICT_WINDOW_DAYS,
  CLUSTER_WINDOW_HOURS,
  computeRiskScore,
  riskTier,
  slaHoursForScore,
  toReasonCode,
  EXPORT_MAX_ROWS,
  EXPORT_DESCRIPTION_TRUNCATE,
  FINAL_DECISION_EVENT_ACTIONS,
  NOTIF_MODERATION_REPORT_UPDATE,
  NOTIF_MODERATION_ITEM_TAKEDOWN,
  NOTIF_MODERATION_APPEAL_DECIDED,
} from './moderation-lifecycle.constants';

const MAX_ADMIN_PAGE = 100_000;

/**
 * SH-A-003: bentuk item admin yang dipakai di endpoint moderasi etalase.
 * SAMA PERSIS dengan select `showcase` di getShowcaseReportDetail — endpoint
 * restore-takedown mengembalikan item dalam bentuk ini agar konsisten dengan
 * GET detail existing.
 */
const ADMIN_MODERATION_ITEM_SELECT = {
  id: true,
  title: true,
  description: true,
  category: true,
  isActive: true,
  visibility: true,
  priceMin: true,
  priceMax: true,
  likeCount: true,
  commentCount: true,
  createdAt: true,
  images: {
    select: { id: true, imageUrl: true, sortOrder: true },
    orderBy: { sortOrder: 'asc' },
  },
  user: {
    select: { id: true, username: true, fullName: true, avatarUrl: true },
  },
} as const;

/** Status final: aksi moderasi ditolak (idempotency guard). */
const FINAL_STATUSES: ReportStatus[] = MOD_FINAL_STATUSES;

/** Status non-final: masih boleh diproses ulang oleh admin lain. */
const OPEN_STATUSES: ReportStatus[] = MOD_OPEN_STATUSES;

interface TransitionOpts {
  adminId: string;
  ipAddress: string;
  eventAction: ModerationEventActionValue;
  resolution?: string;
  reasonCode?: ModerationReasonCodeValue;
  note?: string;
  metadata?: Record<string, unknown>;
  auditDescription?: string;
}

@Injectable()
export class AdminShowcaseReportsService {
  private readonly logger = new Logger(AdminShowcaseReportsService.name);
  private readonly mod: PrismaService & ModerationPrisma;

  constructor(
    private prisma: PrismaService,
    private auditLog: AuditLogService,
    private uploadService: UploadService,
  ) {
    // Cast terkontrol ke delegate model moderasi baru (lihat moderation-prisma.types.ts).
    this.mod = moderationDb(prisma);
  }

  // -------------------------------------------------------------------------
  // G424 — state machine eksplisit. SEMUA perubahan status laporan lewat sini.
  // OCC guard: updateMany hanya menang bila status masih `from` (G425: dua
  // admin review bersamaan → satu menang, satunya dapat REPORT_ALREADY_RESOLVED).
  // -------------------------------------------------------------------------
  async transition(
    reportId: string,
    from: ReportStatus,
    to: ReportStatus,
    opts: TransitionOpts,
  ): Promise<ReportStatus> {
    const allowed = REPORT_STATUS_TRANSITIONS[from] ?? [];
    if (!allowed.includes(to)) {
      throw new BadRequestException({
        code: ErrorCodes.REPORT_INVALID_TRANSITION,
        message: `Transisi status laporan ${from} → ${to} tidak diizinkan`,
      });
    }
    const now = new Date();
    const updated = await this.prisma.showcaseReport.updateMany({
      where: { id: reportId, status: from },
      data: {
        status: to,
        resolution: opts.resolution,
        reviewedBy: opts.adminId,
        reviewedAt: now,
      },
    });
    if (updated.count !== 1) {
      throw new BadRequestException({
        code: ErrorCodes.REPORT_ALREADY_RESOLVED,
        message: 'Report state changed; reload and try again',
      });
    }
    await this.recordEvent({
      reportId,
      actorAdminId: opts.adminId,
      action: opts.eventAction,
      stateFrom: from,
      stateTo: to,
      reasonCode: opts.reasonCode,
      note: opts.note,
      metadata: opts.metadata,
    });
    this.logAction(
      opts.adminId,
      reportId,
      opts.auditDescription ?? `Showcase report ${reportId}: ${from} → ${to}`,
      opts.ipAddress,
    );
    return to;
  }

  /**
   * G403 — tulis satu baris ReportModerationEvent (append-only).
   * Best-effort dengan warn log: aksi moderasi tidak boleh gagal hanya karena
   * tabel event belum tersedia (fragment schema belum di-merge).
   */
  private async recordEvent(input: {
    reportId: string;
    actorAdminId?: string | null;
    action: ModerationEventActionValue;
    stateFrom?: ReportStatus | null;
    stateTo?: ReportStatus | null;
    reasonCode?: ModerationReasonCodeValue | string | null;
    note?: string | null;
    metadata?: Record<string, unknown> | null;
  }): Promise<void> {
    try {
      await this.mod.reportModerationEvent.create({
        data: {
          reportId: input.reportId,
          actorAdminId: input.actorAdminId ?? null,
          action: input.action,
          stateFrom: input.stateFrom ?? null,
          stateTo: input.stateTo ?? null,
          reasonCode: (input.reasonCode as ModerationReasonCodeValue) ?? null,
          note: input.note ?? null,
          metadata: input.metadata ?? undefined,
        },
      });
    } catch (err) {
      this.logger.warn(
        `recordEvent(${input.action}) for report ${input.reportId} failed (best-effort): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /** Helper: baca model moderasi baru dengan degradasi aman bila tabel belum ada. */
  private async safeRead<T>(promise: Promise<T>, fallback: T, label: string): Promise<T> {
    try {
      return await promise;
    } catch (err) {
      this.logger.warn(
        `moderation read ${label} failed (returning fallback): ${err instanceof Error ? err.message : String(err)}`,
      );
      return fallback;
    }
  }

  // -------------------------------------------------------------------------
  // G409 — snapshot JSON kondisi item saat keputusan final pertama.
  // -------------------------------------------------------------------------
  private async captureItemSnapshot(
    showcaseId: string,
    adminId: string,
  ): Promise<Record<string, unknown>> {
    const item = await this.prisma.userShowcase.findUnique({
      where: { id: showcaseId },
      select: {
        id: true,
        title: true,
        isActive: true,
        visibility: true,
        category: true,
        priceMin: true,
        priceMax: true,
        userId: true,
        user: { select: { id: true, username: true } },
        images: {
          select: { imageUrl: true },
          orderBy: { sortOrder: 'asc' },
        },
      },
    });
    const capturedAt = new Date().toISOString();
    if (!item) {
      return { showcaseId, missing: true, capturedAt, capturedBy: adminId };
    }
    return {
      showcaseId: item.id,
      title: item.title,
      imageUrls: item.images.map((i) => i.imageUrl),
      isActive: item.isActive,
      visibility: item.visibility,
      category: item.category,
      priceMin: item.priceMin?.toString() ?? null,
      priceMax: item.priceMax?.toString() ?? null,
      ownerId: item.userId,
      ownerUsername: item.user?.username ?? null,
      capturedAt,
      capturedBy: adminId,
    };
  }

  // -------------------------------------------------------------------------
  // G416/G417 — notifikasi privasi-aware via pola yang sama dipakai modul lain
  // (prisma.notification.create + emitNotificationCreated, silent-catch).
  // -------------------------------------------------------------------------
  private notifyUser(input: {
    userId: string;
    type: string;
    title: string;
    body: string;
    refType: string;
    refId: string;
    metadata?: Record<string, unknown>;
  }): void {
    const notifType = input.type as unknown as NotificationType;
    this.prisma.notification
      .create({
        data: {
          notifId: generateNotifId(),
          userId: input.userId,
          type: notifType,
          category: getCategoryForType(notifType),
          title: input.title,
          body: input.body,
          refType: input.refType,
          refId: input.refId,
          metadata: (input.metadata as Prisma.InputJsonValue) ?? undefined,
        },
      })
      .catch((err: unknown) =>
        this.logger.warn(
          `moderation notification to ${input.userId} failed: ${err instanceof Error ? err.message : String(err)}`,
        ),
      );
    try {
      this.prisma.emitNotificationCreated({
        userId: input.userId,
        title: input.title,
        body: input.body,
        data: { type: input.type, refId: input.refId },
      });
    } catch {
      /* best-effort */
    }
  }

  /** G416 — kabari pelapor saat status laporannya berubah; TANPA identitas pemilik. */
  private notifyReporterStatusChange(reporterId: string, itemTitle: string, outcome: string): void {
    this.notifyUser({
      userId: reporterId,
      type: NOTIF_MODERATION_REPORT_UPDATE,
      title: 'Update laporan etalase Anda',
      body: `Laporan Anda terhadap item "${itemTitle}" telah ditinjau: ${outcome}. Terima kasih atas partisipasinya menjaga keamanan Kahade.`,
      refType: 'ShowcaseReport',
      refId: reporterId,
    });
  }

  /** G417 — kabari pemilik item saat takedown/restrict + cara banding. */
  private notifyOwnerItemAction(
    ownerId: string,
    itemTitle: string,
    temporary: boolean,
    restoreInfo: string,
  ): void {
    this.notifyUser({
      userId: ownerId,
      type: NOTIF_MODERATION_ITEM_TAKEDOWN,
      title: temporary ? 'Item etalase Anda dibatasi sementara' : 'Item etalase Anda dinonaktifkan',
      body: temporary
        ? `Item "${itemTitle}" disembunyikan sementara karena melanggar kebijakan Kahade. ${restoreInfo} Anda dapat mengajukan banding melalui aplikasi Kahade.`
        : `Item "${itemTitle}" dinonaktifkan karena melanggar kebijakan Kahade. Anda dapat mengajukan banding melalui aplikasi Kahade bila keberatan dengan keputusan ini.`,
      refType: 'UserShowcase',
      refId: ownerId,
    });
  }

  // -------------------------------------------------------------------------
  // Query existing (dipertahankan) + G420 (histori event di detail).
  // -------------------------------------------------------------------------
  async listShowcaseReports(page: number, limit: number, status?: string): Promise<object> {
    const safeLimit = Math.min(limit, 100);
    const safePage = Math.min(Math.max(page, 1), MAX_ADMIN_PAGE);
    const skip = (safePage - 1) * safeLimit;

    const where: Prisma.ShowcaseReportWhereInput = {};
    if (status) {
      const validStatuses = Object.values(ReportStatus);
      if (!validStatuses.includes(status as ReportStatus)) {
        throw new BadRequestException({
          code: ErrorCodes.INVALID_STATUS,
          message: `Invalid showcase report status: ${status}. Valid values: ${validStatuses.join(', ')}`,
        });
      }
      where.status = status as Prisma.EnumReportStatusFilter;
    }

    const [reports, total] = await Promise.all([
      this.prisma.showcaseReport.findMany({
        where,
        skip,
        take: safeLimit,
        orderBy: { createdAt: 'desc' },
        include: {
          showcase: {
            select: {
              id: true,
              title: true,
              isActive: true,
              images: {
                select: { imageUrl: true },
                orderBy: { sortOrder: 'asc' },
                take: 1,
              },
              user: {
                select: { id: true, username: true, fullName: true },
              },
            },
          },
          reporter: {
            select: { id: true, username: true, fullName: true },
          },
        },
      }),
      this.prisma.showcaseReport.count({ where }),
    ]);

    return createPaginatedResponse(reports, total, safePage, safeLimit);
  }

  async getShowcaseReportDetail(reportId: string): Promise<object> {
    const report = await this.prisma.showcaseReport.findUnique({
      where: { id: reportId },
      include: {
        // SH-A-003: select dishare via ADMIN_MODERATION_ITEM_SELECT.
        showcase: {
          select: ADMIN_MODERATION_ITEM_SELECT,
        },
        reporter: {
          select: { id: true, username: true, fullName: true, avatarUrl: true },
        },
      },
    });

    if (!report) {
      throw new NotFoundException({
        code: ErrorCodes.REPORT_NOT_FOUND,
        message: 'Showcase report not found',
      });
    }

    // reviewedBy = soft FK ke admin_users.id (bukan relasi Prisma) → lookup manual.
    let reviewedByAdmin: { id: string; fullName: string | null; email: string } | null = null;
    if (report.reviewedBy) {
      reviewedByAdmin = await this.prisma.adminUser.findUnique({
        where: { id: report.reviewedBy },
        select: { id: true, fullName: true, email: true },
      });
    }

    // G420 — histori semua aksi moderasi tampil di halaman detail final.
    const [moderationEvents, activeAssignment, appeals] = await Promise.all([
      this.safeRead(
        this.mod.reportModerationEvent.findMany({
          where: { reportId },
          orderBy: { createdAt: 'asc' },
          take: 500,
        }),
        [],
        'detail-events',
      ),
      this.safeRead(
        this.mod.reportAssignment.findFirst({
          where: { reportId, unassignedAt: null },
          orderBy: { assignedAt: 'desc' },
        }),
        null,
        'detail-assignment',
      ),
      this.safeRead(
        this.mod.reportAppeal.findMany({
          where: { reportId },
          orderBy: { createdAt: 'desc' },
        }),
        [],
        'detail-appeals',
      ),
    ]);

    // Resolve nama admin untuk tiap event (satu query).
    const actorIds = [...new Set(moderationEvents.map((e) => e.actorAdminId).filter(Boolean))] as string[];
    const actors =
      actorIds.length > 0
        ? await this.prisma.adminUser.findMany({
            where: { id: { in: actorIds } },
            select: { id: true, fullName: true },
          })
        : [];
    const actorName = new Map(actors.map((a) => [a.id, a.fullName ?? a.id]));
    const eventsWithActor = moderationEvents.map((e) => ({
      ...e,
      actorAdminName: e.actorAdminId ? (actorName.get(e.actorAdminId) ?? e.actorAdminId) : 'Sistem',
    }));

    return { ...report, reviewedByAdmin, moderationEvents: eventsWithActor, activeAssignment, appeals };
  }

  // -------------------------------------------------------------------------
  // Review awal (dipertahankan) — kini lewat transition() + event + snapshot.
  // ADM-302: takedown permanen = SUPER_ADMIN only (server-side). Guard
  // class-level membolehkan CUSTOMER_SUPPORT untuk aksi lain; aksi takedown
  // dicek eksplisit di sini karena `action` ada di body (bukan di route).
  // ADM-320: catatan resolusi wajib (min. 10 karakter) khusus takedown.
  // -------------------------------------------------------------------------
  async reviewShowcaseReport(
    reportId: string,
    action: ShowcaseReportAction,
    resolution: string | undefined,
    adminId: string,
    ipAddress: string,
    adminRole?: AdminRole,
  ): Promise<{ message: string; reportId: string; status: ReportStatus }> {
    if (action === 'takedown' && adminRole !== AdminRole.SUPER_ADMIN) {
      throw new ForbiddenException({
        code: 'TAKEDOWN_FORBIDDEN_ROLE',
        message: 'Takedown permanen hanya untuk SUPER_ADMIN',
      });
    }
    const trimmedResolutionForTakedown = action === 'takedown' ? (resolution?.trim() ?? '') : undefined;
    if (action === 'takedown' && trimmedResolutionForTakedown!.length < 10) {
      throw new BadRequestException({
        code: 'RESOLUTION_REQUIRED_TAKEDOWN',
        message: 'Catatan resolusi takedown wajib diisi (minimal 10 karakter)',
      });
    }
    const report = await this.prisma.showcaseReport.findUnique({
      where: { id: reportId },
      include: { showcase: { select: { id: true, title: true, isActive: true, userId: true } } },
    });

    if (!report) {
      throw new NotFoundException({
        code: ErrorCodes.REPORT_NOT_FOUND,
        message: 'Showcase report not found',
      });
    }

    // Idempotency: status final tidak boleh diproses ulang (bukan 500 — 400 jelas).
    if (FINAL_STATUSES.includes(report.status)) {
      throw new BadRequestException({
        code: ErrorCodes.REPORT_ALREADY_RESOLVED,
        message: `Showcase report has already been ${this.describeStatus(report.status)}`,
      });
    }

    const trimmedResolution = resolution?.trim() || undefined;
    const reasonCode = toReasonCode(report.reason);
    const now = new Date();

    switch (action) {
      case 'under_review': {
        if (report.status === ReportStatus.UNDER_REVIEW) {
          // No-op yang aman untuk retry — kembalikan status saat ini.
          return { message: 'Showcase report already under review', reportId, status: report.status };
        }
        await this.transition(reportId, report.status, ReportStatus.UNDER_REVIEW, {
          adminId,
          ipAddress,
          eventAction: 'UNDER_REVIEW',
          resolution: trimmedResolution,
          reasonCode,
          note: trimmedResolution,
          auditDescription: `Marked showcase report ${reportId} as under review`,
        });
        return { message: 'Showcase report marked as under review', reportId, status: ReportStatus.UNDER_REVIEW };
      }
      case 'dismiss': {
        const snapshot = await this.captureItemSnapshot(report.showcaseId, adminId);
        await this.transition(reportId, report.status, ReportStatus.DISMISSED, {
          adminId,
          ipAddress,
          eventAction: 'DISMISSED',
          resolution: trimmedResolution,
          reasonCode,
          note: trimmedResolution,
          metadata: { snapshot },
          auditDescription: `Dismissed showcase report ${reportId}${trimmedResolution ? `: ${trimmedResolution}` : ''}`,
        });
        this.notifyReporterStatusChange(report.reporterId, report.showcase.title, 'ditolak');
        return { message: 'Showcase report dismissed', reportId, status: ReportStatus.DISMISSED };
      }
      case 'no_action': {
        const snapshot = await this.captureItemSnapshot(report.showcaseId, adminId);
        await this.transition(reportId, report.status, ReportStatus.RESOLVED_NO_ACTION, {
          adminId,
          ipAddress,
          eventAction: 'NO_ACTION',
          resolution: trimmedResolution,
          reasonCode,
          note: trimmedResolution,
          metadata: { snapshot },
          auditDescription: `Resolved showcase report ${reportId} with no action${trimmedResolution ? `: ${trimmedResolution}` : ''}`,
        });
        this.notifyReporterStatusChange(report.reporterId, report.showcase.title, 'diselesaikan tanpa tindakan');
        return { message: 'Showcase report resolved with no action', reportId, status: ReportStatus.RESOLVED_NO_ACTION };
      }
      case 'takedown': {
        // Takedown hanya bila item masih aktif.
        if (!report.showcase.isActive) {
          throw new BadRequestException({
            code: ErrorCodes.SHOWCASE_ALREADY_INACTIVE,
            message: 'Showcase item is already inactive; cannot takedown again',
          });
        }
        const snapshot = await this.captureItemSnapshot(report.showcaseId, adminId);
        await this.prisma.$transaction([
          this.prisma.userShowcase.updateMany({
            where: { id: report.showcaseId, isActive: true },
            data: { isActive: false },
          }),
          this.prisma.showcaseReport.updateMany({
            where: { id: reportId, status: { in: OPEN_STATUSES } },
            data: {
              status: ReportStatus.RESOLVED_ACTION_TAKEN,
              resolution: trimmedResolution,
              reviewedBy: adminId,
              reviewedAt: now,
            },
          }),
        ]);
        const reloaded = await this.prisma.showcaseReport.findUnique({
          where: { id: reportId },
          select: { status: true },
        });
        if (reloaded?.status !== ReportStatus.RESOLVED_ACTION_TAKEN) {
          throw new BadRequestException({
            code: ErrorCodes.REPORT_ALREADY_RESOLVED,
            message: 'Report state changed; reload and try again',
          });
        }
        await this.recordEvent({
          reportId,
          actorAdminId: adminId,
          action: 'TAKEDOWN',
          stateFrom: report.status,
          stateTo: ReportStatus.RESOLVED_ACTION_TAKEN,
          reasonCode,
          note: trimmedResolution,
          metadata: { snapshot },
        });
        this.logAction(
          adminId,
          reportId,
          `Took down showcase item ${report.showcaseId} ("${report.showcase.title}") via report ${reportId}${trimmedResolution ? `: ${trimmedResolution}` : ''}`,
          ipAddress,
        );
        this.notifyReporterStatusChange(report.reporterId, report.showcase.title, 'ditindaklanjuti (item dinonaktifkan)');
        this.notifyOwnerItemAction(report.showcase.userId, report.showcase.title, false, '');
        return { message: 'Showcase item taken down; report resolved', reportId, status: ReportStatus.RESOLVED_ACTION_TAKEN };
      }
      default: {
        throw new BadRequestException({
          code: ErrorCodes.INVALID_STATUS,
          message: `Invalid action: ${action}. Valid values: dismiss, takedown, no_action, under_review`,
        });
      }
    }
  }

  // -------------------------------------------------------------------------
  // ADM-328 — bulk dismiss / under_review (maks 50, confirm wajib, hasil
  // parsial). Hanya dua aksi non-destruktif; takedown tidak boleh bulk
  // (fail-closed). Setiap item lewat jalur reviewShowcaseReport yang sama
  // (state machine + event + audit + notifikasi).
  // -------------------------------------------------------------------------
  async bulkReviewShowcaseReports(
    adminId: string,
    ipAddress: string,
    adminRole: AdminRole | undefined,
    ids: string[],
    action: 'dismiss' | 'under_review',
    resolution: string | undefined,
    confirm: boolean,
  ): Promise<object> {
    if (confirm !== true) {
      throw new BadRequestException({
        code: 'BULK_CONFIRM_REQUIRED',
        message: 'Bulk review membutuhkan konfirmasi eksplisit (confirm: true)',
      });
    }
    const uniqueIds = [...new Set(ids)].slice(0, 50);
    // B1-009 (perf): bulk review diparalel bounded (8 worker); hasil per item
    // tetap terkumpul dalam urutan input. Semantik per item identik.
    const settled = await mapWithConcurrency(
      uniqueIds,
      8,
      (id) => this.reviewShowcaseReport(id, action, resolution, adminId, ipAddress, adminRole),
    );
    const results: Array<{ id: string; ok: boolean; status?: string; error?: string }> =
      settled.map((s, i) =>
        s.ok && s.value
          ? { id: uniqueIds[i], ok: true, status: s.value.status }
          : { id: uniqueIds[i], ok: false, error: s.error instanceof Error ? s.error.message : String(s.error) },
      );
    return {
      action,
      total: uniqueIds.length,
      succeeded: results.filter((r) => r.ok).length,
      failed: results.filter((r) => !r.ok).length,
      results,
    };
  }

  // -------------------------------------------------------------------------
  // ADM-324 — daftar admin aktif untuk picker assign + jumlah antrean.
  // -------------------------------------------------------------------------
  /**
   * Kandidat assignee: admin aktif (isActive, tidak dihapus) berrole
   * SUPER_ADMIN / CUSTOMER_SUPPORT, beserta jumlah assignment terbuka
   * (unassignedAt IS NULL). Untuk picker assign di UI antrean prioritas.
   */
  async getAssignCandidates(): Promise<object> {
    const rows = await this.prisma.$queryRaw<
      Array<{ id: string; full_name: string; role: string; open_assignments: bigint }>
    >(
      Prisma.sql`SELECT a.id, a."fullName" AS full_name, a.role::text AS role,
                        COUNT(ra.id)::bigint AS open_assignments
                 FROM "AdminUser" a
                 LEFT JOIN report_assignments ra
                   ON ra."assigneeAdminId" = a.id AND ra."unassignedAt" IS NULL
                 WHERE a.role::text IN ('SUPER_ADMIN', 'CUSTOMER_SUPPORT')
                   AND a."isActive" = true
                   AND a."deletedAt" IS NULL
                 GROUP BY a.id
                 ORDER BY open_assignments ASC, a."fullName" ASC`,
    );
    return {
      candidates: rows.map((r) => ({
        id: r.id,
        fullName: r.full_name,
        role: r.role,
        openAssignments: Number(r.open_assignments),
      })),
    };
  }

  // -------------------------------------------------------------------------
  // SH-A-003 — restore item yang pernah di-takedown moderasi.
  // Kontrak: POST /v1/admin/showcase-reports/items/:id/restore-takedown
  // (SUPER_ADMIN only di controller). Audit-logged, set isActive=true,
  // catat moderation event RESTORED, response 200 { ok: true, item } dengan
  // bentuk item SAMA dengan GET detail existing (ADMIN_MODERATION_ITEM_SELECT).
  //
  // Guard penting: HANYA item yang terbukti pernah di-takedown moderasi
  // (ada event TAKEDOWN pada laporannya) yang boleh di-restore. Item yang
  // dinonaktifkan sendiri oleh owner → SHOWCASE_NOT_TAKEN_DOWN (fail-closed:
  // endpoint ini bukan jalan pintas "aktifkan item").
  // -------------------------------------------------------------------------
  async restoreTakedownItem(
    adminId: string,
    itemId: string,
    ipAddress: string,
  ): Promise<{ ok: true; item: object }> {
    const item = await this.prisma.userShowcase.findUnique({
      where: { id: itemId },
      select: { id: true, title: true, isActive: true, deletedAt: true, userId: true },
    });
    if (!item) {
      throw new NotFoundException({
        code: ErrorCodes.SHOWCASE_NOT_FOUND,
        message: 'Showcase item not found',
      });
    }
    if (item.deletedAt) {
      throw new BadRequestException({
        code: ErrorCodes.SHOWCASE_NOT_FOUND,
        message: 'Showcase item is deleted; its owner must restore it before takedown restore',
      });
    }
    if (item.isActive) {
      throw new BadRequestException({
        code: ErrorCodes.SHOWCASE_ALREADY_ACTIVE,
        message: 'Showcase item is already active; nothing to restore',
      });
    }

    // Bukti takedown moderasi: event TAKEDOWN terbaru pada laporan item ini.
    // Tanpa ini → kemungkinan besar item dinonaktifkan owner sendiri.
    // SH-A-003 (proof hardening): TAKEDOWN lama yang SUDAH di-restore tidak
    // boleh dipakai ulang. Skenario berbahaya: takedown → restore → owner
    // menonaktifkan item sendiri → admin memakai event TAKEDOWN lama untuk
    // mengaktifkan lagi (jalan pintas). Karena itu, TAKEDOWN terbaru harus
    // BELUM memiliki RESTORED setelahnya (fail-closed).
    const takedownEvent = await this.safeRead(
      this.mod.reportModerationEvent.findFirst({
        where: { action: 'TAKEDOWN', report: { showcaseId: itemId } },
        orderBy: { createdAt: 'desc' },
        select: { id: true, reportId: true, createdAt: true },
      }),
      null,
      'restore-takedown-event-check',
    );
    if (!takedownEvent) {
      throw new BadRequestException({
        code: ErrorCodes.SHOWCASE_NOT_TAKEN_DOWN,
        message: 'Item was not taken down by moderation (it may have been deactivated by its owner); restore-takedown is not allowed',
      });
    }
    const restoredAfterTakedown = await this.safeRead(
      this.mod.reportModerationEvent.findFirst({
        where: {
          action: 'RESTORED',
          report: { showcaseId: itemId },
          createdAt: { gt: takedownEvent.createdAt },
        },
        orderBy: { createdAt: 'desc' },
        select: { id: true },
      }),
      null,
      'restore-takedown-restored-check',
    );
    if (restoredAfterTakedown) {
      throw new BadRequestException({
        code: ErrorCodes.SHOWCASE_NOT_TAKEN_DOWN,
        message: 'The latest takedown of this item was already restored; a newer takedown by moderation is required before restore-takedown',
      });
    }

    // SH-A-003 (atomicity): isActive=true + event RESTORED ditulis dalam SATU
    // transaksi — event RESTORED wajib tercatat (bukan best-effort). Bila
    // transaksi gagal, item tetap nonaktif dan tidak ada event setengah jadi.
    await this.prisma.$transaction(async (tx) => {
      await tx.userShowcase.update({
        where: { id: itemId },
        data: { isActive: true },
      });
      await (tx as unknown as PrismaService & ModerationPrisma).reportModerationEvent.create({
        data: {
          reportId: takedownEvent.reportId,
          actorAdminId: adminId,
          action: 'RESTORED',
          stateFrom: null,
          stateTo: null,
          reasonCode: null,
          note: `Takedown restored by SUPER_ADMIN ${adminId}`,
          metadata: { takedownEventId: takedownEvent.id, showcaseId: itemId },
        },
      });
    });

    this.logAction(
      adminId,
      takedownEvent.reportId,
      `Restored takedown of showcase item ${itemId} ("${item.title}") via report ${takedownEvent.reportId}`,
      ipAddress,
    );

    const restored = await this.prisma.userShowcase.findUnique({
      where: { id: itemId },
      select: ADMIN_MODERATION_ITEM_SELECT,
    });
    return { ok: true, item: restored ?? {} };
  }

  // -------------------------------------------------------------------------
  // G401 — reopen laporan final. Hanya dari status final, alasan wajib,
  // role dibatasi SUPER_ADMIN di controller (guard → 403 untuk CUSTOMER_SUPPORT).
  // -------------------------------------------------------------------------
  async reopenReport(
    reportId: string,
    reason: string,
    reasonCode: ModerationReasonCodeValue | undefined,
    adminId: string,
    ipAddress: string,
  ): Promise<{ message: string; reportId: string; status: ReportStatus }> {
    const report = await this.prisma.showcaseReport.findUnique({
      where: { id: reportId },
      select: { id: true, status: true, reporterId: true, showcaseId: true },
    });
    if (!report) {
      throw new NotFoundException({
        code: ErrorCodes.REPORT_NOT_FOUND,
        message: 'Showcase report not found',
      });
    }
    if (!FINAL_STATUSES.includes(report.status)) {
      throw new BadRequestException({
        code: ErrorCodes.REPORT_NOT_FINAL,
        message: `Hanya laporan berstatus final yang bisa dibuka kembali (status saat ini: ${report.status})`,
      });
    }
    const trimmed = reason?.trim() ?? '';
    if (trimmed.length < REOPEN_REASON_MIN_LENGTH) {
      throw new BadRequestException({
        code: ErrorCodes.REPORT_REOPEN_REASON_REQUIRED,
        message: `Alasan pembukaan kembali wajib diisi (min. ${REOPEN_REASON_MIN_LENGTH} karakter)`,
      });
    }
    const item = await this.prisma.userShowcase.findUnique({
      where: { id: report.showcaseId },
      select: { title: true },
    });
    await this.transition(reportId, report.status, ReportStatus.UNDER_REVIEW, {
      adminId,
      ipAddress,
      eventAction: 'REOPENED',
      reasonCode: reasonCode ?? toReasonCode(null),
      note: trimmed,
      auditDescription: `Reopened showcase report ${reportId} (${report.status} → UNDER_REVIEW): ${trimmed}`,
    });
    this.notifyReporterStatusChange(
      report.reporterId,
      item?.title ?? report.showcaseId,
      'dibuka kembali untuk peninjauan ulang',
    );
    return { message: 'Showcase report reopened for review', reportId, status: ReportStatus.UNDER_REVIEW };
  }

  // -------------------------------------------------------------------------
  // G402 — append catatan moderasi tanpa menimpa resolution awal.
  // -------------------------------------------------------------------------
  async addModerationNote(
    reportId: string,
    note: string,
    adminId: string,
    ipAddress: string,
  ): Promise<{ message: string; reportId: string }> {
    const report = await this.prisma.showcaseReport.findUnique({
      where: { id: reportId },
      select: { id: true },
    });
    if (!report) {
      throw new NotFoundException({
        code: ErrorCodes.REPORT_NOT_FOUND,
        message: 'Showcase report not found',
      });
    }
    const trimmed = note?.trim() ?? '';
    if (trimmed.length < 1) {
      throw new BadRequestException({
        code: ErrorCodes.MODERATION_NOTE_TOO_SHORT,
        message: 'Catatan moderasi tidak boleh kosong',
      });
    }
    await this.recordEvent({
      reportId,
      actorAdminId: adminId,
      action: 'NOTE_ADDED',
      note: trimmed,
    });
    this.logAction(adminId, reportId, `Added moderation note to showcase report ${reportId}`, ipAddress);
    return { message: 'Moderation note added', reportId };
  }

  // -------------------------------------------------------------------------
  // G411 — assignment + skor risiko → antrean prioritas. G419 — slaDueAt.
  // -------------------------------------------------------------------------
  private async computeReportRisk(reportId: string, showcaseId: string, reason: string, reasonCode?: ModerationReasonCodeValue) {
    const [totalReports, reporterRows] = await Promise.all([
      this.prisma.showcaseReport.count({ where: { showcaseId } }),
      this.prisma.showcaseReport.findMany({
        where: { showcaseId },
        select: { reporterId: true },
        distinct: ['reporterId'],
      }),
    ]);
    const code = reasonCode ?? toReasonCode(reason);
    const score = computeRiskScore(totalReports, reporterRows.length, code);
    return { score, tier: riskTier(score), reasonCode: code, totalReports, uniqueReporters: reporterRows.length };
  }

  async assignReport(
    reportId: string,
    assigneeAdminId: string | undefined,
    reasonCode: ModerationReasonCodeValue | undefined,
    adminId: string,
    ipAddress: string,
  ): Promise<object> {
    const report = await this.prisma.showcaseReport.findUnique({
      where: { id: reportId },
      select: { id: true, status: true, showcaseId: true, reason: true },
    });
    if (!report) {
      throw new NotFoundException({
        code: ErrorCodes.REPORT_NOT_FOUND,
        message: 'Showcase report not found',
      });
    }
    if (!OPEN_STATUSES.includes(report.status)) {
      throw new BadRequestException({
        code: ErrorCodes.REPORT_INVALID_TRANSITION,
        message: 'Hanya laporan terbuka (PENDING/UNDER_REVIEW) yang bisa di-assign',
      });
    }

    const risk = await this.computeReportRisk(reportId, report.showcaseId, report.reason, reasonCode);

    // Tentukan assignee: eksplisit atau auto (beban antrean tersedikit).
    let assignee = assigneeAdminId;
    if (assignee) {
      const exists = await this.prisma.adminUser.findUnique({
        where: { id: assignee },
        select: { id: true },
      });
      if (!exists) {
        throw new BadRequestException({
          code: ErrorCodes.VALIDATION_ERROR,
          message: `Admin ${assignee} tidak ditemukan`,
        });
      }
    } else {
      const candidates = await this.prisma.adminUser.findMany({
        where: { role: { in: ['SUPER_ADMIN', 'CUSTOMER_SUPPORT'] } },
        select: { id: true },
      });
      if (candidates.length === 0) {
        throw new BadRequestException({
          code: ErrorCodes.VALIDATION_ERROR,
          message: 'Tidak ada admin yang bisa di-assign',
        });
      }
      const loads = await Promise.all(
        candidates.map(async (c) => ({
          id: c.id,
          open: await this.safeRead(
            this.mod.reportAssignment.count({ where: { assigneeAdminId: c.id, unassignedAt: null } }),
            0,
            'assign-load',
          ),
        })),
      );
      loads.sort((a, b) => a.open - b.open);
      assignee = loads[0].id;
    }

    const now = new Date();
    const slaDueAt = new Date(now.getTime() + slaHoursForScore(risk.score) * 3_600_000);

    // Handoff: tutup assignment aktif sebelumnya (histori utuh).
    await this.safeRead(
      this.mod.reportAssignment.updateMany({
        where: { reportId, unassignedAt: null },
        data: { unassignedAt: now },
      }),
      { count: 0 },
      'assign-handoff',
    );
    const assignment = await this.mod.reportAssignment.create({
      data: {
        reportId,
        assigneeAdminId: assignee,
        riskScore: risk.score,
        slaDueAt,
      },
    });

    await this.recordEvent({
      reportId,
      actorAdminId: adminId,
      action: 'ASSIGNED',
      reasonCode: risk.reasonCode,
      note: `Assigned to ${assignee} (risk ${risk.score}/${risk.tier})`,
      metadata: {
        assigneeAdminId: assignee,
        riskScore: risk.score,
        riskTier: risk.tier,
        slaDueAt: slaDueAt.toISOString(),
        totalReports: risk.totalReports,
        uniqueReporters: risk.uniqueReporters,
      },
    });
    this.logAction(
      adminId,
      reportId,
      `Assigned showcase report ${reportId} to admin ${assignee} (risk ${risk.score}/${risk.tier}, SLA ${slaDueAt.toISOString()})`,
      ipAddress,
    );

    return {
      message: 'Showcase report assigned',
      reportId,
      assignmentId: assignment.id,
      assigneeAdminId: assignee,
      riskScore: risk.score,
      riskTier: risk.tier,
      slaDueAt: slaDueAt.toISOString(),
    };
  }

  // -------------------------------------------------------------------------
  // G423 — RESTRICT_TEMPORARY: sembunyikan item N hari, auto-restore via
  // scheduler. Berbeda dari TAKEDOWN permanen (event RESTRICTED eksplisit).
  // -------------------------------------------------------------------------
  async restrictShowcase(
    reportId: string,
    days: number,
    reason: string,
    reasonCode: ModerationReasonCodeValue | undefined,
    adminId: string,
    ipAddress: string,
  ): Promise<{ message: string; reportId: string; status: ReportStatus; restrictUntil: string }> {
    const report = await this.prisma.showcaseReport.findUnique({
      where: { id: reportId },
      include: { showcase: { select: { id: true, title: true, isActive: true, userId: true } } },
    });
    if (!report) {
      throw new NotFoundException({
        code: ErrorCodes.REPORT_NOT_FOUND,
        message: 'Showcase report not found',
      });
    }
    if (!OPEN_STATUSES.includes(report.status)) {
      throw new BadRequestException({
        code: ErrorCodes.REPORT_ALREADY_RESOLVED,
        message: `Showcase report has already been ${this.describeStatus(report.status)}`,
      });
    }
    if (!report.showcase.isActive) {
      throw new BadRequestException({
        code: ErrorCodes.SHOWCASE_ALREADY_INACTIVE,
        message: 'Showcase item is already inactive',
      });
    }
    const trimmed = reason?.trim() ?? '';
    if (trimmed.length < REOPEN_REASON_MIN_LENGTH) {
      throw new BadRequestException({
        code: ErrorCodes.REPORT_REOPEN_REASON_REQUIRED,
        message: `Alasan pembatasan wajib diisi (min. ${REOPEN_REASON_MIN_LENGTH} karakter)`,
      });
    }

    const now = new Date();
    const restrictUntil = new Date(now.getTime() + days * 24 * 3_600_000);
    const code = reasonCode ?? toReasonCode(report.reason);
    const snapshot = await this.captureItemSnapshot(report.showcaseId, adminId);

    await this.prisma.$transaction([
      this.prisma.userShowcase.updateMany({
        where: { id: report.showcaseId, isActive: true },
        data: { isActive: false },
      }),
      this.prisma.showcaseReport.updateMany({
        where: { id: reportId, status: { in: OPEN_STATUSES } },
        data: {
          status: ReportStatus.RESOLVED_ACTION_TAKEN,
          resolution: trimmed,
          reviewedBy: adminId,
          reviewedAt: now,
        },
      }),
    ]);
    const reloaded = await this.prisma.showcaseReport.findUnique({
      where: { id: reportId },
      select: { status: true },
    });
    if (reloaded?.status !== ReportStatus.RESOLVED_ACTION_TAKEN) {
      throw new BadRequestException({
        code: ErrorCodes.REPORT_ALREADY_RESOLVED,
        message: 'Report state changed; reload and try again',
      });
    }

    await this.recordEvent({
      reportId,
      actorAdminId: adminId,
      action: 'RESTRICTED',
      stateFrom: report.status,
      stateTo: ReportStatus.RESOLVED_ACTION_TAKEN,
      reasonCode: code,
      note: trimmed,
      metadata: {
        snapshot,
        restrictDays: days,
        restrictUntil: restrictUntil.toISOString(),
        temporary: true,
      },
    });
    this.logAction(
      adminId,
      reportId,
      `Temporarily restricted showcase item ${report.showcaseId} for ${days} day(s) via report ${reportId}: ${trimmed}`,
      ipAddress,
    );
    this.notifyReporterStatusChange(report.reporterId, report.showcase.title, 'ditindaklanjuti (item dibatasi sementara)');
    this.notifyOwnerItemAction(
      report.showcase.userId,
      report.showcase.title,
      true,
      `Item akan otomatis tampil kembali pada ${restrictUntil.toISOString()}.`,
    );
    return {
      message: `Showcase item restricted for ${days} day(s); auto-restore scheduled`,
      reportId,
      status: ReportStatus.RESOLVED_ACTION_TAKEN,
      restrictUntil: restrictUntil.toISOString(),
    };
  }

  // -------------------------------------------------------------------------
  // G405/G406/G407 — putusan banding. G408 — restore bila APPROVED.
  // -------------------------------------------------------------------------
  async decideAppeal(
    appealId: string,
    decision: AppealDecision,
    decisionNote: string,
    reviewerAdminId: string,
    ipAddress: string,
  ): Promise<object> {
    const appeal = await this.safeRead(
      this.mod.reportAppeal.findUnique({ where: { id: appealId } }),
      null,
      'decide-appeal-load',
    );
    if (!appeal) {
      throw new NotFoundException({
        code: ErrorCodes.APPEAL_NOT_FOUND,
        message: 'Appeal not found',
      });
    }
    if (appeal.status !== 'PENDING') {
      throw new ConflictException({
        code: ErrorCodes.APPEAL_ALREADY_DECIDED,
        message: `Appeal has already been ${appeal.status}`,
      });
    }
    const trimmedNote = decisionNote?.trim() ?? '';
    if (trimmedNote.length < APPEAL_DECISION_NOTE_MIN_LENGTH) {
      throw new BadRequestException({
        code: ErrorCodes.APPEAL_DECISION_NOTE_REQUIRED,
        message: `Catatan putusan wajib diisi (min. ${APPEAL_DECISION_NOTE_MIN_LENGTH} karakter)`,
      });
    }

    const report = await this.prisma.showcaseReport.findUnique({
      where: { id: appeal.reportId },
      include: { showcase: { select: { id: true, title: true, isActive: true, userId: true } } },
    });
    if (!report) {
      throw new NotFoundException({
        code: ErrorCodes.REPORT_NOT_FOUND,
        message: 'Showcase report not found',
      });
    }

    // G406 — reviewer banding WAJIB berbeda dari moderator keputusan awal.
    if (report.reviewedBy && report.reviewedBy === reviewerAdminId) {
      throw new UnprocessableEntityException({
        code: ErrorCodes.APPEAL_REVIEWER_CONFLICT,
        message: 'Reviewer banding harus berbeda dari moderator keputusan awal',
      });
    }

    // G407 — konflik kepentingan: tolak bila reviewer pernah menangani report
    // terkait item/pemilik yang sama dalam 90 hari (cek ReportModerationEvent).
    const cutoff = new Date(Date.now() - REVIEWER_CONFLICT_WINDOW_DAYS * 24 * 3_600_000);
    const relatedIds = (
      await this.prisma.showcaseReport.findMany({
        where: {
          OR: [{ showcaseId: report.showcaseId }, { showcase: { userId: report.showcase.userId } }],
        },
        select: { id: true },
      })
    ).map((r) => r.id);
    const conflict = await this.safeRead(
      this.mod.reportModerationEvent.findFirst({
        where: {
          actorAdminId: reviewerAdminId,
          reportId: { in: relatedIds },
          createdAt: { gte: cutoff },
        },
        select: { id: true },
      }),
      null,
      'decide-conflict-check',
    );
    if (conflict) {
      throw new UnprocessableEntityException({
        code: ErrorCodes.APPEAL_REVIEWER_CONFLICT,
        message: `Reviewer memiliki konflik kepentingan: pernah menangani report terkait item/pemilik ini dalam ${REVIEWER_CONFLICT_WINDOW_DAYS} hari terakhir`,
      });
    }

    const now = new Date();
    await this.mod.reportAppeal.update({
      where: { id: appealId, status: 'PENDING' },
      data: {
        status: decision,
        reviewerAdminId,
        decidedAt: now,
        decisionNote: trimmedNote,
      },
    });

    await this.recordEvent({
      reportId: report.id,
      actorAdminId: reviewerAdminId,
      action: 'APPEAL_DECIDED',
      reasonCode: toReasonCode(report.reason),
      note: trimmedNote,
      metadata: { appealId, decision, appellantType: appeal.appellantType },
    });

    // G408 — APPROVED → kembalikan isActive showcase + event RESTORED.
    let restored = false;
    if (decision === 'APPROVED') {
      const res = await this.prisma.userShowcase.updateMany({
        where: { id: report.showcaseId, isActive: false },
        data: { isActive: true },
      });
      restored = res.count === 1;
      await this.recordEvent({
        reportId: report.id,
        actorAdminId: reviewerAdminId,
        action: 'RESTORED',
        note: `Item restored after appeal ${appealId} APPROVED`,
        metadata: { appealId, viaAppeal: true },
      });
    }

    this.logAction(
      reviewerAdminId,
      report.id,
      `Decided appeal ${appealId} as ${decision} for report ${report.id}: ${trimmedNote}`,
      ipAddress,
    );

    // Notifikasi ke pemilik item (G405) — privasi-aware, tanpa data pelapor.
    this.notifyUser({
      userId: appeal.appellantUserId,
      type: NOTIF_MODERATION_APPEAL_DECIDED,
      title: decision === 'APPROVED' ? 'Banding Anda disetujui' : 'Banding Anda ditolak',
      body:
        decision === 'APPROVED'
          ? `Banding Anda untuk item "${report.showcase.title}" disetujui — item telah ditampilkan kembali.`
          : `Banding Anda untuk item "${report.showcase.title}" ditolak — keputusan moderasi dipertahankan.`,
      refType: 'ReportAppeal',
      refId: appealId,
    });

    return {
      message: `Appeal ${decision === 'APPROVED' ? 'approved' : 'rejected'}`,
      appealId,
      reportId: report.id,
      decision,
      restored,
    };
  }

  async listPendingAppeals(page: number, limit: number): Promise<object> {
    const safeLimit = Math.min(limit, 100);
    const safePage = Math.min(Math.max(page, 1), MAX_ADMIN_PAGE);
    const skip = (safePage - 1) * safeLimit;
    const where = { status: 'PENDING' as const };
    const [appeals, total] = await Promise.all([
      this.safeRead(
        this.mod.reportAppeal.findMany({
          where,
          skip,
          take: safeLimit,
          orderBy: { createdAt: 'asc' },
        }),
        [],
        'pending-appeals',
      ),
      this.safeRead(this.mod.reportAppeal.count({ where }), 0, 'pending-appeals-count'),
    ]);
    // Perkaya dengan info report + item (batch).
    const reportIds = [...new Set(appeals.map((a) => a.reportId))];
    const reports =
      reportIds.length > 0
        ? await this.prisma.showcaseReport.findMany({
            where: { id: { in: reportIds } },
            select: {
              id: true,
              status: true,
              reason: true,
              reviewedBy: true,
              showcase: { select: { id: true, title: true, isActive: true } },
            },
          })
        : [];
    const byId = new Map(reports.map((r) => [r.id, r]));
    const data = appeals.map((a) => ({ ...a, report: byId.get(a.reportId) ?? null }));
    return createPaginatedResponse(data, total, safePage, safeLimit);
  }

  // -------------------------------------------------------------------------
  // ADM-327 — ringkasan moderasi showcase (read-only, agregat).
  // -------------------------------------------------------------------------
  /**
   * Metrik agregat moderasi etalase: laporan open/under_review, jumlah
   * takedown/restrict/reopen 30 hari, rata-rata waktu penyelesaian,
   * distribusi alasan, banding pending. Tanpa PII.
   */
  async getMetrics(): Promise<object> {
    const [statusRows, actionRows, avgRows, reasonRows, appealRows] = await Promise.all([
      this.prisma.$queryRaw<Array<{ open_reports: bigint; under_review: bigint }>>(
        Prisma.sql`SELECT COUNT(*) FILTER (WHERE status::text = 'PENDING')::bigint AS open_reports,
                          COUNT(*) FILTER (WHERE status::text = 'UNDER_REVIEW')::bigint AS under_review
                   FROM showcase_reports`,
      ),
      this.prisma.$queryRaw<Array<{ action: string; count: bigint }>>(
        Prisma.sql`SELECT action::text AS action, COUNT(*)::bigint AS count
                   FROM report_moderation_events
                   WHERE created_at >= NOW() - INTERVAL '30 days'
                     AND action::text IN ('TAKEDOWN', 'RESTRICTED', 'REOPENED', 'DISMISSED')
                   GROUP BY action`,
      ),
      this.prisma.$queryRaw<Array<{ avg_seconds: number | null; resolved_count: bigint }>>(
        Prisma.sql`SELECT AVG(EXTRACT(EPOCH FROM (reviewed_at - created_at))) AS avg_seconds,
                          COUNT(*)::bigint AS resolved_count
                   FROM showcase_reports
                   WHERE reviewed_at IS NOT NULL AND reviewed_at >= NOW() - INTERVAL '30 days'`,
      ),
      this.prisma.$queryRaw<Array<{ reason: string; count: bigint }>>(
        Prisma.sql`SELECT reason, COUNT(*)::bigint AS count
                   FROM showcase_reports
                   WHERE status::text IN ('PENDING', 'UNDER_REVIEW')
                   GROUP BY reason
                   ORDER BY count DESC`,
      ),
      this.prisma.$queryRaw<Array<{ pending_appeals: bigint }>>(
        Prisma.sql`SELECT COUNT(*)::bigint AS pending_appeals
                   FROM report_appeals
                   WHERE status::text = 'PENDING'`,
      ),
    ]);
    const actions: Record<string, number> = {};
    for (const r of actionRows) actions[r.action] = Number(r.count);
    const avgSeconds = avgRows[0]?.avg_seconds != null ? Number(avgRows[0].avg_seconds) : null;
    return {
      openReports: Number(statusRows[0]?.open_reports ?? 0),
      underReview: Number(statusRows[0]?.under_review ?? 0),
      resolvedLast30d: Number(avgRows[0]?.resolved_count ?? 0),
      avgResolutionHours: avgSeconds != null ? Math.round((avgSeconds / 3600) * 10) / 10 : null,
      takedownsLast30d: actions['TAKEDOWN'] ?? 0,
      restrictsLast30d: actions['RESTRICTED'] ?? 0,
      reopensLast30d: actions['REOPENED'] ?? 0,
      dismissedLast30d: actions['DISMISSED'] ?? 0,
      pendingAppeals: Number(appealRows[0]?.pending_appeals ?? 0),
      reasonDistribution: reasonRows.map((r) => ({ reason: r.reason, count: Number(r.count) })),
    };
  }

  // -------------------------------------------------------------------------
  // G414 — report lain untuk showcaseId atau ownerId yang sama.
  // -------------------------------------------------------------------------
  async getRelatedReports(reportId: string): Promise<object> {
    const report = await this.prisma.showcaseReport.findUnique({
      where: { id: reportId },
      select: {
        id: true,
        showcaseId: true,
        showcase: { select: { userId: true, title: true } },
      },
    });
    if (!report) {
      throw new NotFoundException({
        code: ErrorCodes.REPORT_NOT_FOUND,
        message: 'Showcase report not found',
      });
    }
    const related = await this.prisma.showcaseReport.findMany({
      where: {
        id: { not: reportId },
        OR: [{ showcaseId: report.showcaseId }, { showcase: { userId: report.showcase.userId } }],
      },
      orderBy: { createdAt: 'desc' },
      take: 50,
      select: {
        id: true,
        showcaseId: true,
        reason: true,
        status: true,
        createdAt: true,
        reviewedAt: true,
        showcase: { select: { id: true, title: true } },
      },
    });
    return {
      reportId,
      showcaseId: report.showcaseId,
      ownerId: report.showcase.userId,
      total: related.length,
      reports: related,
    };
  }

  // -------------------------------------------------------------------------
  // G418 — ringkasan bukti untuk reviewer kedua (PII reporter diminimalkan).
  // -------------------------------------------------------------------------
  async getReviewerSummary(reportId: string): Promise<object> {
    const report = await this.prisma.showcaseReport.findUnique({
      where: { id: reportId },
      include: {
        showcase: {
          select: {
            id: true,
            title: true,
            isActive: true,
            visibility: true,
            category: true,
            userId: true,
            user: { select: { id: true, username: true } },
            images: { select: { imageUrl: true }, orderBy: { sortOrder: 'asc' } },
          },
        },
      },
    });
    if (!report) {
      throw new NotFoundException({
        code: ErrorCodes.REPORT_NOT_FOUND,
        message: 'Showcase report not found',
      });
    }

    const [events, appeals, clusterLinks] = await Promise.all([
      this.safeRead(
        this.mod.reportModerationEvent.findMany({
          where: { reportId, action: { not: 'EXPORTED' } },
          orderBy: { createdAt: 'asc' },
          take: 500,
        }),
        [],
        'summary-events',
      ),
      this.safeRead(
        this.mod.reportAppeal.findMany({ where: { reportId }, orderBy: { createdAt: 'desc' } }),
        [],
        'summary-appeals',
      ),
      this.safeRead(
        this.mod.reportClusterMember.findMany({ where: { reportId } }),
        [],
        'summary-cluster',
      ),
    ]);

    // Snapshot keputusan final pertama (bila ada), fallback ke kondisi live.
    const snapshotEvent = [...events]
      .reverse()
      .find((e) => FINAL_DECISION_EVENT_ACTIONS.includes(e.action) && e.metadata && (e.metadata as Record<string, unknown>).snapshot);
    const snapshot = snapshotEvent
      ? (snapshotEvent.metadata as Record<string, unknown>).snapshot
      : null;

    let cluster: object | null = null;
    if (clusterLinks.length > 0) {
      const clusterId = clusterLinks[0].clusterId;
      const [clusterRow, members] = await Promise.all([
        this.safeRead(this.mod.reportCluster.findUnique({ where: { id: clusterId } }), null, 'summary-cluster-row'),
        this.safeRead(
          this.mod.reportClusterMember.findMany({ where: { clusterId } }),
          [],
          'summary-cluster-members',
        ),
      ]);
      const memberReportIds = members.map((m) => m.reportId);
      const memberReports =
        memberReportIds.length > 0
          ? await this.prisma.showcaseReport.findMany({
              where: { id: { in: memberReportIds } },
              select: { id: true, status: true, reason: true, createdAt: true },
            })
          : [];
      cluster = { ...(clusterRow ?? { id: clusterId }), members: memberReports };
    }

    // PII reporter diminimalkan: hanya id + username (tanpa fullName/avatar).
    const reporter = await this.prisma.user.findUnique({
      where: { id: report.reporterId },
      select: { id: true, username: true },
    });

    return {
      report: {
        id: report.id,
        showcaseId: report.showcaseId,
        reason: report.reason,
        description: report.description,
        status: report.status,
        resolution: report.resolution,
        reviewedBy: report.reviewedBy,
        reviewedAt: report.reviewedAt,
        createdAt: report.createdAt,
        reporter: reporter ?? { id: report.reporterId },
      },
      itemSnapshot: snapshot,
      snapshotSource: snapshot ? 'decision' : 'live',
      itemLive: {
        title: report.showcase.title,
        isActive: report.showcase.isActive,
        visibility: report.showcase.visibility,
        category: report.showcase.category,
        ownerId: report.showcase.userId,
        ownerUsername: report.showcase.user?.username ?? null,
        imageUrls: report.showcase.images.map((i) => i.imageUrl),
      },
      moderationEvents: events,
      appeals,
      cluster,
    };
  }

  // -------------------------------------------------------------------------
  // G410 — diff snapshot keputusan vs kondisi item saat ini.
  // -------------------------------------------------------------------------
  async getSnapshotDiff(reportId: string): Promise<object> {
    const report = await this.prisma.showcaseReport.findUnique({
      where: { id: reportId },
      select: { id: true, showcaseId: true },
    });
    if (!report) {
      throw new NotFoundException({
        code: ErrorCodes.REPORT_NOT_FOUND,
        message: 'Showcase report not found',
      });
    }
    const events = await this.safeRead(
      this.mod.reportModerationEvent.findMany({
        where: { reportId, action: { in: FINAL_DECISION_EVENT_ACTIONS } },
        orderBy: { createdAt: 'desc' },
        take: 5,
      }),
      [],
      'diff-events',
    );
    const snapshotEvent = events.find(
      (e) => e.metadata && (e.metadata as Record<string, unknown>).snapshot,
    );
    const snapshot = snapshotEvent
      ? ((snapshotEvent.metadata as Record<string, unknown>).snapshot as Record<string, unknown>)
      : null;
    if (!snapshot) {
      throw new NotFoundException({
        code: ErrorCodes.SNAPSHOT_NOT_FOUND,
        message: 'Tidak ada snapshot keputusan final untuk laporan ini',
      });
    }

    const live = await this.prisma.userShowcase.findUnique({
      where: { id: report.showcaseId },
      select: {
        title: true,
        isActive: true,
        visibility: true,
        category: true,
        priceMin: true,
        priceMax: true,
        userId: true,
        images: { select: { imageUrl: true }, orderBy: { sortOrder: 'asc' } },
      },
    });
    if (!live) {
      return { reportId, snapshotAt: snapshot.capturedAt ?? null, itemDeleted: true, changedFields: [] };
    }

    const norm = (v: unknown): string => {
      if (v === null || v === undefined) return '';
      if (Array.isArray(v)) return [...v].map(String).sort().join('|');
      return String(v);
    };
    const current: Record<string, unknown> = {
      title: live.title,
      imageUrls: live.images.map((i) => i.imageUrl),
      isActive: live.isActive,
      visibility: live.visibility,
      category: live.category,
      priceMin: live.priceMin?.toString() ?? null,
      priceMax: live.priceMax?.toString() ?? null,
      ownerId: live.userId,
    };
    const changedFields: { field: string; snapshot: unknown; current: unknown }[] = [];
    for (const field of Object.keys(current)) {
      if (norm((snapshot as Record<string, unknown>)[field]) !== norm(current[field])) {
        changedFields.push({
          field,
          snapshot: (snapshot as Record<string, unknown>)[field] ?? null,
          current: current[field] ?? null,
        });
      }
    }
    return {
      reportId,
      snapshotAt: (snapshot as Record<string, unknown>).capturedAt ?? null,
      snapshotBy: (snapshot as Record<string, unknown>).capturedBy ?? null,
      decisionEventId: snapshotEvent!.id,
      changedFields,
      changedCount: changedFields.length,
    };
  }

  // -------------------------------------------------------------------------
  // G411/G419 — antrean prioritas: skor risiko + badge overdue + filter.
  // -------------------------------------------------------------------------
  async getModerationQueue(query: {
    page: number;
    limit: number;
    riskTier?: string;
    overdueOnly?: boolean;
    sort?: string;
    assigneeAdminId?: string;
  }): Promise<object> {
    const reports = await this.prisma.showcaseReport.findMany({
      where: { status: { in: OPEN_STATUSES } },
      orderBy: query.sort === 'oldest' ? { createdAt: 'asc' } : { createdAt: 'desc' },
      take: 500,
      include: {
        showcase: {
          select: {
            id: true,
            title: true,
            isActive: true,
            user: { select: { id: true, username: true } },
          },
        },
      },
    });

    const reportIds = reports.map((r) => r.id);
    const showcaseIds = [...new Set(reports.map((r) => r.showcaseId))];
    const [assignments, counts, reporterRows] = await Promise.all([
      this.safeRead(
        this.mod.reportAssignment.findMany({ where: { reportId: { in: reportIds }, unassignedAt: null } }),
        [],
        'queue-assignments',
      ),
      this.prisma.showcaseReport.groupBy({
        by: ['showcaseId'],
        where: { showcaseId: { in: showcaseIds } },
        _count: { _all: true },
      }),
      this.prisma.showcaseReport.findMany({
        where: { showcaseId: { in: showcaseIds } },
        select: { showcaseId: true, reporterId: true },
        distinct: ['showcaseId', 'reporterId'],
      }),
    ]);
    const assignmentByReport = new Map(assignments.map((a) => [a.reportId, a]));
    const countByShowcase = new Map(counts.map((c) => [c.showcaseId, c._count._all]));
    const reportersByShowcase = new Map<string, number>();
    for (const row of reporterRows) {
      reportersByShowcase.set(row.showcaseId, (reportersByShowcase.get(row.showcaseId) ?? 0) + 1);
    }

    const now = new Date();
    let items = reports.map((r) => {
      const assignment = assignmentByReport.get(r.id) ?? null;
      const score =
        assignment?.riskScore ??
        computeRiskScore(
          countByShowcase.get(r.showcaseId) ?? 1,
          reportersByShowcase.get(r.showcaseId) ?? 1,
          toReasonCode(r.reason),
        );
      const isOverdue = assignment ? assignment.slaDueAt < now : false;
      return {
        id: r.id,
        showcaseId: r.showcaseId,
        reason: r.reason,
        status: r.status,
        createdAt: r.createdAt,
        showcase: r.showcase,
        riskScore: score,
        riskTier: riskTier(score),
        assigneeAdminId: assignment?.assigneeAdminId ?? null,
        slaDueAt: assignment?.slaDueAt ?? null,
        isOverdue,
        escalated: assignment?.escalated ?? false,
      };
    });

    if (query.riskTier) items = items.filter((i) => i.riskTier === query.riskTier);
    if (query.overdueOnly) items = items.filter((i) => i.isOverdue);
    if (query.assigneeAdminId) items = items.filter((i) => i.assigneeAdminId === query.assigneeAdminId);
    if (query.sort === 'risk' || !query.sort) items.sort((a, b) => b.riskScore - a.riskScore);

    const total = items.length;
    const safePage = Math.min(Math.max(query.page, 1), MAX_ADMIN_PAGE);
    const safeLimit = Math.min(Math.max(query.limit, 1), 100);
    const paged = items.slice((safePage - 1) * safeLimit, safePage * safeLimit);
    return createPaginatedResponse(paged, total, safePage, safeLimit);
  }

  // -------------------------------------------------------------------------
  // G421 — export CSV/JSON untuk audit kepatuhan (redaksi PII), event EXPORTED.
  // -------------------------------------------------------------------------
  async exportShowcaseReports(
    query: { format?: string; status?: string; from?: string; to?: string; limit?: number },
    adminId: string,
    ipAddress: string,
  ): Promise<{ format: 'csv' | 'json'; content: string; rowCount: number; exportedAt: string }> {
    const format = query.format === 'json' ? 'json' : 'csv';
    const where: Prisma.ShowcaseReportWhereInput = {};
    if (query.status) {
      const validStatuses = Object.values(ReportStatus);
      if (!validStatuses.includes(query.status as ReportStatus)) {
        throw new BadRequestException({
          code: ErrorCodes.INVALID_STATUS,
          message: `Invalid status: ${query.status}`,
        });
      }
      where.status = query.status as Prisma.EnumReportStatusFilter;
    }
    if (query.from || query.to) {
      where.createdAt = {};
      if (query.from) where.createdAt.gte = new Date(query.from);
      if (query.to) where.createdAt.lte = new Date(query.to);
    }

    const take = Math.min(query.limit ?? EXPORT_MAX_ROWS, EXPORT_MAX_ROWS);
    const rows = await this.prisma.showcaseReport.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take,
      include: {
        showcase: { select: { id: true, title: true, userId: true } },
      },
    });

    const truncate = (v: string | null | undefined): string | null => {
      if (!v) return null;
      const t = v.trim();
      return t.length > EXPORT_DESCRIPTION_TRUNCATE ? `${t.slice(0, EXPORT_DESCRIPTION_TRUNCATE)}…` : t;
    };

    // Redaksi: tanpa nama/username pelapor & pemilik — hanya ID; description dipotong.
    const redacted = rows.map((r) => ({
      id: r.id,
      createdAt: r.createdAt.toISOString(),
      showcaseId: r.showcaseId,
      showcaseTitle: r.showcase?.title ?? null,
      ownerId: r.showcase?.userId ?? null,
      reporterId: r.reporterId,
      reason: r.reason,
      description: truncate(r.description),
      status: r.status,
      reviewedBy: r.reviewedBy,
      reviewedAt: r.reviewedAt?.toISOString() ?? null,
      resolution: truncate(r.resolution),
    }));

    // Catat sebagai event EXPORTED per baris (createMany, satu round-trip).
    try {
      const exportedAt = new Date().toISOString();
      await this.mod.reportModerationEvent.createMany({
        data: rows.map((r) => ({
          reportId: r.id,
          actorAdminId: adminId,
          action: 'EXPORTED',
          note: `Showcase reports export (${format}, ${rows.length} rows)`,
          metadata: { format, exportedAt, filters: { status: query.status ?? null, from: query.from ?? null, to: query.to ?? null } },
        })),
      });
    } catch (err) {
      this.logger.warn(
        `export EXPORTED events failed (best-effort): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    this.logAction(
      adminId,
      'bulk',
      `Exported ${rows.length} showcase reports as ${format}${query.status ? ` (status=${query.status})` : ''}`,
      ipAddress,
    );

    const exportedAt = new Date().toISOString();
    if (format === 'json') {
      return { format, content: JSON.stringify(redacted, null, 2), rowCount: rows.length, exportedAt };
    }
    const header = 'id,createdAt,showcaseId,showcaseTitle,ownerId,reporterId,reason,description,status,reviewedBy,reviewedAt,resolution';
    const esc = (v: unknown): string => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const lines = redacted.map((r) =>
      [
        r.id, r.createdAt, r.showcaseId, r.showcaseTitle, r.ownerId, r.reporterId,
        r.reason, r.description, r.status, r.reviewedBy, r.reviewedAt, r.resolution,
      ]
        .map(esc)
        .join(','),
    );
    return { format, content: [header, ...lines].join('\n'), rowCount: rows.length, exportedAt };
  }

  // -------------------------------------------------------------------------
  // G404 — banding oleh pemilik item atas takedown/pembatasan.
  // Endpoint user-facing (ter-autentikasi). Syarat: item milik user, ada
  // enforcement final (event TAKEDOWN/RESTRICTED) yang bisa dibanding,
  // alasan + bukti baru WAJIB.
  // -------------------------------------------------------------------------
  async fileAppeal(
    userId: string,
    showcaseId: string,
    input: { reason: string; evidenceFileKeys: string[] },
    ipAddress: string,
  ): Promise<{ message: string; appealId: string; reportId: string }> {
    const item = await this.prisma.userShowcase.findFirst({
      where: { id: showcaseId, userId, deletedAt: null },
      select: { id: true, title: true, isActive: true },
    });
    if (!item) {
      throw new NotFoundException({
        code: ErrorCodes.SHOWCASE_NOT_FOUND,
        message: 'Showcase item not found',
      });
    }

    const reason = (input.reason ?? '').trim();
    if (reason.length < APPEAL_REASON_MIN_LENGTH) {
      throw new BadRequestException({
        code: ErrorCodes.VALIDATION_ERROR,
        message: `Alasan banding wajib diisi (min. ${APPEAL_REASON_MIN_LENGTH} karakter)`,
      });
    }
    if (reason.length > APPEAL_REASON_MAX_LENGTH) {
      throw new BadRequestException({
        code: ErrorCodes.VALIDATION_ERROR,
        message: `Alasan banding maksimal ${APPEAL_REASON_MAX_LENGTH} karakter`,
      });
    }
    // SH-S-005: bukti = daftar FILE KEY terverifikasi (report-evidence), BUKAN
    // JSON bebas. verifyEvidenceFileKeys menegakkan: bentuk key aman (anti
    // traversal), prefix uploads/report-evidence/<userId>/, konfirmasi upload,
    // file ada di storage, ukuran, dan meng-consume konfirmasi one-time.
    // DTO sudah menjamin min. 1 key; verifikasi ini menjamin key-nya asli.
    const evidenceFileKeys = Array.isArray(input.evidenceFileKeys) ? input.evidenceFileKeys : [];
    if (evidenceFileKeys.length === 0) {
      throw new BadRequestException({
        code: ErrorCodes.APPEAL_EVIDENCE_REQUIRED,
        message: 'Bukti baru wajib dilampirkan saat mengajukan banding',
      });
    }
    await this.uploadService.verifyEvidenceFileKeys(userId, evidenceFileKeys, 'report-evidence');
    const evidence: Record<string, unknown> = { fileKeys: evidenceFileKeys };

    // Harus ada enforcement final (takedown/restrict) atas item ini.
    const enforcement = await this.safeRead(
      this.mod.reportModerationEvent.findFirst({
        where: {
          action: { in: ['TAKEDOWN', 'RESTRICTED'] },
          report: { showcaseId },
        },
        orderBy: { createdAt: 'desc' },
      }),
      null,
      'appeal-enforcement-check',
    );
    if (!enforcement) {
      throw new BadRequestException({
        code: ErrorCodes.APPEAL_NOT_ELIGIBLE,
        message: 'Item ini tidak sedang dikenai takedown/pembatasan moderasi — tidak ada yang bisa dibanding',
      });
    }
    const report = await this.prisma.showcaseReport.findUnique({
      where: { id: enforcement.reportId },
      select: { id: true, status: true, showcaseId: true },
    });
    if (!report) {
      throw new NotFoundException({
        code: ErrorCodes.REPORT_NOT_FOUND,
        message: 'Showcase report not found',
      });
    }

    // Satu banding PENDING per pemilik per laporan — duplikat → 409.
    const existingPending = await this.safeRead(
      this.mod.reportAppeal.findFirst({
        where: { reportId: report.id, appellantUserId: userId, status: 'PENDING' },
        select: { id: true },
      }),
      null,
      'appeal-duplicate-check',
    );
    if (existingPending) {
      throw new ConflictException({
        code: ErrorCodes.APPEAL_ALREADY_PENDING,
        message: 'Anda sudah memiliki banding yang sedang diproses untuk item ini',
        appealId: existingPending.id,
      });
    }

    const appeal = await this.mod.reportAppeal.create({
      data: {
        reportId: report.id,
        appellantType: 'OWNER',
        appellantUserId: userId,
        reason,
        newEvidence: evidence,
        status: 'PENDING',
      },
    });

    await this.recordEvent({
      reportId: report.id,
      actorAdminId: null,
      action: 'APPEAL_FILED',
      note: `Appeal filed by item owner ${userId}`,
      metadata: { appealId: appeal.id, appellantType: 'OWNER', showcaseId },
    });

    try {
      this.auditLog.logUserAction({
        userId,
        action: 'SHOWCASE_APPEAL_FILED' as UserAuditAction,
        entityType: 'UserShowcase',
        entityId: showcaseId,
        description: `User ${userId} filed appeal ${appeal.id} for showcase ${showcaseId} (report ${report.id})`,
        ipAddress,
      });
    } catch (err) {
      this.logger.warn(
        `appeal user audit log failed (best-effort): ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    return {
      message: 'Banding berhasil diajukan dan akan ditinjau oleh reviewer',
      appealId: appeal.id,
      reportId: report.id,
    };
  }

  // -------------------------------------------------------------------------
  // G405 — daftar banding milik sendiri untuk satu item (pemilik item).
  // -------------------------------------------------------------------------
  async listOwnAppeals(userId: string, showcaseId: string): Promise<object> {
    const item = await this.prisma.userShowcase.findFirst({
      where: { id: showcaseId, userId, deletedAt: null },
      select: { id: true },
    });
    if (!item) {
      throw new NotFoundException({
        code: ErrorCodes.SHOWCASE_NOT_FOUND,
        message: 'Showcase item not found',
      });
    }
    const reportIds = (
      await this.prisma.showcaseReport.findMany({
        where: { showcaseId },
        select: { id: true },
      })
    ).map((r) => r.id);
    if (reportIds.length === 0) return { showcaseId, appeals: [] };
    const appeals = await this.safeRead(
      this.mod.reportAppeal.findMany({
        where: { reportId: { in: reportIds }, appellantUserId: userId },
        orderBy: { createdAt: 'desc' },
      }),
      [],
      'list-own-appeals',
    );
    return {
      showcaseId,
      appeals: appeals.map((a) => ({
        id: a.id,
        reportId: a.reportId,
        reason: a.reason,
        status: a.status,
        decidedAt: a.decidedAt,
        decisionNote: a.decisionNote,
        createdAt: a.createdAt,
      })),
    };
  }

  // -------------------------------------------------------------------------
  // G415 — tautkan laporan baru ke cluster duplikat (showcaseId + reason sama
  // dalam 24 jam). Laporan sumber TIDAK dihapus — cluster hanya menautkan.
  // Best-effort: kegagalan tidak menggagalkan pembuatan laporan.
  // -------------------------------------------------------------------------
  async linkReportToCluster(reportId: string, showcaseId: string, reason: string): Promise<string | null> {
    try {
      const normalizedReason = (reason ?? '').trim().toUpperCase().slice(0, 100) || 'OTHER';
      const windowStart = new Date(Date.now() - CLUSTER_WINDOW_HOURS * 3_600_000);
      let cluster = await this.mod.reportCluster.findFirst({
        where: {
          showcaseId,
          reason: normalizedReason,
          createdAt: { gte: windowStart },
        },
        orderBy: { createdAt: 'desc' },
      });
      if (!cluster) {
        cluster = await this.mod.reportCluster.create({
          data: { showcaseId, reason: normalizedReason, reportCount: 0 },
        });
      }
      try {
        await this.mod.reportClusterMember.create({
          data: { clusterId: cluster.id, reportId },
        });
        await this.mod.reportCluster.update({
          where: { id: cluster.id },
          data: { reportCount: { increment: 1 } },
        });
      } catch (err) {
        // P2002 = (clusterId, reportId) sudah tertaut (retry) — abaikan.
        if ((err as { code?: string })?.code !== 'P2002') throw err;
      }
      return cluster.id;
    } catch (err) {
      this.logger.warn(
        `linkReportToCluster(${reportId}) failed (best-effort): ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
  }

  // -------------------------------------------------------------------------
  // G419 — eskalasi SLA terlewati (dipanggil scheduler ModerationSlaService).
  // Assignment yang slaDueAt-nya lewat dan belum di-unassign/escalated
  // ditandai escalated + dicatat sebagai event ESCALATED (actor = sistem).
  // Jejak auditnya adalah event append-only; logAction admin dilewati karena
  // tidak ada adminId manusia.
  // -------------------------------------------------------------------------
  async escalateOverdueAssignments(now: Date = new Date()): Promise<{ escalated: number }> {
    const overdue = await this.safeRead(
      this.mod.reportAssignment.findMany({
        where: { slaDueAt: { lte: now }, unassignedAt: null, escalated: false },
      }),
      [],
      'escalate-overdue',
    );
    let escalated = 0;
    for (const assignment of overdue) {
      try {
        await this.mod.reportAssignment.update({
          where: { id: assignment.id },
          data: { escalated: true },
        });
        await this.recordEvent({
          reportId: assignment.reportId,
          actorAdminId: null,
          action: 'ESCALATED',
          note: `SLA review terlewati (batas ${assignment.slaDueAt.toISOString()}); diekskalasi otomatis ke supervisor`,
          metadata: {
            assignmentId: assignment.id,
            assigneeAdminId: assignment.assigneeAdminId,
            riskScore: assignment.riskScore,
            slaDueAt: assignment.slaDueAt.toISOString(),
            viaScheduler: true,
          },
        });
        escalated += 1;
      } catch (err) {
        this.logger.warn(
          `escalateOverdueAssignments(${assignment.id}) failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    if (escalated > 0) {
      this.logger.log(`Escalated ${escalated} overdue moderation assignment(s)`);
    }
    return { escalated };
  }

  // -------------------------------------------------------------------------
  // G423 — auto-restore RESTRICT_TEMPORARY yang sudah kedaluwarsa (scheduler).
  // Untuk tiap event RESTRICTED dengan metadata.restrictUntil <= now:
  //   - lewati bila ada event RESTRICTED lebih baru untuk report yang sama
  //     (pembatasan ulang menimpa jadwal lama);
  //   - lewati bila sudah ada event RESTORED setelahnya (banding/jalan lama);
  //   - kembalikan userShowcase.isActive = true + event RESTORED (aktor sistem)
  //     + notifikasi ke pemilik item.
  // -------------------------------------------------------------------------
  async autoRestoreExpiredRestrictions(
    now: Date = new Date(),
  ): Promise<{ checked: number; restored: number }> {
    const since = new Date(now.getTime() - 60 * 24 * 3_600_000);
    const restrictedEvents = await this.safeRead(
      this.mod.reportModerationEvent.findMany({
        where: { action: 'RESTRICTED', createdAt: { gte: since } },
        orderBy: { createdAt: 'desc' },
        take: 1000,
      }),
      [],
      'auto-restore-scan',
    );

    let checked = 0;
    let restored = 0;
    const seenReports = new Set<string>();

    for (const event of restrictedEvents) {
      // Hanya event RESTRICTED terbaru per report yang mengatur jadwal.
      if (seenReports.has(event.reportId)) continue;
      seenReports.add(event.reportId);

      const meta = (event.metadata ?? {}) as Record<string, unknown>;
      const restrictUntilRaw = meta.restrictUntil as string | undefined;
      if (!restrictUntilRaw) continue;
      const restrictUntil = new Date(restrictUntilRaw);
      if (Number.isNaN(restrictUntil.getTime()) || restrictUntil > now) continue;
      checked += 1;

      // Sudah dipulihkan (banding APPROVED / jalan scheduler sebelumnya)?
      const alreadyRestored = await this.safeRead(
        this.mod.reportModerationEvent.findFirst({
          where: {
            reportId: event.reportId,
            action: 'RESTORED',
            createdAt: { gt: event.createdAt },
          },
          select: { id: true },
        }),
        null,
        'auto-restore-check',
      );
      if (alreadyRestored) continue;

      const report = await this.prisma.showcaseReport.findUnique({
        where: { id: event.reportId },
        select: { showcaseId: true },
      });
      if (!report) continue;

      const item = await this.prisma.userShowcase.findUnique({
        where: { id: report.showcaseId },
        select: { id: true, title: true, userId: true, isActive: true },
      });
      if (!item || item.isActive) continue;

      try {
        await this.prisma.userShowcase.updateMany({
          where: { id: item.id, isActive: false },
          data: { isActive: true },
        });
        await this.recordEvent({
          reportId: event.reportId,
          actorAdminId: null,
          action: 'RESTORED',
          note: `Auto-restore setelah RESTRICT_TEMPORARY berakhir (${restrictUntilRaw})`,
          metadata: {
            restrictEventId: event.id,
            restrictUntil: restrictUntilRaw,
            viaScheduler: true,
          },
        });
        this.notifyUser({
          userId: item.userId,
          type: NOTIF_MODERATION_ITEM_TAKEDOWN,
          title: 'Item etalase Anda aktif kembali',
          body: `Masa pembatasan sementara item "${item.title}" telah berakhir — item kini tampil kembali di etalase.`,
          refType: 'UserShowcase',
          refId: item.id,
        });
        restored += 1;
      } catch (err) {
        this.logger.warn(
          `autoRestoreExpiredRestrictions(${event.reportId}) failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    if (restored > 0) {
      this.logger.log(`Auto-restored ${restored} showcase item(s) after temporary restriction`);
    }
    return { checked, restored };
  }

  private describeStatus(status: ReportStatus): string {
    switch (status) {
      case ReportStatus.DISMISSED:
        return 'dismissed';
      case ReportStatus.RESOLVED_ACTION_TAKEN:
        return 'resolved with action taken';
      case ReportStatus.RESOLVED_NO_ACTION:
        return 'resolved with no action';
      default:
        return 'resolved';
    }
  }

  private logAction(adminId: string, reportId: string, description: string, ipAddress: string): void {
    this.auditLog.logAdminAction({
      adminId,
      action: AuditAction.ADMIN_ACTION,
      targetType: 'ShowcaseReport',
      targetId: reportId,
      description,
      ipAddress,
    });
  }
}
