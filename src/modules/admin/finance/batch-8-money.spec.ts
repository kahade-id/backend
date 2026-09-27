/**
 * Batch 8 (MONEY) — regression tests untuk temuan audit yang diperbaiki:
 * - WF-002: ringkasan finance menyertakan revenue langganan Kahade+
 * - WF-012: rejectWithdrawal menulis entri ledger kompensasi (tanpa ubah saldo ganda)
 * - WF-013: pencarian server-side transaksi finance (param q)
 */
import { AdminFinanceService } from './admin-finance.service';
import { DashboardService } from '../dashboard/dashboard.service';

jest.mock('../../../common/utils/crypto.util', () => ({
  decryptAES: jest.fn(async (value: string) => value),
}));

const SEN = (idr: number) => BigInt(idr) * BigInt(100);

function makePrisma() {
  return {
    walletTransaction: {
      findFirst: jest.fn(),
      findMany: jest.fn(),
      count: jest.fn(),
      updateMany: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      findUniqueOrThrow: jest.fn(),
      aggregate: jest.fn(),
    },
    wallet: {
      findUnique: jest.fn(),
      updateMany: jest.fn(),
      aggregate: jest.fn(),
    },
    order: {
      aggregate: jest.fn(),
    },
    $transaction: jest.fn(),
  };
}

function makeService(prisma: ReturnType<typeof makePrisma>) {
  const auditLog = { logAdminAction: jest.fn().mockResolvedValue(undefined) };
  const midtrans = { createIrisPayout: jest.fn() };
  const dashboard = { invalidateSummaryCache: jest.fn(async () => undefined) };
  const service = new AdminFinanceService(
    prisma as never,
    auditLog as never,
    midtrans as never,
    dashboard as never,
  );
  return { service, auditLog, dashboard };
}

describe('Batch 8 money — WF-002 subscription revenue in financial summary', () => {
  it('menambahkan revenue langganan ke total revenue harian/bulanan tanpa mengubah field lama', async () => {
    const prisma = makePrisma();
    const { service } = makeService(prisma);

    // Urutan agregasi di getFinancialSummary: 8 agregat lama + 3 agregat langganan.
    prisma.walletTransaction.aggregate.mockImplementation(async (args: any) => {
      if (args.where?.type === 'SUBSCRIPTION_PAYMENT') {
        if (args.where?.createdAt?.gte) {
          return { _sum: { amount: SEN(50000) }, _count: 2 }; // today & month sama utk uji
        }
        return { _sum: { amount: SEN(200000) }, _count: 8 };
      }
      if (args.where?.type === 'TOP_UP') return { _sum: { amount: SEN(1000000) }, _count: 10 };
      if (args.where?.type === 'WITHDRAW') {
        if (args.where?.withdrawStatus) return { _sum: { amount: SEN(0) }, _count: 0 };
        return { _sum: { amount: SEN(300000) }, _count: 3 };
      }
      return { _sum: { amount: SEN(0) }, _count: 0 };
    });
    prisma.wallet.aggregate.mockResolvedValue({ _sum: { escrowBalance: SEN(0) } });
    prisma.order.aggregate.mockImplementation(async (args: any) => {
      if (args.where?.completedAt?.gte) return { _sum: { feeAmount: SEN(15000) } };
      return { _sum: { feeAmount: SEN(90000) }, _count: 6 };
    });

    const summary = (await service.getFinancialSummary()) as Record<string, number>;

    // Field lama tidak berubah semantiknya (fee-only).
    expect(summary.totalPlatformFeeToday).toBe(15000);
    expect(summary.totalPlatformFeeThisMonth).toBe(15000);
    // Field baru: breakdown langganan + revenue gabungan.
    expect(summary.totalSubscriptionRevenue).toBe(200000);
    expect(summary.totalSubscriptionRevenueCount).toBe(8);
    expect(summary.totalSubscriptionRevenueToday).toBe(50000);
    expect(summary.totalSubscriptionRevenueThisMonth).toBe(50000);
    expect(summary.totalRevenueToday).toBe(15000 + 50000);
    expect(summary.totalRevenueThisMonth).toBe(15000 + 50000);
  });
});

describe('Batch 8 money — WF-012 compensating ledger on withdrawal reject', () => {
  const withdrawTx = {
    id: 'withdraw-internal-1',
    txId: 'WLT-20260926-000001-abc',
    walletId: 'wallet-1',
    type: 'WITHDRAW',
    withdrawStatus: 'PENDING_PROCESS',
    amount: SEN(500000),
    createdAt: new Date(),
  };
  const freshWallet = {
    id: 'wallet-1',
    totalBalance: SEN(2000000),
    availableBalance: SEN(1500000),
    escrowBalance: SEN(500000),
    todayWithdrawAmount: SEN(500000),
    version: 3,
  };

  function mockRejectTx(prisma: ReturnType<typeof makePrisma>) {
    prisma.walletTransaction.findFirst.mockResolvedValue(withdrawTx);
    const ptx = {
      walletTransaction: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        create: jest.fn().mockResolvedValue({ id: 'refund-entry-1' }),
        update: jest.fn().mockResolvedValue({}),
        findUniqueOrThrow: jest.fn().mockResolvedValue({
          ...withdrawTx,
          withdrawStatus: 'FAILED',
          balanceBefore: freshWallet.totalBalance - withdrawTx.amount,
          balanceAfter: freshWallet.totalBalance,
        }),
      },
      wallet: {
        findUnique: jest.fn().mockResolvedValue(freshWallet),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
    prisma.$transaction.mockImplementation(async (cb: any) => cb(ptx));
    return ptx;
  }

  it('membuat entri ADMIN_CREDIT kompensasi + menautkan reversalTxId, dalam transaksi yang sama', async () => {
    const prisma = makePrisma();
    const { service, auditLog, dashboard } = makeService(prisma);
    const ptx = mockRejectTx(prisma);

    await service.rejectWithdrawal(withdrawTx.txId, { adminNote: 'Catatan uji: ditolak' } as never, 'admin-1');

    // Entri kompensasi: kredit sukses sebesar nominal penarikan.
    expect(ptx.walletTransaction.create).toHaveBeenCalledTimes(1);
    expect(ptx.walletTransaction.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        txId: `${withdrawTx.txId}-REFUND`,
        walletId: withdrawTx.walletId,
        type: 'ADMIN_CREDIT',
        status: 'SUCCESS',
        amount: withdrawTx.amount,
        balanceBefore: freshWallet.totalBalance,
        balanceAfter: freshWallet.totalBalance + withdrawTx.amount,
        reversalTxId: withdrawTx.id,
      }),
    });
    // Baris WITHDRAW asli ditautkan ke entri kompensasi (pola reversal).
    expect(ptx.walletTransaction.update).toHaveBeenCalledWith({
      where: { id: withdrawTx.id },
      data: { reversalTxId: 'refund-entry-1' },
    });
    // Audit admin + invalidasi cache tetap jalan.
    expect(auditLog.logAdminAction).toHaveBeenCalled();
    expect(dashboard.invalidateSummaryCache).toHaveBeenCalled();
  });

  it('TIDAK mengubah saldo ganda — increment hanya sekali di wallet.updateMany', async () => {
    const prisma = makePrisma();
    const { service } = makeService(prisma);
    const ptx = mockRejectTx(prisma);

    await service.rejectWithdrawal(withdrawTx.txId, { adminNote: 'Catatan uji: ditolak' } as never, 'admin-1');

    expect(ptx.wallet.updateMany).toHaveBeenCalledTimes(1);
    const data = ptx.wallet.updateMany.mock.calls[0][0].data;
    expect(data.availableBalance).toEqual({ increment: withdrawTx.amount });
    expect(data.totalBalance).toEqual({ increment: withdrawTx.amount });
  });
});

describe('Batch 8 money — WF-013 server-side search (q)', () => {
  const baseQuery = {
    page: 1,
    limit: 20,
    startDate: '2026-09-01',
    endDate: '2026-09-26',
  };

  it('menerapkan filter OR (txId, description, orderId) saat q diisi', async () => {
    const prisma = makePrisma();
    const { service } = makeService(prisma);
    prisma.walletTransaction.findMany.mockResolvedValue([]);
    prisma.walletTransaction.count.mockResolvedValue(0);

    await service.listTransactions({ ...baseQuery, q: 'WLT-2026' } as never);

    const where = prisma.walletTransaction.findMany.mock.calls[0][0].where;
    // E3: cakupan pencarian diperluas ke referensi eksternal provider
    // (midtransOrderId, flashTransactionId, irisPayoutId, irisRef).
    expect(where.OR).toEqual([
      { txId: { contains: 'WLT-2026' } },
      { description: { contains: 'WLT-2026', mode: 'insensitive' } },
      { order: { orderId: { contains: 'WLT-2026' } } },
      { paymentTx: { midtransOrderId: { contains: 'WLT-2026', mode: 'insensitive' } } },
      { paymentTx: { flashTransactionId: { contains: 'WLT-2026', mode: 'insensitive' } } },
      { irisPayoutId: { contains: 'WLT-2026' } },
      { irisRef: { contains: 'WLT-2026' } },
    ]);
    // dipakai juga untuk count agar paginasi konsisten
    expect(prisma.walletTransaction.count.mock.calls[0][0].where).toEqual(where);
  });

  it('tanpa q: tidak ada klausa OR (perilaku lama tetap)', async () => {
    const prisma = makePrisma();
    const { service } = makeService(prisma);
    prisma.walletTransaction.findMany.mockResolvedValue([]);
    prisma.walletTransaction.count.mockResolvedValue(0);

    await service.listTransactions({ ...baseQuery } as never);

    const where = prisma.walletTransaction.findMany.mock.calls[0][0].where;
    expect(where.OR).toBeUndefined();
  });
});
