import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import * as ErrorCodes from '../../common/constants/error-codes';
import { ReplyTicketDto } from './dto/create-ticket.dto';
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

  /**
   * D1-010 (perf 2026-09-29): fingerprint ringan untuk poll — SATU query
   * (select + _count balasan), bukan getTicketDetail (tiket + semua balasan).
   * updatedAt ikut berubah tiap ada balasan (lihat replyToTicket), jadi
   * balasan baru dari staf ikut terdeteksi.
   */
  async getTicketFingerprint(
    userId: string,
    ticketId: string,
  ): Promise<{ ticketId: string; status: string; updatedAt: Date; replyCount: number }> {
    const ticket = await this.prisma.supportTicket.findUnique({
      where: { id: ticketId },
      select: {
        id: true,
        userId: true,
        status: true,
        updatedAt: true,
        _count: { select: { replies: true } },
      },
    });
    if (!ticket) throw new NotFoundException({ code: ErrorCodes.NOT_FOUND, message: 'Ticket not found' });
    if (ticket.userId !== userId) throw new ForbiddenException({ code: ErrorCodes.FORBIDDEN, message: 'Not authorized' });
    return {
      ticketId: ticket.id,
      status: ticket.status,
      updatedAt: ticket.updatedAt,
      replyCount: ticket._count.replies,
    };
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
    // Lampiran balasan diverifikasi seperti lampiran tiket utama — key harus
    // milik user, purpose CHAT_ATTACHMENT, maks 5 file. Verifikasi di luar
    // transaksi supaya kegagalan validasi tidak membuka transaksi DB sia-sia.
    const attachments = dto.attachments ?? [];
    await this.uploadService.verifyUserFileKeys(userId, attachments, UploadPurpose.CHAT_ATTACHMENT);
    const reply = await this.prisma.$transaction(async (tx) => {
      const ticket = await tx.supportTicket.findUnique({ where: { id: ticketId } });
      if (!ticket) throw new NotFoundException({ code: ErrorCodes.NOT_FOUND, message: 'Ticket not found' });
      if (ticket.userId !== userId) throw new ForbiddenException({ code: ErrorCodes.FORBIDDEN, message: 'Not authorized' });
      if (TERMINAL_TICKET_STATUSES.includes(ticket.status as (typeof TERMINAL_TICKET_STATUSES)[number])) {
        throw new BadRequestException({ code: ErrorCodes.INVALID_STATUS, message: 'Cannot reply to a closed or resolved ticket' });
      }
      const created = await tx.supportTicketReply.create({
        data: { ticketId, senderId: userId, senderType: 'USER', message: dto.message.trim(), attachments },
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

  async closeTicket(userId: string, ticketId: string): Promise<object> {
    const ticket = await this.prisma.supportTicket.findUnique({ where: { id: ticketId } });
    if (!ticket) throw new NotFoundException({ code: ErrorCodes.NOT_FOUND, message: 'Ticket not found' });
    if (ticket.userId !== userId) throw new ForbiddenException({ code: ErrorCodes.FORBIDDEN, message: 'Not authorized' });
    if ((['CLOSED', 'RESOLVED'] as string[]).includes(ticket.status)) throw new BadRequestException({ code: ErrorCodes.INVALID_STATUS, message: 'Already closed' });
    const updated = await this.prisma.supportTicket.update({ where: { id: ticketId }, data: { status: SupportTicketStatus.CLOSED } });
    return { ticketId: updated.id, status: updated.status };
  }

  async reopenTicket(userId: string, ticketId: string): Promise<object> {
    const ticket = await this.prisma.supportTicket.findUnique({ where: { id: ticketId } });
    if (!ticket) throw new NotFoundException({ code: ErrorCodes.NOT_FOUND, message: 'Ticket not found' });
    if (ticket.userId !== userId) throw new ForbiddenException({ code: ErrorCodes.FORBIDDEN, message: 'Not authorized' });
    if (ticket.status !== 'CLOSED') throw new BadRequestException({ code: ErrorCodes.INVALID_STATUS, message: 'Only closed tickets can be reopened' });
    const updated = await this.prisma.supportTicket.update({ where: { id: ticketId }, data: { status: SupportTicketStatus.OPEN } });
    return { ticketId: updated.id, status: updated.status };
  }

  async rateTicket(userId: string, ticketId: string, rating: number, comment?: string): Promise<object> {
    const ticket = await this.prisma.supportTicket.findUnique({ where: { id: ticketId } });
    if (!ticket) throw new NotFoundException({ code: ErrorCodes.NOT_FOUND, message: 'Ticket not found' });
    if (ticket.userId !== userId) throw new ForbiddenException({ code: ErrorCodes.FORBIDDEN, message: 'Not authorized' });
    if (!['RESOLVED', 'CLOSED'].includes(ticket.status)) throw new BadRequestException({ code: ErrorCodes.INVALID_STATUS, message: 'Can only rate resolved/closed tickets' });
    if (rating < 1 || rating > 5) throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Rating 1-5' });
    // SP-025: rating tidak boleh ditimpa — tolak bila sudah ada. Kolom
    // rating/ratingComment memang ada di schema SupportTicket (tidak ada
    // model rating terpisah), jadi update langsung tanpa dynamic model
    // opsional dan tanpa catch yang membungkam error.
    if (ticket.rating !== null) {
      throw new BadRequestException({ code: ErrorCodes.INVALID_STATUS, message: 'Ticket has already been rated' });
    }
    const updated = await this.prisma.supportTicket.update({
      where: { id: ticketId },
      data: { rating, ratingComment: comment ?? null },
    });
    return { ticketId, rating, comment, status: updated.status };
  }
}
