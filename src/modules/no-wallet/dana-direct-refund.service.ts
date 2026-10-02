import { Injectable, Logger } from '@nestjs/common';
import { PaymentProvider, PaymentStatus } from '@prisma/client';
import { createHash } from 'node:crypto';
import { PrismaService } from '../../prisma/prisma.service';
import { DanaPaymentService } from '../payment/dana/dana-payment.service';

export interface DanaRefundAmountParams {
  /** DB id PaymentTransaction DANA yang akan di-refund. */
  paymentDbId: string;
  /**
   * Nominal refund dalam sen. null/undefined = penuh (sisa yang belum
   * di-refund). Parsial didukung DANA Refund API.
   */
  amountSen?: bigint | null;
  reason: string;
  /**
   * Kunci idempotency stabil dari caller (mis. "ORDER:<orderDbId>:FULL",
   * "DISPUTE:<disputeId>:BUYER", "RETURN:<returnId>"). Dua panggilan dengan
   * key sama → tepat satu refund.
   */
  idempotencyKey: string;
}

export type DanaRefundOutcome =
  | { refunded: true; already: boolean; amountSen: bigint }
  | { refunded: false; reason: 'NOT_ELIGIBLE' };

/**
 * partnerRefundNo DETERMINISTIK per idempotencyKey.
 *
 * DANA idempoten per (merchantId, partnerRefundNo): bila refundOrder timeout
 * SETELAH DANA menerima refund (hasil ambigu), retry HARUS memakai refundNo
 * yang sama agar DANA mengembalikan hasil refund asli — refundNo baru/acak =
 * refund KEDUA (double refund, uang sungguhan keluar 2x). Format 16 char,
 * aman dari batas 25 char partnerReferenceNo DANA.
 */
export function deriveDanaRefundNo(idempotencyKey: string): string {
  return `RFD-${createHash('sha256').update(idempotencyKey, 'utf8').digest('hex').slice(0, 12).toUpperCase()}`;
}

/**
 * Misi tanpa-wallet (BI-safe): refund DANA ke metode bayar asal.
 *
 * Refund kembali ke METODE BAYAR ASAL via DANA Refund API memakai
 * originalPartnerReferenceNo (= danaPartnerReferenceNo yang tersimpan di
 * PaymentTransaction) — BUKAN ke wallet internal.
 *
 * Berlaku untuk: cancel/auto-cancel order, dispute (buyer menang / split),
 * retur, refund subscription, refund milestone.
 *
 * Idempotency: satu baris DanaRefundAttempt per idempotencyKey (klaim via
 * insert — pemenang mengeksekusi, yang kalah membaca hasil). DANA sendiri
 * idempoten per (merchantId, partnerRefundNo).
 * Fail-closed: refund hanya untuk payment DANA (danaPayKind terisi) yang
 * SUCCESS dan belum lunas di-refund; selain itu no-op dengan alasan jelas.
 */
@Injectable()
export class DanaDirectRefundService {
  private readonly logger = new Logger(DanaDirectRefundService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly danaPayment: DanaPaymentService,
  ) {}

  /**
   * Refund penuh payment DANA-direct (kompatibilitas dengan caller lama).
   * Mengembalikan true bila refund dieksekusi (atau sudah pernah),
   * false bila tidak ada payment yang eligible (no-op — bukan error).
   */
  async refundPayment(paymentDbId: string, reason: string): Promise<boolean> {
    const result = await this.refundAmount({
      paymentDbId,
      amountSen: null,
      reason,
      idempotencyKey: `LEGACY-FULL:${paymentDbId}`,
    });
    return result.refunded;
  }

  /**
   * Refund penuh escrow DANA-direct untuk sebuah order (cari payment
   * SUCCESS terbaru). No-op (false) bila tidak ada payment DANA-direct.
   */
  async refundOrderEscrow(orderDbId: string, reason: string): Promise<boolean> {
    const payment = await this.prisma.paymentTransaction.findFirst({
      where: {
        orderId: orderDbId,
        provider: PaymentProvider.DANA,
        status: PaymentStatus.SUCCESS,
      },
      orderBy: { settledAt: 'desc' },
      select: { id: true },
    });
    if (!payment) return false;
    const result = await this.refundAmount({
      paymentDbId: payment.id,
      amountSen: null,
      reason,
      idempotencyKey: `ORDER:${orderDbId}:FULL`,
    });
    return result.refunded;
  }

  /**
   * Primitif refund kanonis: penuh atau parsial, idempoten via
   * idempotencyKey. Aman dipanggil ulang / konkuren.
   */
  async refundAmount(params: DanaRefundAmountParams): Promise<DanaRefundOutcome> {
    const { paymentDbId, reason, idempotencyKey } = params;

    const payment = await this.prisma.paymentTransaction.findUnique({
      where: { id: paymentDbId },
    });
    if (
      !payment ||
      payment.provider !== PaymentProvider.DANA ||
      !payment.danaPayKind ||
      !payment.danaPartnerReferenceNo
    ) {
      this.logger.warn(
        `DANA refund skip: payment ${paymentDbId} bukan payment DANA-direct yang eligible`,
      );
      return { refunded: false, reason: 'NOT_ELIGIBLE' };
    }
    if (payment.status === PaymentStatus.REFUNDED) {
      return { refunded: true, already: true, amountSen: payment.refundedAmount };
    }
    if (payment.status !== PaymentStatus.SUCCESS) {
      this.logger.warn(
        `DANA refund skip: payment ${paymentDbId} status=${payment.status} (bukan SUCCESS)`,
      );
      return { refunded: false, reason: 'NOT_ELIGIBLE' };
    }

    const alreadyRefunded = payment.refundedAmount ?? BigInt(0);
    const remaining = payment.grossAmount - alreadyRefunded;
    if (remaining <= BigInt(0)) {
      return { refunded: true, already: true, amountSen: alreadyRefunded };
    }
    const amountSen =
      params.amountSen == null || params.amountSen <= BigInt(0) || params.amountSen > remaining
        ? remaining
        : params.amountSen;
    if (amountSen <= BigInt(0)) {
      return { refunded: false, reason: 'NOT_ELIGIBLE' };
    }

    // Klaim idempotency: insert dulu — bila key sudah ada, hanya SATU pemenang
    // yang boleh mengeksekusi (klaim atomik PENDING/FAILED → EXECUTING via
    // updateMany). DANA sendiri idempoten per (merchantId, partnerRefundNo).
    //
    // P1 (2026-09-30): partnerRefundNo deterministik dari idempotencyKey
    // (deriveDanaRefundNo), BUKAN acak. Retry setelah timeout ambigu memakai
    // refundNo yang sama → DANA dedupe, bukan refund kedua.
    let partnerRefundNo: string;
    let attempt: { id: string; amountSen: bigint };
    try {
      partnerRefundNo = deriveDanaRefundNo(idempotencyKey);
      attempt = await this.prisma.danaRefundAttempt.create({
        data: {
          idempotencyKey,
          paymentTransactionId: payment.id,
          amountSen,
          partnerRefundNo,
          reason: reason.slice(0, 500),
          status: 'EXECUTING',
        },
        select: { id: true, amountSen: true },
      });
    } catch (e) {
      // Baris sudah ada — klaim dan PAKAI partnerRefundNo ASLI dari baris
      // itu (jangan timpa dengan yang baru): bila attempt pertama timeout
      // setelah DANA menerima refund, refundNo yang sama membuat DANA
      // mengembalikan hasil asli, bukan memproses refund kedua.
      const prior = await this.prisma.danaRefundAttempt.findUnique({
        where: { idempotencyKey },
        select: { partnerRefundNo: true },
      });
      const claimed = await this.prisma.danaRefundAttempt.updateMany({
        where: { idempotencyKey, status: { in: ['PENDING', 'FAILED'] } },
        data: {
          amountSen,
          status: 'EXECUTING',
          reason: reason.slice(0, 500),
        },
      });
      if (claimed.count !== 1) {
        // Pemenang lain sedang mengeksekusi / sudah sukses — baca hasilnya.
        const existing = await this.prisma.danaRefundAttempt.findUnique({
          where: { idempotencyKey },
          select: { status: true, amountSen: true },
        });
        if (existing?.status === 'SUCCESS') {
          return { refunded: true, already: true, amountSen: existing.amountSen };
        }
        // EXECUTING oleh pihak lain: fail-closed — caller retry nanti.
        throw new Error(
          `DANA refund ${idempotencyKey} sedang dieksekusi pihak lain — coba lagi nanti`,
        );
      }
      attempt = await this.prisma.danaRefundAttempt.findUniqueOrThrow({
        where: { idempotencyKey },
        select: { id: true, amountSen: true },
      });
      // Pakai refundNo asli baris ini; fallback deterministik bila baris lama
      // (pra-fix) tidak punya refundNo tersimpan.
      partnerRefundNo = prior?.partnerRefundNo || deriveDanaRefundNo(idempotencyKey);
    }

    try {
      const amountIdr = Math.round(Number(amountSen) / 100);
      if (amountIdr <= 0) {
        throw new Error(`Nominal refund tidak valid: ${amountSen} sen`);
      }
      const result = await this.danaPayment.refundOrder({
        partnerReferenceNo: payment.danaPartnerReferenceNo!,
        partnerRefundNo,
        amountIdr,
        reason: reason.slice(0, 200),
      });
      await this.prisma.danaRefundAttempt.update({
        where: { id: attempt.id },
        data: { status: 'SUCCESS', danaReferenceNo: result.referenceNo || undefined },
      });
      const fullyRefunded = alreadyRefunded + amountSen >= payment.grossAmount;
      // SEC-103: JANGAN overwrite refundedAmount dari snapshot basi — klaim
      // kondisional (refundedAmount masih = nilai yang kita baca). Dua refund
      // konkuren dengan key berbeda tidak bisa saling menimpa angka.
      const finalizePayment = (baseRefunded: bigint) =>
        this.prisma.paymentTransaction.updateMany({
          where: { id: payment.id, refundedAmount: baseRefunded },
          data: {
            refundedAmount: { increment: amountSen },
            refundRequestedAt: new Date(),
            refundReference: partnerRefundNo,
            refundReason: reason.slice(0, 500),
            ...(baseRefunded + amountSen >= payment.grossAmount
              ? { status: PaymentStatus.REFUNDED, danaReferenceNo: result.referenceNo || undefined }
              : {}),
          },
        });
      let finalized = await finalizePayment(alreadyRefunded);
      if (finalized.count === 0) {
        // Race: baris berubah di tengah jalan — baca ulang, hitung ulang
        // remaining (fail-closed). Refund DANA untuk attempt ini SUDAH jalan
        // (uang keluar), jadi pencatatan harus mengejar nilai fresh.
        const fresh = await this.prisma.paymentTransaction.findUnique({
          where: { id: payment.id },
          select: { refundedAmount: true, grossAmount: true },
        });
        const freshRefunded = fresh?.refundedAmount ?? BigInt(0);
        const freshRemaining = (fresh?.grossAmount ?? payment.grossAmount) - freshRefunded;
        if (freshRemaining < amountSen) {
          this.logger.error(
            `SEC-103 OVER_REFUND_BLOCKED: payment=${paymentDbId} amountSen=${amountSen} ` +
              `freshRemaining=${freshRemaining} — total refund konkuren melebihi gross; ` +
              `refund DANA ${partnerRefundNo} sudah dieksekusi, BUTUH rekonsiliasi manual`,
          );
          throw new Error(
            'OVER_REFUND_BLOCKED: refund konkuren melebihi sisa pembayaran — diblokir, butuh rekonsiliasi manual',
          );
        }
        finalized = await finalizePayment(freshRefunded);
        if (finalized.count === 0) {
          this.logger.error(
            `SEC-103 OVER_REFUND_BLOCKED: payment=${paymentDbId} — gagal mencatat refund ${partnerRefundNo} setelah baca ulang; BUTUH rekonsiliasi manual`,
          );
          throw new Error(
            'OVER_REFUND_BLOCKED: gagal mencatat refund setelah baca ulang — butuh rekonsiliasi manual',
          );
        }
      }
      this.logger.log(
        `DANA refund sukses: payment=${paymentDbId} refundNo=${partnerRefundNo} amountSen=${amountSen} full=${fullyRefunded}`,
      );
      return { refunded: true, already: false, amountSen };
    } catch (error) {
      await this.prisma.danaRefundAttempt
        .update({
          where: { id: attempt.id },
          data: { status: 'FAILED' },
        })
        .catch(releaseError =>
          this.logger.error(
            `Gagal menandai refund attempt FAILED ${attempt.id}: ${
              releaseError instanceof Error ? releaseError.message : String(releaseError)
            }`,
          ),
        );
      throw error;
    }
  }

  /**
   * M3: retry attempt refund DANA yang FAILED (durable). Klaim atomik
   * PENDING/FAILED → EXECUTING di refundAmount() menjamin tepat satu
   * eksekutor per idempotency key — aman dipanggil cron tiap jam.
   */
  async retryFailedRefunds(limit = 50): Promise<{ retried: number; succeeded: number }> {
    const failed = await this.prisma.danaRefundAttempt.findMany({
      where: { status: 'FAILED' },
      orderBy: { updatedAt: 'asc' },
      take: Math.max(1, limit),
      select: { idempotencyKey: true, paymentTransactionId: true, amountSen: true, reason: true },
    });
    let succeeded = 0;
    for (const a of failed) {
      try {
        const res = await this.refundAmount({
          paymentDbId: a.paymentTransactionId,
          amountSen: a.amountSen,
          reason: a.reason ?? 'Retry refund DANA (cron)',
          idempotencyKey: a.idempotencyKey,
        });
        if (res.refunded) succeeded++;
      } catch (e) {
        this.logger.warn(`Retry refund DANA gagal key=${a.idempotencyKey}: ${(e as Error).message}`);
      }
    }
    return { retried: failed.length, succeeded };
  }
}
