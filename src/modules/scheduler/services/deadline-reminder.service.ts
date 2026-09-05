import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { OrderStatus, NotificationType } from '@prisma/client';
import { randomUUID } from 'crypto';
import { getCategoryForType } from '../../notifications/notification-category.map';
import { PrismaService } from '../../../prisma/prisma.service';
import { RedisService } from '../../../redis/redis.service';
import { generateNotifId } from '../../../common/utils/id-generator.util';
import { ensureRedisAvailable } from '../../../common/utils/redis-health.util';

const REMINDER_WINDOWS_HOURS = [48, 24, 6];

@Injectable()
export class DeadlineReminderService {
  private readonly logger = new Logger(DeadlineReminderService.name);

  constructor(
    private prisma: PrismaService,
    private redis: RedisService,
  ) {}

  private async isReminderStillEligible(orderId: string, audience: 'buyer' | 'seller', now: Date): Promise<boolean> {
    try {
      const order = await this.prisma.order.findUnique({
        where: { id: orderId },
        select: {
          status: true,
          deliveryDeadlineAt: true,
          dispute: { select: { id: true } },
          deliveryProofs: { where: { status: 'SUBMITTED' }, select: { id: true }, take: 1 },
        },
      });
      if (!order || !order.deliveryDeadlineAt || order.deliveryDeadlineAt <= now || order.dispute) return false;
      if (audience === 'buyer') return order.status === OrderStatus.IN_DELIVERY && order.deliveryProofs.length > 0;
      return (order.status === OrderStatus.PROCESSING || order.status === OrderStatus.IN_DELIVERY) && order.deliveryProofs.length === 0;
    } catch (error: unknown) {
      this.logger.warn(`Reminder eligibility check failed for ${orderId}: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  }

  @Cron('*/30 * * * *', { name: 'deadline-reminders' })
  async sendDeadlineReminders(): Promise<void> {
    if (!(await ensureRedisAvailable(this.redis, 'deadline-reminders'))) return;

    const lockKey = 'cron_lock:deadline_reminders';
    const lockToken = randomUUID();
    const acquired = await this.redis.setNx(lockKey, lockToken, 900);
    if (!acquired) return;

    const now = new Date();

    try {
      for (const hoursBeforeDeadline of REMINDER_WINDOWS_HOURS) {
        const windowStart = new Date(now.getTime() + (hoursBeforeDeadline - 1) * 60 * 60 * 1000);
        const windowEnd = new Date(now.getTime() + hoursBeforeDeadline * 60 * 60 * 1000);

        const buyerOrders = await this.prisma.order.findMany({
          where: {
            status: OrderStatus.IN_DELIVERY,
            deliveryDeadlineAt: { gte: windowStart, lt: windowEnd },
            dispute: { is: null },
            deliveryProofs: {
              some: { status: 'SUBMITTED' },
            },
          },
          select: { id: true, orderId: true, buyerId: true, title: true },
          take: 200,
        });

        for (const order of buyerOrders) {
          if (!(await this.isReminderStillEligible(order.id, 'buyer', now))) continue;
          const dedupKey = `reminder:deadline:${order.id}:${hoursBeforeDeadline}h:buyer`;
          const claimed = await this.redis.setNx(dedupKey, '1', hoursBeforeDeadline * 3600);
          if (!claimed) continue;

          try {
            let title: string;
            let body: string;
            if (hoursBeforeDeadline <= 6) {
              title = '⚠️ Deadline Segera Berakhir';
              body = `Order "${order.title}" akan otomatis diselesaikan dalam ${hoursBeforeDeadline} jam. Segera review bukti pengiriman sekarang.`;
            } else if (hoursBeforeDeadline <= 24) {
              title = 'Reminder: Review Bukti Pengiriman';
              body = `Order "${order.title}" akan otomatis diselesaikan besok. Pastikan Anda sudah review bukti pengiriman.`;
            } else {
              title = 'Reminder: Bukti Pengiriman Menunggu Review';
              body = `Bukti pengiriman untuk order "${order.title}" belum Anda review. Deadline dalam 2 hari.`;
            }

            await this.prisma.notification.create({
              data: {
                notifId: generateNotifId(),
                userId: order.buyerId,
                type: NotificationType.ORDER_DELIVERED,
                category: getCategoryForType(NotificationType.ORDER_DELIVERED),
                title,
                body,
                isRead: false,
              },
            });
            try {
              this.prisma.emitNotificationCreated({
                userId: order.buyerId,
                title,
                body,
                data: { type: 'ORDER_DELIVERED', orderId: order.orderId },
              });
            } catch (error: unknown) {
              this.logger.warn(`Buyer reminder realtime emit failed: ${error instanceof Error ? error.message : String(error)}`);
            }

          } catch (err) {
            await this.redis.del(dedupKey).catch((cleanupError) => this.logger.warn(`Reminder dedup rollback failed: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`));
            this.logger.error(`Failed to send ${hoursBeforeDeadline}h buyer reminder for order ${order.orderId}: ${err instanceof Error ? err.message : String(err)}`);
          }
        }

        const sellerOrders = await this.prisma.order.findMany({
          where: {
            status: { in: [OrderStatus.PROCESSING, OrderStatus.IN_DELIVERY] },
            deliveryDeadlineAt: { gte: windowStart, lt: windowEnd },
            dispute: { is: null },
            deliveryProofs: {
              none: { status: 'SUBMITTED' },
            },
          },
          select: { id: true, orderId: true, sellerId: true, title: true, status: true },
          take: 200,
        });

        for (const order of sellerOrders) {
          if (!(await this.isReminderStillEligible(order.id, 'seller', now))) continue;
          const dedupKey = `reminder:deadline:${order.id}:${hoursBeforeDeadline}h:seller`;
          const claimed = await this.redis.setNx(dedupKey, '1', hoursBeforeDeadline * 3600);
          if (!claimed) continue;

          try {
            let title: string;
            let body: string;
            if (hoursBeforeDeadline <= 6) {
              title = '⚠️ Segera Kirim Bukti Pengiriman';
              body = `Deadline order "${order.title}" tinggal ${hoursBeforeDeadline} jam lagi. Segera kirim bukti pengiriman sebelum order otomatis dibatalkan.`;
            } else if (hoursBeforeDeadline <= 24) {
              title = 'Reminder: Kirim Bukti Pengiriman';
              body = `Deadline order "${order.title}" besok. Pastikan Anda sudah mengirim bukti pengiriman.`;
            } else {
              title = 'Reminder: Belum Ada Bukti Pengiriman';
              body = `Order "${order.title}" belum memiliki bukti pengiriman. Deadline dalam 2 hari.`;
            }

            await this.prisma.notification.create({
              data: {
                notifId: generateNotifId(),
                userId: order.sellerId,
                type: NotificationType.ORDER_DEADLINE_REMINDER,
                category: getCategoryForType(NotificationType.ORDER_DEADLINE_REMINDER),
                title,
                body,
                isRead: false,
              },
            });
            try {
              this.prisma.emitNotificationCreated({
                userId: order.sellerId,
                title,
                body,
                data: { type: 'ORDER_DEADLINE_REMINDER', orderId: order.orderId },
              });
            } catch (error: unknown) {
              this.logger.warn(`Seller reminder realtime emit failed: ${error instanceof Error ? error.message : String(error)}`);
            }

          } catch (err) {
            await this.redis.del(dedupKey).catch((cleanupError) => this.logger.warn(`Reminder dedup rollback failed: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`));
            this.logger.error(`Failed to send ${hoursBeforeDeadline}h seller reminder for order ${order.orderId}: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
      }
    } catch (error) {
      this.logger.error('DeadlineReminderService FAILED', error);
    } finally {
      await this.redis.releaseLock(lockKey, lockToken).catch((err) => this.logger.warn(`silent-catch: ${err instanceof Error ? err.message : String(err)}`));
    }
  }
}
