import { ConflictException } from '@nestjs/common';
import {
  ReconciliationFindingsService,
  URGENT_INVARIANT,
  LEDGER_MISMATCH_INVARIANT,
  RECONCILIATION_URGENT_THRESHOLD_IDR,
} from './reconciliation-findings.service';
import type { WalletDiscrepancy } from './reconciliation.service';

const discrepancy = (userId: string, diffIdr: number): WalletDiscrepancy => ({
  walletId: 'wallet-1',
  userId,
  actualAvailable: 100000,
  actualEscrow: 0,
  actualTotal: 100000,
  expectedTotal: 100000 - diffIdr,
  discrepancy: diffIdr,
  invariantViolation: false,
});

const findingRow = (overrides: Record<string, unknown> = {}) => ({
  id: 'finding-1',
  userId: 'user-1',
  recordedBalance: 10000000n,
  computedBalance: 9000000n,
  difference: 1000000n,
  violatedInvariants: [LEDGER_MISMATCH_INVARIANT],
  status: 'NEW',
  batchId: 'batch-1',
  acknowledgedBy: null,
  acknowledgedAt: null,
  notes: null,
  createdAt: new Date('2026-09-26T10:00:00Z'),
  updatedAt: new Date('2026-09-26T10:00:00Z'),
  ...overrides,
});

describe('ReconciliationFindingsService', () => {
  const prisma = {
    reconciliationFinding: {
      findFirst: jest.fn(),
      create: jest.fn(),
      findMany: jest.fn(),
      count: jest.fn(),
      findUnique: jest.fn(),
      update: jest.fn(),
    },
  };
  const auditLog = { logAdminAction: jest.fn() };
  const redis = { setex: jest.fn().mockResolvedValue(undefined) };

  const service = () =>
    new ReconciliationFindingsService(prisma as never, auditLog as never, redis as never);

  beforeEach(() => jest.clearAllMocks());

  it('dedup: tidak membuat temuan duplikat bila user sudah punya temuan NEW', async () => {
    prisma.reconciliationFinding.findFirst.mockResolvedValue({ id: 'existing-1' });
    const created = await service().recordFromDiscrepancies([discrepancy('user-1', 50000)], 'batch-1', 'admin-1');
    expect(created).toEqual([]);
    expect(prisma.reconciliationFinding.create).not.toHaveBeenCalled();
  });

  it('dedup: tidak membuat duplikat untuk temuan INVESTIGATING', async () => {
    prisma.reconciliationFinding.findFirst.mockResolvedValue({ id: 'existing-2' });
    const created = await service().recordFromDiscrepancies([discrepancy('user-2', 50000)], 'batch-1', 'admin-1');
    expect(prisma.reconciliationFinding.create).not.toHaveBeenCalled();
    expect(created).toEqual([]);
  });

  it('membuat temuan baru bila tidak ada temuan yang belum selesai', async () => {
    prisma.reconciliationFinding.findFirst.mockResolvedValue(null);
    prisma.reconciliationFinding.create.mockImplementation(({ data }: { data: Record<string, unknown> }) => ({
      ...findingRow(),
      ...data,
      status: 'NEW',
    }));
    const created = await service().recordFromDiscrepancies([discrepancy('user-3', 50000)], 'batch-9', 'admin-1');
    expect(created).toHaveLength(1);
    expect(prisma.reconciliationFinding.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ userId: 'user-3', batchId: 'batch-9' }),
      }),
    );
  });

  it('menandai URGENT + menaikkan alert bila |difference| > ambang', async () => {
    prisma.reconciliationFinding.findFirst.mockResolvedValue(null);
    prisma.reconciliationFinding.create.mockImplementation(({ data }: { data: Record<string, unknown> }) => ({
      ...findingRow(),
      ...data,
      status: 'NEW',
    }));
    const big = RECONCILIATION_URGENT_THRESHOLD_IDR + 1_000_000;
    const created = await service().recordFromDiscrepancies([discrepancy('user-4', big)], 'batch-1', 'admin-1');

    expect(created).toHaveLength(1);
    expect(created[0].urgent).toBe(true);
    expect(created[0].violatedInvariants).toContain(URGENT_INVARIANT);
    expect(redis.setex).toHaveBeenCalledWith(
      'cron_alert:reconciliation_urgent',
      24 * 3600,
      expect.stringContaining('user-4'),
    );
  });

  it('tidak menandai URGENT bila selisih di bawah ambang', async () => {
    prisma.reconciliationFinding.findFirst.mockResolvedValue(null);
    prisma.reconciliationFinding.create.mockImplementation(({ data }: { data: Record<string, unknown> }) => ({
      ...findingRow(),
      ...data,
      status: 'NEW',
    }));
    const created = await service().recordFromDiscrepancies([discrepancy('user-5', 100000)], 'batch-1', 'admin-1');
    expect(created[0].urgent).toBe(false);
    expect(created[0].violatedInvariants).not.toContain(URGENT_INVARIANT);
    expect(redis.setex).not.toHaveBeenCalled();
  });

  it('menyimpan selisih negatif tanpa melempar (signed difference)', async () => {
    prisma.reconciliationFinding.findFirst.mockResolvedValue(null);
    prisma.reconciliationFinding.create.mockImplementation(({ data }: { data: Record<string, unknown> }) => ({
      ...findingRow(),
      ...data,
      status: 'NEW',
    }));
    // discrepancy negatif: computed < recorded (mis. -2_500_000).
    const created = await service().recordFromDiscrepancies([discrepancy('user-6', -2500000)], 'batch-1', 'admin-1');
    expect(created).toHaveLength(1);
    expect(created[0].differenceIdr).toBe(-2500000);
    expect(prisma.reconciliationFinding.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          // -2_500_000 IDR = -250_000_000 sen (bigint bertanda).
          difference: BigInt(-250000000),
        }),
      }),
    );
  });

  it('menolak transisi status yang tidak valid (RESOLVED → INVESTIGATING)', async () => {
    prisma.reconciliationFinding.findUnique.mockResolvedValue(findingRow({ status: 'RESOLVED' }));
    await expect(
      service().acknowledgeFinding('finding-1', 'admin-1', { status: 'INVESTIGATING', notes: 'cek lagi' }, '127.0.0.1'),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(prisma.reconciliationFinding.update).not.toHaveBeenCalled();
  });

  it('mengizinkan transisi NEW → INVESTIGATING dengan catatan', async () => {
    prisma.reconciliationFinding.findUnique.mockResolvedValue(findingRow({ status: 'NEW' }));
    prisma.reconciliationFinding.update.mockImplementation(({ data }: { data: Record<string, unknown> }) => ({
      ...findingRow(),
      ...data,
      status: 'INVESTIGATING',
    }));
    const view = await service().acknowledgeFinding(
      'finding-1',
      'admin-9',
      { status: 'INVESTIGATING', notes: 'telusuri mutasi' },
      '127.0.0.1',
    );
    expect(view.status).toBe('INVESTIGATING');
    expect(view.acknowledgedBy).toBe('admin-9');
    expect(auditLog.logAdminAction).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'RECONCILIATION_FINDING_ACKNOWLEDGED' }),
    );
  });
});
