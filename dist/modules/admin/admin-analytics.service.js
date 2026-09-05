"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.AdminAnalyticsService = void 0;
const common_1 = require("@nestjs/common");
const prisma_service_1 = require("../../prisma/prisma.service");
const currency_util_1 = require("../../common/utils/currency.util");
let AdminAnalyticsService = class AdminAnalyticsService {
    constructor(prisma) {
        this.prisma = prisma;
    }
    async getOverview(startDate, endDate) {
        this.assertDateRange(startDate, endDate);
        const dateFilter = this.buildDateFilter(startDate, endDate);
        const [totalUsers, newUsers, totalOrders, completedOrders, disputedOrders, cancelledOrders, gmvResult, revenueResult, activeUsers,] = await Promise.all([
            this.prisma.user.count({ where: { deletedAt: null } }),
            this.prisma.user.count({ where: { createdAt: dateFilter, deletedAt: null } }),
            this.prisma.order.count({ where: { createdAt: dateFilter, deletedAt: null } }),
            this.prisma.order.count({ where: { status: 'COMPLETED', completedAt: dateFilter, deletedAt: null } }),
            this.prisma.order.count({ where: { status: 'DISPUTED', createdAt: dateFilter, deletedAt: null } }),
            this.prisma.order.count({ where: { status: 'CANCELLED', createdAt: dateFilter, deletedAt: null } }),
            this.prisma.order.aggregate({
                where: { status: 'COMPLETED', completedAt: dateFilter, deletedAt: null },
                _sum: { orderValue: true },
            }),
            this.prisma.order.aggregate({
                where: { status: 'COMPLETED', completedAt: dateFilter, deletedAt: null },
                _sum: { feeAmount: true },
            }),
            this.prisma.$queryRaw `
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
        const gmv = (0, currency_util_1.toIdr)(gmvResult._sum.orderValue ?? 0n);
        const revenue = (0, currency_util_1.toIdr)(revenueResult._sum.feeAmount ?? 0n);
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
    async getOrderStats(startDate, endDate, groupBy = 'day') {
        this.assertDateRange(startDate, endDate);
        const start = startDate || new Date('2020-01-01');
        const end = endDate || new Date();
        const queryByTrunc = (trunc) => {
            switch (trunc) {
                case 'week':
                    return this.prisma.$queryRaw `
            SELECT date_trunc('week', "createdAt") AS period,
              COUNT(*)::int AS total_orders,
              COUNT(*) FILTER (WHERE status = 'COMPLETED')::int AS completed,
              COUNT(*) FILTER (WHERE status = 'DISPUTED')::int AS disputed,
              COUNT(*) FILTER (WHERE status = 'CANCELLED')::int AS cancelled,
              COALESCE(SUM("orderValue") FILTER (WHERE status = 'COMPLETED'), 0)::bigint AS gmv,
              COALESCE(SUM("feeAmount") FILTER (WHERE status = 'COMPLETED'), 0)::bigint AS revenue
            FROM "orders"
            WHERE "createdAt" >= ${start}
              AND "createdAt" <= ${end}
              AND "deletedAt" IS NULL
            GROUP BY period ORDER BY period ASC`;
                case 'month':
                    return this.prisma.$queryRaw `
            SELECT date_trunc('month', "createdAt") AS period,
              COUNT(*)::int AS total_orders,
              COUNT(*) FILTER (WHERE status = 'COMPLETED')::int AS completed,
              COUNT(*) FILTER (WHERE status = 'DISPUTED')::int AS disputed,
              COUNT(*) FILTER (WHERE status = 'CANCELLED')::int AS cancelled,
              COALESCE(SUM("orderValue") FILTER (WHERE status = 'COMPLETED'), 0)::bigint AS gmv,
              COALESCE(SUM("feeAmount") FILTER (WHERE status = 'COMPLETED'), 0)::bigint AS revenue
            FROM "orders"
            WHERE "createdAt" >= ${start}
              AND "createdAt" <= ${end}
              AND "deletedAt" IS NULL
            GROUP BY period ORDER BY period ASC`;
                default:
                    return this.prisma.$queryRaw `
            SELECT date_trunc('day', "createdAt") AS period,
              COUNT(*)::int AS total_orders,
              COUNT(*) FILTER (WHERE status = 'COMPLETED')::int AS completed,
              COUNT(*) FILTER (WHERE status = 'DISPUTED')::int AS disputed,
              COUNT(*) FILTER (WHERE status = 'CANCELLED')::int AS cancelled,
              COALESCE(SUM("orderValue") FILTER (WHERE status = 'COMPLETED'), 0)::bigint AS gmv,
              COALESCE(SUM("feeAmount") FILTER (WHERE status = 'COMPLETED'), 0)::bigint AS revenue
            FROM "orders"
            WHERE "createdAt" >= ${start}
              AND "createdAt" <= ${end}
              AND "deletedAt" IS NULL
            GROUP BY period ORDER BY period ASC`;
            }
        };
        const results = await queryByTrunc(groupBy);
        return results.map((row) => ({
            period: row.period,
            totalOrders: Number(row.total_orders),
            completed: Number(row.completed),
            disputed: Number(row.disputed),
            cancelled: Number(row.cancelled),
            gmv: (0, currency_util_1.toIdr)(BigInt(row.gmv)),
            revenue: (0, currency_util_1.toIdr)(BigInt(row.revenue)),
        }));
    }
    async getTopUsers(limit = 10, metric = 'orders') {
        const orderBy = metric === 'orders'
            ? { totalOrdersCompleted: 'desc' }
            : metric === 'volume'
                ? { totalTransactionValue: 'desc' }
                : { averageRating: 'desc' };
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
            totalVolume: (0, currency_util_1.toIdr)(user.totalTransactionValue),
            isKycVerified: user.kycStatus === 'APPROVED',
        }));
    }
    async getUserGrowth(startDate, endDate) {
        this.assertDateRange(startDate, endDate);
        const start = startDate || new Date('2020-01-01');
        const end = endDate || new Date();
        const results = await this.prisma.$queryRaw `
      SELECT date_trunc('day', "createdAt") AS day,
        COUNT(*)::int AS new_users,
        SUM(COUNT(*)::int) OVER (ORDER BY date_trunc('day', "createdAt"))::int AS cumulative
      FROM "users"
      WHERE "createdAt" >= ${start}
        AND "createdAt" <= ${end}
        AND "deletedAt" IS NULL
      GROUP BY day
      ORDER BY day ASC`;
        return results.map((row) => ({
            day: row.day,
            newUsers: Number(row.new_users),
            cumulative: Number(row.cumulative),
        }));
    }
    assertDateRange(startDate, endDate) {
        if (startDate && endDate && startDate.getTime() > endDate.getTime()) {
            throw new common_1.BadRequestException({ code: 'INVALID_DATE_RANGE', message: 'startDate must be before or equal to endDate' });
        }
    }
    buildDateFilter(startDate, endDate) {
        if (!startDate && !endDate)
            return undefined;
        const filter = {};
        if (startDate)
            filter.gte = startDate;
        if (endDate)
            filter.lte = endDate;
        return filter;
    }
};
exports.AdminAnalyticsService = AdminAnalyticsService;
exports.AdminAnalyticsService = AdminAnalyticsService = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [prisma_service_1.PrismaService])
], AdminAnalyticsService);
