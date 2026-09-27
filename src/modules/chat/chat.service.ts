import { Injectable, NotFoundException, ForbiddenException, BadRequestException, ConflictException, Logger, Optional, Inject, forwardRef, OnModuleInit, HttpException, HttpStatus } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { UploadService } from '../upload/upload.service';
import { PrismaService } from '../../prisma/prisma.service';
import { RealtimeService } from '../realtime/realtime.service';
import { SendMessageDto, UserChatMessageType } from './dto/send-message.dto';
import type { CreateInquiryDto } from './dto/create-inquiry.dto';
import type { UpdateChatPrivacyDto } from './dto/chat-privacy.dto';
import type { CreatePollDto } from './dto/poll.dto';
import type { CreateReplyTemplateDto, UpdateReplyTemplateDto } from './dto/reply-template.dto';
import type { CreateOrderFromChatDto } from './dto/create-order-from-chat.dto';
import type { ReportRoomDto } from './dto/room-report-pin.dto';
import { ChatMessageType, ChatModerationAction, ChatModerationKind, ChatModerationSeverity, DmPolicy, NotificationType, OrderStatus, Prisma, ReportCategory } from '@prisma/client';
import { OrdersService } from '../orders/orders.service';
import { TranslationService } from './translation/translation.service';
import { ChatOrderHooks, ChatOrderEventKind, ChatOrderEventData } from './chat-order-hooks';
import { generateNotifId } from '../../common/utils/id-generator.util';
import { getCategoryForType } from '../notifications/notification-category.map';
import * as path from 'path';
import * as ErrorCodes from '../../common/constants/error-codes';
import {
  CHAT_EPHEMERAL_TTL_MIN_SECONDS,
  CHAT_EPHEMERAL_TTL_MAX_SECONDS,
  CHAT_VIEW_ONCE_GRACE_SECONDS,
  CHAT_EXPORT_MAX_MESSAGES,
  CHAT_POLL_MIN_OPTIONS,
  CHAT_POLL_MAX_OPTIONS,
  CHAT_POLL_QUESTION_MAX_LENGTH,
  CHAT_MAX_REPLY_TEMPLATES_PER_USER,
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
import { VerificationBadgeService } from '../users/verification-badge.service';
import { NotificationsService } from '../notifications/notifications.service';
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
  // Batch 43 BE-CHAT: pesan sementara/sekali-lihat, lokasi, kartu.
  ephemeralTtlSeconds: true,
  expiresAt: true,
  viewOnce: true,
  viewOnceViewedAt: true,
  locationLat: true,
  locationLng: true,
  locationLabel: true,
  cardSnapshot: true,
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
} satisfies Prisma.ChatMessageSelect;

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
  // Batch 43 BE-CHAT.
  ephemeralTtlSeconds: number | null;
  expiresAt: Date | null;
  viewOnce: boolean;
  viewOnceViewedAt: Date | null;
  locationLat: number | null;
  locationLng: number | null;
  locationLabel: string | null;
  cardSnapshot: unknown;
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
  /**
   * Batch 43 BE-CHAT: id user yang mengaktifkan hideReadReceipts. Entri
   * readAt milik mereka disembunyikan dari viewer lain (kecuali dirinya
   * sendiri) — "centang baca tidak dikirim ke lawan bicara".
   */
  hiddenReaders?: Set<string>;
}

/**
 * Batch 43 BE-CHAT: saring blob readAt agar pembaca yang menyembunyikan
 * centang baca tidak terlihat oleh viewer lain.
 */
export function filterReadAtForViewer(
  readAt: unknown,
  viewerId: string | null | undefined,
  hiddenReaders?: Set<string>,
): unknown {
  if (!readAt || typeof readAt !== 'object' || !hiddenReaders || hiddenReaders.size === 0) {
    return readAt;
  }
  const out: Record<string, unknown> = {};
  for (const [readerId, value] of Object.entries(readAt as Record<string, unknown>)) {
    if (hiddenReaders.has(readerId) && readerId !== viewerId) continue;
    out[readerId] = value;
  }
  return out;
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
    readAt: filterReadAtForViewer(msg.readAt, options.viewerId, options.hiddenReaders),
    // Batch 43 BE-CHAT: pesan sementara/sekali-lihat, lokasi, kartu.
    ephemeralTtlSeconds: msg.ephemeralTtlSeconds ?? null,
    expiresAt: msg.expiresAt ?? null,
    viewOnce: msg.viewOnce ?? false,
    viewOnceViewedAt: msg.viewOnceViewedAt ?? null,
    location:
      msg.messageType === 'LOCATION' && msg.locationLat != null && msg.locationLng != null
        ? { lat: msg.locationLat, lng: msg.locationLng, label: msg.locationLabel ?? null }
        : null,
    card: (msg.cardSnapshot as Record<string, unknown> | null) ?? null,
    createdAt: msg.createdAt,
    updatedAt: msg.updatedAt,
    attachments: msg.isDeleted ? [] : msg.attachments,
    replyToId: msg.replyToId ?? null,
    replyTo,
    // R1 (2026-09-26): frontend butuh tahu apakah pesan dari user sendiri
    // untuk menentukan arah bubble (outgoing/incoming).
    fromUser: options.viewerId ? msg.sender?.id === options.viewerId : false,
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
export class ChatService implements OnModuleInit {
  private readonly logger = new Logger(ChatService.name);
  constructor(
    private prisma: PrismaService,
    private realtime: RealtimeService,
    private configService: ConfigService,
    private verificationBadgeService: VerificationBadgeService,
    private notificationsService: NotificationsService,
    @Optional() private uploadService?: UploadService,
    // Batch 43 BE-CHAT: buat order escrow dari chat — forwardRef agar tidak
    // circular dengan OrdersModule; @Optional supaya chat tetap jalan bila
    // OrdersService tidak ter-resolve (fail closed di createOrderFromChat).
    @Inject(forwardRef(() => OrdersService)) @Optional() private ordersService?: OrdersService,
    // @Optional: test lama & konteks tanpa provider tetap jalan; translate
    // fail-closed 501 bila tidak ada.
    @Optional() private translationService?: TranslationService,
  ) {}

  async onModuleInit(): Promise<void> {
    // Batch 43 BE-CHAT: daftarkan handler pesan sistem untuk event order
    // (bayar diterima, resi diupload, dikirim, dana cair) + arsip otomatis.
    ChatOrderHooks.register((orderId, kind, data) => this.handleOrderEvent(orderId, kind, data));
  }

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
        initiator_user_id: string | null; initiator_internal_id: string | null; initiator_full_name: string | null;
        initiator_username: string | null; initiator_avatar_url: string | null;
        counterpart_user_id: string | null; counterpart_internal_id: string | null; counterpart_full_name: string | null;
        counterpart_username: string | null; counterpart_avatar_url: string | null;
        last_msg_id: string | null; last_msg_content: string | null; last_msg_type: string | null;
        last_msg_sender_user_id: string | null; last_msg_sender_internal_id: string | null; last_msg_created_at: Date | null;
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
          cm."isArchived" AS member_archived,
          cm."isMuted" AS member_muted,
          cm."mutedUntil" AS member_muted_until,
          o."orderId" AS order_id,
          o.title AS order_title,
          o.status AS order_status,
          iu.id AS initiator_internal_id,
          iu."userId" AS initiator_user_id,
          iu."fullName" AS initiator_full_name,
          iu.username AS initiator_username,
          iu."avatarUrl" AS initiator_avatar_url,
          cu.id AS counterpart_internal_id,
          cu."userId" AS counterpart_user_id,
          cu."fullName" AS counterpart_full_name,
          cu.username AS counterpart_username,
          cu."avatarUrl" AS counterpart_avatar_url,
          lm.id AS last_msg_id,
          lm.content AS last_msg_content,
          lm."messageType" AS last_msg_type,
          lm_sender."userId" AS last_msg_sender_user_id,
          lm_sender.id AS last_msg_sender_internal_id,
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
          AND COALESCE(cm."isArchived", false) = ${archivedOnly}
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
          AND COALESCE(cm."isArchived", false) = ${archivedOnly}
      `,
    ]);

    const total = Number(countResult[0]?.count ?? 0);

    const otherUserIds = roomRows
      .map((r) => (r.initiator_internal_id === userId ? r.counterpart_internal_id : r.initiator_internal_id))
      .filter((id): id is string => typeof id === 'string' && id !== userId);
    const uniqueOtherIds = [...new Set(otherUserIds)];
    const onlineStatuses = await this.realtime.areUsersOnline(uniqueOtherIds);
    const privacySettings = await this.loadOnlineVisibility(uniqueOtherIds);
    const lastSeenByUser = await this.loadLastSeen(uniqueOtherIds, onlineStatuses, privacySettings);
    // R1 (audit 2026-09-26): sealTier lawan bicara disematkan agar frontend
    // bisa render <VerifiedSeal> di daftar & header chat tanpa N+1.
    const sealTierMap = await this.verificationBadgeService.getSealTierMap(uniqueOtherIds);

    const mappedRooms = roomRows.map((r) => {
      const isInitiator = r.initiator_internal_id === userId;
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
      const otherInternalId = isInitiator ? r.counterpart_internal_id : r.initiator_internal_id;
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
          sealTier: otherInternalId ? (sealTierMap.get(otherInternalId) ?? null) : null,
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
              // CN-001: penanda sudut pandang agar frontend bisa render prefix
              // "Anda:" — bandingkan internal id (namespace yang sama dengan userId viewer).
              fromUser: r.last_msg_sender_internal_id != null && r.last_msg_sender_internal_id === userId,
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

  // ============================================================
  // Item 7 (batch 2026-09-28) — Hapus room 1-by-1, TANPA bulk.
  //
  // Semantik hapus:
  // - Room DM/INQUIRY tanpa transaksi (orderId NULL): HARD DELETE permanen
  //   untuk kedua anggota — pesan & keanggotaan ikut terhapus (cascade).
  //   Order yang pernah lahir dari inquiry ini TIDAK ikut terhapus
  //   (FK SetNull), hanya konteks nego yang hilang.
  // - Room ORDER (terikat transaksi): hanya boleh dihapus bila order sudah
  //   terminal COMPLETED, dan itu pun SOFT DELETE (deletedAt) — riwayat
  //   percakapan dipertahankan sebagai jejak audit transaksi keuangan.
  //   Order berstatus selain COMPLETED (termasuk CANCELLED/DISPUTED) → 409
  //   CHAT_ROOM_DELETE_ORDER_NOT_COMPLETED (fail closed).
  //
  // Auth: hanya anggota room (validateRoomAccess → 404 bila room tidak ada /
  // sudah dihapus, 403 bila bukan anggota).
  // ============================================================
  async deleteRoom(userId: string, roomId: string): Promise<{ deleted: boolean; roomId: string; permanent: boolean }> {
    const room = await this.validateRoomAccess(userId, roomId);

    if (room.order) {
      // Aturan keras: room transaksi hanya boleh dihapus bila order terminal COMPLETED.
      if (room.order.status !== OrderStatus.COMPLETED) {
        throw new ConflictException({
          code: ErrorCodes.CHAT_ROOM_DELETE_ORDER_NOT_COMPLETED,
          message: 'Room transaksi hanya dapat dihapus setelah order berstatus COMPLETED',
        });
      }
      await this.prisma.chatRoom.update({
        where: { id: roomId },
        data: { deletedAt: new Date(), status: 'CLOSED' },
      });
      this.logger.log(`Chat room ${roomId} (order ${room.order.orderId}) soft-deleted oleh anggota ${userId}`);
      return { deleted: true, roomId, permanent: false };
    }

    // DM/INQUIRY tanpa transaksi: hapus permanen (cascade ke pesan & member).
    await this.prisma.chatRoom.delete({ where: { id: roomId } });
    this.logger.log(`Chat room ${roomId} (tanpa transaksi) dihapus permanen oleh anggota ${userId}`);
    return { deleted: true, roomId, permanent: true };
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
      // Batch 43 BE-CHAT: tegakkan kebijakan DM pemilik lawan bicara — hanya
      // saat room BARU dibuat (percakapan lama tidak diputus).
      await this.assertDmAllowed(userId, dto.counterpartId);
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
  // PRF-002 — DM get-or-create tanpa pesan pertama
  // ============================================================

  /**
   * Buka (atau pakai ulang) room DM dengan user lain — tanpa pesan pertama.
   * Dipakai tombol "Kirim Pesan" di profil (perilaku WhatsApp).
   *
   * Room bertipe INQUIRY seperti jalur nego pra-transaksi, supaya taksonomi
   * room tidak berubah dan tidak perlu migrasi. Bedanya dengan
   * `createInquiry`: tidak ada pesan pertama yang wajib diisi dan tidak ada
   * moderasi pesan — room boleh kosong sampai salah satu pihak mengirim.
   */
  async getOrCreateDm(userId: string, username: string): Promise<object> {
    const normalized = username.toLowerCase();
    const counterpart = await this.prisma.user.findUnique({
      where: { username: normalized },
      select: { id: true, isActive: true, isBanned: true },
    });
    if (!counterpart || !counterpart.isActive || counterpart.isBanned) {
      throw new NotFoundException({
        code: ErrorCodes.CHAT_COUNTERPART_NOT_FOUND,
        message: 'User not found or unavailable',
      });
    }
    if (counterpart.id === userId) {
      throw new BadRequestException({
        code: ErrorCodes.CHAT_INQUIRY_SELF,
        message: 'You cannot open a conversation with yourself',
      });
    }

    await this.assertNotBlocked(userId, counterpart.id);

    // Pasangan disimpan dalam urutan kanonik agar partial unique index
    // (`chat_rooms_inquiry_pair_key`) benar-benar mencegah room ganda.
    const [initiatorId, counterpartId] = [userId, counterpart.id].sort();

    let room = await this.prisma.chatRoom.findFirst({
      where: { type: 'INQUIRY', initiatorId, counterpartId, deletedAt: null },
      select: { id: true, status: true },
    });

    if (!room) {
      // Batasi pembuatan room baru (anti-spam), sama seperti inquiry.
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
      // Batch 43 BE-CHAT: tegakkan kebijakan DM (lihat createInquiry).
      await this.assertDmAllowed(userId, counterpart.id);
      room = await this.prisma.chatRoom.create({
        data: {
          type: 'INQUIRY',
          status: 'ACTIVE',
          initiatorId,
          counterpartId,
          members: {
            create: [
              { userId: initiatorId, role: 'INITIATOR' },
              { userId: counterpartId, role: 'COUNTERPART' },
            ],
          },
        },
        select: { id: true, status: true },
      });
    }

    return {
      room: {
        id: room.id,
        type: 'INQUIRY',
        status: room.status,
        initiatorId,
        counterpartId,
      },
    };
  }

  // ============================================================
  // Messages
  // ============================================================

  async getMessages(userId: string, roomId: string, cursor?: string, limit: number = 50, excludeIds?: string[]): Promise<object> {
    const room = await this.validateRoomAccess(userId, roomId);

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

    // Batch 43 BE-CHAT: sembunyikan entri readAt milik user yang mengaktifkan
    // hideReadReceipts dari viewer lain.
    const hiddenReaders = await this.loadHiddenReadReceiptUserIds(
      messages.flatMap((m) => Object.keys((m.readAt as Record<string, unknown> | null) ?? {})),
    );

    // Batch 43 BE-CHAT: pesan sekali-lihat dikonsumsi saat dibaca lawan bicara.
    // Setelah dikonsumsi, pesan diberi masa tenggang singkat lalu dihapus
    // permanen oleh worker purge.
    const consumedViewOnce: string[] = [];
    const now = new Date();
    for (const message of messages) {
      if (
        message.viewOnce &&
        !message.viewOnceViewedAt &&
        !message.isDeleted &&
        message.sender?.id &&
        message.sender.id !== userId
      ) {
        consumedViewOnce.push(message.id);
      }
    }
    if (consumedViewOnce.length > 0) {
      const graceUntil = new Date(now.getTime() + CHAT_VIEW_ONCE_GRACE_SECONDS * 1000);
      await this.prisma.chatMessage.updateMany({
        where: { id: { in: consumedViewOnce }, viewOnceViewedAt: null },
        data: { viewOnceViewedAt: now, expiresAt: graceUntil },
      });
      for (const messageId of consumedViewOnce) {
        this.emitChatEvent(room, 'chat.message_view_once_consumed', { roomId, messageId, viewerId: userId });
      }
    }

    const responseMessages = await Promise.all(messages.map(async (message) => ({
      ...message,
      attachments: await Promise.all(message.attachments.map(async (attachment) => ({
        ...attachment,
        fileUrl: await this.toReadableAttachmentUrl(attachment.fileUrl),
        thumbnailUrl: attachment.thumbnailUrl ? await this.toReadableAttachmentUrl(attachment.thumbnailUrl) : null,
      }))),
    })));

    return {
      messages: responseMessages.map((m) => serializeMessage(m, { viewerId: userId, hiddenReaders })),
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
      caption?: string;
      attachments?: SendMessageDto['attachments'];
      replyToId?: string;
      durationSeconds?: number;
      forwardedFromId?: string;
      // Batch 43 BE-CHAT: pesan lokasi / kartu / sementara / sekali lihat.
      location?: SendMessageDto['location'];
      showcaseId?: string;
      orderId?: string;
      ephemeralTtlSeconds?: number;
      viewOnce?: boolean;
      /**
       * Internal: true bila lampiran disalin dari pesan yang sudah tersimpan
       * dan tervalidasi di DB (forward). Cek ownership path dilewati karena
       * file milik pengirim asli; cek trusted-host + MIME tetap berlaku.
       */
      skipAttachmentOwnershipCheck?: boolean;
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
    // 15.3 caption support: allow caption as content for media messages
    const effectiveContent = (dto.content?.trim() ? dto.content : (dto as any).caption) as string | undefined;

    if (userMessageType === UserChatMessageType.TEXT && (!effectiveContent || effectiveContent.trim().length === 0)) {
      throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Text messages must have non-empty content' });
    }

    if (effectiveContent && effectiveContent.length > CHAT_MESSAGE_MAX_LENGTH) {
      throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: `Message content must not exceed ${CHAT_MESSAGE_MAX_LENGTH} characters` });
    }

    // Batch 43 BE-CHAT: tipe non-media baru (lokasi/kartu) tidak butuh lampiran.
    const isCardOrLocationType =
      userMessageType === UserChatMessageType.LOCATION ||
      userMessageType === UserChatMessageType.PRODUCT_CARD ||
      userMessageType === UserChatMessageType.ORDER_CARD;

    if (userMessageType !== UserChatMessageType.TEXT && !isCardOrLocationType && (!dto.attachments || dto.attachments.length === 0)) {
      throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Media messages must include at least one attachment' });
    }

    if (userMessageType === UserChatMessageType.VOICE) {
      this.validateVoiceNote(dto);
    }

    // Batch 43 BE-CHAT: validasi pesan lokasi.
    let locationData: { lat: number; lng: number; label: string | null } | null = null;
    if (userMessageType === UserChatMessageType.LOCATION) {
      locationData = this.validateLocationMessage(dto.location);
    }

    // Batch 43 BE-CHAT: validasi kartu produk/order + snapshot saat kirim.
    let cardSnapshot: Record<string, unknown> | null = null;
    if (userMessageType === UserChatMessageType.PRODUCT_CARD) {
      cardSnapshot = await this.buildProductCardSnapshot(dto.showcaseId, room, userId);
    } else if (userMessageType === UserChatMessageType.ORDER_CARD) {
      cardSnapshot = await this.buildOrderCardSnapshot(dto.orderId, userId);
    }

    // Batch 43 BE-CHAT: pesan sementara/sekali-lihat.
    // Fail closed untuk bukti sengketa: tidak boleh dipakai saat order DISPUTED.
    const ephemeralTtlSeconds = dto.ephemeralTtlSeconds ?? null;
    const viewOnce = dto.viewOnce === true;
    if (ephemeralTtlSeconds != null || viewOnce) {
      await this.assertNotDisputeLocked(room);
      if (ephemeralTtlSeconds != null) {
        if (
          !Number.isInteger(ephemeralTtlSeconds) ||
          ephemeralTtlSeconds < CHAT_EPHEMERAL_TTL_MIN_SECONDS ||
          ephemeralTtlSeconds > CHAT_EPHEMERAL_TTL_MAX_SECONDS
        ) {
          throw new BadRequestException({
            code: ErrorCodes.VALIDATION_ERROR,
            message: `ephemeralTtlSeconds must be between ${CHAT_EPHEMERAL_TTL_MIN_SECONDS} and ${CHAT_EPHEMERAL_TTL_MAX_SECONDS} seconds`,
          });
        }
      }
    }
    const expiresAt =
      ephemeralTtlSeconds != null
        ? new Date(Date.now() + ephemeralTtlSeconds * 1000)
        : viewOnce
          ? new Date(Date.now() + 30 * 24 * 60 * 60 * 1000) // backstop: 30 hari bila tak pernah dibaca
          : null;

    if (dto.attachments?.length) {
      this.validateAttachments(userId, dto.attachments, dto.skipAttachmentOwnershipCheck === true);
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
     *
     * Batch 43 BE-CHAT: label lokasi dimoderasi seperti konten teks (jalur
     * yang sama untuk menyelundupkan kontak).
     */
    const moderationTarget = effectiveContent ?? locationData?.label ?? null;
    const verdict = moderationTarget
      ? moderateText(moderationTarget, { maxAction: this.circumventionAction() })
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

    const content = verdict && effectiveContent ? sanitizeText(verdict.text.trim()) : null;
    if (locationData && verdict && locationData.label) {
      locationData = { ...locationData, label: sanitizeText(verdict.text.trim()).slice(0, 200) || null };
    }
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
        // Batch 43 BE-CHAT.
        ephemeralTtlSeconds,
        expiresAt,
        viewOnce,
        locationLat: locationData?.lat ?? null,
        locationLng: locationData?.lng ?? null,
        locationLabel: locationData?.label ?? null,
        cardSnapshot: (cardSnapshot ?? undefined) as Prisma.InputJsonValue | undefined,
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

    // CN-004: serialisasi per penerima — fromUser & reactedByMe dihitung dari
    // sudut pandang masing-masing viewer. Payload tunggal bersudut-pandang
    // pengirim membuat penerima me-render pesan masuk sebagai pesan keluar.
    const senderView = serializeMessage(message, { viewerId: userId });
    const recipientView = recipientId ? serializeMessage(message, { viewerId: recipientId }) : null;
    // Room broadcast memakai payload netral (tanpa viewerId) agar tidak
    // menyesatkan; klien menentukan sudut pandang dari senderId.
    const neutralView = serializeMessage(message, {});

    this.emitChatEvent(room, 'chat.new_message', neutralView);
    // Sinkron multi-perangkat pengirim.
    this.realtime.emitToUser(userId, 'chat.new_message', senderView);
    if (recipientId && recipientView) {
      this.realtime.emitToUser(recipientId, 'chat.new_message', recipientView);
      // Preview notifikasi memakai teks PASCA-moderasi (content) agar hasil
      // redaksi (mis. nomor HP tersensor) tidak bocor lewat push.
      await this.notifyNewMessage(room, recipientId, userId, message.id, content || effectiveContent, userMessageType);
    }

    return senderView;
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

  // Batch 1A (ST-004): ekstrak fileKey dari stable storage URL
  // (https://api.kahade.id/uploads/chat-attachments/<userId>/<file>)
  // atau dari raw key. Dipakai untuk normalisasi persist + signing saat baca.
  private extractChatFileKey(rawUrl: string): string | null {
    if (!rawUrl || typeof rawUrl !== 'string') return null;
    if (rawUrl.startsWith('uploads/')) return rawUrl;
    try {
      const parsed = new URL(rawUrl);
      const storagePublicUrl = this.configService.get<string>('app.storagePublicUrl') || 'https://api.kahade.id/uploads';
      const base = new URL(storagePublicUrl);
      if (parsed.hostname !== base.hostname) return null;
      // pathname: /uploads/chat-attachments/<userId>/<file>
      const prefix = base.pathname.replace(/\/+$/, '');
      let rel = decodeURIComponent(parsed.pathname);
      if (prefix && rel.startsWith(prefix)) rel = rel.slice(prefix.length);
      rel = rel.replace(/^\/+/, '');
      if (!rel.startsWith('uploads/')) rel = `uploads/${rel}`;
      return rel;
    } catch {
      return null;
    }
  }

  // Batch 1A (ST-004): normalisasi URL lampiran menjadi stable storage URL
  // sebelum persist. Klien mungkin mengirim signed URL dari /v1/chat/upload
  // (untuk preview langsung) — signed URL kedaluwarsa dan TIDAK BOLEH
  // dipersist. Verifikasi signature, lalu simpan bentuk stabilnya.
  private normalizeAttachmentUrl(userId: string, rawUrl: string, label: string): string {
    try {
      const parsed = new URL(rawUrl);
      const apiHost = (() => {
        try {
          const storagePublicUrl = this.configService.get<string>('app.storagePublicUrl') || 'https://api.kahade.id/uploads';
          return new URL(storagePublicUrl.replace(/\/uploads\/?$/, '')).hostname;
        } catch { return null; }
      })();
      if (apiHost && parsed.hostname === apiHost && parsed.pathname === '/v1/upload/s') {
        if (!this.uploadService) {
          throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: `${label} cannot be verified (storage unavailable)` });
        }
        const params = parsed.searchParams;
        const fileKey = this.uploadService.verifySignedDownload(
          params.get('key') || '',
          params.get('exp') || '',
          params.get('sig') || '',
        );
        if (!fileKey) {
          throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: `${label} has an invalid or expired signature` });
        }
        const segments = fileKey.split('/');
        if (segments.length !== 4 || segments[1] !== 'chat-attachments' || segments[2] !== userId) {
          throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: `${label} does not belong to this user` });
        }
        const storagePublicUrl = (this.configService.get<string>('app.storagePublicUrl') || 'https://api.kahade.id/uploads').replace(/\/+$/, '');
        return `${storagePublicUrl}/${fileKey.slice('uploads/'.length)}`;
      }
    } catch (e) {
      if (e instanceof BadRequestException) throw e;
      // Bukan signed URL — lanjutkan ke validasi stable URL di bawah.
    }
    return rawUrl;
  }

  private validateAttachments(userId: string, attachments: NonNullable<SendMessageDto['attachments']>, skipOwnershipCheck = false): void {
    const trustedHostnames: string[] = [];
    const r2Endpoint = this.configService.get<string>('r2.endpointUrl');
    if (r2Endpoint) {
      try { trustedHostnames.push(new URL(r2Endpoint).hostname); } catch {}
    }
    const r2PublicUrl = this.configService.get<string>('r2.publicUrl');
    if (r2PublicUrl) {
      try { trustedHostnames.push(new URL(r2PublicUrl).hostname); } catch {}
    }
    // Batch 1A (ST-008): storage self-hosted — lampiran berupa URL
    // https://api.kahade.id/uploads/... atau signed URL /v1/upload/s.
    // Sebelumnya hanya hostname R2 yang dipercaya → lampiran self-hosted
    // ditolak `domain mismatch` (atau `Storage is not configured` bila env
    // R2 dihapus).
    const storagePublicUrl = this.configService.get<string>('app.storagePublicUrl');
    if (storagePublicUrl) {
      try { trustedHostnames.push(new URL(storagePublicUrl).hostname); } catch {}
    }
    // Host API sendiri (untuk signed URL /v1/upload/s?...).
    const apiHost = (() => {
      try {
        const base = (storagePublicUrl || '').replace(/\/uploads\/?$/, '');
        return base ? new URL(base).hostname : null;
      } catch { return null; }
    })();
    if (apiHost && !trustedHostnames.includes(apiHost)) trustedHostnames.push(apiHost);
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
      // Batch 1A (ST-004): normalisasi signed URL → stable URL sebelum validasi
      // & persist, agar URL kedaluwarsa tidak tersimpan di DB.
      if (a.fileUrl) {
        a.fileUrl = this.normalizeAttachmentUrl(userId, a.fileUrl, 'Attachment file URL');
        validateStorageUrl(a.fileUrl, 'Attachment file URL');
        if (!skipOwnershipCheck) {
          validateOwnership(a.fileUrl, 'Attachment file URL');
        }
      }
      if (a.thumbnailUrl) {
        a.thumbnailUrl = this.normalizeAttachmentUrl(userId, a.thumbnailUrl, 'Attachment thumbnail URL');
        validateStorageUrl(a.thumbnailUrl, 'Attachment thumbnail URL');
        if (!skipOwnershipCheck) {
          validateOwnership(a.thumbnailUrl, 'Attachment thumbnail URL');
        }
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
      // Mute harus menekan notifikasi: user yang mem-mute room tidak boleh
      // menerima push untuk pesan baru di room tersebut.
      const membership = await this.prisma.chatRoomMember.findUnique({
        where: { roomId_userId: { roomId: room.id, userId: recipientId } },
        select: { isMuted: true, mutedUntil: true },
      });
      if (
        membership?.isMuted === true &&
        (!membership.mutedUntil || membership.mutedUntil.getTime() > Date.now())
      ) {
        return;
      }
      // CN-007: hormati preferensi chatInApp — user yang mematikan notifikasi
      // chat tidak boleh tetap mendapat baris di inbox. Pipeline PUSH tetap
      // harus berjalan (digate chatPush di push.service), jadi hanya
      // `notification.create` yang dilewati, bukan `emitNotificationCreated`.
      const inAppEnabled = await this.notificationsService.isInAppEnabled(recipientId, NotificationType.CHAT_NEW_MESSAGE);
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
      // CN-019: refType/refId menunjuk ke RUANG (bukan pesan) agar konsisten
      // dengan actionUrl dan aman di-routing klien.
      const notification = inAppEnabled
        ? await this.prisma.notification.create({
            data: {
              notifId: generateNotifId(), userId: recipientId,
              type: NotificationType.CHAT_NEW_MESSAGE, category: getCategoryForType(NotificationType.CHAT_NEW_MESSAGE),
              title: `Message from ${senderName}`, body: preview, isRead: false,
              refType: 'CHAT_ROOM', refId: room.id,
              actionUrl: `/chat/${encodeURIComponent(room.id)}`,
            },
            select: { notifId: true },
          })
        : null;
      this.prisma.emitNotificationCreated({
        userId: recipientId,
        title: `Message from ${senderName}`,
        body: preview,
        data: { type: 'CHAT_NEW', notificationType: NotificationType.CHAT_NEW_MESSAGE, ...(notification ? { notificationId: notification.notifId } : {}), chatRoomId: room.id, roomId: room.id },
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

    // 15.1 Edit window 15 minutes
    const editWindowMs = 15 * 60 * 1000;
    if (Date.now() - new Date(message.createdAt).getTime() > editWindowMs) {
      throw new BadRequestException({
        code: ErrorCodes.CHAT_MESSAGE_NOT_EDITABLE,
        message: 'Message can only be edited within 15 minutes of sending',
      });
    }

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
      // Batch 43 BE-CHAT: bila pembaca mengaktifkan hideReadReceipts, centang
      // baca TIDAK dikirim ke lawan bicara (hanya sinkron multi-device milik
      // pembaca sendiri). Status baca internal (lastReadAt, badge notifikasi)
      // tetap diperbarui.
      const hideReceipts = await this.isHideReadReceiptsEnabled(userId);
      const payload = { roomId, userId, readAt: now, markedCount };
      if (hideReceipts) {
        this.realtime.emitToUser(userId, 'chat.read', payload);
      } else {
        this.emitChatEvent(room, 'chat.read', payload);
      }
    }

    // CN-002: membaca chat juga menandai notifikasi chat terkait sebagai dibaca,
    // agar badge notifikasi (yang dihitung dari tabel notification) ikut padam.
    // actionUrl adalah penanda room yang konsisten (lihat CN-019).
    try {
      await this.prisma.notification.updateMany({
        where: {
          userId,
          type: NotificationType.CHAT_NEW_MESSAGE,
          isRead: false,
          deletedAt: null,
          actionUrl: `/chat/${roomId}`,
        },
        data: { isRead: true, readAt: new Date() },
      });
    } catch (error) {
      // Gangguan sinkronisasi badge tidak boleh menggagalkan markAsRead.
      this.logger.warn(`Failed to sync chat notification read state for room ${roomId}: ${(error as Error).message}`);
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
    await this.assertNotBlocked(userId, this.resolveCounterpart(room, userId));
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
    await this.assertNotBlocked(userId, this.resolveCounterpart(room, userId));
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
    // CN-005: reactedByMe harus dihitung per penerima, bukan memakai sudut
    // pandang aktor untuk semua peserta.
    const actorPayload = {
      roomId: room.id,
      messageId,
      reactions: summarizeReactions(rows as unknown as RawReaction[], viewerId),
    };
    for (const participantId of room.participants) {
      if (participantId === viewerId) {
        this.realtime.emitToUser(participantId, 'chat.reaction_updated', actorPayload);
      } else {
        this.realtime.emitToUser(participantId, 'chat.reaction_updated', {
          roomId: room.id,
          messageId,
          reactions: summarizeReactions(rows as unknown as RawReaction[], participantId),
        });
      }
    }
    // Room broadcast: payload netral agar tidak menyesatkan.
    this.emitChatEvent(room, 'chat.reaction_updated', {
      roomId: room.id,
      messageId,
      reactions: summarizeReactions(rows as unknown as RawReaction[], undefined),
    });
    return actorPayload;
  }

  // ============================================================
  // Pin message
  // ============================================================

  async pinMessage(userId: string, roomId: string, messageId: string, pinned: boolean): Promise<object> {
    const room = await this.validateRoomAccess(userId, roomId);
    await this.assertNotBlocked(userId, this.resolveCounterpart(room, userId));

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
    // Counterpart sumber tidak boleh null: tanpa identitas lawan bicara yang
    // jelas, pembatasan "forward hanya ke counterpart sama" tidak bisa
    // ditegakkan dan data pribadi bisa bocor antar transaksi (room legacy).
    if (!sourceCounterpart) {
      throw new BadRequestException({
        code: ErrorCodes.CHAT_FORWARD_NOT_ALLOWED,
        message: 'Forwarding is not available for this conversation',
      });
    }
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
      if (this.resolveCounterpart(targetRoom, userId) !== sourceCounterpart) {
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
        // Lampiran disalin dari pesan sumber yang sudah tervalidasi di DB.
        skipAttachmentOwnershipCheck: true,
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
    if (!rawUrl || !this.uploadService) return rawUrl;
    try {
      // URL signing is intentionally performed at read time, not persisted with
      // the message. Persisted chat records must remain readable after expiry.
      // Batch 1A (ST-004): lampiran dipersist sebagai stable storage URL
      // (https://api.kahade.id/uploads/chat-attachments/...) — ekstrak fileKey
      // lalu buat signed URL segar. Bentuk raw key lawas tetap didukung.
      const fileKey = this.extractChatFileKey(rawUrl);
      if (!fileKey) return rawUrl;
      return await this.uploadService.generateDownloadUrl(fileKey, 300);
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
   *
   * PRF-002: HANYA room transaksi (tipe ORDER) yang boleh dibaca admin —
   * room DM pribadi (INQUIRY) tidak boleh dimasuki admin, sesuai kebijakan
   * privasi. Jalur dispute sudah me-resolve room via orderId sehingga selalu
   * ORDER.
   */
  async getRoomMessagesForAdmin(
    roomId: string,
    options: { limit?: number; cursor?: string; includeDeleted?: boolean } = {},
  ): Promise<object> {
    const room = await this.prisma.chatRoom.findUnique({
      where: { id: roomId },
      select: { type: true },
    });
    if (!room || room.type !== 'ORDER') {
      throw new ForbiddenException({
        code: ErrorCodes.FORBIDDEN,
        message: 'Admin can only read transaction (ORDER) chat rooms',
      });
    }

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

  // 16.1 typing indicator
  async sendTypingIndicator(userId: string, roomId: string, isTyping: boolean): Promise<{ sent: boolean }> {
    const room = await this.validateRoomAccess(userId, roomId);
    await this.assertNotBlocked(userId, this.resolveCounterpart(room, userId));
    this.emitChatEvent(room, 'chat.typing', { roomId, userId, isTyping, at: new Date().toISOString() });
    return { sent: true };
  }

  // 16.2 read receipts
  async getReadReceipts(userId: string, roomId: string): Promise<object> {
    await this.validateRoomAccess(userId, roomId);
    const messages = await this.prisma.chatMessage.findMany({
      where: { roomId, isDeleted: false },
      select: { id: true, readAt: true, senderId: true },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    // Batch 43 BE-CHAT: pembaca yang menyembunyikan centang baca tidak
    // dimunculkan ke viewer lain.
    const hiddenReaders = await this.loadHiddenReadReceiptUserIds(
      messages.flatMap((m) => Object.keys((m.readAt as Record<string, unknown> | null) ?? {})),
    );
    return {
      roomId,
      receipts: messages.map(m => {
        const readAt = filterReadAtForViewer(m.readAt, userId, hiddenReaders) as Record<string, unknown> | null;
        return {
          messageId: m.id,
          readAt,
          isRead: !!(readAt && typeof readAt === 'object' && Object.keys(readAt).length > 0),
        };
      }),
    };
  }

  async markMessageAsRead(userId: string, roomId: string, messageId: string): Promise<object> {
    const room = await this.validateRoomAccess(userId, roomId);
    const now = new Date().toISOString();
    const jsonPatch = JSON.stringify({ [userId]: now });
    const markedCount = await this.prisma.$executeRaw(
      Prisma.sql`
        UPDATE chat_messages
        SET \"readAt\" = COALESCE(\"readAt\", '{}'::jsonb) || ${jsonPatch}::jsonb
        WHERE id = ${messageId} AND \"roomId\" = ${roomId} AND \"isDeleted\" = false
          AND (\"senderId\" IS NULL OR \"senderId\" != ${userId})
          AND (
            \"readAt\" IS NULL
            OR NOT jsonb_exists(\"readAt\", ${userId})
          )
      `,
    );
    if (markedCount > 0) {
      // Batch 43 BE-CHAT: hormati hideReadReceipts (lihat markAsRead).
      const hideReceipts = await this.isHideReadReceiptsEnabled(userId);
      const payload = { roomId, userId, messageId, readAt: now, markedCount };
      if (hideReceipts) {
        this.realtime.emitToUser(userId, 'chat.read', payload);
      } else {
        this.emitChatEvent(room, 'chat.read', payload);
      }
      // CN-002: sinkronisasi badge notifikasi (lihat markAsRead).
      try {
        await this.prisma.notification.updateMany({
          where: {
            userId,
            type: NotificationType.CHAT_NEW_MESSAGE,
            isRead: false,
            deletedAt: null,
            actionUrl: `/chat/${roomId}`,
          },
          data: { isRead: true, readAt: new Date() },
        });
      } catch (error) {
        this.logger.warn(`Failed to sync chat notification read state for room ${roomId}: ${(error as Error).message}`);
      }
      await this.prisma.chatRoomMember.upsert({
        where: { roomId_userId: { roomId, userId } },
        create: { roomId, userId, role: this.roleFor(room, userId), lastReadAt: new Date() },
        update: { lastReadAt: new Date() },
        select: { id: true },
      }).catch(() => undefined);
    }
    return { messageId, readAt: now, userId, markedCount };
  }

  // ============================================================
  // Batch 43 BE-CHAT — privasi chat (hideReadReceipts + dmPolicy)
  // ============================================================

  async getChatPrivacy(userId: string): Promise<{ hideReadReceipts: boolean; dmPolicy: DmPolicy }> {
    const setting = await this.prisma.privacySetting.findUnique({
      where: { userId },
      select: { hideReadReceipts: true, dmPolicy: true },
    });
    return {
      hideReadReceipts: setting?.hideReadReceipts ?? false,
      dmPolicy: setting?.dmPolicy ?? ('EVERYONE' as DmPolicy),
    };
  }

  async updateChatPrivacy(userId: string, dto: UpdateChatPrivacyDto): Promise<{ hideReadReceipts: boolean; dmPolicy: DmPolicy }> {
    const updated = await this.prisma.privacySetting.upsert({
      where: { userId },
      create: {
        userId,
        hideReadReceipts: dto.hideReadReceipts ?? false,
        dmPolicy: dto.dmPolicy ?? ('EVERYONE' as DmPolicy),
      },
      update: {
        ...(dto.hideReadReceipts !== undefined ? { hideReadReceipts: dto.hideReadReceipts } : {}),
        ...(dto.dmPolicy !== undefined ? { dmPolicy: dto.dmPolicy } : {}),
      },
      select: { hideReadReceipts: true, dmPolicy: true },
    });
    return updated;
  }

  private async isHideReadReceiptsEnabled(userId: string): Promise<boolean> {
    const setting = await this.prisma.privacySetting.findUnique({
      where: { userId },
      select: { hideReadReceipts: true },
    });
    return setting?.hideReadReceipts === true;
  }

  private async loadHiddenReadReceiptUserIds(userIds: string[]): Promise<Set<string>> {
    const unique = [...new Set(userIds.filter((id) => typeof id === 'string' && id.length > 0))];
    if (unique.length === 0) return new Set();
    const rows = await this.prisma.privacySetting.findMany({
      where: { userId: { in: unique }, hideReadReceipts: true },
      select: { userId: true },
    });
    return new Set(rows.map((r) => r.userId));
  }

  /**
   * Tegakkan kebijakan DM milik target. Dipanggil HANYA saat room baru dibuat
   * (createInquiry / getOrCreateDm) — percakapan yang sudah ada tidak diputus.
   * FOLLOWING = pengirim harus di-follow oleh target ("orang yang saya follow
   * boleh DM saya").
   */
  private async assertDmAllowed(senderId: string, targetId: string): Promise<void> {
    const setting = await this.prisma.privacySetting.findUnique({
      where: { userId: targetId },
      select: { dmPolicy: true },
    });
    const policy = setting?.dmPolicy ?? ('EVERYONE' as DmPolicy);
    if (policy === ('NONE' as DmPolicy)) {
      throw new ForbiddenException({
        code: ErrorCodes.CHAT_DM_NOT_ALLOWED,
        message: 'This user does not accept new direct messages',
      });
    }
    if (policy === ('FOLLOWING' as DmPolicy)) {
      const followsBack = await this.prisma.follow.findUnique({
        where: { followerId_followingId: { followerId: targetId, followingId: senderId } },
        select: { id: true },
      });
      if (!followsBack) {
        throw new ForbiddenException({
          code: ErrorCodes.CHAT_DM_NOT_ALLOWED,
          message: 'This user only accepts direct messages from people they follow',
        });
      }
    }
  }

  // ============================================================
  // Batch 43 BE-CHAT — terjemahan pesan
  // ============================================================

  async translateMessage(userId: string, messageId: string, targetLang: string): Promise<object> {
    const message = await this.prisma.chatMessage.findUnique({
      where: { id: messageId },
      select: { id: true, roomId: true, content: true, isDeleted: true, messageType: true },
    });
    if (!message || message.isDeleted) {
      throw new NotFoundException({ code: ErrorCodes.NOT_FOUND, message: 'Message not found' });
    }
    await this.validateRoomAccess(userId, message.roomId);
    const text = (message.content ?? '').trim();
    if (!text) {
      throw new BadRequestException({
        code: ErrorCodes.CHAT_MESSAGE_NOT_TRANSLATABLE,
        message: 'Only text messages can be translated',
      });
    }
    // Fail closed 501 bila provider belum dikonfigurasi (atau service tak ada).
    if (!this.translationService) {
      throw new HttpException(
        { code: ErrorCodes.TRANSLATION_NOT_CONFIGURED, message: 'Translation provider is not configured' },
        HttpStatus.NOT_IMPLEMENTED,
      );
    }
    const result = await this.translationService.translate(text, targetLang.toLowerCase());
    return {
      messageId: message.id,
      targetLang: targetLang.toLowerCase(),
      translatedText: result.translatedText,
      sourceLang: result.sourceLang ?? null,
    };
  }

  // ============================================================
  // Batch 43 BE-CHAT — export chat (hanya anggota room)
  // ============================================================

  async exportRoom(userId: string, roomId: string, format: 'txt' | 'json'): Promise<{ format: string; filename: string; content: unknown }> {
    const room = await this.validateRoomAccess(userId, roomId);
    const messages = await this.prisma.chatMessage.findMany({
      where: { roomId, isDeleted: false },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: CHAT_EXPORT_MAX_MESSAGES + 1,
      select: {
        id: true,
        messageType: true,
        content: true,
        locationLabel: true,
        createdAt: true,
        sender: { select: { fullName: true } },
      },
    });
    if (messages.length > CHAT_EXPORT_MAX_MESSAGES) {
      throw new BadRequestException({
        code: ErrorCodes.CHAT_EXPORT_TOO_LARGE,
        message: `Chat export is limited to ${CHAT_EXPORT_MAX_MESSAGES} messages`,
      });
    }
    const dateFmt = new Intl.DateTimeFormat('id-ID', {
      timeZone: 'Asia/Jakarta',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false,
    });
    const filename = `chat-export-${roomId}.${format}`;
    if (format === 'json') {
      return {
        format,
        filename,
        content: {
          roomId,
          roomType: room.type,
          exportedAt: new Date().toISOString(),
          messageCount: messages.length,
          messages: messages.map((m) => ({
            id: m.id,
            sentAt: m.createdAt,
            senderName: m.sender?.fullName ?? 'Sistem',
            messageType: m.messageType,
            content: m.content ?? m.locationLabel ?? `[${m.messageType}]`,
          })),
        },
      };
    }
    const lines = [
      'Kahade — Ekspor Chat',
      `Room: ${roomId} (${room.type})`,
      `Diekspor: ${dateFmt.format(new Date())} WIB`,
      `Jumlah pesan: ${messages.length}`,
      '='.repeat(48),
    ];
    for (const m of messages) {
      const when = dateFmt.format(new Date(m.createdAt));
      const who = m.sender?.fullName ?? 'Sistem';
      const body = m.content ?? m.locationLabel ?? `[${m.messageType}]`;
      lines.push(`[${when}] ${who}: ${body}`);
    }
    return { format, filename, content: lines.join('\n') };
  }

  // ============================================================
  // Batch 43 BE-CHAT — pesan berbintang (per user per room)
  // ============================================================

  async starMessage(userId: string, roomId: string, messageId: string): Promise<{ starred: boolean }> {
    await this.validateRoomAccess(userId, roomId);
    const message = await this.prisma.chatMessage.findFirst({
      where: { id: messageId, roomId, isDeleted: false },
      select: { id: true },
    });
    if (!message) {
      throw new NotFoundException({ code: ErrorCodes.NOT_FOUND, message: 'Message not found' });
    }
    await this.prisma.chatStarredMessage.upsert({
      where: { userId_messageId: { userId, messageId } },
      create: { userId, messageId, roomId },
      update: {},
      select: { id: true },
    });
    return { starred: true };
  }

  async unstarMessage(userId: string, roomId: string, messageId: string): Promise<{ starred: boolean }> {
    await this.validateRoomAccess(userId, roomId);
    await this.prisma.chatStarredMessage.deleteMany({ where: { userId, messageId, roomId } });
    return { starred: false };
  }

  async listStarredMessages(userId: string, roomId: string): Promise<object> {
    await this.validateRoomAccess(userId, roomId);
    const stars = await this.prisma.chatStarredMessage.findMany({
      where: { userId, roomId, message: { isDeleted: false } },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true, message: { select: MESSAGE_SELECT } },
    });
    const hiddenReaders = await this.loadHiddenReadReceiptUserIds(
      stars.flatMap((s) => Object.keys((((s.message as unknown as RawMessage).readAt as Record<string, unknown> | null) ?? {}))),
    );
    return {
      roomId,
      messages: stars.map((s) => ({
        starredAt: s.createdAt,
        message: serializeMessage(s.message as unknown as RawMessage, { viewerId: userId, hiddenReaders }),
      })),
    };
  }

  // ============================================================
  // Batch 43 BE-CHAT — chat dengan diri sendiri
  // ============================================================

  /**
   * Get-or-create room "pesan tersimpan" (chat dengan diri sendiri).
   * Memakai tipe INQUIRY dengan initiatorId = counterpartId = userId agar
   * taksonomi room tidak berubah; frontend mengenali via isSelf.
   */
  async getOrCreateSelfRoom(userId: string): Promise<object> {
    let room = await this.prisma.chatRoom.findFirst({
      where: { type: 'INQUIRY', initiatorId: userId, counterpartId: userId, deletedAt: null },
      select: { id: true, status: true },
    });
    if (!room) {
      room = await this.prisma.chatRoom.create({
        data: {
          type: 'INQUIRY',
          status: 'ACTIVE',
          initiatorId: userId,
          counterpartId: userId,
          members: { create: [{ userId, role: 'INITIATOR' }] },
        },
        select: { id: true, status: true },
      });
    }
    return {
      room: {
        id: room.id,
        type: 'INQUIRY',
        status: room.status,
        isSelf: true,
      },
    };
  }

  // ============================================================
  // Batch 43 BE-CHAT — validasi lokasi & snapshot kartu
  // ============================================================

  private validateLocationMessage(location: SendMessageDto['location']): { lat: number; lng: number; label: string | null } {
    if (!location || typeof location.lat !== 'number' || typeof location.lng !== 'number') {
      throw new BadRequestException({
        code: ErrorCodes.CHAT_LOCATION_INVALID,
        message: 'Location messages require { lat, lng }',
      });
    }
    if (!Number.isFinite(location.lat) || location.lat < -90 || location.lat > 90 ||
        !Number.isFinite(location.lng) || location.lng < -180 || location.lng > 180) {
      throw new BadRequestException({
        code: ErrorCodes.CHAT_LOCATION_INVALID,
        message: 'Invalid coordinates: lat must be -90..90, lng must be -180..180',
      });
    }
    return {
      lat: location.lat,
      lng: location.lng,
      label: location.label?.trim().slice(0, 200) || null,
    };
  }

  /**
   * Snapshot kartu produk saat pesan dikirim — harga/judul/gambar dibekukan
   * supaya tidak berubah bila etalase diedit kemudian.
   */
  private async buildProductCardSnapshot(
    showcaseId: string | undefined,
    room: RoomContext,
    userId: string,
  ): Promise<Record<string, unknown>> {
    if (!showcaseId) {
      throw new BadRequestException({ code: ErrorCodes.CHAT_CARD_INVALID, message: 'PRODUCT_CARD requires showcaseId' });
    }
    const showcase = await this.prisma.userShowcase.findUnique({
      where: { id: showcaseId },
      select: {
        id: true, userId: true, title: true, priceMin: true, priceMax: true,
        isActive: true, visibility: true,
        images: { select: { imageUrl: true }, orderBy: { sortOrder: 'asc' }, take: 1 },
        user: { select: { username: true, fullName: true } },
      },
    });
    if (!showcase || !showcase.isActive) {
      throw new NotFoundException({ code: ErrorCodes.CHAT_CARD_INVALID, message: 'Showcase not found or inactive' });
    }
    const participantIds = [room.initiatorId, room.counterpartId, userId].filter(Boolean) as string[];
    const isOwner = showcase.userId === userId;
    const isParticipantOwned = participantIds.includes(showcase.userId);
    if (showcase.visibility !== 'PUBLIC' && !isOwner && !isParticipantOwned) {
      throw new ForbiddenException({ code: ErrorCodes.CHAT_CARD_INVALID, message: 'Showcase is not visible to this chat' });
    }
    return {
      kind: 'PRODUCT_CARD',
      showcaseId: showcase.id,
      title: showcase.title,
      priceMin: showcase.priceMin?.toString() ?? null,
      priceMax: showcase.priceMax?.toString() ?? null,
      imageUrl: showcase.images[0]?.imageUrl ?? null,
      sellerUsername: showcase.user.username,
      sellerName: showcase.user.fullName,
      snapshotAt: new Date().toISOString(),
    };
  }

  private async buildOrderCardSnapshot(orderId: string | undefined, userId: string): Promise<Record<string, unknown>> {
    if (!orderId) {
      throw new BadRequestException({ code: ErrorCodes.CHAT_CARD_INVALID, message: 'ORDER_CARD requires orderId' });
    }
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      select: {
        id: true, orderId: true, title: true, status: true, orderValue: true,
        buyerId: true, sellerId: true, deletedAt: true,
        buyer: { select: { username: true } },
        seller: { select: { username: true } },
      },
    });
    if (!order || order.deletedAt) {
      throw new NotFoundException({ code: ErrorCodes.CHAT_CARD_INVALID, message: 'Order not found' });
    }
    if (order.buyerId !== userId && order.sellerId !== userId) {
      throw new ForbiddenException({ code: ErrorCodes.CHAT_CARD_INVALID, message: 'You are not a participant of this order' });
    }
    return {
      kind: 'ORDER_CARD',
      orderId: order.id,
      orderCode: order.orderId,
      title: order.title,
      status: order.status,
      orderValue: order.orderValue.toString(),
      buyerUsername: order.buyer.username,
      sellerUsername: order.seller.username,
      snapshotAt: new Date().toISOString(),
    };
  }

  // ============================================================
  // Batch 43 BE-CHAT — polling/voting
  // ============================================================

  async createPoll(userId: string, roomId: string, dto: CreatePollDto): Promise<object> {
    const room = await this.validateRoomAccess(userId, roomId);
    await this.assertNotBlocked(userId, this.resolveCounterpart(room, userId));
    const question = dto.question.trim();
    if (question.length === 0) {
      throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Poll question must not be empty' });
    }
    const options = [...new Set(dto.options.map((o) => o.trim()).filter((o) => o.length > 0))];
    if (options.length < CHAT_POLL_MIN_OPTIONS) {
      throw new BadRequestException({
        code: ErrorCodes.VALIDATION_ERROR,
        message: `Poll must have at least ${CHAT_POLL_MIN_OPTIONS} unique non-empty options`,
      });
    }
    let deadline: Date | null = null;
    if (dto.deadline) {
      deadline = new Date(dto.deadline);
      if (Number.isNaN(deadline.getTime()) || deadline.getTime() <= Date.now()) {
        throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Poll deadline must be a future date-time' });
      }
    }
    const poll = await this.prisma.chatPoll.create({
      data: {
        roomId,
        question: question.slice(0, CHAT_POLL_QUESTION_MAX_LENGTH),
        options,
        allowMultiple: dto.allowMultiple === true,
        deadline,
        createdById: userId,
      },
      select: { id: true },
    });
    this.emitChatEvent(room, 'chat.poll_created', { roomId, pollId: poll.id, question });
    return this.getPoll(userId, roomId, poll.id);
  }

  async listPolls(userId: string, roomId: string): Promise<object> {
    await this.validateRoomAccess(userId, roomId);
    const polls = await this.prisma.chatPoll.findMany({
      where: { roomId },
      orderBy: { createdAt: 'desc' },
      select: { id: true },
    });
    const items = await Promise.all(polls.map((p) => this.serializePoll(p.id, userId)));
    return { roomId, polls: items };
  }

  async getPoll(userId: string, roomId: string, pollId: string): Promise<object> {
    await this.validateRoomAccess(userId, roomId);
    const poll = await this.prisma.chatPoll.findFirst({
      where: { id: pollId, roomId },
      select: { id: true },
    });
    if (!poll) {
      throw new NotFoundException({ code: ErrorCodes.CHAT_POLL_NOT_FOUND, message: 'Poll not found' });
    }
    return this.serializePoll(pollId, userId);
  }

  private async serializePoll(pollId: string, viewerId: string): Promise<object> {
    const poll = await this.prisma.chatPoll.findUnique({
      where: { id: pollId },
      select: {
        id: true, roomId: true, question: true, options: true,
        allowMultiple: true, deadline: true, isClosed: true, createdAt: true,
        createdBy: { select: { userId: true, fullName: true } },
        votes: { select: { userId: true, optionIndex: true } },
      },
    });
    if (!poll) {
      throw new NotFoundException({ code: ErrorCodes.CHAT_POLL_NOT_FOUND, message: 'Poll not found' });
    }
    const options = (poll.options as string[]) ?? [];
    const counts = new Array(options.length).fill(0) as number[];
    const myVotes: number[] = [];
    const voters = new Set<string>();
    for (const vote of poll.votes) {
      if (vote.optionIndex >= 0 && vote.optionIndex < counts.length) counts[vote.optionIndex] += 1;
      voters.add(vote.userId);
      if (vote.userId === viewerId && !myVotes.includes(vote.optionIndex)) myVotes.push(vote.optionIndex);
    }
    return {
      id: poll.id,
      roomId: poll.roomId,
      question: poll.question,
      options: options.map((text, index) => ({ index, text, votes: counts[index] ?? 0 })),
      totalVotes: voters.size,
      allowMultiple: poll.allowMultiple,
      deadline: poll.deadline,
      isClosed: poll.isClosed || (poll.deadline != null && poll.deadline.getTime() <= Date.now()),
      myVotes: myVotes.sort((a, b) => a - b),
      createdBy: { userId: poll.createdBy.userId, fullName: poll.createdBy.fullName },
      createdAt: poll.createdAt,
    };
  }

  async votePoll(userId: string, roomId: string, pollId: string, optionIndexes: number[]): Promise<object> {
    const room = await this.validateRoomAccess(userId, roomId);
    await this.assertNotBlocked(userId, this.resolveCounterpart(room, userId));
    const poll = await this.prisma.chatPoll.findFirst({
      where: { id: pollId, roomId },
      select: { id: true, options: true, allowMultiple: true, deadline: true, isClosed: true },
    });
    if (!poll) {
      throw new NotFoundException({ code: ErrorCodes.CHAT_POLL_NOT_FOUND, message: 'Poll not found' });
    }
    if (poll.isClosed) {
      throw new BadRequestException({ code: ErrorCodes.CHAT_POLL_CLOSED, message: 'This poll is closed' });
    }
    if (poll.deadline && poll.deadline.getTime() <= Date.now()) {
      throw new BadRequestException({ code: ErrorCodes.CHAT_POLL_DEADLINE_PASSED, message: 'Voting deadline has passed' });
    }
    const options = (poll.options as string[]) ?? [];
    const unique = [...new Set(optionIndexes)];
    for (const index of unique) {
      if (!Number.isInteger(index) || index < 0 || index >= options.length) {
        throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Invalid option index' });
      }
    }
    if (!poll.allowMultiple && unique.length > 1) {
      throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'This poll allows only one choice' });
    }
    // Single-choice: ganti pilihan lama. Multi-choice: tambah (idempoten).
    if (!poll.allowMultiple) {
      await this.prisma.chatPollVote.deleteMany({ where: { pollId, userId } });
    }
    if (unique.length > 0) {
      await this.prisma.chatPollVote.createMany({
        data: unique.map((optionIndex) => ({ pollId, userId, optionIndex })),
        skipDuplicates: true,
      });
    }
    const result = await this.serializePoll(pollId, userId);
    this.emitChatEvent(room, 'chat.poll_updated', { roomId, pollId, voterId: userId });
    return result;
  }

  async closePoll(userId: string, roomId: string, pollId: string): Promise<object> {
    const room = await this.validateRoomAccess(userId, roomId);
    const poll = await this.prisma.chatPoll.findFirst({
      where: { id: pollId, roomId },
      select: { id: true, createdById: true },
    });
    if (!poll) {
      throw new NotFoundException({ code: ErrorCodes.CHAT_POLL_NOT_FOUND, message: 'Poll not found' });
    }
    if (poll.createdById !== userId) {
      throw new ForbiddenException({ code: ErrorCodes.FORBIDDEN, message: 'Only the poll creator can close it' });
    }
    await this.prisma.chatPoll.update({ where: { id: pollId }, data: { isClosed: true } });
    this.emitChatEvent(room, 'chat.poll_closed', { roomId, pollId });
    return this.serializePoll(pollId, userId);
  }

  // ============================================================
  // Batch 43 BE-CHAT — pin room tersinkron backend
  // ============================================================

  async listPinnedChatRooms(userId: string): Promise<object> {
    const pins = await this.prisma.chatPinnedRoom.findMany({
      where: { userId, room: { deletedAt: null } },
      orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
      select: {
        roomId: true,
        position: true,
        createdAt: true,
        room: { select: { id: true, type: true, subject: true } },
      },
    });
    return {
      pinnedRooms: pins.map((p) => ({
        roomId: p.roomId,
        position: p.position,
        pinnedAt: p.createdAt,
        room: p.room,
      })),
    };
  }

  async pinChatRoom(userId: string, roomId: string, position?: number): Promise<object> {
    await this.validateRoomAccess(userId, roomId);
    const safePosition = position == null ? await this.nextPinnedRoomPosition(userId) : Math.max(0, Math.min(100000, Math.floor(position)));
    const pin = await this.prisma.chatPinnedRoom.upsert({
      where: { userId_roomId: { userId, roomId } },
      create: { userId, roomId, position: safePosition },
      update: { position: safePosition },
      select: { roomId: true, position: true },
    });
    this.realtime.emitToUser(userId, 'chat.room_pinned', pin);
    return pin;
  }

  async unpinChatRoom(userId: string, roomId: string): Promise<{ unpinned: boolean }> {
    await this.prisma.chatPinnedRoom.deleteMany({ where: { userId, roomId } });
    this.realtime.emitToUser(userId, 'chat.room_unpinned', { roomId });
    return { unpinned: true };
  }

  private async nextPinnedRoomPosition(userId: string): Promise<number> {
    const last = await this.prisma.chatPinnedRoom.findFirst({
      where: { userId },
      orderBy: { position: 'desc' },
      select: { position: true },
    });
    return (last?.position ?? -1) + 1;
  }

  // ============================================================
  // Batch 43 BE-CHAT — template balasan "/"
  // ============================================================

  async listReplyTemplates(userId: string): Promise<object> {
    const templates = await this.prisma.chatReplyTemplate.findMany({
      where: { userId },
      orderBy: { shortcut: 'asc' },
      select: { id: true, shortcut: true, text: true, createdAt: true, updatedAt: true },
    });
    return { templates };
  }

  async createReplyTemplate(userId: string, dto: CreateReplyTemplateDto): Promise<object> {
    const shortcut = dto.shortcut.trim().toLowerCase();
    const count = await this.prisma.chatReplyTemplate.count({ where: { userId } });
    if (count >= CHAT_MAX_REPLY_TEMPLATES_PER_USER) {
      throw new BadRequestException({
        code: ErrorCodes.CHAT_TEMPLATE_LIMIT_REACHED,
        message: `You can have at most ${CHAT_MAX_REPLY_TEMPLATES_PER_USER} reply templates`,
      });
    }
    const existing = await this.prisma.chatReplyTemplate.findUnique({
      where: { userId_shortcut: { userId, shortcut } },
      select: { id: true },
    });
    if (existing) {
      throw new ConflictException({ code: ErrorCodes.CHAT_TEMPLATE_SHORTCUT_TAKEN, message: 'Shortcut already exists' });
    }
    const template = await this.prisma.chatReplyTemplate.create({
      data: { userId, shortcut, text: dto.text.trim() },
      select: { id: true, shortcut: true, text: true, createdAt: true, updatedAt: true },
    });
    return { template };
  }

  async updateReplyTemplate(userId: string, templateId: string, dto: UpdateReplyTemplateDto): Promise<object> {
    const template = await this.prisma.chatReplyTemplate.findFirst({
      where: { id: templateId, userId },
      select: { id: true },
    });
    if (!template) {
      throw new NotFoundException({ code: ErrorCodes.CHAT_TEMPLATE_NOT_FOUND, message: 'Reply template not found' });
    }
    const shortcut = dto.shortcut?.trim().toLowerCase();
    if (shortcut) {
      const clash = await this.prisma.chatReplyTemplate.findFirst({
        where: { userId, shortcut, id: { not: templateId } },
        select: { id: true },
      });
      if (clash) {
        throw new ConflictException({ code: ErrorCodes.CHAT_TEMPLATE_SHORTCUT_TAKEN, message: 'Shortcut already exists' });
      }
    }
    const updated = await this.prisma.chatReplyTemplate.update({
      where: { id: templateId },
      data: {
        ...(shortcut ? { shortcut } : {}),
        ...(dto.text !== undefined ? { text: dto.text.trim() } : {}),
      },
      select: { id: true, shortcut: true, text: true, createdAt: true, updatedAt: true },
    });
    return { template: updated };
  }

  async deleteReplyTemplate(userId: string, templateId: string): Promise<{ deleted: boolean }> {
    const result = await this.prisma.chatReplyTemplate.deleteMany({ where: { id: templateId, userId } });
    if (result.count === 0) {
      throw new NotFoundException({ code: ErrorCodes.CHAT_TEMPLATE_NOT_FOUND, message: 'Reply template not found' });
    }
    return { deleted: true };
  }

  // ============================================================
  // Batch 43 BE-CHAT — pesan sistem otomatis dari event order
  // ============================================================

  /**
   * Handler yang didaftarkan ke ChatOrderHooks (lihat onModuleInit).
   * Dipanggil best-effort dari modul orders SETELAH transisi status berhasil:
   * bayar diterima, resi diupload, dikirim, dana cair. Kegagalan di sini tidak
   * pernah menggagalkan alur order (emit memakai fire-and-forget + catch).
   */
  async handleOrderEvent(orderId: string, kind: ChatOrderEventKind, data?: ChatOrderEventData): Promise<void> {
    try {
      const room = await this.prisma.chatRoom.findUnique({
        where: { orderId },
        select: { id: true, initiatorId: true, counterpartId: true, type: true, status: true },
      });
      if (!room) return; // Order tanpa room chat (bukan dari chat) — lewati.

      const content = this.systemMessageForOrderEvent(kind, data);
      if (!content) return;
      const context = await this.loadRoomContextForSystem(room.id);
      if (!context) return;

      const message = await this.prisma.chatMessage.create({
        data: { roomId: room.id, senderId: null, messageType: 'SYSTEM', content },
        select: MESSAGE_SELECT,
      });
      await this.prisma.chatRoom.update({ where: { id: room.id }, data: { updatedAt: new Date() } });

      const payload = serializeMessage(message as unknown as RawMessage, {});
      this.emitChatEvent(context, 'chat.new_message', payload);
      for (const participantId of context.participants) {
        this.realtime.emitToUser(participantId, 'chat.new_message', payload);
      }

      // Transaksi selesai → arsipkan room untuk kedua pihak (otomatis).
      if (kind === 'ORDER_COMPLETED') {
        await this.archiveRoomForOrderCompletion(room.id, context.participants);
      }
    } catch (error) {
      this.logger.warn(`handleOrderEvent failed (${kind} ${orderId}): ${(error as Error)?.message ?? error}`);
    }
  }

  private systemMessageForOrderEvent(kind: ChatOrderEventKind, data?: ChatOrderEventData): string | null {
    switch (kind) {
      case 'ORDER_PAID':
        return '✅ Pembayaran diterima dan dikunci di escrow Kahade. Penjual dapat mulai memproses pesanan.';
      case 'ORDER_TRACKING_UPDATED': {
        const courier = data?.courierName?.trim();
        const tracking = data?.trackingNumber?.trim();
        if (!tracking && !courier) return null;
        return `📦 Nomor resi diperbarui: ${[courier, tracking].filter(Boolean).join(' ')}.`;
      }
      case 'ORDER_SHIPPED': {
        const courier = data?.courierName?.trim();
        const tracking = data?.trackingNumber?.trim();
        return `🚚 Pesanan telah dikirim${courier ? ` via ${courier}` : ''}${tracking ? ` (resi: ${tracking})` : ''}.`;
      }
      case 'ORDER_COMPLETED':
        return '🎉 Transaksi selesai — dana telah dicairkan ke penjual. Terima kasih telah bertransaksi di Kahade!';
      default:
        return null;
    }
  }

  private async loadRoomContextForSystem(roomId: string): Promise<RoomContext | null> {
    const room = await this.prisma.chatRoom.findUnique({
      where: { id: roomId, deletedAt: null },
      select: {
        id: true, type: true, status: true, subject: true,
        initiatorId: true, counterpartId: true,
        order: {
          select: {
            id: true, orderId: true, status: true, completedAt: true, cancelledAt: true,
            buyerId: true, sellerId: true,
          },
        },
      },
    });
    if (!room) return null;
    const participants = [room.initiatorId, room.counterpartId].filter(
      (id): id is string => typeof id === 'string' && id.length > 0,
    );
    const effectiveParticipants =
      participants.length === 2 ? participants : [room.order?.buyerId, room.order?.sellerId].filter(Boolean) as string[];
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
            id: room.order.id, orderId: room.order.orderId, status: room.order.status,
            completedAt: room.order.completedAt, cancelledAt: room.order.cancelledAt,
            buyerId: room.order.buyerId, sellerId: room.order.sellerId,
          }
        : null,
    };
  }

  private async archiveRoomForOrderCompletion(roomId: string, participantIds: string[]): Promise<void> {
    const now = new Date();
    for (const participantId of participantIds) {
      await this.prisma.chatRoomMember.upsert({
        where: { roomId_userId: { roomId, userId: participantId } },
        create: { roomId, userId: participantId, role: 'BUYER', isArchived: true, archivedAt: now },
        update: { isArchived: true, archivedAt: now },
        select: { id: true },
      }).catch(() => undefined);
    }
    // Mirror global bila kedua pihak mengarsipkan (pola mirrorArchiveState).
    await this.mirrorArchiveState(roomId).catch(() => undefined);
    this.logger.log(`Auto-archived chat room ${roomId} after order completion`);
  }

  // ============================================================
  // Batch 43 BE-CHAT — blokir & laporkan dari menu room
  // ============================================================

  /**
   * Blokir lawan bicara langsung dari menu room. Target = counterpart room
   * (otomatis, tanpa perlu tahu userId-nya). Cerminan UsersService.blockUser
   * (buat baris block + hapus follow dua arah) tanpa mengimpor UsersModule.
   */
  async blockCounterpartFromRoom(userId: string, roomId: string): Promise<{ message: string }> {
    const room = await this.validateRoomAccess(userId, roomId);
    const targetId = this.resolveCounterpart(room, userId);
    if (!targetId || targetId === userId) {
      throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Cannot block in a self chat' });
    }
    const existing = await this.prisma.blockList.findUnique({
      where: { blockerId_blockedId: { blockerId: userId, blockedId: targetId } },
      select: { id: true },
    });
    if (existing) {
      throw new ConflictException({ code: 'USER_ALREADY_BLOCKED', message: 'User is already blocked' });
    }
    await this.prisma.$transaction([
      this.prisma.blockList.create({ data: { blockerId: userId, blockedId: targetId } }),
      this.prisma.follow.deleteMany({
        where: { OR: [{ followerId: userId, followingId: targetId }, { followerId: targetId, followingId: userId }] },
      }),
    ]);
    return { message: 'User blocked successfully' };
  }

  /**
   * Laporkan lawan bicara dari menu room. relatedOrderId diisi otomatis bila
   * room terikat order; relatedMessageId opsional untuk konteks admin.
   */
  async reportCounterpartFromRoom(userId: string, roomId: string, dto: ReportRoomDto): Promise<{ message: string; reportId: string }> {
    const room = await this.validateRoomAccess(userId, roomId);
    const targetId = this.resolveCounterpart(room, userId);
    if (!targetId || targetId === userId) {
      throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Cannot report in a self chat' });
    }
    if (dto.evidenceUrls?.length) {
      this.validateReportEvidenceUrls(dto.evidenceUrls);
    }
    let relatedMessageId: string | null = null;
    if (dto.relatedMessageId) {
      const relatedMessage = await this.prisma.chatMessage.findFirst({
        where: { id: dto.relatedMessageId, roomId },
        select: { id: true },
      });
      if (!relatedMessage) {
        throw new NotFoundException({ code: ErrorCodes.NOT_FOUND, message: 'Related message not found in this room' });
      }
      relatedMessageId = relatedMessage.id;
    }
    const report = await this.prisma.userReport.create({
      data: {
        reporterId: userId,
        targetId,
        category: dto.category as ReportCategory,
        description: dto.description.trim(),
        evidenceUrls: dto.evidenceUrls ?? [],
        relatedOrderId: room.order?.id ?? null,
        relatedMessageId,
      },
      select: { id: true },
    });
    return { message: 'Report submitted', reportId: report.id };
  }

  private validateReportEvidenceUrls(urls: string[]): void {
    const trustedHostnames: string[] = [];
    const storagePublicUrl = this.configService.get<string>('app.storagePublicUrl') || 'https://api.kahade.id/uploads';
    try { trustedHostnames.push(new URL(storagePublicUrl).hostname); } catch { /* abaikan */ }
    const r2Endpoint = this.configService.get<string>('r2.endpointUrl');
    if (r2Endpoint) { try { trustedHostnames.push(new URL(r2Endpoint).hostname); } catch { /* abaikan */ } }
    const r2PublicUrl = this.configService.get<string>('r2.publicUrl');
    if (r2PublicUrl) { try { trustedHostnames.push(new URL(r2PublicUrl).hostname); } catch { /* abaikan */ } }
    if (trustedHostnames.length === 0) {
      throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Storage is not configured' });
    }
    for (const rawUrl of urls) {
      try {
        const parsed = new URL(rawUrl);
        if (parsed.protocol !== 'https:') throw new Error('not https');
        const isTrusted = trustedHostnames.some((h) => parsed.hostname === h || parsed.hostname.endsWith(`.${h}`));
        if (!isTrusted) throw new Error('domain mismatch');
      } catch {
        throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Evidence URL must be from platform storage' });
      }
    }
  }

  // ============================================================
  // Batch 43 BE-CHAT — buat transaksi escrow dari chat
  // ============================================================

  /**
   * Buat order escrow 1-by-1 dari room chat negosiasi (INQUIRY).
   *
   * Uang HANYA lewat escrow: seluruh logika finansial (fee, voucher, KYC,
   * validasi nilai) didelegasikan ke OrdersService.createOrder — tidak ada
   * logika uang baru di sini. Jalur wallet-to-wallet langsung DILARANG KERAS
   * (keputusan user) dan tidak diimplementasikan.
   */
  async createOrderFromChat(userId: string, roomId: string, dto: CreateOrderFromChatDto): Promise<object> {
    const room = await this.validateRoomAccess(userId, roomId);
    if (room.type !== 'INQUIRY') {
      throw new BadRequestException({
        code: ErrorCodes.CHAT_ORDER_FROM_CHAT_INVALID,
        message: 'Orders can only be created from negotiation (INQUIRY) chats',
      });
    }
    const counterpartId = this.resolveCounterpart(room, userId);
    if (!counterpartId || counterpartId === userId) {
      throw new BadRequestException({
        code: ErrorCodes.CHAT_ORDER_FROM_CHAT_INVALID,
        message: 'Cannot create an order from a self chat',
      });
    }
    if (!this.ordersService) {
      throw new HttpException(
        { code: 'SERVICE_UNAVAILABLE', message: 'Order service is unavailable' },
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }

    // Tentukan penjual/pembeli + judul/deskripsi/nilai dasar.
    let sellerId: string;
    let title: string;
    let description: string;
    let basePriceRupiah: number | null = null;

    if (dto.showcaseId) {
      const showcase = await this.prisma.userShowcase.findUnique({
        where: { id: dto.showcaseId },
        select: { id: true, userId: true, title: true, description: true, priceMin: true, priceMax: true, isActive: true },
      });
      if (!showcase || !showcase.isActive) {
        throw new NotFoundException({ code: ErrorCodes.CHAT_ORDER_FROM_CHAT_INVALID, message: 'Showcase not found or inactive' });
      }
      if (showcase.userId !== userId && showcase.userId !== counterpartId) {
        throw new ForbiddenException({
          code: ErrorCodes.CHAT_ORDER_FROM_CHAT_INVALID,
          message: 'Showcase does not belong to a participant of this chat',
        });
      }
      sellerId = showcase.userId;
      title = showcase.title;
      description = (showcase.description?.trim() || showcase.title).slice(0, 500);
      const priceMin = showcase.priceMin != null ? Number(showcase.priceMin) : null;
      const priceMax = showcase.priceMax != null ? Number(showcase.priceMax) : null;
      basePriceRupiah = dto.hargaSepakat ?? priceMin ?? priceMax;
    } else {
      if (!dto.title?.trim() || !dto.description?.trim()) {
        throw new BadRequestException({
          code: ErrorCodes.CHAT_ORDER_FROM_CHAT_INVALID,
          message: 'title and description are required when showcaseId is not provided',
        });
      }
      const role = dto.role ?? 'BUYER';
      sellerId = role === 'SELLER' ? userId : counterpartId;
      title = dto.title.trim();
      description = dto.description.trim();
      basePriceRupiah = dto.hargaSepakat ?? null;
    }

    if (basePriceRupiah == null || !Number.isSafeInteger(basePriceRupiah) || basePriceRupiah < 1) {
      throw new BadRequestException({
        code: ErrorCodes.CHAT_ORDER_FROM_CHAT_INVALID,
        message: 'hargaSepakat (atau harga etalase) wajib diisi sebagai nilai rupiah yang valid',
      });
    }
    const qty = dto.qty ?? 1;
    const orderValue = basePriceRupiah * qty; // derivasi input; logika fee tetap di OrdersService
    if (!Number.isSafeInteger(orderValue) || orderValue < 1) {
      throw new BadRequestException({ code: ErrorCodes.CHAT_ORDER_FROM_CHAT_INVALID, message: 'Invalid total order value' });
    }

    const buyerId = sellerId === userId ? counterpartId : userId;
    const counterpartUserId = buyerId === userId ? sellerId : userId;
    const counterpart = await this.prisma.user.findUnique({
      where: { id: counterpartUserId },
      select: { username: true, isActive: true, isBanned: true },
    });
    if (!counterpart || !counterpart.isActive || counterpart.isBanned || !counterpart.username) {
      throw new NotFoundException({ code: ErrorCodes.CHAT_COUNTERPART_NOT_FOUND, message: 'Counterpart not found or unavailable' });
    }
    await this.assertNotBlocked(userId, counterpartId);

    // Delegasi penuh ke OrdersService: fee, voucher, KYC, escrow — tanpa
    // perubahan logika uang. inquiryRoomId menautkan order ke room ini.
    const result = await this.ordersService.createOrder(userId, {
      role: buyerId === userId ? 'BUYER' : 'SELLER',
      counterpartUsername: counterpart.username,
      title,
      description,
      orderType: (dto.orderType ?? 'PHYSICAL_GOODS') as 'PHYSICAL_GOODS' | 'DIGITAL_GOODS' | 'SERVICE' | 'OTHER',
      orderValue,
      deliveryDeadlineDays: dto.deliveryDeadlineDays ?? 3,
      feeResponsibility: (dto.feeResponsibility ?? 'BUYER') as 'BUYER' | 'SELLER' | 'SPLIT',
      inquiryRoomId: roomId,
    });

    // Pesan sistem di room sebagai jejak (best-effort).
    try {
      const context = await this.loadRoomContextForSystem(roomId);
      if (context) {
        const sysMessage = await this.prisma.chatMessage.create({
          data: {
            roomId,
            senderId: null,
            messageType: 'SYSTEM',
            content: `🧾 Order ${result.orderId} dibuat dari chat ini — dana akan dikunci di escrow setelah pembayaran.`,
          },
          select: MESSAGE_SELECT,
        });
        this.emitChatEvent(context, 'chat.new_message', serializeMessage(sysMessage as unknown as RawMessage, {}));
      }
    } catch (error) {
      this.logger.warn(`Order-from-chat system message failed for room ${roomId}: ${(error as Error)?.message ?? error}`);
    }

    return {
      order: {
        orderId: result.orderId,
        status: result.status,
        feeCalculation: result.feeCalculation,
        confirmationDeadlineAt: result.confirmationDeadlineAt,
      },
      roomId,
    };
  }
}
