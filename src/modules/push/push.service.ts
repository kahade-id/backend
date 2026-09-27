import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service';
import { NotificationType } from '@prisma/client';
import * as admin from 'firebase-admin';
import { getMinutesInTimezone, isMinutesInRange } from '../../common/utils/timezone.util';
import { recordDeliveryMetric } from '../observability/delivery-metrics.service';

const EXPO_PUSH_API_URL = 'https://exp.host/--/api/v2/push/send';
const EXPO_PUSH_BATCH_SIZE = 100;
const FCM_PUSH_BATCH_SIZE = 500;
const PUSH_DATA_MAX_BYTES = 3_500;
const PUSH_DATA_VALUE_MAX_LENGTH = 256;
const SAFE_PUSH_DATA_KEYS = new Set([
  'type', 'notificationType', 'notificationCategory', 'notificationId', 'notifId', 'actionUrl',
  'orderId', 'transactionId', 'txId', 'roomId', 'chatRoomId', 'orderLinkToken', 'linkToken', 'token',
  'username', 'userUsername', 'profileUsername', 'disputeId', 'rewardId', 'badgeId', 'templateId',
  'ticketId', 'promoCode', 'code', 'scheduleId', 'entityId', 'entityType', 'broadcastId',
]);

/**
 * Item #24 — kategori expo-notifications untuk action button "Konfirmasi terima"
 * di push order. Didefinisikan di frontend (`lib/order-confirm.ts`,
 * `ORDER_ACTION_CATEGORY`); backend hanya meneruskannya sebagai field
 * top-level `categoryId` pada payload Expo push. Field ini BUKAN bagian dari
 * `data` (tidak melewati sanitizePushData).
 */
const ORDER_ACTION_CATEGORY_ID = 'kahade-order-actions';

@Injectable()
export class PushService implements OnModuleInit {
  private readonly logger = new Logger(PushService.name);
  private messaging: admin.messaging.Messaging | null = null;

  constructor(
    private configService: ConfigService,
    private prisma: PrismaService,
  ) {}

  onModuleInit(): void {
    const projectId = this.configService.get<string>('fcm.projectId');
    const clientEmail = this.configService.get<string>('fcm.clientEmail');
    const privateKey = this.configService.get<string>('fcm.privateKey');

    if (!projectId || !clientEmail || !privateKey) {
      this.logger.warn('FCM credentials not configured — push notifications disabled');
    } else {
      try {
        const appName = 'kahade-push';
        const existingApp = admin.apps?.find(a => a?.name === appName);
        const app = existingApp ?? admin.initializeApp({
          credential: admin.credential.cert({ projectId, clientEmail, privateKey }),
        }, appName);
        this.messaging = app.messaging();
        this.logger.log('Firebase Admin initialized for push notifications');
      } catch (error) {
        this.logger.error(`Failed to initialize Firebase Admin: ${(error as Error).message}`, (error as Error).stack);
      }
    }

    this.prisma.onNotificationCreated((notif) => {
      this.enrichPushData(notif.userId, notif.title, notif.body, notif.data).then((data) => this.sendToUser(notif.userId, notif.title, notif.body, data)).catch((err) => {
        this.logger.error(`Push notification callback failed: ${(err as Error).message}`);
      });
    });
  }

  /**
   * Legacy producers still emit after persisting their own notification row.
   * Enrich their reduced realtime payload with the public notifId and action URL
   * so a push tap resolves to the same record as the in-app inbox.
   */
  private async enrichPushData(userId: string, title: string, body: string, data?: Record<string, string>): Promise<Record<string, string>> {
    if (data?.notificationId && data.actionUrl) return data;
    const createdAfter = new Date(Date.now() - 60_000);
    const derivedActionUrl = this.deriveActionUrl(data);
    const notificationType = this.asNotificationType(data?.notificationType ?? data?.type);
    const notification = await this.prisma.notification.findFirst({
      where: {
        userId,
        deletedAt: null,
        createdAt: { gte: createdAfter },
        OR: [{ title, body }, ...(notificationType ? [{ type: notificationType }] : [])],
      },
      orderBy: { createdAt: 'desc' },
      select: { id: true, notifId: true, actionUrl: true, type: true, category: true },
    }).catch(() => null);
    if (notification && derivedActionUrl && !notification.actionUrl) {
      await this.prisma.notification.update({ where: { id: notification.id }, data: { actionUrl: derivedActionUrl } }).catch((error) => {
        this.logger.warn(`Could not backfill notification action URL for ${notification.notifId}: ${(error as Error).message}`);
      });
    }
    return {
      ...(data ?? {}),
      ...(notification?.notifId ? { notificationId: notification.notifId } : {}),
      ...(notification?.actionUrl || derivedActionUrl ? { actionUrl: notification?.actionUrl ?? derivedActionUrl } : {}),
      ...(notification?.type && !data?.notificationType ? { notificationType: notification.type } : {}),
      ...(notification?.category && !data?.notificationCategory ? { notificationCategory: notification.category } : {}),
    };
  }

  private asNotificationType(value?: string): NotificationType | undefined {
    if (!value) return undefined;
    const aliases: Record<string, NotificationType> = {
      CHAT_NEW: NotificationType.CHAT_NEW_MESSAGE,
      DISPUTE_RESOLUTION: NotificationType.DISPUTE_DECISION,
      DISPUTE_RESOLVED: NotificationType.DISPUTE_DECISION,
      ORDER_DELIVERED: NotificationType.ORDER_SHIPPED,
      SECURITY_BACKUP_CODE: NotificationType.SECURITY_BACKUP_CODE_USED,
      SECURITY_ALERT: NotificationType.SECURITY_NEW_LOGIN,
      WALLET_TOPUP: NotificationType.WALLET_TOPUP_SUCCESS,
      WALLET_ADJUSTED: NotificationType.WALLET_FUNDS_RELEASED,
    };
    const normalized = aliases[value] ?? value;
    return (Object.values(NotificationType) as string[]).includes(normalized) ? normalized as NotificationType : undefined;
  }

  private deriveActionUrl(data?: Record<string, string>): string | undefined {
    if (data?.actionUrl) return data.actionUrl;
    if (data?.orderId) return `/order/${encodeURIComponent(data.orderId)}`;
    if (data?.roomId ?? data?.chatRoomId) return `/chat/${encodeURIComponent(data.roomId ?? data.chatRoomId ?? '')}`;
    if (data?.transactionId ?? data?.txId) return `/wallet/transaction?id=${encodeURIComponent(data.transactionId ?? data.txId ?? '')}`;
    if (data?.notificationId) return `/notifications?notificationId=${encodeURIComponent(data.notificationId)}`;
    return undefined;
  }

  private sanitizePushData(data?: Record<string, string>): Record<string, string> {
    const safe: Record<string, string> = {};
    let size = 2;
    for (const [key, value] of Object.entries(data ?? {})) {
      if (!SAFE_PUSH_DATA_KEYS.has(key) || typeof value !== 'string') continue;
      const normalized = value.trim().slice(0, PUSH_DATA_VALUE_MAX_LENGTH);
      if (!normalized) continue;
      const additionalSize = Buffer.byteLength(key, 'utf8') + Buffer.byteLength(normalized, 'utf8') + 6;
      if (size + additionalSize > PUSH_DATA_MAX_BYTES) continue;
      safe[key] = normalized;
      size += additionalSize;
    }
    return safe;
  }

  private getPushPrefFieldForType(notificationType?: string): string | null {
    if (!notificationType) return null;
    if (notificationType.startsWith('ORDER_')) return 'orderPush';
    if (notificationType.startsWith('WALLET_')) return 'walletPush';
    if (notificationType.startsWith('SECURITY_')) return 'securityPush';
    if (notificationType.startsWith('CHAT_')) return 'chatPush';
    if (notificationType.startsWith('DISPUTE_')) return 'disputePush';
    if (notificationType.startsWith('RATING_')) return 'rankingPush';
    if (notificationType === 'RANK_UPGRADED') return 'rankingPush';
    if (notificationType.startsWith('SUBSCRIPTION_')) return 'rankingPush';
    if (notificationType === 'REFERRAL_REWARD_RECEIVED') return 'rankingPush';
    if (notificationType.startsWith('KYC_')) return 'securityPush';
    if (notificationType.startsWith('SYSTEM_')) return 'securityPush';
    // Marketing (default opt-in false): voucher, cashback, bonus topup.
    // Tanpa pemetaan ini push promo terkirim walau user tidak pernah opt-in.
    if (notificationType === 'VOUCHER_ISSUED') return 'marketingPush';
    if (notificationType === 'CAMPAIGN_CASHBACK_CREDITED') return 'marketingPush';
    if (notificationType === 'TOPUP_BONUS_CREDITED') return 'marketingPush';
    // Nudge non-kritis: boleh dimatikan user via preferensi marketing.
    if (notificationType === 'QUESTION_UNANSWERED_REMINDER') return 'marketingPush';
    return null;
  }

  private getAndroidChannelId(notificationType?: string): string {
    if (!notificationType) return 'default';
    if (notificationType.startsWith('SECURITY_') || notificationType.startsWith('KYC_') || notificationType.startsWith('SYSTEM_')) return 'security';
    if (notificationType.startsWith('ORDER_')) return 'orders';
    if (notificationType.startsWith('WALLET_')) return 'wallet';
    if (notificationType.startsWith('CHAT_') || notificationType.startsWith('DISPUTE_')) return 'chat';
    return 'default';
  }

  /**
   * Item #24 — kembalikan categoryId untuk action button "Konfirmasi terima"
   * hanya pada tipe order di mana pembeli boleh konfirmasi terima
   * (status IN_DELIVERY/SHIPPED/DELIVERED × peran pembeli, cerminan
   * `canReviewDelivery` di frontend). Konservatif: ORDER_SHIPPED dan
   * ORDER_DELIVERED saja; tipe lain (termasuk order lain) tidak diubah.
   */
  private getOrderActionCategoryId(notificationType?: string): string | undefined {
    if (notificationType === 'ORDER_SHIPPED' || notificationType === 'ORDER_DELIVERED') {
      return ORDER_ACTION_CATEGORY_ID;
    }
    return undefined;
  }

  private async shouldSendPush(userId: string, data?: Record<string, string>): Promise<boolean> {
    const notificationType = data?.notificationType ?? data?.type;
    // Quiet hours: hanya notifikasi keamanan kritis yang lolos.
    if (notificationType && await this.isInQuietHours(userId)) {
      return notificationType.startsWith('SECURITY_');
    }
    const prefField = this.getPushPrefFieldForType(notificationType);
    if (!prefField) return true;

    try {
      const prefs = await this.prisma.notificationPreference.findUnique({ where: { userId } });
      if (!prefs) return true;
      return (prefs as Record<string, unknown>)[prefField] !== false;
    } catch {
      // The inbox remains durable and can be read when the app next refreshes.
      // Do not risk violating an opt-out merely because preference lookup is
      // temporarily unavailable.
      return false;
    }
  }

  /**
   * Quiet hours check (zona waktu per-user, CN-008). Di-port dari NotificationsService
   * agar berlaku di jalur pengiriman push yang sebenarnya.
   */
  private async isInQuietHours(userId: string): Promise<boolean> {
    try {
      const prefs = await this.prisma.notificationPreference.findUnique({ where: { userId } }) as any;
      if (!prefs || !prefs.quietHoursEnabled) return false;
      const start = prefs.quietHoursStart || '22:00';
      const end = prefs.quietHoursEnd || '07:00';
      // CN-008: zona waktu dari preferensi user, bukan hardcode WIB.
      const currentMinutes = getMinutesInTimezone(new Date(), prefs.quietHoursTimezone);
      return isMinutesInRange(currentMinutes, String(start), String(end));
    } catch {
      return false;
    }
  }

  private isExpoToken(token: string): boolean {
    return (token.startsWith('ExponentPushToken[') || token.startsWith('ExpoPushToken[')) && token.endsWith(']');
  }

  private async sendViaExpo(
    expoTokens: string[],
    title: string,
    body: string,
    data?: Record<string, string>,
    channelId = 'default',
    deviceIdMap?: Map<string, string>,
    categoryId?: string,
  ): Promise<void> {
    if (expoTokens.length === 0) return;

    for (let offset = 0; offset < expoTokens.length; offset += EXPO_PUSH_BATCH_SIZE) {
      const tokenBatch = expoTokens.slice(offset, offset + EXPO_PUSH_BATCH_SIZE);
      const messages = tokenBatch.map((token) => ({
        to: token,
        title,
        body,
        data: data ?? {},
        sound: 'default' as const,
        priority: 'high' as const,
        channelId,
        // Item #24: categoryId top-level (format Expo push). Hanya disertakan
        // bila terdefinisi — tipe lain tidak tersentuh sama sekali.
        ...(categoryId ? { categoryId } : {}),
      }));

      try {
        const response = await fetch(EXPO_PUSH_API_URL, {
          method: 'POST',
          headers: {
            'Accept': 'application/json',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(messages),
        });

        if (!response.ok) {
          this.logger.error(`Expo push API returned ${response.status}: ${await response.text()}`);
          // G494: metrik delivery — hanya counter, tanpa token/payload.
          recordDeliveryMetric('push', 'expo', 'failed');
          continue;
        }

        const result = await response.json() as { data: Array<{ status: string; message?: string; details?: { error?: string } }> };
        let failed = 0;
        for (let i = 0; i < (result.data?.length ?? 0); i++) {
          const ticket = result.data[i];
          if (ticket.status !== 'error') continue;
          failed += 1;
          const errorType = ticket.details?.error;
          if (errorType === 'DeviceNotRegistered' && deviceIdMap) {
            const deviceId = deviceIdMap.get(tokenBatch[i]);
            if (deviceId) {
              await this.prisma.userDevice.update({
                where: { id: deviceId },
                data: { pushToken: null },
              });
              this.logger.log('Cleaned invalid Expo push token');
            }
          } else {
            this.logger.warn(`Expo push error: ${ticket.message}`);
          }
        }
        // G494: metrik delivery — hanya counter, tanpa token/payload.
        if (failed > 0) recordDeliveryMetric('push', 'expo', 'failed', failed);
        const okCount = (result.data?.length ?? 0) - failed;
        if (okCount > 0) recordDeliveryMetric('push', 'expo', 'sent', okCount);
      } catch (error) {
        this.logger.error(`Expo push API call failed: ${(error as Error).message}`);
        // G494: metrik delivery — hanya counter, tanpa token/payload.
        recordDeliveryMetric('push', 'expo', 'failed');
      }
    }
  }

  async sendToUser(
    userId: string,
    title: string,
    body: string,
    data?: Record<string, string>,
  ): Promise<void> {
    if (!(await this.shouldSendPush(userId, data))) {
      this.logger.debug(`Push skipped: preference disabled for type ${data?.notificationType}`);
      // G494: metrik delivery — hanya counter, tanpa token/payload.
      recordDeliveryMetric('push', 'all', 'skipped');
      return;
    }

    try {
      const devices = await this.prisma.userDevice.findMany({
        where: { userId, pushToken: { not: null } },
        select: { id: true, pushToken: true, deviceType: true },
      });

      const allTokens = devices
        .map((d) => d.pushToken)
        .filter((t): t is string => !!t);

      if (allTokens.length === 0) {
        // G494: metrik delivery — hanya counter, tanpa token/payload.
        recordDeliveryMetric('push', 'all', 'skipped');
        return;
      }

      const fcmTokens: string[] = [];
      const expoTokens: string[] = [];
      const expoDeviceMap = new Map<string, string>();
      let unsupportedNativeTokenCount = 0;

      for (const device of devices) {
        if (!device.pushToken) continue;
        if (this.isExpoToken(device.pushToken)) {
          expoTokens.push(device.pushToken);
          expoDeviceMap.set(device.pushToken, device.id);
        } else if (!device.deviceType || device.deviceType === 'android') {
          // The backend receives native Android registration tokens for FCM.
          // Unknown legacy rows are retained for compatibility; native iOS tokens
          // are APNs tokens and must not be sent to FCM Admin.
          fcmTokens.push(device.pushToken);
        } else {
          unsupportedNativeTokenCount += 1;
        }
      }

      const pushData = this.sanitizePushData(data);
      const channelId = this.getAndroidChannelId(pushData.notificationType ?? pushData.type);
      const categoryId = this.getOrderActionCategoryId(pushData.notificationType ?? pushData.type);

      if (expoTokens.length > 0) {
        await this.sendViaExpo(expoTokens, title, body, pushData, channelId, expoDeviceMap, categoryId);
      }

      if (fcmTokens.length > 0 && this.messaging) {
        let successCount = 0;
        const invalidTokenIds: string[] = [];
        for (let offset = 0; offset < fcmTokens.length; offset += FCM_PUSH_BATCH_SIZE) {
          const tokenBatch = fcmTokens.slice(offset, offset + FCM_PUSH_BATCH_SIZE);
          const response = await this.messaging.sendEachForMulticast({
            tokens: tokenBatch,
            notification: { title, body },
            data: pushData,
            android: {
              priority: 'high',
              notification: { channelId },
            },
          });
          successCount += response.successCount;
          response.responses.forEach((resp, idx) => {
            const code = resp.error?.code;
            if (!resp.success && (code === 'messaging/invalid-registration-token' || code === 'messaging/registration-token-not-registered')) {
              const device = devices.find((d) => d.pushToken === tokenBatch[idx]);
              if (device) invalidTokenIds.push(device.id);
            }
          });
        }

        if (invalidTokenIds.length > 0) {
          await this.prisma.userDevice.updateMany({
            where: { id: { in: invalidTokenIds } },
            data: { pushToken: null },
          });
          this.logger.log(`Cleaned ${invalidTokenIds.length} invalid push tokens`);
        }
        this.logger.debug(`FCM push sent: ${successCount}/${fcmTokens.length} succeeded`);
        // G494: metrik delivery — hanya counter, tanpa token/payload.
        const fcmFailed = fcmTokens.length - successCount;
        if (successCount > 0) recordDeliveryMetric('push', 'fcm', 'sent', successCount);
        if (fcmFailed > 0) recordDeliveryMetric('push', 'fcm', 'failed', fcmFailed);
      } else if (fcmTokens.length > 0) {
        this.logger.warn(`FCM push skipped: ${fcmTokens.length} native token(s) registered but Firebase Admin is unavailable`);
        // G494: metrik delivery — hanya counter, tanpa token/payload.
        recordDeliveryMetric('push', 'fcm', 'skipped');
      }

      if (unsupportedNativeTokenCount > 0) {
        this.logger.debug(`Native push skipped for ${unsupportedNativeTokenCount} unsupported non-Android token(s)`);
      }
      if (expoTokens.length > 0) {
        this.logger.debug(`Expo push sent: ${expoTokens.length} token(s)`);
      }
    } catch (error) {
      this.logger.error(`Push notification failed: ${(error as Error).message}`, (error as Error).stack);
    }
  }

  async sendToMultipleUsers(
    userIds: string[],
    title: string,
    body: string,
    data?: Record<string, string>,
  ): Promise<void> {
    const uniqueUserIds = [...new Set(userIds.filter((userId) => typeof userId === 'string' && userId.length > 0))];
    await Promise.allSettled(
      uniqueUserIds.map((userId) => this.sendToUser(userId, title, body, data)),
    );
  }
}
