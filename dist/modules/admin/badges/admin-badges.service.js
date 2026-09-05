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
var AdminBadgesService_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.AdminBadgesService = void 0;
const common_1 = require("@nestjs/common");
const prisma_service_1 = require("../../../prisma/prisma.service");
const audit_log_service_1 = require("../../../common/services/audit-log.service");
const notification_queue_service_1 = require("../../queue/notification-queue.service");
const pagination_dto_1 = require("../../../common/dto/pagination.dto");
const client_1 = require("@prisma/client");
const ErrorCodes = __importStar(require("../../../common/constants/error-codes"));
let AdminBadgesService = AdminBadgesService_1 = class AdminBadgesService {
    constructor(prisma, auditLog, notificationQueue) {
        this.prisma = prisma;
        this.auditLog = auditLog;
        this.notificationQueue = notificationQueue;
        this.logger = new common_1.Logger(AdminBadgesService_1.name);
    }
    async listBadges(page, limit) {
        const safePage = Math.max(1, Number.isFinite(page) ? Math.floor(page) : 1);
        const safeLimit = Math.min(100, Math.max(1, Number.isFinite(limit) ? Math.floor(limit) : 20));
        const [badges, total] = await Promise.all([
            this.prisma.badge.findMany({
                orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
                skip: (safePage - 1) * safeLimit,
                take: safeLimit,
                include: {
                    _count: { select: { userBadges: true } },
                },
            }),
            this.prisma.badge.count(),
        ]);
        const data = badges.map((b) => ({
            ...b,
            awardedCount: b._count.userBadges,
            holderCount: b._count.userBadges,
        }));
        return (0, pagination_dto_1.createPaginatedResponse)(data, total, safePage, safeLimit);
    }
    async getBadgeDetail(badgeId) {
        const badge = await this.prisma.badge.findUnique({
            where: { id: badgeId },
            include: {
                _count: { select: { userBadges: true } },
                userBadges: {
                    orderBy: [{ earnedAt: 'desc' }, { id: 'desc' }],
                    take: 100,
                    include: {
                        user: {
                            select: { id: true, userId: true, username: true, fullName: true, avatarUrl: true },
                        },
                    },
                },
            },
        });
        if (!badge) {
            throw new common_1.NotFoundException({ code: ErrorCodes.BADGE_NOT_FOUND, message: 'Badge not found' });
        }
        const b = badge;
        const { userBadges, _count, ...rest } = b;
        return {
            ...rest,
            holderCount: _count.userBadges,
            awardedCount: _count.userBadges,
            holders: userBadges.map((ub) => ({
                id: ub.id,
                userId: ub.userId,
                awardedAt: ub.earnedAt,
                user: ub.user,
            })),
        };
    }
    async createBadge(adminId, dto, ipAddress) {
        let badge;
        try {
            badge = await this.prisma.badge.create({
                data: {
                    name: dto.name,
                    iconUrl: dto.iconUrl,
                    description: dto.description,
                },
            });
        }
        catch (error) {
            if (error instanceof client_1.Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
                throw new common_1.ConflictException({ code: ErrorCodes.BADGE_NAME_TAKEN, message: 'Badge name is already in use' });
            }
            throw error;
        }
        this.auditLog.logAdminAction({
            adminId,
            action: client_1.AuditAction.ADMIN_ACTION,
            targetType: 'Badge',
            targetId: badge.id,
            description: `Created badge "${dto.name}"`,
            ipAddress,
        });
        return badge;
    }
    async updateBadge(badgeId, dto, adminId, ipAddress) {
        const badge = await this.prisma.badge.findUnique({ where: { id: badgeId } });
        if (!badge) {
            throw new common_1.NotFoundException({ code: ErrorCodes.BADGE_NOT_FOUND, message: 'Badge not found' });
        }
        let updated;
        try {
            updated = await this.prisma.badge.update({
                where: { id: badgeId },
                data: {
                    ...(dto.name !== undefined && { name: dto.name }),
                    ...(dto.iconUrl !== undefined && { iconUrl: dto.iconUrl }),
                    ...(dto.description !== undefined && { description: dto.description }),
                },
            });
        }
        catch (error) {
            if (error instanceof client_1.Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
                throw new common_1.ConflictException({ code: ErrorCodes.BADGE_NAME_TAKEN, message: 'Badge name is already in use' });
            }
            throw error;
        }
        this.auditLog.logAdminAction({
            adminId,
            action: client_1.AuditAction.ADMIN_ACTION,
            targetType: 'Badge',
            targetId: badge.id,
            description: `Updated badge "${updated.name}"`,
            ipAddress,
        });
        return updated;
    }
    async deleteBadge(badgeId, adminId, ipAddress) {
        const badgeName = await this.prisma.$transaction(async (tx) => {
            const badge = await tx.badge.findUnique({ where: { id: badgeId } });
            if (!badge) {
                throw new common_1.NotFoundException({ code: ErrorCodes.BADGE_NOT_FOUND, message: 'Badge not found' });
            }
            const awardedCount = await tx.userBadge.count({ where: { badgeId } });
            if (awardedCount > 0) {
                throw new common_1.BadRequestException({
                    code: ErrorCodes.BADGE_HAS_AWARDS,
                    message: 'Badge cannot be deleted after it has been awarded. Revoke awards explicitly first.',
                });
            }
            await tx.badge.delete({ where: { id: badgeId } });
            return badge.name;
        }, { isolationLevel: client_1.Prisma.TransactionIsolationLevel.Serializable });
        this.auditLog.logAdminAction({
            adminId,
            action: client_1.AuditAction.ADMIN_ACTION,
            targetType: 'Badge',
            targetId: badgeId,
            description: `Deleted badge "${badgeName}"`,
            ipAddress,
        });
        return { message: 'Badge deleted successfully' };
    }
    async awardBadge(badgeId, userId, adminId, ipAddress) {
        const badge = await this.prisma.badge.findUnique({ where: { id: badgeId } });
        if (!badge) {
            throw new common_1.NotFoundException({ code: ErrorCodes.BADGE_NOT_FOUND, message: 'Badge not found' });
        }
        const user = await this.prisma.user.findUnique({ where: { id: userId } });
        if (!user) {
            throw new common_1.NotFoundException({ code: ErrorCodes.USER_NOT_FOUND, message: 'User not found' });
        }
        const existing = await this.prisma.userBadge.findUnique({
            where: { userId_badgeId: { userId, badgeId } },
        });
        if (existing) {
            throw new common_1.ConflictException({ code: ErrorCodes.BADGE_ALREADY_AWARDED, message: 'User already has this badge' });
        }
        let userBadge;
        try {
            userBadge = await this.prisma.userBadge.create({
                data: { userId, badgeId },
                include: { badge: true },
            });
        }
        catch (error) {
            if (error instanceof client_1.Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
                throw new common_1.ConflictException({ code: ErrorCodes.BADGE_ALREADY_AWARDED, message: 'User already has this badge' });
            }
            throw error;
        }
        this.auditLog.logAdminAction({
            adminId,
            action: client_1.AuditAction.BADGE_ASSIGNED,
            targetType: 'UserBadge',
            targetId: userBadge.id,
            description: `Awarded badge "${badge.name}" to user ${userId}`,
            ipAddress,
        });
        this.notificationQueue.enqueue({
            userId,
            type: client_1.NotificationType.BADGE_AWARDED,
            title: 'Badge Earned!',
            body: `Congratulations! You have earned the "${badge.name}" badge.`,
            pushData: { type: 'BADGE_AWARDED', badgeId },
            actionUrl: '/badges',
        }).catch((err) => this.logger.warn(`silent-catch: ${err instanceof Error ? err.message : String(err)}`));
        return userBadge;
    }
    async revokeBadge(badgeId, userId, adminId, ipAddress) {
        const userBadge = await this.prisma.$transaction(async (tx) => {
            const existing = await tx.userBadge.findUnique({
                where: { userId_badgeId: { userId, badgeId } },
                include: { badge: true },
            });
            if (!existing) {
                throw new common_1.NotFoundException({ code: ErrorCodes.USER_BADGE_NOT_FOUND, message: 'User does not have this badge' });
            }
            const deleted = await tx.userBadge.deleteMany({ where: { userId, badgeId } });
            if (deleted.count === 0) {
                throw new common_1.ConflictException({ code: ErrorCodes.OPTIMISTIC_LOCK_CONFLICT, message: 'Badge award changed concurrently — please retry' });
            }
            return existing;
        }, { isolationLevel: client_1.Prisma.TransactionIsolationLevel.Serializable });
        this.auditLog.logAdminAction({
            adminId,
            action: client_1.AuditAction.BADGE_REVOKED,
            targetType: 'UserBadge',
            targetId: userBadge.id,
            description: `Revoked badge "${userBadge.badge.name}" from user ${userId}`,
            ipAddress,
        });
        return { message: 'Badge revoked successfully' };
    }
};
exports.AdminBadgesService = AdminBadgesService;
exports.AdminBadgesService = AdminBadgesService = AdminBadgesService_1 = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [prisma_service_1.PrismaService,
        audit_log_service_1.AuditLogService,
        notification_queue_service_1.NotificationQueueService])
], AdminBadgesService);
