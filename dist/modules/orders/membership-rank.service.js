"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var MembershipRankService_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.MembershipRankService = void 0;
const common_1 = require("@nestjs/common");
const client_1 = require("@prisma/client");
const RANK_THRESHOLDS = [
    { rank: client_1.MembershipRank.DIAMOND, minOrders: 200 },
    { rank: client_1.MembershipRank.PLATINUM, minOrders: 100 },
    { rank: client_1.MembershipRank.GOLD, minOrders: 50 },
    { rank: client_1.MembershipRank.SILVER, minOrders: 20 },
    { rank: client_1.MembershipRank.BRONZE, minOrders: 0 },
];
const RANK_ORDER = {
    BRONZE: 0,
    SILVER: 1,
    GOLD: 2,
    PLATINUM: 3,
    DIAMOND: 4,
};
let MembershipRankService = MembershipRankService_1 = class MembershipRankService {
    constructor() {
        this.logger = new common_1.Logger(MembershipRankService_1.name);
    }
    async checkAndUpdateMembershipRank(tx, userId) {
        try {
            const user = await tx.user.findUnique({
                where: { id: userId },
                select: {
                    membershipRank: true,
                    totalOrdersCompleted: true,
                    totalTransactionValue: true,
                    createdAt: true,
                },
            });
            if (!user)
                return;
            const newRank = RANK_THRESHOLDS.find(t => user.totalOrdersCompleted >= t.minOrders)?.rank ?? client_1.MembershipRank.BRONZE;
            if (RANK_ORDER[newRank] > RANK_ORDER[user.membershipRank]) {
                const memberDays = Math.floor((Date.now() - user.createdAt.getTime()) / (1000 * 60 * 60 * 24));
                await tx.user.update({
                    where: { id: userId },
                    data: { membershipRank: newRank, rankUpdatedAt: new Date() },
                });
                const ratingAgg = await tx.rating.aggregate({
                    where: { receiverId: userId },
                    _avg: { stars: true },
                });
                await tx.membershipRankHistory.create({
                    data: {
                        userId,
                        fromRank: user.membershipRank,
                        toRank: newRank,
                        reason: `Reached ${user.totalOrdersCompleted} completed orders`,
                        totalOrders: user.totalOrdersCompleted,
                        totalValue: user.totalTransactionValue,
                        averageRating: ratingAgg._avg?.stars ?? 0,
                        memberDays,
                    },
                });
                this.logger.log(`User ${userId} ranked up: ${user.membershipRank} → ${newRank}`);
            }
        }
        catch (err) {
            if (err instanceof client_1.Prisma.PrismaClientKnownRequestError ||
                err instanceof client_1.Prisma.PrismaClientUnknownRequestError ||
                err instanceof client_1.Prisma.PrismaClientRustPanicError) {
                throw err;
            }
            this.logger.error(`Failed to update membership rank for user ${userId}: ${err.message}`);
        }
    }
};
exports.MembershipRankService = MembershipRankService;
exports.MembershipRankService = MembershipRankService = MembershipRankService_1 = __decorate([
    (0, common_1.Injectable)()
], MembershipRankService);
