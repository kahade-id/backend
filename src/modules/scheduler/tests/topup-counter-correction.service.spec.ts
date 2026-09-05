jest.mock('../../../common/utils/cron-jitter.util', () => ({
  cronJitter: jest.fn().mockResolvedValue(undefined),
}));

import { TopupCounterCorrectionService } from '../services/topup-counter-correction.service';

describe('TopupCounterCorrectionService', () => {
  const client = { lpop: jest.fn(), lpush: jest.fn() };
  const prisma = {
    wallet: { findUnique: jest.fn(), updateMany: jest.fn() },
    walletTransaction: { aggregate: jest.fn() },
  };
  const redis = {
    isHealthy: jest.fn(),
    setNx: jest.fn(),
    releaseLock: jest.fn(),
    getClient: jest.fn(),
    getPrefix: jest.fn(),
  };

  beforeEach(() => {
    jest.clearAllMocks();
    redis.isHealthy.mockResolvedValue(true);
    redis.setNx.mockResolvedValue(true);
    redis.releaseLock.mockResolvedValue(true);
    redis.getClient.mockReturnValue(client);
    redis.getPrefix.mockReturnValue('kahade:');
    client.lpush.mockResolvedValue(1);
  });

  it('requeues a correction and stops the batch when wallet storage is temporarily unavailable', async () => {
    const raw = JSON.stringify({ userId: 'user-1', amountInSen: '10000', paymentTxId: 'payment-1', timestamp: Date.now() });
    client.lpop.mockResolvedValueOnce(raw).mockResolvedValueOnce(null);
    prisma.wallet.findUnique.mockRejectedValueOnce(new Error('database unavailable'));
    const service = new TopupCounterCorrectionService(prisma as never, redis as never);

    await service.processCorrections();

    expect(client.lpush).toHaveBeenCalledWith('kahade:topup_counter_corrections', raw);
    expect(client.lpop).toHaveBeenCalledTimes(1);
  });
});
