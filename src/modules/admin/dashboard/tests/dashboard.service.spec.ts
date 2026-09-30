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

  it('AW-018: invalidateSummaryCache deletes the summary key and never throws', async () => {
    await service.invalidateSummaryCache();
    expect(redis.del).toHaveBeenCalledWith('dashboard:summary_v2');

    redis.del.mockRejectedValueOnce(new Error('redis down'));
    await expect(service.invalidateSummaryCache()).resolves.toBeUndefined();
  });

  it('BAI-125: refresh=true bypasses the 5-minute cache and recomputes from DB', async () => {
    redis.get.mockResolvedValue(JSON.stringify({ users: { total: 999 } }));

    const result = await service.getSummary(true);

    expect(redis.get).not.toHaveBeenCalled();
    expect(prisma.user.count).toHaveBeenCalled();
    expect(redis.setex).toHaveBeenCalledWith('dashboard:summary_v2', 300, expect.any(String));
    expect(result).toMatchObject({ users: { total: 0 }, orders: { total: 0 } });
  });

  it('BAI-125: default getSummary() still serves the cached snapshot', async () => {
    redis.get.mockResolvedValue(JSON.stringify({ users: { total: 7 } }));

    const result = await service.getSummary();

    expect(prisma.user.count).not.toHaveBeenCalled();
    expect(result).toMatchObject({ users: { total: 7 } });
  });

  it('BAI-122: active orders include WAITING_CONFIRMATION (the default new-order status)', async () => {
    redis.get.mockResolvedValue(null);
    await service.getSummary();

    const activeCall = prisma.order.count.mock.calls.find((args: unknown[]) =>
      (args[0] as { where?: { status?: { in?: string[] } } })?.where?.status?.in,
    );
    expect(activeCall).toBeDefined();
    const statuses = (activeCall![0] as { where: { status: { in: string[] } } }).where.status.in;
    expect(statuses).toEqual(
      expect.arrayContaining(['WAITING_CONFIRMATION', 'WAITING_PAYMENT', 'PROCESSING', 'IN_DELIVERY']),
    );
    // Semua count order mengecualikan soft-delete (BAI-132).
    for (const args of prisma.order.count.mock.calls) {
      expect((args[0] as { where?: object }).where).toEqual(expect.objectContaining({ deletedAt: null }));
    }
  });

  it('BAI-130/BAI-131: getCharts zero-fills empty days and reports period=custom for custom ranges', async () => {
    prisma.$queryRaw
      .mockResolvedValueOnce([{ day: '2026-09-28', count: 5n }]) // ordersByDay
      .mockResolvedValueOnce([]); // revenueByDay

    const result = (await service.getCharts({
      startDate: '2026-09-28',
      endDate: '2026-09-30',
    })) as { period: string; data: Array<{ date: string; orders: number; revenue: number }> };

    expect(result.period).toBe('custom');
    expect(result.data.map((d) => d.date)).toEqual(['2026-09-28', '2026-09-29', '2026-09-30']);
    expect(result.data[0].orders).toBe(5);
    expect(result.data[1]).toMatchObject({ date: '2026-09-29', orders: 0, revenue: 0 });
    expect(result.data[2]).toMatchObject({ date: '2026-09-30', orders: 0, revenue: 0 });
  });
});
