import { ReconciliationService } from './reconciliation.service';

describe('ReconciliationService', () => {
  const prisma = {
    wallet: { findUnique: jest.fn(), findMany: jest.fn() },
    walletTransaction: { findMany: jest.fn(), count: jest.fn() },
  };

  beforeEach(() => {
    jest.clearAllMocks();
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
