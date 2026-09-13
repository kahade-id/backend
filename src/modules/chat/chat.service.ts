import { Injectable, NotFoundException, ForbiddenException, BadRequestException, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { UploadService } from '../upload/upload.service';
import { PrismaService } from '../../prisma/prisma.service';
import { RealtimeService } from '../realtime/realtime.service';
import { SendMessageDto, UserChatMessageType } from './dto/send-message.dto';
import type { CreateInquiryDto } from './dto/create-inquiry.dto';
import { ChatMessageType, ChatModerationAction, ChatModerationKind, ChatModerationSeverity, NotificationType, Prisma } from '@prisma/client';
import { generateNotifId } from '../../common/utils/id-generator.util';
import { getCategoryForType } from '../notifications/notification-category.map';
import * as path from 'path';
import * as ErrorCodes from '../../common/constants/error-codes';
import {
  CHAT_INQUIRY_MAX_ACTIVE_PER_USER,
  CHAT_MAX_PINNED_PER_ROOM,
  CHAT_MESSAGE_MAX_LENGTH,
  CHAT_SEARCH_DEFAULT_LIMIT,
  CHAT_SEARCH_MAX_LIMIT,
  CHAT_SEARCH_MIN_QUERY_LENGTH,
  CHAT_VOICE_MAX_DURATION_SECONDS,
  CHAT_VOICE_MIN_DURATION_SECONDS,
} from '../../common/constants/app.constants';
import { createPaginatedResponse } from '../../common/dto/pagination.dto';
import { moderateFileName, moderateText, ModerationVerdict, ModerateOptions } from './chat-moderation.util';

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
  editedAt: true,
  isDeleted: true,
  deletedAt: true,
  isPinned: true,
  pinnedAt: true,
  durationSeconds: true,
  forwardedFromId: true,
  readAt: true,
  createdAt: true,
  updatedAt: true,
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
  forwardedFrom: {
    select: {
      id: true,
      roomId: true,
      content: true,
      messageType: true,
      isDeleted: true,
      sender: { select: { id: true, userId: true, fullName: true, avatarUrl: true } },
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
  reactions: {
    select: {
      emoji: true,
      userId: true,
      createdAt: true,
      user: { select: { userId: true, fullName: true } },
    },
    orderBy: { createdAt: 'asc' },
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

type RawForwardedFrom = {
  id: string;
  roomId: string;
  content: string | null;
  messageType: string;
  isDeleted: boolean;
  sender: { id: string; userId: string; fullName: string; avatarUrl: string | null } | null;
} | null;

type RawReaction = {
  emoji: string;
  userId: string;
  user: { userId: string; fullName: string } | null;
};

type RawMessage = {
  id: string;
  roomId: string;
  messageType: string;
  content: string | null;
  isEdited: boolean;
  editedAt: Date | null;
  isDeleted: boolean;
  deletedAt: Date | null;
  isPinned: boolean;
  pinnedAt: Date | null;
  durationSeconds: number | null;
  forwardedFromId: string | null;
  readAt: unknown;
  createdAt: Date;
  updatedAt: Date;
  replyToId?: string | null;
  replyTo?: RawReplyTo;
  forwardedFrom?: RawForwardedFrom;
  sender: { id: string; userId: string; fullName: string; avatarUrl: string | null } | null;
  attachments: {
    id: string;
    fileName: string;
    fileSize: number;
    mimeType: string;
    fileUrl: string;
    thumbnailUrl: string | null;
    createdAt: Date;
  }[];
  reactions?: RawReaction[];
  deletedContent?: string | null;
};

interface ChatAttachmentCopy {
  fileName: string;
  fileSize: number;
  mimeType: string;
  fileUrl: string;
  thumbnailUrl?: string | null;
}

export interface ReactionSummaryEntry {
  emoji: string;
  count: number;
  reactedByMe: boolean;
  users: { userId: string; fullName: string | null }[];
}

export interface SerializeMessageOptions {
  /** Dipakai untuk menandai reaksi milik sendiri. */
  viewerId?: string | null;
  /**
   * Sertakan `deletedContent` (isi asli pesan yang dihapus). HANYA untuk admin
   * dan resolver dispute — pesan yang sudah masuk masa sengketa tidak boleh
   * hilang begitu saja dari bukti.
   */
  includeDeletedContent?: boolean;
}

function summarizeReactions(reactions: RawReaction[], viewerId?: string | null): ReactionSummaryEntry[] {
  const byEmoji = new Map<string, ReactionSummaryEntry>();
  for (const reaction of reactions) {
    const entry = byEmoji.get(reaction.emoji) ?? {
      emoji: reaction.emoji,
      count: 0,
      reactedByMe: false,
      users: [],
    };
    entry.count += 1;
    if (viewerId && reaction.userId === viewerId) entry.reactedByMe = true;
    entry.users.push({ userId: reaction.user?.userId ?? reaction.userId, fullName: reaction.user?.fullName ?? null });
    byEmoji.set(reaction.emoji, entry);
  }
  return [...byEmoji.values()];
}

function serializeMessage(msg: RawMessage, options: SerializeMessageOptions = {}) {
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

  const forwardedFrom = msg.forwardedFrom
    ? {
        id: msg.forwardedFrom.id,
        roomId: msg.forwardedFrom.roomId,
        content: msg.forwardedFrom.isDeleted ? null : msg.forwardedFrom.content,
        messageType: msg.forwardedFrom.messageType,
        senderName: msg.forwardedFrom.sender?.fullName ?? null,
        senderId: msg.forwardedFrom.sender?.userId ?? null,
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
    editedAt: msg.editedAt ?? null,
    isDeleted: msg.isDeleted,
    deletedAt: msg.deletedAt ?? null,
    isPinned: msg.isPinned,
    pinnedAt: msg.pinnedAt ?? null,
    durationSeconds: msg.durationSeconds ?? null,
    forwardedFromId: msg.forwardedFromId ?? null,
    forwardedFrom,
    readAt: msg.readAt,
    createdAt: msg.createdAt,
    updatedAt: msg.updatedAt,
    attachments: msg.isDeleted ? [] : msg.attachments,
    replyToId: msg.replyToId ?? null,
    replyTo,
    reactions: summarizeReactions(msg.reactions ?? [], options.viewerId),
    ...(options.includeDeletedContent && msg.isDeleted
      ? { deletedContent: (msg as RawMessage).deletedContent ?? null }
      : {}),
  };
}

/** Konteks room yang sudah lolos otorisasi. */
interface RoomContext {
  id: string;
  type: string;
  status: string;
  subject: string | null;
  initiatorId: string | null;
  counterpartId: string | null;
  participants: string[];
  order: {
    id: string;
    orderId: string;
    status: string;
    completedAt: Date | null;
    cancelledAt: Date | null;
    buyerId: string;
    sellerId: string;
  } | null;
}

export interface RoomListOptions {
  page?: number;
  limit?: number;
  type?: 'ORDER' | 'INQUIRY';
  /** true = hanya yang diarsipkan, false/undefined = sembunyikan yang diarsipkan. */
  archived?: boolean;
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

  // ============================================================
  // Rooms
  // ============================================================

  async getRooms(userId: string, options: RoomListOptions = {}): Promise<object> {
    const safePage = Math.max(1, options.page ?? 1);
    const safeLimit = Math.min(Math.max(1, options.limit ?? 20), 50);
    const skip = (safePage - 1) * safeLimit;
    const typeFilter = options.type === 'INQUIRY' || options.type === 'ORDER' ? options.type : null;
    const archivedOnly = options.archived === true;

    const [roomRows, countResult] = await Promise.all([
      this.prisma.$queryRaw<Array<{
        room_id: string; room_type: string; room_status: string; room_subject: string | null;
        is_archived: boolean; room_created_at: Date; room_updated_at: Date;
        member_archived: boolean | null; member_muted: boolean | null; member_muted_until: Date | null;
        order_id: string | null; order_title: string | null; order_status: string | null;
        initiator_user_id: string | null; initiator_full_name: string | null;
        initiator_username: string | null; initiator_avatar_url: string | null;
        counterpart_user_id: string | null; counterpart_full_name: string | null;
        counterpart_username: string | null; counterpart_avatar_url: string | null;
        last_msg_id: string | null; last_msg_content: string | null; last_msg_type: string | null;
        last_msg_sender_user_id: string | null; last_msg_created_at: Date | null;
        unread_count: bigint; pinned_count: bigint;
      }>>`
        SELECT
          cr.id AS room_id,
          cr."type" AS room_type,
          cr.status AS room_status,
          cr.subject AS room_subject,
          cr."isArchived" AS is_archived,
          cr."createdAt" AS room_created_at,
          cr."updatedAt" AS room_updated_at,
          cm.is_archived AS member_archived,
          cm.is_muted AS member_muted,
          cm."mutedUntil" AS member_muted_until,
          o."orderId" AS order_id,
          o.title AS order_title,
          o.status AS order_status,
          iu."userId" AS initiator_user_id,
          iu."fullName" AS initiator_full_name,
          iu.username AS initiator_username,
          iu."avatarUrl" AS initiator_avatar_url,
          cu."userId" AS counterpart_user_id,
          cu."fullName" AS counterpart_full_name,
          cu.username AS counterpart_username,
          cu."avatarUrl" AS counterpart_avatar_url,
          lm.id AS last_msg_id,
          lm.content AS last_msg_content,
          lm."messageType" AS last_msg_type,
          lm_sender."userId" AS last_msg_sender_user_id,
          lm."createdAt" AS last_msg_created_at,
          COALESCE(uc.unread_count, 0) AS unread_count,
          COALESCE(pc.pinned_count, 0) AS pinned_count
        FROM chat_rooms cr
        LEFT JOIN orders o ON o.id = cr."orderId" AND o."deletedAt" IS NULL
        LEFT JOIN users iu ON iu.id = cr."initiatorId"
        LEFT JOIN users cu ON cu.id = cr."counterpartId"
        LEFT JOIN chat_room_members cm ON cm."roomId" = cr.id AND cm."userId" = ${userId}
        LEFT JOIN LATERAL (
          SELECT cm2.id, cm2.content, cm2."messageType", cm2."senderId", cm2."createdAt"
          FROM chat_messages cm2
          WHERE cm2."roomId" = cr.id AND cm2."isDeleted" = false
          ORDER BY cm2."createdAt" DESC
          LIMIT 1
        ) lm ON true
        LEFT JOIN users lm_sender ON lm_sender.id = lm."senderId"
        LEFT JOIN LATERAL (
          SELECT COUNT(*) AS unread_count
          FROM chat_messages cm3
          WHERE cm3."roomId" = cr.id
            AND cm3."isDeleted" = false
            AND (cm3."senderId" IS NULL OR cm3."senderId" != ${userId})
            AND (cm3."readAt" IS NULL OR NOT jsonb_exists(cm3."readAt", ${userId}))
        ) uc ON true
        LEFT JOIN LATERAL (
          SELECT COUNT(*) AS pinned_count
          FROM chat_messages cm4
          WHERE cm4."roomId" = cr.id AND cm4."isPinned" = true AND cm4."isDeleted" = false
        ) pc ON true
        WHERE cr."deletedAt" IS NULL
          AND (${typeFilter}::text IS NULL OR cr."type" = ${typeFilter}::"ChatRoomType")
          AND (
            cr."initiatorId" = ${userId}
            OR cr."counterpartId" = ${userId}
            -- Room lama yang belum ter-backfill pesertanya (lihat migration
            -- 20260913_chat_trust_safety_and_features).
            OR (cr."initiatorId" IS NULL AND (o."buyerId" = ${userId} OR o."sellerId" = ${userId}))
          )
          AND COALESCE(cm.is_archived, false) = ${archivedOnly}
        ORDER BY cr."updatedAt" DESC
        OFFSET ${skip}
        LIMIT ${safeLimit}
      `,
      this.prisma.$queryRaw<[{ count: bigint }]>`
        SELECT COUNT(*) AS count
        FROM chat_rooms cr
        LEFT JOIN orders o ON o.id = cr."orderId" AND o."deletedAt" IS NULL
        LEFT JOIN chat_room_members cm ON cm."roomId" = cr.id AND cm."userId" = ${userId}
        WHERE cr."deletedAt" IS NULL
          AND (${typeFilter}::text IS NULL OR cr."type" = ${typeFilter}::"ChatRoomType")
          AND (
            cr."initiatorId" = ${userId}
            OR cr."counterpartId" = ${userId}
            OR (cr."initiatorId" IS NULL AND (o."buyerId" = ${userId} OR o."sellerId" = ${userId}))
          )
          AND COALESCE(cm.is_archived, false) = ${archivedOnly}
      `,
    ]);

    const total = Number(countResult[0]?.count ?? 0);

    const otherUserIds = roomRows
      .map((r) => (r.initiator_user_id === userId ? r.counterpart_user_id : r.initiator_user_id))
      .filter((id): id is string => typeof id === 'string' && id !== userId);
    const uniqueOtherIds = [...new Set(otherUserIds)];
    const onlineStatuses = await this.realtime.areUsersOnline(uniqueOtherIds);
    const privacySettings = await this.loadOnlineVisibility(uniqueOtherIds);
    const lastSeenByUser = await this.loadLastSeen(uniqueOtherIds, onlineStatuses, privacySettings);

    const mappedRooms = roomRows.map((r) => {
      const isInitiator = r.initiator_user_id === userId;
      const other = isInitiator
        ? {
            userId: r.counterpart_user_id,
            fullName: r.counterpart_full_name,
            username: r.counterpart_username,
            avatarUrl: r.counterpart_avatar_url,
          }
        : {
            userId: r.initiator_user_id,
            fullName: r.initiator_full_name,
            username: r.initiator_username,
            avatarUrl: r.initiator_avatar_url,
          };
      const otherInternalId = isInitiator ? r.counterpart_user_id : r.initiator_user_id;
      const mutedUntil =
        r.member_muted === true && r.member_muted_until
          ? new Date(r.member_muted_until)
          : null;
      const isMuted =
        r.member_muted === true && (!mutedUntil || mutedUntil.getTime() > Date.now());

      return {
        id: r.room_id,
        type: r.room_type,
        status: r.room_status,
        subject: r.room_subject,
        orderId: r.order_id,
        orderTitle: r.order_title,
        orderStatus: r.order_status,
        isArchived: r.member_archived ?? r.is_archived,
        isMuted,
        mutedUntil,
        initiator: {
          userId: r.initiator_user_id,
          fullName: r.initiator_full_name,
          username: r.initiator_username,
          avatarUrl: r.initiator_avatar_url,
        },
        counterpart: {
          userId: r.counterpart_user_id,
          fullName: r.counterpart_full_name,
          username: r.counterpart_username,
          avatarUrl: r.counterpart_avatar_url,
        },
        otherUser: {
          userId: other.userId,
          fullName: other.fullName,
          username: other.username,
          avatarUrl: other.avatarUrl,
          // Pengaturan privasi lawan bicara dihormati: bila dia menonaktifkan
          // status online, kita tidak pernah melaporkannya sedang online.
          isOnline: otherInternalId
            ? (privacySettings[otherInternalId] !== false && onlineStatuses[otherInternalId] === true)
            : false,
          lastSeenAt: otherInternalId ? lastSeenByUser[otherInternalId] ?? null : null,
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
        pinnedCount: Number(r.pinned_count),
        createdAt: r.room_created_at,
        updatedAt: r.room_updated_at,
      };
    });

    return createPaginatedResponse(mappedRooms, total, safePage, safeLimit);
  }

  private async loadOnlineVisibility(userIds: string[]): Promise<Record<string, boolean>> {
    if (userIds.length === 0) return {};
    try {
      const users = await this.prisma.user.findMany({
        where: { id: { in: userIds } },
        select: { id: true, showOnlineStatus: true },
      });
      return users.reduce<Record<string, boolean>>((acc, user) => {
        acc[user.id] = user.showOnlineStatus;
        return acc;
      }, {});
    } catch {
      return {};
    }
  }

  private async loadLastSeen(
    userIds: string[],
    onlineStatuses: Record<string, boolean>,
    privacySettings: Record<string, boolean>,
  ): Promise<Record<string, Date | null>> {
    const result: Record<string, Date | null> = {};
    for (const id of userIds) {
      if (privacySettings[id] === false) {
        result[id] = null;
        continue;
      }
      result[id] = onlineStatuses[id] ? new Date() : await this.realtime.getLastSeen(id);
    }
    return result;
  }

  /**
   * Status online/last-seen lawan bicara di satu room. Dipisah dari daftar room
   * supaya layar percakapan bisa me-refresh indikator tanpa memuat ulang list.
   */
  async getRoomPresence(userId: string, roomId: string): Promise<object> {
    const room = await this.validateRoomAccess(userId, roomId);
    const counterpartId = this.resolveCounterpart(room, userId);
    if (!counterpartId) {
      return { roomId, userId: null, isOnline: false, lastSeenAt: null };
    }
    const settings = await this.loadOnlineVisibility([counterpartId]);
    const visible = settings[counterpartId] !== false;
    const isOnline = visible && (await this.realtime.isUserOnline(counterpartId));
    const lastSeenAt = !visible ? null : (isOnline ? new Date() : await this.realtime.getLastSeen(counterpartId));
    return { roomId, userId: counterpartId, isOnline, lastSeenAt };
  }

  async setRoomArchived(userId: string, roomId: string, archived: boolean): Promise<object> {
    const room = await this.validateRoomAccess(userId, roomId);
    await this.upsertMembership(room, userId);
    await this.prisma.chatRoomMember.update({
      where: { roomId_userId: { roomId, userId } },
      data: { isArchived: archived, archivedAt: archived ? new Date() : null },
    });
    await this.mirrorArchiveState(roomId);
    return { roomId, isArchived: archived, archivedAt: archived ? new Date() : null };
  }

  async setRoomMuted(userId: string, roomId: string, muted: boolean, durationHours?: number): Promise<object> {
    const room = await this.validateRoomAccess(userId, roomId);
    await this.upsertMembership(room, userId);
    const mutedUntil = muted && durationHours ? new Date(Date.now() + durationHours * 3600_000) : null;
    await this.prisma.chatRoomMember.update({
      where: { roomId_userId: { roomId, userId } },
      data: { isMuted: muted, mutedUntil },
    });
    return { roomId, isMuted: muted, mutedUntil };
  }

  private roleFor(room: RoomContext, userId: string): 'BUYER' | 'SELLER' | 'INITIATOR' | 'COUNTERPART' {
    const isInitiator = room.initiatorId === userId;
    return room.type === 'INQUIRY'
      ? isInitiator
        ? 'INITIATOR'
        : 'COUNTERPART'
      : isInitiator
        ? 'BUYER'
        : 'SELLER';
  }

  private async upsertMembership(room: RoomContext, userId: string): Promise<void> {
    const role = this.roleFor(room, userId);
    await this.prisma.chatRoomMember.upsert({
      where: { roomId_userId: { roomId: room.id, userId } },
      create: { roomId: room.id, userId, role },
      update: {},
      select: { id: true },
    });
  }

  /**
   * Mirror ke `ChatRoom.isArchived` (kolom lama yang bersifat global) supaya
   * kolom itu tidak menjadi data mati: bernilai true hanya bila SEMUA peserta
   * mengarsipkan percakapan.
   */
  private async mirrorArchiveState(roomId: string): Promise<void> {
    const members = await this.prisma.chatRoomMember.findMany({
      where: { roomId },
      select: { isArchived: true },
    });
    const allArchived = members.length > 0 && members.every((m) => m.isArchived);
    await this.prisma.chatRoom.update({
      where: { id: roomId },
      data: { isArchived: allArchived, archivedAt: allArchived ? new Date() : null },
    });
  }

  // ============================================================
  // Pre-transaction (inquiry) rooms
  // ============================================================

  /**
   * Chat pra-transaksi: buyer calon bisa bertanya/nego SEBELUM membuat order
   * dan mengunci dana di escrow. Sebelumnya chat hanya eksis setelah order ada.
   */
  async createInquiry(userId: string, dto: CreateInquiryDto): Promise<object> {
    if (dto.counterpartId === userId) {
      throw new BadRequestException({
        code: ErrorCodes.CHAT_INQUIRY_SELF,
        message: 'You cannot open a conversation with yourself',
      });
    }

    const counterpart = await this.prisma.user.findUnique({
      where: { id: dto.counterpartId },
      select: { id: true, isActive: true, isBanned: true },
    });
    if (!counterpart || !counterpart.isActive || counterpart.isBanned) {
      throw new NotFoundException({
        code: ErrorCodes.CHAT_COUNTERPART_NOT_FOUND,
        message: 'User not found or unavailable',
      });
    }

    await this.assertNotBlocked(userId, dto.counterpartId);

    const activeCount = await this.prisma.chatRoom.count({
      where: {
        type: 'INQUIRY',
        deletedAt: null,
        status: 'ACTIVE',
        OR: [{ initiatorId: userId }, { counterpartId: userId }],
      },
    });
    if (activeCount >= CHAT_INQUIRY_MAX_ACTIVE_PER_USER) {
      throw new BadRequestException({
        code: ErrorCodes.CHAT_INQUIRY_LIMIT_REACHED,
        message: `You cannot open more than ${CHAT_INQUIRY_MAX_ACTIVE_PER_USER} active conversations`,
      });
    }

    // Pasangan disimpan dalam urutan kanonik agar partial unique index
    // (`chat_rooms_inquiry_pair_key`) benar-benar mencegah room ganda.
    const [initiatorId, counterpartId] = [userId, dto.counterpartId].sort();

    let room = await this.prisma.chatRoom.findFirst({
      where: { type: 'INQUIRY', initiatorId, counterpartId, deletedAt: null },
      select: { id: true },
    });

    if (!room) {
      room = await this.prisma.chatRoom.create({
        data: {
          type: 'INQUIRY',
          status: 'ACTIVE',
          initiatorId,
          counterpartId,
          subject: dto.subject ? sanitizeText(dto.subject.trim()).slice(0, 200) : null,
          members: {
            create: [
              { userId: initiatorId, role: 'INITIATOR' },
              { userId: counterpartId, role: 'COUNTERPART' },
            ],
          },
        },
        select: { id: true },
      });
    }

    const context = await this.validateRoomAccess(userId, room.id);
    const message = await this.createMessage(context, userId, {
      messageType: UserChatMessageType.TEXT,
      content: dto.message,
    });

    return {
      room: {
        id: room.id,
        type: 'INQUIRY',
        status: 'ACTIVE',
        subject: dto.subject ? sanitizeText(dto.subject.trim()).slice(0, 200) : null,
        initiatorId,
        counterpartId,
      },
      message,
    };
  }

  // ============================================================
  // Messages
  // ============================================================

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
      messages: responseMessages.map((m) => serializeMessage(m, { viewerId: userId })),
      nextCursor,
      hasMore,
    };
  }

  async sendMessage(userId: string, roomId: string, dto: SendMessageDto): Promise<object> {
    const room = await this.validateRoomAccess(userId, roomId);
    this.validateCanSendMessage(room);

    const recipientId = this.resolveCounterpart(room, userId);
    await this.assertNotBlocked(userId, recipientId);

    return this.createMessage(room, userId, dto);
  }

  /**
   * Jalur pembuatan pesan bersama untuk `sendMessage` dan `createInquiry`.
   * Semua pemeriksaan konten (termasuk moderasi) berada di sini supaya tidak
   * ada jalur yang bisa melewatinya.
   */
  private async createMessage(
    room: RoomContext,
    userId: string,
    dto: {
      messageType?: UserChatMessageType;
      content?: string;
      attachments?: SendMessageDto['attachments'];
      replyToId?: string;
      durationSeconds?: number;
      forwardedFromId?: string;
    },
  ): Promise<object> {
    // Berlaku untuk SEMUA jalur pembuatan pesan (send, forward, inquiry):
    // room yang sudah ditutup tidak boleh menerima pesan baru lagi.
    if (room.status !== 'ACTIVE') {
      throw new BadRequestException({
        code: ErrorCodes.CHAT_ROOM_CLOSED,
        message: 'This conversation has been closed',
      });
    }

    const recipientId = this.resolveCounterpart(room, userId);

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

    if (userMessageType === UserChatMessageType.VOICE) {
      this.validateVoiceNote(dto);
    }

    if (dto.attachments?.length) {
      this.validateAttachments(userId, dto.attachments);
    }

    if (dto.replyToId) {
      const replyTarget = await this.prisma.chatMessage.findFirst({
        where: { id: dto.replyToId, roomId: room.id, isDeleted: false },
        select: { id: true },
      });
      if (!replyTarget) {
        throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Replied-to message not found in this room' });
      }
    }

    /*
     * Moderasi konten (audit 2026-09-13).
     *
     * Sebelumnya teks pesan tidak difilter sama sekali: nomor HP, tautan
     * WhatsApp/Telegram, dan ajakan "lanjut di luar app" lolos begitu saja.
     * Untuk platform escrow ini bukan sekadar masalah etiket — begitu
     * percakapan pindah keluar, proteksi escrow hilang dan sengketa tidak bisa
     * ditindaklanjuti. Detektor juga memindai nama file lampiran, karena
     * "bukti-transfer-0812xxxx.pdf" adalah cara yang sama umumnya untuk
     * menyelundupkan kontak.
     */
    const verdict = dto.content
      ? moderateText(dto.content, { maxAction: this.circumventionAction() })
      : null;

    if (verdict?.blocked) {
      // Pesan tidak disimpan, jadi event moderasi adalah satu-satunya jejak.
      await this.recordModerationEvents({
        room,
        userId,
        verdict,
        messageId: null,
      });
      throw new BadRequestException({
        code: ErrorCodes.CHAT_MESSAGE_BLOCKED,
        message: verdict.blockReason ?? 'Pesan tidak dapat dikirim karena melanggar kebijakan Kahade.',
      });
    }

    const content = verdict && dto.content ? sanitizeText(verdict.text.trim()) : null;
    const attachmentNames = new Map<string, string>();
    if (dto.attachments?.length) {
      for (const attachment of dto.attachments) {
        const nameVerdict = moderateFileName(attachment.fileName);
        if (nameVerdict.matches.length > 0) {
          attachmentNames.set(attachment.fileUrl, nameVerdict.text);
          await this.recordModerationEvents({ room, userId, verdict: nameVerdict, messageId: null });
        }
      }
    }

    const message = await this.prisma.chatMessage.create({
      data: {
        roomId: room.id,
        senderId: userId,
        messageType,
        content: content && content.length > 0 ? content : null,
        durationSeconds: userMessageType === UserChatMessageType.VOICE ? (dto.durationSeconds ?? null) : null,
        replyToId: dto.replyToId || undefined,
        forwardedFromId: dto.forwardedFromId || undefined,
        moderationAction: verdict && verdict.matches.length > 0 ? this.highestAction(verdict) : null,
        moderationSeverity: verdict?.maxSeverity ?? null,
        moderationKind: verdict?.kinds?.[0] ?? null,
        attachments: dto.attachments?.length
          ? {
              create: dto.attachments.map((a) => ({
                fileName: sanitizeText(
                  (attachmentNames.get(a.fileUrl) ?? a.fileName).replace(/[/\\:*?"<>|]/g, '_').replace(/\.\./g, '_'),
                ),
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

    if (verdict && verdict.matches.length > 0) {
      // Di luar jalur utama: kegagalan mencatat tidak boleh menggagalkan kirim.
      void this.recordModerationEvents({ room, userId, verdict, messageId: message.id }).catch((error) => {
        this.logger.warn(`Failed to persist chat moderation events: ${(error as Error).message}`);
      });
    }

    await this.prisma.chatRoom.update({
      where: { id: room.id },
      data: { updatedAt: new Date() },
    });

    const serialized = serializeMessage(message, { viewerId: userId });

    this.emitChatEvent(room, 'chat.new_message', serialized);
    if (recipientId) {
      this.realtime.emitToUser(recipientId, 'chat.new_message', serialized);
      await this.notifyNewMessage(room, recipientId, userId, message.id, dto.content, userMessageType);
    }

    return serialized;
  }

  private highestAction(verdict: ModerationVerdict): ChatModerationAction {
    if (verdict.blocked) return 'BLOCKED' as ChatModerationAction;
    if (verdict.redacted) return 'REDACTED' as ChatModerationAction;
    return 'FLAGGED' as ChatModerationAction;
  }

  private validateVoiceNote(dto: { attachments?: SendMessageDto['attachments']; durationSeconds?: number }): void {
    const attachment = dto.attachments?.[0];
    if (!attachment) {
      throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Voice notes must include an audio attachment' });
    }
    if (!attachment.mimeType?.toLowerCase().startsWith('audio/')) {
      throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Voice notes must use an audio MIME type' });
    }
    const duration = dto.durationSeconds;
    if (
      typeof duration !== 'number' ||
      !Number.isInteger(duration) ||
      duration < CHAT_VOICE_MIN_DURATION_SECONDS ||
      duration > CHAT_VOICE_MAX_DURATION_SECONDS
    ) {
      throw new BadRequestException({
        code: ErrorCodes.VALIDATION_ERROR,
        message: `Voice notes must be between ${CHAT_VOICE_MIN_DURATION_SECONDS} and ${CHAT_VOICE_MAX_DURATION_SECONDS} seconds`,
      });
    }
  }

  private validateAttachments(userId: string, attachments: NonNullable<SendMessageDto['attachments']>): void {
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

    for (const a of attachments) {
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

  private async notifyNewMessage(
    room: RoomContext,
    recipientId: string,
    senderId: string,
    messageId: string,
    rawContent: string | undefined,
    messageType: UserChatMessageType,
  ): Promise<void> {
    try {
      const author = await this.prisma.user.findUnique({
        where: { id: senderId },
        select: { fullName: true, username: true },
      });
      const senderName = author?.fullName || author?.username || 'User';
      const preview = rawContent
        ? sanitizeText(rawContent.slice(0, 80))
        : messageType === UserChatMessageType.VOICE
          ? 'Mengirim pesan suara'
          : 'Sent media';
      // Setiap pesan yang tersimpan adalah event komunikasi yang berbeda. Kunci
      // dedupe lama (room+user per 60 detik) justru menahan pesan kedua.
      const notification = await this.prisma.notification.create({
        data: {
          notifId: generateNotifId(), userId: recipientId,
          type: NotificationType.CHAT_NEW_MESSAGE, category: getCategoryForType(NotificationType.CHAT_NEW_MESSAGE),
          title: `Message from ${senderName}`, body: preview, isRead: false,
          refType: 'CHAT_MESSAGE', refId: messageId,
          actionUrl: `/chat/${encodeURIComponent(room.id)}`,
        },
        select: { notifId: true },
      });
      this.prisma.emitNotificationCreated({
        userId: recipientId,
        title: `Message from ${senderName}`,
        body: preview,
        data: { type: 'CHAT_NEW', notificationType: NotificationType.CHAT_NEW_MESSAGE, notificationId: notification.notifId, chatRoomId: room.id, roomId: room.id },
      });
    } catch (error) {
      // Penyimpanan pesan bersifat otoritatif. Gangguan notifikasi tidak boleh
      // mengubah kirim yang berhasil menjadi kegagalan yang terlihat klien.
      this.logger.warn(`Chat notification side-effect failed for message ${messageId}: ${(error as Error).message}`);
    }
  }

  async editMessage(userId: string, roomId: string, messageId: string, content: string): Promise<object> {
    const room = await this.validateRoomAccess(userId, roomId);

    const message = await this.prisma.chatMessage.findFirst({
      where: { id: messageId, roomId, isDeleted: false },
      select: {
        id: true,
        senderId: true,
        content: true,
        messageType: true,
        createdAt: true,
      },
    });

    if (!message) {
      throw new NotFoundException({ code: ErrorCodes.NOT_FOUND, message: 'Message not found' });
    }
    if (message.senderId !== userId) {
      throw new ForbiddenException({ code: ErrorCodes.FORBIDDEN, message: 'You can only edit your own messages' });
    }
    if (message.messageType !== 'TEXT') {
      throw new BadRequestException({
        code: ErrorCodes.CHAT_MESSAGE_NOT_EDITABLE,
        message: 'Only text messages can be edited',
      });
    }
    await this.assertNotDisputeLocked(room);

    const trimmed = (content ?? '').trim();
    if (!trimmed || trimmed.length > CHAT_MESSAGE_MAX_LENGTH) {
      throw new BadRequestException({
        code: ErrorCodes.VALIDATION_ERROR,
        message: `Message content must contain 1–${CHAT_MESSAGE_MAX_LENGTH} characters`,
      });
    }

    // Konten baru tetap dimoderasi. Tanpa ini, detektor circumvention bisa
    // dilewati dengan mengirim pesan polos lalu menyuntingnya.
    const verdict = moderateText(trimmed, { maxAction: this.circumventionAction() });
    if (verdict.blocked) {
      await this.recordModerationEvents({ room, userId, verdict, messageId: message.id }).catch((error) => {
        this.logger.warn(`Failed to persist chat moderation events: ${(error as Error).message}`);
      });
      throw new BadRequestException({
        code: ErrorCodes.CHAT_MESSAGE_BLOCKED,
        message: verdict.blockReason ?? 'Pesan tidak dapat diubah karena melanggar kebijakan Kahade.',
      });
    }

    const nextContent = sanitizeText(verdict.text.trim());
    if (nextContent === (message.content ?? '')) {
      const unchanged = await this.prisma.chatMessage.findFirst({
        where: { id: messageId, roomId },
        select: MESSAGE_SELECT,
      }) as unknown as RawMessage;
      return serializeMessage(unchanged, { viewerId: userId });
    }

    // Riwayat revisi disimpan DULU: kalau proses terputus di tengah, yang
    // tersisa adalah versi lama yang masih terbaca, bukan bukti yang hilang.
    await this.prisma.chatMessageEdit.create({
      data: {
        messageId: message.id,
        editorId: userId,
        previousContent: message.content ?? null,
      },
      select: { id: true },
    });

    await this.prisma.chatMessage.update({
      where: { id: message.id },
      data: {
        content: nextContent,
        isEdited: true,
        editedAt: new Date(),
        moderationAction: verdict.matches.length > 0 ? this.highestAction(verdict) : null,
        moderationSeverity: verdict.maxSeverity ?? null,
        moderationKind: verdict.kinds?.[0] ?? null,
      },
      select: { id: true },
    });

    const updated = await this.prisma.chatMessage.findFirst({
      where: { id: message.id, roomId },
      select: MESSAGE_SELECT,
    }) as unknown as RawMessage;
    const serialized = serializeMessage(updated, { viewerId: userId });

    this.emitChatEvent(room, 'chat.message_updated', serialized);
    return serialized;
  }

  async deleteMessage(userId: string, roomId: string, messageId: string): Promise<{ message: string }> {
    const room = await this.validateRoomAccess(userId, roomId);

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
     * Kunci bukti saat sengketa (audit 2026-09-13).
     *
     * Pengecekan status order sebelumnya hanya ada di `validateCanSendMessage`,
     * sehingga pesan yang sedang disengketakan bisa dihapus pengirimnya sendiri
     * — ditambah lagi `content` di-null-kan permanen. Resolver dispute lalu
     * kehilangan baris percakapan yang paling menentukan. Sekarang delete
     * ditolak saat order DISPUTED, dan di luar masa sengketa isi aslinya tetap
     * disimpan di `deletedContent` untuk kepentingan audit.
     */
    await this.assertNotDisputeLocked(room);

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
      data: {
        isDeleted: true,
        deletedAt: new Date(),
        deletedById: userId,
        deletedContent: message.content ?? null,
        content: null,
        isPinned: false,
        pinnedAt: null,
        pinnedById: null,
      },
    });

    this.emitChatEvent(room, 'chat.message_deleted', { messageId, roomId });

    return { message: 'Message deleted successfully' };
  }

  async markAsRead(userId: string, roomId: string): Promise<{ markedCount: number }> {
    if (!userId || typeof userId !== 'string' || userId.length < 1) {
      throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Invalid userId format' });
    }
    const room = await this.validateRoomAccess(userId, roomId);

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
      this.emitChatEvent(room, 'chat.read', {
        roomId,
        userId,
        readAt: now,
        markedCount,
      });
    }

    await this.prisma.chatRoomMember.upsert({
      where: { roomId_userId: { roomId, userId } },
      create: { roomId, userId, role: this.roleFor(room, userId), lastReadAt: new Date() },
      update: { lastReadAt: new Date() },
      select: { id: true },
    }).catch(() => undefined);

    return { markedCount };
  }

  // ============================================================
  // Reactions (fitur yang dijanjikan README tapi belum ada)
  // ============================================================

  async addReaction(userId: string, roomId: string, messageId: string, emoji: string): Promise<object> {
    const room = await this.validateRoomAccess(userId, roomId);
    const normalized = this.normalizeEmoji(emoji);

    const message = await this.prisma.chatMessage.findFirst({
      where: { id: messageId, roomId, isDeleted: false },
      select: { id: true },
    });
    if (!message) {
      throw new NotFoundException({ code: ErrorCodes.NOT_FOUND, message: 'Message not found' });
    }

    await this.prisma.chatMessageReaction.upsert({
      where: { messageId_userId_emoji: { messageId, userId, emoji: normalized } },
      create: { messageId, userId, emoji: normalized },
      update: {},
      select: { id: true },
    });

    return this.emitReactionUpdate(room, messageId, userId);
  }

  async removeReaction(userId: string, roomId: string, messageId: string, emoji: string): Promise<object> {
    const room = await this.validateRoomAccess(userId, roomId);
    const normalized = this.normalizeEmoji(emoji);

    await this.prisma.chatMessageReaction.deleteMany({
      where: { messageId, userId, emoji: normalized },
    });

    return this.emitReactionUpdate(room, messageId, userId);
  }

  private normalizeEmoji(raw: string): string {
    const trimmed = (raw ?? '').trim();
    const codePoints = [...trimmed];
    if (codePoints.length === 0 || codePoints.length > 8) {
      throw new BadRequestException({ code: ErrorCodes.CHAT_INVALID_EMOJI, message: 'emoji must be 1–8 characters' });
    }
    if (!/^[\p{Extended_Pictographic}\p{Emoji_Component}0-9#*]+$/u.test(trimmed)) {
      throw new BadRequestException({ code: ErrorCodes.CHAT_INVALID_EMOJI, message: 'emoji must contain only emoji characters' });
    }
    return trimmed;
  }

  private async emitReactionUpdate(room: RoomContext, messageId: string, viewerId: string): Promise<object> {
    const rows = await this.prisma.chatMessageReaction.findMany({
      where: { messageId },
      select: { emoji: true, userId: true, user: { select: { userId: true, fullName: true } } },
      orderBy: { createdAt: 'asc' },
    });
    const payload = {
      roomId: room.id,
      messageId,
      reactions: summarizeReactions(rows as unknown as RawReaction[], viewerId),
    };
    this.emitChatEvent(room, 'chat.reaction_updated', payload);
    return payload;
  }

  // ============================================================
  // Pin message
  // ============================================================

  async pinMessage(userId: string, roomId: string, messageId: string, pinned: boolean): Promise<object> {
    const room = await this.validateRoomAccess(userId, roomId);

    const message = await this.prisma.chatMessage.findFirst({
      where: { id: messageId, roomId, isDeleted: false },
      select: { id: true },
    });
    if (!message) {
      throw new NotFoundException({ code: ErrorCodes.NOT_FOUND, message: 'Message not found' });
    }

    if (pinned) {
      const pinnedCount = await this.prisma.chatMessage.count({
        where: { roomId, isPinned: true, isDeleted: false },
      });
      if (pinnedCount >= CHAT_MAX_PINNED_PER_ROOM) {
        throw new BadRequestException({
          code: ErrorCodes.CHAT_PIN_LIMIT_REACHED,
          message: `A conversation can have at most ${CHAT_MAX_PINNED_PER_ROOM} pinned messages`,
        });
      }
    }

    await this.prisma.chatMessage.update({
      where: { id: messageId },
      data: pinned
        ? { isPinned: true, pinnedAt: new Date(), pinnedById: userId }
        : { isPinned: false, pinnedAt: null, pinnedById: null },
      select: { id: true },
    });

    // Pesan yang dihapus otomatis unpinned (lihat deleteMessage), jadi hitungan
    // di sini selalu konsisten dengan constraint DB.
    const payload = { roomId, messageId, isPinned: pinned, pinnedBy: userId };
    this.emitChatEvent(room, pinned ? 'chat.message_pinned' : 'chat.message_unpinned', payload);
    return payload;
  }

  async listPinnedMessages(userId: string, roomId: string): Promise<object> {
    await this.validateRoomAccess(userId, roomId);
    const messages = await this.prisma.chatMessage.findMany({
      where: { roomId, isPinned: true, isDeleted: false },
      orderBy: { pinnedAt: 'desc' },
      take: CHAT_MAX_PINNED_PER_ROOM,
      select: MESSAGE_SELECT,
    }) as unknown as RawMessage[];
    return {
      roomId,
      messages: messages.map((m) => serializeMessage(m, { viewerId: userId })),
    };
  }

  // ============================================================
  // Forward message
  // ============================================================

  async forwardMessage(userId: string, roomId: string, messageId: string, targetRoomIds: string[]): Promise<object> {
    const room = await this.validateRoomAccess(userId, roomId);

    const message = await this.prisma.chatMessage.findFirst({
      where: { id: messageId, roomId, isDeleted: false },
      select: {
        id: true,
        content: true,
        messageType: true,
        senderId: true,
        durationSeconds: true,
        attachments: {
          select: { fileName: true, fileSize: true, mimeType: true, fileUrl: true, thumbnailUrl: true },
        },
      },
    });
    if (!message) {
      throw new NotFoundException({ code: ErrorCodes.NOT_FOUND, message: 'Message not found' });
    }

    const sourceCounterpart = this.resolveCounterpart(room, userId);
    const targets = [...new Set(targetRoomIds)].filter((id) => id !== roomId);

    if (targets.length === 0) {
      throw new BadRequestException({
        code: ErrorCodes.VALIDATION_ERROR,
        message: 'Forward requires at least one different target room',
      });
    }

    const forwarded: object[] = [];
    const skipped: { roomId: string; reason: string }[] = [];

    for (const targetRoomId of targets) {
      const targetRoom = await this.validateRoomAccess(userId, targetRoomId);
      /*
       * Forward hanya boleh ke room dengan lawan bicara yang SAMA.
       *
       * Tanpa pembatasan ini, alamat pengiriman buyer A bisa diteruskan ke
       * seller B hanya karena keduanya pernah bertransaksi dengan user yang
       * sama — kebocoran data pribadi antar transaksi.
       */
      if (sourceCounterpart && this.resolveCounterpart(targetRoom, userId) !== sourceCounterpart) {
        skipped.push({ roomId: targetRoomId, reason: 'Counterpart is different — forwarding is only allowed between rooms with the same counterpart' });
        continue;
      }
      try {
        this.validateCanSendMessage(targetRoom);
      } catch (error) {
        skipped.push({ roomId: targetRoomId, reason: (error as Error).message });
        continue;
      }

      const created = await this.createMessage(targetRoom, userId, {
        messageType: message.messageType as unknown as UserChatMessageType,
        content: message.content ?? undefined,
        durationSeconds: message.durationSeconds ?? undefined,
        attachments: message.attachments.map((a: ChatAttachmentCopy) => ({
          fileName: a.fileName,
          fileSize: a.fileSize,
          mimeType: a.mimeType,
          fileUrl: a.fileUrl,
          thumbnailUrl: a.thumbnailUrl ?? undefined,
        })),
        forwardedFromId: message.id,
      });
      forwarded.push({ roomId: targetRoomId, message: created });
    }

    if (forwarded.length === 0 && skipped.length > 0) {
      throw new ForbiddenException({
        code: ErrorCodes.CHAT_FORWARD_NOT_ALLOWED,
        message: skipped[0].reason,
      });
    }

    return { sourceMessageId: messageId, forwarded, skipped };
  }

  // ============================================================
  // Search
  // ============================================================

  async searchMessages(
    userId: string,
    roomId: string,
    query: string,
    options: { limit?: number; cursor?: string } = {},
  ): Promise<object> {
    // Validasi input sebelum menyentuh database: query yang terlalu pendek
    // tidak boleh memicu pemeriksaan akses (dan kueri DB) sama sekali.
    const term = this.normalizeSearchTerm(query);
    await this.validateRoomAccess(userId, roomId);
    const safeLimit = Math.min(Math.max(1, options.limit ?? CHAT_SEARCH_DEFAULT_LIMIT), CHAT_SEARCH_MAX_LIMIT);

    const messages = await this.prisma.chatMessage.findMany({
      where: {
        roomId,
        isDeleted: false,
        content: { contains: term, mode: 'insensitive' },
      },
      ...(options.cursor ? { cursor: { id: options.cursor }, skip: 1 } : {}),
      take: safeLimit,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: MESSAGE_SELECT,
    }) as unknown as RawMessage[];

    const hasMore = messages.length === safeLimit;
    const nextCursor = hasMore && messages.length > 0 ? messages[messages.length - 1].id : null;

    return {
      query: term,
      messages: messages.map((m) => serializeMessage(m, { viewerId: userId })),
      nextCursor,
      hasMore,
    };
  }

  /**
   * Pencarian global: mencari kata kunci di seluruh percakapan user sekaligus.
   * Berguna untuk "nomor resi itu dikirim di chat yang mana, ya?".
   */
  async searchAllMessages(
    userId: string,
    query: string,
    options: { limit?: number } = {},
  ): Promise<object> {
    const term = this.normalizeSearchTerm(query);
    const safeLimit = Math.min(Math.max(1, options.limit ?? CHAT_SEARCH_DEFAULT_LIMIT), CHAT_SEARCH_MAX_LIMIT);
    const roomIds = await this.getUserRoomIds(userId);
    if (roomIds.length === 0) {
      return { query: term, results: [] };
    }

    const messages = await this.prisma.chatMessage.findMany({
      where: {
        roomId: { in: roomIds },
        isDeleted: false,
        content: { contains: term, mode: 'insensitive' },
      },
      take: safeLimit,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: {
        ...MESSAGE_SELECT,
        room: {
          select: {
            id: true,
            type: true,
            subject: true,
            initiatorId: true,
            counterpartId: true,
            order: { select: { orderId: true, title: true, status: true } },
          },
        },
      },
    }) as unknown as Array<RawMessage & {
      room: {
        id: string;
        type: string;
        subject: string | null;
        initiatorId: string | null;
        counterpartId: string | null;
        order: { orderId: string; title: string; status: string } | null;
      };
    }>;

    return {
      query: term,
      results: messages.map((message) => ({
        ...serializeMessage(message, { viewerId: userId }),
        room: {
          id: message.room.id,
          type: message.room.type,
          subject: message.room.subject,
          orderId: message.room.order?.orderId ?? null,
          orderTitle: message.room.order?.title ?? null,
          orderStatus: message.room.order?.status ?? null,
        },
      })),
    };
  }

  private normalizeSearchTerm(query: string): string {
    const term = (query ?? '').trim();
    if (term.length < CHAT_SEARCH_MIN_QUERY_LENGTH) {
      throw new BadRequestException({
        code: ErrorCodes.VALIDATION_ERROR,
        message: `Search query must be at least ${CHAT_SEARCH_MIN_QUERY_LENGTH} characters`,
      });
    }
    // Batas panjang melindungi dari pola ILIKE yang mahal pada pesan panjang.
    return term.slice(0, 100);
  }

  private async getUserRoomIds(userId: string): Promise<string[]> {
    const [byParticipant, byOrder] = await Promise.all([
      this.prisma.chatRoom.findMany({
        where: { deletedAt: null, OR: [{ initiatorId: userId }, { counterpartId: userId }] },
        select: { id: true },
      }),
      this.prisma.chatRoom.findMany({
        where: {
          deletedAt: null,
          initiatorId: null,
          order: { OR: [{ buyerId: userId }, { sellerId: userId }] },
        },
        select: { id: true },
      }),
    ]);
    return [...new Set([...byParticipant, ...byOrder].map((r) => r.id))];
  }

  // ============================================================
  // Trust & Safety internals
  // ============================================================

  /**
   * Seberapa keras chat menolak ajakan transaksi di luar aplikasi. Default
   * BLOCKED; bisa diturunkan operator lewat `CHAT_CIRCUMVENTION_ACTION`.
   */
  private circumventionAction(): ModerateOptions['maxAction'] {
    const configured = (this.configService.get<string>('chat.circumventionAction') ?? '').toUpperCase();
    if (configured === 'REDACTED') return 'REDACTED';
    if (configured === 'FLAGGED') return 'FLAGGED';
    return 'BLOCKED';
  }

  /**
   * Simpan jejak moderasi: satu event per matcher yang terpicu. Pesan yang
   * DIBLOKIR tidak tersimpan, sehingga tanpa baris ini kita tidak pernah tahu
   * berapa banyak percobaan circumvention yang dicegah.
   */
  private async recordModerationEvents(params: {
    room: RoomContext;
    userId: string;
    verdict: ModerationVerdict;
    messageId: string | null;
  }): Promise<void> {
    const { room, userId, verdict, messageId } = params;
    if (!verdict.matches.length) return;

    const byMatcher = new Map<string, {
      kind: ChatModerationKind;
      severity: ChatModerationSeverity;
      action: ChatModerationAction;
      matchers: string[];
      snippet: string | null;
    }>();

    for (const match of verdict.matches) {
      const existing = byMatcher.get(match.matcher);
      const matchers = [match.matcher, ...(match.absorbedMatchers ?? [])];
      if (!existing) {
        byMatcher.set(match.matcher, {
          kind: match.kind as ChatModerationKind,
          severity: match.severity as ChatModerationSeverity,
          action: match.action as ChatModerationAction,
          matchers,
          snippet: match.snippet?.slice(0, 280) ?? null,
        });
        continue;
      }
      existing.matchers = [...new Set([...existing.matchers, ...matchers])];
    }

    for (const entry of byMatcher.values()) {
      await this.prisma.chatModerationEvent.create({
        data: {
          eventId: generateNotifId(),
          roomId: room.id,
          messageId,
          userId,
          kind: entry.kind,
          severity: entry.severity,
          action: entry.action,
          matchers: entry.matchers as unknown as Prisma.InputJsonValue,
          snippet: entry.snippet,
        },
        select: { id: true },
      });
    }

    this.logger.warn(
      `Chat moderation [${[...byMatcher.values()].map((e) => `${e.action}/${e.severity}`).join(', ')}] ` +
      `user=${userId} room=${room.id} message=${messageId ?? 'blocked'}`,
    );
  }

  /**
   * Pesan terkunci saat sengketa berlangsung. Dipakai delete DAN edit, karena
   * keduanya bisa dipakai untuk mengubah barang bukti percakapan.
   */
  private async assertNotDisputeLocked(room: RoomContext): Promise<void> {
    if (!(await this.isDisputeLocked(room))) return;
    throw new ForbiddenException({
      code: ErrorCodes.CHAT_MESSAGE_LOCKED_DISPUTE,
      message: 'Pesan tidak dapat diubah atau dihapus selama order dalam status sengketa — percakapan ini adalah bukti untuk tim dispute Kahade.',
    });
  }

  async isDisputeLocked(room: RoomContext): Promise<boolean> {
    if (!room.order) return false;
    if (room.order.status === 'DISPUTED') return true;
    // Belt-and-braces: bila status order belum berubah (race, atau data lama),
    // baris dispute yang belum terselesaikan tetap mengunci percakapan.
    const dispute = await this.prisma.dispute.findFirst({
      where: { orderId: room.order.id, status: { not: 'RESOLVED' } },
      select: { id: true },
    });
    return dispute !== null;
  }

  private async assertNotBlocked(userId: string, counterpartId: string | null): Promise<void> {
    if (!counterpartId) return;
    const block = await this.prisma.blockList.findFirst({
      where: {
        OR: [
          { blockerId: userId, blockedId: counterpartId },
          { blockerId: counterpartId, blockedId: userId },
        ],
      },
      select: { id: true },
    });
    if (block) {
      throw new ForbiddenException({ code: ErrorCodes.FORBIDDEN, message: 'Cannot send messages — one party has blocked the other' });
    }
  }

  // ============================================================
  // Attachments
  // ============================================================

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

  // ============================================================
  // Admin / dispute resolver view
  // ============================================================

  /**
   * Baca percakapan untuk keperluan admin & resolver dispute, TERMASUK isi
   * asli pesan yang sudah dihapus (`deletedContent`).
   *
   * Pesan terhapus otomatis tersembunyi dari kueri Prisma biasa (middleware
   * soft delete), jadi butuh kueri khusus dengan `deletedAt` eksplisit.
   */
  async getRoomMessagesForAdmin(
    roomId: string,
    options: { limit?: number; cursor?: string; includeDeleted?: boolean } = {},
  ): Promise<object> {
    const safeLimit = Math.min(Math.max(1, options.limit ?? 50), 100);
    const includeDeleted = options.includeDeleted === true;

    const where: Record<string, unknown> = { roomId };
    if (!includeDeleted) where.isDeleted = false;

    const messages = await this.prisma.chatMessage.findMany({
      where,
      ...(options.cursor ? { cursor: { id: options.cursor }, skip: 1 } : {}),
      take: safeLimit,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: {
        ...MESSAGE_SELECT,
        deletedContent: true,
        deletedById: true,
        editHistory: {
          select: { id: true, previousContent: true, createdAt: true, editorId: true },
          orderBy: { createdAt: 'desc' },
        },
      },
    }) as unknown as RawMessage[];

    const hasMore = messages.length === safeLimit;
    const nextCursor = hasMore && messages.length > 0 ? messages[messages.length - 1].id : null;

    return {
      messages: messages.reverse().map((m) => serializeMessage(m, { includeDeletedContent: true })),
      nextCursor,
      hasMore,
    };
  }

  // ============================================================
  // Authorization helpers
  // ============================================================

  async validateRoomAccess(userId: string, roomId: string): Promise<RoomContext> {
    const room = await this.prisma.chatRoom.findUnique({
      where: { id: roomId, deletedAt: null },
      select: {
        id: true,
        type: true,
        status: true,
        subject: true,
        initiatorId: true,
        counterpartId: true,
        order: {
          select: {
            id: true,
            orderId: true,
            status: true,
            completedAt: true,
            cancelledAt: true,
            buyerId: true,
            sellerId: true,
            deletedAt: true,
          },
        },
      },
    });

    if (!room) {
      throw new NotFoundException({
        code: ErrorCodes.NOT_FOUND,
        message: 'Chat room not found',
      });
    }

    if (room.order?.deletedAt) {
      throw new NotFoundException({
        code: ErrorCodes.NOT_FOUND,
        message: 'Chat room not found',
      });
    }

    const participants = [room.initiatorId, room.counterpartId].filter(
      (id): id is string => typeof id === 'string' && id.length > 0,
    );
    const effectiveParticipants =
      participants.length === 2 ? participants : [room.order?.buyerId, room.order?.sellerId].filter(Boolean) as string[];

    if (!effectiveParticipants.includes(userId)) {
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

    return {
      id: room.id,
      type: room.type,
      status: room.status,
      subject: room.subject,
      initiatorId: room.initiatorId,
      counterpartId: room.counterpartId,
      participants: effectiveParticipants,
      order: room.order
        ? {
            id: room.order.id,
            orderId: room.order.orderId,
            status: room.order.status,
            completedAt: room.order.completedAt,
            cancelledAt: room.order.cancelledAt,
            buyerId: room.order.buyerId,
            sellerId: room.order.sellerId,
          }
        : null,
    };
  }

  private resolveCounterpart(room: RoomContext, userId: string): string | null {
    if (room.initiatorId && room.counterpartId) {
      return room.initiatorId === userId ? room.counterpartId : room.initiatorId;
    }
    if (room.order) {
      return room.order.buyerId === userId ? room.order.sellerId : room.order.buyerId;
    }
    return room.participants.find((id) => id !== userId) ?? null;
  }

  /**
   * Kirim event ke semua alamat yang relevan: `chat:<roomId>` selalu (satu-satunya
   * alamat yang ada untuk room INQUIRY) dan `order:<orderId>` bila room melekat
   * pada order (event order lama tetap berfungsi).
   */
  private emitChatEvent(room: RoomContext, event: string, payload: unknown): void {
    this.realtime.emitToChatRoom(room.id, event, payload);
    if (room.order?.orderId) {
      this.realtime.emitToOrder(room.order.orderId, event, payload);
    }
  }

  private validateCanSendMessage(room: RoomContext): void {
    // Room INQUIRY tidak punya order: percakapan pra-transaksi selalu terbuka
    // selama room-nya aktif.
    if (!room.order) {
      if (room.status !== 'ACTIVE') {
        throw new BadRequestException({
          code: ErrorCodes.CHAT_ROOM_CLOSED,
          message: 'This conversation has been closed',
        });
      }
      return;
    }

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
