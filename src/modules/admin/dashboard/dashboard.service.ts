import { BadRequestException, Injectable } from '@nestjs/common';
import { OrderStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { RedisService } from '../../../redis/redis.service';
import { parseDateBoundaryWIB, startOfDayWIB } from '../../../common/utils/date.util';
import { toIdr } from '../../../common/utils/currency.util';
import { ChartQueryDto } from './dto/chart-query.dto';

const DASHBOARD_SUMMARY_CACHE_KEY = 'dashboard:summary_v2';
const DASHBOARD_SUMMARY_TTL = 300; // 5 minutes

@Injectable()
export class DashboardService {
  constructor(
    private prisma: PrismaService,
    private redis: RedisService,
  ) {}

  // hitting the DB with 9 parallel count/aggregate queries on every dashboard load.
  async getSummary(): Promise<object> {
    const cached = await this.redis.get(DASHBOARD_SUMMARY_CACHE_KEY);
    if (cached) {
      try {
        return JSON.parse(cached);
      } catch {
        // A corrupt cache entry must not turn the dashboard into a permanent 500.
        await this.redis.del(DASHBOARD_SUMMARY_CACHE_KEY);
      }
    }

    const today = startOfDayWIB();

    const [
      totalUsers, newUsersToday, verifiedUsers,
      totalOrders, activeOrders, completedOrders,
      openDisputes, pendingKyc,
      totalWalletBalance,
    ] = await Promise.all([
      this.prisma.user.count({ where: { deletedAt: null } }),
      this.prisma.user.count({ where: { deletedAt: null, createdAt: { gte: today } } }),
      this.prisma.user.count({ where: { deletedAt: null, kycStatus: 'APPROVED' } }),
      this.prisma.order.count(),
      this.prisma.order.count({
        where: {
          status: {
            in: [
              OrderStatus.WAITING_PAYMENT,
              OrderStatus.PROCESSING,
              OrderStatus.IN_DELIVERY,
            ],
          },
        },
      }),
      this.prisma.order.count({ where: { status: OrderStatus.COMPLETED } }),
      this.prisma.dispute.count({ where: { status: { in: ['OPEN', 'UNDER_REVIEW'] } } }),
      this.prisma.kycRequest.count({ where: { status: 'PENDING' } }),
      this.prisma.wallet.aggregate({ _sum: { totalBalance: true } }),
    ]);

    const result = {
      users: { total: totalUsers, newToday: newUsersToday, verified: verifiedUsers },
      orders: { total: totalOrders, active: activeOrders, completed: completedOrders },
      disputes: { open: openDisputes },
      kyc: { pending: pendingKyc },
      finance: {
        totalWalletBalance: toIdr(totalWalletBalance._sum.totalBalance ?? BigInt(0)),
      },
    };

    await this.redis.setex(DASHBOARD_SUMMARY_CACHE_KEY, DASHBOARD_SUMMARY_TTL, JSON.stringify(result));

    return result;
  }

  private getPeriodStartDate(period: string = '30d'): Date {
    const now = new Date();
    switch (period) {
      case '7d':
        return new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
      case '30d':
        return new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
      case '90d':
        return new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);
      case '1y':
        return new Date(now.getTime() - 365 * 24 * 60 * 60 * 1000);
      default:
        return new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    }
  }

  private getDateRange(query: ChartQueryDto): { period: string; startDate: Date; endDate?: Date } {
    const period = query.period ?? '30d';
    const startDate = query.startDate
      ? parseDateBoundaryWIB(query.startDate, 'start')
      : this.getPeriodStartDate(period);
    const endDate = query.endDate ? parseDateBoundaryWIB(query.endDate, 'end') : undefined;
    if (!startDate || (query.endDate && !endDate) || (endDate && endDate < startDate)) {
      throw new BadRequestException({ code: 'INVALID_DATE_RANGE', message: 'Invalid dashboard date range' });
    }
    return { period, startDate, endDate };
  }

  async getCharts(query: ChartQueryDto): Promise<object> {
    const { period, startDate, endDate } = this.getDateRange(query);
    const endDateFilter = endDate
      ? Prisma.sql` AND "createdAt" <= ${endDate}`
      : Prisma.empty;

    const [ordersByDay, revenueByDay] = await Promise.all([
      this.prisma.$queryRaw<Array<{ day: string; count: bigint }>>`
        SELECT ("createdAt" AT TIME ZONE 'Asia/Jakarta')::date::text as day, COUNT(*)::bigint as count
        FROM orders
        WHERE "createdAt" >= ${startDate}${endDateFilter}
        GROUP BY ("createdAt" AT TIME ZONE 'Asia/Jakarta')::date
        ORDER BY day ASC
      `,
      this.prisma.$queryRaw<Array<{ day: string; revenue: bigint }>>`
        SELECT ("createdAt" AT TIME ZONE 'Asia/Jakarta')::date::text as day, COALESCE(SUM("feeAmount"), 0)::bigint as revenue
        FROM orders
        WHERE "createdAt" >= ${startDate}${endDateFilter} AND status = 'COMPLETED'
        GROUP BY ("createdAt" AT TIME ZONE 'Asia/Jakarta')::date
        ORDER BY day ASC
      `,
    ]);

    const allDates = new Set([
      ...ordersByDay.map(o => o.day),
      ...revenueByDay.map(r => r.day),
    ]);
    const orderMap = new Map(ordersByDay.map(o => [o.day, Number(o.count)]));
    const revenueMap = new Map(revenueByDay.map(r => [r.day, r.revenue]));
    const sortedDates = [...allDates].sort();

    return {
      period,
      data: sortedDates.map(date => ({
        date,
        orders: orderMap.get(date) ?? 0,
        revenue: toIdr(revenueMap.get(date) ?? BigInt(0)),
      })),
    };
  }

  async getRecentActivity(): Promise<{ data: object[] }> {
    const logs = await this.prisma.adminAuditLog.findMany({
      take: 20,
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        action: true,
        targetType: true,
        targetId: true,
        description: true,
        createdAt: true,
        admin: {
          select: {
            id: true,
            fullName: true,
            role: true,
          },
        },
      },
    });

    return { data: logs };
  }

  async getUserGrowth(query: ChartQueryDto): Promise<object> {
    const { period, startDate, endDate } = this.getDateRange(query);
    const endDateFilter = endDate
      ? Prisma.sql` AND "createdAt" <= ${endDate}`
      : Prisma.empty;

    const usersByDay = await this.prisma.$queryRaw<Array<{ day: string; count: bigint }>>`
      SELECT ("createdAt" AT TIME ZONE 'Asia/Jakarta')::date::text as day, COUNT(*)::bigint as count
      FROM users
      WHERE "createdAt" >= ${startDate}${endDateFilter} AND "deletedAt" IS NULL
      GROUP BY ("createdAt" AT TIME ZONE 'Asia/Jakarta')::date
      ORDER BY day ASC
    `;

    const baseCountResult = await this.prisma.$queryRaw<Array<{ count: bigint }>>`
      SELECT COUNT(*)::bigint as count FROM users
      WHERE "createdAt" < ${startDate} AND "deletedAt" IS NULL
    `;
    let cumulative = Number(baseCountResult[0]?.count ?? 0);
    return {
      period,
      data: usersByDay.map(row => {
        const count = Number(row.count);
        cumulative += count;
        return {
          date: row.day,
          newUsers: count,
          cumulativeUsers: cumulative,
        };
      }),
    };
  }

  async getOrderStats(): Promise<object> {
    const grouped = await this.prisma.order.groupBy({
      by: ['status'],
      _count: { id: true },
    });

    const countMap = new Map<OrderStatus, number>();
    let total = 0;
    for (const g of grouped) {
      countMap.set(g.status, g._count.id);
      total += g._count.id;
    }

    const statuses = Object.values(OrderStatus);

    return {
      total,
      distribution: statuses.map(status => {
        const count = countMap.get(status) ?? 0;
        return {
          status,
          count,
          percentage: total > 0 ? Math.round((count / total) * 10000) / 100 : 0,
        };
      }),
    };
  }
}
