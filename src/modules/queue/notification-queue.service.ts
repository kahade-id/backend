import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bull';
import { Queue } from 'bull';
import { NOTIFICATION_QUEUE, NotificationJobData } from './processors/notification.processor';
import { RedisService } from '../../redis/redis.service';

// Jendela dedup enqueue: replay webhook / retry produsen dalam 5 menit
// untuk event bisnis yang sama tidak boleh menghasilkan notif ganda.
const ENQUEUE_DEDUP_TTL_SECONDS = 300;

@Injectable()
export class NotificationQueueService {
  private readonly logger = new Logger(NotificationQueueService.name);

  constructor(
    @InjectQueue(NOTIFICATION_QUEUE) private readonly notificationQueue: Queue<NotificationJobData>,
    private readonly redis: RedisService,
  ) {}

  /**
   * Kunci dedup deterministik dari (user, tipe, referensi bisnis).
   * Null bila tidak ada referensi — enqueue tetap jalan tanpa dedup.
   */
  private dedupKey(data: NotificationJobData): string | null {
    const pushData = data.pushData ?? {};
    const ref =
      pushData.orderId ?? pushData.roomId ?? pushData.chatRoomId ??
      pushData.disputeId ?? pushData.transactionId ?? pushData.txId ??
      data.actionUrl ?? null;
    if (!ref || typeof ref !== 'string' || ref.length === 0) return null;
    return `notif:dedup:${data.userId}:${data.type}:${ref}`;
  }

  async enqueue(data: NotificationJobData): Promise<void> {
    const jobData: NotificationJobData = {
      ...data,
      language: data.language ?? 'id',
    };
    try {
      const key = this.dedupKey(jobData);
      if (key) {
        const acquired = await this.redis.setNx(key, '1', ENQUEUE_DEDUP_TTL_SECONDS).catch(() => true);
        if (!acquired) {
          this.logger.debug(`Skipping duplicate notification enqueue type=${String(jobData.type)} userId=${jobData.userId}`);
          return;
        }
      }
      await this.notificationQueue.add('send', jobData);
      return;
    } catch (error) {
      // Notification delivery is asynchronous and must not roll back or mask a committed
      // order/wallet mutation. The queue processor/reconciliation can retry separately.
      this.logger.error(`Notification enqueue failed for type=${String(jobData.type)}`, error instanceof Error ? error.stack : String(error));
      return;
    }
  }

  async enqueueMany(data: NotificationJobData[]): Promise<number> {
    if (data.length === 0) return 0;
    const jobs = data.map((item) => ({
      name: 'send',
      data: {
        ...item,
        language: item.language ?? 'id',
      },
    }));
    try {
      await this.notificationQueue.addBulk(jobs);
      return jobs.length;
    } catch (error) {
      // A broadcast may contain many jobs, so use one bulk operation per batch and
      // report the queued count to the caller without rolling back earlier batches.
      this.logger.error(`Notification bulk enqueue failed for ${jobs.length} jobs`, error instanceof Error ? error.stack : String(error));
      return 0;
    }
  }
}
