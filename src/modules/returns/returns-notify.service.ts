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

  /** Kirim ke satu user: persist baris + emit realtime/push (best-effort). */
  async notifyStage(params: ReturnNotifyParams): Promise<void> {
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
      this.logger.warn(`notifyStage: gagal persist notifikasi ${params.stage}: ${(err as Error).message}`);
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
  }

  /** Kirim ke buyer & seller sekaligus. */
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
  ): Promise<void> {
    await this.notifyStage({ userId: buyerId, stage, title: buyerTitle, body: buyerBody, returnDbId, returnPublicId });
    await this.notifyStage({ userId: sellerId, stage, title: sellerTitle, body: sellerBody, returnDbId, returnPublicId });
  }
}
