import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bull';
import { ConfigModule } from '@nestjs/config';
import { EmailProcessor, EMAIL_QUEUE } from './processors/email.processor';
import { NotificationProcessor, NOTIFICATION_QUEUE } from './processors/notification.processor';
import { NotificationQueueService } from './notification-queue.service';
import { RedisModule } from '../../redis/redis.module';
import { TemplateService } from '../../common/services/template.service';
import { DEAD_LETTER_QUEUE, QUEUE_JOB_TIMEOUT_MS } from './queue.constants';

@Module({
  imports: [
    ConfigModule,
    RedisModule,
    BullModule.registerQueue({
      name: EMAIL_QUEUE,
      limiter: {
        max: 50,
        duration: 1000,
      },
      settings: { stalledInterval: 30_000, maxStalledCount: 1 },
      defaultJobOptions: {
        attempts: 3,
        timeout: QUEUE_JOB_TIMEOUT_MS,
        backoff: {
          type: 'exponential',
          delay: 5000,
        },
        removeOnComplete: 100,
        removeOnFail: 50,
      },
    }),
    BullModule.registerQueue({
      name: NOTIFICATION_QUEUE,
      settings: { stalledInterval: 30_000, maxStalledCount: 1 },
      defaultJobOptions: {
        attempts: 3,
        timeout: QUEUE_JOB_TIMEOUT_MS,
        backoff: {
          type: 'exponential',
          delay: 3000,
        },
        removeOnComplete: 100,
        removeOnFail: 50,
      },
    }),
    BullModule.registerQueue({
      name: DEAD_LETTER_QUEUE,
      settings: { stalledInterval: 60_000, maxStalledCount: 1 },
      defaultJobOptions: {
        attempts: 1,
        timeout: QUEUE_JOB_TIMEOUT_MS,
        removeOnComplete: false,
        removeOnFail: false,
      },
    }),
  ],
  providers: [EmailProcessor, NotificationProcessor, TemplateService, NotificationQueueService],
  exports: [BullModule, TemplateService, NotificationQueueService],
})
export class QueueModule {}
