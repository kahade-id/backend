import {
  ForbiddenException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PaymentPurpose, PaymentStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { WalletService } from '../wallet/wallet.service';
import { OrderQrisPaymentService } from '../payment/order-qris-payment.service';
import { DanaPaymentService } from '../payment/dana/dana-payment.service';
import {
  DANA_SANDBOX_WEBHOOK_PUBLIC_KEY,
  verifyDanaWebhookSignature,
} from '../payment/dana/dana-snap.util';
import {
  DANA_TX_STATUS_SUCCESS,
  DanaFinishNotify,
} from '../payment/dana/dana.types';
import { parseDanaAmount } from '../payment/dana/dana-payment.service';

export interface DanaWebhookOutcome {
  responseCode: string;
  responseMessage: string;
}

/**
 * DANA menandatangani finish-notify terhadap PATH CALLBACK URL MILIK MERCHANT
 * (path persis dari URL notifikasi yang DANA POST — bukan path API DANA).
 * Terbukti empiris 2026-09-29: notify yang dikirim DANA ke
 * https://webhook.site/<uuid> terverifikasi dengan path `/<uuid>` memakai
 * public key resmi DANA; semua path lain (termasuk `/v1.0/debit/notify`)
 * gagal. Untuk server kita DANA POST ke /v1/webhooks/dana/payment, sehingga
 * verifikasi memakai req.path persis seperti diterima (diteruskan controller).
 *
 * CATATAN INSIDEN 2026-09-29: commit 140b981 sempat mengganti path ini menjadi
 * `/v1.0/debit/notify` (teori yang salah) — notify asli tetap 403. Root cause
 * sebenarnya adalah req.rawBody yang selalu undefined (lihat stashRawBody di
 * main.ts), bukan path.
 */

/** Ack yang wajib dikembalikan ke DANA agar skenario notify terverifikasi. */
export const DANA_NOTIFY_ACK: DanaWebhookOutcome = {
  responseCode: '2005600',
  responseMessage: 'Successful',
};

/**
 * Settlement webhook DANA finish-notify.
 *
 * URL didaftarkan di DANA dashboard (tipe NOTIFICATION):
 *   https://api.kahade.id/v1/webhooks/dana/payment
 *
 * Alur keamanan (fail-closed):
 *  1. Verifikasi signature RSA-SHA256 DANA atas raw body
 *     (X-SIGNATURE / X-TIMESTAMP). Gagal → 403, TIDAK diproses.
 *  2. Durable inbox `webhookLog` (`source='DANA'`, `eventKey` unik per
 *     callback) — idempoten terhadap retry/duplikat DANA.
 *  3. Lookup PaymentTransaction via `danaPartnerReferenceNo`
 *     (= originalPartnerReferenceNo yang kita kirim saat create order).
 *     Tidak ditemukan → kemungkinan notify uji mandatory portal DANA →
 *     catat + balas ok TANPA settlement finansial.
 *  4. Verify-via-API: `danaPaymentService.getPaymentDetail()` harus
 *     SUCCESS dan nominal cocok — selain itu JANGAN kredit (fail-closed).
 *  5. Settlement memakai SATU-SATUNYA jalur yang sama dengan provider
 *     lain (tidak ada logika finansial baru):
 *       TOPUP        → walletService.handleTopupSuccess
 *       ORDER_ESCROW → orderQrisPaymentService.handleSettlement
 *
 * Selalu balas 200 untuk outcome bisnis agar DANA tidak retry tanpa henti;
 * 4xx/5xx hanya untuk signature invalid atau kegagalan infrastruktur.
 */
@Injectable()
export class DanaWebhookSettlementService {
  private readonly logger = new Logger(DanaWebhookSettlementService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly danaPaymentService: DanaPaymentService,
    private readonly walletService: WalletService,
    private readonly orderQrisPaymentService: OrderQrisPaymentService,
  ) {}

  private webhookPublicKey(): string {
    const fromEnv = this.config.get<string>('dana.publicKey') ?? '';
    if (fromEnv.trim()) return fromEnv;
    // Sandbox: kunci publik bawaan SDK resmi DANA.
    return DANA_SANDBOX_WEBHOOK_PUBLIC_KEY;
  }

  /** Parse payload FinishNotify → null bila field kunci hilang. */
  parseFinishNotify(body: Record<string, unknown>): DanaFinishNotify | null {
    const originalPartnerReferenceNo = String(body?.originalPartnerReferenceNo ?? '').trim();
    const latestTransactionStatus = String(body?.latestTransactionStatus ?? '').trim();
    if (!originalPartnerReferenceNo || !latestTransactionStatus) return null;
    const amountObj = (body?.amount ?? {}) as Record<string, unknown>;
    const paymentInfo = ((body?.additionalInfo ?? {}) as Record<string, unknown>)
      .paymentInfo as Record<string, unknown> | undefined;
    return {
      originalPartnerReferenceNo,
      originalReferenceNo: String(body?.originalReferenceNo ?? ''),
      originalExternalId: String(body?.originalExternalId ?? ''),
      merchantId: String(body?.merchantId ?? ''),
      latestTransactionStatus,
      transactionStatusDesc: String(body?.transactionStatusDesc ?? ''),
      amountIdr: parseDanaAmount(amountObj?.value),
      paidAt:
        (paymentInfo?.paidTime as string | undefined) ??
        (body?.finishedTime as string | undefined) ??
        null,
      externalStoreId: body?.externalStoreId ? String(body.externalStoreId) : undefined,
    };
  }

  async handleFinishNotify(
    rawBody: string,
    headers: Record<string, string | string[] | undefined>,
    // path = req.path dari controller, yaitu path callback URL merchant
    // (/v1/webhooks/dana/payment) — DANA menandatangani terhadap path ini.
    path: string,
  ): Promise<DanaWebhookOutcome> {
    const signature = String(headers['x-signature'] ?? '');
    const timestamp = String(headers['x-timestamp'] ?? '');
    const ok = verifyDanaWebhookSignature({
      method: 'POST',
      path,
      rawBody,
      timestamp,
      signature,
      publicKeyPem: this.webhookPublicKey(),
    });
    if (!ok) {
      this.logger.warn('DANA webhook: signature tidak valid — ditolak');
      throw new ForbiddenException({
        code: 'WEBHOOK_SIGNATURE_INVALID',
        message: 'Invalid DANA webhook signature',
      });
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(rawBody);
    } catch {
      this.logger.warn('DANA webhook: body bukan JSON valid');
      return DANA_NOTIFY_ACK;
    }
    const notify = this.parseFinishNotify(parsed as Record<string, unknown>);
    if (!notify) {
      this.logger.warn('DANA webhook: field kunci hilang — diabaikan');
      return DANA_NOTIFY_ACK;
    }

    const eventKey =
      `DANA:${notify.originalReferenceNo || notify.originalPartnerReferenceNo}:` +
      `${notify.latestTransactionStatus}`;
    const webhookLog = await this.prisma.webhookLog.upsert({
      where: { eventKey },
      create: {
        source: 'DANA',
        event: `finish_notify:${notify.latestTransactionStatus}`,
        payload: parsed as Prisma.InputJsonValue,
        headers: { 'x-timestamp': timestamp } as Prisma.InputJsonValue,
        transactionId: notify.originalReferenceNo || notify.originalPartnerReferenceNo,
        eventKey,
        isProcessed: false,
        lastAttemptAt: new Date(),
      },
      update: { lastAttemptAt: new Date() },
    });
    if (webhookLog.isProcessed) {
      this.logger.warn(`DANA webhook duplikat — sudah diproses: ${eventKey}`);
      return DANA_NOTIFY_ACK;
    }

    try {
      await this.settle(notify);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // Gagal verifikasi / API (transient maupun final-non-sukses):
      // tandai processed agar tidak retry tanpa henti untuk status final,
      // tapi JANGAN pernah kredit.
      this.logger.error(`DANA webhook settlement gagal (${eventKey}): ${msg}`);
      if (e instanceof ServiceUnavailableException) throw e;
    }

    await this.prisma.webhookLog.update({
      where: { id: webhookLog.id },
      data: { isProcessed: true, processedAt: new Date(), errorMessage: null },
    });
    return DANA_NOTIFY_ACK;
  }

  private async settle(notify: DanaFinishNotify): Promise<void> {
    const pt = await this.prisma.paymentTransaction.findUnique({
      where: { danaPartnerReferenceNo: notify.originalPartnerReferenceNo },
    });
    if (!pt) {
      // Notify uji mandatory portal DANA / order tak dikenal — catat saja.
      this.logger.log(
        `DANA webhook: partnerReferenceNo tak dikenal (${notify.originalPartnerReferenceNo}) — tanpa settlement`,
      );
      return;
    }
    if (pt.status === PaymentStatus.SUCCESS) {
      this.logger.log(`DANA webhook: paymentTransaction ${pt.id} sudah SUCCESS — idempoten skip`);
      return;
    }

    // Hanya status sukses DANA yang boleh lanjut ke settlement finansial.
    if (notify.latestTransactionStatus !== DANA_TX_STATUS_SUCCESS) {
      this.logger.log(
        `DANA webhook: status ${notify.latestTransactionStatus} bukan sukses — tanpa kredit`,
      );
      return;
    }

    // Verify-via-API + cek nominal (fail-closed).
    const detail = await this.danaPaymentService.getPaymentDetail(
      notify.originalPartnerReferenceNo,
    );
    if (detail.status !== 'SUCCESS') {
      this.logger.error(
        `DANA webhook: verify-via-API gagal (status=${detail.status}) — JANGAN kredit ${pt.id}`,
      );
      return;
    }
    const expectedIdr = Number(pt.grossAmount);
    if (detail.amountIdr === null || detail.amountIdr !== expectedIdr) {
      this.logger.error(
        `DANA webhook: nominal mismatch (dana=${detail.amountIdr}, expected=${expectedIdr}) — JANGAN kredit ${pt.id}`,
      );
      return;
    }

    const grossAmount = String(expectedIdr);
    if (pt.purpose === PaymentPurpose.TOPUP) {
      await this.walletService.handleTopupSuccess(pt.midtransOrderId, grossAmount);
    } else if (pt.purpose === PaymentPurpose.ORDER_ESCROW) {
      await this.orderQrisPaymentService.handleSettlement(pt.midtransOrderId, grossAmount);
    } else {
      this.logger.log(`DANA webhook: purpose ${pt.purpose} belum didukung — tanpa settlement`);
      return;
    }

    await this.prisma.paymentTransaction.update({
      where: { id: pt.id },
      data: {
        status: PaymentStatus.SUCCESS,
        danaReferenceNo: notify.originalReferenceNo || undefined,
      },
    });
  }
}
