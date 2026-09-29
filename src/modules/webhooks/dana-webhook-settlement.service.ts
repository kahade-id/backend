import {
  ForbiddenException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PaymentProvider, PaymentPurpose, PaymentStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { WalletService } from '../wallet/wallet.service';
import { OrderQrisPaymentService } from '../payment/order-qris-payment.service';
import { DanaPaymentService } from '../payment/dana/dana-payment.service';
import { DanaDirectPaymentService } from '../no-wallet/dana-direct-payment.service';
import { DanaDirectRefundService } from '../no-wallet/dana-direct-refund.service';
import { WalletModeService } from '../wallet-mode/wallet-mode.service';
import { SubscriptionsService } from '../subscriptions/subscriptions.service';
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
 *       SUBSCRIPTION (DANA-direct) → subscriptionsService.activateDanaSubscription
 *
 * Selalu balas 200 untuk outcome bisnis agar DANA tidak retry tanpa henti;
 * 4xx/5xx hanya untuk signature invalid atau kegagalan infrastruktur.
 */
@Injectable()
export class DanaWebhookSettlementService {
  private readonly logger = new Logger(DanaWebhookSettlementService.name);

  /**
   * TEST HOOK sandbox-only untuk skenario portal "Internal Server Error
   * Response from Partner" (5005601). SYARAT KERAS:
   * - Hanya aktif bila `dana.env === 'sandbox'` (DANA_ENV). Di production
   *   hook MATI TOTAL walau env flag ter-set.
   * - Signature DIVERIFIKASI DULU — invalid tetap 403, hook tidak fire.
   * - Trigger eksplisit & terkontrol: env DANA_WEBHOOK_TEST_5005601_ONCE='true'.
   *   Kosong/false = hook mati total.
   * - SATU KALI: setelah fire, flag in-memory langsung nonaktif. Retry DANA
   *   berikutnya diproses normal (2005600 / deteksi duplikat).
   * - Fire SEBELUM webhookLog.upsert: tanpa DB write, idempotency & fail-closed
   *   tidak tersentuh.
   */
  private test5005601Fired = false;

  private maybeFireTestHook5005601(
    latestTransactionStatus: string,
  ): DanaWebhookOutcome | null {
    if (this.test5005601Fired) return null;
    if (this.config.get<string>('dana.env') !== 'sandbox') return null;
    if (this.config.get<string>('DANA_WEBHOOK_TEST_5005601_ONCE') !== 'true')
      return null;
    // Hanya fire untuk notif sukses (00) — skenario "Internal Server Error"
    // portal mengirim notif 00 dan mengharapkan respons 5005601. Notif 05
    // (expired) harus tetap dibalas 2005600 untuk skenario expired.
    if (latestTransactionStatus !== '00') return null;
    this.test5005601Fired = true;
    this.logger.warn(
      'DANA webhook TEST HOOK 5005601 FIRED (sekali) — hook otomatis nonaktif',
    );
    return { responseCode: '5005601', responseMessage: 'Internal Server Error' };
  }

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly danaPaymentService: DanaPaymentService,
    private readonly walletService: WalletService,
    private readonly orderQrisPaymentService: OrderQrisPaymentService,
    private readonly danaDirectPaymentService: DanaDirectPaymentService,
    private readonly danaDirectRefundService: DanaDirectRefundService,
    private readonly walletMode: WalletModeService,
    private readonly subscriptionsService: SubscriptionsService,
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

    // Test hook 5005601 (sandbox-only, satu kali, setelah signature valid).
    // Hanya untuk notif status 00 — notif 05 tetap dibalas normal 2005600.
    const testHook = this.maybeFireTestHook5005601(
      notify.latestTransactionStatus,
    );
    if (testHook) return testHook;

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
    // P0 (misi tanpa-wallet): grossAmount tersimpan dalam SEN, sedangkan
    // DANA melaporkan rupiah. Bandingkan dalam rupiah (fail-closed bila
    // mismatch) — sebelumnya bug unit membuat SEMUA webhook asli ditolak.
    const expectedIdr = Math.round(Number(pt.grossAmount) / 100);
    if (detail.amountIdr === null || detail.amountIdr !== expectedIdr) {
      this.logger.error(
        `DANA webhook: nominal mismatch (dana=${detail.amountIdr}, expected=${expectedIdr}) — JANGAN kredit ${pt.id}`,
      );
      return;
    }

    const grossAmount = String(expectedIdr);
    // Misi tanpa-wallet (BI-safe): escrow DANA-direct — settlement TANPA
    // menyentuh wallet internal. Uang: buyer → DANA → escrow (pot =
    // PaymentTransaction). Signature, replay protection, idempotency, dan
    // verify-via-API + pencocokan nominal di atas tetap berlaku (fail-closed).
    if (
      pt.provider === PaymentProvider.DANA &&
      pt.purpose === PaymentPurpose.ORDER_ESCROW &&
      pt.danaPayKind
    ) {
      try {
        await this.danaDirectPaymentService.settleEscrow(pt.id);
      } catch (e) {
        const code =
          e instanceof ServiceUnavailableException
            ? ((e.getResponse() as { code?: string } | undefined)?.code ?? '')
            : '';
        if (
          code === 'DANA_DIRECT_ORDER_INELIGIBLE' ||
          code === 'DANA_DIRECT_ORDER_MISSING'
        ) {
          // Fail-closed: order tak eligible / hilang — uang TIDAK BOLEH
          // nyangkut dan TIDAK BOLEH masuk wallet: kembalikan ke pembayar
          // via DANA Refund API (ke metode bayar asal).
          this.logger.warn(
            `DANA webhook: order tak eligible untuk ${pt.id} — refund ke sumber`,
          );
          await this.danaDirectRefundService.refundPayment(
            pt.id,
            'Order tidak eligible menerima escrow — dana dikembalikan',
          );
          return;
        }
        throw e;
      }
    } else if (pt.purpose === PaymentPurpose.TOPUP) {
      // Mode BI-safe: top-up DANA yang masih in-flight TIDAK BOLEH dikredit
      // ke wallet. Fail-closed: kembalikan ke metode bayar asal via DANA
      // Refund API (uang kembali ke pembayar, tidak pernah masuk wallet).
      if (!this.walletMode.isWalletEnabled()) {
        await this.refundTopupToSource(pt);
      } else {
        await this.walletService.handleTopupSuccess(pt.midtransOrderId, grossAmount);
      }
    } else if (pt.purpose === PaymentPurpose.ORDER_ESCROW) {
      await this.orderQrisPaymentService.handleSettlement(pt.midtransOrderId, grossAmount);
    } else if (
      pt.provider === PaymentProvider.DANA &&
      pt.purpose === PaymentPurpose.SUBSCRIPTION &&
      pt.danaPayKind
    ) {
      // Misi tanpa-wallet: subscription Kahade+ via DANA direct — aktivasi
      // TANPA menyentuh wallet. activateDanaSubscription sudah menandai
      // payment SUCCESS secara atomik + fail-closed (verify-via-API, cek
      // nominal). Return awal: skip update SUCCESS generik di bawah.
      await this.subscriptionsService.activateDanaSubscription(pt.id);
      return;
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

  /**
   * Fail-closed untuk top-up DANA in-flight saat wallet nonaktif: kembalikan
   * dana ke metode bayar asal via DANA Refund API (bukan ke wallet).
   * Idempoten via partnerRefundNo stabil; gagal → lempar agar webhookLog
   * mencatat (tidak retry tanpa henti, admin rekonsiliasi manual).
   */
  private async refundTopupToSource(pt: {
    id: string;
    danaPartnerReferenceNo: string | null;
    grossAmount: bigint;
  }): Promise<void> {
    if (!pt.danaPartnerReferenceNo) {
      this.logger.error(
        `DANA webhook: topup ${pt.id} tanpa danaPartnerReferenceNo — TIDAK bisa refund otomatis, butuh review manual`,
      );
      throw new ServiceUnavailableException({
        code: 'DANA_TOPUP_REFUND_NO_REFERENCE',
        message: 'Topup DANA tanpa referensi — butuh review manual',
      });
    }
    const partnerRefundNo = `RFD-${pt.id}-nowallet-topup`;
    try {
      await this.danaPaymentService.refundOrder({
        partnerReferenceNo: pt.danaPartnerReferenceNo,
        partnerRefundNo,
        amountIdr: Math.round(Number(pt.grossAmount) / 100),
        reason: 'Wallet disabled (BI-safe mode) — topup refunded to source',
      });
      await this.prisma.paymentTransaction.update({
        where: { id: pt.id },
        data: {
          status: PaymentStatus.REFUNDED,
          refundReference: partnerRefundNo,
          refundRequestedAt: new Date(),
          refundReason: 'Wallet nonaktif (mode BI-safe) — topup dikembalikan ke metode bayar asal',
        },
      });
      this.logger.log(`DANA webhook: topup ${pt.id} di-refund ke sumber (wallet nonaktif)`);
    } catch (e) {
      this.logger.error(
        `DANA webhook: refund topup ${pt.id} gagal — butuh review manual: ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
      throw e;
    }
  }
}
