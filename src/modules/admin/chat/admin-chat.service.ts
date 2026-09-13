import { Injectable, NotFoundException, BadRequestException, Logger } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { AuditLogService } from '../../../common/services/audit-log.service';
import { createPaginatedResponse } from '../../../common/dto/pagination.dto';
import {
  AuditAction,
  ChatModerationAction,
  ChatModerationKind,
  ChatModerationSeverity,
  ChatModerationStatus,
} from '@prisma/client';
import * as ErrorCodes from '../../../common/constants/error-codes';

const MAX_ADMIN_PAGE = 100_000;
const MAX_ADMIN_LIMIT = 100;

const STATUSES: ChatModerationStatus[] = ['PENDING', 'REVIEWED', 'DISMISSED', 'ACTIONED'];
const SEVERITIES: ChatModerationSeverity[] = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];
const ACTIONS: ChatModerationAction[] = ['BLOCKED', 'REDACTED', 'FLAGGED'];
const KINDS: ChatModerationKind[] = ['CIRCUMVENTION', 'CONTACT_SHARING', 'PROFANITY', 'SPAM'];

export interface ModerationEventQuery {
  page?: number;
  limit?: number;
  status?: string;
  severity?: string;
  action?: string;
  kind?: string;
}

/**
 * Antrean moderasi chat.
 *
 * Mengapa perlu modul sendiri: pesan yang DIBLOKIR tidak pernah tersimpan di
 * `chat_messages`, sehingga `chat_moderation_events` adalah satu-satunya jejak
 * yang bisa ditinjau admin. Tanpa antrean ini, detektor circumvention berjalan
 * buta — kita tidak akan tahu berapa banyak percobaan yang dicegah, dan tidak
 * punya cara menemukan false positive yang membuat user frustrasi.
 */
@Injectable()
export class AdminChatService {
  private readonly logger = new Logger(AdminChatService.name);

  constructor(
    private prisma: PrismaService,
    private auditLog: AuditLogService,
  ) {}

  async listModerationEvents(query: ModerationEventQuery): Promise<object> {
    const safeLimit = Math.min(Math.max(query.limit ?? 20, 1), MAX_ADMIN_LIMIT);
    const safePage = Math.min(Math.max(query.page ?? 1, 1), MAX_ADMIN_PAGE);
    const skip = (safePage - 1) * safeLimit;

    const where: Record<string, unknown> = {};
    if (query.status) where.status = this.pickEnum(query.status, STATUSES, 'status');
    if (query.severity) where.severity = this.pickEnum(query.severity, SEVERITIES, 'severity');
    if (query.action) where.action = this.pickEnum(query.action, ACTIONS, 'action');
    if (query.kind) where.kind = this.pickEnum(query.kind, KINDS, 'kind');

    const [events, total] = await Promise.all([
      this.prisma.chatModerationEvent.findMany({
        where,
        skip,
        take: safeLimit,
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          eventId: true,
          kind: true,
          severity: true,
          action: true,
          matchers: true,
          snippet: true,
          status: true,
          createdAt: true,
          user: {
            select: { userId: true, fullName: true, username: true, flaggedForReview: true },
          },
          room: {
            select: {
              id: true,
              type: true,
              order: { select: { orderId: true, title: true, status: true } },
            },
          },
        },
      }),
      this.prisma.chatModerationEvent.count({ where }),
    ]);

    return createPaginatedResponse(events, total, safePage, safeLimit);
  }

  /** Ringkasan untuk kartu dashboard Trust & Safety. */
  async getModerationStats(): Promise<object> {
    const [pending, severityRows, actionRows, last24h] = await Promise.all([
      this.prisma.chatModerationEvent.count({ where: { status: 'PENDING' } }),
      this.prisma.chatModerationEvent.groupBy({ by: ['severity'], _count: { _all: true } }),
      this.prisma.chatModerationEvent.groupBy({ by: ['action'], _count: { _all: true } }),
      this.prisma.chatModerationEvent.count({
        where: { createdAt: { gte: new Date(Date.now() - 24 * 3600_000) } },
      }),
    ]);

    const bySeverity = severityRows as Array<{
      severity: ChatModerationSeverity;
      _count: { _all: number };
    }>;
    const byAction = actionRows as Array<{
      action: ChatModerationAction;
      _count: { _all: number };
    }>;

    const severity = SEVERITIES.reduce<Record<string, number>>((acc, key) => {
      acc[key] = bySeverity.find(row => row.severity === key)?._count?._all ?? 0;
      return acc;
    }, {});
    const action = ACTIONS.reduce<Record<string, number>>((acc, key) => {
      acc[key] = byAction.find(row => row.action === key)?._count?._all ?? 0;
      return acc;
    }, {});

    return { pending, last24h, severity, action };
  }

  async getModerationEventDetail(eventId: string): Promise<object> {
    const event = await this.prisma.chatModerationEvent.findFirst({
      where: { OR: [{ id: eventId }, { eventId }] },
      select: {
        id: true,
        eventId: true,
        kind: true,
        severity: true,
        action: true,
        matchers: true,
        snippet: true,
        status: true,
        reviewedById: true,
        reviewedAt: true,
        reviewNote: true,
        createdAt: true,
        updatedAt: true,
        user: {
          select: {
            id: true,
            userId: true,
            fullName: true,
            username: true,
            flaggedForReview: true,
          },
        },
        message: {
          select: {
            id: true,
            content: true,
            messageType: true,
            isDeleted: true,
            isEdited: true,
            createdAt: true,
          },
        },
        room: {
          select: {
            id: true,
            type: true,
            subject: true,
            initiatorId: true,
            counterpartId: true,
            order: { select: { orderId: true, title: true, status: true } },
          },
        },
      },
    });
    if (!event) {
      throw new NotFoundException({
        code: ErrorCodes.NOT_FOUND,
        message: 'Moderation event not found',
      });
    }
    return event;
  }

  async reviewModerationEvent(
    eventId: string,
    adminId: string,
    status: ChatModerationStatus,
    note: string | undefined,
    ipAddress: string,
  ): Promise<object> {
    const event = await this.prisma.chatModerationEvent.findFirst({
      where: { OR: [{ id: eventId }, { eventId }] },
      select: { id: true, eventId: true, status: true, action: true },
    });
    if (!event) {
      throw new NotFoundException({
        code: ErrorCodes.NOT_FOUND,
        message: 'Moderation event not found',
      });
    }

    const updated = await this.prisma.chatModerationEvent.update({
      where: { id: event.id },
      data: {
        status,
        reviewedById: adminId,
        reviewedAt: new Date(),
        reviewNote: note ? note.slice(0, 500) : null,
      },
      select: { id: true, eventId: true, status: true, reviewedAt: true },
    });

    this.auditLog.logAdminAction({
      adminId,
      action: AuditAction.ADMIN_ACTION,
      targetType: 'ChatModerationEvent',
      targetId: event.eventId,
      description: `Chat moderation event ${event.eventId} marked ${status}`,
      before: { status: event.status },
      after: { status, note: note ?? null },
      ipAddress,
    });

    this.logger.log(`Chat moderation event ${event.eventId} -> ${status} by admin ${adminId}`);
    return updated;
  }

  /**
   * Riwayat moderasi satu user. Dipakai untuk melihat apakah seseorang
   * berulang kali mencoba transaksi di luar aplikasi — sinyal yang jauh lebih
   * kuat daripada satu pesan yang keblokir.
   */
  async listUserModerationEvents(userId: string, limit: number = 50): Promise<object> {
    const events = await this.prisma.chatModerationEvent.findMany({
      where: { userId },
      take: Math.min(Math.max(limit, 1), MAX_ADMIN_LIMIT),
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        eventId: true,
        kind: true,
        severity: true,
        action: true,
        status: true,
        createdAt: true,
        roomId: true,
      },
    });
    const circumventionCount = events.filter(e => e.kind === 'CIRCUMVENTION').length;
    return { userId, total: events.length, circumventionCount, events };
  }

  private pickEnum<T extends string>(value: string, allowed: readonly T[], label: string): T {
    const normalized = value.toUpperCase() as T;
    if (!allowed.includes(normalized)) {
      throw new BadRequestException({
        code: ErrorCodes.INVALID_STATUS,
        message: `Invalid ${label}: ${value}. Valid values: ${allowed.join(', ')}`,
      });
    }
    return normalized;
  }
}
