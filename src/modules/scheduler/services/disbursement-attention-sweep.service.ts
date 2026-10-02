import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { randomUUID } from 'crypto';
import { PrismaService } from '../../../prisma/prisma.service';
import { RedisService } from '../../../redis/redis.service';
import { cronJitter } from '../../../common/utils/cron-jitter.util';
import { ensureRedisAvailable } from '../../../common/utils/redis-health.util';
import { safeErrorMessage } from '../../../common/utils/background-reliability.util';
import { alertDisbursementNeedsAttention } from '../common/money-alert.util';

/**
 * SYS-B-306 (audit sistemik ronde 3): HELD_NO_BANK & NEEDS_REVIEW selama ini
 * manual-only TANPA alert — uang fail-closed (tidak hilang) tetapi tertahan
 * sampai admin kebetulan membuka dashboard dengan filter yang tepat.
 *
 * Cron tiap 10 menit memindai baris EscrowDisbursement berstatus
 * HELD_NO_BANK / NEEDS_REVIEW dan mengirim alert (notif jejak adminAuditLog
 * + Redis alert key) via helper bersama `alertDisbursementNeedsAttention`.
 *
 * Helper yang sama diekspos untuk dipanggil LANGSUNG dari
 * `dana-webhook-disbursement.service.ts` `applyStatus()` (oleh W1) tepat
 * setelah transisi ke NEEDS_REVIEW — alert seketika. Dedup via Redis
 * (`disbursement_alerted:<id>`, 7 hari) membuat kedua jalur aman dari
 * alert ganda. Sweep ini adalah safety net bila transisi terjadi dari jalur
 * lain (mis. settle() → HELD_NO_BANK di escrow-disbursement.service.ts).
 *
 * NEEDS_REVIEW sekaligus memenuhi "antrean kerja" minimal SYS-B-304.
 */
@Injectable()
export class DisbursementAttentionSweepService {
  private readonly logger = new Logger(DisbursementAttentionSweepService.name);

  constructor(
    private prisma: PrismaService,
    private redis: RedisService,
  ) {}

  // Tiap 10 menit — antrean tertahan harus terlihat cepat oleh admin.
  @Cron('*/10 * * * *', { name: 'disbursement-attention-sweep', timeZone: 'Asia/Jakarta' })
  async sweepAttentionQueue(): Promise<void> {
    await cronJitter(10_000);
    if (!(await ensureRedisAvailable(this.redis, 'disbursement-attention-sweep'))) return;

    const lockKey = 'cron_lock:disbursement_attention_sweep';
    const lockToken = randomUUID();
    if (!(await this.redis.setNx(lockKey, lockToken, 480))) return;

    try {
      const rows = await this.prisma.escrowDisbursement.findMany({
        where: { status: { in: ['HELD_NO_BANK', 'NEEDS_REVIEW'] } },
        select: {
          id: true,
          idempotencyKey: true,
          status: true,
          amountSen: true,
          sellerId: true,
          orderId: true,
          heldReason: true,
          lastError: true,
          createdAt: true,
          updatedAt: true,
        },
        orderBy: { updatedAt: 'asc' },
        take: 200,
      });

      let alerted = 0;
      for (const row of rows) {
        const reason =
          row.status === 'HELD_NO_BANK'
            ? (row.heldReason ?? 'seller belum memiliki rekening bank terverifikasi')
            : (row.lastError ?? 'status DANA tak dikenal / nominal mismatch — butuh review manual');
        const raised = await alertDisbursementNeedsAttention({
          prisma: this.prisma,
          redis: this.redis,
          logger: this.logger,
          disbursementId: row.id,
          idempotencyKey: row.idempotencyKey,
          status: row.status as 'HELD_NO_BANK' | 'NEEDS_REVIEW',
          reason: `${reason} (order=${row.orderId ?? '-'}, seller=${row.sellerId})`,
        });
        if (raised) alerted++;
      }

      if (rows.length > 0) {
        this.logger.log(
          `disbursement-attention-sweep: queue=${rows.length} alertBaru=${alerted}`,
        );
      }
      await this.redis
        .setex(
          'cron_heartbeat:disbursement_attention_sweep',
          86400,
          JSON.stringify({
            ranAt: new Date().toISOString(),
            queueDepth: rows.length,
            alerted,
            heldNoBank: rows.filter(r => r.status === 'HELD_NO_BANK').length,
            needsReview: rows.filter(r => r.status === 'NEEDS_REVIEW').length,
          }),
        )
        .catch((err: unknown) => this.logger.warn(`silent-catch: ${safeErrorMessage(err)}`));
    } catch (error) {
      this.logger.error(`disbursement-attention-sweep gagal: ${safeErrorMessage(error)}`);
    } finally {
      await this.redis.releaseLock(lockKey, lockToken).catch(() => undefined);
    }
  }
}
