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
exports.DashboardService = void 0;
const common_1 = require("@nestjs/common");
const client_1 = require("@prisma/client");
const prisma_service_1 = require("../../../prisma/prisma.service");
const redis_service_1 = require("../../../redis/redis.service");
const date_util_1 = require("../../../common/utils/date.util");
const currency_util_1 = require("../../../common/utils/currency.util");
const DASHBOARD_SUMMARY_CACHE_KEY = 'dashboard:summary_v2';
const DASHBOARD_SUMMARY_TTL = 300;
let DashboardService = class DashboardService {
    constructor(prisma, redis) {
        this.prisma = prisma;
        this.redis = redis;
    }
    async getSummary() {
        const cached = await this.redis.get(DASHBOARD_SUMMARY_CACHE_KEY);
        if (cached) {
            try {
                return JSON.parse(cached);
            }
            catch {
                await this.redis.del(DASHBOARD_SUMMARY_CACHE_KEY);
            }
        }
        const today = (0, date_util_1.startOfDayWIB)();
        const [totalUsers, newUsersToday, verifiedUsers, totalOrders, activeOrders, completedOrders, openDisputes, pendingKyc, totalWalletBalance,] = await Promise.all([
            this.prisma.user.count({ where: { deletedAt: null } }),
            this.prisma.user.count({ where: { deletedAt: null, createdAt: { gte: today } } }),
            this.prisma.user.count({ where: { deletedAt: null, kycStatus: 'APPROVED' } }),
            this.prisma.order.count(),
            this.prisma.order.count({
                where: {
                    status: {
                        in: [
                            client_1.OrderStatus.WAITING_PAYMENT,
                            client_1.OrderStatus.PROCESSING,
                            client_1.OrderStatus.IN_DELIVERY,
                        ],
                    },
                },
            }),
            this.prisma.order.count({ where: { status: client_1.OrderStatus.COMPLETED } }),
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
                totalWalletBalance: (0, currency_util_1.toIdr)(totalWalletBalance._sum.totalBalance ?? BigInt(0)),
            },
        };
        await this.redis.setex(DASHBOARD_SUMMARY_CACHE_KEY, DASHBOARD_SUMMARY_TTL, JSON.stringify(result));
        return result;
    }
    getPeriodStartDate(period = '30d') {
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
    getDateRange(query) {
        const period = query.period ?? '30d';
        const startDate = query.startDate
            ? (0, date_util_1.parseDateBoundaryWIB)(query.startDate, 'start')
            : this.getPeriodStartDate(period);
        const endDate = query.endDate ? (0, date_util_1.parseDateBoundaryWIB)(query.endDate, 'end') : undefined;
        if (!startDate || (query.endDate && !endDate) || (endDate && endDate < startDate)) {
            throw new common_1.BadRequestException({ code: 'INVALID_DATE_RANGE', message: 'Invalid dashboard date range' });
        }
        return { period, startDate, endDate };
    }
    async getCharts(query) {
        const { period, startDate, endDate } = this.getDateRange(query);
        const endDateFilter = endDate
            ? client_1.Prisma.sql ` AND "createdAt" <= ${endDate}`
            : client_1.Prisma.empty;
        const [ordersByDay, revenueByDay] = await Promise.all([
            this.prisma.$queryRaw `
        SELECT ("createdAt" AT TIME ZONE 'Asia/Jakarta')::date::text as day, COUNT(*)::bigint as count
        FROM orders
        WHERE "createdAt" >= ${startDate}${endDateFilter}
        GROUP BY ("createdAt" AT TIME ZONE 'Asia/Jakarta')::date
        ORDER BY day ASC
      `,
            this.prisma.$queryRaw `
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
                revenue: (0, currency_util_1.toIdr)(revenueMap.get(date) ?? BigInt(0)),
            })),
        };
    }
    async getRecentActivity() {
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
    async getUserGrowth(query) {
        const { period, startDate, endDate } = this.getDateRange(query);
        const endDateFilter = endDate
            ? client_1.Prisma.sql ` AND "createdAt" <= ${endDate}`
            : client_1.Prisma.empty;
        const usersByDay = await this.prisma.$queryRaw `
      SELECT ("createdAt" AT TIME ZONE 'Asia/Jakarta')::date::text as day, COUNT(*)::bigint as count
      FROM users
      WHERE "createdAt" >= ${startDate}${endDateFilter} AND "deletedAt" IS NULL
      GROUP BY ("createdAt" AT TIME ZONE 'Asia/Jakarta')::date
      ORDER BY day ASC
    `;
        const baseCountResult = await this.prisma.$queryRaw `
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
    async getOrderStats() {
        const grouped = await this.prisma.order.groupBy({
            by: ['status'],
            _count: { id: true },
        });
        const countMap = new Map();
        let total = 0;
        for (const g of grouped) {
            countMap.set(g.status, g._count.id);
            total += g._count.id;
        }
        const statuses = Object.values(client_1.OrderStatus);
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
};
exports.DashboardService = DashboardService;
exports.DashboardService = DashboardService = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [prisma_service_1.PrismaService,
        redis_service_1.RedisService])
], DashboardService);
