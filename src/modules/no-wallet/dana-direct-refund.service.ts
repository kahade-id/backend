import { Injectable, Logger } from '@nestjs/common';
import { PaymentProvider, PaymentPurpose, PaymentStatus } from '@prisma/client';
import { randomBytes } from 'node:crypto';
import { PrismaService } from '../../prisma/prisma.service';
import { DanaPaymentService } from '../payment/dana/dana-payment.service';

/**
 * Misi tanpa-wallet (BI-safe): refund escrow DANA-direct.
 *
 * Refund kembali ke METODE BAYAR ASAL via DANA Refund API memakai
 * originalPartnerReferenceNo (= danaPartnerReferenceNo yang tersimpan di
 * PaymentTransaction) — BUKAN ke wallet internal.
 *
 * Berlaku untuk: cancel sebelum kirim, auto-refund cron melewati batas
 * kirim 2 hari, dispute yang dimenangkan buyer.
 *
 * Idempotency: klaim refundRequestedAt (satu pemenang), partnerRefundNo
 * unik per upaya; DANA sendiri idempoten per (merchantId, partnerRefundNo).
 * Fail-closed: refund hanya untuk payment DANA-direct yang SUCCESS dan
 * belum REFUNDED; selain itu no-op / lempar agar caller menahan.
 */
@Injectable()
export class DanaDirectRefundService {
  private readonly logger = new Logger(DanaDirectRefundService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly danaPayment: DanaPaymentService,
  ) {}

  /**
   * Refund penuh payment DANA-direct. Mengembalikan true bila refund
   * dieksekusi (atau sudah pernah), false bila tidak ada payment yang
   * eligible (no-op — bukan error).
   */
  async refundPayment(paymentDbId: string, reason: string): Promise<boolean> {
    const payment = await this.prisma.paymentTransaction.findUnique({
      where: { id: paymentDbId },
    });
    if (
      !payment ||
      payment.provider !== PaymentProvider.DANA ||
      payment.purpose !== PaymentPurpose.ORDER_ESCROW ||
      !payment.danaPayKind ||
      !payment.danaPartnerReferenceNo
    ) {
      return false;
    }
    if (payment.status === PaymentStatus.REFUNDED) return true;
    if (payment.status !== PaymentStatus.SUCCESS) {
      this.logger.warn(
        `DANA direct refund skip: payment ${paymentDbId} status=${payment.status} (bukan SUCCESS)`,
      );
      return false;
    }

    const partnerRefundNo = `RFD-${payment.id}-${randomBytes(4).toString('hex').toUpperCase()}`;
    const claimTime = new Date();
    const claimed = await this.prisma.paymentTransaction.updateMany({
      where: { id: payment.id, refundRequestedAt: null, status: PaymentStatus.SUCCESS },
      data: {
        refundRequestedAt: claimTime,
        refundReference: partnerRefundNo,
        refundReason: reason.slice(0, 500),
      },
    });
    if (claimed.count !== 1) {
      // Race: pemenang lain sudah klaim / status berubah — baca ulang.
      const fresh = await this.prisma.paymentTransaction.findUnique({
        where: { id: payment.id },
        select: { status: true },
      });
      return fresh?.status === PaymentStatus.REFUNDED;
    }

    try {
      const amountIdr = Math.round(Number(payment.grossAmount) / 100);
      const result = await this.danaPayment.refundOrder({
        partnerReferenceNo: payment.danaPartnerReferenceNo,
        partnerRefundNo,
        amountIdr,
        reason: reason.slice(0, 200),
      });
      await this.prisma.paymentTransaction.update({
        where: { id: payment.id },
        data: {
          status: PaymentStatus.REFUNDED,
          refundedAmount: payment.grossAmount,
          danaReferenceNo: result.referenceNo || undefined,
        },
      });
      this.logger.log(
        `DANA direct refund sukses: payment=${paymentDbId} refundNo=${partnerRefundNo} amountIdr=${amountIdr}`,
      );
      return true;
    } catch (error) {
      // Lepas klaim agar retry terjadwal bisa mencoba lagi dengan
      // partnerRefundNo yang sama (idempoten di sisi DANA).
      await this.prisma.paymentTransaction
        .updateMany({
          where: { id: payment.id, refundRequestedAt: claimTime },
          data: { refundRequestedAt: null, refundReference: null, refundReason: null },
        })
        .catch(releaseError =>
          this.logger.error(
            `Gagal melepas klaim refund ${paymentDbId}: ${
              releaseError instanceof Error ? releaseError.message : String(releaseError)
            }`,
          ),
        );
      throw error;
    }
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
        purpose: PaymentPurpose.ORDER_ESCROW,
        status: PaymentStatus.SUCCESS,
      },
      orderBy: { settledAt: 'desc' },
      select: { id: true },
    });
    if (!payment) return false;
    return this.refundPayment(payment.id, reason);
  }
}
