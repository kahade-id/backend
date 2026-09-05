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
var DisputeMessageService_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.DisputeMessageService = void 0;
const common_1 = require("@nestjs/common");
const prisma_service_1 = require("../../prisma/prisma.service");
const realtime_service_1 = require("../realtime/realtime.service");
const upload_service_1 = require("../upload/upload.service");
const ErrorCodes = __importStar(require("../../common/constants/error-codes"));
let DisputeMessageService = DisputeMessageService_1 = class DisputeMessageService {
    constructor(prisma, realtime, uploadService) {
        this.prisma = prisma;
        this.realtime = realtime;
        this.uploadService = uploadService;
        this.logger = new common_1.Logger(DisputeMessageService_1.name);
    }
    async validateDisputeAccess(disputeId, userId) {
        const dispute = await this.prisma.dispute.findFirst({
            where: {
                OR: [{ disputeId }, { id: disputeId }],
            },
            include: {
                order: { select: { buyerId: true, sellerId: true, orderId: true } },
            },
        });
        if (!dispute) {
            throw new common_1.NotFoundException({ code: ErrorCodes.NOT_FOUND, message: 'Dispute not found' });
        }
        const isParticipant = dispute.order.buyerId === userId || dispute.order.sellerId === userId;
        if (!isParticipant) {
            throw new common_1.ForbiddenException({ code: ErrorCodes.FORBIDDEN, message: 'Not a participant of this dispute' });
        }
        return dispute;
    }
    async getMessages(disputeId, userId, page, limit) {
        const dispute = await this.validateDisputeAccess(disputeId, userId);
        const safePage = Number.isFinite(page) ? Math.max(1, Math.floor(page)) : 1;
        const safeLimit = Number.isFinite(limit) ? Math.min(100, Math.max(1, Math.floor(limit))) : 50;
        const skip = (safePage - 1) * safeLimit;
        const [messages, total] = await Promise.all([
            this.prisma.disputeMessage.findMany({
                where: { disputeId: dispute.id },
                orderBy: { createdAt: 'desc' },
                skip,
                take: safeLimit,
            }),
            this.prisma.disputeMessage.count({
                where: { disputeId: dispute.id },
            }),
        ]);
        return {
            messages: messages.reverse(),
            total,
            page: safePage,
            limit: safeLimit,
            totalPages: Math.ceil(total / safeLimit),
        };
    }
    async sendMessage(disputeId, userId, message, attachments) {
        if ((!message || message.trim().length === 0) && (!attachments || attachments.length === 0)) {
            throw new common_1.BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Message or attachment is required' });
        }
        const normalizedMessage = (message || '').trim();
        if (normalizedMessage.length > 5000) {
            throw new common_1.BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Message too long (max 5000 characters)' });
        }
        const dispute = await this.validateDisputeAccess(disputeId, userId);
        if (['RESOLVED', 'CANCELLED'].includes(dispute.status)) {
            throw new common_1.BadRequestException({ code: ErrorCodes.INVALID_STATUS, message: 'Cannot send messages to a resolved or cancelled dispute' });
        }
        if (attachments && attachments.length > 5) {
            throw new common_1.BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Maximum 5 attachments per message' });
        }
        const attachmentKeys = (attachments ?? []).map((attachment) => attachment.fileKey);
        if (new Set(attachmentKeys).size !== attachmentKeys.length) {
            throw new common_1.BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Duplicate attachments are not allowed' });
        }
        const attachmentResults = attachments?.length
            ? await this.uploadService.verifyEvidenceFileKeysBatch(userId, attachmentKeys, attachments.map((attachment) => attachment.fileType))
            : [];
        const verifiedAttachmentKeys = attachmentResults.filter((result) => result.status === 'ok').map((result) => result.fileKey);
        if (attachmentResults.some((result) => result.status !== 'ok')) {
            await this.cleanupConfirmedAttachments(userId, verifiedAttachmentKeys);
            throw new common_1.BadRequestException({ code: ErrorCodes.UPLOAD_NOT_CONFIRMED, message: 'Every attachment must be a confirmed dispute-evidence upload' });
        }
        let actualSizes = [];
        try {
            actualSizes = attachments?.length
                ? await Promise.all(attachmentKeys.map((key) => this.uploadService.getFileSize(key)))
                : [];
        }
        catch (error) {
            await this.cleanupConfirmedAttachments(userId, verifiedAttachmentKeys);
            throw error;
        }
        const invalidSizes = actualSizes.some((size) => !Number.isSafeInteger(size) || size < 0 || size > 10 * 1024 * 1024);
        if (invalidSizes) {
            await this.cleanupConfirmedAttachments(userId, verifiedAttachmentKeys);
            throw new common_1.BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Each attachment must be a valid file no larger than 10 MB' });
        }
        const totalAttachmentBytes = actualSizes.reduce((total, size) => total + size, 0);
        if (!Number.isSafeInteger(totalAttachmentBytes) || totalAttachmentBytes > 20 * 1024 * 1024) {
            await this.cleanupConfirmedAttachments(userId, verifiedAttachmentKeys);
            throw new common_1.BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Total attachment size must not exceed 20 MB' });
        }
        const sanitizedMessage = normalizedMessage
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/&(?!amp;|lt;|gt;|quot;|#39;)/g, '&amp;');
        let created;
        try {
            created = await this.prisma.disputeMessage.create({
                data: {
                    disputeId: dispute.id,
                    senderId: userId,
                    message: sanitizedMessage,
                    attachments: (attachments ?? []).map((attachment, index) => ({
                        fileKey: attachment.fileKey,
                        fileName: attachment.fileName.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120) || `attachment-${index + 1}`,
                        fileType: attachment.fileType,
                        fileSize: actualSizes[index] ?? 0,
                    })),
                },
            });
        }
        catch (error) {
            await this.cleanupConfirmedAttachments(userId, verifiedAttachmentKeys);
            throw error;
        }
        const recipientId = dispute.order.buyerId === userId ? dispute.order.sellerId : dispute.order.buyerId;
        try {
            this.realtime.emitToUser(recipientId, 'dispute.new_message', {
                disputeId: dispute.disputeId,
                message: created,
            });
        }
        catch (error) {
            this.logger.warn(`Dispute message realtime emit failed: ${error instanceof Error ? error.message : String(error)}`);
        }
        return created;
    }
    async cleanupConfirmedAttachments(userId, fileKeys) {
        if (fileKeys.length === 0)
            return;
        try {
            await this.uploadService.cleanupFileKeys(userId, fileKeys);
        }
        catch (error) {
            this.logger.warn(`Dispute attachment cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
};
exports.DisputeMessageService = DisputeMessageService;
exports.DisputeMessageService = DisputeMessageService = DisputeMessageService_1 = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [prisma_service_1.PrismaService,
        realtime_service_1.RealtimeService,
        upload_service_1.UploadService])
], DisputeMessageService);
