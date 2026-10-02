import { Injectable, NotFoundException, BadRequestException, Logger } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { AuditLogService } from '../../../common/services/audit-log.service';
import { createPaginatedResponse } from '../../../common/dto/pagination.dto';
import { ChatService } from '../../chat/chat.service';
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
    private chatService: ChatService,
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

    // H1 (aturan keras privasi DM): room INQUIRY adalah DM privat — admin
    // hanya boleh melihat METADATA (tanpa snippet isi pesan). Room ORDER
    // (chat transaksi/dispute) tetap menampilkan snippet untuk moderasi.
    const sanitized = events.map((event) =>
      event.room?.type === 'INQUIRY' ? { ...event, snippet: null } : event,
    );

    return createPaginatedResponse(sanitized, total, safePage, safeLimit);
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
        messageId: true,
        // Audit 2026-10-03 (BAD-007): roomId eksplisit di detail agar tombol
        // "Lihat room" panel admin bisa tampil tanpa parse dari objek room.
        roomId: true,
        user: {
          select: {
            id: true,
            userId: true,
            fullName: true,
            username: true,
            flaggedForReview: true,
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
    const message = event.messageId
      ? await this.prisma.chatMessage.findUnique({
          where: { id: event.messageId },
          select: {
            id: true,
            content: true,
            messageType: true,
            isDeleted: true,
            isEdited: true,
            createdAt: true,
          },
        })
      : null;
    // H1 (aturan keras privasi DM): room INQUIRY adalah DM privat — admin
    // hanya boleh melihat METADATA (tanpa snippet & tanpa content pesan).
    // Room ORDER (chat transaksi/dispute) tetap menampilkan isi untuk moderasi.
    if (event.room?.type === 'INQUIRY') {
      return {
        ...event,
        snippet: null,
        message: message ? { ...message, content: null } : null,
      };
    }
    return { ...event, message };
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
        // Audit 2026-10-03 (BAD-007): roomId agar tombol "Lihat room" bisa tampil.
        roomId: true,
      },
    });
    const circumventionCount = events.filter(e => e.kind === 'CIRCUMVENTION').length;
    return { userId, total: events.length, circumventionCount, events };
  }

  /**
   * ADM-115 — resolve room chat dari orderId publik untuk admin.
   * Hanya mengembalikan room bertipe ORDER; room INQUIRY (DM pribadi)
   * tidak pernah tertaut ke order sehingga tidak bisa bocor lewat sini.
   * Akses isi pesan tetap lewat getRoomMessagesForAdmin yang melempar 403
   * untuk non-ORDER (privasi DM terjaga).
   */
  async getRoomIdByOrder(orderId: string, adminId: string, ipAddress: string): Promise<object> {
    const order = await this.prisma.order.findFirst({
      where: { OR: [{ id: orderId }, { orderId }] },
      select: { id: true, orderId: true },
    });
    if (!order) {
      throw new NotFoundException({
        code: ErrorCodes.NOT_FOUND,
        message: 'Order not found',
      });
    }
    const room = await this.prisma.chatRoom.findFirst({
      where: { orderId: order.id, type: 'ORDER' },
      select: { id: true },
    });
    this.auditLog.logAdminAction({
      adminId,
      action: AuditAction.ADMIN_ACTION,
      targetType: 'Order',
      targetId: order.orderId,
      description: `Admin looked up chat room for order ${order.orderId}`,
      after: { roomId: room?.id ?? null },
      ipAddress,
    });
    if (!room) {
      throw new NotFoundException({
        code: ErrorCodes.NOT_FOUND,
        message: 'No transaction chat room found for this order',
      });
    }
    return { roomId: room.id, orderDbId: order.id, orderId: order.orderId };
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

  /**
   * Audit 2026-10-03 (FAL-003): detail polling untuk Trust & Safety —
   * hasil vote per opsi agar polling manipulatif/spam bisa ditinjau.
   */
  async getPollDetail(pollId: string): Promise<object> {
    const poll = await this.prisma.chatPoll.findUnique({
      where: { id: pollId },
      select: {
        id: true,
        roomId: true,
        question: true,
        options: true,
        isClosed: true,
        createdAt: true,
        createdBy: { select: { userId: true, fullName: true } },
        votes: { select: { userId: true, optionIndex: true } },
      },
    });
    if (!poll) {
      throw new NotFoundException({ code: ErrorCodes.CHAT_POLL_NOT_FOUND, message: 'Poll not found' });
    }
    const options = (poll.options as string[]) ?? [];
    const voteCounts = new Array(options.length).fill(0) as number[];
    const voters = new Set<string>();
    for (const vote of poll.votes) {
      if (vote.optionIndex >= 0 && vote.optionIndex < voteCounts.length) {
        voteCounts[vote.optionIndex] += 1;
      }
      voters.add(vote.userId);
    }
    return {
      poll: {
        id: poll.id,
        question: poll.question,
        options: options.map((text, index) => ({
          id: index,
          text,
          voteCount: voteCounts[index] ?? 0,
        })),
        totalVotes: voters.size,
        isClosed: poll.isClosed,
        createdAt: poll.createdAt,
        createdBy: poll.createdBy,
        roomId: poll.roomId,
      },
    };
  }

  /**
   * Audit 2026-10-03 (FAL-003): penutupan paksa polling bermasalah oleh admin.
   * Dicatat di audit log admin (sebelum & sesudah status).
   */
  async closePollForAdmin(pollId: string, adminId: string, ipAddress: string): Promise<object> {
    const before = await this.prisma.chatPoll.findUnique({
      where: { id: pollId },
      select: { id: true, question: true, isClosed: true, roomId: true },
    });
    if (!before) {
      throw new NotFoundException({ code: ErrorCodes.CHAT_POLL_NOT_FOUND, message: 'Poll not found' });
    }
    await this.chatService.closePollByAdmin(pollId);
    this.auditLog.logAdminAction({
      adminId,
      action: AuditAction.ADMIN_ACTION,
      targetType: 'ChatPoll',
      targetId: pollId,
      description: `Admin force-closed poll ${pollId} (room ${before.roomId})`,
      before: { isClosed: before.isClosed },
      after: { isClosed: true },
      ipAddress,
    });
    this.logger.log(`Chat poll ${pollId} force-closed by admin ${adminId}`);
    return { ok: true };
  }
}
