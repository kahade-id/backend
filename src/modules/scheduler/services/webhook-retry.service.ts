import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import { randomUUID } from 'crypto';
import { PrismaService } from '../../../prisma/prisma.service';
import { RedisService } from '../../../redis/redis.service';
import { ensureRedisAvailable } from '../../../common/utils/redis-health.util';
import { cronJitter } from '../../../common/utils/cron-jitter.util';
import { PaymentService } from '../../payment/payment.service';
import { MidtransNotificationDto } from '../../payment/dto/midtrans-notification.dto';
import { getWebhookRetryAt, MAX_WEBHOOK_ATTEMPTS } from '../../payment/webhook-retry.constants';
import { safeErrorMessage, startLockRenewal } from '../../../common/utils/background-reliability.util';

const WEBHOOK_RETRY_LOCK_KEY = 'cron_lock:webhook_inbox_retry';
const WEBHOOK_RETRY_LOCK_TTL_SECONDS = 110;
const DEFAULT_BATCH_SIZE = 25;

@Injectable()
export class WebhookRetryService {
  private readonly logger = new Logger(WebhookRetryService.name);
  private readonly batchSize: number;

  constructor(
    private prisma: PrismaService,
    private redis: RedisService,
    private paymentService: PaymentService,
    private configService: ConfigService,
  ) {
    const configuredBatchSize = this.configService.get<number>('app.webhookRetryBatchSize') ?? DEFAULT_BATCH_SIZE;
    this.batchSize = Math.min(Math.max(Math.trunc(configuredBatchSize), 1), 100);
  }

  // Provider retries are sparse; running every two minutes makes internal recovery
  // prompt without competing with Midtrans' own retry cadence.
  @Cron('*/2 * * * *', { name: 'webhook-inbox-retry', timeZone: 'UTC' })
  async retryFailedWebhooks(): Promise<void> {
    await cronJitter(10_000);
    if (!(await ensureRedisAvailable(this.redis, 'webhook-inbox-retry'))) return;

    const lockToken = randomUUID();
    if (!(await this.redis.setNx(WEBHOOK_RETRY_LOCK_KEY, lockToken, WEBHOOK_RETRY_LOCK_TTL_SECONDS))) {
      return;
    }

    const startedAt = Date.now();
    const stats = { fetched: 0, processed: 0, failed: 0, deadLettered: 0 };
    const lease = startLockRenewal(this.redis, WEBHOOK_RETRY_LOCK_KEY, lockToken, WEBHOOK_RETRY_LOCK_TTL_SECONDS, this.logger);
    try {
      const now = new Date();
      const candidates = await this.prisma.webhookLog.findMany({
        where: {
          source: 'MIDTRANS',
          isProcessed: false,
          deadLetteredAt: null,
          retryCount: { lt: MAX_WEBHOOK_ATTEMPTS },
          ipAddress: { not: null },
          OR: [
            { nextRetryAt: null },
            { nextRetryAt: { lte: now } },
          ],
        },
        orderBy: [{ nextRetryAt: 'asc' }, { createdAt: 'asc' }],
        take: this.batchSize,
      });
      stats.fetched = candidates.length;

      for (const candidate of candidates) {
        if (lease.lost()) {
          this.logger.warn('Webhook retry stopped because the Redis lease was lost.');
          break;
        }
        try {
          await this.paymentService.handleMidtransWebhook(
            candidate.payload as unknown as MidtransNotificationDto,
            candidate.ipAddress as string,
          );
          stats.processed += 1;
        } catch (error) {
          stats.failed += 1;
          const message = safeErrorMessage(error);
          const attempt = Math.max(candidate.retryCount + 1, 1);
          const deadLettered = attempt >= MAX_WEBHOOK_ATTEMPTS;
          if (deadLettered) stats.deadLettered += 1;

          await this.prisma.webhookLog.updateMany({
            where: { id: candidate.id, isProcessed: false, retryCount: candidate.retryCount },
            data: {
              retryCount: { increment: 1 },
              errorMessage: message,
              lastAttemptAt: new Date(),
              nextRetryAt: deadLettered ? null : getWebhookRetryAt(attempt),
              deadLetteredAt: deadLettered ? new Date() : null,
            },
          }).catch((updateError) => {
            this.logger.error(`Failed to schedule webhook retry id=${candidate.id}: ${updateError instanceof Error ? updateError.message : String(updateError)}`);
          });

          this.logger.warn(
            `Webhook retry failed id=${candidate.id} attempt=${attempt}/${MAX_WEBHOOK_ATTEMPTS} deadLettered=${deadLettered}: ${message}`,
          );
        }
      }

      const [retryableBacklog, deadLetterBacklog] = await Promise.all([
        this.prisma.webhookLog.count({
          where: {
            source: 'MIDTRANS',
            isProcessed: false,
            deadLetteredAt: null,
            retryCount: { lt: MAX_WEBHOOK_ATTEMPTS },
            OR: [{ nextRetryAt: null }, { nextRetryAt: { lte: new Date() } }],
          },
        }),
        this.prisma.webhookLog.count({
          where: { source: 'MIDTRANS', isProcessed: false, deadLetteredAt: { not: null } },
        }),
      ]);

      if (deadLetterBacklog > 0) {
        await this.redis.setex('cron_alert:webhook_inbox_dead_letter', 3600, JSON.stringify({
          raisedAt: new Date().toISOString(),
          count: deadLetterBacklog,
        })).catch((error) => this.logger.warn(`Failed to write webhook dead-letter alert: ${error instanceof Error ? error.message : String(error)}`));
        this.logger.error(`Webhook dead-letter backlog is ${deadLetterBacklog}`);
      } else {
        await this.redis.del('cron_alert:webhook_inbox_dead_letter').catch((error) => this.logger.warn(`Failed to clear webhook dead-letter alert: ${error instanceof Error ? error.message : String(error)}`));
      }

      if (retryableBacklog > this.batchSize * 4) {
        this.logger.warn(`Webhook retry backlog is high: ${retryableBacklog} eligible rows`);
      }

      await this.redis.setex('cron_heartbeat:webhook_inbox_retry', 86400, JSON.stringify({
        ranAt: new Date().toISOString(),
        stats: { ...stats, retryableBacklog, deadLetterBacklog },
        durationMs: Date.now() - startedAt,
      })).catch((error) => this.logger.warn(`Failed to write webhook retry heartbeat: ${error instanceof Error ? error.message : String(error)}`));
    } catch (error) {
      const message = safeErrorMessage(error);
      this.logger.error(`Webhook retry worker failed: ${message}`);
      await this.redis.setex('cron_alert:webhook_inbox_retry_failed', 3600, JSON.stringify({ failedAt: new Date().toISOString(), error: message })).catch((alertError: unknown) => this.logger.warn(`Failed to write webhook retry failure alert: ${safeErrorMessage(alertError)}`));
    } finally {
      lease.stop();
      await this.redis.releaseLock(WEBHOOK_RETRY_LOCK_KEY, lockToken).catch((error) => this.logger.warn(`Failed to release webhook retry lock: ${safeErrorMessage(error)}`));
    }
  }
}
