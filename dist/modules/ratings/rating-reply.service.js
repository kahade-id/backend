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
var RatingReplyService_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.RatingReplyService = void 0;
const common_1 = require("@nestjs/common");
const client_1 = require("@prisma/client");
const prisma_service_1 = require("../../prisma/prisma.service");
const id_generator_util_1 = require("../../common/utils/id-generator.util");
const notification_category_map_1 = require("../notifications/notification-category.map");
const ErrorCodes = __importStar(require("../../common/constants/error-codes"));
let RatingReplyService = RatingReplyService_1 = class RatingReplyService {
    constructor(prisma) {
        this.prisma = prisma;
        this.logger = new common_1.Logger(RatingReplyService_1.name);
        this.REPLY_EDIT_WINDOW_DAYS = 7;
    }
    async createReply(userId, ratingId, content) {
        const normalizedContent = content.trim();
        if (!normalizedContent) {
            throw new common_1.BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Reply content cannot be blank' });
        }
        const rating = await this.prisma.rating.findUnique({
            where: { id: ratingId },
            include: { reply: true },
        });
        if (!rating || rating.isHidden)
            throw new common_1.NotFoundException({ code: ErrorCodes.RATING_NOT_FOUND, message: 'Rating not found' });
        if (rating.receiverId !== userId)
            throw new common_1.ForbiddenException({ code: ErrorCodes.NOT_RATING_RECEIVER, message: 'Only the rating receiver can reply' });
        if (rating.reply)
            throw new common_1.BadRequestException({ code: ErrorCodes.REPLY_ALREADY_EXISTS, message: 'Reply already exists for this rating' });
        let reply;
        try {
            reply = await this.prisma.ratingReply.create({
                data: {
                    ratingId,
                    replierId: userId,
                    content: normalizedContent,
                },
            });
        }
        catch (err) {
            if (err instanceof client_1.Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
                throw new common_1.BadRequestException({
                    code: ErrorCodes.REPLY_ALREADY_EXISTS,
                    message: 'Reply already exists for this rating',
                });
            }
            throw err;
        }
        this.sendReplyNotification(userId, rating.giverId, normalizedContent).catch((err) => this.logger.warn(`silent-catch: ${err instanceof Error ? err.message : String(err)}`));
        return {
            id: reply.id,
            content: reply.content,
            createdAt: reply.createdAt,
            userId: reply.replierId,
            replierId: reply.replierId,
        };
    }
    async updateReply(userId, replyId, content) {
        const normalizedContent = content.trim();
        if (!normalizedContent) {
            throw new common_1.BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Reply content cannot be blank' });
        }
        const reply = await this.prisma.ratingReply.findUnique({ where: { id: replyId }, include: { rating: { select: { isHidden: true } } } });
        if (!reply || reply.rating?.isHidden)
            throw new common_1.NotFoundException({ code: ErrorCodes.RATING_NOT_FOUND, message: 'Reply not found' });
        if (reply.replierId !== userId)
            throw new common_1.ForbiddenException({ code: ErrorCodes.FORBIDDEN, message: 'Not your reply' });
        const editDeadline = new Date(reply.createdAt.getTime() + this.REPLY_EDIT_WINDOW_DAYS * 24 * 60 * 60 * 1000);
        if (new Date() > editDeadline) {
            throw new common_1.BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: `Reply can only be edited within ${this.REPLY_EDIT_WINDOW_DAYS} days of posting` });
        }
        const result = await this.prisma.ratingReply.updateMany({
            where: { id: replyId, replierId: userId, isHidden: false, createdAt: { lte: editDeadline } },
            data: { content: normalizedContent },
        });
        if (result.count === 0) {
            throw new common_1.BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Reply was moderated or its edit window closed; reload and try again' });
        }
        const updated = await this.prisma.ratingReply.findUniqueOrThrow({ where: { id: replyId } });
        return {
            id: updated.id,
            content: updated.content,
            updatedAt: updated.updatedAt,
            userId: updated.replierId,
            replierId: updated.replierId,
        };
    }
    async deleteReply(userId, replyId) {
        const reply = await this.prisma.ratingReply.findUnique({ where: { id: replyId }, include: { rating: { select: { isHidden: true } } } });
        if (!reply || reply.rating?.isHidden)
            throw new common_1.NotFoundException({ code: ErrorCodes.RATING_NOT_FOUND, message: 'Reply not found' });
        if (reply.replierId !== userId)
            throw new common_1.ForbiddenException({ code: ErrorCodes.FORBIDDEN, message: 'Not your reply' });
        const deleteDeadline = new Date(reply.createdAt.getTime() + this.REPLY_EDIT_WINDOW_DAYS * 24 * 60 * 60 * 1000);
        if (new Date() > deleteDeadline) {
            throw new common_1.BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: `Reply can only be deleted within ${this.REPLY_EDIT_WINDOW_DAYS} days of posting` });
        }
        const result = await this.prisma.ratingReply.deleteMany({
            where: { id: replyId, replierId: userId, isHidden: false, createdAt: { lte: deleteDeadline } },
        });
        if (result.count === 0) {
            throw new common_1.BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Reply was moderated, already deleted, or its delete window closed; reload and try again' });
        }
        return { message: 'Reply deleted' };
    }
    async sendReplyNotification(replierId, giverId, content) {
        const replier = await this.prisma.user.findUnique({ where: { id: replierId }, select: { fullName: true, username: true } });
        const replierName = replier?.fullName || replier?.username || 'User';
        await this.prisma.notification.create({
            data: {
                notifId: (0, id_generator_util_1.generateNotifId)(),
                userId: giverId,
                type: client_1.NotificationType.RATING_NEW,
                category: (0, notification_category_map_1.getCategoryForType)(client_1.NotificationType.RATING_NEW),
                title: 'New Reply to Your Rating',
                body: `${replierName} replied to your rating: "${content.slice(0, 60)}"`,
                isRead: false,
            },
        });
        this.prisma.emitNotificationCreated({
            userId: giverId,
            title: 'New Reply to Your Rating',
            body: `${replierName} replied to your rating`,
            data: { type: 'RATING_NEW' },
        });
    }
};
exports.RatingReplyService = RatingReplyService;
exports.RatingReplyService = RatingReplyService = RatingReplyService_1 = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [prisma_service_1.PrismaService])
], RatingReplyService);
