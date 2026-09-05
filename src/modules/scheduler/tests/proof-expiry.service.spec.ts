jest.mock('../../../common/utils/cron-jitter.util', () => ({ cronJitter: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../../../common/utils/redis-health.util', () => ({ ensureRedisAvailable: jest.fn().mockResolvedValue(true) }));

import { ProofExpiryService } from '../services/proof-expiry.service';

describe('ProofExpiryService — distributed lock', () => {
  const prisma = {
    deliveryProof: { findMany: jest.fn(), updateMany: jest.fn() },
    notification: { create: jest.fn() },
    emitNotificationCreated: jest.fn(),
  };
  const redis = { setNx: jest.fn(), get: jest.fn(), expire: jest.fn(), renewLock: jest.fn(), releaseLock: jest.fn() };
  let service: ProofExpiryService;

  beforeEach(() => {
    jest.clearAllMocks();
    redis.setNx.mockResolvedValue(true);
    redis.releaseLock.mockResolvedValue(true);
    redis.renewLock.mockResolvedValue(true);
    service = new ProofExpiryService(prisma as never, redis as never);
  });

  it('renews the lock while a proof batch is still running', async () => {
    let releaseBatch: ((rows: unknown[]) => void) | undefined;
    let renew: (() => Promise<void>) | undefined;
    prisma.deliveryProof.findMany.mockImplementation(() => new Promise((resolve) => { releaseBatch = resolve; }));
    const interval = jest.spyOn(global, 'setInterval').mockImplementation(((callback: () => Promise<void>) => {
      renew = callback;
      return 1 as unknown as ReturnType<typeof setInterval>;
    }) as typeof setInterval);
    redis.get.mockImplementation(async () => redis.setNx.mock.calls[0]?.[1]);

    const run = service.expireUnreviewedProofs();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await renew?.();

    expect(redis.renewLock).toHaveBeenCalledWith('cron_lock:proof_expiry', expect.any(String), 600);
    releaseBatch?.([]);
    await run;
    interval.mockRestore();
  });
});
