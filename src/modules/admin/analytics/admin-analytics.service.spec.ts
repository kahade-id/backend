import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException } from '@nestjs/common';
import { AdminAnalyticsService } from '../admin-analytics.service';
import { PrismaService } from '../../../prisma/prisma.service';

const mockPrisma = {
  user: { count: jest.fn(), findMany: jest.fn() },
  order: { count: jest.fn(), aggregate: jest.fn() },
  $queryRaw: jest.fn(),
};

describe('AdminAnalyticsService', () => {
  let service: AdminAnalyticsService;

  beforeEach(async () => {
    jest.resetAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [AdminAnalyticsService, { provide: PrismaService, useValue: mockPrisma }],
    }).compile();
    service = module.get(AdminAnalyticsService);
  });

  it('excludes deleted users and orders from overview aggregates', async () => {
    mockPrisma.user.count.mockResolvedValueOnce(10).mockResolvedValueOnce(3);
    mockPrisma.order.count.mockResolvedValueOnce(20).mockResolvedValueOnce(12).mockResolvedValueOnce(2).mockResolvedValueOnce(1);
    mockPrisma.order.aggregate.mockResolvedValueOnce({ _sum: { orderValue: 10000n } }).mockResolvedValueOnce({ _sum: { feeAmount: 500n } });
    mockPrisma.$queryRaw.mockResolvedValue([{ count: 7n }]);
    const result = await service.getOverview(new Date('2026-01-01'), new Date('2026-01-31'));
    expect(result).toMatchObject({ users: { total: 10, new: 3 }, orders: { total: 20, completed: 12 }, activeUsers: 7 });
    for (const call of [...mockPrisma.user.count.mock.calls, ...mockPrisma.order.count.mock.calls, ...mockPrisma.order.aggregate.mock.calls]) {
      expect(call[0].where).toEqual(expect.objectContaining({ deletedAt: null }));
    }
    const activeSql = mockPrisma.$queryRaw.mock.calls[0][0].join(' ');
    expect(activeSql).toContain('o."deletedAt" IS NULL');
    expect(activeSql).toContain('bu."deletedAt" IS NULL');
    expect(activeSql).toContain('su."deletedAt" IS NULL');
  });

  it('rejects inverted date ranges before touching the database', async () => {
    await expect(service.getOverview(new Date('2026-02-01'), new Date('2026-01-01'))).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.getOrderStats(new Date('2026-02-01'), new Date('2026-01-01'))).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.getUserGrowth(new Date('2026-02-01'), new Date('2026-01-01'))).rejects.toBeInstanceOf(BadRequestException);
    expect(mockPrisma.user.count).not.toHaveBeenCalled();
    expect(mockPrisma.$queryRaw).not.toHaveBeenCalled();
  });

  it('AW-013: buckets completion metrics by completedAt, not createdAt', async () => {
    mockPrisma.$queryRaw.mockResolvedValue([
      { period: new Date('2026-01-05T00:00:00Z'), kind: 'total', total_orders: 4, gmv: 0n, revenue: 0n },
      { period: new Date('2026-01-05T00:00:00Z'), kind: 'completed', total_orders: 2, gmv: 10000000n, revenue: 250000n },
      { period: new Date('2026-01-05T00:00:00Z'), kind: 'disputed', total_orders: 1, gmv: 0n, revenue: 0n },
      { period: new Date('2026-01-06T00:00:00Z'), kind: 'cancelled', total_orders: 1, gmv: 0n, revenue: 0n },
    ]);
    const result = await service.getOrderStats(new Date('2026-01-01'), new Date('2026-01-31'), 'day') as Array<Record<string, unknown>>;
    const sql = mockPrisma.$queryRaw.mock.calls[0][0].join(' ');
    // Satu definisi: completed/GMV/revenue dari completedAt; disputed dari
    // disputedAt; cancelled dari cancelledAt; total dari createdAt.
    expect(sql).toContain('"completedAt"');
    expect(sql).toContain('"disputedAt"');
    expect(sql).toContain('"cancelledAt"');
    expect(sql).toContain('UNION ALL');
    const day5 = result.find(r => String(r.period).startsWith('2026-01-05'));
    expect(day5).toMatchObject({ totalOrders: 4, completed: 2, disputed: 1, cancelled: 0 });
    expect(day5?.gmv).toBe(100000); // toIdr: sen → rupiah
    expect(day5?.revenue).toBe(2500);
    const day6 = result.find(r => String(r.period).startsWith('2026-01-06'));
    expect(day6).toMatchObject({ totalOrders: 0, completed: 0, disputed: 0, cancelled: 1 });
    // BAI-129: bucket diserialisasi sebagai tanggal WIB "YYYY-MM-DD" —
    // bukan timestamp (sebelumnya dirender admin sebagai "07.00 WIB").
    expect(day5?.period).toBe('2026-01-05');
    expect(day6?.period).toBe('2026-01-06');
  });

  it('filters deleted rows in order stats and user growth raw queries', async () => {
    mockPrisma.$queryRaw.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    await service.getOrderStats(undefined, undefined, 'month');
    await service.getUserGrowth();
    const sql = mockPrisma.$queryRaw.mock.calls.map((call: unknown[]) => (call[0] as string[]).join(' ')).join('\n');
    expect(sql.match(/"deletedAt" IS NULL/g)?.length).toBeGreaterThanOrEqual(2);
  });

  it('clamps top-user limit and never returns deleted users', async () => {
    mockPrisma.user.findMany.mockResolvedValue([]);
    await service.getTopUsers(9999, 'volume');
    expect(mockPrisma.user.findMany).toHaveBeenCalledWith(expect.objectContaining({ take: 100, where: { deletedAt: null }, orderBy: { totalTransactionValue: 'desc' } }));
  });

  it('BAI-129: user-growth days are WIB date-only strings (no misleading time)', async () => {
    mockPrisma.$queryRaw.mockResolvedValue([
      { day: new Date('2026-01-05T00:00:00Z'), new_users: 3n, cumulative: 42n },
    ]);
    const result = await service.getUserGrowth() as Array<Record<string, unknown>>;
    expect(result[0]).toMatchObject({ day: '2026-01-05', newUsers: 3, cumulative: 42 });
  });
});
