import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException, ForbiddenException, BadRequestException } from '@nestjs/common';
import { SupportService } from '../support.service';
import { PrismaService } from '../../../prisma/prisma.service';
import { UploadService } from '../../upload/upload.service';
import { AuditLogService } from '../../../common/services/audit-log.service';

const mockPrisma = {
  supportTicket: { create: jest.fn(), findMany: jest.fn(), count: jest.fn(), findUnique: jest.fn(), update: jest.fn() },
  supportTicketReply: { create: jest.fn() },
  order: { findFirst: jest.fn() },
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

  // ============================================================
  // D1-010: getTicketFingerprint (fingerprint ringan untuk poll)
  // ============================================================

  describe('getTicketFingerprint (D1-010)', () => {
    const fingerprintRow = {
      id: 'ticket-1',
      userId: 'user-1',
      status: 'OPEN',
      updatedAt: new Date('2026-09-29T10:00:00.000Z'),
      _count: { replies: 2 },
    };

    it('mengembalikan status + updatedAt + replyCount tanpa memuat semua balasan', async () => {
      mockPrisma.supportTicket.findUnique.mockResolvedValue(fingerprintRow);
      const result = await service.getTicketFingerprint('user-1', 'ticket-1');
      expect(result).toEqual({
        ticketId: 'ticket-1',
        status: 'OPEN',
        updatedAt: fingerprintRow.updatedAt,
        replyCount: 2,
      });
      const args = mockPrisma.supportTicket.findUnique.mock.calls[0][0];
      expect(args.include).toBeUndefined();
      expect(args.select._count).toEqual({ select: { replies: true } });
    });

    it('NotFound untuk tiket tak dikenal', async () => {
      mockPrisma.supportTicket.findUnique.mockResolvedValue(null);
      await expect(service.getTicketFingerprint('user-1', 'ticket-x')).rejects.toThrow(NotFoundException);
    });

    it('Forbidden untuk pemilik tiket lain', async () => {
      mockPrisma.supportTicket.findUnique.mockResolvedValue(fingerprintRow);
      await expect(service.getTicketFingerprint('user-2', 'ticket-1')).rejects.toThrow(ForbiddenException);
    });
  });
});
