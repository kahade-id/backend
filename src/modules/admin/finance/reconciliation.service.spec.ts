import { ReconciliationService } from './reconciliation.service';

describe('ReconciliationService', () => {
  const prisma = {
    wallet: { findUnique: jest.fn(), findMany: jest.fn() },
    walletTransaction: { findMany: jest.fn(), count: jest.fn() },
    user: { findFirst: jest.fn() },
  };

  beforeEach(() => {
    jest.clearAllMocks();
    prisma.user.findFirst.mockResolvedValue({ id: 'user-1' });
  });

  it('does not report a false mismatch for a pending withdrawal that has already reserved total balance', async () => {
    prisma.wallet.findUnique.mockResolvedValue({
      id: 'wallet-1', userId: 'user-1', availableBalance: BigInt(90000), escrowBalance: BigInt(0), totalBalance: BigInt(90000),
    });
    prisma.walletTransaction.findMany.mockImplementation(({ where }: { where: Record<string, unknown> }) => {
      if (Array.isArray(where.OR)) {
        return [
          { id: 'topup-1', type: 'TOP_UP', balanceBefore: BigInt(0), balanceAfter: BigInt(100000) },
          { id: 'withdraw-1', type: 'WITHDRAW', balanceBefore: BigInt(100000), balanceAfter: BigInt(90000) },
        ];
      }
      return [];
    });
    prisma.walletTransaction.count.mockResolvedValue(1);
    const service = new ReconciliationService(prisma as never);

    await expect(service.reconcileWalletBalance('user-1')).resolves.toBeNull();
    expect(prisma.walletTransaction.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        OR: expect.arrayContaining([
          expect.objectContaining({ type: 'WITHDRAW', withdrawStatus: { in: ['PENDING_OTP', 'PENDING_PROCESS', 'PROCESSING'] } }),
        ]),
      }),
    }));
  });

  it('interprets date-only audit boundaries as an inclusive WIB calendar day', async () => {
    prisma.wallet.findUnique.mockResolvedValue({ id: 'wallet-1' });
    prisma.walletTransaction.findMany.mockResolvedValue([]);
    const service = new ReconciliationService(prisma as never);

    await service.getFinancialAuditTrail('user-1', '2026-08-21', '2026-08-21');

    expect(prisma.walletTransaction.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        createdAt: {
          gte: new Date('2026-08-20T17:00:00.000Z'),
          lte: new Date('2026-08-21T16:59:59.999Z'),
        },
      }),
    }));
  });
});

describe('ReconciliationService — ADM-203/204 resolusi ID publik', () => {
  const prisma = {
    wallet: { findUnique: jest.fn(), findMany: jest.fn() },
    walletTransaction: { findMany: jest.fn(), count: jest.fn() },
    user: { findFirst: jest.fn() },
  };

  beforeEach(() => {
    jest.clearAllMocks();
    prisma.user.findFirst.mockResolvedValue({ id: 'clx-internal-1' });
  });

  it('reconcileWalletBalance menerima ID publik USR-…', async () => {
    prisma.wallet.findUnique.mockResolvedValue({
      id: 'wallet-1', userId: 'clx-internal-1', availableBalance: BigInt(90000), escrowBalance: BigInt(0), totalBalance: BigInt(90000),
    });
    prisma.walletTransaction.findMany.mockImplementation(({ where }: { where: Record<string, unknown> }) => {
      if (Array.isArray(where.OR)) {
        return [
          { id: 'topup-1', type: 'TOP_UP', balanceBefore: BigInt(0), balanceAfter: BigInt(100000) },
          { id: 'withdraw-1', type: 'WITHDRAW', balanceBefore: BigInt(100000), balanceAfter: BigInt(90000) },
        ];
      }
      return [];
    });
    prisma.walletTransaction.count.mockResolvedValue(0);
    const service = new ReconciliationService(prisma as never);

    await expect(service.reconcileWalletBalance('USR-PUBLIK1')).resolves.toBeNull();
    expect(prisma.wallet.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: 'clx-internal-1' } }),
    );
  });

  it('getFinancialAuditTrail menerima ID publik USR-… dan mengembalikan cuid internal', async () => {
    prisma.wallet.findUnique.mockResolvedValue({ id: 'wallet-1' });
    prisma.walletTransaction.findMany.mockResolvedValue([]);
    const service = new ReconciliationService(prisma as never);

    const result = await service.getFinancialAuditTrail('USR-PUBLIK1', '2026-08-21', '2026-08-21');
    expect(result.userId).toBe('clx-internal-1');
  });

  it('ID publik tanpa user cocok → 404 fail closed', async () => {
    prisma.user.findFirst.mockResolvedValue(null);
    const service = new ReconciliationService(prisma as never);
    await expect(service.reconcileWalletBalance('USR-TIDAKADA')).rejects.toThrow('User tidak ditemukan');
    expect(prisma.wallet.findUnique).not.toHaveBeenCalled();
  });
});
