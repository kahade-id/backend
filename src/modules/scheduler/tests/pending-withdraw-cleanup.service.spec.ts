import { Test, TestingModule } from '@nestjs/testing';
import { PendingWithdrawCleanupService } from '../services/pending-withdraw-cleanup.service';
import { PrismaService } from '../../../prisma/prisma.service';
import { RedisService } from '../../../redis/redis.service';

jest.mock('../../../common/utils/cron-jitter.util', () => ({ cronJitter: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../../../common/utils/redis-health.util', () => ({ ensureRedisAvailable: jest.fn().mockResolvedValue(true) }));

describe('PendingWithdrawCleanupService ownership boundary', () => {
  let service: PendingWithdrawCleanupService;
  const queryWhere: Array<Record<string, unknown>> = [];
  const prisma = {
    walletTransaction: {
      findMany: jest.fn(async ({ where }: { where: Record<string, unknown> }) => {
        queryWhere.push(where);
        return [];
      }),
    },
    $transaction: jest.fn(),
  };
  const redis = {
    setNx: jest.fn().mockResolvedValue(true),
    get: jest.fn().mockResolvedValue('lock-token'),
    expire: jest.fn().mockResolvedValue(1),
    releaseLock: jest.fn().mockResolvedValue(true),
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    queryWhere.length = 0;
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PendingWithdrawCleanupService,
        { provide: PrismaService, useValue: prisma },
        { provide: RedisService, useValue: redis },
      ],
    }).compile();
    service = module.get(PendingWithdrawCleanupService);
  });

  it('does not query or refund PROCESSING withdrawals; Iris reconciliation owns that state', async () => {
    await service.cleanupExpiredWithdrawals();

    expect(queryWhere).toHaveLength(2);
    expect(queryWhere.some((where) => where.withdrawStatus === 'PROCESSING')).toBe(false);
    expect(queryWhere.find((where) => where.withdrawStatus === 'PENDING_OTP')).toEqual(expect.objectContaining({
      updatedAt: { lt: expect.any(Date) },
    }));
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});
