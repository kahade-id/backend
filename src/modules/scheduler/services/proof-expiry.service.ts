import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { NotificationType } from '@prisma/client';
import { randomUUID } from 'crypto';
import { getCategoryForType } from '../../notifications/notification-category.map';
import { PrismaService } from '../../../prisma/prisma.service';
import { RedisService } from '../../../redis/redis.service';
import { cronJitter } from '../../../common/utils/cron-jitter.util';
import { generateNotifId } from '../../../common/utils/id-generator.util';
import { ensureRedisAvailable } from '../../../common/utils/redis-health.util';

@Injectable()
export class ProofExpiryService {
  private readonly logger = new Logger(ProofExpiryService.name);

  constructor(
    private prisma: PrismaService,
    private redis: RedisService,
  ) {}

  private runRealtimeBestEffort(task: () => void, label: string): void {
    try {
      task();
    } catch (error: unknown) {
      this.logger.warn(`${label} realtime side effect failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  @Cron('*/15 * * * *', { name: 'proof-expiry' })
  async expireUnreviewedProofs(): Promise<void> {
    await cronJitter(15_000);
    if (!(await ensureRedisAvailable(this.redis, 'proof-expiry'))) return;

    const lockKey = 'cron_lock:proof_expiry';
    const lockToken = randomUUID();
    const acquired = await this.redis.setNx(lockKey, lockToken, 600);
    if (!acquired) return;

    let lockLost = false;
    const lockRenewalInterval = setInterval(async () => {
      const renewed = await this.redis.renewLock(lockKey, lockToken, 600);
      if (!renewed) {
        lockLost = true;
        clearInterval(lockRenewalInterval);
        this.logger.warn('Proof expiry lock ownership was lost; stopping after the current batch.');
      }
    }, 60_000);

    const now = new Date();

    try {
      let hasMore = true;
      while (hasMore) {
        if (lockLost || await this.redis.get(lockKey) !== lockToken) {
          this.logger.warn('Proof expiry lock ownership was lost; aborting before the next batch.');
          return;
        }
        const expiredProofs = await this.prisma.deliveryProof.findMany({
          where: {
            status: 'SUBMITTED',
            reviewWindowEnd: { lt: now },
          },
          select: {
            id: true,
            orderId: true,
            order: {
              select: { orderId: true, title: true, buyerId: true, sellerId: true, status: true },
            },
          },
          take: 100,
        });

        if (expiredProofs.length === 0) break;
        hasMore = expiredProofs.length === 100;
        this.logger.log(`Found ${expiredProofs.length} expired unreviewed delivery proofs — auto-rejecting`);

        for (const proof of expiredProofs) {
        try {
          const updated = await this.prisma.deliveryProof.updateMany({
            where: { id: proof.id, status: 'SUBMITTED', reviewWindowEnd: { lt: now }, order: { status: 'IN_DELIVERY' } },
            data: {
              status: 'REJECTED',
              reviewedAt: new Date(),
              rejectionNote: 'Auto-expired: buyer did not review within the review window',
            },
          });
          if (updated.count === 0) continue;

          this.prisma.notification.create({
            data: {
              notifId: generateNotifId(),
              userId: proof.order.sellerId,
              type: NotificationType.ORDER_DELIVERED,
              category: getCategoryForType(NotificationType.ORDER_DELIVERED),
              title: 'Bukti Pengiriman Kedaluwarsa',
              body: `Bukti pengiriman untuk order "${proof.order.title}" sudah melewati batas waktu review. Silakan kirim bukti pengiriman baru.`,
              isRead: false,
            },
          }).catch((notificationError: unknown) => this.logger.warn(`silent-catch: proof expiry notification failed: ${notificationError instanceof Error ? notificationError.message : String(notificationError)}`));
          this.runRealtimeBestEffort(() => this.prisma.emitNotificationCreated({
            userId: proof.order.sellerId,
            title: 'Bukti Pengiriman Kedaluwarsa',
            body: `Bukti pengiriman untuk order "${proof.order.title}" kedaluwarsa. Kirim ulang bukti baru.`,
            data: { type: 'ORDER_DELIVERED', orderId: proof.order.orderId },
          }), `PROOF_EXPIRY_NOTIFICATION orderId=${proof.order.orderId}`);

          this.logger.log(`Auto-expired proof ${proof.id} for order ${proof.order.orderId}`);
        } catch (err) {
          this.logger.error(`Failed to expire proof ${proof.id}: ${err instanceof Error ? err.message : String(err)}`);
        }
        }
      }
    } catch (error) {
      this.logger.error('ProofExpiryService FAILED', error);
    } finally {
      clearInterval(lockRenewalInterval);
      await this.redis.releaseLock(lockKey, lockToken).catch((err) => this.logger.warn(`silent-catch: ${err instanceof Error ? err.message : String(err)}`));
    }
  }
}
