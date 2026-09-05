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
var RatingsService_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.RatingsService = void 0;
const common_1 = require("@nestjs/common");
const client_1 = require("@prisma/client");
const prisma_service_1 = require("../../prisma/prisma.service");
const pagination_dto_1 = require("../../common/dto/pagination.dto");
const id_generator_util_1 = require("../../common/utils/id-generator.util");
const notification_category_map_1 = require("../notifications/notification-category.map");
const ErrorCodes = __importStar(require("../../common/constants/error-codes"));
const library_1 = require("@prisma/client/runtime/library");
const app_constants_1 = require("../../common/constants/app.constants");
let RatingsService = RatingsService_1 = class RatingsService {
    constructor(prisma) {
        this.prisma = prisma;
        this.logger = new common_1.Logger(RatingsService_1.name);
        this.RATING_WINDOW_DAYS = app_constants_1.RATING_WINDOW_DAYS;
        this.EDIT_WINDOW_DAYS = app_constants_1.RATING_EDIT_WINDOW_DAYS;
    }
    async createRating(userId, dto) {
        const order = await this.prisma.order.findFirst({
            where: { orderId: dto.orderId },
            include: {
                dispute: {
                    select: {
                        status: true,
                        decision: { select: { id: true } },
                        mutualProposals: { where: { status: 'ACCEPTED' }, select: { id: true }, take: 1 },
                    },
                },
            },
        });
        if (!order) {
            throw new common_1.NotFoundException({ code: ErrorCodes.ORDER_NOT_FOUND, message: 'Order not found' });
        }
        if (order.status !== 'COMPLETED') {
            throw new common_1.BadRequestException({ code: ErrorCodes.INVALID_ORDER_STATUS, message: 'Order must be completed to rate' });
        }
        const adminCompletion = await this.prisma.orderStatusHistory.findFirst({
            where: { orderId: order.id, toStatus: 'COMPLETED', changedByType: 'ADMIN' },
            select: { id: true },
        });
        const disputeResolvedByResolution = order.dispute?.status === 'RESOLVED'
            && Boolean(order.dispute.decision || order.dispute.mutualProposals.length > 0);
        const adminForceCompleted = Boolean(adminCompletion) && !disputeResolvedByResolution;
        if (adminForceCompleted) {
            throw new common_1.BadRequestException({ code: ErrorCodes.RATING_BLOCKED_FORCE_COMPLETED, message: 'Rating is not allowed on admin-force-completed orders' });
        }
        const isBuyer = order.buyerId === userId;
        const isSeller = order.sellerId === userId;
        if (!isBuyer && !isSeller) {
            throw new common_1.ForbiddenException({ code: ErrorCodes.NOT_ORDER_PARTICIPANT, message: 'You are not a participant of this order' });
        }
        const completedAt = order.completedAt;
        if (!completedAt) {
            throw new common_1.BadRequestException({ code: ErrorCodes.INVALID_ORDER_STATUS, message: 'Order completion timestamp is required to rate' });
        }
        const windowEnd = new Date(completedAt.getTime() + this.RATING_WINDOW_DAYS * 24 * 60 * 60 * 1000);
        if (new Date() > windowEnd) {
            throw new common_1.BadRequestException({ code: ErrorCodes.RATING_WINDOW_CLOSED, message: `Rating window has closed (${this.RATING_WINDOW_DAYS} days after completion)` });
        }
        const existingRating = await this.prisma.rating.findUnique({
            where: { orderId_giverId: { orderId: order.id, giverId: userId } },
        });
        if (existingRating) {
            throw new common_1.BadRequestException({ code: ErrorCodes.ALREADY_RATED, message: 'You have already rated this order' });
        }
        const receiverId = isBuyer ? order.sellerId : order.buyerId;
        const giverRole = isBuyer ? 'BUYER' : 'SELLER';
        const normalizedComment = dto.comment?.trim() || null;
        let rating;
        try {
            rating = await this.prisma.$transaction(async (tx) => {
                await tx.$queryRaw `SELECT id FROM users WHERE id = ${receiverId} FOR UPDATE`;
                const result = await tx.rating.create({
                    data: {
                        orderId: order.id,
                        giverId: userId,
                        receiverId,
                        stars: dto.stars,
                        comment: normalizedComment,
                        giverRole,
                    },
                });
                await this.updateReceiverStatsInTx(tx, receiverId);
                return result;
            }, { isolationLevel: client_1.Prisma.TransactionIsolationLevel.Serializable });
        }
        catch (err) {
            if (err instanceof client_1.Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
                throw new common_1.BadRequestException({ code: ErrorCodes.ALREADY_RATED, message: 'You have already rated this order' });
            }
            throw err;
        }
        const giver = await this.prisma.user.findUnique({ where: { id: userId }, select: { fullName: true, username: true } });
        const giverName = giver?.fullName || giver?.username || 'User';
        try {
            await this.prisma.notification.create({
                data: {
                    notifId: (0, id_generator_util_1.generateNotifId)(), userId: receiverId,
                    type: client_1.NotificationType.RATING_NEW, category: (0, notification_category_map_1.getCategoryForType)(client_1.NotificationType.RATING_NEW),
                    title: 'New Rating',
                    body: `${giverName} gave you a ${dto.stars}-star rating.${dto.comment ? ` "${dto.comment.slice(0, 60)}"` : ''}`,
                    isRead: false,
                },
            });
            this.prisma.emitNotificationCreated({ userId: receiverId, title: 'New Rating', body: `${giverName} gave a ${dto.stars}-star rating`, data: { type: 'RATING_NEW' } });
        }
        catch (notificationError) {
            this.logger.warn(`Rating notification failed after rating ${rating.id} was committed: ${notificationError instanceof Error ? notificationError.message : String(notificationError)}`);
        }
        return rating;
    }
    async getMyRatings(userId, page, limit) {
        const safePage = Math.max(1, Math.trunc(Number(page) || 1));
        const safeLimit = Math.min(100, Math.max(1, Math.trunc(Number(limit) || 20)));
        const skip = (safePage - 1) * safeLimit;
        const replyInclude = {
            reply: {
                where: { isHidden: false },
                select: { id: true, content: true, createdAt: true, replierId: true },
            },
        };
        const [given, givenCount] = await Promise.all([
            this.prisma.rating.findMany({
                where: { giverId: userId, isHidden: false },
                orderBy: { createdAt: 'desc' },
                skip,
                take: safeLimit,
                include: {
                    order: { select: { orderId: true, title: true } },
                    receiver: { select: { userId: true, fullName: true, username: true, avatarUrl: true } },
                    ...replyInclude,
                },
            }),
            this.prisma.rating.count({ where: { giverId: userId, isHidden: false } }),
        ]);
        const [received, receivedCount, receivedAggregate] = await Promise.all([
            this.prisma.rating.findMany({
                where: { receiverId: userId, isHidden: false },
                orderBy: { createdAt: 'desc' },
                skip,
                take: safeLimit,
                include: {
                    order: { select: { orderId: true, title: true } },
                    giver: { select: { userId: true, fullName: true, username: true, avatarUrl: true } },
                    ...replyInclude,
                },
            }),
            this.prisma.rating.count({ where: { receiverId: userId, isHidden: false } }),
            this.prisma.rating.aggregate({ where: { receiverId: userId, isHidden: false }, _avg: { stars: true }, _count: { stars: true } }),
        ]);
        const normalizeRating = (r) => {
            const { reply, ...rest } = r;
            return {
                ...rest,
                replies: reply ? [{ ...reply, userId: reply.replierId }] : [],
            };
        };
        return {
            given: (0, pagination_dto_1.createPaginatedResponse)(given.map(normalizeRating), givenCount, safePage, safeLimit),
            received: { ...(0, pagination_dto_1.createPaginatedResponse)(received.map(normalizeRating), receivedCount, safePage, safeLimit), averageRating: Number(receivedAggregate._avg.stars ?? 0), ratingCount: receivedAggregate._count.stars },
        };
    }
    async updateRating(userId, ratingId, dto) {
        if (dto.stars === undefined && dto.comment === undefined) {
            throw new common_1.BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Provide stars or a comment to update a rating' });
        }
        const rating = await this.prisma.rating.findUnique({
            where: { id: ratingId },
        });
        if (!rating) {
            throw new common_1.NotFoundException({ code: ErrorCodes.RATING_NOT_FOUND, message: 'Rating not found' });
        }
        if (rating.giverId !== userId) {
            throw new common_1.ForbiddenException({ code: ErrorCodes.NOT_RATING_GIVER, message: 'You can only edit your own ratings' });
        }
        if (rating.isHidden) {
            throw new common_1.NotFoundException({ code: ErrorCodes.RATING_NOT_FOUND, message: 'Rating not found' });
        }
        const editWindowEnd = new Date(rating.createdAt.getTime() + this.EDIT_WINDOW_DAYS * 24 * 60 * 60 * 1000);
        if (new Date() > editWindowEnd) {
            throw new common_1.BadRequestException({ code: ErrorCodes.RATING_WINDOW_CLOSED, message: `Edit window has closed (${this.EDIT_WINDOW_DAYS} days after rating)` });
        }
        const updated = await this.prisma.$transaction(async (tx) => {
            if (dto.stars !== undefined) {
                await tx.$queryRaw `SELECT id FROM users WHERE id = ${rating.receiverId} FOR UPDATE`;
            }
            const guarded = await tx.rating.updateMany({
                where: { id: ratingId, giverId: userId, isHidden: false, createdAt: { lte: editWindowEnd } },
                data: {
                    ...(dto.stars !== undefined && { stars: dto.stars }),
                    ...(dto.comment !== undefined && { comment: dto.comment.trim() || null }),
                },
            });
            if (guarded.count === 0) {
                throw new common_1.ConflictException({ code: ErrorCodes.INVALID_STATUS, message: 'Rating was moderated or its edit window closed; reload and try again' });
            }
            const result = await tx.rating.findUniqueOrThrow({ where: { id: ratingId } });
            if (dto.stars !== undefined)
                await this.updateReceiverStatsInTx(tx, rating.receiverId);
            return result;
        }, { isolationLevel: client_1.Prisma.TransactionIsolationLevel.Serializable });
        return updated;
    }
    async updateReceiverStatsInTx(tx, receiverId) {
        const stats = await tx.rating.aggregate({
            where: { receiverId, isHidden: false },
            _avg: { stars: true },
            _count: { stars: true },
        });
        await tx.user.update({
            where: { id: receiverId },
            data: {
                averageRating: new library_1.Decimal(stats._avg.stars ?? 0),
                totalRatingCount: stats._count.stars,
            },
        });
    }
};
exports.RatingsService = RatingsService;
exports.RatingsService = RatingsService = RatingsService_1 = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [prisma_service_1.PrismaService])
], RatingsService);
