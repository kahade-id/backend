import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import * as ErrorCodes from '../../common/constants/error-codes';
import { CreateTicketDto, ReplyTicketDto } from './dto/create-ticket.dto';
import { UploadPurpose } from '../upload/dto/presigned-url.dto';
import { UploadService } from '../upload/upload.service';
import { AuditAction, SupportTicketStatus } from '@prisma/client';
import { AuditLogService } from '../../common/services/audit-log.service';

const TERMINAL_TICKET_STATUSES = ['CLOSED', 'RESOLVED'] as const;

@Injectable()
export class SupportService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly uploadService: UploadService,
    private readonly auditLog: AuditLogService,
  ) {}

  async createTicket(userId: string, dto: CreateTicketDto): Promise<object> {
    const attachments = dto.attachments ?? [];
    await this.uploadService.verifyUserFileKeys(userId, attachments, UploadPurpose.CHAT_ATTACHMENT);
    return this.prisma.supportTicket.create({
      data: {
        userId,
        subject: dto.subject.trim(),
        message: dto.message.trim(),
        category: dto.category || 'GENERAL',
        orderId: dto.orderId || null,
        attachments,
        status: 'OPEN',
      },
    });
  }

  async getTickets(userId: string, page = 1, limit = 20): Promise<{ data: object[]; total: number; page: number; limit: number }> {
    const safeLimit = Math.min(Math.max(1, Math.floor(limit)), 50);
    const safePage = Math.max(1, Math.floor(page));
    const skip = (safePage - 1) * safeLimit;
    const [tickets, total] = await Promise.all([
      this.prisma.supportTicket.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' },
        skip,
        take: safeLimit,
        include: { replies: { orderBy: { createdAt: 'desc' }, take: 1 } },
      }),
      this.prisma.supportTicket.count({ where: { userId } }),
    ]);
    const mapped = tickets.map((ticket) => ({
      ...ticket,
      replies: (ticket.replies || []).map((reply) => ({ ...reply, isStaff: reply.senderType === 'ADMIN' || reply.senderType === 'SYSTEM' })),
    }));
    return { data: mapped, total, page: safePage, limit: safeLimit };
  }

  async getTicketDetail(userId: string, ticketId: string): Promise<object> {
    const ticket = await this.prisma.supportTicket.findUnique({
      where: { id: ticketId },
      include: { replies: { orderBy: { createdAt: 'asc' } } },
    });
    if (!ticket) throw new NotFoundException({ code: ErrorCodes.NOT_FOUND, message: 'Ticket not found' });
    if (ticket.userId !== userId) throw new ForbiddenException({ code: ErrorCodes.FORBIDDEN, message: 'Not authorized' });
    return {
      ...ticket,
      replies: (ticket.replies || []).map((reply) => ({ ...reply, isStaff: reply.senderType === 'ADMIN' || reply.senderType === 'SYSTEM' })),
    };
  }

  async replyToTicket(userId: string, ticketId: string, dto: ReplyTicketDto): Promise<object> {
    const reply = await this.prisma.$transaction(async (tx) => {
      const ticket = await tx.supportTicket.findUnique({ where: { id: ticketId } });
      if (!ticket) throw new NotFoundException({ code: ErrorCodes.NOT_FOUND, message: 'Ticket not found' });
      if (ticket.userId !== userId) throw new ForbiddenException({ code: ErrorCodes.FORBIDDEN, message: 'Not authorized' });
      if (TERMINAL_TICKET_STATUSES.includes(ticket.status as (typeof TERMINAL_TICKET_STATUSES)[number])) {
        throw new BadRequestException({ code: ErrorCodes.INVALID_STATUS, message: 'Cannot reply to a closed or resolved ticket' });
      }
      const created = await tx.supportTicketReply.create({
        data: { ticketId, senderId: userId, senderType: 'USER', message: dto.message.trim() },
      });
      await tx.supportTicket.update({ where: { id: ticketId }, data: { updatedAt: new Date() } });
      return created;
    });
    return reply;
  }

  private assertStatusCanChange(current: string, next: string): void {
    if (TERMINAL_TICKET_STATUSES.includes(current as (typeof TERMINAL_TICKET_STATUSES)[number])) {
      throw new BadRequestException({ code: ErrorCodes.INVALID_STATUS, message: 'A resolved or closed ticket cannot be reopened' });
    }
    if (current === next) {
      throw new BadRequestException({ code: ErrorCodes.INVALID_STATUS, message: 'Ticket is already in this status' });
    }
  }

  async updateStatus(ticketId: string, status: string, adminId: string, ipAddress: string): Promise<object> {
    const updated = await this.prisma.$transaction(async (tx) => {
      const ticket = await tx.supportTicket.findUnique({ where: { id: ticketId } });
      if (!ticket) throw new NotFoundException({ code: ErrorCodes.NOT_FOUND, message: 'Ticket not found' });
      this.assertStatusCanChange(ticket.status, status);
      return tx.supportTicket.update({ where: { id: ticketId }, data: { status: status as SupportTicketStatus } });
    });

    this.auditLog.logAdminAction({
      adminId,
      action: AuditAction.ADMIN_ACTION,
      targetType: 'SupportTicket',
      targetId: ticketId,
      description: `Changed support ticket ${ticketId} status to ${status}`,
      ipAddress,
    });
    return { message: 'Ticket status updated', ticketId: updated.id, status: updated.status };
  }
}
