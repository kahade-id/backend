import { StaleRefundClaimSweepService } from '../stale-refund-claim-sweep.service';
import { PrismaService } from '../../../../prisma/prisma.service';
import { RedisService } from '../../../../redis/redis.service';

jest.mock('../../../../common/utils/cron-jitter.util', () => ({
  cronJitter: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../../../../common/utils/redis-health.util', () => ({
  ensureRedisAvailable: jest.fn().mockResolvedValue(true),
  alertMoneyCronSkippedRedisDown: jest.fn(),
}));
jest.mock('../../common/money-alert.util', () => ({
  alertAdminsOnMoneyAnomaly: jest.fn().mockResolvedValue(true),
}));

import { alertAdminsOnMoneyAnomaly } from '../../common/money-alert.util';

const alertMock = alertAdminsOnMoneyAnomaly as unknown as jest.Mock;

const STALE_ROW = {
  id: 'attempt-1',
  idempotencyKey: 'ORDER:ord-1:FULL',
  paymentTransactionId: 'pay-1',
  amountSen: BigInt(5000000),
  partnerRefundNo: 'PRN-TEST-1',
  updatedAt: new Date(Date.now() - 3600_000),
};

function makePrisma(staleRows: unknown[], updateCount = 1) {
  const updateMany = jest.fn().mockResolvedValue({ count: updateCount });
  const prisma = {
    danaRefundAttempt: {
      findMany: jest.fn().mockResolvedValue(staleRows),
      updateMany,
    },
  } as unknown as PrismaService;
  return { prisma, updateMany };
}

const makeRedis = () =>
  ({
    setNx: jest.fn().mockResolvedValue(true),
    setex: jest.fn().mockResolvedValue('OK'),
    releaseLock: jest.fn().mockResolvedValue(true),
  }) as unknown as RedisService;

describe('StaleRefundClaimSweepService (SYS-B-301)', () => {
  beforeEach(() => jest.clearAllMocks());

  it('EXECUTING basi >30 mnt → FAILED agar retryFailedRefunds menjemput + alert', async () => {
    const { prisma, updateMany } = makePrisma([STALE_ROW]);
    const svc = new StaleRefundClaimSweepService(prisma, makeRedis());
    await svc.sweepStaleExecutingRefunds();

    expect(updateMany).toHaveBeenCalledWith({
      where: { id: 'attempt-1', status: 'EXECUTING' },
      data: { status: 'FAILED', reason: expect.stringContaining('SYS-B-301') },
    });
    expect(alertMock).toHaveBeenCalledTimes(1);
    expect(alertMock.mock.calls[0][0].title).toContain('Stale refund claim');
    expect(alertMock.mock.calls[0][0].targetId).toBe('attempt-1');
  });

  it('tak ada baris basi → tak ada reset/alert; heartbeat tetap ditulis', async () => {
    const { prisma, updateMany } = makePrisma([]);
    const redis = makeRedis();
    const svc = new StaleRefundClaimSweepService(prisma, redis);
    await svc.sweepStaleExecutingRefunds();

    expect(updateMany).not.toHaveBeenCalled();
    expect(alertMock).not.toHaveBeenCalled();
    expect((redis.setex as unknown as jest.Mock)).toHaveBeenCalledWith(
      'cron_heartbeat:stale_refund_claim_sweep',
      86400,
      expect.stringContaining('"recovered":0'),
    );
  });

  it('kalah race (updateMany count=0) → tak ada alert ganda', async () => {
    const { prisma, updateMany } = makePrisma([STALE_ROW], 0);
    const svc = new StaleRefundClaimSweepService(prisma, makeRedis());
    await svc.sweepStaleExecutingRefunds();

    expect(updateMany).toHaveBeenCalledTimes(1);
    expect(alertMock).not.toHaveBeenCalled();
  });

  it('lock tak didapat → sweep dilewati diam-diam', async () => {
    const { prisma } = makePrisma([STALE_ROW]);
    const redis = {
      setNx: jest.fn().mockResolvedValue(false),
      setex: jest.fn(),
      releaseLock: jest.fn(),
    } as unknown as RedisService;
    const svc = new StaleRefundClaimSweepService(prisma, redis);
    await svc.sweepStaleExecutingRefunds();
    expect(prisma.danaRefundAttempt.findMany).not.toHaveBeenCalled();
  });
});
