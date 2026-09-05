import { BadRequestException } from '@nestjs/common';
import { DashboardService } from '../dashboard.service';

describe('DashboardService control-plane contracts', () => {
  const prisma = {
    user: { count: jest.fn() },
    order: { count: jest.fn(), groupBy: jest.fn() },
    dispute: { count: jest.fn() },
    kycRequest: { count: jest.fn() },
    wallet: { aggregate: jest.fn() },
    adminAuditLog: { findMany: jest.fn() },
    $queryRaw: jest.fn(),
  };
  const redis = { get: jest.fn(), del: jest.fn(), setex: jest.fn() };
  let service: DashboardService;

  beforeEach(() => {
    jest.resetAllMocks();
    redis.get.mockResolvedValue(null);
    redis.del.mockResolvedValue(undefined);
    redis.setex.mockResolvedValue(undefined);
    prisma.user.count.mockResolvedValue(0);
    prisma.order.count.mockResolvedValue(0);
    prisma.dispute.count.mockResolvedValue(0);
    prisma.kycRequest.count.mockResolvedValue(0);
    prisma.wallet.aggregate.mockResolvedValue({ _sum: { totalBalance: 0n } });
    prisma.adminAuditLog.findMany.mockResolvedValue([]);
    service = new DashboardService(prisma as never, redis as never);
  });

  it('recovers from corrupt cached summary instead of returning a permanent 500', async () => {
    redis.get.mockResolvedValue('{not-json');

    await expect(service.getSummary()).resolves.toMatchObject({
      users: { total: 0 },
      orders: { total: 0 },
    });
    expect(redis.del).toHaveBeenCalledWith('dashboard:summary_v2');
    expect(prisma.user.count).toHaveBeenCalled();
  });

  it('rejects a dashboard date range whose end precedes its start', async () => {
    await expect(service.getCharts({ period: '30d', startDate: '2026-08-20', endDate: '2026-08-19' }))
      .rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
  });
});
