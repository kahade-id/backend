import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import * as ErrorCodes from '../../common/constants/error-codes';
import { toIdr } from '../../common/utils/currency.util';

@Injectable()
export class UserStatsService {
  constructor(private prisma: PrismaService) {}

  async getDashboardStats(userId: string): Promise<object> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        totalOrdersCompleted: true,
        totalOrdersAsBuyer: true,
        totalOrdersAsSeller: true,
        totalOrdersCancelled: true,
        totalOrdersDisputed: true,
        totalTransactionValue: true,
        averageRating: true,
        totalRatingCount: true,
        membershipRank: true,
        memberSince: true,
      },
    });
    if (!user) throw new NotFoundException({ code: ErrorCodes.USER_NOT_FOUND, message: 'User not found' });

    const [buyerOrders, sellerOrders, disputeCount, avgCompletionTime, repeatBuyers] = await Promise.all([
      this.prisma.order.count({ where: { buyerId: userId, status: 'COMPLETED' } }),
      this.prisma.order.count({ where: { sellerId: userId, status: 'COMPLETED' } }),
      this.prisma.order.count({ where: { OR: [{ buyerId: userId }, { sellerId: userId }], status: 'DISPUTED' } }),
      this.prisma.order.findMany({
        where: { OR: [{ buyerId: userId }, { sellerId: userId }], status: 'COMPLETED', completedAt: { not: null }, paidAt: { not: null } },
        select: { paidAt: true, completedAt: true },
        take: 100,
        orderBy: { completedAt: 'desc' },
      }),
      this.prisma.order.groupBy({
        by: ['buyerId'],
        where: { sellerId: userId, status: 'COMPLETED' },
        _count: { buyerId: true },
        having: { buyerId: { _count: { gt: 1 } } },
      }),
    ]);

    let avgDays = 0;
    if (avgCompletionTime.length > 0) {
      const totalDays = avgCompletionTime.reduce((sum, o) => {
        if (o.paidAt && o.completedAt) {
          return sum + (o.completedAt.getTime() - o.paidAt.getTime()) / (1000 * 60 * 60 * 24);
        }
        return sum;
      }, 0);
      avgDays = Math.round((totalDays / avgCompletionTime.length) * 10) / 10;
    }

    const totalCompleted = user.totalOrdersCompleted;
    const disputeRate = totalCompleted > 0 ? Math.round((user.totalOrdersDisputed / (totalCompleted + user.totalOrdersDisputed)) * 10000) / 100 : 0;

    return {
      overview: {
        totalOrders: user.totalOrdersAsBuyer + user.totalOrdersAsSeller,
        totalCompleted: user.totalOrdersCompleted,
        totalCancelled: user.totalOrdersCancelled,
        totalDisputed: user.totalOrdersDisputed,
        totalTransactionValue: toIdr(user.totalTransactionValue),
        avgRating: Number(user.averageRating ?? 0),
        ratingCount: user.totalRatingCount,
        membershipRank: user.membershipRank,
        memberSince: user.memberSince,
      },
      seller: {
        completedOrders: sellerOrders,
        avgCompletionDays: avgDays,
        repeatBuyerCount: repeatBuyers.length,
        disputeRate,
      },
      buyer: {
        completedOrders: buyerOrders,
        totalDisputes: disputeCount,
      },
    };
  }
}
