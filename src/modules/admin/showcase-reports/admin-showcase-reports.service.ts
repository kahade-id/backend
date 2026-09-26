import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { AuditLogService } from '../../../common/services/audit-log.service';
import { createPaginatedResponse } from '../../../common/dto/pagination.dto';
import { AuditAction, Prisma, ReportStatus } from '@prisma/client';
import * as ErrorCodes from '../../../common/constants/error-codes';
import { ShowcaseReportAction } from './dto/review-showcase-report.dto';

const MAX_ADMIN_PAGE = 100_000;

/** Status final: aksi moderasi ditolak (idempotency guard). */
const FINAL_STATUSES: ReportStatus[] = [
  ReportStatus.RESOLVED_ACTION_TAKEN,
  ReportStatus.RESOLVED_NO_ACTION,
  ReportStatus.DISMISSED,
];

/** Status non-final: masih boleh diproses ulang oleh admin lain. */
const OPEN_STATUSES: ReportStatus[] = [ReportStatus.PENDING, ReportStatus.UNDER_REVIEW];

@Injectable()
export class AdminShowcaseReportsService {
  constructor(
    private prisma: PrismaService,
    private auditLog: AuditLogService,
  ) {}

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
        showcase: {
          select: {
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
          },
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

    return { ...report, reviewedByAdmin };
  }

  async reviewShowcaseReport(
    reportId: string,
    action: ShowcaseReportAction,
    resolution: string | undefined,
    adminId: string,
    ipAddress: string,
  ): Promise<{ message: string; reportId: string; status: ReportStatus }> {
    const report = await this.prisma.showcaseReport.findUnique({
      where: { id: reportId },
      include: { showcase: { select: { id: true, title: true, isActive: true } } },
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
    const now = new Date();

    switch (action) {
      case 'under_review': {
        if (report.status === ReportStatus.UNDER_REVIEW) {
          // No-op yang aman untuk retry — kembalikan status saat ini.
          return { message: 'Showcase report already under review', reportId, status: report.status };
        }
        await this.updateReportStatus(reportId, ReportStatus.UNDER_REVIEW, trimmedResolution, adminId, now);
        this.logAction(adminId, reportId, `Marked showcase report ${reportId} as under review`, ipAddress);
        return { message: 'Showcase report marked as under review', reportId, status: ReportStatus.UNDER_REVIEW };
      }
      case 'dismiss': {
        await this.updateReportStatus(reportId, ReportStatus.DISMISSED, trimmedResolution, adminId, now);
        this.logAction(adminId, reportId, `Dismissed showcase report ${reportId}${trimmedResolution ? `: ${trimmedResolution}` : ''}`, ipAddress);
        return { message: 'Showcase report dismissed', reportId, status: ReportStatus.DISMISSED };
      }
      case 'no_action': {
        await this.updateReportStatus(reportId, ReportStatus.RESOLVED_NO_ACTION, trimmedResolution, adminId, now);
        this.logAction(adminId, reportId, `Resolved showcase report ${reportId} with no action${trimmedResolution ? `: ${trimmedResolution}` : ''}`, ipAddress);
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
        this.logAction(
          adminId,
          reportId,
          `Took down showcase item ${report.showcaseId} ("${report.showcase.title}") via report ${reportId}${trimmedResolution ? `: ${trimmedResolution}` : ''}`,
          ipAddress,
        );
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

  /** Update status dengan OCC guard (hanya dari status non-final). */
  private async updateReportStatus(
    reportId: string,
    status: ReportStatus,
    resolution: string | undefined,
    adminId: string,
    now: Date,
  ): Promise<void> {
    const updated = await this.prisma.showcaseReport.updateMany({
      where: { id: reportId, status: { in: OPEN_STATUSES } },
      data: { status, resolution, reviewedBy: adminId, reviewedAt: now },
    });
    if (updated.count !== 1) {
      throw new BadRequestException({
        code: ErrorCodes.REPORT_ALREADY_RESOLVED,
        message: 'Report state changed; reload and try again',
      });
    }
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
