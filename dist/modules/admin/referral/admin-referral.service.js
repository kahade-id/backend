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
exports.AdminReferralService = void 0;
const common_1 = require("@nestjs/common");
const prisma_service_1 = require("../../../prisma/prisma.service");
const pagination_dto_1 = require("../../../common/dto/pagination.dto");
const currency_util_1 = require("../../../common/utils/currency.util");
let AdminReferralService = class AdminReferralService {
    constructor(prisma) {
        this.prisma = prisma;
    }
    async getReferralStats() {
        const [totalCodes, activeCodes, totalRelations, totalRewards, pendingRewards] = await Promise.all([
            this.prisma.referralCode.count(),
            this.prisma.referralCode.count({ where: { isActive: true } }),
            this.prisma.referralRelation.count(),
            this.prisma.referralReward.count(),
            this.prisma.referralReward.count({ where: { isCredited: false } }),
        ]);
        const rewardAggregation = await this.prisma.referralReward.aggregate({
            _sum: {
                rewardAmount: true,
            },
            where: { isCredited: true },
        });
        return {
            totalCodes,
            activeCodes,
            totalRelations,
            totalRewards,
            pendingRewards,
            totalRewardsPaid: (0, currency_util_1.toIdr)(rewardAggregation._sum.rewardAmount ?? BigInt(0)),
        };
    }
    async listReferralCodes(page, limit, isActive) {
        const safePage = Math.max(1, Number.isFinite(page) ? Math.trunc(page) : 1);
        const safeLimit = Math.min(100, Math.max(1, Number.isFinite(limit) ? Math.trunc(limit) : 20));
        const skip = (safePage - 1) * safeLimit;
        const normalizedActive = typeof isActive === 'string' ? isActive.trim().toLowerCase() : undefined;
        const where = {};
        if (normalizedActive === 'true')
            where.isActive = true;
        if (normalizedActive === 'false')
            where.isActive = false;
        const [codes, total] = await Promise.all([
            this.prisma.referralCode.findMany({
                where,
                skip,
                take: safeLimit,
                orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
                include: {
                    user: {
                        select: {
                            id: true,
                            userId: true,
                            username: true,
                            fullName: true,
                            email: true,
                        },
                    },
                },
            }),
            this.prisma.referralCode.count({ where }),
        ]);
        const data = codes.map(c => ({
            ...c,
            totalRewardEarned: (0, currency_util_1.toIdr)(c.totalRewardEarned),
        }));
        return (0, pagination_dto_1.createPaginatedResponse)(data, total, safePage, safeLimit);
    }
};
exports.AdminReferralService = AdminReferralService;
exports.AdminReferralService = AdminReferralService = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [prisma_service_1.PrismaService])
], AdminReferralService);
