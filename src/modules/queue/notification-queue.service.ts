import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bull';
import { Queue } from 'bull';
import { NOTIFICATION_QUEUE, NotificationJobData } from './processors/notification.processor';

@Injectable()
export class NotificationQueueService {
  private readonly logger = new Logger(NotificationQueueService.name);

  constructor(
    @InjectQueue(NOTIFICATION_QUEUE) private readonly notificationQueue: Queue<NotificationJobData>,
  ) {}

  async enqueue(data: NotificationJobData): Promise<void> {
    const jobData: NotificationJobData = {
      ...data,
      language: data.language ?? 'id',
    };
    try {
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
