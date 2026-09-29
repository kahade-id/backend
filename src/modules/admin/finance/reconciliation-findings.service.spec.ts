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
      createManyAndReturn: jest.fn(),
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

  // B1-010: recordFromDiscrepancies kini memakai 1x findMany (dedup batch) +
  // 1x createManyAndReturn, bukan findFirst/create per temuan.
  const mockDedupMiss = () => prisma.reconciliationFinding.findMany.mockResolvedValue([]);
  const mockDedupHit = (userId: string) =>
    prisma.reconciliationFinding.findMany.mockResolvedValue([{ userId }]);
  const mockCreateMany = () =>
    prisma.reconciliationFinding.createManyAndReturn.mockImplementation(
      ({ data }: { data: Record<string, unknown>[] }) =>
        data.map((d, i) => ({ ...findingRow({ id: `finding-${i + 1}` }), ...d, status: 'NEW' })),
    );

  it('dedup: tidak membuat temuan duplikat bila user sudah punya temuan NEW', async () => {
    mockDedupHit('user-1');
    const created = await service().recordFromDiscrepancies([discrepancy('user-1', 50000)], 'batch-1', 'admin-1');
    expect(created).toEqual([]);
    expect(prisma.reconciliationFinding.createManyAndReturn).not.toHaveBeenCalled();
  });

  it('dedup: tidak membuat duplikat untuk temuan INVESTIGATING', async () => {
    mockDedupHit('user-2');
    const created = await service().recordFromDiscrepancies([discrepancy('user-2', 50000)], 'batch-1', 'admin-1');
    expect(prisma.reconciliationFinding.createManyAndReturn).not.toHaveBeenCalled();
    expect(created).toEqual([]);
  });

  it('membuat temuan baru bila tidak ada temuan yang belum selesai', async () => {
    mockDedupMiss();
    mockCreateMany();
    const created = await service().recordFromDiscrepancies([discrepancy('user-3', 50000)], 'batch-9', 'admin-1');
    expect(created).toHaveLength(1);
    expect(prisma.reconciliationFinding.createManyAndReturn).toHaveBeenCalledWith(
      expect.objectContaining({
        data: [expect.objectContaining({ userId: 'user-3', batchId: 'batch-9' })],
      }),
    );
  });

  it('dedup intra-batch: user yang sama 2x dalam satu batch hanya dibuat sekali', async () => {
    mockDedupMiss();
    mockCreateMany();
    const created = await service().recordFromDiscrepancies(
      [discrepancy('user-7', 50000), discrepancy('user-7', 60000)],
      'batch-1',
      'admin-1',
    );
    expect(created).toHaveLength(1);
    expect(prisma.reconciliationFinding.createManyAndReturn).toHaveBeenCalledTimes(1);
  });

  it('menandai URGENT + menaikkan alert bila |difference| > ambang', async () => {
    mockDedupMiss();
    mockCreateMany();
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
    mockDedupMiss();
    mockCreateMany();
    const created = await service().recordFromDiscrepancies([discrepancy('user-5', 100000)], 'batch-1', 'admin-1');
    expect(created[0].urgent).toBe(false);
    expect(created[0].violatedInvariants).not.toContain(URGENT_INVARIANT);
    expect(redis.setex).not.toHaveBeenCalled();
  });

  it('menyimpan selisih negatif tanpa melempar (signed difference)', async () => {
    mockDedupMiss();
    mockCreateMany();
    // discrepancy negatif: computed < recorded (mis. -2_500_000).
    const created = await service().recordFromDiscrepancies([discrepancy('user-6', -2500000)], 'batch-1', 'admin-1');
    expect(created).toHaveLength(1);
    expect(created[0].differenceIdr).toBe(-2500000);
    expect(prisma.reconciliationFinding.createManyAndReturn).toHaveBeenCalledWith(
      expect.objectContaining({
        data: [
          expect.objectContaining({
            // -2_500_000 IDR = -250_000_000 sen (bigint bertanda).
            difference: BigInt(-250000000),
          }),
        ],
      }),
    );
  });

  it('ADM-228: mengizinkan reopen RESOLVED → INVESTIGATING dengan catatan (audit REOPENED)', async () => {
    prisma.reconciliationFinding.findUnique.mockResolvedValue(findingRow({ status: 'RESOLVED' }));
    prisma.reconciliationFinding.update.mockResolvedValue(findingRow({ status: 'INVESTIGATING' }));
    const res = (await service().acknowledgeFinding(
      'finding-1',
      'admin-1',
      { status: 'INVESTIGATING', notes: 'cek lagi' },
      '127.0.0.1',
    )) as { status: string };
    expect(res.status).toBe('INVESTIGATING');
    expect(auditLog.logAdminAction).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'RECONCILIATION_FINDING_REOPENED' }),
    );
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
