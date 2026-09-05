import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { AuditLogService } from '../../../common/services/audit-log.service';
import { createPaginatedResponse } from '../../../common/dto/pagination.dto';
import { AuditAction, Prisma, SupportTicketStatus, SupportTicketCategory, SupportTicketSenderType } from '@prisma/client';
import * as ErrorCodes from '../../../common/constants/error-codes';

const TERMINAL_TICKET_STATUSES = [SupportTicketStatus.RESOLVED, SupportTicketStatus.CLOSED] as const;

@Injectable()
export class AdminSupportService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLog: AuditLogService,
  ) {}

  async listTickets(page: number, limit: number, status?: string, category?: string, search?: string): Promise<object> {
    const safeLimit = Math.min(Math.max(1, Math.floor(limit)), 100);
    const safePage = Math.max(1, Math.floor(page));
    const skip = (safePage - 1) * safeLimit;
    const where: Prisma.SupportTicketWhereInput = {};
    if (status) where.status = status as SupportTicketStatus;
    if (category) where.category = category as SupportTicketCategory;
    const normalizedSearch = search?.trim();
    if (normalizedSearch) {
      where.OR = [
        { subject: { contains: normalizedSearch, mode: 'insensitive' } },
        { message: { contains: normalizedSearch, mode: 'insensitive' } },
        { user: { is: { email: { contains: normalizedSearch, mode: 'insensitive' } } } },
        { user: { is: { username: { contains: normalizedSearch, mode: 'insensitive' } } } },
        { user: { is: { fullName: { contains: normalizedSearch, mode: 'insensitive' } } } },
      ];
    }

    const [tickets, total] = await Promise.all([
      this.prisma.supportTicket.findMany({
        where,
        skip,
        take: safeLimit,
        orderBy: { createdAt: 'desc' },
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
      return { ...rest, replyCount: _count.replies, attachmentCount };
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
      replies: (ticket.replies || []).map((reply) => ({ ...reply, isStaff: reply.senderType === SupportTicketSenderType.ADMIN || reply.senderType === SupportTicketSenderType.SYSTEM })),
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

    this.auditLog.logAdminAction({
      adminId,
      action: AuditAction.ADMIN_ACTION,
      targetType: 'SupportTicket',
      targetId: ticketId,
      description: `Replied to support ticket ${ticketId}`,
      ipAddress,
    });
    return { ...reply, isStaff: true };
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
}
