import { Injectable, NotFoundException, ForbiddenException, BadRequestException, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { UploadService } from '../upload/upload.service';
import { PrismaService } from '../../prisma/prisma.service';
import { RealtimeService } from '../realtime/realtime.service';
import { SendMessageDto, UserChatMessageType } from './dto/send-message.dto';
import { ChatMessageType, NotificationType, Prisma } from '@prisma/client';
import { generateNotifId } from '../../common/utils/id-generator.util';
import { getCategoryForType } from '../notifications/notification-category.map';
import * as path from 'path';
import * as ErrorCodes from '../../common/constants/error-codes';
import { CHAT_MESSAGE_MAX_LENGTH } from '../../common/constants/app.constants';
import { createPaginatedResponse } from '../../common/dto/pagination.dto';

function sanitizeText(text: string): string {
  // React Native renders text nodes safely; HTML entity encoding here corrupts
  // legitimate chat content (for example, "A & B" becomes "A &amp; B").
  // Remove control characters only and let the UI renderer escape markup.
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

type RawReplyTo = {
  id: string;
  content: string | null;
  messageType: string;
  isDeleted: boolean;
  sender: { id: string; userId: string; fullName: string; avatarUrl: string | null } | null;
  attachments: { fileName: string }[];
} | null;

type RawMessage = Awaited<ReturnType<PrismaService['chatMessage']['findMany']>>[number] & {
  sender: { id: string; userId: string; fullName: string; avatarUrl: string | null } | null;
  attachments: { id: string; fileName: string; fileSize: number; mimeType: string; fileUrl: string; thumbnailUrl: string | null; createdAt: Date }[];
  replyToId?: string | null;
  replyTo?: RawReplyTo;
};

function serializeMessage(msg: RawMessage) {
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

@Injectable()
export class ChatService {
  private readonly logger = new Logger(ChatService.name);
  constructor(
    private prisma: PrismaService,
    private realtime: RealtimeService,
    private configService: ConfigService,
    @Optional() private uploadService?: UploadService,
  ) {}

  async getRooms(userId: string, page: number = 1, limit: number = 20): Promise<object> {
    const safePage = Math.max(1, page);
    const safeLimit = Math.min(Math.max(1, limit), 50);
    const skip = (safePage - 1) * safeLimit;

    const [roomRows, countResult] = await Promise.all([
      this.prisma.$queryRaw<Array<{
        room_id: string; is_archived: boolean; room_created_at: Date; room_updated_at: Date;
        order_id: string; order_title: string; order_status: string; buyer_id: string; seller_id: string;
        buyer_user_id: string; buyer_full_name: string; buyer_username: string; buyer_avatar_url: string | null;
        seller_user_id: string; seller_full_name: string; seller_username: string; seller_avatar_url: string | null;
        last_msg_id: string | null; last_msg_content: string | null; last_msg_type: string | null;
        last_msg_sender_user_id: string | null; last_msg_created_at: Date | null;
        unread_count: bigint;
      }>>`
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
      this.prisma.$queryRaw<[{ count: bigint }]>`
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

    return createPaginatedResponse(mappedRooms, total, safePage, safeLimit);
  }

  async getMessages(userId: string, roomId: string, cursor?: string, limit: number = 50, excludeIds?: string[]): Promise<object> {
    await this.validateRoomAccess(userId, roomId);

    const safeLimit = Math.min(Math.max(1, limit), 100);

    const whereClause: Record<string, unknown> = { roomId };
    if (cursor) {
      const cursorMessage = await this.prisma.chatMessage.findFirst({
        where: { id: cursor, roomId },
        select: { id: true },
      });
      if (!cursorMessage) {
        throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Cursor does not belong to this room' });
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
    }) as unknown as RawMessage[];
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

  async sendMessage(userId: string, roomId: string, dto: SendMessageDto): Promise<object> {
    const room = await this.validateRoomAccess(userId, roomId) as {
      order: { orderId: string; buyerId: string; sellerId: string; status: string; completedAt?: Date | null; cancelledAt?: Date | null };
    };
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
      throw new ForbiddenException({ code: ErrorCodes.FORBIDDEN, message: 'Cannot send messages — one party has blocked the other' });
    }

    const userMessageType = dto.messageType ?? UserChatMessageType.TEXT;
    const messageType = userMessageType as unknown as ChatMessageType;

    if (userMessageType === UserChatMessageType.TEXT && (!dto.content || dto.content.trim().length === 0)) {
      throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Text messages must have non-empty content' });
    }

    if (dto.content && dto.content.length > CHAT_MESSAGE_MAX_LENGTH) {
      throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: `Message content must not exceed ${CHAT_MESSAGE_MAX_LENGTH} characters` });
    }

    if (userMessageType !== UserChatMessageType.TEXT && (!dto.attachments || dto.attachments.length === 0)) {
      throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Media messages must include at least one attachment' });
    }

    if (dto.attachments?.length) {
      const trustedHostnames: string[] = [];
      const r2Endpoint = this.configService.get<string>('r2.endpointUrl');
      if (r2Endpoint) {
        try { trustedHostnames.push(new URL(r2Endpoint).hostname); } catch {}
      }
      const r2PublicUrl = this.configService.get<string>('r2.publicUrl');
      if (r2PublicUrl) {
        try { trustedHostnames.push(new URL(r2PublicUrl).hostname); } catch {}
      }
      if (trustedHostnames.length === 0) {
        throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Storage is not configured' });
      }

      const validateStorageUrl = (rawUrl: string, label: string) => {
        try {
          const parsed = new URL(rawUrl);
          if (parsed.protocol !== 'https:') throw new Error('not https');
          const isTrusted = trustedHostnames.some(h => parsed.hostname === h);
          if (!isTrusted) throw new Error('domain mismatch');
        } catch {
          throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: `${label} must reference the platform storage` });
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

      const validateOwnership = (rawUrl: string, label: string) => {
        try {
          const parsed = new URL(rawUrl);
          const decodedPath = decodeURIComponent(parsed.pathname);
          if (/\.\./.test(decodedPath) || /\/\.\//.test(decodedPath)) {
            throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: `${label} contains invalid path segments` });
          }
          const normalizedPath = path.posix.normalize(decodedPath);
          const segments = normalizedPath.split('/').filter(Boolean);
          const isOwnedChatObject = segments.some((segment, index) =>
            segment === 'uploads'
            && segments[index + 1] === 'chat-attachments'
            && segments[index + 2] === userId,
          );
          if (!isOwnedChatObject) {
            throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: `${label} does not belong to this user` });
          }
        } catch (e) {
          if (e instanceof BadRequestException) throw e;
          throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: `${label} has an invalid path` });
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
          throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: `MIME type '${a.mimeType}' is not allowed` });
        }
      }
    }

    if (dto.replyToId) {
      const replyTarget = await this.prisma.chatMessage.findFirst({
        where: { id: dto.replyToId, roomId, isDeleted: false },
        select: { id: true },
      });
      if (!replyTarget) {
        throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Replied-to message not found in this room' });
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
    }) as unknown as RawMessage;

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
    // Each persisted message is a distinct communication event. The previous
    // room/user dedupe key suppressed every second message sent within 60s.
    try {
      const notification = await this.prisma.notification.create({
        data: {
          notifId: generateNotifId(), userId: recipientId,
          type: NotificationType.CHAT_NEW_MESSAGE, category: getCategoryForType(NotificationType.CHAT_NEW_MESSAGE),
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
        data: { type: 'CHAT_NEW', notificationType: NotificationType.CHAT_NEW_MESSAGE, notificationId: notification.notifId, chatRoomId: roomId, roomId },
      });
    } catch (error) {
      // Message persistence is authoritative. A notification outage must not
      // turn a successful send into a client-visible failure and replay.
      this.logger.warn(`Chat notification side-effect failed for message ${message.id}: ${(error as Error).message}`);
    }

    return serialized;
  }

  async markAsRead(userId: string, roomId: string): Promise<{ markedCount: number }> {
    if (!userId || typeof userId !== 'string' || userId.length < 1) {
      throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Invalid userId format' });
    }
    const room = await this.validateRoomAccess(userId, roomId) as {
      order: { orderId: string; buyerId: string; sellerId: string };
    };

    const now = new Date().toISOString();
    const jsonPatch = JSON.stringify({ [userId]: now });

    const markedCount = await this.prisma.$executeRaw(
      Prisma.sql`
        UPDATE chat_messages
        SET "readAt" = COALESCE("readAt", '{}'::jsonb) || ${jsonPatch}::jsonb
        WHERE "roomId" = ${roomId}
          AND "isDeleted" = false
          AND ("senderId" IS NULL OR "senderId" != ${userId})
          AND (
            "readAt" IS NULL
            OR NOT jsonb_exists("readAt", ${userId})
          )
      `,
    );

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

  async deleteMessage(userId: string, roomId: string, messageId: string): Promise<{ message: string }> {
    const room = await this.validateRoomAccess(userId, roomId) as {
      order: { orderId: string; buyerId: string; sellerId: string };
    };

    const message = await this.prisma.chatMessage.findFirst({
      where: { id: messageId, roomId, isDeleted: false },
    });

    if (!message) {
      throw new NotFoundException({ code: ErrorCodes.NOT_FOUND, message: 'Message not found' });
    }

    if (message.senderId !== userId) {
      throw new ForbiddenException({ code: ErrorCodes.FORBIDDEN, message: 'You can only delete your own messages' });
    }

    /*
     * D-01: emit to the *public* order id, not the FK.
     *
     * `ChatRoom.orderId` is the relation column and holds `Order.id` — the internal cuid
     * (`schema.prisma:1223`). Socket rooms are named after the human-readable `Order.orderId`:
     * that is what `join-room` joins (`realtime.gateway.ts:478`), what `join_order` joins
     * (`:421`), what the disconnect sweep enumerates (`:325`), and what the sibling emits in
     * this same service already use (`:412` and `:463` both pass `room.order.orderId`).
     *
     * Passing the cuid addressed `order:<cuid>` — a room no socket has ever joined — so
     * `chat.message_deleted` was delivered to nobody. Mobile registers a handler for it
     * (`lib/hooks/useChatSocket.ts:172`, `app/chat/index.tsx:149`) that never fired, leaving a
     * message the sender had just deleted still rendered on the counterpart's screen until they
     * refetched or reopened the room.
     */
    await this.prisma.chatMessage.update({
      where: { id: messageId },
      data: { isDeleted: true, deletedAt: new Date(), content: null },
    });

    this.realtime.emitToOrder(room.order.orderId, 'chat.message_deleted', { messageId, roomId });

    return { message: 'Message deleted successfully' };
  }

  private async toReadableAttachmentUrl(rawUrl: string): Promise<string> {
    if (!rawUrl || !rawUrl.startsWith('uploads/') || !this.uploadService) return rawUrl;
    try {
      // URL signing is intentionally performed at read time, not persisted with
      // the message. Persisted chat records must remain readable after expiry.
      return await this.uploadService.generateDownloadUrl(rawUrl, 300);
    } catch (error) {
      this.logger.warn(`Unable to sign chat attachment URL: ${(error as Error).message}`);
      return '';
    }
  }

  async getRoomAttachments(userId: string, roomId: string, page: number, limit: number): Promise<object> {
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

  async validateRoomAccess(userId: string, roomId: string): Promise<object> {
    const room = await this.prisma.chatRoom.findUnique({
      where: { id: roomId, deletedAt: null },
      include: {
                  order: {
          select: { orderId: true, buyerId: true, sellerId: true, status: true, completedAt: true, cancelledAt: true, deletedAt: true },
        },

      },
    });

    if (!room) {
      throw new NotFoundException({
        code: ErrorCodes.NOT_FOUND,
        message: 'Chat room not found',
      });
    }

    if (room.order.deletedAt || (room.order.buyerId !== userId && room.order.sellerId !== userId)) {
      throw new ForbiddenException({
        code: ErrorCodes.NOT_ORDER_PARTICIPANT,
        message: 'You are not a participant of this order',
      });
    }

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { isActive: true, isBanned: true },
    });

    if (!user || !user.isActive) {
      throw new ForbiddenException({
        code: ErrorCodes.ACCOUNT_INACTIVE,
        message: 'Your account is inactive',
      });
    }

    if (user.isBanned) {
      throw new ForbiddenException({
        code: ErrorCodes.ACCOUNT_BANNED,
        message: 'Your account has been banned',
      });
    }

    return room;
  }

  private validateCanSendMessage(room: { order: { status: string; completedAt?: Date | null; cancelledAt?: Date | null } }): void {
    const CLOSED_STATUSES = ['COMPLETED', 'CANCELLED'];
    if (CLOSED_STATUSES.includes(room.order.status)) {
      const GRACE_PERIOD_MS = 24 * 60 * 60 * 1000;
      const closedAt = room.order.completedAt || room.order.cancelledAt;
      if (closedAt && Date.now() - new Date(closedAt).getTime() < GRACE_PERIOD_MS) {
        return;
      }
      throw new BadRequestException({
        code: ErrorCodes.CHAT_ROOM_CLOSED,
        message: 'Cannot send messages after the order has been completed or cancelled',
      });
    }
  }
}
