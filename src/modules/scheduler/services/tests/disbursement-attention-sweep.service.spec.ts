import { DisbursementAttentionSweepService } from '../disbursement-attention-sweep.service';
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
  alertDisbursementNeedsAttention: jest.fn().mockResolvedValue(true),
}));

import { alertDisbursementNeedsAttention } from '../../common/money-alert.util';

const attentionMock = alertDisbursementNeedsAttention as unknown as jest.Mock;

const makeRedis = () =>
  ({
    setNx: jest.fn().mockResolvedValue(true),
    setex: jest.fn().mockResolvedValue('OK'),
    releaseLock: jest.fn().mockResolvedValue(true),
  }) as unknown as RedisService;

const HELD_ROW = {
  id: 'disb-1',
  idempotencyKey: 'DISB:1',
  status: 'HELD_NO_BANK',
  amountSen: BigInt(9800000),
  sellerId: 'seller-1',
  orderId: 'ord-1',
  heldReason: 'seller belum punya rekening',
  lastError: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

const REVIEW_ROW = {
  ...HELD_ROW,
  id: 'disb-2',
  idempotencyKey: 'DISB:2',
  status: 'NEEDS_REVIEW',
  heldReason: null,
  lastError: 'status DANA tak dikenal',
};

describe('DisbursementAttentionSweepService (SYS-B-306)', () => {
  beforeEach(() => jest.clearAllMocks());

  it('setiap baris HELD_NO_BANK/NEEDS_REVIEW memicu alert via helper bersama', async () => {
    const prisma = {
      escrowDisbursement: { findMany: jest.fn().mockResolvedValue([HELD_ROW, REVIEW_ROW]) },
    } as unknown as PrismaService;
    const svc = new DisbursementAttentionSweepService(prisma, makeRedis());
    await svc.sweepAttentionQueue();

    expect(attentionMock).toHaveBeenCalledTimes(2);
    const first = attentionMock.mock.calls[0][0];
    expect(first.disbursementId).toBe('disb-1');
    expect(first.status).toBe('HELD_NO_BANK');
    expect(first.reason).toContain('seller belum punya rekening');
    const second = attentionMock.mock.calls[1][0];
    expect(second.disbursementId).toBe('disb-2');
    expect(second.status).toBe('NEEDS_REVIEW');
    expect(second.reason).toContain('status DANA tak dikenal');
  });

  it('antrean kosong → tak ada alert; heartbeat mencatat queueDepth=0', async () => {
    const prisma = {
      escrowDisbursement: { findMany: jest.fn().mockResolvedValue([]) },
    } as unknown as PrismaService;
    const redis = makeRedis();
    const svc = new DisbursementAttentionSweepService(prisma, redis);
    await svc.sweepAttentionQueue();

    expect(attentionMock).not.toHaveBeenCalled();
    expect((redis.setex as unknown as jest.Mock)).toHaveBeenCalledWith(
      'cron_heartbeat:disbursement_attention_sweep',
      86400,
      expect.stringContaining('"queueDepth":0'),
    );
  });
});
