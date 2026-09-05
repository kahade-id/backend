import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import * as ErrorCodes from '../../common/constants/error-codes';
import { toIdr } from '../../common/utils/currency.util';
import { formatWIBDate } from '../../common/utils/date.util';

@Injectable()
export class UserAnalyticsService {
  constructor(private prisma: PrismaService) {}

  async getUserAnalytics(userId: string, period: string = '30d') {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        totalOrdersCompleted: true, totalOrdersAsBuyer: true, totalOrdersAsSeller: true,
        totalOrdersCancelled: true, totalOrdersDisputed: true, totalTransactionValue: true,
        averageRating: true, totalRatingCount: true, membershipRank: true, memberSince: true,
        kycStatus: true, isKahadePlus: true, createdAt: true,
      },
    });
    if (!user) throw new NotFoundException({ code: ErrorCodes.USER_NOT_FOUND, message: 'User not found' });

    const days = period === '7d' ? 7 : period === '90d' ? 90 : period === '1y' ? 365 : 30;
    const sinceDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    const [ordersInPeriod, walletTxInPeriod, ratingsInPeriod, monthlyVolume, visibleRatingAggregate] = await Promise.all([
      this.prisma.order.findMany({
        where: {
          OR: [{ buyerId: userId }, { sellerId: userId }],
          createdAt: { gte: sinceDate },
        },
        select: { status: true, orderValue: true, createdAt: true, buyerId: true, sellerId: true },
        orderBy: { createdAt: 'asc' },
      }),
      this.prisma.walletTransaction.findMany({
        where: { wallet: { userId }, createdAt: { gte: sinceDate } },
        select: { type: true, amount: true, createdAt: true },
        orderBy: { createdAt: 'asc' },
      }),
      this.prisma.rating.findMany({
        where: { receiverId: userId, isHidden: false, createdAt: { gte: sinceDate } },
        select: { stars: true, createdAt: true },
        orderBy: { createdAt: 'asc' },
      }),
      this.prisma.order.aggregate({
        where: {
          OR: [{ buyerId: userId }, { sellerId: userId }],
          status: 'COMPLETED',
          completedAt: { gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) },
        },
        _sum: { orderValue: true },
        _count: true,
      }),
      this.prisma.rating.aggregate({ where: { receiverId: userId, isHidden: false }, _avg: { stars: true }, _count: { stars: true } }),
    ]);
    // L-231: These queries are covered by existing composite indexes:
    //   orders: @@index([buyerId, createdAt]), @@index([sellerId, createdAt]), @@index([buyerId, status]), @@index([sellerId, status])
    //   wallet_transactions: @@index([walletId, createdAt])
    //   ratings: @@index([receiverId, isHidden, createdAt])

    const completedInPeriod = ordersInPeriod.filter((o) => o.status === 'COMPLETED').length;
    const cancelledInPeriod = ordersInPeriod.filter((o) => o.status === 'CANCELLED').length;
    const disputedInPeriod = ordersInPeriod.filter((o) => o.status === 'DISPUTED').length;
    const volumeInPeriod = ordersInPeriod
      .filter((o) => o.status === 'COMPLETED')
      .reduce((sum, o) => sum + toIdr(o.orderValue), 0);

    const asBuyerInPeriod = ordersInPeriod.filter((o) => o.buyerId === userId).length;
    const asSellerInPeriod = ordersInPeriod.filter((o) => o.sellerId === userId).length;

    const topups = walletTxInPeriod.filter((t) => t.type === 'TOP_UP').reduce((s, t) => s + toIdr(t.amount), 0);
    const withdrawals = walletTxInPeriod.filter((t) => t.type === 'WITHDRAW').reduce((s, t) => s + toIdr(t.amount), 0);

    const ordersByDay: Record<string, number> = {};
    ordersInPeriod.forEach((o) => {
      const day = formatWIBDate(o.createdAt);
      ordersByDay[day] = (ordersByDay[day] || 0) + 1;
    });

    const ratingTrend = ratingsInPeriod.map((r) => ({
      date: formatWIBDate(r.createdAt),
      stars: r.stars,
    }));

    return {
      overview: {
        totalOrders: user.totalOrdersAsBuyer + user.totalOrdersAsSeller,
        totalCompleted: user.totalOrdersCompleted,
        totalCancelled: user.totalOrdersCancelled,
        totalDisputed: user.totalOrdersDisputed,
        totalVolume: toIdr(user.totalTransactionValue),
        avgRating: Number(visibleRatingAggregate._avg.stars ?? 0),
        ratingCount: visibleRatingAggregate._count.stars,
        membershipRank: user.membershipRank,
        memberSince: user.memberSince,
        trustScore: this.calculateTrustScore({ ...user, averageRating: visibleRatingAggregate._avg.stars ?? 0, totalRatingCount: visibleRatingAggregate._count.stars }),
      },
      period: {
        days,
        ordersTotal: ordersInPeriod.length,
        ordersCompleted: completedInPeriod,
        ordersCancelled: cancelledInPeriod,
        ordersDisputed: disputedInPeriod,
        asBuyer: asBuyerInPeriod,
        asSeller: asSellerInPeriod,
        volume: volumeInPeriod,
        topups,
        withdrawals,
        ratingsReceived: ratingsInPeriod.length,
        avgRatingInPeriod: ratingsInPeriod.length > 0
          ? Math.round(ratingsInPeriod.reduce((s, r) => s + r.stars, 0) / ratingsInPeriod.length * 100) / 100
          : null,
      },
      charts: {
        ordersByDay,
        ratingTrend,
      },
      monthlyVolume: {
        count: monthlyVolume._count ?? 0,
        volume: toIdr(monthlyVolume._sum?.orderValue ?? BigInt(0)),
      },
    };
  }

  calculateTrustScore(user: {
    totalOrdersCompleted: number;
    totalOrdersCancelled: number;
    totalOrdersDisputed: number;
    averageRating: unknown;
    totalRatingCount: number;
    kycStatus: string;
    isKahadePlus: boolean;
    createdAt: Date;
  }): number {
    let score = 0;

    if (user.kycStatus === 'APPROVED') score += 20;
    if (user.isKahadePlus) score += 5;

    const completedOrders = Number.isFinite(user.totalOrdersCompleted) ? Math.max(0, user.totalOrdersCompleted) : 0;
    const cancelledOrders = Number.isFinite(user.totalOrdersCancelled) ? Math.max(0, user.totalOrdersCancelled) : 0;
    const disputedOrders = Number.isFinite(user.totalOrdersDisputed) ? Math.max(0, user.totalOrdersDisputed) : 0;
    const totalOrders = completedOrders + cancelledOrders + disputedOrders;
    if (totalOrders > 0) {
      const completionRate = completedOrders / totalOrders;
      score += Math.round(completionRate * 25);
    }

    const parsedRating = Number(user.averageRating);
    const rating = Number.isFinite(parsedRating) ? Math.min(5, Math.max(0, parsedRating)) : 0;
    const ratingCount = Number.isFinite(user.totalRatingCount) ? Math.max(0, user.totalRatingCount) : 0;
    if (ratingCount > 0 && rating > 0) {
      score += Math.round((rating / 5) * 25);
    }

    if (completedOrders >= 50) score += 15;
    else if (completedOrders >= 20) score += 10;
    else if (completedOrders >= 5) score += 5;

    const accountAgeDays = (Date.now() - user.createdAt.getTime()) / (1000 * 60 * 60 * 24);
    if (accountAgeDays >= 365) score += 10;
    else if (accountAgeDays >= 180) score += 7;
    else if (accountAgeDays >= 30) score += 3;

    return Math.min(100, Math.max(0, score));
  }

  getTrustBadge(score: number): { label: string; labelEn: string; color: string } {
    if (score >= 90) return { label: 'Sangat Terpercaya', labelEn: 'Highly Trusted', color: 'emerald' };
    if (score >= 70) return { label: 'Terpercaya', labelEn: 'Trusted', color: 'blue' };
    if (score >= 50) return { label: 'Cukup Baik', labelEn: 'Good', color: 'yellow' };
    if (score >= 30) return { label: 'Baru', labelEn: 'New', color: 'gray' };
    return { label: 'Belum Terverifikasi', labelEn: 'Unverified', color: 'red' };
  }
}
