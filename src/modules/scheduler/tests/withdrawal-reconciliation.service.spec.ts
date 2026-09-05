jest.mock('../../../common/utils/cron-jitter.util', () => ({
  cronJitter: jest.fn().mockResolvedValue(undefined),
}));

import { WithdrawalReconciliationService } from '../services/withdrawal-reconciliation.service';

describe('WithdrawalReconciliationService', () => {
  const prisma = {
    walletTransaction: {
      findMany: jest.fn(),
      updateMany: jest.fn(),
    },
    wallet: {
      findUnique: jest.fn(),
      updateMany: jest.fn(),
    },
    $transaction: jest.fn(),
  };
  const redis = {
    isHealthy: jest.fn(),
    setNx: jest.fn(),
    setex: jest.fn(),
    releaseLock: jest.fn(),
  };
  const midtrans = { getIrisPayoutStatus: jest.fn() };
  const notificationQueue = { enqueue: jest.fn() };

  beforeEach(() => {
    jest.clearAllMocks();
    redis.isHealthy.mockResolvedValue(true);
    redis.setNx.mockResolvedValue(true);
    redis.setex.mockResolvedValue(true);
    redis.releaseLock.mockResolvedValue(true);
    midtrans.getIrisPayoutStatus.mockResolvedValue({ status: 'not_found', referenceNo: 'WLT-1' });
  });

  it('does not refund a newly processing payout merely because the withdrawal request is old', async () => {
    prisma.walletTransaction.findMany.mockResolvedValue([{
      id: 'withdraw-1',
      txId: 'WLT-1',
      walletId: 'wallet-1',
      amount: BigInt(5000000),
      createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
      updatedAt: new Date(),
      wallet: { userId: 'user-1' },
    }]);

    const service = new WithdrawalReconciliationService(prisma as never, redis as never, midtrans as never, notificationQueue as never);
    await service.reconcileProcessingWithdrawals();

    expect(prisma.walletTransaction.updateMany).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('reconciles the oldest PROCESSING withdrawals first so later batches cannot starve them', async () => {
    prisma.walletTransaction.findMany.mockResolvedValue([]);

    const service = new WithdrawalReconciliationService(prisma as never, redis as never, midtrans as never, notificationQueue as never);
    await service.reconcileProcessingWithdrawals();

    expect(prisma.walletTransaction.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { type: 'WITHDRAW', withdrawStatus: 'PROCESSING' },
      orderBy: { updatedAt: 'asc' },
      take: 50,
    }));
  });

  it('does not refund an old PROCESSING payout when Iris still reports not_found', async () => {
    prisma.walletTransaction.findMany.mockResolvedValue([{
      id: 'withdraw-1',
      txId: 'WLT-1',
      walletId: 'wallet-1',
      amount: BigInt(5000000),
      createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
      updatedAt: new Date(Date.now() - 31 * 60 * 1000),
      wallet: { userId: 'user-1' },
    }]);

    const service = new WithdrawalReconciliationService(prisma as never, redis as never, midtrans as never, notificationQueue as never);
    await service.reconcileProcessingWithdrawals();

    expect(prisma.walletTransaction.updateMany).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(redis.setex).toHaveBeenCalledWith('alert:withdrawal_payout_unknown:withdraw-1', 86400, expect.any(String));
  });

  it('records a manual-review alert for an old payout with an unknown provider status', async () => {
    prisma.walletTransaction.findMany.mockResolvedValue([{
      id: 'withdraw-1',
      txId: 'WLT-1',
      walletId: 'wallet-1',
      amount: BigInt(5000000),
      createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
      updatedAt: new Date(Date.now() - 31 * 60 * 1000),
      wallet: { userId: 'user-1' },
    }]);
    midtrans.getIrisPayoutStatus.mockResolvedValue({ status: 'cancelled', referenceNo: 'WLT-1' });

    const service = new WithdrawalReconciliationService(prisma as never, redis as never, midtrans as never, notificationQueue as never);
    await service.reconcileProcessingWithdrawals();

    expect(prisma.walletTransaction.updateMany).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(redis.setex).toHaveBeenCalledWith('alert:withdrawal_payout_unknown:withdraw-1', 86400, expect.stringContaining('cancelled'));
  });

  it('does not notify a failed withdrawal when the refund claim loses a concurrent status transition', async () => {
    prisma.walletTransaction.findMany.mockResolvedValue([{
      id: 'withdraw-1',
      txId: 'WLT-1',
      walletId: 'wallet-1',
      amount: BigInt(5000000),
      createdAt: new Date(),
      updatedAt: new Date(),
      wallet: { userId: 'user-1' },
    }]);
    midtrans.getIrisPayoutStatus.mockResolvedValue({ status: 'failed', referenceNo: 'WLT-1' });
    prisma.walletTransaction.updateMany.mockResolvedValue({ count: 0 });
    prisma.$transaction.mockImplementation(async (callback: (client: typeof prisma) => Promise<unknown>) => callback(prisma));

    const service = new WithdrawalReconciliationService(prisma as never, redis as never, midtrans as never, notificationQueue as never);
    await service.reconcileProcessingWithdrawals();

    expect(prisma.wallet.findUnique).not.toHaveBeenCalled();
    expect(notificationQueue.enqueue).not.toHaveBeenCalled();
  });
});
