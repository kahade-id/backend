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
exports.UserStatsService = void 0;
const common_1 = require("@nestjs/common");
const prisma_service_1 = require("../../prisma/prisma.service");
const ErrorCodes = __importStar(require("../../common/constants/error-codes"));
const currency_util_1 = require("../../common/utils/currency.util");
let UserStatsService = class UserStatsService {
    constructor(prisma) {
        this.prisma = prisma;
    }
    async getDashboardStats(userId) {
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
        if (!user)
            throw new common_1.NotFoundException({ code: ErrorCodes.USER_NOT_FOUND, message: 'User not found' });
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
                totalTransactionValue: (0, currency_util_1.toIdr)(user.totalTransactionValue),
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
};
exports.UserStatsService = UserStatsService;
exports.UserStatsService = UserStatsService = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [prisma_service_1.PrismaService])
], UserStatsService);
