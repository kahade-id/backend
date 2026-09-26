import { BadRequestException, Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { toIdr } from '../../common/utils/currency.util';

interface UserGrowthRow {
  day: Date;
  new_users: number;
  cumulative: number;
}

@Injectable()
export class AdminAnalyticsService {
  constructor(private readonly prisma: PrismaService) {}

  async getOverview(startDate?: Date, endDate?: Date): Promise<object> {
    this.assertDateRange(startDate, endDate);
    const dateFilter = this.buildDateFilter(startDate, endDate);

    const [
      totalUsers,
      newUsers,
      totalOrders,
      completedOrders,
      disputedOrders,
      cancelledOrders,
      gmvResult,
      revenueResult,
      activeUsers,
    ] = await Promise.all([
      this.prisma.user.count({ where: { deletedAt: null } }),
      this.prisma.user.count({ where: { createdAt: dateFilter, deletedAt: null } }),
      this.prisma.order.count({ where: { createdAt: dateFilter, deletedAt: null } }),
      this.prisma.order.count({ where: { status: 'COMPLETED', completedAt: dateFilter, deletedAt: null } }),
      // AW-013: metrik status dikenali pada tanggal statusnya (bukan tanggal
      // pembuatan) agar konsisten dengan GMV/revenue berbasis completedAt.
      this.prisma.order.count({ where: { status: 'DISPUTED', disputedAt: dateFilter, deletedAt: null } }),
      this.prisma.order.count({ where: { status: 'CANCELLED', cancelledAt: dateFilter, deletedAt: null } }),
      this.prisma.order.aggregate({
        where: { status: 'COMPLETED', completedAt: dateFilter, deletedAt: null },
        _sum: { orderValue: true },
      }),
      this.prisma.order.aggregate({
        where: { status: 'COMPLETED', completedAt: dateFilter, deletedAt: null },
        _sum: { feeAmount: true },
      }),
      this.prisma.$queryRaw<[{ count: bigint }]>`
        SELECT COUNT(DISTINCT u) AS count FROM (
          SELECT o."buyerId" AS u
          FROM "orders" o
          INNER JOIN "users" bu ON bu."id" = o."buyerId"
          WHERE o."deletedAt" IS NULL
            AND bu."deletedAt" IS NULL
            AND o."createdAt" >= ${dateFilter?.gte ?? new Date('2000-01-01')}
            AND o."createdAt" <= ${dateFilter?.lte ?? new Date()}
          UNION
          SELECT o."sellerId" AS u
          FROM "orders" o
          INNER JOIN "users" su ON su."id" = o."sellerId"
          WHERE o."deletedAt" IS NULL
            AND su."deletedAt" IS NULL
            AND o."createdAt" >= ${dateFilter?.gte ?? new Date('2000-01-01')}
            AND o."createdAt" <= ${dateFilter?.lte ?? new Date()}
        ) sub
      `,
    ]);

    const gmv = toIdr(gmvResult._sum.orderValue ?? 0n);
    const revenue = toIdr(revenueResult._sum.feeAmount ?? 0n);
    const disputeRate = completedOrders + disputedOrders > 0
      ? Math.round((disputedOrders / (completedOrders + disputedOrders)) * 10000) / 100
      : 0;

    return {
      users: { total: totalUsers, new: newUsers },
      orders: {
        total: totalOrders,
        completed: completedOrders,
        disputed: disputedOrders,
        cancelled: cancelledOrders,
        disputeRate,
      },
      financial: { gmv, revenue },
      activeUsers: Number(activeUsers[0]?.count ?? 0),
    };
  }

  async getOrderStats(
    startDate?: Date,
    endDate?: Date,
    groupBy: 'day' | 'week' | 'month' = 'day',
  ): Promise<object[]> {
    this.assertDateRange(startDate, endDate);
    const start = startDate || new Date('2020-01-01');
    const end = endDate || new Date();

    // AW-013 — SATU definisi untuk semua endpoint analitik admin:
    // - metrik kreasi (total order dibuat) dibucket pada createdAt;
    // - metrik status dibucket pada tanggal statusnya:
    //   completed/GMV/revenue → completedAt (hanya order COMPLETED),
    //   disputed → disputedAt, cancelled → cancelledAt.
    // Sebelumnya semuanya dibucket createdAt sambil menghitung status SAAT INI,
    // sehingga order yang dibuat di luar rentang tapi selesai di dalam rentang
    // tidak pernah terhitung GMV-nya (dan sebaliknya).
    interface BucketRow {
      period: Date;
      kind: string;
      total_orders: number;
      gmv: bigint;
      revenue: bigint;
    }
    const trunc = groupBy === 'week' ? 'week' : groupBy === 'month' ? 'month' : 'day';
    const rows = await this.prisma.$queryRaw<BucketRow[]>`
      SELECT date_trunc(${trunc}, (m."metricDate" AT TIME ZONE 'Asia/Jakarta')) AS period,
        m.kind AS kind,
        COUNT(*)::int AS total_orders,
        COALESCE(SUM(m."orderValue"), 0)::bigint AS gmv,
        COALESCE(SUM(m."feeAmount"), 0)::bigint AS revenue
      FROM (
        SELECT "createdAt" AS "metricDate", 'total'::text AS kind,
          0::bigint AS "orderValue", 0::bigint AS "feeAmount"
        FROM "orders"
        WHERE "createdAt" >= ${start} AND "createdAt" <= ${end} AND "deletedAt" IS NULL
        UNION ALL
        SELECT "completedAt" AS "metricDate", 'completed'::text AS kind,
          "orderValue", "feeAmount"
        FROM "orders"
        WHERE status = 'COMPLETED'
          AND "completedAt" IS NOT NULL
          AND "completedAt" >= ${start} AND "completedAt" <= ${end}
          AND "deletedAt" IS NULL
        UNION ALL
        SELECT "disputedAt" AS "metricDate", 'disputed'::text AS kind,
          0::bigint AS "orderValue", 0::bigint AS "feeAmount"
        FROM "orders"
        WHERE status = 'DISPUTED'
          AND "disputedAt" IS NOT NULL
          AND "disputedAt" >= ${start} AND "disputedAt" <= ${end}
          AND "deletedAt" IS NULL
        UNION ALL
        SELECT "cancelledAt" AS "metricDate", 'cancelled'::text AS kind,
          0::bigint AS "orderValue", 0::bigint AS "feeAmount"
        FROM "orders"
        WHERE status = 'CANCELLED'
          AND "cancelledAt" IS NOT NULL
          AND "cancelledAt" >= ${start} AND "cancelledAt" <= ${end}
          AND "deletedAt" IS NULL
      ) m
      GROUP BY period, m.kind
      ORDER BY period ASC, m.kind ASC`;

    const buckets = new Map<string, { period: Date; totalOrders: number; completed: number; disputed: number; cancelled: number; gmv: bigint; revenue: bigint }>();
    for (const row of rows) {
      const key = new Date(row.period).toISOString();
      let b = buckets.get(key);
      if (!b) {
        b = { period: new Date(row.period), totalOrders: 0, completed: 0, disputed: 0, cancelled: 0, gmv: 0n, revenue: 0n };
        buckets.set(key, b);
      }
      const n = Number(row.total_orders);
      if (row.kind === 'total') b.totalOrders = n;
      else if (row.kind === 'completed') { b.completed = n; b.gmv = BigInt(row.gmv); b.revenue = BigInt(row.revenue); }
      else if (row.kind === 'disputed') b.disputed = n;
      else if (row.kind === 'cancelled') b.cancelled = n;
    }

    return [...buckets.values()].map((b) => ({
      period: b.period,
      totalOrders: b.totalOrders,
      completed: b.completed,
      disputed: b.disputed,
      cancelled: b.cancelled,
      gmv: toIdr(b.gmv),
      revenue: toIdr(b.revenue),
    }));
  }

  async getTopUsers(limit = 10, metric: 'orders' | 'volume' | 'rating' = 'orders'): Promise<object[]> {
    const orderBy = metric === 'orders'
      ? { totalOrdersCompleted: 'desc' as const }
      : metric === 'volume'
        ? { totalTransactionValue: 'desc' as const }
        : { averageRating: 'desc' as const };

    const safeLimit = Math.min(Math.max(1, Math.floor(limit)), 100);
    const users = await this.prisma.user.findMany({
      where: { deletedAt: null },
      orderBy,
      take: safeLimit,
      select: {
        userId: true,
        username: true,
        fullName: true,
        avatarUrl: true,
        membershipRank: true,
        averageRating: true,
        totalRatingCount: true,
        totalOrdersCompleted: true,
        totalTransactionValue: true,
        kycStatus: true,
      },
    });

    return users.map((user) => ({
      userId: user.userId,
      username: user.username,
      fullName: user.fullName,
      avatarUrl: user.avatarUrl,
      membershipRank: user.membershipRank,
      avgRating: user.averageRating,
      ratingCount: user.totalRatingCount,
      totalOrders: user.totalOrdersCompleted,
      totalVolume: toIdr(user.totalTransactionValue),
      isKycVerified: user.kycStatus === 'APPROVED',
    }));
  }

  async getUserGrowth(startDate?: Date, endDate?: Date): Promise<object[]> {
    this.assertDateRange(startDate, endDate);
    const start = startDate || new Date('2020-01-01');
    const end = endDate || new Date();

    // Unified timezone: Asia/Jakarta (WIB) — consistent with dashboard.service
    const results = await this.prisma.$queryRaw<UserGrowthRow[]>`
      SELECT (("createdAt" AT TIME ZONE 'Asia/Jakarta')::date) AS day,
        COUNT(*)::int AS new_users,
        SUM(COUNT(*)::int) OVER (ORDER BY (("createdAt" AT TIME ZONE 'Asia/Jakarta')::date))::int AS cumulative
      FROM "users"
      WHERE "createdAt" >= ${start}
        AND "createdAt" <= ${end}
        AND "deletedAt" IS NULL
      GROUP BY day
      ORDER BY day ASC`;

    return results.map((row: UserGrowthRow) => ({
      day: row.day,
      newUsers: Number(row.new_users),
      cumulative: Number(row.cumulative),
    }));
  }

  private assertDateRange(startDate?: Date, endDate?: Date): void {
    if (startDate && endDate && startDate.getTime() > endDate.getTime()) {
      throw new BadRequestException({ code: 'INVALID_DATE_RANGE', message: 'startDate must be before or equal to endDate' });
    }
  }

  private buildDateFilter(startDate?: Date, endDate?: Date): { gte?: Date; lte?: Date } | undefined {
    if (!startDate && !endDate) return undefined;
    const filter: { gte?: Date; lte?: Date } = {};
    if (startDate) filter.gte = startDate;
    if (endDate) filter.lte = endDate;
    return filter;
  }
}
