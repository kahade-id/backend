import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { randomUUID } from 'crypto';
import { PrismaService } from '../../../prisma/prisma.service';
import { RedisService } from '../../../redis/redis.service';
import { cronJitter } from '../../../common/utils/cron-jitter.util';
import { alertMoneyCronSkippedRedisDown, ensureRedisAvailable } from '../../../common/utils/redis-health.util';
import { toIdr } from '../../../common/utils/currency.util';
import { safeErrorMessage } from '../../../common/utils/background-reliability.util';
import { alertAdminsOnMoneyAnomaly } from '../common/money-alert.util';

/**
 * SYS-B-304 (audit sistemik ronde 3): rekonsiliasi DANA→DB, arah yang hilang.
 *
 * Rekonsiliasi disbursement yang ada (`reconcileProcessing`) hanya satu arah
 * (DB→DANA: query status per baris DB). Tidak ada yang memeriksa arah
 * sebaliknya — refund yang tereksekusi di DANA tapi tak tercatat di DB.
 *
 * Cron ini memeriksa konservasi refund per payment:
 *   Σ danaRefundAttempt(status=SUCCESS).amountSen  vs  paymentTransaction.refundedAmount
 *
 * - Σ_attempt > refundedAmount → tanda tangan SEC-103 OVER_REFUND_BLOCKED:
 *   refund DANA SUDAH tereksekusi (uang keluar) tetapi pencatatan DB diblokir
 *   karena total refund konkuren melebihi gross. Sebelumnya kasus ini hanya
 *   `logger.error` di dana-direct-refund.service.ts tanpa alert/antrean.
 *   → alert + adminAuditLog (antrean kerja manual).
 * - Σ_attempt < refundedAmount → refundedAmount tercatat tanpa attempt yang
 *   cocok (jalur non-durable, mis. refund topup pra-SYS-B-103) → anomali
 *   pencatatan, alert terpisah.
 *
 * CATATAN API: `DanaPaymentService` (wrapper API DANA) hanya mengekspos
 * create/query/refund/cancel — TIDAK ada endpoint listing riwayat
 * disbursement/refund di sisi DANA. Rekonsiliasi "tarik riwayat DANA lalu
 * cocokkan" belum bisa dibangun tanpa integrasi API baru; itu tindak lanjut
 * terpisah. Yang dibangun di sini adalah jaring pengaman DB-side terkuat
 * yang dimungkinkan hari ini.
 *
 * NEEDS_REVIEW ditangani `disbursement-attention-sweep` (tiap 10 menit);
 * HELD_NO_BANK juga di sana (SYS-B-306).
 */
@Injectable()
export class DanaDbReconciliationService {
  private readonly logger = new Logger(DanaDbReconciliationService.name);

  constructor(
    private prisma: PrismaService,
    private redis: RedisService,
  ) {}

  // Tiap jam menit :20 (hindari tabrakan dispute-settlement :25,
  // dana-payment-reconcile berjalan tiap 15 menit di :00/:15/:30/:45).
  @Cron('20 * * * *', { name: 'dana-db-reconciliation', timeZone: 'Asia/Jakarta' })
  async runDanaDbReconciliation(): Promise<void> {
    await cronJitter(20_000);
    if (!(await ensureRedisAvailable(this.redis, 'dana-db-reconciliation', {
        onRedisDown: () => alertMoneyCronSkippedRedisDown('dana-db-reconciliation'),
      }))) return;

    const lockKey = 'cron_lock:dana_db_reconciliation';
    const lockToken = randomUUID();
    if (!(await this.redis.setNx(lockKey, lockToken, 900))) return;

    const startedAt = Date.now();
    try {
      const stats = await this.checkRefundConservation();
      const durationMs = Date.now() - startedAt;
      this.logger.log(
        `dana-db-reconciliation selesai: payments=${stats.paymentsChecked} ` +
          `overRefund=${stats.overRefundGaps} underRecorded=${stats.underRecorded} (${durationMs}ms)`,
      );
      await this.redis
        .setex(
          'cron_heartbeat:dana_db_reconciliation',
          86400,
          JSON.stringify({ ranAt: new Date().toISOString(), durationMs, ...stats }),
        )
        .catch((err: unknown) => this.logger.warn(`silent-catch: ${safeErrorMessage(err)}`));
    } catch (error) {
      this.logger.error(`dana-db-reconciliation gagal: ${safeErrorMessage(error)}`);
    } finally {
      await this.redis.releaseLock(lockKey, lockToken).catch(() => undefined);
    }
  }

  async checkRefundConservation(): Promise<{
    paymentsChecked: number;
    overRefundGaps: number;
    underRecorded: number;
  }> {
    // Kelompokkan attempt SUCCESS per payment (batch, bukan N+1).
    const groups = await this.prisma.danaRefundAttempt.groupBy({
      by: ['paymentTransactionId'],
      where: { status: 'SUCCESS' },
      _sum: { amountSen: true },
      _count: { _all: true },
    });

    let paymentsChecked = 0;
    let overRefundGaps = 0;
    let underRecorded = 0;

    const BATCH = 200;
    for (let i = 0; i < groups.length; i += BATCH) {
      const batch = groups.slice(i, i + BATCH);
      const payments = await this.prisma.paymentTransaction.findMany({
        where: { id: { in: batch.map(g => g.paymentTransactionId) } },
        select: {
          id: true,
          orderId: true,
          grossAmount: true,
          refundedAmount: true,
          danaPartnerReferenceNo: true,
          status: true,
        },
      });
      const byId = new Map(payments.map(p => [p.id, p]));

      for (const g of batch) {
        const payment = byId.get(g.paymentTransactionId);
        if (!payment) continue;
        paymentsChecked++;
        const attempted = g._sum.amountSen ?? BigInt(0);
        const recorded = payment.refundedAmount;
        const gap = attempted - recorded; // >0: uang keluar tak tercatat

        if (gap > BigInt(0)) {
          overRefundGaps++;
          this.logger.error(
            `OVER_REFUND_GAP: payment=${payment.id} order=${payment.orderId} ` +
              `attempted=${toIdr(attempted)} recorded=${toIdr(recorded)} gap=${toIdr(gap)} ` +
              `(partnerRef=${payment.danaPartnerReferenceNo ?? '-'})`,
          );
          await alertAdminsOnMoneyAnomaly({
            prisma: this.prisma,
            redis: this.redis,
            logger: this.logger,
            title: `OVER_REFUND_BLOCKED terdeteksi: payment ${payment.id}`,
            body:
              `Tanda tangan SEC-103: total refund DANA tereksekusi (${toIdr(attempted)}) ` +
              `melebihi yang tercatat di paymentTransaction (${toIdr(recorded)}); ` +
              `selisih ${toIdr(gap)} SUDAH keluar dari merchant DANA tanpa pencatatan DB. ` +
              `gross=${toIdr(payment.grossAmount)} partnerRef=${payment.danaPartnerReferenceNo ?? '-'}. ` +
              `BUTUH rekonsiliasi manual: cocokkan riwayat refund di dashboard DANA, ` +
              `lalu koreksi refundedAmount via jalur admin yang diaudit.`,
            targetType: 'PaymentTransaction',
            targetId: payment.id,
            redisAlertKey: 'dana_over_refund_gap',
            dedupKey: `refund_gap_alerted:${payment.id}`,
            dedupTtlSeconds: 7 * 86400,
          });
        } else if (gap < BigInt(0)) {
          underRecorded++;
          this.logger.warn(
            `REFUND_UNDER_RECORDED: payment=${payment.id} attempted=${toIdr(attempted)} ` +
              `recorded=${toIdr(recorded)} — refundedAmount tercatat tanpa attempt SUCCESS yang cocok`,
          );
          await alertAdminsOnMoneyAnomaly({
            prisma: this.prisma,
            redis: this.redis,
            logger: this.logger,
            title: `Refund tak tercatat di attempt: payment ${payment.id}`,
            body:
              `paymentTransaction.refundedAmount (${toIdr(recorded)}) melebihi total ` +
              `danaRefundAttempt SUCCESS (${toIdr(attempted)}). Kemungkinan refund via ` +
              `jalur non-durable (pra-SYS-B-103) atau koreksi manual. Verifikasi bahwa ` +
              `setiap rupiah yang keluar tercatat di dana_refund_attempts.`,
            targetType: 'PaymentTransaction',
            targetId: payment.id,
            redisAlertKey: 'dana_refund_under_recorded',
            dedupKey: `refund_underrecorded_alerted:${payment.id}`,
            dedupTtlSeconds: 7 * 86400,
          });
        }
      }
    }

    return { paymentsChecked, overRefundGaps, underRecorded };
  }
}
