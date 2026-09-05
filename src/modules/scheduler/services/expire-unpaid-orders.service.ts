import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { OrderStatus, ActorType, NotificationType, Prisma } from '@prisma/client';
import { randomUUID } from 'crypto';
import { getCategoryForType } from '../../notifications/notification-category.map';
import { PrismaService } from '../../../prisma/prisma.service';
import { RedisService } from '../../../redis/redis.service';
import { generateNotifId } from '../../../common/utils/id-generator.util';
import { ensureRedisAvailable } from '../../../common/utils/redis-health.util';

@Injectable()
export class ExpireUnpaidOrdersService {
  private readonly logger = new Logger(ExpireUnpaidOrdersService.name);

  constructor(
    private prisma: PrismaService,
    private redis: RedisService,
  ) {}

  private emitRealtimeBestEffort(payload: { userId: string; title: string; body: string; data: Record<string, string> }, label: string): void {
    try {
      this.prisma.emitNotificationCreated(payload);
    } catch (error: unknown) {
      this.logger.warn(`${label} realtime notification failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // SCH-017: Runs every 10 minutes to expire unpaid orders past payment deadline
  @Cron('*/10 * * * *', { name: 'expire-unpaid-orders' })
  async expireUnpaidOrders(): Promise<void> {
    if (!(await ensureRedisAvailable(this.redis, 'expire-unpaid-orders'))) return;

    const lockKey = 'cron_lock:expire_unpaid_orders';
    const lockToken = randomUUID();
    const acquired = await this.redis.setNx(lockKey, lockToken, 600);
    if (!acquired) return;

    let lockLost = false;
    const lockRenewalInterval = setInterval(async () => {
      const renewed = await this.redis.renewLock(lockKey, lockToken, 600);
      if (!renewed) {
        lockLost = true;
        clearInterval(lockRenewalInterval);
        this.logger.warn('Expire unpaid orders lock ownership was lost; stopping after the current batch.');
      }
    }, 60_000);

    const now = new Date();
    try {
      let hasMore = true;
      while (hasMore) {
        if (lockLost || await this.redis.get(lockKey) !== lockToken) {
          this.logger.warn('Expire unpaid orders lock ownership was lost; aborting before the next batch.');
          return;
        }
        const expiredOrders = await this.prisma.order.findMany({
          where: {
            status: OrderStatus.WAITING_PAYMENT,
            paymentDeadlineAt: { lt: now },
          },
          select: { id: true, orderId: true, title: true, buyerId: true, sellerId: true, voucherId: true },
          take: 500,
        });

        if (expiredOrders.length === 0) { hasMore = false; break; }
        hasMore = expiredOrders.length === 500;

        this.logger.log(`Found ${expiredOrders.length} unpaid orders past deadline — expiring.`);

        for (const order of expiredOrders) {
          try {
            const didExpire = await this.prisma.$transaction(async (tx) => {
              const updated = await tx.order.updateMany({
                where: { id: order.id, status: OrderStatus.WAITING_PAYMENT, paymentDeadlineAt: { lt: now } },
                data: {
                  status: OrderStatus.CANCELLED,
                  cancelledAt: new Date(),
                  cancelReason: 'TIMEOUT_PAYMENT',
                },
              });
              if (updated.count === 0) return false;

              await tx.orderStatusHistory.create({
                data: {
                  orderId: order.id,
                  fromStatus: OrderStatus.WAITING_PAYMENT,
                  toStatus: OrderStatus.CANCELLED,
                  changedBy: 'SYSTEM',
                  changedByType: ActorType.SYSTEM,
                  reason: 'Auto-expired: payment deadline exceeded',
                },
              });

              if (order.voucherId) {
                const deletedVoucherUsage = await tx.voucherUsage.deleteMany({
                  where: { orderId: order.id, voucherId: order.voucherId },
                });
                if (deletedVoucherUsage.count > 0) {
                  await tx.voucher.updateMany({
                    where: { id: order.voucherId, currentUsage: { gt: 0 } },
                    data: { currentUsage: { decrement: 1 } },
                  });
                }
              }

              return true;
            }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });

            if (!didExpire) continue;

            this.prisma.notification.create({
              data: {
                notifId: generateNotifId(),
                userId: order.buyerId,
                type: NotificationType.ORDER_CANCELLED_TIMEOUT,
                category: getCategoryForType(NotificationType.ORDER_CANCELLED_TIMEOUT),
                title: 'Order Cancelled',
                body: `Order "${order.title}" has been cancelled because the payment deadline has passed.`,
                isRead: false,
              },
            }).catch((notificationError: unknown) => this.logger.warn(`silent-catch: unpaid buyer notification failed: ${notificationError instanceof Error ? notificationError.message : String(notificationError)}`));
            this.prisma.notification.create({
              data: {
                notifId: generateNotifId(),
                userId: order.sellerId,
                type: NotificationType.ORDER_CANCELLED_TIMEOUT,
                category: getCategoryForType(NotificationType.ORDER_CANCELLED_TIMEOUT),
                title: 'Order Cancelled',
                body: `Order "${order.title}" has been cancelled because the buyer did not pay before the deadline.`,
                isRead: false,
              },
            }).catch((notificationError: unknown) => this.logger.warn(`silent-catch: unpaid seller notification failed: ${notificationError instanceof Error ? notificationError.message : String(notificationError)}`));
            this.emitRealtimeBestEffort({
              userId: order.buyerId,
              title: 'Order Cancelled',
              body: `Order "${order.title}" has been cancelled because the payment deadline has passed.`,
              data: { type: 'ORDER_CANCELLED', orderId: order.orderId },
            }, 'EXPIRE_UNPAID_BUYER');
            this.emitRealtimeBestEffort({
              userId: order.sellerId,
              title: 'Order Cancelled',
              body: `Order "${order.title}" has been cancelled because the buyer did not pay before the deadline.`,
              data: { type: 'ORDER_CANCELLED', orderId: order.orderId },
            }, 'EXPIRE_UNPAID_SELLER');

            this.logger.log(`Expired unpaid order ${order.orderId}`);
          } catch (err: unknown) {
            const errMsg = err instanceof Error ? err.message : String(err);
            this.logger.error(`Failed to expire order ${order.orderId}: ${errMsg}`);
          }
        }
      }
    } catch (error) {
      this.logger.error('ExpireUnpaidOrders FAILED', error);
    } finally {
      clearInterval(lockRenewalInterval);
      await this.redis.releaseLock(lockKey, lockToken).catch((err) => this.logger.warn(`silent-catch: ${err instanceof Error ? err.message : String(err)}`));
    }
  }
}
