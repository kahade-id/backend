jest.mock('../../../common/utils/cron-jitter.util', () => ({
  cronJitter: jest.fn().mockResolvedValue(undefined),
}));

import { PendingTopupCleanupService } from '../services/pending-topup-cleanup.service';

describe('PendingTopupCleanupService', () => {
  const prisma = {
    walletTransaction: { findMany: jest.fn(), updateMany: jest.fn() },
    paymentTransaction: { updateMany: jest.fn() },
    wallet: { findUnique: jest.fn(), updateMany: jest.fn() },
    $transaction: jest.fn(),
  };
  const redis = {
    isHealthy: jest.fn(), setNx: jest.fn(), get: jest.fn(), expire: jest.fn(), renewLock: jest.fn(), releaseLock: jest.fn(),
  };
  const config = { get: jest.fn().mockReturnValue(24) };
  const midtrans = { getTransactionStatus: jest.fn() };
  const walletService = { handleTopupSuccess: jest.fn() };

  const staleTopup = {
    id: 'wallet-tx-1', walletId: 'wallet-1', amount: BigInt(1_000_000), createdAt: new Date(Date.now() - 30 * 60 * 60 * 1000),
    paymentTx: { id: 'payment-1', midtransOrderId: 'PAY-1', status: 'PENDING' },
  };

  beforeEach(() => {
    jest.clearAllMocks();
    redis.isHealthy.mockResolvedValue(true);
    redis.setNx.mockResolvedValue(true);
    redis.get.mockImplementation(async () => redis.setNx.mock.calls[0]?.[1]);
    redis.renewLock.mockResolvedValue(true);
    redis.releaseLock.mockResolvedValue(true);
  });

  it('retains a stale local pending top-up when Midtrans still reports pending', async () => {
    prisma.walletTransaction.findMany.mockResolvedValue([staleTopup]);
    midtrans.getTransactionStatus.mockResolvedValue({ transaction_status: 'pending' });
    const service = new PendingTopupCleanupService(prisma as never, redis as never, config as never, midtrans as never, walletService as never);

    await service.cleanupStaleTopups();

    expect(midtrans.getTransactionStatus).toHaveBeenCalledWith('PAY-1');
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(walletService.handleTopupSuccess).not.toHaveBeenCalled();
  });

  it('settles a stale local pending top-up when Midtrans confirms settlement', async () => {
    prisma.walletTransaction.findMany.mockResolvedValue([staleTopup]);
    midtrans.getTransactionStatus.mockResolvedValue({ transaction_status: 'settlement', gross_amount: '10000.00' });
    walletService.handleTopupSuccess.mockResolvedValue(undefined);
    const service = new PendingTopupCleanupService(prisma as never, redis as never, config as never, midtrans as never, walletService as never);

    await service.cleanupStaleTopups();

    expect(walletService.handleTopupSuccess).toHaveBeenCalledWith('PAY-1', '10000.00');
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('cleans up a stale local pending top-up when Midtrans reports capture with fraud denial', async () => {
    prisma.walletTransaction.findMany.mockResolvedValue([staleTopup]);
    prisma.walletTransaction.updateMany.mockResolvedValue({ count: 1 });
    prisma.paymentTransaction.updateMany.mockResolvedValue({ count: 1 });
    prisma.wallet.findUnique.mockResolvedValue({ id: 'wallet-1', version: 1, todayTopupAmount: BigInt(0) });
    prisma.$transaction.mockImplementation(async (callback: (client: typeof prisma) => Promise<unknown>) => callback(prisma));
    midtrans.getTransactionStatus.mockResolvedValue({ transaction_status: 'capture', fraud_status: 'deny' });
    const service = new PendingTopupCleanupService(prisma as never, redis as never, config as never, midtrans as never, walletService as never);

    await service.cleanupStaleTopups();

    expect(prisma.walletTransaction.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'wallet-tx-1', status: 'PENDING' },
      data: expect.objectContaining({ status: 'FAILED' }),
    }));
    expect(prisma.paymentTransaction.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'payment-1', status: 'PENDING' },
      data: expect.objectContaining({ status: 'FAILED' }),
    }));
  });

  it('records capture fraud challenge for manual review instead of retaining an unexplained pending top-up', async () => {
    prisma.walletTransaction.findMany.mockResolvedValue([staleTopup]);
    prisma.paymentTransaction.updateMany.mockResolvedValue({ count: 1 });
    midtrans.getTransactionStatus.mockResolvedValue({ transaction_status: 'capture', fraud_status: 'challenge' });
    const service = new PendingTopupCleanupService(prisma as never, redis as never, config as never, midtrans as never, walletService as never);

    await service.cleanupStaleTopups();

    expect(prisma.paymentTransaction.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'payment-1', status: 'PENDING' },
      data: expect.objectContaining({ fraudStatus: 'challenge', webhookReceivedAt: expect.any(Date) }),
    }));
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.walletTransaction.updateMany).not.toHaveBeenCalled();
  });

  it('cleans up a stale local pending top-up when Midtrans confirms partial chargeback', async () => {
    prisma.walletTransaction.findMany.mockResolvedValue([staleTopup]);
    prisma.walletTransaction.updateMany.mockResolvedValue({ count: 1 });
    prisma.paymentTransaction.updateMany.mockResolvedValue({ count: 1 });
    prisma.wallet.findUnique.mockResolvedValue({ id: 'wallet-1', version: 1, todayTopupAmount: BigInt(0) });
    prisma.$transaction.mockImplementation(async (callback: (client: typeof prisma) => Promise<unknown>) => callback(prisma));
    midtrans.getTransactionStatus.mockResolvedValue({ transaction_status: 'partial_chargeback' });
    const service = new PendingTopupCleanupService(prisma as never, redis as never, config as never, midtrans as never, walletService as never);

    await service.cleanupStaleTopups();

    expect(prisma.walletTransaction.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'wallet-tx-1', status: 'PENDING' },
      data: expect.objectContaining({ status: 'FAILED' }),
    }));
    expect(prisma.paymentTransaction.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'payment-1', status: 'PENDING' },
      data: expect.objectContaining({ status: 'FAILED' }),
    }));
  });
});
