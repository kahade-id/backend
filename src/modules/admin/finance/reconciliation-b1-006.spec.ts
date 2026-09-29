
import { ReconciliationService } from './reconciliation.service';

describe('ReconciliationService — B1-006 incremental + paralel bounded', () => {
  const prisma = {
    wallet: { findUnique: jest.fn(), findMany: jest.fn() },
    walletTransaction: { findMany: jest.fn(), count: jest.fn() },
    user: { findFirst: jest.fn() },
    systemConfig: { findUnique: jest.fn(), upsert: jest.fn() },
  };

  // w-a: bersih (total 100000 = ekspektasi). w-b: selisih (total 90000 vs 100000).
  const walletA = { id: 'w-a', userId: 'u-a', availableBalance: BigInt(100000), escrowBalance: BigInt(0), totalBalance: BigInt(100000) };
  const walletB = { id: 'w-b', userId: 'u-b', availableBalance: BigInt(90000), escrowBalance: BigInt(0), totalBalance: BigInt(90000) };
  const allWallets = [walletA, walletB];

  const txsFor = (walletId: string) => [
    { id: `tx-${walletId}`, type: 'TOP_UP', balanceBefore: BigInt(0), balanceAfter: BigInt(100000) },
  ];

  beforeEach(() => {
    jest.clearAllMocks();
    prisma.systemConfig.findUnique.mockResolvedValue(null);
    prisma.systemConfig.upsert.mockResolvedValue({});
    prisma.walletTransaction.findMany.mockImplementation((args: { where?: Record<string, unknown> }) => {
      // listActiveWalletsSince: hanya w-b yang bertransaksi sejak checkpoint.
      if ((args?.where?.createdAt as Record<string, unknown> | undefined)?.gte) {
        return [{ walletId: 'w-b' }];
      }
      // reconcileWallet: cursor loop per wallet.
      if (Array.isArray(args?.where?.OR)) {
        return txsFor(args.where.walletId as string);
      }
      return [];
    });
    prisma.wallet.findMany.mockImplementation((args: { where?: Record<string, unknown> }) => {
      const ids = (args?.where?.id as Record<string, unknown> | undefined)?.in as string[] | undefined;
      if (ids) return allWallets.filter((w) => ids.includes(w.id));
      return allWallets; // listAllWallets: 1 batch (< 500 -> berhenti)
    });
  });

  it("mode 'full': memeriksa SEMUA wallet dan perhitungan selisih tidak berubah", async () => {
    const service = new ReconciliationService(prisma as never);
    const result = await service.reconcileAllWallets({ mode: 'full' });

    expect(result.walletsChecked).toBe(2);
    expect(result.clean).toBe(false);
    expect(result.discrepancies).toHaveLength(1);
    expect(result.discrepancies[0].userId).toBe('u-b');
    // Perhitungan identik dengan loop lama: 90000 - 100000 = -10000 sen = -100 IDR.
    expect(result.discrepancies[0].discrepancy).toBe(-100);
    expect(result.discrepancies[0].expectedTotal).toBe(1000);
    // Checkpoint sukses ditulis dengan mode full.
    expect(prisma.systemConfig.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ where: { key: 'reconciliation.checkpoint' } }),
    );
    const written = JSON.parse(prisma.systemConfig.upsert.mock.calls[0][0].create.value);
    expect(written.lastMode).toBe('full');
    expect(written.lastFullRunAt).toBeTruthy();
  });

  it("mode 'auto' dengan checkpoint full kemarin -> incremental: hanya wallet aktif yang diperiksa", async () => {
    const yesterday = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    prisma.systemConfig.findUnique.mockResolvedValue({
      value: JSON.stringify({ lastFullRunAt: yesterday, lastRunAt: yesterday, lastMode: 'full' }),
    });
    const service = new ReconciliationService(prisma as never);
    const result = await service.reconcileAllWallets();

    expect(result.walletsChecked).toBe(1);
    expect(result.discrepancies).toHaveLength(1);
    expect(result.discrepancies[0].userId).toBe('u-b');
    expect(prisma.walletTransaction.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ createdAt: expect.objectContaining({ gte: expect.any(Date) }) }) }),
    );
    const written = JSON.parse(prisma.systemConfig.upsert.mock.calls[0][0].create.value);
    expect(written.lastMode).toBe('incremental');
    // Full scan terakhir kemarin -> lastFullRunAt TIDAK ikut maju.
    expect(written.lastFullRunAt).toBe(yesterday);
  });

  it("mode 'auto' tanpa checkpoint -> full scan (aman untuk deploy pertama)", async () => {
    const service = new ReconciliationService(prisma as never);
    const result = await service.reconcileAllWallets();
    expect(result.walletsChecked).toBe(2);
    const written = JSON.parse(prisma.systemConfig.upsert.mock.calls[0][0].create.value);
    expect(written.lastMode).toBe('full');
  });

  it('checkpoint basi >30 hari -> full scan (incremental tidak lagi hemat)', async () => {
    const old = new Date(Date.now() - 40 * 24 * 3600 * 1000).toISOString();
    prisma.systemConfig.findUnique.mockResolvedValue({
      value: JSON.stringify({ lastFullRunAt: old, lastRunAt: old, lastMode: 'incremental' }),
    });
    const service = new ReconciliationService(prisma as never);
    const result = await service.reconcileAllWallets();
    expect(result.walletsChecked).toBe(2);
    const written = JSON.parse(prisma.systemConfig.upsert.mock.calls[0][0].create.value);
    expect(written.lastMode).toBe('full');
  });

  it('error di satu wallet -> run gagal & checkpoint TIDAK ditulis (fail-closed)', async () => {
    prisma.walletTransaction.findMany.mockImplementation((args: { where?: Record<string, unknown> }) => {
      if (Array.isArray(args?.where?.OR) && args.where.walletId === 'w-b') {
        throw new Error('DB down');
      }
      if (Array.isArray(args?.where?.OR)) return txsFor(args.where.walletId as string);
      return [];
    });
    const service = new ReconciliationService(prisma as never);
    await expect(service.reconcileAllWallets({ mode: 'full' })).rejects.toThrow('DB down');
    expect(prisma.systemConfig.upsert).not.toHaveBeenCalled();
  });
});
