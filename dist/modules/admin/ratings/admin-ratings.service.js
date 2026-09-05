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
exports.AdminRatingsService = void 0;
const common_1 = require("@nestjs/common");
const prisma_service_1 = require("../../../prisma/prisma.service");
const audit_log_service_1 = require("../../../common/services/audit-log.service");
const pagination_dto_1 = require("../../../common/dto/pagination.dto");
const client_1 = require("@prisma/client");
const ErrorCodes = __importStar(require("../../../common/constants/error-codes"));
let AdminRatingsService = class AdminRatingsService {
    constructor(prisma, auditLog) {
        this.prisma = prisma;
        this.auditLog = auditLog;
    }
    async listRatings(page, limit, stars, flagged) {
        if (stars !== undefined && !['1', '2', '3', '4', '5'].includes(stars)) {
            throw new common_1.BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'stars must be between 1 and 5' });
        }
        if (flagged !== undefined && flagged !== 'true' && flagged !== 'false') {
            throw new common_1.BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'flagged must be true or false' });
        }
        const safePage = Number.isFinite(page) ? Math.max(1, Math.floor(page)) : 1;
        const safeLimit = Number.isFinite(limit) ? Math.min(100, Math.max(1, Math.floor(limit))) : 20;
        const skip = (safePage - 1) * safeLimit;
        const where = {};
        if (stars) {
            const parsed = parseInt(stars, 10);
            if (!isNaN(parsed) && parsed >= 1 && parsed <= 5) {
                where.stars = parsed;
            }
        }
        if (flagged === 'true') {
            where.isHidden = true;
        }
        if (flagged === 'false') {
            where.isHidden = false;
        }
        const [ratings, total] = await Promise.all([
            this.prisma.rating.findMany({
                where,
                skip,
                take: safeLimit,
                orderBy: { createdAt: 'desc' },
                include: {
                    giver: {
                        select: {
                            id: true,
                            userId: true,
                            username: true,
                            fullName: true,
                        },
                    },
                    receiver: {
                        select: {
                            id: true,
                            userId: true,
                            username: true,
                            fullName: true,
                        },
                    },
                    order: {
                        select: {
                            id: true,
                            orderId: true,
                        },
                    },
                },
            }),
            this.prisma.rating.count({ where }),
        ]);
        return (0, pagination_dto_1.createPaginatedResponse)(ratings, total, safePage, safeLimit);
    }
    async removeRating(ratingId, adminId, ipAddress, reason) {
        if (!reason || reason.trim().length === 0) {
            throw new common_1.BadRequestException({
                code: ErrorCodes.VALIDATION_ERROR,
                message: 'A reason is required when modifying ratings',
            });
        }
        const rating = await this.prisma.rating.findUnique({
            where: { id: ratingId },
        });
        if (!rating) {
            throw new common_1.NotFoundException({
                code: ErrorCodes.RATING_NOT_FOUND,
                message: 'Rating not found',
            });
        }
        const updated = await this.prisma.$transaction(async (tx) => {
            await tx.$queryRaw `SELECT id FROM users WHERE id = ${rating.receiverId} FOR UPDATE`;
            const result = await tx.rating.updateMany({
                where: { id: ratingId, isHidden: false },
                data: { isHidden: true, hiddenAt: new Date(), hiddenBy: adminId },
            });
            if (result.count === 0)
                throw new common_1.ConflictException({ code: ErrorCodes.INVALID_STATUS, message: 'Rating state changed; reload and retry' });
            await this.recalcReceiverStats(tx, rating.receiverId);
            return { id: ratingId };
        }, { isolationLevel: client_1.Prisma.TransactionIsolationLevel.Serializable });
        await this.auditLog.logAdminAction({
            adminId,
            action: client_1.AuditAction.ADMIN_ACTION,
            targetType: 'Rating',
            targetId: ratingId,
            description: `Removed rating ${ratingId}${reason ? ': ' + reason : ''}`,
            ipAddress,
        });
        return {
            message: 'Rating removed successfully',
            ratingId: updated.id,
        };
    }
    async unhideRating(ratingId, adminId, ipAddress, reason) {
        if (!reason || reason.trim().length === 0) {
            throw new common_1.BadRequestException({
                code: ErrorCodes.VALIDATION_ERROR,
                message: 'A reason is required when modifying ratings',
            });
        }
        const rating = await this.prisma.rating.findUnique({
            where: { id: ratingId },
        });
        if (!rating) {
            throw new common_1.NotFoundException({
                code: ErrorCodes.RATING_NOT_FOUND,
                message: 'Rating not found',
            });
        }
        const updated = await this.prisma.$transaction(async (tx) => {
            await tx.$queryRaw `SELECT id FROM users WHERE id = ${rating.receiverId} FOR UPDATE`;
            const result = await tx.rating.updateMany({
                where: { id: ratingId, isHidden: true },
                data: { isHidden: false, hiddenAt: null, hiddenBy: null },
            });
            if (result.count === 0)
                throw new common_1.ConflictException({ code: ErrorCodes.INVALID_STATUS, message: 'Rating state changed; reload and retry' });
            await this.recalcReceiverStats(tx, rating.receiverId);
            return { id: ratingId };
        }, { isolationLevel: client_1.Prisma.TransactionIsolationLevel.Serializable });
        await this.auditLog.logAdminAction({
            adminId,
            action: client_1.AuditAction.ADMIN_ACTION,
            targetType: 'Rating',
            targetId: ratingId,
            description: `Unhid rating ${ratingId}${reason ? ': ' + reason : ''}`,
            ipAddress,
        });
        return {
            message: 'Rating unhidden successfully',
            ratingId: updated.id,
        };
    }
    async recalcReceiverStats(tx, receiverId) {
        const visibleRatings = await tx.rating.aggregate({
            where: { receiverId, isHidden: false },
            _avg: { stars: true },
            _count: { stars: true },
        });
        await tx.user.update({
            where: { id: receiverId },
            data: {
                averageRating: visibleRatings._avg.stars ?? 0,
                totalRatingCount: visibleRatings._count.stars,
            },
        });
    }
};
exports.AdminRatingsService = AdminRatingsService;
exports.AdminRatingsService = AdminRatingsService = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [prisma_service_1.PrismaService,
        audit_log_service_1.AuditLogService])
], AdminRatingsService);
