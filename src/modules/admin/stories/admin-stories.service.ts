import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  AuditAction,
  NotificationType,
  Prisma,
  StoryKind,
  StoryReportStatus,
} from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { AuditLogService } from '../../../common/services/audit-log.service';
import { UploadService } from '../../upload/upload.service';
import { StoriesService } from '../../stories/stories.service';
import { getCategoryForType } from '../../notifications/notification-category.map';
import { generateNotifId } from '../../../common/utils/id-generator.util';
import { AdminStoryListQueryDto, AdminStoryReportListQueryDto } from './dto/admin-story-query.dto';
import {
  BanStoryFeatureDto,
  HideStoryDto,
  ReviewStoryReportDto,
  AdminStoryReasonDto,
} from './dto/admin-story-action.dto';

const AUTHOR_SELECT = {
  id: true,
  userId: true,
  username: true,
  fullName: true,
  avatarUrl: true,
} satisfies Prisma.UserSelect;

function jsonRecord(value: Prisma.JsonValue | null | undefined): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function apiReportStatus(status: StoryReportStatus): string {
  return status.toLowerCase();
}

function reportStatusFromApi(status?: string): StoryReportStatus | undefined {
  if (!status) return undefined;
  const normalized = status.toUpperCase();
  return Object.values(StoryReportStatus).includes(normalized as StoryReportStatus)
    ? (normalized as StoryReportStatus)
    : undefined;
}

@Injectable()
export class AdminStoriesService {
  private readonly logger = new Logger(AdminStoriesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLog: AuditLogService,
    private readonly upload: UploadService,
    private readonly stories: StoriesService,
  ) {}

  async listStories(
    query: AdminStoryListQueryDto,
    adminId: string,
    ipAddress: string,
    userAgent?: string,
  ): Promise<object> {
    const page = Math.min(10_000, Math.max(1, query.page ?? 1));
    const limit = Math.min(100, Math.max(1, query.limit ?? 20));
    const now = new Date();
    const where: Prisma.StoryWhereInput = {};

    if (query.authorUserId) {
      const author = await this.prisma.user.findUnique({
        where: { userId: query.authorUserId },
        select: { id: true },
      });
      if (!author) {
        const empty = { stories: [], total: 0, page, limit };
        this.audit(
          adminId,
          `Listed Story records (page=${page}, limit=${limit}, author not found)`,
          'Story',
          '*',
          ipAddress,
          userAgent,
          undefined,
          { page, limit, authorUserId: query.authorUserId, total: 0 },
        );
        return empty;
      }
      where.authorId = author.id;
    }
    if (query.kind) where.kind = query.kind === 'image' ? StoryKind.IMAGE : StoryKind.TEXT;
    if (query.from && query.to && Date.parse(query.from) > Date.parse(query.to)) {
      throw new BadRequestException({
        code: 'VALIDATION_ERROR',
        message: 'from must be earlier than or equal to to',
      });
    }
    if (query.from || query.to) {
      where.createdAt = {
        ...(query.from ? { gte: new Date(query.from) } : {}),
        ...(query.to ? { lte: new Date(query.to) } : {}),
      };
    }
    switch (query.status ?? 'all') {
      case 'active':
        where.deletedAt = null;
        where.expiresAt = { gt: now };
        where.AND = [{ OR: [{ hiddenAt: null }, { hiddenUntil: { lte: now } }] }];
        break;
      case 'expired':
        where.deletedAt = null;
        where.expiresAt = { lte: now };
        break;
      case 'deleted':
        where.deletedAt = { not: null };
        break;
      case 'hidden':
        where.hiddenAt = { not: null };
        where.OR = [{ hiddenUntil: null }, { hiddenUntil: { gt: now } }];
        break;
      case 'banned':
        where.author = {
          storyFeatureBan: {
            isActive: true,
            OR: [{ bannedUntil: null }, { bannedUntil: { gt: now } }],
          },
        };
        break;
    }

    const [total, rows] = await Promise.all([
      this.prisma.story.count({ where }),
      this.prisma.story.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * limit,
        take: limit,
        include: {
          author: {
            select: {
              ...AUTHOR_SELECT,
              storyFeatureBan: { select: { isActive: true, bannedUntil: true } },
            },
          },
          _count: { select: { views: true, reactions: true } },
        },
      }),
    ]);
    const ids = rows.map(row => row.id);
    const [reports, replies] = ids.length
      ? await Promise.all([
          this.prisma.storyReport.groupBy({
            by: ['storyId'],
            where: { storyId: { in: ids } },
            _count: { _all: true },
          }),
          this.prisma.chatMessage.groupBy({
            by: ['storyId'],
            where: { storyId: { in: ids }, isDeleted: false },
            _count: { _all: true },
          }),
        ])
      : [[], []];
    const reportCount = new Map(reports.map(row => [row.storyId, row._count._all]));
    const replyCount = new Map(
      replies.flatMap(row => (row.storyId ? [[row.storyId, row._count._all] as const] : [])),
    );
    const stories = rows.map(row => ({
      id: row.id,
      author: {
        userId: row.author.userId,
        username: row.author.username ?? row.author.userId,
        fullName: row.author.fullName,
        avatarUrl: row.author.avatarUrl,
      },
      kind: row.kind === StoryKind.IMAGE ? 'image' : 'text',
      createdAt: row.createdAt.toISOString(),
      expiresAt: row.expiresAt.toISOString(),
      deletedAt: row.deletedAt?.toISOString() ?? null,
      hiddenAt: row.hiddenAt?.toISOString() ?? null,
      hiddenUntil: row.hiddenUntil?.toISOString() ?? null,
      featureBanned:
        !!row.author.storyFeatureBan?.isActive &&
        (!row.author.storyFeatureBan.bannedUntil || row.author.storyFeatureBan.bannedUntil > now),
      viewCount: row._count.views,
      reactionCount: row._count.reactions,
      replyCount: replyCount.get(row.id) ?? 0,
      reportCount: reportCount.get(row.id) ?? 0,
    }));
    const result = { stories, total, page, limit };
    this.audit(
      adminId,
      `Listed Story records (page=${page}, limit=${limit})`,
      'Story',
      '*',
      ipAddress,
      userAgent,
      undefined,
      {
        page,
        limit,
        status: query.status ?? 'all',
        kind: query.kind ?? null,
        authorUserId: query.authorUserId ?? null,
        total,
      },
    );
    return result;
  }

  async getMetrics(adminId: string, ipAddress: string, userAgent?: string): Promise<object> {
    const now = new Date();
    const since = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    const dayStart = new Date(now);
    dayStart.setUTCHours(0, 0, 0, 0);
    const [storiesToday, stories30Days, views30Days, reactions30Days, reports30Days, resolved] =
      await Promise.all([
        this.prisma.story.count({ where: { createdAt: { gte: dayStart } } }),
        this.prisma.story.count({ where: { createdAt: { gte: since } } }),
        this.prisma.storyView.count({ where: { story: { createdAt: { gte: since } } } }),
        this.prisma.storyReaction.count({ where: { story: { createdAt: { gte: since } } } }),
        this.prisma.storyReport.count({ where: { createdAt: { gte: since } } }),
        this.prisma.storyReport.findMany({
          where: {
            status: { in: ['RESOLVED_ACTION', 'RESOLVED_DISMISSED'] },
            reviewedAt: { not: null },
          },
          select: { createdAt: true, reviewedAt: true },
          take: 5000,
        }),
      ]);
    const averageResolutionHours = resolved.length
      ? resolved.reduce(
          (sum, row) => sum + (row.reviewedAt!.getTime() - row.createdAt.getTime()) / 3_600_000,
          0,
        ) / resolved.length
      : 0;
    const result = {
      storiesToday,
      storiesLast30Days: stories30Days,
      averageViewersPerStory: stories30Days ? Number((views30Days / stories30Days).toFixed(2)) : 0,
      reactionRate: views30Days ? Number((reactions30Days / views30Days).toFixed(4)) : 0,
      reportsPer1000Stories: stories30Days
        ? Number(((reports30Days / stories30Days) * 1000).toFixed(2))
        : 0,
      averageReportResolutionHours: Number(averageResolutionHours.toFixed(2)),
    };
    this.audit(
      adminId,
      'Viewed Story moderation metrics',
      'StoryMetrics',
      '*',
      ipAddress,
      userAgent,
      undefined,
      result,
    );
    return result;
  }

  async getStoryDetail(
    storyId: string,
    adminId: string,
    ipAddress: string,
    userAgent?: string,
  ): Promise<unknown> {
    const data = await this.stories.getAdminStoryRecord(storyId);
    this.audit(
      adminId,
      'Viewed Story content and audience',
      'Story',
      storyId,
      ipAddress,
      userAgent,
    );
    return data;
  }

  async getStoryViewers(
    storyId: string,
    page: number,
    limit: number,
    adminId: string,
    ipAddress: string,
    userAgent?: string,
  ): Promise<object> {
    const data = await this.stories.getAdminStoryViewers(storyId, page, limit);
    this.audit(
      adminId,
      `Viewed Story viewers (page=${page}, limit=${limit})`,
      'Story',
      storyId,
      ipAddress,
      userAgent,
    );
    return data;
  }

  async getStoryReplies(
    storyId: string,
    adminId: string,
    ipAddress: string,
    userAgent?: string,
  ): Promise<object> {
    const data = await this.stories.getAdminStoryReplies(storyId);
    this.audit(
      adminId,
      'Viewed Story reply history while report is open',
      'Story',
      storyId,
      ipAddress,
      userAgent,
    );
    return data;
  }

  async deleteStory(
    storyId: string,
    dto: AdminStoryReasonDto,
    adminId: string,
    ipAddress: string,
    userAgent?: string,
  ): Promise<{ deleted: true }> {
    const before = await this.prisma.story.findUnique({
      where: { id: storyId },
      select: { id: true, authorId: true, kind: true, mediaKey: true, expiresAt: true },
    });
    if (!before)
      throw new NotFoundException({ code: 'STORY_NOT_FOUND', message: 'Story tidak ditemukan.' });
    await this.stories.adminDeleteStory(storyId);
    this.audit(
      adminId,
      `Deleted Story: ${dto.reason}`,
      'Story',
      storyId,
      ipAddress,
      userAgent,
      before,
      { deleted: true, reason: dto.reason },
    );
    return { deleted: true };
  }

  async hideStory(
    storyId: string,
    dto: HideStoryDto,
    adminId: string,
    ipAddress: string,
    userAgent?: string,
  ): Promise<object> {
    const durationDays = dto.durationDays ?? 7;
    const hiddenUntil = new Date(Date.now() + durationDays * 24 * 60 * 60 * 1000);
    await this.stories.adminHideStory(storyId, adminId, dto.reason, hiddenUntil);
    this.audit(
      adminId,
      `Temporarily hid Story for ${durationDays} day(s): ${dto.reason}`,
      'Story',
      storyId,
      ipAddress,
      userAgent,
      undefined,
      { hiddenUntil: hiddenUntil.toISOString(), reason: dto.reason },
    );
    return { storyId, hidden: true, hiddenUntil: hiddenUntil.toISOString() };
  }

  async restoreStory(
    storyId: string,
    adminId: string,
    ipAddress: string,
    userAgent?: string,
  ): Promise<object> {
    await this.stories.adminRestoreStory(storyId);
    this.audit(
      adminId,
      'Restored hidden Story',
      'Story',
      storyId,
      ipAddress,
      userAgent,
      undefined,
      { restored: true },
    );
    return { storyId, restored: true };
  }

  async banStoryFeature(
    userPublicId: string,
    dto: BanStoryFeatureDto,
    adminId: string,
    ipAddress: string,
    userAgent?: string,
  ): Promise<object> {
    const result = await this.stories.adminBanStoryFeature(
      userPublicId,
      adminId,
      dto.reason,
      dto.durationDays,
    );
    this.audit(
      adminId,
      `Banned user from Story feature: ${dto.reason}`,
      'StoryFeatureBan',
      userPublicId,
      ipAddress,
      userAgent,
      undefined,
      {
        durationDays: dto.durationDays ?? null,
        bannedUntil: result.bannedUntil?.toISOString() ?? null,
        reason: dto.reason,
      },
    );
    return { userId: userPublicId, bannedUntil: result.bannedUntil?.toISOString() ?? null };
  }

  async unbanStoryFeature(
    userPublicId: string,
    adminId: string,
    ipAddress: string,
    userAgent?: string,
  ): Promise<object> {
    await this.stories.adminUnbanStoryFeature(userPublicId);
    this.audit(
      adminId,
      'Removed Story feature ban',
      'StoryFeatureBan',
      userPublicId,
      ipAddress,
      userAgent,
      undefined,
      { isActive: false },
    );
    return { userId: userPublicId, isBanned: false };
  }

  async listReports(
    query: AdminStoryReportListQueryDto,
    adminId: string,
    ipAddress: string,
    userAgent?: string,
  ): Promise<object> {
    const page = Math.min(10_000, Math.max(1, query.page ?? 1));
    const limit = Math.min(100, Math.max(1, query.limit ?? 20));
    const status = reportStatusFromApi(query.status);
    const where: Prisma.StoryReportWhereInput = status ? { status } : {};
    const [total, rows] = await Promise.all([
      this.prisma.storyReport.count({ where }),
      this.prisma.storyReport.findMany({
        where,
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        skip: (page - 1) * limit,
        take: limit,
        include: { reporter: { select: AUTHOR_SELECT } },
      }),
    ]);
    const reports = await Promise.all(rows.map(row => this.serializeReport(row)));
    const result = { reports, total, page, limit };
    this.audit(
      adminId,
      `Listed Story reports (page=${page}, limit=${limit}, status=${query.status ?? 'all'})`,
      'StoryReportQueue',
      '*',
      ipAddress,
      userAgent,
      undefined,
      { page, limit, status: query.status ?? 'all', total },
    );
    return result;
  }

  async getReport(
    reportId: string,
    adminId: string,
    ipAddress: string,
    userAgent?: string,
  ): Promise<unknown> {
    const report = await this.prisma.storyReport.findUnique({
      where: { id: reportId },
      include: { reporter: { select: AUTHOR_SELECT } },
    });
    if (!report)
      throw new NotFoundException({
        code: 'STORY_REPORT_NOT_FOUND',
        message: 'Laporan story tidak ditemukan.',
      });
    const data = await this.serializeReport(report);
    this.audit(
      adminId,
      'Viewed Story report detail and snapshot',
      'StoryReport',
      reportId,
      ipAddress,
      userAgent,
    );
    return data;
  }

  async reviewReport(
    reportId: string,
    dto: ReviewStoryReportDto,
    adminId: string,
    ipAddress: string,
    userAgent?: string,
  ): Promise<object> {
    const report = await this.prisma.storyReport.findUnique({ where: { id: reportId } });
    if (!report)
      throw new NotFoundException({
        code: 'STORY_REPORT_NOT_FOUND',
        message: 'Laporan story tidak ditemukan.',
      });
    if (report.status === 'RESOLVED_ACTION' || report.status === 'RESOLVED_DISMISSED') {
      throw new ConflictException({
        code: 'STORY_REPORT_ALREADY_RESOLVED',
        message: 'Laporan story sudah diselesaikan.',
      });
    }

    const before = { status: report.status, internalNote: report.internalNote };
    const now = new Date();
    let status: StoryReportStatus;
    if (dto.action === 'in_review') {
      status = 'IN_REVIEW';
    } else if (dto.action === 'dismiss') {
      status = 'RESOLVED_DISMISSED';
    } else {
      status = 'RESOLVED_ACTION';
      if (dto.action === 'delete') {
        await this.stories.adminDeleteStory(report.storyId).catch((error: unknown) => {
          if (!(error instanceof NotFoundException)) throw error;
        });
      } else if (dto.action === 'hide') {
        const durationDays = dto.durationDays ?? 7;
        await this.stories
          .adminHideStory(
            report.storyId,
            adminId,
            dto.internalNote,
            new Date(now.getTime() + durationDays * 24 * 60 * 60 * 1000),
          )
          .catch((error: unknown) => {
            if (!(error instanceof NotFoundException)) throw error;
          });
      } else if (dto.action === 'ban') {
        const author = await this.prisma.user.findUnique({
          where: { id: report.authorId },
          select: { userId: true },
        });
        if (author)
          await this.stories.adminBanStoryFeature(
            author.userId,
            adminId,
            dto.internalNote,
            dto.durationDays,
          );
      }
    }

    const updated = await this.prisma.storyReport.update({
      where: { id: reportId },
      data: {
        status,
        internalNote: dto.internalNote,
        reviewedByAdminId: adminId,
        reviewedAt: now,
      },
    });
    this.audit(
      adminId,
      `Story report ${reportId}: ${dto.action}`,
      'StoryReport',
      reportId,
      ipAddress,
      userAgent,
      before,
      { status, action: dto.action, internalNote: dto.internalNote },
    );
    this.notifyReporter(reportId, report.reporterId, status);
    return {
      reportId: updated.id,
      storyId: updated.storyId,
      status: apiReportStatus(updated.status),
      reviewedAt: updated.reviewedAt?.toISOString() ?? null,
    };
  }

  private async serializeReport(report: {
    id: string;
    storyId: string;
    authorId: string;
    reporterId: string;
    category: string;
    note: string | null;
    storySnapshot: Prisma.JsonValue;
    status: StoryReportStatus;
    internalNote: string | null;
    reviewedByAdminId: string | null;
    reviewedAt: Date | null;
    createdAt: Date;
    reporter?: {
      id: string;
      userId: string;
      username: string | null;
      fullName: string;
      avatarUrl: string | null;
    };
  }): Promise<object> {
    const snapshot = jsonRecord(report.storySnapshot) ?? {};
    const mediaKey = typeof snapshot.mediaKey === 'string' ? snapshot.mediaKey : null;
    const mediaUrl = mediaKey
      ? await this.upload.generateDownloadUrl(mediaKey, 900).catch(() => null)
      : null;
    const cleanSnapshot = { ...snapshot, mediaKey: undefined, mediaUrl };
    return {
      id: report.id,
      storyId: report.storyId,
      authorId: report.authorId,
      reporter: report.reporter
        ? {
            userId: report.reporter.userId,
            username: report.reporter.username ?? report.reporter.userId,
            fullName: report.reporter.fullName,
            avatarUrl: report.reporter.avatarUrl,
          }
        : null,
      category: report.category.toLowerCase(),
      note: report.note,
      storySnapshot: cleanSnapshot,
      status: apiReportStatus(report.status),
      internalNote: report.internalNote,
      reviewedByAdminId: report.reviewedByAdminId,
      reviewedAt: report.reviewedAt?.toISOString() ?? null,
      createdAt: report.createdAt.toISOString(),
      ageHours: Number(((Date.now() - report.createdAt.getTime()) / 3_600_000).toFixed(2)),
    };
  }

  private notifyReporter(reportId: string, reporterId: string, status: StoryReportStatus): void {
    const type = NotificationType.MODERATION_REPORT_UPDATE;
    const title = 'Update laporan story Anda';
    const statusText =
      status === 'IN_REVIEW'
        ? 'sedang ditinjau'
        : status === 'RESOLVED_ACTION'
          ? 'telah ditindaklanjuti'
          : 'telah ditinjau';
    const body = `Laporan story Anda ${statusText}. Terima kasih telah membantu menjaga keamanan Kahade.`;
    this.prisma.notification
      .create({
        data: {
          notifId: generateNotifId(),
          userId: reporterId,
          type,
          category: getCategoryForType(type),
          title,
          body,
          refType: 'StoryReport',
          refId: reportId,
        },
      })
      .catch((error: unknown) =>
        this.logger.warn(
          `Story report notification failed: ${error instanceof Error ? error.message : String(error)}`,
        ),
      );
    try {
      this.prisma.emitNotificationCreated({
        userId: reporterId,
        title,
        body,
        data: { type, refId: reportId },
      });
    } catch (error) {
      this.logger.warn(
        `Story report notification event failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private audit(
    adminId: string,
    description: string,
    targetType: string,
    targetId: string,
    ipAddress: string,
    userAgent?: string,
    before?: Record<string, unknown>,
    after?: Record<string, unknown>,
  ): void {
    this.auditLog.logAdminAction({
      adminId,
      action: AuditAction.ADMIN_ACTION,
      targetType,
      targetId,
      description,
      ...(before ? { before } : {}),
      ...(after ? { after } : {}),
      ipAddress: ipAddress || 'unknown',
      userAgent,
    });
  }
}
