import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { SupportService } from '../support.service';
import { PrismaService } from '../../../prisma/prisma.service';
import { UploadService } from '../../upload/upload.service';
import { AuditLogService } from '../../../common/services/audit-log.service';
import { SubscriptionsService } from '../../subscriptions/subscriptions.service';

const mockPrisma = {
  supportTicket: { create: jest.fn(), findMany: jest.fn(), count: jest.fn(), findUnique: jest.fn(), update: jest.fn() },
  supportTicketReply: { create: jest.fn() },
  order: { findFirst: jest.fn() },
  $transaction: jest.fn(),
};

const mockUpload = { verifyUserFileKeys: jest.fn() };
const mockAuditLog = { logAdminAction: jest.fn() };
const mockSubscriptions = { isActive: jest.fn() };

const OPEN_TICKET = { id: 't1', userId: 'u1', status: 'OPEN' };
const ATTACHMENTS = ['uploads/chat-attachments/u1/bukti.jpg'];

describe('SupportService — replyToTicket attachments (BE-IMP item 130)', () => {
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
        { provide: SubscriptionsService, useValue: mockSubscriptions },
      ],
    }).compile();
    service = module.get<SupportService>(SupportService);
  });

  it('menyimpan lampiran balasan setelah file key diverifikasi', async () => {
    mockPrisma.supportTicket.findUnique.mockResolvedValue(OPEN_TICKET);
    const created = { id: 'r1', ticketId: 't1', message: 'Ini buktinya', attachments: ATTACHMENTS };
    mockPrisma.supportTicketReply.create.mockResolvedValue(created);

    const result = await service.replyToTicket('u1', 't1', { message: 'Ini buktinya', attachments: ATTACHMENTS } as any);

    expect(result).toEqual(created);
    expect(mockUpload.verifyUserFileKeys).toHaveBeenCalledWith('u1', ATTACHMENTS, 'CHAT_ATTACHMENT');
    expect(mockPrisma.supportTicketReply.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ attachments: ATTACHMENTS }) }),
    );
  });

  it('balasan tanpa lampiran tetap jalan dengan attachments kosong', async () => {
    mockPrisma.supportTicket.findUnique.mockResolvedValue(OPEN_TICKET);
    mockPrisma.supportTicketReply.create.mockResolvedValue({ id: 'r2', attachments: [] });

    await service.replyToTicket('u1', 't1', { message: 'Halo' } as any);

    expect(mockUpload.verifyUserFileKeys).toHaveBeenCalledWith('u1', [], 'CHAT_ATTACHMENT');
    expect(mockPrisma.supportTicketReply.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ attachments: [] }) }),
    );
  });

  it('gagal verifikasi file key → balasan tidak dibuat', async () => {
    mockPrisma.supportTicket.findUnique.mockResolvedValue(OPEN_TICKET);
    mockUpload.verifyUserFileKeys.mockRejectedValue(
      new BadRequestException({ code: 'VALIDATION_ERROR', message: 'Invalid file key' }),
    );

    await expect(
      service.replyToTicket('u1', 't1', { message: 'x', attachments: ['uploads/evil/u2/x.jpg'] } as any),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(mockPrisma.supportTicketReply.create).not.toHaveBeenCalled();
  });

  it('tiket tertutup tetap menolak balasan ber-lampiran', async () => {
    mockPrisma.supportTicket.findUnique.mockResolvedValue({ ...OPEN_TICKET, status: 'CLOSED' });

    await expect(
      service.replyToTicket('u1', 't1', { message: 'x', attachments: ATTACHMENTS } as any),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('tiket milik user lain → 403', async () => {
    mockPrisma.supportTicket.findUnique.mockResolvedValue({ ...OPEN_TICKET, userId: 'u-lain' });

    await expect(service.replyToTicket('u1', 't1', { message: 'x' } as any)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('tiket tidak ada → 404', async () => {
    mockPrisma.supportTicket.findUnique.mockResolvedValue(null);

    await expect(service.replyToTicket('u1', 't1', { message: 'x' } as any)).rejects.toBeInstanceOf(NotFoundException);
  });
});
