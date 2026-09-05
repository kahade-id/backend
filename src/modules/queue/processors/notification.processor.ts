import { Processor, Process, OnQueueFailed } from '@nestjs/bull';
import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bull';
import { Job, Queue } from 'bull';
import { NotificationChannel, NotificationType, Prisma } from '@prisma/client';
import { createHash } from 'crypto';
import { PrismaService } from '../../../prisma/prisma.service';
import { getCategoryForType } from '../../notifications/notification-category.map';
import { DEAD_LETTER_QUEUE, deadLetterJobId } from '../queue.constants';
import { safeErrorMessage } from '../../../common/utils/background-reliability.util';

/**
 * Derive a STABLE notifId from the Bull job id.
 *
 * Previously this processor called `generateNotifId()`, which returns a fresh
 * random id on every invocation. Bull gives at-least-once delivery: if the
 * worker is killed (or the job stalls) after `notification.create()` has
 * committed but before Bull records the completion, the job is redelivered and
 * a *second* notification row was inserted and a *second* push fired for the
 * same event — with `attempts: 3` configured, up to 3 duplicates per event.
 *
 * Keying the id off `job.id` (which is stable across retries of the same job)
 * makes the insert collide with the existing `Notification.notifId @unique`
 * constraint on redelivery, so the duplicate is rejected by the database rather
 * than relying on a read-then-write check that has its own race window.
 *
 * Keeps the existing `NTF-{16 alphanumeric}` shape, so nothing downstream that
 * parses or validates notifId needs to change.
 */
function stableNotifId(jobId: Job['id']): string {
  const digest = createHash('sha256').update(`notification:${String(jobId)}`).digest('hex');
  return `NTF-${digest.slice(0, 16)}`;
}

export const NOTIFICATION_QUEUE = 'notification';

export interface NotificationJobData {
  userId: string;
  type: NotificationType;
  title: string;
  body: string;
  pushData?: Record<string, string>;
  actionUrl?: string;
  language?: string;
  channel?: NotificationChannel;
}

@Injectable()
@Processor(NOTIFICATION_QUEUE)
export class NotificationProcessor {
  private readonly logger = new Logger(NotificationProcessor.name);

  constructor(
    private prisma: PrismaService,
    @InjectQueue(DEAD_LETTER_QUEUE) private readonly deadLetterQueue: Queue,
  ) {}

  @Process({ name: 'send', concurrency: 5 })
  async handleSendNotification(job: Job<NotificationJobData>): Promise<void> {
    const { userId, type, title, body, pushData, actionUrl, language, channel } = job.data;

    if (!userId || !type || !title || !body) {
      throw new Error(`Notification job ${job.id} has invalid payload`);
    }

    const category = getCategoryForType(type);
    const resolvedActionUrl = actionUrl ?? this.deriveActionUrl(pushData);

    let notification;
    try {
      notification = await this.prisma.notification.create({
        data: {
          notifId: stableNotifId(job.id),
          userId,
          type,
          category,
          title,
          body,
          channel: channel ?? NotificationChannel.IN_APP,
          isRead: false,
          ...(resolvedActionUrl ? { actionUrl: resolvedActionUrl } : {}),
          ...(language ? { metadata: { language } } : {}),
        },
      });
    } catch (e) {
      // P2002 = unique constraint violation on notifId, i.e. an earlier delivery
      // of THIS job already persisted the notification. Treat as success and
      // return without re-emitting, so the user does not get a duplicate push.
      if (
        e instanceof Prisma.PrismaClientKnownRequestError
        && e.code === 'P2002'
        && Array.isArray(e.meta?.target)
        && e.meta.target.includes('notifId')
      ) {
        this.logger.warn(
          `Notification job ${job.id} redelivered (attempt ${job.attemptsMade}) — row already exists, skipping duplicate push`,
        );
        return;
      }
      throw e;
    }

    this.prisma.emitNotificationCreated({
      userId,
      title,
      body,
      data: {
        ...pushData,
        notificationId: notification.notifId,
        ...(resolvedActionUrl ? { actionUrl: resolvedActionUrl } : {}),
        notificationType: type,
        notificationCategory: category,
      },
    });

    this.logger.debug(`Notification job ${job.id} processed (lang=${language ?? 'default'})`);
  }

  private deriveActionUrl(data?: Record<string, string>): string | undefined {
    if (data?.actionUrl) return data.actionUrl;
    if (data?.orderId) return `/order/${encodeURIComponent(data.orderId)}`;
    if (data?.orderLinkToken) return `/link/${encodeURIComponent(data.orderLinkToken)}`;
    if (data?.roomId ?? data?.chatRoomId) return `/chat/${encodeURIComponent(data.roomId ?? data.chatRoomId ?? '')}`;
    if (data?.transactionId ?? data?.txId) return `/wallet/transaction?id=${encodeURIComponent(data.transactionId ?? data.txId ?? '')}`;
    if (data?.disputeId) return `/dispute/${encodeURIComponent(data.disputeId)}`;
    return undefined;
  }

  @OnQueueFailed()
  async onJobFailed(job: Job<NotificationJobData>, error: Error): Promise<void> {
    this.logger.error(
      `Notification job ${job.id} FAILED (attempt ${job.attemptsMade}/${job.opts.attempts}): ${error.message}`,
    );

    if (job.attemptsMade >= (job.opts.attempts || 1)) {
        await this.deadLetterQueue.add('notification-failed', {
        originalQueue: NOTIFICATION_QUEUE,
        jobId: job.id,
        data: job.data,
        error: safeErrorMessage(error),
        failedAt: new Date().toISOString(),
      }, {
        jobId: deadLetterJobId(NOTIFICATION_QUEUE, job.id),
        removeOnComplete: false,
        removeOnFail: false,
      }).catch((dlqErr: unknown) => {
        this.logger.error(`CRITICAL: Dead-letter queue enqueue failed for notification job ${job.id} — event lost`, dlqErr);
      });
    }
  }
}
