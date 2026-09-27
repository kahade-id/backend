import {
  ForbiddenException,
  UnprocessableEntityException,
  BadRequestException,
  ConflictException,
} from '@nestjs/common';
import {
  LedgerCorrectionService,
  MAX_LEDGER_CORRECTION_IDR,
  newCorrectionId,
} from './ledger-corrections.service';
import { ParseIdPipe } from '../../../common/pipes/parse-id.pipe';
import { AuditAction } from '@prisma/client';

const requestRow = (overrides: Record<string, unknown> = {}) => ({
  id: 'audit-1',
  adminId: 'admin-requester',
  action: AuditAction.MANUAL_LEDGER_CORRECTION,
  targetType: 'LedgerCorrectionRequest',
  targetId: 'req-1',
  description: 'req',
  before: null,
  after: {
    userId: 'user-1',
    amountSen: '5000000',
    amountIdr: 50000,
    type: 'CREDIT',
    reason: 'Koreksi selisih hasil rekonsiliasi batch',
    ticketRef: 'TICKET-123',
    idempotencyKey: 'key-abc',
    requestedBy: 'admin-requester',
    requestedAt: new Date().toISOString(),
    status: 'PENDING_APPROVAL',
  },
  ipAddress: '127.0.0.1',
  userAgent: null,
  createdAt: new Date(),
  ...overrides,
});

describe('LedgerCorrectionService — guard', () => {
  const prisma = {
    adminAuditLog: { findFirst: jest.fn(), create: jest.fn(), findMany: jest.fn(), count: jest.fn() },
    wallet: { findUnique: jest.fn() },
  };
  const walletTxSerial = { getNext: jest.fn().mockResolvedValue(42) };
  const service = () => new LedgerCorrectionService(prisma as never, walletTxSerial as never);

  beforeEach(() => jest.clearAllMocks());

  it('menolak self-approve (approver = requester)', () => {
    expect(() => LedgerCorrectionService.assertNotSelfApproval('admin-1', 'admin-1')).toThrow(ForbiddenException);
    expect(() => LedgerCorrectionService.assertNotSelfApproval('admin-1', 'admin-1')).toThrow(
      expect.objectContaining({ response: expect.objectContaining({ code: 'CORRECTION_SELF_APPROVAL' }) }),
    );
  });

  it('mengizinkan approver berbeda', () => {
    expect(() => LedgerCorrectionService.assertNotSelfApproval('admin-1', 'admin-2')).not.toThrow();
  });

  it('menolak nominal di atas batas rate limit', () => {
    expect(() => LedgerCorrectionService.assertAmountWithinLimit(MAX_LEDGER_CORRECTION_IDR + 1)).toThrow(
      UnprocessableEntityException,
    );
    expect(() => LedgerCorrectionService.assertAmountWithinLimit(MAX_LEDGER_CORRECTION_IDR + 1)).toThrow(
      expect.objectContaining({ response: expect.objectContaining({ code: 'CORRECTION_AMOUNT_EXCEEDS_LIMIT' }) }),
    );
  });

  it('mengizinkan nominal tepat pada batas', () => {
    expect(() => LedgerCorrectionService.assertAmountWithinLimit(MAX_LEDGER_CORRECTION_IDR)).not.toThrow();
  });

  it('menolak nominal nol/negatif', () => {
    expect(() => LedgerCorrectionService.assertAmountWithinLimit(0)).toThrow(BadRequestException);
    expect(() => LedgerCorrectionService.assertAmountWithinLimit(-100)).toThrow(BadRequestException);
  });

  it('ID koreksi yang digenerate lolos ParseIdPipe (endpoint :id tidak 400)', () => {
    const pipe = new ParseIdPipe();
    for (let i = 0; i < 5; i++) {
      const id = newCorrectionId();
      expect(id.startsWith('CORR-')).toBe(true);
      expect(() => pipe.transform(id)).not.toThrow();
      expect(pipe.transform(id)).toBe(id);
    }
  });
});

describe('LedgerCorrectionService — idempotency & dual approval', () => {
  const prisma = {
    adminAuditLog: { findFirst: jest.fn(), create: jest.fn(), findMany: jest.fn(), count: jest.fn() },
    wallet: { findUnique: jest.fn() },
  };
  const walletTxSerial = { getNext: jest.fn().mockResolvedValue(42) };
  const service = () => new LedgerCorrectionService(prisma as never, walletTxSerial as never);

  // clearAllMocks TIDAK mengosongkan antrean mockResolvedValueOnce —
  // tanpa mockReset, hasil once dari test sebelumnya bocor ke test berikut.
  beforeEach(() => {
    jest.clearAllMocks();
    prisma.adminAuditLog.findFirst.mockReset();
  });

  const dto = {
    userId: 'user-1',
    amountIdr: 50000,
    type: 'CREDIT' as const,
    reason: 'Koreksi selisih hasil rekonsiliasi batch',
    ticketRef: 'TICKET-123',
    idempotencyKey: 'key-abc',
  };

  it('replay idempotencyKey dengan payload sama mengembalikan request yang sama tanpa membuat baru', async () => {
    prisma.adminAuditLog.findFirst.mockResolvedValue(requestRow());
    const view = await service().requestCorrection('admin-requester', dto, '127.0.0.1');
    expect(view.id).toBe('req-1');
    expect(view.status).toBe('PENDING_APPROVAL');
    expect(prisma.adminAuditLog.create).not.toHaveBeenCalled();
  });

  it('idempotencyKey dipakai ulang dengan payload berbeda → 409', async () => {
    prisma.adminAuditLog.findFirst.mockResolvedValue(requestRow());
    await expect(
      service().requestCorrection('admin-requester', { ...dto, amountIdr: 99999 }, '127.0.0.1'),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('membuat request PENDING_APPROVAL baru tanpa mutasi saldo', async () => {
    prisma.adminAuditLog.findFirst.mockResolvedValue(null);
    prisma.wallet.findUnique.mockResolvedValue({ id: 'w-1', availableBalance: 10000000n, isLocked: false });
    prisma.adminAuditLog.create.mockImplementation(({ data }: { data: Record<string, unknown> }) => ({
      ...requestRow(),
      ...data,
      targetId: 'req-new',
    }));
    const view = await service().requestCorrection('admin-requester', { ...dto, idempotencyKey: 'key-new' }, '127.0.0.1');
    expect(view.status).toBe('PENDING_APPROVAL');
    expect(prisma.wallet.findUnique).toHaveBeenCalled();
    // Tidak ada mutasi wallet pada tahap request.
    expect(prisma.adminAuditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: AuditAction.MANUAL_LEDGER_CORRECTION,
          targetType: 'LedgerCorrectionRequest',
        }),
      }),
    );
  });

  it('decideCorrection menolak bila approver sama dengan requester (sebelum mutasi apa pun)', async () => {
    prisma.adminAuditLog.findFirst
      .mockResolvedValueOnce(requestRow()) // request row
      .mockResolvedValueOnce(null); // no decision yet
    await expect(
      service().decideCorrection('req-1', 'admin-requester', { decision: 'APPROVE' }, '127.0.0.1'),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.adminAuditLog.create).not.toHaveBeenCalled();
  });

  it('decideCorrection menolak bila request sudah diputuskan', async () => {
    prisma.adminAuditLog.findFirst
      .mockResolvedValueOnce(requestRow()) // request row
      .mockResolvedValueOnce({ id: 'decision-1' }); // existing decision
    await expect(
      service().decideCorrection('req-1', 'admin-other', { decision: 'APPROVE' }, '127.0.0.1'),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('REJECT oleh admin berbeda mencatat decision tanpa mutasi wallet', async () => {
    prisma.adminAuditLog.findFirst
      .mockResolvedValueOnce(requestRow())
      .mockResolvedValueOnce(null);
    prisma.adminAuditLog.create.mockImplementation(({ data }: { data: Record<string, unknown> }) => ({
      id: 'decision-1',
      ...data,
    }));
    const view = await service().decideCorrection(
      'req-1',
      'admin-other',
      { decision: 'REJECT', notes: 'data tidak valid' },
      '127.0.0.1',
    );
    expect(view.status).toBe('REJECTED');
    expect(view.decidedBy).toBe('admin-other');
    expect(prisma.adminAuditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ targetType: 'LedgerCorrectionDecision' }),
      }),
    );
  });
});
