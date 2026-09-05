import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import { UserAnalyticsService } from '../user-analytics.service';
import { PrismaService } from '../../../prisma/prisma.service';

const mockPrisma: any = {
  user: { findUnique: jest.fn() },
  order: { findMany: jest.fn(), aggregate: jest.fn() },
  walletTransaction: { findMany: jest.fn() },
  rating: { findMany: jest.fn(), aggregate: jest.fn() },
};

describe('UserAnalyticsService', () => {
  let service: UserAnalyticsService;

  beforeEach(async () => {
    jest.resetAllMocks();
    mockPrisma.order.aggregate.mockResolvedValue({ _sum: { orderValue: BigInt(0) }, _count: 0 });
    mockPrisma.order.findMany.mockResolvedValue([]);
    mockPrisma.walletTransaction.findMany.mockResolvedValue([]);
    mockPrisma.rating.findMany.mockResolvedValue([]);
    mockPrisma.rating.aggregate.mockResolvedValue({ _avg: { stars: null }, _count: { stars: 0 } });
    const module: TestingModule = await Test.createTestingModule({
      providers: [UserAnalyticsService, { provide: PrismaService, useValue: mockPrisma }],
    }).compile();
    service = module.get<UserAnalyticsService>(UserAnalyticsService);
  });

  it('should be defined', () => expect(service).toBeDefined());

  it('throws NotFoundException when user missing', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(null);
    await expect(service.getUserAnalytics('u1')).rejects.toThrow(NotFoundException);
  });

  it.each(['7d', '30d', '90d', '1y', 'unknown'])('handles period %s', async (period) => {
    mockPrisma.user.findUnique.mockResolvedValue({
      totalOrdersCompleted: 0, totalOrdersAsBuyer: 0, totalOrdersAsSeller: 0,
      totalOrdersCancelled: 0, totalOrdersDisputed: 0, totalTransactionValue: BigInt(0),
      averageRating: 0, totalRatingCount: 0, membershipRank: 'BRONZE', memberSince: new Date(),
      kycStatus: 'PENDING', isKahadePlus: false, createdAt: new Date(),
    });
    const res: any = await service.getUserAnalytics('u1', period);
    expect(res.period.days).toBeGreaterThan(0);
  });

  it('aggregates orders/wallet/rating in period', async () => {
    mockPrisma.user.findUnique.mockResolvedValue({
      totalOrdersCompleted: 1, totalOrdersAsBuyer: 1, totalOrdersAsSeller: 0,
      totalOrdersCancelled: 0, totalOrdersDisputed: 0, totalTransactionValue: BigInt(100000),
      averageRating: 4, totalRatingCount: 1, membershipRank: 'BRONZE', memberSince: new Date(),
      kycStatus: 'APPROVED', isKahadePlus: true, createdAt: new Date(),
    });
    const now = new Date();
    mockPrisma.order.findMany.mockResolvedValue([
      { status: 'COMPLETED', orderValue: BigInt(100000), createdAt: now, buyerId: 'u1', sellerId: 'x' },
      { status: 'CANCELLED', orderValue: BigInt(0), createdAt: now, buyerId: 'u1', sellerId: 'x' },
    ]);
    mockPrisma.walletTransaction.findMany.mockResolvedValue([
      { type: 'TOP_UP', amount: BigInt(500000), createdAt: now },
      { type: 'WITHDRAW', amount: BigInt(200000), createdAt: now },
    ]);
    mockPrisma.rating.findMany.mockResolvedValue([{ stars: 5, createdAt: now }]);
    mockPrisma.order.aggregate.mockResolvedValue({ _sum: { orderValue: BigInt(100000) }, _count: 1 });

    const res: any = await service.getUserAnalytics('u1');
    expect(res.period.ordersCompleted).toBe(1);
    expect(res.period.ordersCancelled).toBe(1);
    expect(res.period.topups).toBe(5000);
    expect(res.period.withdrawals).toBe(2000);
    expect(res.period.avgRatingInPeriod).toBe(5);
  });

  it('labels order and rating charts using the WIB calendar date', async () => {
    mockPrisma.user.findUnique.mockResolvedValue({
      totalOrdersCompleted: 1, totalOrdersAsBuyer: 1, totalOrdersAsSeller: 0,
      totalOrdersCancelled: 0, totalOrdersDisputed: 0, totalTransactionValue: BigInt(100000),
      averageRating: 5, totalRatingCount: 1, membershipRank: 'BRONZE', memberSince: new Date(),
      kycStatus: 'APPROVED', isKahadePlus: false, createdAt: new Date(),
    });
    const earlyWib = new Date('2026-08-20T18:30:00.000Z');
    mockPrisma.order.findMany.mockResolvedValue([
      { status: 'COMPLETED', orderValue: BigInt(100000), createdAt: earlyWib, buyerId: 'u1', sellerId: 'x' },
    ]);
    mockPrisma.rating.findMany.mockResolvedValue([{ stars: 5, createdAt: earlyWib }]);

    const res: any = await service.getUserAnalytics('u1');

    expect(res.charts.ordersByDay).toEqual({ '2026-08-21': 1 });
    expect(res.charts.ratingTrend).toEqual([{ date: '2026-08-21', stars: 5 }]);
  });

  describe('calculateTrustScore', () => {
    it('returns score 0 for blank user', () => {
      const score = service.calculateTrustScore({
        totalOrdersCompleted: 0, totalOrdersCancelled: 0, totalOrdersDisputed: 0,
        averageRating: 0, totalRatingCount: 0, kycStatus: 'PENDING', isKahadePlus: false,
        createdAt: new Date(),
      });
      expect(score).toBe(0);
    });

    it('rewards verified, KahadePlus, completion, rating, age', () => {
      const score = service.calculateTrustScore({
        totalOrdersCompleted: 100, totalOrdersCancelled: 0, totalOrdersDisputed: 0,
        averageRating: 5, totalRatingCount: 50, kycStatus: 'APPROVED', isKahadePlus: true,
        createdAt: new Date(Date.now() - 400 * 24 * 60 * 60 * 1000),
      });
      expect(score).toBe(100);
    });

    it('returns a finite bounded score for corrupt numeric aggregates', () => {
      const score = service.calculateTrustScore({
        totalOrdersCompleted: Number.NaN,
        totalOrdersCancelled: Number.POSITIVE_INFINITY,
        totalOrdersDisputed: -10,
        averageRating: Number.NaN,
        totalRatingCount: Number.POSITIVE_INFINITY,
        kycStatus: 'APPROVED',
        isKahadePlus: false,
        createdAt: new Date(Number.NaN),
      });
      expect(Number.isFinite(score)).toBe(true);
      expect(score).toBeGreaterThanOrEqual(0);
      expect(score).toBeLessThanOrEqual(100);
    });

    it('caps at 100', () => {
      const s = service.calculateTrustScore({
        totalOrdersCompleted: 999, totalOrdersCancelled: 0, totalOrdersDisputed: 0,
        averageRating: 5, totalRatingCount: 999, kycStatus: 'APPROVED', isKahadePlus: true,
        createdAt: new Date('2000-01-01'),
      });
      expect(s).toBe(100);
    });
  });

  describe('getTrustBadge', () => {
    it.each([
      [95, 'Sangat Terpercaya'],
      [75, 'Terpercaya'],
      [55, 'Cukup Baik'],
      [35, 'Baru'],
      [10, 'Belum Terverifikasi'],
    ])('badge for score %i = %s', (score, label) => {
      expect(service.getTrustBadge(score).label).toBe(label);
    });
  });
});
