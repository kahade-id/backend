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
exports.BadgesService = void 0;
const common_1 = require("@nestjs/common");
const prisma_service_1 = require("../../prisma/prisma.service");
const pagination_dto_1 = require("../../common/dto/pagination.dto");
let BadgesService = class BadgesService {
    constructor(prisma) {
        this.prisma = prisma;
    }
    async listAllBadges(userId, page = 1, limit = 20) {
        const safePage = Math.max(1, Number.isFinite(page) ? Math.floor(page) : 1);
        const safeLimit = Math.min(100, Math.max(1, Number.isFinite(limit) ? Math.floor(limit) : 20));
        const skip = (safePage - 1) * safeLimit;
        const [badges, total] = await Promise.all([
            this.prisma.badge.findMany({
                orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
                skip,
                take: safeLimit,
                include: {
                    userBadges: {
                        where: { userId },
                        select: { earnedAt: true },
                        take: 1,
                    },
                },
            }),
            this.prisma.badge.count(),
        ]);
        const mapped = badges.map(({ userBadges, ...badge }) => ({
            ...badge,
            isOwned: userBadges.length > 0,
            earnedAt: userBadges[0]?.earnedAt ?? null,
        }));
        return (0, pagination_dto_1.createPaginatedResponse)(mapped, total, safePage, safeLimit);
    }
    async getMyBadges(userId, page = 1, limit = 50) {
        const safePage = Math.max(1, Number.isFinite(page) ? Math.floor(page) : 1);
        const safeLimit = Math.min(100, Math.max(1, Number.isFinite(limit) ? Math.floor(limit) : 50));
        const skip = (safePage - 1) * safeLimit;
        const [userBadges, total] = await Promise.all([
            this.prisma.userBadge.findMany({
                where: { userId },
                include: { badge: true },
                orderBy: [{ earnedAt: 'desc' }, { id: 'desc' }],
                skip,
                take: safeLimit,
            }),
            this.prisma.userBadge.count({ where: { userId } }),
        ]);
        const mapped = userBadges.map(ub => ({
            id: ub.id,
            earnedAt: ub.earnedAt,
            badge: ub.badge,
        }));
        return (0, pagination_dto_1.createPaginatedResponse)(mapped, total, safePage, safeLimit);
    }
};
exports.BadgesService = BadgesService;
exports.BadgesService = BadgesService = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [prisma_service_1.PrismaService])
], BadgesService);
