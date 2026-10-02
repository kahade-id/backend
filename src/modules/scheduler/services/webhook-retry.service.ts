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
import {
  DanaPaymentReconcileService,
  isTerminalReconcileOutcome,
} from './dana-payment-reconcile.service';

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
    private danaPaymentReconcile: DanaPaymentReconcileService,
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
          // SYS-B-305: webhook DANA (source='DANA') ikut di-retry — sebelumnya
          // hanya MIDTRANS sehingga notify DANA yang gagal diproses tak pernah
          // pulih via sistem (satu-satunya harapan adalah retry dari DANA).
          source: { in: ['MIDTRANS', 'DANA'] },
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
        // SYS-B-305: baris DANA tidak bisa di-replay lewat handler webhook
        // (verifikasi signature butuh raw body yang tak disimpan) — pulihkan
        // via jalur verify-via-API yang sama dipakai webhook itu sendiri.
        if (candidate.source === 'DANA') {
          await this.retryDanaWebhook(candidate, stats);
          continue;
        }
        try {
          await this.paymentService.handleMidtransWebhook(
            candidate.payload as unknown as MidtransNotificationDto,
            candidate.ipAddress as string,
          );
          stats.processed += 1;
        } catch (error) {
          stats.failed += 1;
          await this.recordAttemptFailure(candidate, safeErrorMessage(error), stats);
        }
      }

      const [retryableBacklog, deadLetterBacklog] = await Promise.all([
        this.prisma.webhookLog.count({
          where: {
            source: { in: ['MIDTRANS', 'DANA'] },
            isProcessed: false,
            deadLetteredAt: null,
            retryCount: { lt: MAX_WEBHOOK_ATTEMPTS },
            OR: [{ nextRetryAt: null }, { nextRetryAt: { lte: new Date() } }],
          },
        }),
        this.prisma.webhookLog.count({
          where: { source: { in: ['MIDTRANS', 'DANA'] }, isProcessed: false, deadLetteredAt: { not: null } },
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

  /**
   * SYS-B-305a: replay baris webhookLog DANA yang gagal diproses.
   *
   * Replay penuh lewat handler webhook tidak mungkin (verifikasi signature
   * RSA butuh raw body; yang tersimpan hanya payload ter-parse). Sebagai
   * gantinya dipakai jalur verify-via-API — persis seperti yang dilakukan
   * handler webhook setelah signature valid:
   *  - `finish_notify:*` → `DanaPaymentReconcileService`
   *    (getPaymentDetail + settle/expire). Outcome terminal → baris ditandai
   *    processed; bila belum terminal → backoff retry seperti MIDTRANS.
   *  - `disburs_notify:*` → cek status final EscrowDisbursement; yang belum
   *    final diserahkan ke cron `dana-refund-retry` → `reconcileProcessing()`
   *    (query Transfer-to-Bank Status API). Baris hanya dihitung gagal agar
   *    backoff/DLQ tetap berjalan.
   */
  private async retryDanaWebhook(
    candidate: { id: string; event: string | null; payload: unknown; retryCount: number },
    stats: { processed: number; failed: number; deadLettered: number },
  ): Promise<void> {
    const event = candidate.event ?? '';
    const payload = (candidate.payload ?? {}) as Record<string, unknown>;

    try {
      if (event.startsWith('finish_notify:')) {
        const partnerRefNo = String(
          payload['originalPartnerReferenceNo'] ?? payload['originalReferenceNo'] ?? '',
        ).trim();
        if (!partnerRefNo) {
          throw new Error('payload DANA finish_notify tanpa originalPartnerReferenceNo');
        }
        const outcome = await this.danaPaymentReconcile.reconcileByPartnerReferenceNo(partnerRefNo);
        if (isTerminalReconcileOutcome(outcome)) {
          await this.markProcessed(candidate.id);
          stats.processed += 1;
          this.logger.log(`DANA webhook retry ok id=${candidate.id} outcome=${outcome}`);
        } else {
          throw new Error(`reconcile belum terminal: ${outcome}`);
        }
        return;
      }

      if (event.startsWith('disburs_notify:')) {
        const partnerRefNo = String(
          payload['originalPartnerReferenceNo'] ?? payload['originalReferenceNo'] ?? '',
        ).trim();
        if (partnerRefNo) {
          const disb = await this.prisma.escrowDisbursement.findUnique({
            where: { danaPartnerReferenceNo: partnerRefNo },
            select: { id: true, status: true },
          });
          // Status final → notify sudah ter-apply (idempoten); baris selesai.
          // Selain itu → cron dana-refund-retry/reconcileProcessing yang
          // berwenang (query status resmi DANA); di sini cukup backoff.
          if (!disb || ['SUCCESS', 'FAILED', 'CANCELLED'].includes(disb.status)) {
            await this.markProcessed(candidate.id);
            stats.processed += 1;
            this.logger.log(`DANA disburs webhook retry ok id=${candidate.id} status=${disb?.status ?? 'tak-dikenal'}`);
            return;
          }
        }
        throw new Error('disbursement belum final — menunggu reconcileProcessing');
      }

      throw new Error(`event DANA tak dikenal: ${event || '(kosong)'}`);
    } catch (error) {
      stats.failed += 1;
      await this.recordAttemptFailure(candidate, safeErrorMessage(error), stats);
    }
  }

  private async markProcessed(id: string): Promise<void> {
    await this.prisma.webhookLog
      .updateMany({
        where: { id, isProcessed: false },
        data: { isProcessed: true, lastAttemptAt: new Date(), errorMessage: null },
      })
      .catch(error => {
        this.logger.error(`Failed to mark webhook processed id=${id}: ${error instanceof Error ? error.message : String(error)}`);
      });
  }

  private async recordAttemptFailure(
    candidate: { id: string; retryCount: number },
    message: string,
    stats: { failed: number; deadLettered: number },
  ): Promise<void> {
    const attempt = Math.max(candidate.retryCount + 1, 1);
    const deadLettered = attempt >= MAX_WEBHOOK_ATTEMPTS;
    if (deadLettered) stats.deadLettered += 1;

    await this.prisma.webhookLog
      .updateMany({
        where: { id: candidate.id, isProcessed: false, retryCount: candidate.retryCount },
        data: {
          retryCount: { increment: 1 },
          errorMessage: message,
          lastAttemptAt: new Date(),
          nextRetryAt: deadLettered ? null : getWebhookRetryAt(attempt),
          deadLetteredAt: deadLettered ? new Date() : null,
        },
      })
      .catch(updateError => {
        this.logger.error(
          `Failed to schedule webhook retry id=${candidate.id}: ${updateError instanceof Error ? updateError.message : String(updateError)}`,
        );
      });

    this.logger.warn(
      `Webhook retry failed id=${candidate.id} attempt=${attempt}/${MAX_WEBHOOK_ATTEMPTS} deadLettered=${deadLettered}: ${message}`,
    );
  }
}
