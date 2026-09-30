/**
 * GAP-D retur — notifikasi tiap tahap (G221).
 *
 * Memakai pipeline notifikasi existing: baris `notification` (tipe existing
 * terdekat, lihat RETURN_STAGE_NOTIFICATION_TYPE) + `emitNotificationCreated`
 * (mendorong realtime socket & push). Payload `data.type = 'RETURN_*'`
 * dipakai frontend untuk deep-link ke layar retur.
 */
import { Injectable, Logger } from '@nestjs/common';
import { NotificationType } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { getCategoryForType } from '../notifications/notification-category.map';
import { generateNotifId } from '../../common/utils/id-generator.util';
import { RETURN_STAGE_NOTIFICATION_TYPE } from './returns.constants';

export interface ReturnNotifyParams {
  userId: string;
  stage: string; // mis. 'RETURN_REQUESTED'
  title: string;
  body: string;
  returnDbId: string;
  returnPublicId: string;
}

@Injectable()
export class ReturnsNotifyService {
  private readonly logger = new Logger(ReturnsNotifyService.name);

  constructor(private prisma: PrismaService) {}

  /**
   * Kirim ke satu user: persist baris + emit realtime/push (best-effort).
   *
   * BAI-098: mengembalikan `{ delivered }` — `false` bila persist baris
   * notifikasi gagal. Kegagalan dicatat di sini (logger.error) dan pemanggil
   * (aksi admin) wajib mencatatnya ke timeline agar terlihat di panel admin.
   */
  async notifyStage(params: ReturnNotifyParams): Promise<{ delivered: boolean }> {
    const type: NotificationType =
      RETURN_STAGE_NOTIFICATION_TYPE[params.stage] ?? NotificationType.SYSTEM_ANNOUNCEMENT;
    const data = {
      type: params.stage,
      returnId: params.returnDbId,
      returnPublicId: params.returnPublicId,
      actionUrl: `/returns/${params.returnDbId}`,
    };
    try {
      await this.prisma.notification.create({
        data: {
          notifId: generateNotifId(),
          userId: params.userId,
          type,
          category: getCategoryForType(type),
          title: params.title,
          body: params.body,
          isRead: false,
        },
      });
    } catch (err) {
      this.logger.error(`notifyStage: GAGAL persist notifikasi ${params.stage} ke user ${params.userId}: ${(err as Error).message}`);
      return { delivered: false };
    }
    try {
      this.prisma.emitNotificationCreated({
        userId: params.userId,
        title: params.title,
        body: params.body,
        data,
      });
    } catch (err) {
      this.logger.warn(`notifyStage: gagal emit ${params.stage}: ${(err as Error).message}`);
    }
    return { delivered: true };
  }

  /** Kirim ke buyer & seller sekaligus. `delivered` = true hanya bila keduanya persist. */
  async notifyBoth(
    buyerId: string,
    sellerId: string,
    stage: string,
    buyerTitle: string,
    buyerBody: string,
    sellerTitle: string,
    sellerBody: string,
    returnDbId: string,
    returnPublicId: string,
  ): Promise<{ delivered: boolean }> {
    const b = await this.notifyStage({ userId: buyerId, stage, title: buyerTitle, body: buyerBody, returnDbId, returnPublicId });
    const s = await this.notifyStage({ userId: sellerId, stage, title: sellerTitle, body: sellerBody, returnDbId, returnPublicId });
    return { delivered: b.delivered && s.delivered };
  }
}
