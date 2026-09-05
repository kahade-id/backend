import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service';
import { NotificationType } from '@prisma/client';
import * as admin from 'firebase-admin';

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

  private async shouldSendPush(userId: string, data?: Record<string, string>): Promise<boolean> {
    const notificationType = data?.notificationType ?? data?.type;
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
          continue;
        }

        const result = await response.json() as { data: Array<{ status: string; message?: string; details?: { error?: string } }> };
        for (let i = 0; i < (result.data?.length ?? 0); i++) {
          const ticket = result.data[i];
          if (ticket.status !== 'error') continue;
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
      } catch (error) {
        this.logger.error(`Expo push API call failed: ${(error as Error).message}`);
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

      if (allTokens.length === 0) return;

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

      if (expoTokens.length > 0) {
        await this.sendViaExpo(expoTokens, title, body, pushData, channelId, expoDeviceMap);
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
      } else if (fcmTokens.length > 0) {
        this.logger.warn(`FCM push skipped: ${fcmTokens.length} native token(s) registered but Firebase Admin is unavailable`);
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
