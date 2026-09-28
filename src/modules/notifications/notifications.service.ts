import { Injectable, Logger, NotFoundException, ForbiddenException, BadRequestException } from '@nestjs/common';
import { Prisma, Notification, NotificationPreference, NotificationCategory, NotificationType } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { createPaginatedResponse, PaginatedResponse } from '../../common/dto/pagination.dto';
import * as ErrorCodes from '../../common/constants/error-codes';
import { UpdatePreferencesDto } from './dto/update-preferences.dto';
import { customAlphabet } from 'nanoid';
import { getMinutesInTimezone, isMinutesInRange } from '../../common/utils/timezone.util';

const generateDeviceId = customAlphabet('0123456789abcdefghijklmnopqrstuvwxyz', 16);
const NOTIFICATION_DEDUP_WINDOW_MS = 60_000;
const MAX_NOTIFICATION_PAGE = 10_000;

const IN_APP_PREFERENCE_TYPES: ReadonlyArray<[keyof Pick<NotificationPreference, 'orderInApp' | 'walletInApp' | 'chatInApp' | 'disputeInApp' | 'rankingInApp' | 'marketingInApp'>, readonly NotificationType[]]> = [
  ['orderInApp', [NotificationType.ORDER_NEW, NotificationType.ORDER_ACCEPTED, NotificationType.ORDER_REJECTED, NotificationType.ORDER_CANCELLED_TIMEOUT, NotificationType.ORDER_CANCELLED, NotificationType.ORDER_PAYMENT_RECEIVED, NotificationType.ORDER_SHIPPED, NotificationType.ORDER_DEADLINE_REMINDER, NotificationType.ORDER_EXTENSION_REQUESTED, NotificationType.ORDER_EXTENSION_APPROVED, NotificationType.ORDER_EXTENSION_REJECTED, NotificationType.ORDER_COMPLETED, NotificationType.ORDER_AUTOCOMPLETED, NotificationType.ORDER_DELIVERED]],
  ['walletInApp', [NotificationType.WALLET_TOPUP_SUCCESS, NotificationType.WALLET_TOPUP_FAILED, NotificationType.WALLET_WITHDRAW_SUCCESS, NotificationType.WALLET_WITHDRAW_FAILED, NotificationType.WALLET_FUNDS_RELEASED, NotificationType.WALLET_TRANSFER_SENT, NotificationType.WALLET_TRANSFER_RECEIVED, NotificationType.WALLET_REFUND_RECEIVED]],
  ['chatInApp', [NotificationType.CHAT_NEW_MESSAGE]],
  // CN-006: daftar dispute dilengkapi — sebelumnya DISPUTE_MESSAGE_RECEIVED,
  // DISPUTE_ESCALATION_SLA_WARNING/BREACHED tidak tertekan walau toggle mati
  // (push memakai prefix-match sehingga konsisten, in-app tidak).
  ['disputeInApp', [NotificationType.DISPUTE_SUBMITTED, NotificationType.DISPUTE_ADMIN_JOINED, NotificationType.DISPUTE_DECISION, NotificationType.DISPUTE_EVIDENCE_SUBMITTED, NotificationType.DISPUTE_CLAIM_SUBMITTED, NotificationType.DISPUTE_ESCALATED, NotificationType.DISPUTE_MESSAGE_RECEIVED, NotificationType.DISPUTE_ESCALATION_SLA_WARNING, NotificationType.DISPUTE_ESCALATION_SLA_BREACHED]],
  ['rankingInApp', [NotificationType.RATING_NEW, NotificationType.BADGE_AWARDED, NotificationType.RANK_UPGRADED, NotificationType.SUBSCRIPTION_ACTIVATED, NotificationType.SUBSCRIPTION_EXPIRY_REMINDER, NotificationType.SUBSCRIPTION_EXPIRED, NotificationType.SUBSCRIPTION_RENEWED, NotificationType.REFERRAL_REWARD_RECEIVED]],
  ['marketingInApp', [NotificationType.VOUCHER_ISSUED, NotificationType.CAMPAIGN_CASHBACK_CREDITED, NotificationType.TOPUP_BONUS_CREDITED]],
];

function criticalSecurityType(type: NotificationType): boolean {
  return type.startsWith('SECURITY_');
}

export type PublicNotification = Pick<Notification, 'notifId' | 'type' | 'category' | 'channel' | 'title' | 'body' | 'refType' | 'refId' | 'actionUrl' | 'isRead' | 'readAt' | 'createdAt' | 'expiresAt'> & {
  /** NP-011: hanya diisi pada endpoint detail; daftar tidak mengembalikannya. */
  metadata?: Prisma.JsonValue | null;
  /**
   * Batch 139 BE-API2 (item 114): URL gambar opsional untuk notifikasi kaya
   * (rich notification). Diambil dari `metadata.imageUrl` (fallback
   * `metadata.image_url`); null bila tidak ada. Tidak ada migrasi — kolom
   * tidak ditambahkan ke tabel, pembuat notifikasi cukup mengisi metadata.
   */
  imageUrl: string | null;
};

/**
 * Batch 139 BE-API2 (item 113): preferensi notifikasi + status EFEKTIF quiet
 * hours yang dihitung server dari setting + waktu sekarang (zona waktu
 * per-user `quietHoursTimezone`).
 */
export type NotificationPreferencesResponse = NotificationPreference & {
  quietHoursActive: boolean;
};

function extractNotificationImageUrl(metadata: Prisma.JsonValue | null | undefined): string | null {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return null;
  const record = metadata as Record<string, unknown>;
  const candidate = record.imageUrl ?? record.image_url;
  return typeof candidate === 'string' && candidate.trim().length > 0 ? candidate : null;
}

function withImageUrl<T extends object>(row: T): T & { imageUrl: string | null } {
  const metadata = (row as { metadata?: Prisma.JsonValue | null }).metadata;
  return { ...row, imageUrl: extractNotificationImageUrl(metadata) };
}

const PUBLIC_NOTIFICATION_BASE_SELECT = {
  notifId: true,
  type: true,
  category: true,
  channel: true,
  title: true,
  body: true,
  // CN-019: referensi entitas diekspos agar klien bisa deep-link tanpa parsing actionUrl.
  refType: true,
  refId: true,
  actionUrl: true,
  isRead: true,
  readAt: true,
  createdAt: true,
  expiresAt: true,
} satisfies Prisma.NotificationSelect;

/**
 * NP-011 (perf-fix): daftar notifikasi TIDAK lagi mengembalikan kolom
 * `metadata` (JSONB penuh) — menghemat transfer per baris. Frontend tidak
 * memakai metadata dari daftar (verifikasi 2026-09-29).
 */
const PUBLIC_NOTIFICATION_SELECT = {
  ...PUBLIC_NOTIFICATION_BASE_SELECT,
} satisfies Prisma.NotificationSelect;

/** Detail satu notifikasi tetap menyertakan metadata. */
const NOTIFICATION_DETAIL_SELECT = {
  ...PUBLIC_NOTIFICATION_BASE_SELECT,
  metadata: true,
} satisfies Prisma.NotificationSelect;

function activeNotificationWhere(now = new Date()): Prisma.NotificationWhereInput {
  return { OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] };
}

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(
    private prisma: PrismaService,
  ) {}

  async isDuplicate(userId: string, type: NotificationType, body: string): Promise<boolean> {
    const since = new Date(Date.now() - NOTIFICATION_DEDUP_WINDOW_MS);
    const existing = await this.prisma.notification.findFirst({
      where: {
        userId,
        type,
        body,
        createdAt: { gte: since },
        deletedAt: null,
      },
      select: { id: true },
    });
    return !!existing;
  }

  async isDuplicateByRef(userId: string, type: NotificationType, refId: string): Promise<boolean> {
    const since = new Date(Date.now() - NOTIFICATION_DEDUP_WINDOW_MS);
    const existing = await this.prisma.notification.findFirst({
      where: {
        userId,
        type,
        refId,
        createdAt: { gte: since },
        deletedAt: null,
      },
      select: { id: true },
    });
    return !!existing;
  }

  private async disabledInAppTypes(userId: string): Promise<NotificationType[]> {
    const prefs = await this.prisma.notificationPreference.findUnique({ where: { userId } });
    if (!prefs) return [];
    return IN_APP_PREFERENCE_TYPES
      .filter(([field]) => prefs[field] === false)
      .flatMap(([, types]) => types)
      .filter((type) => !criticalSecurityType(type));
  }

  /**
   * CN-007: cek apakah notifikasi in-app untuk tipe tertentu diizinkan user.
   * Dipakai pembuat notifikasi (mis. chat) SEBELUM menulis baris notification,
   * agar toggle preferensi benar-benar menekan — bukan hanya menyembunyikan
   * dari daftar.
   */
  async isInAppEnabled(userId: string, type: NotificationType): Promise<boolean> {
    try {
      if (criticalSecurityType(type)) return true;
      const disabled = await this.disabledInAppTypes(userId);
      return !disabled.includes(type);
    } catch {
      return true;
    }
  }

  private async notificationVisibilityWhere(userId: string): Promise<Prisma.NotificationWhereInput> {
    const disabledTypes = await this.disabledInAppTypes(userId);
    return {
      userId,
      deletedAt: null,
      AND: [
        activeNotificationWhere(),
        ...(disabledTypes.length > 0 ? [{ type: { notIn: disabledTypes } }] : []),
      ],
    };
  }

  async listNotifications(userId: string, page: number, limit: number, isRead?: boolean, category?: NotificationCategory): Promise<PaginatedResponse<PublicNotification>> {
    const safePage = Math.min(MAX_NOTIFICATION_PAGE, Math.max(1, Math.trunc(page)));
    const safeLimit = Math.min(100, Math.max(1, Math.trunc(limit)));
    const where = await this.notificationVisibilityWhere(userId);
    if (isRead !== undefined) {
      where.isRead = isRead;
    }
    if (category) {
      where.category = category;
    }

    const [rows, total] = await Promise.all([
      this.prisma.notification.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], // R2-L: stable page ordering
        skip: (safePage - 1) * safeLimit,
        take: safeLimit,
        select: PUBLIC_NOTIFICATION_SELECT,
      }),
      this.prisma.notification.count({ where }),
    ]);

    // Batch 139 BE-API2 (item 114): sematkan imageUrl opsional per item.
    const data = rows.map(withImageUrl);

    return createPaginatedResponse(data, total, safePage, safeLimit);
  }

  async getNotification(userId: string, notifId: string): Promise<PublicNotification> {
    const notification = await this.prisma.notification.findFirst({
      where: { userId, notifId, deletedAt: null, AND: [activeNotificationWhere()] },
      select: NOTIFICATION_DETAIL_SELECT,
    });
    if (!notification) {
      throw new NotFoundException({ code: ErrorCodes.NOTIFICATION_NOT_FOUND, message: 'Notification not found' });
    }
    return withImageUrl(notification);
  }

  async getUnreadCount(userId: string, category?: NotificationCategory): Promise<{
    unreadCount: number;
    perCategory?: Record<NotificationCategory, number>;
  }> {
    if (category) {
      const visibility = await this.notificationVisibilityWhere(userId);
      const count = await this.prisma.notification.count({
        where: { ...visibility, isRead: false, category },
      });
      return { unreadCount: count };
    }

    const visibility = await this.notificationVisibilityWhere(userId);
    const counts = await this.prisma.notification.groupBy({
      by: ['category'],
      where: { ...visibility, isRead: false },
      _count: { _all: true },
    });

    const perCategory = {
      [NotificationCategory.INFORMASI]: 0,
      [NotificationCategory.PROMOSI]: 0,
      [NotificationCategory.TRANSAKSI]: 0,
    };
    let total = 0;
    for (const row of counts) {
      perCategory[row.category] = row._count._all;
      total += row._count._all;
    }

    return { unreadCount: total, perCategory };
  }

  async markAsRead(userId: string, notifId: string): Promise<PublicNotification> {
    const notification = await this.prisma.notification.findUnique({
      where: { notifId },
    });

    if (!notification || notification.deletedAt || (notification.expiresAt && notification.expiresAt <= new Date())) {
      throw new NotFoundException({ code: ErrorCodes.NOTIFICATION_NOT_FOUND, message: 'Notification not found' });
    }

    if (notification.userId !== userId) {
      throw new ForbiddenException({ code: ErrorCodes.NOTIFICATION_NOT_OWNED, message: 'Notification does not belong to you' });
    }

    const updated = await this.prisma.notification.update({
      where: { notifId },
      data: { isRead: true, readAt: new Date() },
      select: PUBLIC_NOTIFICATION_SELECT,
    });

    return withImageUrl(updated);
  }

  async markBatchAsRead(userId: string, notifIds: string[]): Promise<{ markedCount: number }> {
    const result = await this.prisma.notification.updateMany({
      where: {
        notifId: { in: notifIds },
        userId,
        isRead: false,
        deletedAt: null,
        AND: [activeNotificationWhere()],
      },
      data: { isRead: true, readAt: new Date() },
    });
    return { markedCount: result.count };
  }

  async deleteBatch(userId: string, notifIds: string[]): Promise<{ deletedCount: number }> {
    const result = await this.prisma.notification.updateMany({
      where: {
        notifId: { in: notifIds },
        userId,
        deletedAt: null,
      },
      data: { deletedAt: new Date() },
    });
    return { deletedCount: result.count };
  }

  async deleteAllRead(userId: string): Promise<{ deletedCount: number }> {
    const result = await this.prisma.notification.updateMany({
      where: { userId, isRead: true, deletedAt: null },
      data: { deletedAt: new Date() },
    });
    return { deletedCount: result.count };
  }

  async markAllAsRead(userId: string): Promise<{ markedCount: number }> {
    let totalMarked = 0;
    let batchCount: number;
    let lastId: string | undefined;
    do {
      const batch = await this.prisma.notification.findMany({
        where: { userId, isRead: false, deletedAt: null, AND: [activeNotificationWhere()] },
        select: { id: true },
        ...(lastId ? { cursor: { id: lastId }, skip: 1 } : {}),
        take: 1000,
        orderBy: { id: 'asc' },
      });
      batchCount = batch.length;
      if (batchCount > 0) {
        lastId = batch[batch.length - 1].id;
        const result = await this.prisma.notification.updateMany({
          where: { id: { in: batch.map(n => n.id) }, isRead: false },
          data: { isRead: true, readAt: new Date() },
        });
        totalMarked += result.count;
      }
    } while (batchCount === 1000);

    return { markedCount: totalMarked };
  }

  async getPreferences(userId: string): Promise<NotificationPreferencesResponse> {
    // Race-safe upsert: previous findUnique→create pattern threw P2002
    // when two concurrent first-time requests landed at the same instant.
    const prefs = await this.prisma.notificationPreference.upsert({
      where: { userId },
      create: { userId },
      update: {},
    });
    // Batch 139 BE-API2 (item 113): status efektif quiet hours dihitung
    // server dari setting + waktu sekarang.
    return { ...prefs, quietHoursActive: this.computeQuietHoursActive(prefs) };
  }

  async updatePreferences(userId: string, dto: UpdatePreferencesDto): Promise<NotificationPreference> {
    // Security alerts are safety-critical. The UI may render a unified toggle,
    // but no client can turn off the durable security channel by crafting a PUT.
    const updateData = { ...dto, securityInApp: true, securityPush: true, securityEmail: true };

    const prefs = await this.prisma.notificationPreference.upsert({
      where: { userId },
      create: { userId, ...updateData },
      update: updateData,
    } as any);

    return prefs;
  }

  /**
   * Batch 139 BE-API2 (item 113): status efektif quiet hours dari objek
   * preferensi yang SUDAH dimuat (tanpa query tambahan). Logika identik
   * dengan `isInQuietHours` — diekstrak agar GET /preferences bisa memakai
   * hasil upsert langsung.
   */
  private computeQuietHoursActive(prefs: {
    quietHoursEnabled: boolean;
    quietHoursStart?: string | null;
    quietHoursEnd?: string | null;
    quietHoursTimezone?: string | null;
  }): boolean {
    try {
      if (!prefs.quietHoursEnabled) return false;
      const start = prefs.quietHoursStart || '22:00';
      const end = prefs.quietHoursEnd || '07:00';
      // CN-008: zona waktu dari preferensi user, bukan hardcode WIB.
      const currentMinutes = getMinutesInTimezone(new Date(), prefs.quietHoursTimezone);
      return isMinutesInRange(currentMinutes, start, end);
    } catch {
      return false;
    }
  }

  // 7.2 Quiet hours check (zona waktu per-user, CN-008) + 7.3 per-category push toggles + language
  async isInQuietHours(userId: string): Promise<boolean> {
    try {
      const prefs = await this.prisma.notificationPreference.findUnique({ where: { userId } }) as any;
      if (!prefs) return false;
      return this.computeQuietHoursActive(prefs);
    } catch {
      return false;
    }
  }

  async shouldSendPush(userId: string, type: NotificationType): Promise<boolean> {
    try {
      const prefs = await this.prisma.notificationPreference.findUnique({ where: { userId } }) as any;
      if (!prefs) return true;
      if (criticalSecurityType(type)) return true;
      if (await this.isInQuietHours(userId)) {
        // During quiet hours, only critical types pass
        return criticalSecurityType(type);
      }
      // Check per-category push toggles
      const pushMap: Record<string, NotificationType[]> = {
        orderPush: [NotificationType.ORDER_NEW, NotificationType.ORDER_ACCEPTED, NotificationType.ORDER_REJECTED, NotificationType.ORDER_CANCELLED_TIMEOUT, NotificationType.ORDER_CANCELLED, NotificationType.ORDER_PAYMENT_RECEIVED, NotificationType.ORDER_SHIPPED, NotificationType.ORDER_DEADLINE_REMINDER, NotificationType.ORDER_EXTENSION_REQUESTED, NotificationType.ORDER_EXTENSION_APPROVED, NotificationType.ORDER_EXTENSION_REJECTED, NotificationType.ORDER_COMPLETED, NotificationType.ORDER_AUTOCOMPLETED, NotificationType.ORDER_DELIVERED],
        walletPush: [NotificationType.WALLET_TOPUP_SUCCESS, NotificationType.WALLET_TOPUP_FAILED, NotificationType.WALLET_WITHDRAW_SUCCESS, NotificationType.WALLET_WITHDRAW_FAILED, NotificationType.WALLET_FUNDS_RELEASED, NotificationType.WALLET_TRANSFER_SENT, NotificationType.WALLET_TRANSFER_RECEIVED],
        chatPush: [NotificationType.CHAT_NEW_MESSAGE],
        disputePush: [NotificationType.DISPUTE_SUBMITTED, NotificationType.DISPUTE_ADMIN_JOINED, NotificationType.DISPUTE_DECISION, NotificationType.DISPUTE_EVIDENCE_SUBMITTED, NotificationType.DISPUTE_CLAIM_SUBMITTED, NotificationType.DISPUTE_ESCALATED],
        rankingPush: [NotificationType.RATING_NEW, NotificationType.BADGE_AWARDED, NotificationType.RANK_UPGRADED, NotificationType.SUBSCRIPTION_ACTIVATED, NotificationType.SUBSCRIPTION_EXPIRY_REMINDER, NotificationType.SUBSCRIPTION_EXPIRED, NotificationType.SUBSCRIPTION_RENEWED, NotificationType.REFERRAL_REWARD_RECEIVED],
        marketingPush: [NotificationType.VOUCHER_ISSUED, NotificationType.CAMPAIGN_CASHBACK_CREDITED, NotificationType.TOPUP_BONUS_CREDITED],
      };
      for (const [field, types] of Object.entries(pushMap)) {
        if ((types as NotificationType[]).includes(type) && prefs[field] === false) return false;
      }
      return true;
    } catch {
      return true;
    }
  }

  async getUserLanguage(userId: string): Promise<'id' | 'en'> {
    try {
      const prefs = await this.prisma.notificationPreference.findUnique({ where: { userId } }) as any;
      return prefs?.language === 'en' ? 'en' : 'id';
    } catch {
      return 'id';
    }
  }

  async deleteNotification(userId: string, notifId: string): Promise<{ message: string }> {
    const notification = await this.prisma.notification.findUnique({
      where: { notifId },
    });

    if (!notification || notification.deletedAt) {
      throw new NotFoundException({ code: ErrorCodes.NOTIFICATION_NOT_FOUND, message: 'Notification not found' });
    }

    if (notification.userId !== userId) {
      throw new ForbiddenException({ code: ErrorCodes.NOTIFICATION_NOT_OWNED, message: 'Notification does not belong to you' });
    }

    await this.prisma.notification.update({
      where: { notifId },
      data: { deletedAt: new Date() },
    });
    return { message: 'Notification deleted successfully' };
  }

  async registerDevice(userId: string, token: string, platform?: string, ipAddress?: string, deviceId?: string): Promise<{ message: string; deviceId: string }> {
    this.logger.log(`Push token registration: platform=${platform ?? 'unknown'}, tokenLength=${token?.length ?? 0}`);
    if (!token || token.length < 10 || token.length > 512 || !/^[a-zA-Z0-9:._/\-[\]]+$/.test(token)) {
      throw new BadRequestException({
        code: 'INVALID_PUSH_TOKEN',
        message: 'Invalid push token',
      });
    }

    await this.prisma.userDevice.updateMany({
      where: { pushToken: token, userId: { not: userId } },
      data: { pushToken: null },
    });

    // D-04: when the client supplies its install fingerprint, that is the device's identity —
    // `UserDevice` is keyed `@@unique([userId, deviceId])`, so an upsert on it is both exact and
    // race-safe. This is what makes `unregister-device` work: it looks the row up by this same
    // fingerprint (`unregisterDevice` below, `purgeLocalData.ts` on the client). Previously
    // registration invented a synthetic `push-<platform>-<nanoid>` id, so the unregister
    // `updateMany` matched 0 rows and silently reported success while the token stayed live —
    // push kept flowing to the handset after logout.
    //
    // It also removes the `deviceType` guess below, which evicted a second device of the same
    // platform: registering an Android tablet overwrote the Android phone's token, so only the
    // most recent install of each platform could ever receive push.
    if (deviceId) {
      const device = await this.prisma.userDevice.upsert({
        where: { userId_deviceId: { userId, deviceId } },
        create: {
          userId,
          deviceId,
          pushToken: token,
          deviceName: platform ?? 'push',
          deviceType: platform ?? 'mobile',
          ipAddress: ipAddress || 'unknown',
        },
        update: {
          pushToken: token,
          lastLoginAt: new Date(),
          ipAddress: ipAddress || 'unknown',
          deviceName: platform ?? 'push',
          ...(platform ? { deviceType: platform } : {}),
        },
      });
      return { message: 'Device registered successfully', deviceId: device.id };
    }

    const existingByToken = await this.prisma.userDevice.findFirst({
      where: { userId, pushToken: token },
    });

    if (existingByToken) {
      await this.prisma.userDevice.update({
        where: { id: existingByToken.id },
        data: { lastLoginAt: new Date() },
      });
      return { message: 'Device token updated', deviceId: existingByToken.id };
    }

    // Legacy fallback for clients that send no fingerprint: when APNs/FCM rotates the token, we
    // must update the existing device record instead of creating duplicates. Match by
    // deviceType+userId combination. Inexact by nature — see D-04 above.
    if (platform) {
      const existingByPlatform = await this.prisma.userDevice.findFirst({
        where: { userId, deviceType: platform, pushToken: { not: null } },
        orderBy: { lastLoginAt: 'desc' },
      });

      if (existingByPlatform) {
        await this.prisma.userDevice.update({
          where: { id: existingByPlatform.id },
          data: { pushToken: token, lastLoginAt: new Date() },
        });
        return { message: 'Device token refreshed', deviceId: existingByPlatform.id };
      }
    }

    const device = await this.prisma.userDevice.create({
      data: {
        userId,
        deviceId: `push-${platform ?? 'mobile'}-${generateDeviceId()}`,
        pushToken: token,
        deviceName: platform ?? 'push',
        deviceType: platform ?? 'mobile',
        ipAddress: ipAddress || 'unknown',
      },
    });

    return { message: 'Device registered successfully', deviceId: device.id };
  }

  async unregisterDevice(userId: string, deviceId: string): Promise<{ message: string }> {
    if (!deviceId || typeof deviceId !== 'string' || deviceId.length > 128 || !/^[a-zA-Z0-9:._-]+$/.test(deviceId)) {
      throw new BadRequestException({ code: 'INVALID_DEVICE_ID', message: 'Device ID is invalid' });
    }

    const result = await this.prisma.userDevice.updateMany({
      where: { userId, deviceId },
      data: { pushToken: null },
    });

    // Stays 200 either way — unregistering an already-unregistered device is legitimately
    // idempotent, and the client calls this during logout teardown where a throw would abort the
    // rest of the purge. But a 0 here means the caller's fingerprint matched no row, which is
    // exactly how D-04 stayed invisible: the token kept receiving push after logout while this
    // endpoint reported success. Log it so the next occurrence is greppable.
    if (result.count === 0) {
      this.logger.warn('unregisterDevice matched no device');
    }

    return { message: 'Device unregistered successfully' };
  }

}
