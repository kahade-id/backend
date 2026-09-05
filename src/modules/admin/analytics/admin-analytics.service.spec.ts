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
});
