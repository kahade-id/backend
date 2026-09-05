import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import { UserStatsService } from '../user-stats.service';
import { PrismaService } from '../../../prisma/prisma.service';

const mockPrisma: any = {
  user: { findUnique: jest.fn() },
  order: { count: jest.fn(), findMany: jest.fn(), groupBy: jest.fn() },
};

describe('UserStatsService', () => {
  let service: UserStatsService;

  beforeEach(async () => {
    jest.resetAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [UserStatsService, { provide: PrismaService, useValue: mockPrisma }],
    }).compile();
    service = module.get<UserStatsService>(UserStatsService);
  });

  it('should be defined', () => expect(service).toBeDefined());

  it('throws NotFoundException when user missing', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(null);
    await expect(service.getDashboardStats('u1')).rejects.toThrow(NotFoundException);
  });

  it('returns aggregated dashboard stats with avg completion days', async () => {
    mockPrisma.user.findUnique.mockResolvedValue({
      totalOrdersCompleted: 10, totalOrdersAsBuyer: 5, totalOrdersAsSeller: 5,
      totalOrdersCancelled: 1, totalOrdersDisputed: 2,
      totalTransactionValue: BigInt(1000000), averageRating: 4.5, totalRatingCount: 8,
      membershipRank: 'BRONZE', memberSince: new Date(),
    });
    mockPrisma.order.count.mockResolvedValueOnce(5).mockResolvedValueOnce(5).mockResolvedValueOnce(2);
    const paid = new Date('2024-01-01T00:00:00Z');
    const completed = new Date('2024-01-03T00:00:00Z');
    mockPrisma.order.findMany.mockResolvedValue([{ paidAt: paid, completedAt: completed }]);
    mockPrisma.order.groupBy.mockResolvedValue([{ buyerId: 'b1', _count: { buyerId: 2 } }]);

    const res: any = await service.getDashboardStats('u1');
    expect(res.overview.totalOrders).toBe(10);
    expect(res.seller.avgCompletionDays).toBe(2);
    expect(res.seller.repeatBuyerCount).toBe(1);
    expect(res.seller.disputeRate).toBeCloseTo(16.67, 1);
  });

  it('handles zero completed orders without divide-by-zero', async () => {
    mockPrisma.user.findUnique.mockResolvedValue({
      totalOrdersCompleted: 0, totalOrdersAsBuyer: 0, totalOrdersAsSeller: 0,
      totalOrdersCancelled: 0, totalOrdersDisputed: 0,
      totalTransactionValue: BigInt(0), averageRating: 0, totalRatingCount: 0,
      membershipRank: 'BRONZE', memberSince: new Date(),
    });
    mockPrisma.order.count.mockResolvedValue(0);
    mockPrisma.order.findMany.mockResolvedValue([]);
    mockPrisma.order.groupBy.mockResolvedValue([]);

    const res: any = await service.getDashboardStats('u1');
    expect(res.seller.avgCompletionDays).toBe(0);
    expect(res.seller.disputeRate).toBe(0);
  });
});
