import { BadRequestException, Injectable } from '@nestjs/common';
import { OrderStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { RedisService } from '../../../redis/redis.service';
import { parseDateBoundaryWIB, startOfDayWIB, toWIB } from '../../../common/utils/date.util';
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

  /**
   * BAI-122: definisi "escrow aktif" = SEMUA status order yang belum final:
   * WAITING_CONFIRMATION (status default setiap order baru — sebelumnya
   * tertinggal), WAITING_PAYMENT, PROCESSING, IN_DELIVERY. Status final
   * (COMPLETED, CANCELLED, DISPUTED) bukan bagian dari metrik ini.
   */
  static readonly ACTIVE_ORDER_STATUSES: OrderStatus[] = [
    OrderStatus.WAITING_CONFIRMATION,
    OrderStatus.WAITING_PAYMENT,
    OrderStatus.PROCESSING,
    OrderStatus.IN_DELIVERY,
  ];

  // hitting the DB with 9 parallel count/aggregate queries on every dashboard load.
  // BAI-125: `refresh=true` melewati cache (tombol "Muat ulang" di panel admin)
  // dan menghitung ulang dari DB, lalu menulis ulang cache.
  async getSummary(refresh = false): Promise<object> {
    if (!refresh) {
      const cached = await this.redis.get(DASHBOARD_SUMMARY_CACHE_KEY);
      if (cached) {
        try {
          return JSON.parse(cached);
        } catch {
          // A corrupt cache entry must not turn the dashboard into a permanent 500.
          await this.redis.del(DASHBOARD_SUMMARY_CACHE_KEY);
        }
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
      // BAI-132: filter deletedAt agar konsisten dengan analitik (admin-analytics).
      this.prisma.order.count({ where: { deletedAt: null } }),
      this.prisma.order.count({
        where: {
          deletedAt: null,
          status: { in: DashboardService.ACTIVE_ORDER_STATUSES },
        },
      }),
      this.prisma.order.count({ where: { deletedAt: null, status: OrderStatus.COMPLETED } }),
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

  // AW-018: SATU pintu invalidasi cache summary dashboard. Dipanggil oleh
  // service admin yang bermutasi dan memengaruhi angka (ban/unban user,
  // approve/reject KYC, resolve dispute, force-cancel/complete order,
  // approve/reject withdrawal). Best-effort: kegagalan Redis tidak boleh
  // menggagalkan aksi admin — entri lama paling lama bertahan sampai TTL.
  async invalidateSummaryCache(): Promise<void> {
    try {
      await this.redis.del(DASHBOARD_SUMMARY_CACHE_KEY);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('[DashboardService] failed to invalidate summary cache', err);
    }
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
    // ADM-025: rentang kustom tanpa `period` eksplisit dilaporkan sebagai
    // 'custom' (sebelumnya respons menyesatkan mengembalikan '30d').
    const hasCustomRange = Boolean(query.startDate || query.endDate);
    const period = query.period ?? (hasCustomRange ? 'custom' : '30d');
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
    // AW-013: revenue (fee order COMPLETED) dibucket pada completedAt —
    // konsisten dengan getFinancialSummary (feeToday/feeThisMonth) dan
    // getRevenue bulanan. Bucket "orders" tetap berbasis kreasi (createdAt).
    const endDateFilterCompleted = endDate
      ? Prisma.sql` AND "completedAt" <= ${endDate}`
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
        SELECT ("completedAt" AT TIME ZONE 'Asia/Jakarta')::date::text as day, COALESCE(SUM("feeAmount"), 0)::bigint as revenue
        FROM orders
        WHERE "completedAt" >= ${startDate}${endDateFilterCompleted} AND status = 'COMPLETED'
        GROUP BY ("completedAt" AT TIME ZONE 'Asia/Jakarta')::date
        ORDER BY day ASC
      `,
    ]);

    const orderMap = new Map(ordersByDay.map(o => [o.day, Number(o.count)]));
    const revenueMap = new Map(revenueByDay.map(r => [r.day, r.revenue]));

    // BAI-130: zero-fill — semua hari kalender WIB dalam rentang muncul di
    // sumbu waktu (hari tanpa order/revenue = 0), agar tren tidak terlihat
    // kontinu padahal ada gap.
    const rangeEnd = endDate ?? new Date();
    const fillDates: string[] = [];
    let cursor = startOfDayWIB(startDate);
    const lastDay = startOfDayWIB(rangeEnd);
    // WIB tidak punya DST — langkah 24 jam aman.
    while (cursor <= lastDay) {
      fillDates.push(toWIB(cursor).format('YYYY-MM-DD'));
      cursor = new Date(cursor.getTime() + 24 * 60 * 60 * 1000);
    }

    return {
      period,
      data: fillDates.map(date => ({
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
    // BAI-132: order yang di-soft-delete dikecualikan — konsisten dengan
    // analitik (admin-analytics.service), agar "Total order" identik di
    // Dashboard dan Analitik.
    const grouped = await this.prisma.order.groupBy({
      by: ['status'],
      where: { deletedAt: null },
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
