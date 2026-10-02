import { DanaDbReconciliationService } from '../dana-db-reconciliation.service';
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

const makeRedis = () =>
  ({
    setNx: jest.fn().mockResolvedValue(true),
    setex: jest.fn().mockResolvedValue('OK'),
    releaseLock: jest.fn().mockResolvedValue(true),
  }) as unknown as RedisService;

function makeService(attemptSumSen: bigint, recordedSen: bigint) {
  const prisma = {
    danaRefundAttempt: {
      groupBy: jest.fn().mockResolvedValue([
        { paymentTransactionId: 'pay-1', _sum: { amountSen: attemptSumSen }, _count: { _all: 2 } },
      ]),
    },
    paymentTransaction: {
      findMany: jest.fn().mockResolvedValue([
        {
          id: 'pay-1',
          orderId: 'ord-1',
          grossAmount: BigInt(20000000),
          refundedAmount: recordedSen,
          danaPartnerReferenceNo: 'R-1',
          status: 'REFUNDED',
        },
      ]),
    },
  } as unknown as PrismaService;
  return new DanaDbReconciliationService(prisma, makeRedis());
}

describe('DanaDbReconciliationService (SYS-B-304)', () => {
  beforeEach(() => jest.clearAllMocks());

  it('Σ attempt SUCCESS > refundedAmount → alert OVER_REFUND (tanda SEC-103)', async () => {
    const svc = makeService(BigInt(15000000), BigInt(10000000));
    const stats = await svc.checkRefundConservation();
    expect(stats.overRefundGaps).toBe(1);
    expect(stats.underRecorded).toBe(0);
    expect(alertMock).toHaveBeenCalledTimes(1);
    expect(alertMock.mock.calls[0][0].title).toContain('OVER_REFUND_BLOCKED');
    expect(alertMock.mock.calls[0][0].targetId).toBe('pay-1');
  });

  it('refundedAmount > Σ attempt → alert under-recorded (jalur non-durable)', async () => {
    const svc = makeService(BigInt(5000000), BigInt(10000000));
    const stats = await svc.checkRefundConservation();
    expect(stats.overRefundGaps).toBe(0);
    expect(stats.underRecorded).toBe(1);
    expect(alertMock).toHaveBeenCalledTimes(1);
    expect(alertMock.mock.calls[0][0].title).toContain('tak tercatat');
  });

  it('konservasi seimbang → tak ada alert', async () => {
    const svc = makeService(BigInt(10000000), BigInt(10000000));
    const stats = await svc.checkRefundConservation();
    expect(stats.overRefundGaps).toBe(0);
    expect(stats.underRecorded).toBe(0);
    expect(alertMock).not.toHaveBeenCalled();
  });
});
