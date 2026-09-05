import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException } from '@nestjs/common';
import { AdminSupportService } from '../admin-support.service';
import { PrismaService } from '../../../../prisma/prisma.service';
import { AuditLogService } from '../../../../common/services/audit-log.service';

const mockPrisma = {
  supportTicket: { findMany: jest.fn(), count: jest.fn(), findUnique: jest.fn(), update: jest.fn() },
  supportTicketReply: { create: jest.fn() },
  $transaction: jest.fn(),
};
const mockAuditLog = { logAdminAction: jest.fn() };

describe('AdminSupportService', () => {
  let service: AdminSupportService;

  beforeEach(async () => {
    jest.resetAllMocks();
    mockPrisma.$transaction.mockImplementation(async (callback: (tx: typeof mockPrisma) => unknown) => callback(mockPrisma));
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AdminSupportService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: AuditLogService, useValue: mockAuditLog },
      ],
    }).compile();
    service = module.get(AdminSupportService);
  });

  it('passes a bounded search to subject, message, and requester fields', async () => {
    mockPrisma.supportTicket.findMany.mockResolvedValue([]);
    mockPrisma.supportTicket.count.mockResolvedValue(0);
    const result = await service.listTickets(0, 999, undefined, undefined, '  alice  ');
    expect(result).toMatchObject({ page: 1, limit: 100, totalPages: 0, hasNext: false, hasPrev: false });
    expect(mockPrisma.supportTicket.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ OR: expect.arrayContaining([
        expect.objectContaining({ subject: expect.any(Object) }),
        expect.objectContaining({ message: expect.any(Object) }),
        expect.objectContaining({ user: expect.any(Object) }),
      ]) }),
    }));
  });

  it('returns requester email and counts attachments without exposing attachment keys in list rows', async () => {
    mockPrisma.supportTicket.findMany.mockResolvedValue([{ id: 't1', subject: 'Help', attachments: ['a', 'b'], _count: { replies: 2 }, user: { email: 'a@example.com' } }]);
    mockPrisma.supportTicket.count.mockResolvedValue(1);
    const result = await service.listTickets(1, 20);
    const row = (result as { data: Array<Record<string, unknown>> }).data[0];
    expect(row).toMatchObject({ replyCount: 2, attachmentCount: 2, user: { email: 'a@example.com' } });
    expect(row).not.toHaveProperty('attachments');
  });

  it('uses one transaction for reply and status side effect', async () => {
    mockPrisma.supportTicket.findUnique.mockResolvedValue({ id: 't1', status: 'OPEN' });
    mockPrisma.supportTicketReply.create.mockResolvedValue({ id: 'r1' });
    mockPrisma.supportTicket.update.mockResolvedValue({});
    await service.replyToTicket('t1', 'admin-1', 'reply', '127.0.0.1');
    expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1);
    expect(mockPrisma.supportTicketReply.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ senderType: 'ADMIN' }) }));
  });

  it.each(['RESOLVED', 'CLOSED'])('rejects reopening a %s ticket', async (status) => {
    mockPrisma.supportTicket.findUnique.mockResolvedValue({ id: 't1', status });
    await expect(service.updateStatus('t1', 'OPEN', 'admin-1', '127.0.0.1')).rejects.toBeInstanceOf(BadRequestException);
    expect(mockPrisma.supportTicket.update).not.toHaveBeenCalled();
  });

  it('rejects a no-op status update', async () => {
    mockPrisma.supportTicket.findUnique.mockResolvedValue({ id: 't1', status: 'OPEN' });
    await expect(service.updateStatus('t1', 'OPEN', 'admin-1', '127.0.0.1')).rejects.toThrow('already in this status');
  });
});
