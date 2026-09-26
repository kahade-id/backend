import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { AuditLogService } from '../../../common/services/audit-log.service';
import { createPaginatedResponse } from '../../../common/dto/pagination.dto';
import { AuditAction, Prisma, SupportTicketStatus, SupportTicketCategory, SupportTicketSenderType, NotificationType } from '@prisma/client';
import { generateNotifId } from '../../../common/utils/id-generator.util';
import { getCategoryForType } from '../../notifications/notification-category.map';
import * as ErrorCodes from '../../../common/constants/error-codes';
import { escapeLikePattern } from '../../../common/utils/search.util';

const TERMINAL_TICKET_STATUSES = [SupportTicketStatus.RESOLVED, SupportTicketStatus.CLOSED] as const;

@Injectable()
export class AdminSupportService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLog: AuditLogService,
  ) {}

  async listTickets(page: number, limit: number, status?: string, category?: string, search?: string, priority?: boolean): Promise<object> {
    const safeLimit = Math.min(Math.max(1, Math.floor(limit)), 100);
    const safePage = Math.max(1, Math.floor(page));
    const skip = (safePage - 1) * safeLimit;
    const where: Prisma.SupportTicketWhereInput = {};
    if (status) where.status = status as SupportTicketStatus;
    if (category) where.category = category as SupportTicketCategory;
    if (priority !== undefined) where.priority = priority;
    const normalizedSearch = search?.trim();
    if (normalizedSearch) {
      where.OR = [
        { subject: { contains: escapeLikePattern(normalizedSearch), mode: 'insensitive' } },
        { message: { contains: escapeLikePattern(normalizedSearch), mode: 'insensitive' } },
        { user: { is: { email: { contains: escapeLikePattern(normalizedSearch), mode: 'insensitive' } } } },
        { user: { is: { username: { contains: escapeLikePattern(normalizedSearch), mode: 'insensitive' } } } },
        { user: { is: { fullName: { contains: escapeLikePattern(normalizedSearch), mode: 'insensitive' } } } },
      ];
    }

    const [tickets, total] = await Promise.all([
      this.prisma.supportTicket.findMany({
        where,
        skip,
        take: safeLimit,
        // SP-022: urutkan berdasarkan aktivitas terakhir — balasan USER
        // menyentuh updatedAt (support.service replyToTicket), sehingga tiket
        // dengan balasan user terbaru muncul di atas sebagai sinyal ringan
        // untuk admin tanpa perubahan schema.
        orderBy: { updatedAt: 'desc' },
        include: {
          user: { select: { id: true, userId: true, username: true, fullName: true, email: true, avatarUrl: true } },
          _count: { select: { replies: true } },
        },
      }),
      this.prisma.supportTicket.count({ where }),
    ]);

    const data = tickets.map((ticket) => {
      const { _count, attachments, ...rest } = ticket as typeof ticket & { _count: { replies: number }; attachments?: unknown };
      const attachmentCount = Array.isArray(attachments) ? attachments.length : 0;
      // SP-021: admin UI membaca `isPriority` untuk badge di tab Umum —
      // sediakan alias dari kolom DB `priority` (aditif).
      return { ...rest, isPriority: ticket.priority, replyCount: _count.replies, attachmentCount };
    });
    return createPaginatedResponse(data, total, safePage, safeLimit);
  }

  async getTicketDetail(ticketId: string): Promise<object> {
    const ticket = await this.prisma.supportTicket.findUnique({
      where: { id: ticketId },
      include: {
        user: { select: { id: true, userId: true, username: true, fullName: true, avatarUrl: true, email: true } },
        replies: { orderBy: { createdAt: 'asc' } },
      },
    });
    if (!ticket) throw new NotFoundException({ code: ErrorCodes.NOT_FOUND, message: 'Ticket not found' });
    return {
      ...ticket,
      // SP-020: admin UI membaca `isAdminReply` (tickets/[id]/page.tsx) —
      // sediakan dengan nama itu; `isStaff` dipertahankan untuk kompatibilitas.
      replies: (ticket.replies || []).map((reply) => {
        const isAdminReply =
          reply.senderType === SupportTicketSenderType.ADMIN ||
          reply.senderType === SupportTicketSenderType.SYSTEM;
        return { ...reply, isStaff: isAdminReply, isAdminReply };
      }),
    };
  }

  async replyToTicket(ticketId: string, adminId: string, message: string, ipAddress: string): Promise<object> {
    const reply = await this.prisma.$transaction(async (tx) => {
      const ticket = await tx.supportTicket.findUnique({ where: { id: ticketId } });
      if (!ticket) throw new NotFoundException({ code: ErrorCodes.NOT_FOUND, message: 'Ticket not found' });
      if (TERMINAL_TICKET_STATUSES.includes(ticket.status as (typeof TERMINAL_TICKET_STATUSES)[number])) {
        throw new BadRequestException({ code: ErrorCodes.INVALID_STATUS, message: 'Cannot reply to a closed or resolved ticket' });
      }
      const created = await tx.supportTicketReply.create({
        data: { ticketId, senderId: adminId, senderType: SupportTicketSenderType.ADMIN, message: message.trim() },
      });
      await tx.supportTicket.update({
        where: { id: ticketId },
        data: { status: ticket.status === SupportTicketStatus.OPEN ? SupportTicketStatus.IN_PROGRESS : ticket.status, updatedAt: new Date() },
      });
      return created;
    });

    // R2-C (audit): admin replies used to be invisible until the user happened to
    // poll the ticket list — there was no in-app signal at all. Notify the ticket
    // owner (and push via realtime) whenever staff answers.
    await this.notifyTicketOwner(reply.ticketId ?? ticketId, 'Kahade Support replied to your ticket', `Reply: ${this.snippet(message)}`);

    this.auditLog.logAdminAction({
      adminId,
      action: AuditAction.ADMIN_ACTION,
      targetType: 'SupportTicket',
      targetId: ticketId,
      description: `Replied to support ticket ${ticketId}`,
      ipAddress,
    });
    // SP-020: samakan dengan getTicketDetail — admin UI membaca `isAdminReply`.
    return { ...reply, isStaff: true, isAdminReply: true };
  }

  async updateStatus(ticketId: string, status: string, adminId: string, ipAddress: string): Promise<object> {
    const result = await this.prisma.$transaction(async (tx) => {
      const ticket = await tx.supportTicket.findUnique({ where: { id: ticketId } });
      if (!ticket) throw new NotFoundException({ code: ErrorCodes.NOT_FOUND, message: 'Ticket not found' });
      if (TERMINAL_TICKET_STATUSES.includes(ticket.status as (typeof TERMINAL_TICKET_STATUSES)[number])) {
        throw new BadRequestException({ code: ErrorCodes.INVALID_STATUS, message: 'A resolved or closed ticket cannot be reopened' });
      }
      if (ticket.status === status) {
        throw new BadRequestException({ code: ErrorCodes.INVALID_STATUS, message: 'Ticket is already in this status' });
      }
      const updated = await tx.supportTicket.update({ where: { id: ticketId }, data: { status: status as SupportTicketStatus, updatedAt: new Date() } });
      return { previousStatus: ticket.status, updated };
    });

    // R2-C (audit): terminal transitions were also silent for the requester.
    if (status === SupportTicketStatus.RESOLVED || status === SupportTicketStatus.CLOSED) {
      await this.notifyTicketOwner(ticketId, 'Kahade Support updated your ticket', `Your ticket is now ${status}.`);
    }

    this.auditLog.logAdminAction({
      adminId,
      action: AuditAction.ADMIN_ACTION,
      targetType: 'SupportTicket',
      targetId: ticketId,
      description: `Changed support ticket ${ticketId} status from ${result.previousStatus} to ${status}`,
      ipAddress,
    });
    return { message: 'Ticket status updated', ticketId: result.updated.id, status: result.updated.status };
  }

  private snippet(text: string): string {
    const flat = text.replace(/\s+/g, ' ').trim();
    return flat.length > 140 ? `${flat.slice(0, 140)}…` : flat;
  }

  private async notifyTicketOwner(ticketId: string, title: string, body: string): Promise<void> {
    const ticket = await this.prisma.supportTicket.findUnique({
      where: { id: ticketId },
      select: { userId: true },
    });
    if (!ticket) return;
    void Promise.resolve()
      .then(() =>
        this.prisma.notification.create({
          data: {
            notifId: generateNotifId(),
            userId: ticket.userId,
            type: NotificationType.SYSTEM_ANNOUNCEMENT,
            category: getCategoryForType(NotificationType.SYSTEM_ANNOUNCEMENT),
            title,
            body,
            isRead: false,
          },
        }),
      )
      .catch(() => undefined);
    this.prisma.emitNotificationCreated({ userId: ticket.userId, title, body, data: { type: 'SUPPORT_TICKET_UPDATE', ticketId } });
  }
}
