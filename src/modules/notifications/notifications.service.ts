import { Injectable, Logger, NotFoundException, ForbiddenException, BadRequestException } from '@nestjs/common';
import { Prisma, Notification, NotificationPreference, NotificationCategory, NotificationType } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { createPaginatedResponse, PaginatedResponse } from '../../common/dto/pagination.dto';
import * as ErrorCodes from '../../common/constants/error-codes';
import { UpdatePreferencesDto } from './dto/update-preferences.dto';
import { customAlphabet } from 'nanoid';

const generateDeviceId = customAlphabet('0123456789abcdefghijklmnopqrstuvwxyz', 16);
const NOTIFICATION_DEDUP_WINDOW_MS = 60_000;
const MAX_NOTIFICATION_PAGE = 10_000;

const IN_APP_PREFERENCE_TYPES: ReadonlyArray<[keyof Pick<NotificationPreference, 'orderInApp' | 'walletInApp' | 'chatInApp' | 'disputeInApp' | 'rankingInApp'>, readonly NotificationType[]]> = [
  ['orderInApp', [NotificationType.ORDER_NEW, NotificationType.ORDER_ACCEPTED, NotificationType.ORDER_REJECTED, NotificationType.ORDER_CANCELLED_TIMEOUT, NotificationType.ORDER_CANCELLED, NotificationType.ORDER_PAYMENT_RECEIVED, NotificationType.ORDER_SHIPPED, NotificationType.ORDER_DEADLINE_REMINDER, NotificationType.ORDER_EXTENSION_REQUESTED, NotificationType.ORDER_EXTENSION_APPROVED, NotificationType.ORDER_EXTENSION_REJECTED, NotificationType.ORDER_COMPLETED, NotificationType.ORDER_AUTOCOMPLETED, NotificationType.ORDER_DELIVERED]],
  ['walletInApp', [NotificationType.WALLET_TOPUP_SUCCESS, NotificationType.WALLET_TOPUP_FAILED, NotificationType.WALLET_WITHDRAW_SUCCESS, NotificationType.WALLET_WITHDRAW_FAILED, NotificationType.WALLET_FUNDS_RELEASED, NotificationType.WALLET_TRANSFER_SENT, NotificationType.WALLET_TRANSFER_RECEIVED]],
  ['chatInApp', [NotificationType.CHAT_NEW_MESSAGE]],
  ['disputeInApp', [NotificationType.DISPUTE_SUBMITTED, NotificationType.DISPUTE_ADMIN_JOINED, NotificationType.DISPUTE_DECISION]],
  ['rankingInApp', [NotificationType.RATING_NEW, NotificationType.BADGE_AWARDED, NotificationType.RANK_UPGRADED, NotificationType.SUBSCRIPTION_ACTIVATED, NotificationType.SUBSCRIPTION_EXPIRY_REMINDER, NotificationType.SUBSCRIPTION_EXPIRED, NotificationType.SUBSCRIPTION_RENEWED, NotificationType.REFERRAL_REWARD_RECEIVED]],
];

function criticalSecurityType(type: NotificationType): boolean {
  return type.startsWith('SECURITY_');
}

export type PublicNotification = Pick<Notification, 'notifId' | 'type' | 'category' | 'channel' | 'title' | 'body' | 'actionUrl' | 'isRead' | 'readAt' | 'createdAt' | 'expiresAt' | 'metadata'>;

const PUBLIC_NOTIFICATION_SELECT = {
  notifId: true,
  type: true,
  category: true,
  channel: true,
  title: true,
  body: true,
  actionUrl: true,
  isRead: true,
  readAt: true,
  createdAt: true,
  expiresAt: true,
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

    const [data, total] = await Promise.all([
      this.prisma.notification.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (safePage - 1) * safeLimit,
        take: safeLimit,
        select: PUBLIC_NOTIFICATION_SELECT,
      }),
      this.prisma.notification.count({ where }),
    ]);

    return createPaginatedResponse(data, total, safePage, safeLimit);
  }

  async getNotification(userId: string, notifId: string): Promise<PublicNotification> {
    const notification = await this.prisma.notification.findFirst({
      where: { userId, notifId, deletedAt: null, AND: [activeNotificationWhere()] },
      select: PUBLIC_NOTIFICATION_SELECT,
    });
    if (!notification) {
      throw new NotFoundException({ code: ErrorCodes.NOTIFICATION_NOT_FOUND, message: 'Notification not found' });
    }
    return notification;
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

    return updated;
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

  async getPreferences(userId: string): Promise<NotificationPreference> {
    // Race-safe upsert: previous findUnique→create pattern threw P2002
    // when two concurrent first-time requests landed at the same instant.
    return this.prisma.notificationPreference.upsert({
      where: { userId },
      create: { userId },
      update: {},
    });
  }

  async updatePreferences(userId: string, dto: UpdatePreferencesDto): Promise<NotificationPreference> {
    // Security alerts are safety-critical. The UI may render a unified toggle,
    // but no client can turn off the durable security channel by crafting a PUT.
    const updateData = { ...dto, securityInApp: true, securityPush: true, securityEmail: true };

    const prefs = await this.prisma.notificationPreference.upsert({
      where: { userId },
      create: { userId, ...updateData },
      update: updateData,
    });

    return prefs;
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
