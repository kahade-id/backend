import { AdminApprovalSweepService } from '../admin-approval-sweep.service';
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

describe('AdminApprovalSweepService (SYS-B-303 + SYS-B-306)', () => {
  beforeEach(() => jest.clearAllMocks());

  it('APPROVED basi >15 mnt (decidedAt) → PENDING + alert', async () => {
    const staleRow = {
      id: 'ap-1',
      actionType: 'RELEASE_FUNDS',
      targetId: 'disb-1',
      amountSen: BigInt(10000000),
      proposedBy: 'admin-a',
      decidedBy: 'admin-b',
      decidedAt: new Date(Date.now() - 3600_000),
    };
    const updateMany = jest.fn().mockResolvedValue({ count: 1 });
    const prisma = {
      adminActionApproval: {
        findMany: jest.fn().mockResolvedValue([staleRow]),
        updateMany,
      },
    } as unknown as PrismaService;
    const svc = new AdminApprovalSweepService(prisma, makeRedis());
    await svc.recoverStaleApproved();

    expect(updateMany).toHaveBeenCalledWith({
      where: { id: 'ap-1', status: 'APPROVED', executedAt: null },
      data: { status: 'PENDING', decidedBy: null, decidedAt: null },
    });
    expect(alertMock).toHaveBeenCalledTimes(1);
    expect(alertMock.mock.calls[0][0].title).toContain('Stale approval');
    expect(alertMock.mock.calls[0][0].targetId).toBe('ap-1');
  });

  it('APPROVED yang sudah dieksekusi (executedAt terisi) tidak di-reset', async () => {
    const updateMany = jest.fn().mockResolvedValue({ count: 0 });
    const findMany = jest.fn().mockResolvedValue([]);
    const prisma = {
      adminActionApproval: { findMany, updateMany },
    } as unknown as PrismaService;
    const svc = new AdminApprovalSweepService(prisma, makeRedis());
    await svc.recoverStaleApproved();
    // Query memakai executedAt: null — baris yang sudah dieksekusi tak masuk.
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ executedAt: null }) }),
    );
    expect(updateMany).not.toHaveBeenCalled();
  });

  it('PENDING yang expiresAt-nya lewat → EXPIRED + alert (SYS-B-306)', async () => {
    const overdue = {
      id: 'ap-2',
      actionType: 'FORCE_SUCCESS',
      targetId: 'disb-2',
      amountSen: null,
      proposedBy: 'admin-a',
      expiresAt: new Date(Date.now() - 1000),
    };
    const updateMany = jest.fn().mockResolvedValue({ count: 1 });
    const prisma = {
      adminActionApproval: {
        findMany: jest.fn().mockResolvedValue([overdue]),
        updateMany,
      },
    } as unknown as PrismaService;
    const svc = new AdminApprovalSweepService(prisma, makeRedis());
    await svc.expireOverdueApprovals();

    expect(updateMany).toHaveBeenCalledWith({
      where: { id: 'ap-2', status: 'PENDING' },
      data: { status: 'EXPIRED' },
    });
    expect(alertMock).toHaveBeenCalledTimes(1);
    expect(alertMock.mock.calls[0][0].title).toContain('kedaluwarsa');
  });

  it('tak ada yang overdue → tak ada alert', async () => {
    const prisma = {
      adminActionApproval: {
        findMany: jest.fn().mockResolvedValue([]),
        updateMany: jest.fn(),
      },
    } as unknown as PrismaService;
    const svc = new AdminApprovalSweepService(prisma, makeRedis());
    await svc.expireOverdueApprovals();
    expect(alertMock).not.toHaveBeenCalled();
  });
});
