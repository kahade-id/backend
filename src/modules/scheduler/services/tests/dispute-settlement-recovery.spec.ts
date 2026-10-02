import { DisputeSettlementSweepService } from '../dispute-settlement-sweep.service';
import type { DisputeDanaSettlementService } from '../../../no-wallet/dispute-dana-settlement.service';
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

const STALE_CLAIMED_ROW = {
  id: 'intent-1',
  disputeId: 'disp-1',
  buyerAmountSen: BigInt(6000000),
  sellerAmountSen: BigInt(4000000),
  attemptCount: 2,
  updatedAt: new Date(Date.now() - 3600_000),
};

const EXHAUSTED_ROW = {
  id: 'intent-2',
  disputeId: 'disp-2',
  buyerAmountSen: BigInt(10000000),
  sellerAmountSen: BigInt(0),
  attemptCount: 10,
  lastError: 'DANA timeout berulang',
};

function makeService(opts: { claimed: unknown[]; exhausted: unknown[] }) {
  const updateMany = jest.fn().mockResolvedValue({ count: 1 });
  const findMany = jest.fn().mockImplementation((args: { where?: Record<string, unknown> }) => {
    if (args?.where?.status === 'CLAIMED') return Promise.resolve(opts.claimed);
    if ((args?.where?.attemptCount as Record<string, unknown> | undefined)?.gte === 10) {
      return Promise.resolve(opts.exhausted);
    }
    return Promise.resolve([]); // sweep utama SEC-104: tak ada intent aktif
  });
  const prisma = {
    disputeSettlementIntent: { findMany, updateMany },
  } as unknown as PrismaService;
  const redis = {
    setNx: jest.fn().mockResolvedValue(true),
    setex: jest.fn().mockResolvedValue('OK'),
    del: jest.fn().mockResolvedValue(1),
    releaseLock: jest.fn().mockResolvedValue(true),
  } as unknown as RedisService;
  const svc = new DisputeSettlementSweepService(
    prisma,
    redis,
    {} as unknown as DisputeDanaSettlementService,
  );
  return { svc, updateMany };
}

describe('DisputeSettlementSweepService recovery (SYS-B-302)', () => {
  beforeEach(() => jest.clearAllMocks());

  it('CLAIMED basi >30 mnt → PENDING + alert (crash antara klaim dan DONE/FAILED)', async () => {
    const { svc, updateMany } = makeService({ claimed: [STALE_CLAIMED_ROW], exhausted: [] });
    await svc.sweepStaleSettlementIntents();

    expect(updateMany).toHaveBeenCalledWith({
      where: { id: 'intent-1', status: 'CLAIMED' },
      data: { status: 'PENDING', lastError: expect.stringContaining('SYS-B-302') },
    });
    expect(alertMock).toHaveBeenCalledTimes(1);
    expect(alertMock.mock.calls[0][0].title).toContain('Stale settlement claim');
    expect(alertMock.mock.calls[0][0].targetId).toBe('intent-1');
  });

  it('attemptCount >= 10 → ESCALATED + alert (sebelumnya di-skip diam-diam)', async () => {
    const { svc, updateMany } = makeService({ claimed: [], exhausted: [EXHAUSTED_ROW] });
    await svc.sweepStaleSettlementIntents();

    expect(updateMany).toHaveBeenCalledWith({
      where: { id: 'intent-2', status: { in: ['PENDING', 'FAILED'] } },
      data: { status: 'ESCALATED', lastError: expect.stringContaining('SYS-B-302') },
    });
    expect(alertMock).toHaveBeenCalledTimes(1);
    expect(alertMock.mock.calls[0][0].title).toContain('intervensi manual');
    expect(alertMock.mock.calls[0][0].targetId).toBe('intent-2');
  });

  it('tak ada baris bermasalah → tak ada alert', async () => {
    const { svc } = makeService({ claimed: [], exhausted: [] });
    await svc.sweepStaleSettlementIntents();
    expect(alertMock).not.toHaveBeenCalled();
  });
});
