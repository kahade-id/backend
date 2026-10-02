import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { randomUUID } from 'crypto';
import { PaymentProvider, PaymentPurpose, PaymentStatus } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { RedisService } from '../../../redis/redis.service';
import { cronJitter } from '../../../common/utils/cron-jitter.util';
import { alertMoneyCronSkippedRedisDown, ensureRedisAvailable } from '../../../common/utils/redis-health.util';
import { toIdr } from '../../../common/utils/currency.util';
import { safeErrorMessage } from '../../../common/utils/background-reliability.util';
import { DanaPaymentService } from '../../payment/dana/dana-payment.service';
import { DanaDirectPaymentService } from '../../no-wallet/dana-direct-payment.service';
import { alertAdminsOnMoneyAnomaly } from '../common/money-alert.util';

/** Payment PENDING lebih tua dari ini mulai direkonsiliasi via API DANA. */
const STALE_PENDING_MS = 15 * 60 * 1000;
/** Payment PENDING tak terjelaskan lebih tua dari ini → alert. */
const UNEXPLAINED_PENDING_MS = 24 * 60 * 60 * 1000;

export type DanaPaymentReconcileOutcome =
  | 'SETTLED' // DANA lunas → settleEscrow berhasil
  | 'ALREADY_SETTLED' // payment sudah SUCCESS/REFUNDED
  | 'MARKED_EXPIRED' // DANA: EXPIRED → payment PENDING→EXPIRED
  | 'STILL_PENDING' // DANA masih pending/tak dikenal — coba lagi nanti
  | 'AMOUNT_MISMATCH' // nominal DANA ≠ grossAmount — fail-closed, alert
  | 'NEEDS_MANUAL_REFUND' // DANA lunas tapi order tak eligible — uang butuh refund manual
  | 'NOT_APPLICABLE' // payment tak ditemukan / sudah final non-PENDING
  | 'ERROR'; // query DANA gagal — coba lagi nanti

const TERMINAL_FOR_RETRY: DanaPaymentReconcileOutcome[] = [
  'SETTLED',
  'ALREADY_SETTLED',
  'MARKED_EXPIRED',
  'NOT_APPLICABLE',
];

/** Outcome yang berarti webhookLog DANA boleh ditandai processed oleh webhook-retry. */
export function isTerminalReconcileOutcome(o: DanaPaymentReconcileOutcome): boolean {
  return TERMINAL_FOR_RETRY.includes(o);
}

/**
 * SYS-B-305 (audit sistemik ronde 3): inbound payment DANA 100% bergantung
 * webhook adalah risiko nyata — notify finish yang hilang (network, DANA
 * berhenti retry, bug deterministik 5xx) membuat `paymentTransaction`
 * PENDING selamanya padahal uang sudah masuk ke merchant.
 *
 * Cron tiap 15 menit: payment DANA/ORDER_ESCROW/PENDING yang basi
 * (>15 mnt, beri kesempatan webhook tiba dulu) direkonsiliasi via
 * `DanaPaymentService.getPaymentDetail()` (query status resmi DANA):
 *  - DANA SUCCESS + nominal cocok → `settleEscrow()` (idempoten).
 *  - DANA SUCCESS + nominal TIDAK cocok → fail-closed: biarkan PENDING + alert.
 *  - DANA EXPIRED → payment PENDING→EXPIRED (fail-closed).
 *  - DANA masih PENDING/UNKNOWN → biarkan; >24 jam → alert.
 *  - DANA SUCCESS tapi order tak eligible (dibatalkan dsb):
 *    `settleEscrow` menandai payment SUCCESS lalu melempar — uang butuh
 *    refund manual ke pembayar → alert URGENT + audit. TIDAK auto-refund
 *    dari cron (keputusan uang butuh oversight admin).
 *
 * Metode `reconcileByPartnerReferenceNo()` juga dipakai
 * `webhook-retry.service.ts` untuk me-replay baris webhookLog DANA
 * (`finish_notify:*`) yang gagal — tanpa itu, notify DANA tak pernah
 * di-retry sistem (SYS-B-305a).
 */
@Injectable()
export class DanaPaymentReconcileService {
  private readonly logger = new Logger(DanaPaymentReconcileService.name);

  constructor(
    private prisma: PrismaService,
    private redis: RedisService,
    private danaPayment: DanaPaymentService,
    private danaDirectPayment: DanaDirectPaymentService,
  ) {}

  // Tiap 15 menit — pemulihan cepat untuk payment yang webhook-nya hilang.
  @Cron('*/15 * * * *', { name: 'dana-payment-reconcile', timeZone: 'Asia/Jakarta' })
  async reconcileStalePendingPayments(): Promise<void> {
    await cronJitter(15_000);
    if (!(await ensureRedisAvailable(this.redis, 'dana-payment-reconcile', {
        onRedisDown: () => alertMoneyCronSkippedRedisDown('dana-payment-reconcile'),
      }))) return;

    const lockKey = 'cron_lock:dana_payment_reconcile';
    const lockToken = randomUUID();
    if (!(await this.redis.setNx(lockKey, lockToken, 600))) return;

    const startedAt = Date.now();
    const stats: Record<string, number> = {};
    try {
      const staleBefore = new Date(Date.now() - STALE_PENDING_MS);
      const pendings = await this.prisma.paymentTransaction.findMany({
        where: {
          provider: PaymentProvider.DANA,
          purpose: PaymentPurpose.ORDER_ESCROW,
          status: PaymentStatus.PENDING,
          danaPartnerReferenceNo: { not: null },
          updatedAt: { lt: staleBefore },
        },
        select: { id: true, danaPartnerReferenceNo: true, createdAt: true },
        orderBy: { updatedAt: 'asc' },
        take: 50,
      });

      for (const p of pendings) {
        const outcome = await this.reconcileByPartnerReferenceNo(p.danaPartnerReferenceNo as string);
        stats[outcome] = (stats[outcome] ?? 0) + 1;
      }

      const total = pendings.length;
      if (total > 0) {
        this.logger.log(`dana-payment-reconcile: checked=${total} ${JSON.stringify(stats)}`);
      }
      await this.redis
        .setex(
          'cron_heartbeat:dana_payment_reconcile',
          86400,
          JSON.stringify({ ranAt: new Date().toISOString(), durationMs: Date.now() - startedAt, checked: total, stats }),
        )
        .catch((err: unknown) => this.logger.warn(`silent-catch: ${safeErrorMessage(err)}`));
    } catch (error) {
      this.logger.error(`dana-payment-reconcile gagal: ${safeErrorMessage(error)}`);
    } finally {
      await this.redis.releaseLock(lockKey, lockToken).catch(() => undefined);
    }
  }

  /**
   * Rekonsiliasi satu payment via partnerReferenceNo DANA. Idempoten dan
   * fail-closed — aman dipanggil dari cron maupun webhook-retry.
   */
  async reconcileByPartnerReferenceNo(partnerRefNo: string): Promise<DanaPaymentReconcileOutcome> {
    const payment = await this.prisma.paymentTransaction.findUnique({
      where: { danaPartnerReferenceNo: partnerRefNo },
      select: {
        id: true,
        orderId: true,
        status: true,
        grossAmount: true,
        createdAt: true,
        updatedAt: true,
      },
    });
    if (!payment) return 'NOT_APPLICABLE';
    if (payment.status === PaymentStatus.SUCCESS || payment.status === PaymentStatus.REFUNDED) {
      return 'ALREADY_SETTLED';
    }
    if (payment.status !== PaymentStatus.PENDING) {
      // FAILED/CANCELLED/EXPIRED — final, tak ada yang perlu di-retry.
      return 'NOT_APPLICABLE';
    }

    let detail: { status: string; amountIdr: number | null };
    try {
      detail = await this.danaPayment.getPaymentDetail(partnerRefNo);
    } catch (e) {
      this.logger.warn(`getPaymentDetail gagal untuk ${partnerRefNo}: ${safeErrorMessage(e)}`);
      return 'ERROR';
    }

    if (detail.status === 'SUCCESS') {
      // Verifikasi nominal SEBELUM settlement finansial (fail-closed —
      // pola sama dengan webhook settlement).
      const expectedIdr = Math.round(Number(payment.grossAmount) / 100);
      if (detail.amountIdr !== null && detail.amountIdr !== expectedIdr) {
        this.logger.error(
          `AMOUNT_MISMATCH reconcile: payment=${payment.id} dana=${detail.amountIdr} expected=${expectedIdr} — dibiarkan PENDING`,
        );
        await alertAdminsOnMoneyAnomaly({
          prisma: this.prisma,
          redis: this.redis,
          logger: this.logger,
          title: `Nominal DANA tak cocok: payment ${payment.id}`,
          body:
            `DANA melaporkan payment ${partnerRefNo} SUCCESS dengan nominal ${detail.amountIdr}, ` +
            `tetapi grossAmount tercatat ${expectedIdr} (IDR). Settlement DITAHAN (fail-closed) — ` +
            `verifikasi manual di dashboard DANA sebelum memutuskan.`,
          targetType: 'PaymentTransaction',
          targetId: payment.id,
          redisAlertKey: 'dana_payment_amount_mismatch',
          dedupKey: `dana_amount_mismatch:${payment.id}`,
          dedupTtlSeconds: 86400,
        });
        return 'AMOUNT_MISMATCH';
      }
      try {
        const res = await this.danaDirectPayment.settleEscrow(payment.id);
        if (res === 'SETTLED') {
          this.logger.log(`dana-payment-reconcile: payment ${payment.id} → SETTLED via API (webhook terlewat)`);
          return 'SETTLED';
        }
        return 'ALREADY_SETTLED';
      } catch (e) {
        const msg = safeErrorMessage(e);
        // settleEscrow menandai payment SUCCESS lalu melempar untuk kasus
        // order tak eligible / order hilang — uang SUDAH masuk merchant dan
        // WAJIB di-refund ke pembayar (SEC-201). Cron tidak auto-refund;
        // serahkan ke admin dengan alert URGENT + jejak audit.
        this.logger.error(`dana-payment-reconcile NEEDS_MANUAL_REFUND payment=${payment.id}: ${msg}`);
        await alertAdminsOnMoneyAnomaly({
          prisma: this.prisma,
          redis: this.redis,
          logger: this.logger,
          title: `URGENT: payment DANA lunas tapi order tak eligible — ${payment.id}`,
          body:
            `DANA melaporkan ${partnerRefNo} SUCCESS (${toIdr(payment.grossAmount)}), tetapi settlement ` +
            `ditolak: ${msg}. Dana sudah masuk ke merchant DANA dan WAJIB di-refund manual ke pembayar ` +
            `(jangan biarkan mengendap). Order: ${payment.orderId ?? '-'}.`,
          targetType: 'PaymentTransaction',
          targetId: payment.id,
          redisAlertKey: 'dana_payment_needs_manual_refund',
          dedupKey: `dana_manual_refund:${payment.id}`,
          dedupTtlSeconds: 7 * 86400,
        });
        return 'NEEDS_MANUAL_REFUND';
      }
    }

    if (detail.status === 'EXPIRED') {
      // Transisi fail-closed: hanya PENDING → EXPIRED (pola MFE-009 webhook).
      const marked = await this.prisma.paymentTransaction.updateMany({
        where: { id: payment.id, status: PaymentStatus.PENDING },
        data: { status: PaymentStatus.EXPIRED, failedAt: new Date() },
      });
      if (marked.count > 0) {
        this.logger.log(`dana-payment-reconcile: payment ${payment.id} → EXPIRED (DANA)`);
      }
      return 'MARKED_EXPIRED';
    }

    // PENDING / UNKNOWN di sisi DANA — biarkan; alert bila terlalu lama
    // tanpa kejelasan (kemungkinan payment yatim).
    if (Date.now() - payment.createdAt.getTime() > UNEXPLAINED_PENDING_MS) {
      this.logger.warn(
        `UNEXPLAINED_PENDING: payment=${payment.id} ref=${partnerRefNo} PENDING >24 jam, status DANA=${detail.status}`,
      );
      await alertAdminsOnMoneyAnomaly({
        prisma: this.prisma,
        redis: this.redis,
        logger: this.logger,
        title: `Payment DANA PENDING >24 jam: ${payment.id}`,
        body:
          `Payment ${partnerRefNo} (${toIdr(payment.grossAmount)}) masih PENDING setelah 24 jam; ` +
          `status terakhir di DANA: ${detail.status}. Selidiki manual (dashboard DANA / hubungi buyer).`,
        targetType: 'PaymentTransaction',
        targetId: payment.id,
        redisAlertKey: 'dana_payment_unexplained_pending',
        dedupKey: `dana_unexplained_pending:${payment.id}`,
        dedupTtlSeconds: 86400,
      });
    }
    return 'STILL_PENDING';
  }
}
