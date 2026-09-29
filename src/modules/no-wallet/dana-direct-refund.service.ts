import { Injectable, Logger } from '@nestjs/common';
import { PaymentProvider, PaymentStatus } from '@prisma/client';
import { randomBytes } from 'node:crypto';
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
    const partnerRefundNo = `RFD-${randomBytes(6).toString('hex').toUpperCase()}`;
    let attempt: { id: string; amountSen: bigint };
    try {
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
      const claimed = await this.prisma.danaRefundAttempt.updateMany({
        where: { idempotencyKey, status: { in: ['PENDING', 'FAILED'] } },
        data: {
          partnerRefundNo,
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
      const newRefunded = alreadyRefunded + amountSen;
      const fullyRefunded = newRefunded >= payment.grossAmount;
      await this.prisma.paymentTransaction.update({
        where: { id: payment.id },
        data: {
          refundedAmount: newRefunded,
          refundRequestedAt: new Date(),
          refundReference: partnerRefundNo,
          refundReason: reason.slice(0, 500),
          ...(fullyRefunded
            ? { status: PaymentStatus.REFUNDED, danaReferenceNo: result.referenceNo || undefined }
            : {}),
        },
      });
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
