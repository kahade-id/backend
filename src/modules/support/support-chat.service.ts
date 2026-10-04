import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import {
  AdminRole,
  NotificationType,
  Prisma,
  SupportConversationStatus,
  SupportMessageSenderType,
  SupportTicketSource,
  SupportTicketStatus,
} from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { RealtimeService } from '../realtime/realtime.service';
import { RedisService } from '../../redis/redis.service';
import { UploadService } from '../upload/upload.service';
import { UploadPurpose } from '../upload/dto/presigned-url.dto';
import { AuditLogService } from '../../common/services/audit-log.service';
import { SubscriptionsService } from '../subscriptions/subscriptions.service';
import { AuditAction } from '@prisma/client';
import * as ErrorCodes from '../../common/constants/error-codes';
import { generateNotifId } from '../../common/utils/id-generator.util';
import { getCategoryForType } from '../notifications/notification-category.map';
import { renderNotificationCopy, resolveNotificationLanguage } from '../notifications/notification-copy.service';

// AGENTS.md (quirk jest + Prisma): enum BARU hasil `prisma generate` bernilai
// `undefined` bila di-import sebagai nilai di jest (spread berlapis di module
// registry). Untuk nilai enum baru (SupportConversation*, SupportTicketSource)
// pakai literal string yang di-cast — Prisma menerima string untuk field enum.
// Enum LAMA (SupportTicketStatus, NotificationType, AdminRole) aman di-import
// sebagai nilai.
const CONV_WAITING = 'WAITING' as SupportConversationStatus;
const CONV_ASSIGNED = 'ASSIGNED' as SupportConversationStatus;
const CONV_OPEN = 'OPEN' as SupportConversationStatus;
const CONV_CLOSED = 'CLOSED' as SupportConversationStatus;
const SENDER_USER = 'USER' as SupportMessageSenderType;
const SENDER_AGENT = 'AGENT' as SupportMessageSenderType;
const SENDER_SYSTEM = 'SYSTEM' as SupportMessageSenderType;
const SOURCE_APP = 'APP' as SupportTicketSource;
const SOURCE_HELP_SITE = 'HELP_SITE' as SupportTicketSource;
const SOURCE_CHAT_ESCALATION = 'CHAT_ESCALATION' as SupportTicketSource;

const ACTIVE_CONV_STATUSES = [CONV_WAITING, CONV_ASSIGNED, CONV_OPEN];
const MAX_MESSAGE_LENGTH = 5000;
const MAX_ATTACHMENTS = 5;
const AGENT_AVAILABILITY_TTL_SECONDS = 12 * 60 * 60;
const AGENT_AVAILABLE_KEY = (adminId: string) => `support:agent:available:${adminId}`;

export type SupportSource = 'APP' | 'HELP_SITE';

export interface SupportMessageView {
  id: string;
  conversationId: string;
  senderType: SupportMessageSenderType;
  senderId: string | null;
  senderName: string | null;
  content: string | null;
  attachments: string[];
  createdAt: Date;
}

function sanitize(text: string): string {
  return text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').trim();
}

/**
 * POIN 5 (2026-10-04) — livechat support websocket penuh.
 *
 * Percakapan: user ↔ agen (AdminUser CUSTOMER_SUPPORT/SUPER_ADMIN).
 * Alur status: WAITING → ASSIGNED → OPEN → CLOSED.
 * Tiket HANYA dibuat admin via escalateToTicket (endpoint user
 * POST /v1/support/tickets dicabut).
 */
@Injectable()
export class SupportChatService {
  private readonly logger = new Logger(SupportChatService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly realtime: RealtimeService,
    private readonly redis: RedisService,
    private readonly uploadService: UploadService,
    private readonly auditLog: AuditLogService,
    private readonly subscriptionsService: SubscriptionsService,
  ) {}

  // ---------------------------------------------------------- percakapan ---

  /**
   * Idempoten: satu user hanya punya SATU percakapan aktif. Bila sudah ada
   * (WAITING/ASSIGNED/OPEN), kembalikan itu — cegah duplikat antrean saat
   * user menekan "hubungi support" berkali-kali.
   */
  async getOrCreateConversation(
    userId: string,
    source: SupportSource = 'APP',
    subject?: string,
  ): Promise<{ conversation: Record<string, unknown>; created: boolean }> {
    const existing = await this.prisma.supportConversation.findFirst({
      where: { userId, status: { in: ACTIVE_CONV_STATUSES } },
      include: { assignedAgent: { select: { id: true, fullName: true } } },
    });
    if (existing) return { conversation: this.toConversationView(existing), created: false };

    const priority = await this.subscriptionsService.isActive(userId).catch(() => false);
    const created = await this.prisma.supportConversation.create({
      data: {
        userId,
        status: CONV_WAITING,
        source: (source === 'HELP_SITE' ? SOURCE_HELP_SITE : SOURCE_APP),
        subject: subject ? sanitize(subject).slice(0, 200) || null : null,
        priority,
      },
      include: { assignedAgent: { select: { id: true, fullName: true } } },
    });
    await this.sendSystemMessageInternal(created.id, 'Percakapan dibuat. Menunggu agen support tersedia.');
    this.realtime.emitToSupportAgents('support.queue.changed', {
      conversationId: created.id,
      status: created.status,
      change: 'created',
    });
    return { conversation: this.toConversationView(created), created: true };
  }

  async listMyConversations(userId: string): Promise<Record<string, unknown>[]> {
    const rows = await this.prisma.supportConversation.findMany({
      where: { userId },
      orderBy: { updatedAt: 'desc' },
      take: 20,
      include: {
        assignedAgent: { select: { id: true, fullName: true } },
        messages: { orderBy: { createdAt: 'desc' }, take: 1 },
      },
    });
    return rows.map((c) => ({
      ...this.toConversationView(c),
      lastMessage: c.messages[0] ? this.toMessageView(c.messages[0] as never) : null,
    }));
  }

  async getConversationForUser(userId: string, conversationId: string): Promise<Record<string, unknown>> {
    const conv = await this.prisma.supportConversation.findUnique({
      where: { id: conversationId },
      include: { assignedAgent: { select: { id: true, fullName: true } } },
    });
    if (!conv) throw new NotFoundException({ code: ErrorCodes.NOT_FOUND, message: 'Conversation not found' });
    if (conv.userId !== userId) throw new ForbiddenException({ code: ErrorCodes.FORBIDDEN, message: 'Not authorized' });
    return this.toConversationView(conv);
  }

  async getConversationForAdmin(conversationId: string): Promise<Record<string, unknown>> {
    const conv = await this.prisma.supportConversation.findUnique({
      where: { id: conversationId },
      include: {
        assignedAgent: { select: { id: true, fullName: true } },
        user: { select: { id: true, username: true, fullName: true } },
      },
    });
    if (!conv) throw new NotFoundException({ code: ErrorCodes.NOT_FOUND, message: 'Conversation not found' });
    return this.toConversationView(conv);
  }

  /** Antrean agen: WAITING dulu (prioritas Kahade+ → FIFO), lalu status lain. */
  async getQueue(status: string | undefined, page = 1, limit = 20): Promise<{ data: Record<string, unknown>[]; total: number; page: number; limit: number }> {
    const safeLimit = Math.min(Math.max(1, Math.floor(limit)), 50);
    const safePage = Math.max(1, Math.floor(page));
    const where: Prisma.SupportConversationWhereInput = status
      ? { status: status as SupportConversationStatus }
      : { status: { in: ACTIVE_CONV_STATUSES } };
    const [rows, total] = await Promise.all([
      this.prisma.supportConversation.findMany({
        where,
        // Prioritas dulu, lalu yang paling lama menunggu.
        orderBy: [{ priority: 'desc' }, { createdAt: 'asc' }],
        skip: (safePage - 1) * safeLimit,
        take: safeLimit,
        include: {
          assignedAgent: { select: { id: true, fullName: true } },
          user: { select: { id: true, username: true, fullName: true } },
          messages: { orderBy: { createdAt: 'desc' }, take: 1 },
        },
      }),
      this.prisma.supportConversation.count({ where }),
    ]);
    return {
      data: rows.map((c, i) => ({
        ...this.toConversationView(c),
        queuePosition: !status || status === 'WAITING' ? (safePage - 1) * safeLimit + i + 1 : null,
        lastMessage: c.messages[0] ? this.toMessageView(c.messages[0] as never) : null,
      })),
      total,
      page: safePage,
      limit: safeLimit,
    };
  }

  /** Posisi antrean percakapan WAITING milik user (untuk ditampilkan di UI). */
  async getQueuePosition(conversationId: string): Promise<number | null> {
    const conv = await this.prisma.supportConversation.findUnique({
      where: { id: conversationId },
      select: { status: true, priority: true, createdAt: true },
    });
    if (!conv || conv.status !== ('WAITING' as SupportConversationStatus)) return null;
    // Jumlah WAITING yang didahulukan: semua prioritas mendahului non-prioritas;
    // dalam prioritas yang sama, yang dibuat lebih dulu mendahului.
    const aheadCount = await this.prisma.supportConversation.count({
      where: {
        status: CONV_WAITING,
        OR: conv.priority
          ? [{ priority: true, createdAt: { lt: conv.createdAt } }]
          : [{ priority: true }, { priority: false, createdAt: { lt: conv.createdAt } }],
      },
    });
    return aheadCount + 1;
  }

  // --------------------------------------------------------------- pesan ---

  async getMessages(
    conversationId: string,
    viewer: { kind: 'user'; id: string } | { kind: 'admin'; id: string },
    cursor?: string,
    limit = 30,
  ): Promise<{ data: SupportMessageView[]; nextCursor: string | null }> {
    await this.assertCanAccess(conversationId, viewer);
    const safeLimit = Math.min(Math.max(1, Math.floor(limit)), 100);
    const rows = await this.prisma.supportMessage.findMany({
      where: {
        conversationId,
        ...(cursor ? { createdAt: { lt: new Date(cursor) }, id: { not: cursor } } : {}),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: safeLimit + 1,
      include: {
        senderUser: { select: { id: true, username: true, fullName: true } },
        senderAdmin: { select: { id: true, fullName: true } },
      },
    });
    const hasMore = rows.length > safeLimit;
    const page = (hasMore ? rows.slice(0, safeLimit) : rows).reverse();
    const last = page[0];
    return {
      data: page.map((m) => this.toMessageView(m as never)),
      nextCursor: hasMore && last ? (last.createdAt as Date).toISOString() : null,
    };
  }

  async sendUserMessage(
    userId: string,
    conversationId: string,
    content: string | undefined,
    attachments: string[] | undefined,
  ): Promise<SupportMessageView> {
    const conv = await this.assertUserOwns(userId, conversationId);
    this.assertConversationWritable(conv.status as string);
    const clean = this.cleanContent(content);
    const files = attachments ?? [];
    if (!clean && files.length === 0) {
      throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Message content or attachment required' });
    }
    await this.uploadService.verifyUserFileKeys(userId, files, UploadPurpose.CHAT_ATTACHMENT, { maxFiles: MAX_ATTACHMENTS });

    const saved = await this.prisma.supportMessage.create({
      data: {
        conversationId,
        senderType: SENDER_USER,
        senderUserId: userId,
        content: clean,
        attachments: files,
      },
      include: {
        senderUser: { select: { id: true, username: true, fullName: true } },
        senderAdmin: { select: { id: true, fullName: true } },
      },
    });
    await this.prisma.supportConversation.update({ where: { id: conversationId }, data: { updatedAt: new Date() } });
    const view = this.toMessageView(saved as never);
    this.emitMessage(conv as never, view);
    // Beritahu agen yang menangani (bila ada) — ia mungkin tidak membuka room.
    if (conv.assignedAgentId) {
      this.realtime.emitToAdmin(conv.assignedAgentId, 'support.message.new', { ...view, conversationStatus: conv.status });
    }
    return view;
  }

  async sendAgentMessage(
    adminId: string,
    conversationId: string,
    content: string | undefined,
    attachments: string[] | undefined,
  ): Promise<SupportMessageView> {
    const conv = await this.prisma.supportConversation.findUnique({ where: { id: conversationId } });
    if (!conv) throw new NotFoundException({ code: ErrorCodes.NOT_FOUND, message: 'Conversation not found' });
    this.assertConversationWritable(conv.status as string);
    const clean = this.cleanContent(content);
    const files = attachments ?? [];
    if (!clean && files.length === 0) {
      throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Message content or attachment required' });
    }
    await this.uploadService.verifyUserFileKeys(adminId, files, UploadPurpose.CHAT_ATTACHMENT, { maxFiles: MAX_ATTACHMENTS });

    // Balasan pertama = agen mengambil alih antrean (WAITING → ASSIGNED → OPEN).
    let assignedAgentId = conv.assignedAgentId;
    let status = conv.status as string;
    if (status === 'WAITING') {
      assignedAgentId = adminId;
      status = 'ASSIGNED';
    }

    const saved = await this.prisma.$transaction(async (tx) => {
      // Status menjadi OPEN begitu agen membalas (WAITING/ASSIGNED → OPEN).
      await tx.supportConversation.update({
        where: { id: conversationId },
        data: {
          status: CONV_OPEN,
          assignedAgentId,
          assignedAt: status === 'ASSIGNED' && !conv.assignedAt ? new Date() : conv.assignedAt,
          updatedAt: new Date(),
        },
      });
      return tx.supportMessage.create({
        data: {
          conversationId,
          senderType: SENDER_AGENT,
          senderAdminId: adminId,
          content: clean,
          attachments: files,
        },
        include: {
          senderUser: { select: { id: true, username: true, fullName: true } },
          senderAdmin: { select: { id: true, fullName: true } },
        },
      });
    });

    const view = this.toMessageView(saved as never);
    const convView = { ...conv, status: 'OPEN', assignedAgentId } as never;
    this.emitMessage(convView, view);
    // Notifikasi ke user (in-app + push + event WS notification.new).
    await this.notifyUserOfAgentReply(conv.userId, conversationId, adminId, clean, view.id).catch((err) =>
      this.logger.warn(`Agent-reply notification failed for conversation ${conversationId}: ${(err as Error).message}`),
    );
    this.realtime.emitToSupportAgents('support.queue.changed', {
      conversationId,
      status: 'OPEN',
      change: status !== (conv.status as string) ? 'claimed' : 'message',
    });
    return view;
  }

  // ------------------------------------------------------------ assignment ---

  /**
   * Agen mengambil percakapan dari antrean. SUPER_ADMIN boleh menugaskan ke
   * agen lain; agen biasa hanya bisa claim untuk diri sendiri.
   */
  async claimConversation(
    claimantAdminId: string,
    claimantRole: AdminRole,
    conversationId: string,
    assigneeAdminId?: string,
  ): Promise<Record<string, unknown>> {
    const targetId = assigneeAdminId ?? claimantAdminId;
    if (assigneeAdminId && assigneeAdminId !== claimantAdminId && claimantRole !== AdminRole.SUPER_ADMIN) {
      throw new ForbiddenException({ code: ErrorCodes.FORBIDDEN, message: 'Only SUPER_ADMIN can assign to another agent' });
    }
    const agent = await this.prisma.adminUser.findUnique({
      where: { id: targetId },
      select: { id: true, fullName: true, role: true, isActive: true, deletedAt: true },
    });
    if (!agent || !agent.isActive || agent.deletedAt) {
      throw new NotFoundException({ code: ErrorCodes.NOT_FOUND, message: 'Agent not found or inactive' });
    }
    if (agent.role !== AdminRole.CUSTOMER_SUPPORT && agent.role !== AdminRole.SUPER_ADMIN) {
      throw new ForbiddenException({ code: ErrorCodes.FORBIDDEN, message: 'Target is not a support agent' });
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      const conv = await tx.supportConversation.findUnique({ where: { id: conversationId } });
      if (!conv) throw new NotFoundException({ code: ErrorCodes.NOT_FOUND, message: 'Conversation not found' });
      const st = conv.status as string;
      if (st !== 'WAITING' && st !== 'ASSIGNED') {
        throw new BadRequestException({ code: ErrorCodes.INVALID_STATUS, message: `Cannot claim a ${st} conversation` });
      }
      return tx.supportConversation.update({
        where: { id: conversationId },
        data: { status: CONV_ASSIGNED, assignedAgentId: targetId, assignedAt: new Date(), updatedAt: new Date() },
        include: { assignedAgent: { select: { id: true, fullName: true } } },
      });
    });

    await this.sendSystemMessageInternal(conversationId, `Agen ${agent.fullName} mengambil percakapan ini.`);
    this.auditLog.logAdminAction({
      adminId: claimantAdminId,
      action: AuditAction.ADMIN_ACTION,
      targetType: 'SupportConversation',
      targetId: conversationId,
      description: `Claimed support conversation ${conversationId} for agent ${targetId}`,
      ipAddress: '',
    });
    this.realtime.emitToSupportAgents('support.queue.changed', { conversationId, status: 'ASSIGNED', change: 'claimed' });
    this.realtime.emitToUser(updated.userId, 'support.assigned', {
      conversationId,
      agentName: agent.fullName,
    });
    return this.toConversationView(updated);
  }

  async closeConversation(
    conversationId: string,
    closedByType: SupportMessageSenderType,
    closedById: string,
  ): Promise<Record<string, unknown>> {
    const conv = await this.prisma.supportConversation.findUnique({ where: { id: conversationId } });
    if (!conv) throw new NotFoundException({ code: ErrorCodes.NOT_FOUND, message: 'Conversation not found' });
    if ((conv.status as string) === 'CLOSED') {
      throw new BadRequestException({ code: ErrorCodes.INVALID_STATUS, message: 'Conversation already closed' });
    }
    const closedBy = closedByType === SENDER_USER ? 'USER' : 'AGENT';
    if (closedBy === 'USER' && conv.userId !== closedById) {
      throw new ForbiddenException({ code: ErrorCodes.FORBIDDEN, message: 'Not authorized' });
    }
    const updated = await this.prisma.supportConversation.update({
      where: { id: conversationId },
      data: { status: CONV_CLOSED, closedAt: new Date(), closedByType, closedById, updatedAt: new Date() },
      include: { assignedAgent: { select: { id: true, fullName: true } } },
    });
    await this.sendSystemMessageInternal(
      conversationId,
      closedBy === 'USER' ? 'Percakapan ditutup oleh pengguna.' : 'Percakapan ditutup oleh agen. Terima kasih telah menghubungi Kahade Support.',
    );
    this.realtime.emitToSupportAgents('support.queue.changed', { conversationId, status: 'CLOSED', change: 'closed' });
    return this.toConversationView(updated);
  }

  async rateConversation(userId: string, conversationId: string, rating: number, comment?: string): Promise<object> {
    const conv = await this.assertUserOwns(userId, conversationId);
    if ((conv.status as string) !== 'CLOSED') {
      throw new BadRequestException({ code: ErrorCodes.INVALID_STATUS, message: 'Can only rate closed conversations' });
    }
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
      throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Rating 1-5' });
    }
    if (conv.rating !== null && conv.rating !== undefined) {
      throw new BadRequestException({ code: ErrorCodes.INVALID_STATUS, message: 'Conversation has already been rated' });
    }
    await this.prisma.supportConversation.update({
      where: { id: conversationId },
      data: { rating, ratingComment: comment ? sanitize(comment).slice(0, 1000) : null },
    });
    return { conversationId, rating };
  }

  // ------------------------------------------------- ketersediaan agen ---

  async setAgentAvailability(adminId: string, available: boolean): Promise<{ adminId: string; available: boolean }> {
    if (available) {
      await this.redis.set(AGENT_AVAILABLE_KEY(adminId), '1', AGENT_AVAILABILITY_TTL_SECONDS);
    } else {
      await this.redis.del(AGENT_AVAILABLE_KEY(adminId));
    }
    return { adminId, available };
  }

  /** Daftar agen + status online (presence WS) + ketersediaan (toggle). */
  async getAgentsStatus(): Promise<Record<string, unknown>[]> {
    const agents = await this.prisma.adminUser.findMany({
      where: { role: { in: [AdminRole.CUSTOMER_SUPPORT, AdminRole.SUPER_ADMIN] }, isActive: true, deletedAt: null },
      select: { id: true, fullName: true, email: true, role: true },
      orderBy: { fullName: 'asc' },
    });
    const onlineMap = await this.realtime.areUsersOnline(agents.map((a) => a.id));
    const availability = await Promise.all(
      agents.map(async (a) => {
        const openCount = await this.prisma.supportConversation.count({
          where: { assignedAgentId: a.id, status: { in: [CONV_ASSIGNED, CONV_OPEN] } },
        });
        let available = false;
        try {
          available = (await this.redis.get(AGENT_AVAILABLE_KEY(a.id))) === '1';
        } catch {
          available = false;
        }
        return {
          id: a.id,
          name: a.fullName,
          email: a.email,
          role: a.role,
          online: onlineMap[a.id] ?? false,
          available,
          openConversations: openCount,
        };
      }),
    );
    return availability;
  }

  // ------------------------------------------------------- eskalasi ---

  /**
   * POIN 5: TIKET HANYA DIBUAT ADMIN — via eskalasi percakapan livechat yang
   * tak terselesaikan langsung. Membuat SupportTicket beserta transkrip.
   */
  async escalateToTicket(
    adminId: string,
    conversationId: string,
    dto: { subject: string; category?: string; message?: string },
    ipAddress: string,
  ): Promise<Record<string, unknown>> {
    const conv = await this.prisma.supportConversation.findUnique({
      where: { id: conversationId },
      include: {
        messages: {
          orderBy: { createdAt: 'asc' },
          include: {
            senderUser: { select: { username: true, fullName: true } },
            senderAdmin: { select: { fullName: true } },
          },
        },
        assignedAgent: { select: { fullName: true } },
      },
    });
    if (!conv) throw new NotFoundException({ code: ErrorCodes.NOT_FOUND, message: 'Conversation not found' });

    const subject = sanitize(dto.subject ?? '').slice(0, 200);
    if (!subject) throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'subject is required' });
    const summary = dto.message ? sanitize(dto.message).slice(0, 5000) : null;
    const transcript = this.buildTranscript(conv.messages as never[]);
    const priority = await this.subscriptionsService.isActive(conv.userId).catch(() => conv.priority);

    const ticket = await this.prisma.supportTicket.create({
      data: {
        userId: conv.userId,
        subject,
        message: summary ?? transcript.slice(0, 5000) ?? 'Eskalasi dari livechat support.',
        category: (dto.category as never) ?? 'GENERAL',
        status: SupportTicketStatus.OPEN,
        priority,
        sourceType: SOURCE_CHAT_ESCALATION,
        sourceChatRoomId: conversationId,
        transcriptText: transcript,
        attachments: [],
      },
    });

    const agentName = conv.assignedAgent?.fullName ?? 'Agen';
    await this.sendSystemMessageInternal(conversationId, `Dieskalasi menjadi tiket oleh ${agentName}. Nomor tiket: ${ticket.id}.`);
    this.auditLog.logAdminAction({
      adminId,
      action: AuditAction.ADMIN_ACTION,
      targetType: 'SupportTicket',
      targetId: ticket.id,
      description: `Escalated support conversation ${conversationId} to ticket ${ticket.id}`,
      ipAddress,
    });
    this.realtime.emitToUser(conv.userId, 'support.escalated', {
      conversationId,
      ticketId: ticket.id,
      subject: ticket.subject,
    });
    return ticket as unknown as Record<string, unknown>;
  }

  // ------------------------------------------------------- internal ---

  private async assertUserOwns(
    userId: string,
    conversationId: string,
  ): Promise<{ id: string; userId: string; status: unknown; assignedAgentId: string | null; priority: boolean; rating: number | null }> {
    const conv = await this.prisma.supportConversation.findUnique({ where: { id: conversationId } });
    if (!conv) throw new NotFoundException({ code: ErrorCodes.NOT_FOUND, message: 'Conversation not found' });
    if (conv.userId !== userId) throw new ForbiddenException({ code: ErrorCodes.FORBIDDEN, message: 'Not authorized' });
    return conv as never;
  }

  private async assertCanAccess(
    conversationId: string,
    viewer: { kind: 'user'; id: string } | { kind: 'admin'; id: string },
  ): Promise<void> {
    const conv = await this.prisma.supportConversation.findUnique({
      where: { id: conversationId },
      select: { userId: true },
    });
    if (!conv) throw new NotFoundException({ code: ErrorCodes.NOT_FOUND, message: 'Conversation not found' });
    if (viewer.kind === 'user' && conv.userId !== viewer.id) {
      throw new ForbiddenException({ code: ErrorCodes.FORBIDDEN, message: 'Not authorized' });
    }
    // Admin (role support, sudah diautentikasi di gateway/guard) boleh akses semua.
  }

  private assertConversationWritable(status: string): void {
    if (status === 'CLOSED') {
      throw new BadRequestException({ code: ErrorCodes.CHAT_ROOM_CLOSED ?? ErrorCodes.INVALID_STATUS, message: 'This conversation has been closed' });
    }
  }

  private cleanContent(content: string | undefined): string | null {
    if (!content) return null;
    const clean = sanitize(content).slice(0, MAX_MESSAGE_LENGTH);
    return clean.length > 0 ? clean : null;
  }

  /** Pesan sistem: disimpan + di-broadcast, TANPA notifikasi. */
  async sendSystemMessage(conversationId: string, content: string): Promise<SupportMessageView> {
    return this.sendSystemMessageInternal(conversationId, content);
  }

  private async sendSystemMessageInternal(conversationId: string, content: string): Promise<SupportMessageView> {
    const saved = await this.prisma.supportMessage.create({
      data: { conversationId, senderType: SENDER_SYSTEM, content: sanitize(content).slice(0, MAX_MESSAGE_LENGTH), attachments: [] },
    });
    const view: SupportMessageView = {
      id: saved.id,
      conversationId,
      senderType: SENDER_SYSTEM,
      senderId: null,
      senderName: 'Sistem',
      content: saved.content,
      attachments: [],
      createdAt: saved.createdAt,
    };
    this.realtime.emitToSupportRoom(conversationId, 'support.message.new', view);
    return view;
  }

  private emitMessage(
    conv: { id: string; userId: string; status: unknown },
    view: SupportMessageView,
  ): void {
    const payload = { ...view, conversationStatus: conv.status };
    this.realtime.emitToSupportRoom(conv.id, 'support.message.new', payload);
    // User yang tidak sedang membuka room tetap dapat event via room pribadinya.
    if (view.senderType !== SENDER_USER) {
      this.realtime.emitToUser(conv.userId, 'support.message.new', payload);
    }
  }

  /**
   * Notifikasi ke user saat AGEN membalas — reuse sistem notifikasi yang ada:
   * baris notification (in-app) + emitNotificationCreated (event WS
   * `notification.new` + unread count via listener gateway + push FCM via
   * push.service). Kegagalan tidak menggagalkan pengiriman pesan.
   */
  private async notifyUserOfAgentReply(
    userId: string,
    conversationId: string,
    adminId: string,
    content: string | null,
    messageId: string,
  ): Promise<void> {
    const agent = await this.prisma.adminUser.findUnique({ where: { id: adminId }, select: { fullName: true } });
    const agentName = agent?.fullName || 'Tim Support';
    const preview = content ? content.slice(0, 80) : 'Mengirim lampiran';
    const lang = await resolveNotificationLanguage(this.prisma, userId);
    const copy = renderNotificationCopy(NotificationType.SUPPORT_AGENT_REPLY, lang, { agentName, preview });
    const notification = await this.prisma.notification.create({
      data: {
        notifId: generateNotifId(),
        userId,
        type: NotificationType.SUPPORT_AGENT_REPLY,
        category: getCategoryForType(NotificationType.SUPPORT_AGENT_REPLY),
        title: copy.title,
        body: copy.body,
        isRead: false,
        refType: 'SUPPORT_CONVERSATION',
        refId: conversationId,
        actionUrl: `/support/chat/${encodeURIComponent(conversationId)}`,
      },
      select: { notifId: true },
    });
    this.prisma.emitNotificationCreated({
      userId,
      title: copy.title,
      body: copy.body,
      data: {
        type: 'SUPPORT_CHAT_REPLY',
        notificationType: NotificationType.SUPPORT_AGENT_REPLY,
        notificationId: notification.notifId,
        conversationId,
        messageId,
      },
    });
  }

  private buildTranscript(messages: never[]): string {
    const lines: string[] = [];
    for (const m of messages as unknown as {
      senderType: string;
      senderUser?: { fullName?: string | null; username?: string | null } | null;
      senderAdmin?: { fullName?: string | null } | null;
      content: string | null;
      attachments: unknown;
      createdAt: Date;
    }[]) {
      const ts = new Date(m.createdAt).toISOString().replace('T', ' ').slice(0, 19);
      let who: string;
      if (m.senderType === 'SYSTEM') who = 'Sistem';
      else if (m.senderType === 'AGENT') who = `Agen (${m.senderAdmin?.fullName ?? 'Support'})`;
      else who = `User (${m.senderUser?.fullName || m.senderUser?.username || 'pengguna'})`;
      const body = m.content?.trim() || '';
      const att = Array.isArray(m.attachments) && m.attachments.length > 0 ? ` [${m.attachments.length} lampiran]` : '';
      lines.push(`[${ts}] ${who}: ${body}${att}`);
    }
    return lines.join('\n');
  }

  private toConversationView(conv: {
    id: string;
    userId: string;
    status: unknown;
    subject: string | null;
    priority: boolean;
    source: unknown;
    assignedAgentId: string | null;
    assignedAgent?: { id: string; fullName: string } | null;
    user?: { id: string; username: string | null; fullName: string | null } | null;
    closedAt: Date | null;
    rating: number | null;
    createdAt: Date;
    updatedAt: Date;
  }): Record<string, unknown> {
    return {
      id: conv.id,
      userId: conv.userId,
      user: conv.user ?? null,
      status: conv.status,
      subject: conv.subject,
      priority: conv.priority,
      source: conv.source,
      assignedAgent: conv.assignedAgent
        ? { id: conv.assignedAgent.id, name: conv.assignedAgent.fullName }
        : null,
      closedAt: conv.closedAt,
      rating: conv.rating,
      createdAt: conv.createdAt,
      updatedAt: conv.updatedAt,
    };
  }

  private toMessageView(m: {
    id: string;
    conversationId: string;
    senderType: SupportMessageSenderType;
    senderUserId: string | null;
    senderAdminId: string | null;
    senderUser?: { id: string; username: string | null; fullName: string | null } | null;
    senderAdmin?: { id: string; fullName: string } | null;
    content: string | null;
    attachments: unknown;
    createdAt: Date;
  }): SupportMessageView {
    const senderId = m.senderUserId ?? m.senderAdminId ?? null;
    const senderName =
      m.senderType === ('SYSTEM' as SupportMessageSenderType)
        ? 'Sistem'
        : m.senderAdmin?.fullName ?? m.senderUser?.fullName ?? m.senderUser?.username ?? null;
    return {
      id: m.id,
      conversationId: m.conversationId,
      senderType: m.senderType,
      senderId,
      senderName,
      content: m.content,
      attachments: Array.isArray(m.attachments) ? (m.attachments as string[]) : [],
      createdAt: m.createdAt,
    };
  }
}
