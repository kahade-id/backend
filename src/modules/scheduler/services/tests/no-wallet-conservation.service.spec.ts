import type { ConfigService } from '@nestjs/config';
import { NoWalletConservationService } from '../no-wallet-conservation.service';
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
    del: jest.fn().mockResolvedValue(1),
  }) as unknown as RedisService;

const config = { get: jest.fn().mockReturnValue(undefined) } as unknown as ConfigService;

function makeService(payGroups: unknown[], disbGroups: unknown[]) {
  const prisma = {
    paymentTransaction: {
      groupBy: jest.fn().mockResolvedValue(payGroups),
      aggregate: jest.fn().mockResolvedValue({ _sum: { grossAmount: null }, _count: { _all: 0 } }),
    },
    escrowDisbursement: {
      groupBy: jest.fn().mockResolvedValue(disbGroups),
    },
  } as unknown as PrismaService;
  const redis = makeRedis();
  const svc = new NoWalletConservationService(prisma, redis, config);
  return { svc, redis };
}

// inflow 10jt − fee 200rb − disbursed 9.8jt = 0 residual; expected_held = 0 → seimbang.
const BALANCED_PAY = [
  {
    orderId: 'ord-1',
    _sum: { grossAmount: BigInt(10000000), refundedAmount: BigInt(0), paymentFee: BigInt(200000) },
    _count: { _all: 1 },
  },
];
const BALANCED_DISB = [
  { orderId: 'ord-1', status: 'SUCCESS', _sum: { amountSen: BigInt(9800000) } },
];

describe('NoWalletConservationService (SYS-B-101)', () => {
  beforeEach(() => jest.clearAllMocks());

  it('buku kas seimbang → clean, tanpa alert; redis alert key dibersihkan', async () => {
    const { svc, redis } = makeService(BALANCED_PAY, BALANCED_DISB);
    const r = await svc.checkConservation();
    expect(r.clean).toBe(true);
    expect(r.diff).toBe(BigInt(0));
    expect(r.orderCount).toBe(1);

    await svc.runNoWalletConservation();
    expect(alertMock).not.toHaveBeenCalled();
    // Kunci alert lama dibersihkan saat kondisi kembali bersih.
    expect((redis.del as unknown as jest.Mock)).toHaveBeenCalledWith(
      'cron_alert:no_wallet_conservation_mismatch',
    );
  });

  it('disbursement SUCCESS untuk order tanpa payment → mismatch → alert + adminAuditLog', async () => {
    // Uang keluar 5jt tercatat di disbursement, tapi tak ada inflow payment —
    // residual −5jt vs expected 0 → diff di luar toleransi.
    const { svc } = makeService([], [
      { orderId: 'ord-asing', status: 'SUCCESS', _sum: { amountSen: BigInt(5000000) } },
    ]);
    const r = await svc.checkConservation();
    expect(r.clean).toBe(false);
    expect(r.diff).toBe(BigInt(-5000000));

    await svc.runNoWalletConservation();
    expect(alertMock).toHaveBeenCalledTimes(1);
    expect(alertMock.mock.calls[0][0].title).toContain('MISMATCH');
    expect(alertMock.mock.calls[0][0].redisAlertKey).toBe('no_wallet_conservation_mismatch');
  });

  it('in-flight (PROCESSING/HELD_NO_BANK) mengurangi residual — bukan mismatch', async () => {
    const { svc } = makeService(BALANCED_PAY, [
      { orderId: 'ord-1', status: 'PROCESSING', _sum: { amountSen: BigInt(9800000) } },
    ]);
    const r = await svc.checkConservation();
    // residual = 10jt − 0 − 0 − 200rb − 9.8jt(inflight) = 0; expected_held = 0
    expect(r.clean).toBe(true);
    expect(r.diff).toBe(BigInt(0));
  });
});
