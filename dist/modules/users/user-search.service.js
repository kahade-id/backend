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
exports.UserSearchService = void 0;
const common_1 = require("@nestjs/common");
const prisma_service_1 = require("../../prisma/prisma.service");
const app_constants_1 = require("../../common/constants/app.constants");
let UserSearchService = class UserSearchService {
    constructor(prisma) {
        this.prisma = prisma;
    }
    async searchUsers(query, filters, page, limit, viewerId) {
        const safePage = Math.max(1, page);
        const safeLimit = Math.min(Math.max(1, limit), app_constants_1.SEARCH_MAX_RESULTS);
        const skip = (safePage - 1) * safeLimit;
        const where = {
            isActive: true,
            isBanned: false,
            profileVisible: true,
            deletedAt: null,
        };
        if (viewerId) {
            const blocks = await this.prisma.blockList.findMany({
                where: { OR: [{ blockerId: viewerId }, { blockedId: viewerId }] },
                select: { blockerId: true, blockedId: true },
            });
            const blockedIds = new Set();
            for (const b of blocks) {
                if (b.blockerId !== viewerId)
                    blockedIds.add(b.blockerId);
                if (b.blockedId !== viewerId)
                    blockedIds.add(b.blockedId);
            }
            if (blockedIds.size > 0) {
                where.id = { notIn: Array.from(blockedIds) };
            }
        }
        if (query) {
            const sanitizedQuery = query.replace(/[<>&"']/g, '').trim();
            if (sanitizedQuery.length > 0) {
                const tsQuery = sanitizedQuery
                    .split(/\s+/)
                    .filter(w => w.length > 0)
                    .map(w => w.replace(/[^a-zA-Z0-9]/g, ''))
                    .filter(w => w.length > 0)
                    .join(' & ');
                if (tsQuery.length > 0) {
                    where.OR = [
                        { username: { contains: tsQuery, mode: 'insensitive' } },
                        { fullName: { contains: tsQuery, mode: 'insensitive' } },
                    ];
                }
                else {
                    where.OR = [
                        { username: { startsWith: sanitizedQuery.toLowerCase(), mode: 'insensitive' } },
                        { fullName: { startsWith: sanitizedQuery, mode: 'insensitive' } },
                    ];
                }
            }
        }
        if (filters.minRating !== undefined) {
            where.averageRating = { gte: filters.minRating };
        }
        if (filters.minTransactions !== undefined) {
            where.totalOrdersCompleted = { gte: filters.minTransactions };
        }
        if (filters.isKycVerified) {
            where.kycStatus = 'APPROVED';
        }
        if (filters.membershipRank) {
            where.membershipRank = filters.membershipRank;
        }
        const [users, total] = await Promise.all([
            this.prisma.user.findMany({
                where,
                orderBy: [{ totalOrdersCompleted: 'desc' }, { averageRating: 'desc' }],
                skip,
                take: safeLimit,
                select: {
                    userId: true,
                    username: true,
                    fullName: true,
                    avatarUrl: true,
                    bio: true,
                    membershipRank: true,
                    averageRating: true,
                    totalRatingCount: true,
                    totalOrdersCompleted: true,
                    kycStatus: true,
                    isVip: true,
                    createdAt: true,
                    _count: { select: { followers: true } },
                },
            }),
            this.prisma.user.count({ where }),
        ]);
        return {
            data: users.map(u => ({
                userId: u.userId,
                username: u.username,
                fullName: u.fullName,
                avatarUrl: u.avatarUrl,
                bio: u.bio,
                membershipRank: u.membershipRank,
                avgRating: u.averageRating,
                ratingCount: u.totalRatingCount,
                totalOrdersCompleted: u.totalOrdersCompleted,
                isKycVerified: u.kycStatus === 'APPROVED',
                isVip: u.isVip,
                followersCount: u._count.followers,
                memberSince: u.createdAt,
            })),
            total,
            page: safePage,
            limit: safeLimit,
            totalPages: Math.ceil(total / safeLimit),
        };
    }
};
exports.UserSearchService = UserSearchService;
exports.UserSearchService = UserSearchService = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [prisma_service_1.PrismaService])
], UserSearchService);
