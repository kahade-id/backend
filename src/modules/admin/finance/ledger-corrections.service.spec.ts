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

jest.mock('../../../common/utils/crypto.util', () => ({
  bcryptCompare: jest.fn(async (plain: string) => plain === 'password123'),
}));

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
    user: { findFirst: jest.fn() },
    adminUser: { findUnique: jest.fn() },
  };
  // ADM-206: mock re-auth password — 'password123' valid, lainnya tidak.
  const redis = {
    get: jest.fn(async () => null),
    incrWithTtl: jest.fn(async () => 1),
    del: jest.fn(async () => undefined),
  };
  const walletTxSerial = { getNext: jest.fn().mockResolvedValue(42) };
  const service = () => new LedgerCorrectionService(prisma as never, walletTxSerial as never, redis as never);

  beforeEach(() => {
    jest.clearAllMocks();
    prisma.user.findFirst.mockResolvedValue({ id: 'user-1' });
    prisma.adminUser.findUnique.mockResolvedValue({ password: 'hashed', isActive: true, deletedAt: null });
  });

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
    user: { findFirst: jest.fn() },
    adminUser: { findUnique: jest.fn() },
  };
  // ADM-206: mock re-auth password — 'password123' valid, lainnya tidak.
  const redis = {
    get: jest.fn(async () => null),
    incrWithTtl: jest.fn(async () => 1),
    del: jest.fn(async () => undefined),
  };
  const walletTxSerial = { getNext: jest.fn().mockResolvedValue(42) };
  const service = () => new LedgerCorrectionService(prisma as never, walletTxSerial as never, redis as never);

  // clearAllMocks TIDAK mengosongkan antrean mockResolvedValueOnce —
  // tanpa mockReset, hasil once dari test sebelumnya bocor ke test berikut.
  beforeEach(() => {
    jest.clearAllMocks();
    prisma.adminAuditLog.findFirst.mockReset();
    prisma.user.findFirst.mockResolvedValue({ id: 'user-1' });
    prisma.adminUser.findUnique.mockResolvedValue({ password: 'hashed', isActive: true, deletedAt: null });
  });

  const dto = {
    userId: 'user-1',
    amountIdr: 50000,
    type: 'CREDIT' as const,
    reason: 'Koreksi selisih hasil rekonsiliasi batch',
    ticketRef: 'TICKET-123',
    idempotencyKey: 'key-abc',
    reauthPassword: 'password123',
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
      service().decideCorrection('req-1', 'admin-requester', { decision: 'APPROVE', reauthPassword: 'password123' }, '127.0.0.1'),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.adminAuditLog.create).not.toHaveBeenCalled();
  });

  it('decideCorrection menolak bila request sudah diputuskan', async () => {
    prisma.adminAuditLog.findFirst
      .mockResolvedValueOnce(requestRow()) // request row
      .mockResolvedValueOnce({ id: 'decision-1' }); // existing decision
    await expect(
      service().decideCorrection('req-1', 'admin-other', { decision: 'APPROVE', reauthPassword: 'password123' }, '127.0.0.1'),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('BAI-054: APPROVE ditolak 409 LEDGER_CORRECTION_WALLET_DISABLED bila wallet nonaktif', async () => {
    prisma.adminAuditLog.findFirst
      .mockResolvedValueOnce(requestRow()) // request row
      .mockResolvedValueOnce(null); // no decision yet
    const walletMode = { isWalletEnabled: () => false };
    const svc = new LedgerCorrectionService(
      prisma as never,
      { getNext: jest.fn().mockResolvedValue(42) } as never,
      redis as never,
      walletMode as never,
    );
    const err = await svc
      .decideCorrection('req-1', 'admin-other', { decision: 'APPROVE', reauthPassword: 'password123' }, '127.0.0.1')
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect((err as { response?: { code?: string } }).response?.code).toBe('LEDGER_CORRECTION_WALLET_DISABLED');
    // Fail-closed: tidak ada decision yang dicatat.
    expect(prisma.adminAuditLog.create).not.toHaveBeenCalled();
  });

  it('BAI-054: APPROVE tetap jalan bila wallet aktif (guard tidak memblokir)', async () => {
    prisma.adminAuditLog.findFirst
      .mockResolvedValueOnce(requestRow()) // request row
      .mockResolvedValueOnce(null); // no decision yet
    const walletMode = { isWalletEnabled: () => true };
    const svc = new LedgerCorrectionService(
      prisma as never,
      { getNext: jest.fn().mockResolvedValue(42) } as never,
      redis as never,
      walletMode as never,
    );
    // Tidak boleh melempar LEDGER_CORRECTION_WALLET_DISABLED — boleh gagal
    // di langkah berikutnya (mock), tapi bukan di guard wallet.
    const err = await svc
      .decideCorrection('req-1', 'admin-other', { decision: 'APPROVE', reauthPassword: 'password123' }, '127.0.0.1')
      .catch((e: unknown) => e);
    if (err instanceof ConflictException) {
      expect((err as unknown as { response?: { code?: string } }).response?.code).not.toBe('LEDGER_CORRECTION_WALLET_DISABLED');
    }
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
      { decision: 'REJECT', notes: 'data tidak valid', reauthPassword: 'password123' },
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

describe('LedgerCorrectionService — ADM-201 resolusi ID publik', () => {
  const prisma = {
    adminAuditLog: { findFirst: jest.fn(), create: jest.fn(), findMany: jest.fn(), count: jest.fn() },
    wallet: { findUnique: jest.fn() },
    user: { findFirst: jest.fn() },
    adminUser: { findUnique: jest.fn() },
  };
  // ADM-206: mock re-auth password — 'password123' valid, lainnya tidak.
  const redis = {
    get: jest.fn(async () => null),
    incrWithTtl: jest.fn(async () => 1),
    del: jest.fn(async () => undefined),
  };
  const walletTxSerial = { getNext: jest.fn().mockResolvedValue(42) };
  const service = () => new LedgerCorrectionService(prisma as never, walletTxSerial as never, redis as never);

  beforeEach(() => {
    jest.clearAllMocks();
    prisma.adminAuditLog.findFirst.mockReset();
    // ADM-206: re-auth password valid default.
    prisma.adminUser.findUnique.mockResolvedValue({ password: 'hashed', isActive: true, deletedAt: null });
  });

  const dto = {
    userId: 'USR-PUBLIK1',
    amountIdr: 50000,
    type: 'CREDIT' as const,
    reason: 'Koreksi selisih hasil rekonsiliasi batch',
    ticketRef: 'TICKET-123',
    idempotencyKey: 'key-publik',
    reauthPassword: 'password123',
  };

  it('ID publik USR-… diresolusi ke cuid internal sebelum cek wallet', async () => {
    prisma.adminAuditLog.findFirst.mockResolvedValue(null);
    prisma.user.findFirst.mockResolvedValue({ id: 'clx-internal-1' });
    prisma.wallet.findUnique.mockResolvedValue({ id: 'w-1', availableBalance: 10000000n, isLocked: false });
    prisma.adminAuditLog.create.mockImplementation(({ data }: { data: Record<string, unknown> }) => ({
      id: 'audit-9',
      ...data,
      targetId: 'req-9',
    }));

    await service().requestCorrection('admin-requester', dto, '127.0.0.1');

    expect(prisma.wallet.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: 'clx-internal-1' } }),
    );
    // Payload tersimpan memakai cuid internal (idempotency stabil antar format).
    expect(prisma.adminAuditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          after: expect.objectContaining({ userId: 'clx-internal-1' }),
        }),
      }),
    );
  });

  it('replay idempotency dengan format ID berbeda tetap dianggap payload sama', async () => {
    prisma.user.findFirst.mockResolvedValue({ id: 'clx-internal-1' });
    prisma.adminAuditLog.findFirst.mockResolvedValue(
      requestRow({ after: { ...(requestRow().after as object), userId: 'clx-internal-1' } }),
    );
    const view = await service().requestCorrection('admin-requester', dto, '127.0.0.1');
    expect(view.id).toBe('req-1');
    expect(prisma.adminAuditLog.create).not.toHaveBeenCalled();
  });

  it('user tidak dikenal → 404 (fail closed)', async () => {
    prisma.adminAuditLog.findFirst.mockResolvedValue(null);
    prisma.user.findFirst.mockResolvedValue(null);
    await expect(service().requestCorrection('admin-requester', dto, '127.0.0.1')).rejects.toThrow(
      expect.objectContaining({
        response: expect.objectContaining({ code: 'USER_NOT_FOUND' }),
      }),
    );
    expect(prisma.wallet.findUnique).not.toHaveBeenCalled();
  });
});

describe('LedgerCorrectionService — ADM-206 re-auth password server-side', () => {
  const prisma = {
    adminAuditLog: { findFirst: jest.fn(), create: jest.fn(), findMany: jest.fn(), count: jest.fn() },
    wallet: { findUnique: jest.fn() },
    user: { findFirst: jest.fn() },
    adminUser: { findUnique: jest.fn() },
  };
  const walletTxSerial = { getNext: jest.fn().mockResolvedValue(42) };
  const redis = {
    get: jest.fn(async () => null),
    incrWithTtl: jest.fn(async () => 1),
    del: jest.fn(async () => undefined),
  };
  const service = () => new LedgerCorrectionService(prisma as never, walletTxSerial as never, redis as never);

  const dto = {
    userId: 'user-1',
    amountIdr: 50000,
    type: 'CREDIT' as const,
    reason: 'Koreksi selisih hasil rekonsiliasi batch',
    ticketRef: 'TICKET-123',
    idempotencyKey: 'key-reauth',
  };

  beforeEach(() => {
    jest.clearAllMocks();
    prisma.adminAuditLog.findFirst.mockReset();
    prisma.user.findFirst.mockResolvedValue({ id: 'user-1' });
    prisma.adminUser.findUnique.mockResolvedValue({ password: 'hashed', isActive: true, deletedAt: null });
    prisma.wallet.findUnique.mockResolvedValue({ id: 'w-1', availableBalance: 10000000n, isLocked: false });
    prisma.adminAuditLog.create.mockImplementation(({ data }: { data: Record<string, unknown> }) => ({
      id: 'audit-r',
      ...data,
      targetId: 'req-r',
    }));
  });

  it('kata sandi benar → request dibuat', async () => {
    prisma.adminAuditLog.findFirst.mockResolvedValue(null);
    const view = await service().requestCorrection('admin-1', { ...dto, reauthPassword: 'password123' }, '127.0.0.1');
    expect(view.status).toBe('PENDING_APPROVAL');
    expect(prisma.adminAuditLog.create).toHaveBeenCalled();
  });

  it('tanpa reauthPassword → 400 REAUTH_PASSWORD_REQUIRED (fail-closed)', async () => {
    await expect(service().requestCorrection('admin-1', { ...dto } as never, '127.0.0.1')).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'REAUTH_PASSWORD_REQUIRED' }),
    });
    expect(prisma.adminAuditLog.create).not.toHaveBeenCalled();
  });

  it('kata sandi salah → 401 REAUTH_INVALID_PASSWORD + counter naik', async () => {
    await expect(
      service().requestCorrection('admin-1', { ...dto, reauthPassword: 'salah' }, '127.0.0.1'),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'REAUTH_INVALID_PASSWORD' }),
    });
    expect(redis.incrWithTtl).toHaveBeenCalledWith('reauth:fail:admin-1', 900);
    expect(prisma.adminAuditLog.create).not.toHaveBeenCalled();
  });

  it('5x salah → 429 REAUTH_TOO_MANY_ATTEMPTS', async () => {
    redis.get.mockResolvedValueOnce('5' as unknown as null);
    await expect(
      service().requestCorrection('admin-1', { ...dto, reauthPassword: 'password123' }, '127.0.0.1'),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'REAUTH_TOO_MANY_ATTEMPTS' }),
    });
    expect(prisma.adminAuditLog.create).not.toHaveBeenCalled();
  });

  it('token palsu warisan "password-confirm:..." → 400 (tidak lagi diterima)', async () => {
    await expect(
      service().requestCorrection('admin-1', { ...dto, reauthPassword: 'password123', reauthToken: 'password-confirm:provided' } as never, '127.0.0.1'),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'REAUTH_PASSWORD_REQUIRED' }),
    });
    expect(prisma.adminAuditLog.create).not.toHaveBeenCalled();
  });

  it('kata sandi benar → counter gagal di-reset', async () => {
    prisma.adminAuditLog.findFirst.mockResolvedValue(null);
    await service().requestCorrection('admin-1', { ...dto, reauthPassword: 'password123' }, '127.0.0.1');
    expect(redis.del).toHaveBeenCalledWith('reauth:fail:admin-1');
  });
});
