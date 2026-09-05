"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.UserAnalyticsService = void 0;
const common_1 = require("@nestjs/common");
const prisma_service_1 = require("../../prisma/prisma.service");
const ErrorCodes = __importStar(require("../../common/constants/error-codes"));
const currency_util_1 = require("../../common/utils/currency.util");
const date_util_1 = require("../../common/utils/date.util");
let UserAnalyticsService = class UserAnalyticsService {
    constructor(prisma) {
        this.prisma = prisma;
    }
    async getUserAnalytics(userId, period = '30d') {
        const user = await this.prisma.user.findUnique({
            where: { id: userId },
            select: {
                totalOrdersCompleted: true, totalOrdersAsBuyer: true, totalOrdersAsSeller: true,
                totalOrdersCancelled: true, totalOrdersDisputed: true, totalTransactionValue: true,
                averageRating: true, totalRatingCount: true, membershipRank: true, memberSince: true,
                kycStatus: true, isKahadePlus: true, createdAt: true,
            },
        });
        if (!user)
            throw new common_1.NotFoundException({ code: ErrorCodes.USER_NOT_FOUND, message: 'User not found' });
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
        const completedInPeriod = ordersInPeriod.filter((o) => o.status === 'COMPLETED').length;
        const cancelledInPeriod = ordersInPeriod.filter((o) => o.status === 'CANCELLED').length;
        const disputedInPeriod = ordersInPeriod.filter((o) => o.status === 'DISPUTED').length;
        const volumeInPeriod = ordersInPeriod
            .filter((o) => o.status === 'COMPLETED')
            .reduce((sum, o) => sum + (0, currency_util_1.toIdr)(o.orderValue), 0);
        const asBuyerInPeriod = ordersInPeriod.filter((o) => o.buyerId === userId).length;
        const asSellerInPeriod = ordersInPeriod.filter((o) => o.sellerId === userId).length;
        const topups = walletTxInPeriod.filter((t) => t.type === 'TOP_UP').reduce((s, t) => s + (0, currency_util_1.toIdr)(t.amount), 0);
        const withdrawals = walletTxInPeriod.filter((t) => t.type === 'WITHDRAW').reduce((s, t) => s + (0, currency_util_1.toIdr)(t.amount), 0);
        const ordersByDay = {};
        ordersInPeriod.forEach((o) => {
            const day = (0, date_util_1.formatWIBDate)(o.createdAt);
            ordersByDay[day] = (ordersByDay[day] || 0) + 1;
        });
        const ratingTrend = ratingsInPeriod.map((r) => ({
            date: (0, date_util_1.formatWIBDate)(r.createdAt),
            stars: r.stars,
        }));
        return {
            overview: {
                totalOrders: user.totalOrdersAsBuyer + user.totalOrdersAsSeller,
                totalCompleted: user.totalOrdersCompleted,
                totalCancelled: user.totalOrdersCancelled,
                totalDisputed: user.totalOrdersDisputed,
                totalVolume: (0, currency_util_1.toIdr)(user.totalTransactionValue),
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
                volume: (0, currency_util_1.toIdr)(monthlyVolume._sum?.orderValue ?? BigInt(0)),
            },
        };
    }
    calculateTrustScore(user) {
        let score = 0;
        if (user.kycStatus === 'APPROVED')
            score += 20;
        if (user.isKahadePlus)
            score += 5;
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
        if (completedOrders >= 50)
            score += 15;
        else if (completedOrders >= 20)
            score += 10;
        else if (completedOrders >= 5)
            score += 5;
        const accountAgeDays = (Date.now() - user.createdAt.getTime()) / (1000 * 60 * 60 * 24);
        if (accountAgeDays >= 365)
            score += 10;
        else if (accountAgeDays >= 180)
            score += 7;
        else if (accountAgeDays >= 30)
            score += 3;
        return Math.min(100, Math.max(0, score));
    }
    getTrustBadge(score) {
        if (score >= 90)
            return { label: 'Sangat Terpercaya', labelEn: 'Highly Trusted', color: 'emerald' };
        if (score >= 70)
            return { label: 'Terpercaya', labelEn: 'Trusted', color: 'blue' };
        if (score >= 50)
            return { label: 'Cukup Baik', labelEn: 'Good', color: 'yellow' };
        if (score >= 30)
            return { label: 'Baru', labelEn: 'New', color: 'gray' };
        return { label: 'Belum Terverifikasi', labelEn: 'Unverified', color: 'red' };
    }
};
exports.UserAnalyticsService = UserAnalyticsService;
exports.UserAnalyticsService = UserAnalyticsService = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [prisma_service_1.PrismaService])
], UserAnalyticsService);
