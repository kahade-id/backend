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
var __param = (this && this.__param) || function (paramIndex, decorator) {
    return function (target, key) { decorator(target, key, paramIndex); }
};
var ChatService_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.ChatService = void 0;
const common_1 = require("@nestjs/common");
const config_1 = require("@nestjs/config");
const upload_service_1 = require("../upload/upload.service");
const prisma_service_1 = require("../../prisma/prisma.service");
const realtime_service_1 = require("../realtime/realtime.service");
const send_message_dto_1 = require("./dto/send-message.dto");
const client_1 = require("@prisma/client");
const id_generator_util_1 = require("../../common/utils/id-generator.util");
const notification_category_map_1 = require("../notifications/notification-category.map");
const path = __importStar(require("path"));
const ErrorCodes = __importStar(require("../../common/constants/error-codes"));
const app_constants_1 = require("../../common/constants/app.constants");
const pagination_dto_1 = require("../../common/dto/pagination.dto");
function sanitizeText(text) {
    return text.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
}
const MESSAGE_SELECT = {
    id: true,
    roomId: true,
    messageType: true,
    content: true,
    isEdited: true,
    isDeleted: true,
    readAt: true,
    createdAt: true,
    replyToId: true,
    replyTo: {
        select: {
            id: true,
            content: true,
            messageType: true,
            isDeleted: true,
            sender: { select: { id: true, userId: true, fullName: true, avatarUrl: true } },
            attachments: { select: { fileName: true }, take: 1 },
        },
    },
    sender: {
        select: { id: true, userId: true, fullName: true, avatarUrl: true },
    },
    attachments: {
        select: {
            id: true,
            fileName: true,
            fileSize: true,
            mimeType: true,
            fileUrl: true,
            thumbnailUrl: true,
            createdAt: true,
        },
    },
};
function serializeMessage(msg) {
    const replyTo = msg.replyTo
        ? {
            id: msg.replyTo.id,
            content: msg.replyTo.isDeleted ? null : msg.replyTo.content,
            messageType: msg.replyTo.messageType,
            isDeleted: msg.replyTo.isDeleted,
            senderName: msg.replyTo.sender?.fullName ?? null,
            senderId: msg.replyTo.sender?.userId ?? null,
            fileName: msg.replyTo.attachments?.[0]?.fileName ?? null,
        }
        : null;
    return {
        id: msg.id,
        roomId: msg.roomId,
        senderId: msg.sender?.userId ?? null,
        sender: msg.sender
            ? { id: msg.sender.userId, userId: msg.sender.userId, fullName: msg.sender.fullName, avatarUrl: msg.sender.avatarUrl }
            : null,
        messageType: msg.messageType,
        content: msg.isDeleted ? null : msg.content,
        isEdited: msg.isEdited,
        isDeleted: msg.isDeleted,
        readAt: msg.readAt,
        createdAt: msg.createdAt,
        attachments: msg.isDeleted ? [] : msg.attachments,
        replyToId: msg.replyToId ?? null,
        replyTo,
    };
}
let ChatService = ChatService_1 = class ChatService {
    constructor(prisma, realtime, configService, uploadService) {
        this.prisma = prisma;
        this.realtime = realtime;
        this.configService = configService;
        this.uploadService = uploadService;
        this.logger = new common_1.Logger(ChatService_1.name);
    }
    async getRooms(userId, page = 1, limit = 20) {
        const safePage = Math.max(1, page);
        const safeLimit = Math.min(Math.max(1, limit), 50);
        const skip = (safePage - 1) * safeLimit;
        const [roomRows, countResult] = await Promise.all([
            this.prisma.$queryRaw `
        SELECT
          cr.id AS room_id,
          cr."isArchived" AS is_archived,
          cr."createdAt" AS room_created_at,
          cr."updatedAt" AS room_updated_at,
          o."orderId" AS order_id,
          o.title AS order_title,
          o.status AS order_status,
          o."buyerId" AS buyer_id,
          o."sellerId" AS seller_id,
          bu."userId" AS buyer_user_id,
          bu."fullName" AS buyer_full_name,
          bu.username AS buyer_username,
          bu."avatarUrl" AS buyer_avatar_url,
          su."userId" AS seller_user_id,
          su."fullName" AS seller_full_name,
          su.username AS seller_username,
          su."avatarUrl" AS seller_avatar_url,
          lm.id AS last_msg_id,
          lm.content AS last_msg_content,
          lm."messageType" AS last_msg_type,
          lm_sender."userId" AS last_msg_sender_user_id,
          lm."createdAt" AS last_msg_created_at,
          COALESCE(uc.unread_count, 0) AS unread_count
        FROM chat_rooms cr
        JOIN orders o ON o.id = cr."orderId"
        JOIN users bu ON bu.id = o."buyerId"
        JOIN users su ON su.id = o."sellerId"
        LEFT JOIN LATERAL (
          SELECT cm.id, cm.content, cm."messageType", cm."senderId", cm."createdAt"
          FROM chat_messages cm
          WHERE cm."roomId" = cr.id AND cm."isDeleted" = false
          ORDER BY cm."createdAt" DESC
          LIMIT 1
        ) lm ON true
        LEFT JOIN users lm_sender ON lm_sender.id = lm."senderId"
        LEFT JOIN LATERAL (
          SELECT COUNT(*) AS unread_count
          FROM chat_messages cm2
          WHERE cm2."roomId" = cr.id
            AND cm2."isDeleted" = false
            AND (cm2."senderId" IS NULL OR cm2."senderId" != ${userId})
            AND (cm2."readAt" IS NULL OR NOT jsonb_exists(cm2."readAt", ${userId}))
        ) uc ON true
        WHERE cr."deletedAt" IS NULL
          AND o."deletedAt" IS NULL
          AND (o."buyerId" = ${userId} OR o."sellerId" = ${userId})
        ORDER BY cr."updatedAt" DESC
        OFFSET ${skip}
        LIMIT ${safeLimit}
      `,
            this.prisma.$queryRaw `
        SELECT COUNT(*) AS count
        FROM chat_rooms cr
        JOIN orders o ON o.id = cr."orderId"
        WHERE cr."deletedAt" IS NULL
          AND o."deletedAt" IS NULL
          AND (o."buyerId" = ${userId} OR o."sellerId" = ${userId})
      `,
        ]);
        const total = Number(countResult[0]?.count ?? 0);
        const otherUserIds = roomRows
            .map(r => r.buyer_id === userId ? r.seller_id : r.buyer_id)
            .filter((id, i, arr) => arr.indexOf(id) === i);
        const onlineStatuses = await this.realtime.areUsersOnline(otherUserIds);
        const mappedRooms = roomRows.map((r) => {
            const isBuyer = r.buyer_id === userId;
            const other = isBuyer
                ? { userId: r.seller_user_id, fullName: r.seller_full_name, username: r.seller_username, avatarUrl: r.seller_avatar_url }
                : { userId: r.buyer_user_id, fullName: r.buyer_full_name, username: r.buyer_username, avatarUrl: r.buyer_avatar_url };
            const otherInternalId = isBuyer ? r.seller_id : r.buyer_id;
            return {
                id: r.room_id,
                orderId: r.order_id,
                orderTitle: r.order_title,
                orderStatus: r.order_status,
                isArchived: r.is_archived,
                buyer: { userId: r.buyer_user_id, fullName: r.buyer_full_name, username: r.buyer_username, avatarUrl: r.buyer_avatar_url },
                seller: { userId: r.seller_user_id, fullName: r.seller_full_name, username: r.seller_username, avatarUrl: r.seller_avatar_url },
                otherUser: {
                    userId: other.userId,
                    fullName: other.fullName,
                    username: other.username,
                    avatarUrl: other.avatarUrl,
                    isOnline: onlineStatuses[otherInternalId] ?? false,
                },
                lastMessage: r.last_msg_id
                    ? {
                        id: r.last_msg_id,
                        content: r.last_msg_content,
                        messageType: r.last_msg_type,
                        senderId: r.last_msg_sender_user_id ?? null,
                        createdAt: r.last_msg_created_at,
                    }
                    : null,
                unreadCount: Number(r.unread_count),
                createdAt: r.room_created_at,
                updatedAt: r.room_updated_at,
            };
        });
        return (0, pagination_dto_1.createPaginatedResponse)(mappedRooms, total, safePage, safeLimit);
    }
    async getMessages(userId, roomId, cursor, limit = 50, excludeIds) {
        await this.validateRoomAccess(userId, roomId);
        const safeLimit = Math.min(Math.max(1, limit), 100);
        const whereClause = { roomId };
        if (cursor) {
            const cursorMessage = await this.prisma.chatMessage.findFirst({
                where: { id: cursor, roomId },
                select: { id: true },
            });
            if (!cursorMessage) {
                throw new common_1.BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Cursor does not belong to this room' });
            }
        }
        if (excludeIds && excludeIds.length > 0) {
            whereClause.id = { notIn: excludeIds };
        }
        const newestFirst = await this.prisma.chatMessage.findMany({
            where: whereClause,
            ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
            take: safeLimit,
            orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
            select: MESSAGE_SELECT,
        });
        const messages = newestFirst.reverse();
        const hasMore = newestFirst.length === safeLimit;
        const nextCursor = hasMore && messages.length > 0 ? messages[0].id : null;
        const responseMessages = await Promise.all(messages.map(async (message) => ({
            ...message,
            attachments: await Promise.all(message.attachments.map(async (attachment) => ({
                ...attachment,
                fileUrl: await this.toReadableAttachmentUrl(attachment.fileUrl),
                thumbnailUrl: attachment.thumbnailUrl ? await this.toReadableAttachmentUrl(attachment.thumbnailUrl) : null,
            }))),
        })));
        return {
            messages: responseMessages.map(serializeMessage),
            nextCursor,
            hasMore,
        };
    }
    async sendMessage(userId, roomId, dto) {
        const room = await this.validateRoomAccess(userId, roomId);
        this.validateCanSendMessage(room);
        const recipientId = room.order.buyerId === userId ? room.order.sellerId : room.order.buyerId;
        const block = await this.prisma.blockList.findFirst({
            where: {
                OR: [
                    { blockerId: userId, blockedId: recipientId },
                    { blockerId: recipientId, blockedId: userId },
                ],
            },
            select: { id: true },
        });
        if (block) {
            throw new common_1.ForbiddenException({ code: ErrorCodes.FORBIDDEN, message: 'Cannot send messages — one party has blocked the other' });
        }
        const userMessageType = dto.messageType ?? send_message_dto_1.UserChatMessageType.TEXT;
        const messageType = userMessageType;
        if (userMessageType === send_message_dto_1.UserChatMessageType.TEXT && (!dto.content || dto.content.trim().length === 0)) {
            throw new common_1.BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Text messages must have non-empty content' });
        }
        if (dto.content && dto.content.length > app_constants_1.CHAT_MESSAGE_MAX_LENGTH) {
            throw new common_1.BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: `Message content must not exceed ${app_constants_1.CHAT_MESSAGE_MAX_LENGTH} characters` });
        }
        if (userMessageType !== send_message_dto_1.UserChatMessageType.TEXT && (!dto.attachments || dto.attachments.length === 0)) {
            throw new common_1.BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Media messages must include at least one attachment' });
        }
        if (dto.attachments?.length) {
            const trustedHostnames = [];
            const r2Endpoint = this.configService.get('r2.endpointUrl');
            if (r2Endpoint) {
                try {
                    trustedHostnames.push(new URL(r2Endpoint).hostname);
                }
                catch { }
            }
            const r2PublicUrl = this.configService.get('r2.publicUrl');
            if (r2PublicUrl) {
                try {
                    trustedHostnames.push(new URL(r2PublicUrl).hostname);
                }
                catch { }
            }
            if (trustedHostnames.length === 0) {
                throw new common_1.BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Storage is not configured' });
            }
            const validateStorageUrl = (rawUrl, label) => {
                try {
                    const parsed = new URL(rawUrl);
                    if (parsed.protocol !== 'https:')
                        throw new Error('not https');
                    const isTrusted = trustedHostnames.some(h => parsed.hostname === h);
                    if (!isTrusted)
                        throw new Error('domain mismatch');
                }
                catch {
                    throw new common_1.BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: `${label} must reference the platform storage` });
                }
            };
            const ALLOWED_MIME_TYPES = new Set([
                'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/heic',
                'video/mp4', 'video/quicktime', 'video/webm',
                'audio/mpeg', 'audio/wav', 'audio/ogg', 'audio/aac', 'audio/mp4', 'audio/m4a',
                'application/pdf',
                'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
                'application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
                'text/plain',
            ]);
            const validateOwnership = (rawUrl, label) => {
                try {
                    const parsed = new URL(rawUrl);
                    const decodedPath = decodeURIComponent(parsed.pathname);
                    if (/\.\./.test(decodedPath) || /\/\.\//.test(decodedPath)) {
                        throw new common_1.BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: `${label} contains invalid path segments` });
                    }
                    const normalizedPath = path.posix.normalize(decodedPath);
                    const segments = normalizedPath.split('/').filter(Boolean);
                    const isOwnedChatObject = segments.some((segment, index) => segment === 'uploads'
                        && segments[index + 1] === 'chat-attachments'
                        && segments[index + 2] === userId);
                    if (!isOwnedChatObject) {
                        throw new common_1.BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: `${label} does not belong to this user` });
                    }
                }
                catch (e) {
                    if (e instanceof common_1.BadRequestException)
                        throw e;
                    throw new common_1.BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: `${label} has an invalid path` });
                }
            };
            for (const a of dto.attachments) {
                if (a.fileUrl) {
                    validateStorageUrl(a.fileUrl, 'Attachment file URL');
                    validateOwnership(a.fileUrl, 'Attachment file URL');
                }
                if (a.thumbnailUrl) {
                    validateStorageUrl(a.thumbnailUrl, 'Attachment thumbnail URL');
                    validateOwnership(a.thumbnailUrl, 'Attachment thumbnail URL');
                }
                if (a.mimeType && !ALLOWED_MIME_TYPES.has(a.mimeType.toLowerCase())) {
                    throw new common_1.BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: `MIME type '${a.mimeType}' is not allowed` });
                }
            }
        }
        if (dto.replyToId) {
            const replyTarget = await this.prisma.chatMessage.findFirst({
                where: { id: dto.replyToId, roomId, isDeleted: false },
                select: { id: true },
            });
            if (!replyTarget) {
                throw new common_1.BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Replied-to message not found in this room' });
            }
        }
        const message = await this.prisma.chatMessage.create({
            data: {
                roomId,
                senderId: userId,
                messageType,
                content: dto.content ? sanitizeText(dto.content.trim()) : null,
                replyToId: dto.replyToId || undefined,
                attachments: dto.attachments?.length
                    ? {
                        create: dto.attachments.map((a) => ({
                            fileName: sanitizeText(a.fileName.replace(/[/\\:*?"<>|]/g, '_').replace(/\.\./g, '_')),
                            fileSize: a.fileSize,
                            mimeType: a.mimeType,
                            fileUrl: a.fileUrl,
                            thumbnailUrl: a.thumbnailUrl,
                        })),
                    }
                    : undefined,
            },
            select: MESSAGE_SELECT,
        });
        await this.prisma.chatRoom.update({
            where: { id: roomId },
            data: { updatedAt: new Date() },
        });
        const serialized = serializeMessage(message);
        this.realtime.emitToOrder(room.order.orderId, 'chat.new_message', serialized);
        this.realtime.emitToUser(recipientId, 'chat.new_message', serialized);
        const sender = await this.prisma.user.findUnique({ where: { id: userId }, select: { fullName: true, username: true } });
        const senderName = sender?.fullName || sender?.username || 'User';
        const rawPreview = dto.content ? dto.content.slice(0, 80) : 'Sent media';
        const preview = sanitizeText(rawPreview);
        try {
            const notification = await this.prisma.notification.create({
                data: {
                    notifId: (0, id_generator_util_1.generateNotifId)(), userId: recipientId,
                    type: client_1.NotificationType.CHAT_NEW_MESSAGE, category: (0, notification_category_map_1.getCategoryForType)(client_1.NotificationType.CHAT_NEW_MESSAGE),
                    title: `Message from ${senderName}`, body: preview, isRead: false,
                    refType: 'CHAT_MESSAGE', refId: message.id,
                    actionUrl: `/chat/${encodeURIComponent(roomId)}`,
                },
                select: { notifId: true },
            });
            this.prisma.emitNotificationCreated({
                userId: recipientId,
                title: `Message from ${senderName}`,
                body: preview,
                data: { type: 'CHAT_NEW', notificationType: client_1.NotificationType.CHAT_NEW_MESSAGE, notificationId: notification.notifId, chatRoomId: roomId, roomId },
            });
        }
        catch (error) {
            this.logger.warn(`Chat notification side-effect failed for message ${message.id}: ${error.message}`);
        }
        return serialized;
    }
    async markAsRead(userId, roomId) {
        if (!userId || typeof userId !== 'string' || userId.length < 1) {
            throw new common_1.BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Invalid userId format' });
        }
        const room = await this.validateRoomAccess(userId, roomId);
        const now = new Date().toISOString();
        const jsonPatch = JSON.stringify({ [userId]: now });
        const markedCount = await this.prisma.$executeRaw(client_1.Prisma.sql `
        UPDATE chat_messages
        SET "readAt" = COALESCE("readAt", '{}'::jsonb) || ${jsonPatch}::jsonb
        WHERE "roomId" = ${roomId}
          AND "isDeleted" = false
          AND ("senderId" IS NULL OR "senderId" != ${userId})
          AND (
            "readAt" IS NULL
            OR NOT jsonb_exists("readAt", ${userId})
          )
      `);
        if (markedCount > 0) {
            this.realtime.emitToOrder(room.order.orderId, 'chat.read', {
                roomId,
                userId,
                readAt: now,
                markedCount,
            });
        }
        return { markedCount };
    }
    async deleteMessage(userId, roomId, messageId) {
        const room = await this.validateRoomAccess(userId, roomId);
        const message = await this.prisma.chatMessage.findFirst({
            where: { id: messageId, roomId, isDeleted: false },
        });
        if (!message) {
            throw new common_1.NotFoundException({ code: ErrorCodes.NOT_FOUND, message: 'Message not found' });
        }
        if (message.senderId !== userId) {
            throw new common_1.ForbiddenException({ code: ErrorCodes.FORBIDDEN, message: 'You can only delete your own messages' });
        }
        await this.prisma.chatMessage.update({
            where: { id: messageId },
            data: { isDeleted: true, deletedAt: new Date(), content: null },
        });
        this.realtime.emitToOrder(room.order.orderId, 'chat.message_deleted', { messageId, roomId });
        return { message: 'Message deleted successfully' };
    }
    async toReadableAttachmentUrl(rawUrl) {
        if (!rawUrl || !rawUrl.startsWith('uploads/') || !this.uploadService)
            return rawUrl;
        try {
            return await this.uploadService.generateDownloadUrl(rawUrl, 300);
        }
        catch (error) {
            this.logger.warn(`Unable to sign chat attachment URL: ${error.message}`);
            return '';
        }
    }
    async getRoomAttachments(userId, roomId, page, limit) {
        await this.validateRoomAccess(userId, roomId);
        const safePage = Math.max(1, page);
        const safeLimit = Math.min(Math.max(1, limit), 100);
        const skip = (safePage - 1) * safeLimit;
        const [attachments, total] = await Promise.all([
            this.prisma.chatAttachment.findMany({
                where: {
                    message: { roomId, isDeleted: false },
                },
                orderBy: { createdAt: 'desc' },
                skip,
                take: safeLimit,
                select: {
                    id: true,
                    fileName: true,
                    fileSize: true,
                    mimeType: true,
                    fileUrl: true,
                    thumbnailUrl: true,
                    createdAt: true,
                    message: {
                        select: { id: true, sender: { select: { userId: true } } },
                    },
                },
            }),
            this.prisma.chatAttachment.count({
                where: { message: { roomId, isDeleted: false } },
            }),
        ]);
        const readableAttachments = await Promise.all(attachments.map(async (attachment) => ({
            ...attachment,
            fileUrl: await this.toReadableAttachmentUrl(attachment.fileUrl),
            thumbnailUrl: attachment.thumbnailUrl ? await this.toReadableAttachmentUrl(attachment.thumbnailUrl) : null,
        })));
        return { data: readableAttachments, total, page: safePage, limit: safeLimit, totalPages: Math.ceil(total / safeLimit) };
    }
    async validateRoomAccess(userId, roomId) {
        const room = await this.prisma.chatRoom.findUnique({
            where: { id: roomId, deletedAt: null },
            include: {
                order: {
                    select: { orderId: true, buyerId: true, sellerId: true, status: true, completedAt: true, cancelledAt: true, deletedAt: true },
                },
            },
        });
        if (!room) {
            throw new common_1.NotFoundException({
                code: ErrorCodes.NOT_FOUND,
                message: 'Chat room not found',
            });
        }
        if (room.order.deletedAt || (room.order.buyerId !== userId && room.order.sellerId !== userId)) {
            throw new common_1.ForbiddenException({
                code: ErrorCodes.NOT_ORDER_PARTICIPANT,
                message: 'You are not a participant of this order',
            });
        }
        const user = await this.prisma.user.findUnique({
            where: { id: userId },
            select: { isActive: true, isBanned: true },
        });
        if (!user || !user.isActive) {
            throw new common_1.ForbiddenException({
                code: ErrorCodes.ACCOUNT_INACTIVE,
                message: 'Your account is inactive',
            });
        }
        if (user.isBanned) {
            throw new common_1.ForbiddenException({
                code: ErrorCodes.ACCOUNT_BANNED,
                message: 'Your account has been banned',
            });
        }
        return room;
    }
    validateCanSendMessage(room) {
        const CLOSED_STATUSES = ['COMPLETED', 'CANCELLED'];
        if (CLOSED_STATUSES.includes(room.order.status)) {
            const GRACE_PERIOD_MS = 24 * 60 * 60 * 1000;
            const closedAt = room.order.completedAt || room.order.cancelledAt;
            if (closedAt && Date.now() - new Date(closedAt).getTime() < GRACE_PERIOD_MS) {
                return;
            }
            throw new common_1.BadRequestException({
                code: ErrorCodes.CHAT_ROOM_CLOSED,
                message: 'Cannot send messages after the order has been completed or cancelled',
            });
        }
    }
};
exports.ChatService = ChatService;
exports.ChatService = ChatService = ChatService_1 = __decorate([
    (0, common_1.Injectable)(),
    __param(3, (0, common_1.Optional)()),
    __metadata("design:paramtypes", [prisma_service_1.PrismaService,
        realtime_service_1.RealtimeService,
        config_1.ConfigService,
        upload_service_1.UploadService])
], ChatService);
