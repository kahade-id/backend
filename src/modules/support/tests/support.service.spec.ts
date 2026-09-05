import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException, ForbiddenException, BadRequestException } from '@nestjs/common';
import { SupportService } from '../support.service';
import { PrismaService } from '../../../prisma/prisma.service';
import { UploadService } from '../../upload/upload.service';
import { AuditLogService } from '../../../common/services/audit-log.service';

const mockPrisma = {
  supportTicket: { create: jest.fn(), findMany: jest.fn(), count: jest.fn(), findUnique: jest.fn(), update: jest.fn() },
  supportTicketReply: { create: jest.fn() },
  $transaction: jest.fn(),
};

const mockUpload = { verifyUserFileKeys: jest.fn() };
const mockAuditLog = { logAdminAction: jest.fn() };

describe('SupportService', () => {
  let service: SupportService;

  beforeEach(async () => {
    jest.resetAllMocks();
    mockUpload.verifyUserFileKeys.mockResolvedValue(undefined);
    mockPrisma.$transaction.mockImplementation(async (callback: (tx: typeof mockPrisma) => unknown) => callback(mockPrisma));
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SupportService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: UploadService, useValue: mockUpload },
        { provide: AuditLogService, useValue: mockAuditLog },
      ],
    }).compile();
    service = module.get<SupportService>(SupportService);
  });

  it('should be defined', () => expect(service).toBeDefined());

  describe('createTicket', () => {
    it('creates ticket with default category GENERAL', async () => {
      const ticket = { id: 't1', userId: 'u1', subject: 'Help', message: 'msg', category: 'GENERAL', status: 'OPEN' };
      mockPrisma.supportTicket.create.mockResolvedValue(ticket);
      const result = await service.createTicket('u1', { subject: 'Help', message: 'msg' } as any);
      expect(result).toEqual(ticket);
      expect(mockPrisma.supportTicket.create).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({ category: 'GENERAL', status: 'OPEN' }),
      }));
    });

    it('validates and persists attachment keys instead of silently dropping them', async () => {
      mockPrisma.supportTicket.create.mockResolvedValue({ id: 't1', attachments: ['uploads/chat-attachments/u1/file.jpg'] });
      const attachments = ['uploads/chat-attachments/u1/file.jpg'];
      await service.createTicket('u1', { subject: 'S', message: 'M', attachments } as any);
      expect(mockUpload.verifyUserFileKeys).toHaveBeenCalledWith('u1', attachments, 'CHAT_ATTACHMENT');
      expect(mockPrisma.supportTicket.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ attachments }) }));
    });

    it('uses provided category and orderId', async () => {
      mockPrisma.supportTicket.create.mockResolvedValue({});
      await service.createTicket('u1', { subject: 'S', message: 'M', category: 'PAYMENT', orderId: 'ORD-1' } as any);
      expect(mockPrisma.supportTicket.create).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({ category: 'PAYMENT', orderId: 'ORD-1' }),
      }));
    });

    /*
     * D-05: the ticket id was minted with `generateUserId()` — the `USR-` user-id generator — which
     * both mislabels the row and shrinks the id space to 36^8 (~2.8e12), where a P2002 on the
     * primary key becomes plausible at scale. The column already declares `@default(cuid())`.
     */
    it('does not set an explicit id, leaving the schema cuid() default to mint it', async () => {
      mockPrisma.supportTicket.create.mockResolvedValue({});
      await service.createTicket('u1', { subject: 'S', message: 'M' } as any);
      const data = mockPrisma.supportTicket.create.mock.calls[0][0].data;
      // Pre-fix this was `USR-XXXXXXXX`; `id` must now be absent so Prisma applies the default.
      expect(data).not.toHaveProperty('id');
    });

    it('never stamps a ticket with the USR- user-id prefix', async () => {
      mockPrisma.supportTicket.create.mockResolvedValue({});
      await service.createTicket('u1', { subject: 'S', message: 'M' } as any);
      const data = mockPrisma.supportTicket.create.mock.calls[0][0].data;
      // `parse-id.pipe.ts:8` accepts `USR-…` on any `:ticketId` route, so a ticket carrying that
      // prefix is indistinguishable from a user id at the routing layer.
      expect(String(data.id ?? '')).not.toMatch(/^USR-/);
    });
  });

  describe('getTickets', () => {
    it('returns paginated user tickets with first-reply staff flag', async () => {
      mockPrisma.supportTicket.findMany.mockResolvedValue([
        { id: 't1', replies: [{ id: 'r1', senderType: 'ADMIN' }] },
      ]);
      mockPrisma.supportTicket.count.mockResolvedValue(1);
      const result = await service.getTickets('u1');
      expect((result.data[0] as any).replies[0].isStaff).toBe(true);
      expect(result.total).toBe(1);
      expect(mockPrisma.supportTicket.findMany).toHaveBeenCalledWith(expect.objectContaining({ include: { replies: { orderBy: { createdAt: 'desc' }, take: 1 } } }));
    });

    it('caps limit and floors page at 1', async () => {
      mockPrisma.supportTicket.findMany.mockResolvedValue([]);
      mockPrisma.supportTicket.count.mockResolvedValue(0);
      await service.getTickets('u1', 0, 999);
      expect(mockPrisma.supportTicket.findMany).toHaveBeenCalledWith(expect.objectContaining({ skip: 0, take: 50 }));
    });
  });

  describe('getTicketDetail', () => {
    it('returns ticket detail when owned', async () => {
      mockPrisma.supportTicket.findUnique.mockResolvedValue({ id: 't1', userId: 'u1', replies: [] });
      const result = await service.getTicketDetail('u1', 't1');
      expect((result as any).id).toBe('t1');
    });

    it('throws NotFoundException when missing', async () => {
      mockPrisma.supportTicket.findUnique.mockResolvedValue(null);
      await expect(service.getTicketDetail('u1', 't1')).rejects.toThrow(NotFoundException);
    });

    it('throws ForbiddenException when not owner', async () => {
      mockPrisma.supportTicket.findUnique.mockResolvedValue({ id: 't1', userId: 'other', replies: [] });
      await expect(service.getTicketDetail('u1', 't1')).rejects.toThrow(ForbiddenException);
    });
  });

  describe('replyToTicket', () => {
    it('creates reply for open ticket', async () => {
      mockPrisma.supportTicket.findUnique.mockResolvedValue({ id: 't1', userId: 'u1', status: 'OPEN' });
      mockPrisma.supportTicketReply.create.mockResolvedValue({ id: 'r1', ticketId: 't1', message: 'reply' });
      mockPrisma.supportTicket.update.mockResolvedValue({});
      const result = await service.replyToTicket('u1', 't1', { message: 'reply' } as any);
      expect((result as any).id).toBe('r1');
      expect(mockPrisma.supportTicket.update).toHaveBeenCalled();
    });

    it('throws NotFoundException when ticket missing', async () => {
      mockPrisma.supportTicket.findUnique.mockResolvedValue(null);
      await expect(service.replyToTicket('u1', 't1', { message: 'r' } as any)).rejects.toThrow(NotFoundException);
    });

    it('throws ForbiddenException when not owner', async () => {
      mockPrisma.supportTicket.findUnique.mockResolvedValue({ id: 't1', userId: 'other', status: 'OPEN' });
      await expect(service.replyToTicket('u1', 't1', { message: 'r' } as any)).rejects.toThrow(ForbiddenException);
    });

    it('throws BadRequestException when ticket is CLOSED', async () => {
      mockPrisma.supportTicket.findUnique.mockResolvedValue({ id: 't1', userId: 'u1', status: 'CLOSED' });
      await expect(service.replyToTicket('u1', 't1', { message: 'r' } as any)).rejects.toThrow(BadRequestException);
    });

    it('throws BadRequestException when ticket is RESOLVED', async () => {
      mockPrisma.supportTicket.findUnique.mockResolvedValue({ id: 't1', userId: 'u1', status: 'RESOLVED' });
      await expect(service.replyToTicket('u1', 't1', { message: 'r' } as any)).rejects.toThrow(BadRequestException);
    });

    // D-05: same id defect on the reply row — `SupportTicketReply.id` also declares `@default(cuid())`.
    it('does not set an explicit id on the reply', async () => {
      mockPrisma.supportTicket.findUnique.mockResolvedValue({ id: 't1', userId: 'u1', status: 'OPEN' });
      mockPrisma.supportTicketReply.create.mockResolvedValue({ id: 'r1' });
      mockPrisma.supportTicket.update.mockResolvedValue({});
      await service.replyToTicket('u1', 't1', { message: 'reply' } as any);
      const data = mockPrisma.supportTicketReply.create.mock.calls[0][0].data;
      expect(data).not.toHaveProperty('id');
      expect(String(data.id ?? '')).not.toMatch(/^USR-/);
    });
  });
});
