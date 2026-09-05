import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { AuditLogService } from '../../../common/services/audit-log.service';
import { createPaginatedResponse } from '../../../common/dto/pagination.dto';
import { AuditAction, Prisma, ReportStatus } from '@prisma/client';
import * as ErrorCodes from '../../../common/constants/error-codes';
const MAX_ADMIN_PAGE = 100_000;

@Injectable()
export class AdminReportsService {
  constructor(
    private prisma: PrismaService,
    private auditLog: AuditLogService,
  ) {}

  async listReports(page: number, limit: number, status?: string, category?: string): Promise<object> {
    const safeLimit = Math.min(limit, 100);
    const safePage = Math.min(Math.max(page, 1), MAX_ADMIN_PAGE);
    const skip = (safePage - 1) * safeLimit;

    const where: Prisma.UserReportWhereInput = {};
    if (status) {
      const validStatuses = ['PENDING', 'UNDER_REVIEW', 'RESOLVED_ACTION_TAKEN', 'RESOLVED_NO_ACTION', 'DISMISSED'];
      if (!validStatuses.includes(status)) {
        throw new BadRequestException({
          code: ErrorCodes.INVALID_STATUS,
          message: `Invalid report status: ${status}. Valid values: ${validStatuses.join(', ')}`,
        });
      }
      where.status = status as Prisma.EnumReportStatusFilter;
    }
    if (category) {
      const validCategories = ['FRAUD', 'FAKE_IDENTITY', 'INAPPROPRIATE_CONTENT', 'TNC_VIOLATION', 'MONEY_LAUNDERING', 'SPAM', 'OTHER'];
      if (!validCategories.includes(category)) {
        throw new BadRequestException({
          code: ErrorCodes.INVALID_STATUS,
          message: `Invalid report category: ${category}. Valid values: ${validCategories.join(', ')}`,
        });
      }
      where.category = category as Prisma.EnumReportCategoryFilter;
    }

    const [reports, total] = await Promise.all([
      this.prisma.userReport.findMany({
        where,
        skip,
        take: safeLimit,
        orderBy: { createdAt: 'desc' },
        include: {
          reporter: {
            select: {
              id: true,
              userId: true,
              username: true,
              fullName: true,
            },
          },
          target: {
            select: {
              id: true,
              userId: true,
              username: true,
              fullName: true,
            },
          },
        },
      }),
      this.prisma.userReport.count({ where }),
    ]);

    return createPaginatedResponse(reports, total, safePage, safeLimit);
  }

  async getReportDetail(reportId: string): Promise<object> {
    const report = await this.prisma.userReport.findUnique({
      where: { id: reportId },
      include: {
        reporter: {
          select: {
            id: true,
            userId: true,
            username: true,
            fullName: true,
            avatarUrl: true,
          },
        },
        target: {
          select: {
            id: true,
            userId: true,
            username: true,
            fullName: true,
            avatarUrl: true,
            isBanned: true,
          },
        },
      },
    });

    if (!report) {
      throw new NotFoundException({
        code: ErrorCodes.REPORT_NOT_FOUND,
        message: 'Report not found',
      });
    }

    return report;
  }

  async resolveReport(reportId: string, resolution: string, adminId: string, ipAddress: string, resolveStatus: ReportStatus = ReportStatus.RESOLVED_ACTION_TAKEN): Promise<{ message: string; reportId: string }> {
    const report = await this.prisma.userReport.findUnique({
      where: { id: reportId },
    });

    if (!report) {
      throw new NotFoundException({
        code: ErrorCodes.REPORT_NOT_FOUND,
        message: 'Report not found',
      });
    }

    if (report.status === ReportStatus.RESOLVED_ACTION_TAKEN || report.status === ReportStatus.RESOLVED_NO_ACTION || report.status === ReportStatus.DISMISSED) {
      throw new BadRequestException({
        code: ErrorCodes.REPORT_ALREADY_RESOLVED,
        message: 'Report has already been resolved or dismissed',
      });
    }

    const updated = await this.prisma.userReport.updateMany({
      where: { id: reportId, status: { in: [ReportStatus.PENDING, ReportStatus.UNDER_REVIEW] } },
      data: {
        status: resolveStatus,
        resolution,
        reviewedBy: adminId,
        reviewedAt: new Date(),
      },
    });
    if (updated.count !== 1) {
      throw new BadRequestException({ code: ErrorCodes.REPORT_ALREADY_RESOLVED, message: 'Report state changed; reload and try again' });
    }

    this.auditLog.logAdminAction({
      adminId,
      action: AuditAction.ADMIN_ACTION,
      targetType: 'UserReport',
      targetId: reportId,
      description: `Resolved report ${reportId}: ${resolution}`,
      ipAddress,
    });

    return { message: 'Report resolved successfully', reportId };
  }

  async dismissReport(reportId: string, adminId: string, ipAddress: string): Promise<{ message: string; reportId: string }> {
    const report = await this.prisma.userReport.findUnique({
      where: { id: reportId },
    });

    if (!report) {
      throw new NotFoundException({
        code: ErrorCodes.REPORT_NOT_FOUND,
        message: 'Report not found',
      });
    }

    if (report.status === ReportStatus.RESOLVED_ACTION_TAKEN || report.status === ReportStatus.RESOLVED_NO_ACTION || report.status === ReportStatus.DISMISSED) {
      throw new BadRequestException({
        code: ErrorCodes.REPORT_ALREADY_RESOLVED,
        message: 'Report has already been resolved or dismissed',
      });
    }

    const updated = await this.prisma.userReport.updateMany({
      where: { id: reportId, status: { in: [ReportStatus.PENDING, ReportStatus.UNDER_REVIEW] } },
      data: {
        status: ReportStatus.DISMISSED,
        reviewedBy: adminId,
        reviewedAt: new Date(),
      },
    });
    if (updated.count !== 1) {
      throw new BadRequestException({ code: ErrorCodes.REPORT_ALREADY_RESOLVED, message: 'Report state changed; reload and try again' });
    }

    this.auditLog.logAdminAction({
      adminId,
      action: AuditAction.ADMIN_ACTION,
      targetType: 'UserReport',
      targetId: reportId,
      description: `Dismissed report ${reportId}`,
      ipAddress,
    });

    return { message: 'Report dismissed successfully', reportId };
  }
}
