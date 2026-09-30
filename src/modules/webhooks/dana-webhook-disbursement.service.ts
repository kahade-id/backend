import {
  ForbiddenException,
  Injectable,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import {
  DANA_SANDBOX_WEBHOOK_PUBLIC_KEY,
  verifyDanaWebhookSignature,
} from '../payment/dana/dana-snap.util';
import { DanaDisbursementNotify } from '../payment/dana/dana.types';
import { parseDanaAmount } from '../payment/dana/dana-payment.service';
import { DanaWebhookOutcome } from './dana-webhook-settlement.service';

/** Ack yang wajib dikembalikan ke DANA untuk Transfer to Bank Notify. */
export const DANA_DISBURSE_NOTIFY_ACK: DanaWebhookOutcome = {
  responseCode: '2004300',
  responseMessage: 'Successful',
};

/** Status DANA yang dikenal pada Transfer to Bank Notify. */
const KNOWN_DISBURS_STATUSES = new Set([
  '00', // sukses
  '01',
  '02',
  '03', // pending
  '04',
  '05',
  '06',
  '07', // gagal
]);

/**
 * Webhook DANA Transfer to Bank Notify (disbursement).
 *
 * URL didaftarkan di DANA dashboard (Production Endpoint Setup →
 * Disbursement Notify URL):
 *   https://api.kahade.id/v1/webhooks/dana/disbursement
 *
 * DANA mengirim update status transfer bank ke endpoint ini setelah
 * pemrosesan bank selesai. latestTransactionStatus:
 *   00 = sukses → EscrowDisbursement.status = SUCCESS
 *   01/02/03 = pending → status = PROCESSING
 *   04/05/06/07 = gagal → status = FAILED (bisa retry via idempotencyKey)
 *   di luar itu = TAK DIKENAL → status = NEEDS_REVIEW (butuh review manual,
 *     JANGAN otomatis FAILED)
 *
 * Alur keamanan (fail-closed, pola sama dengan finish-notify):
 *  1. Validasi header SNAP: X-PARTNER-ID wajib cocok dengan
 *     dana.partnerId, X-EXTERNAL-ID wajib ada, CHANNEL-ID wajib cocok
 *     dengan dana.channelId. Gagal → 403. (Public key webhook DANA dipakai
 *     bersama semua merchant — signature valid saja tidak membuktikan
 *     notify ini ditujukan untuk kita.)
 *  2. Verifikasi signature RSA-SHA256 DANA atas raw body terhadap path
 *     callback merchant (/v1/webhooks/dana/disbursement). Gagal → 403.
 *  3. Durable inbox `webhookLog` (source='DANA', eventKey unik) — idempoten.
 *  4. Lookup EscrowDisbursement via `danaPartnerReferenceNo`
 *     (= originalPartnerReferenceNo). Tidak ditemukan → catat saja,
 *     TANPA perubahan status.
 *  5. Hanya transisi status yang valid; tidak ada logika finansial baru —
 *     dana sudah keluar saat transfer-bank dipanggil, notify hanya
 *     mengonfirmasi hasil akhirnya.
 *
 * Balas 200 + 2004300 untuk outcome bisnis agar DANA tidak retry tanpa henti;
 * 403 untuk signature/header invalid; 5xx bila applyStatus gagal — DENGAN
 * SENGAJA tidak menandai webhookLog processed agar DANA me-retry.
 */
@Injectable()
export class DanaWebhookDisbursementService {
  private readonly logger = new Logger(DanaWebhookDisbursementService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  private webhookPublicKey(): string {
    const fromEnv = this.config.get<string>('dana.publicKey') ?? '';
    if (fromEnv.trim()) return fromEnv;
    return DANA_SANDBOX_WEBHOOK_PUBLIC_KEY;
  }

  /** Parse payload Transfer to Bank Notify → null bila field kunci hilang. */
  parseDisbursNotify(body: Record<string, unknown>): DanaDisbursementNotify | null {
    const originalPartnerReferenceNo = String(
      body?.originalPartnerReferenceNo ?? '',
    ).trim();
    const latestTransactionStatus = String(
      body?.latestTransactionStatus ?? '',
    ).trim();
    if (!originalPartnerReferenceNo || !latestTransactionStatus) return null;
    const amountObj = (body?.amount ?? {}) as Record<string, unknown>;
    return {
      originalPartnerReferenceNo,
      originalReferenceNo: String(body?.originalReferenceNo ?? ''),
      latestTransactionStatus,
      transactionStatusDesc: String(body?.transactionStatusDesc ?? ''),
      amountIdr: parseDanaAmount(amountObj?.value),
    };
  }

  async handleDisbursNotify(
    rawBody: string,
    headers: Record<string, string | string[] | undefined>,
    path: string,
  ): Promise<DanaWebhookOutcome> {
    // Validasi header SNAP dulu (murah, fail-closed) — mengikat notify ke
    // merchant kita. Public key webhook DANA dipakai bersama semua merchant,
    // sehingga signature valid SAJA tidak cukup membuktikan notify ini
    // ditujukan untuk kita.
    this.validateNotifyHeaders(headers);

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
      this.logger.warn('DANA disburs notify: signature tidak valid — ditolak');
      throw new ForbiddenException({
        code: 'WEBHOOK_SIGNATURE_INVALID',
        message: 'Invalid DANA webhook signature',
      });
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(rawBody);
    } catch {
      this.logger.warn('DANA disburs notify: body bukan JSON valid');
      return DANA_DISBURSE_NOTIFY_ACK;
    }
    const notify = this.parseDisbursNotify(parsed as Record<string, unknown>);
    if (!notify) {
      this.logger.warn('DANA disburs notify: field kunci hilang — diabaikan');
      return DANA_DISBURSE_NOTIFY_ACK;
    }

    const eventKey =
      `DANA-DISBURS:${notify.originalReferenceNo || notify.originalPartnerReferenceNo}:` +
      `${notify.latestTransactionStatus}`;
    const webhookLog = await this.prisma.webhookLog.upsert({
      where: { eventKey },
      create: {
        source: 'DANA',
        event: `disburs_notify:${notify.latestTransactionStatus}`,
        payload: parsed as Prisma.InputJsonValue,
        headers: {
          'x-timestamp': timestamp,
          'x-partner-id': String(headers['x-partner-id'] ?? ''),
          'x-external-id': String(headers['x-external-id'] ?? ''),
          'channel-id': String(headers['channel-id'] ?? ''),
        } as Prisma.InputJsonValue,
        transactionId:
          notify.originalReferenceNo || notify.originalPartnerReferenceNo,
        eventKey,
        isProcessed: false,
        lastAttemptAt: new Date(),
      },
      update: { lastAttemptAt: new Date() },
    });
    if (webhookLog.isProcessed) {
      this.logger.warn(`DANA disburs notify duplikat — sudah diproses: ${eventKey}`);
      return DANA_DISBURSE_NOTIFY_ACK;
    }

    try {
      await this.applyStatus(notify);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.logger.error(`DANA disburs notify gagal (${eventKey}): ${msg}`);
      // PENTING: JANGAN tandai processed bila applyStatus gagal — biarkan
      // isProcessed=false agar DANA me-retry notify ini. Catat error untuk
      // observabilitas, lalu lempar agar respons = 5xx (pemicu retry DANA).
      await this.prisma.webhookLog.update({
        where: { id: webhookLog.id },
        data: {
          errorMessage: msg.slice(0, 1000),
          lastAttemptAt: new Date(),
          retryCount: { increment: 1 },
        },
      });
      throw e;
    }

    await this.prisma.webhookLog.update({
      where: { id: webhookLog.id },
      data: { isProcessed: true, processedAt: new Date(), errorMessage: null },
    });
    return DANA_DISBURSE_NOTIFY_ACK;
  }

  /**
   * Validasi header SNAP pada Transfer to Bank Notify (fail-closed).
   *
   * - X-PARTNER-ID wajib sama dengan dana.partnerId terkonfigurasi.
   * - X-EXTERNAL-ID wajib ada (non-kosong).
   * - CHANNEL-ID wajib sama dengan dana.channelId terkonfigurasi.
   *
   * Bila dana.partnerId / dana.channelId belum dikonfigurasi, binding
   * merchant tidak bisa diverifikasi → tolak (fail-closed).
   */
  private validateNotifyHeaders(
    headers: Record<string, string | string[] | undefined>,
  ): void {
    // Express me-lowercase nama header: "CHANNEL-ID" → "channel-id"
    // (tanpa prefix x-).
    const partnerId = String(headers['x-partner-id'] ?? '').trim();
    const externalId = String(headers['x-external-id'] ?? '').trim();
    const channelId = String(headers['channel-id'] ?? '').trim();
    const expectedPartnerId = (this.config.get<string>('dana.partnerId') ?? '').trim();
    const expectedChannelId = (this.config.get<string>('dana.channelId') ?? '').trim();

    const reject = (code: string, detail: string): never => {
      this.logger.warn(`DANA disburs notify: header tidak valid (${code}) — ditolak`);
      throw new ForbiddenException({ code, message: detail });
    };

    if (!expectedPartnerId || !expectedChannelId) {
      this.logger.error(
        'DANA disburs notify: dana.partnerId/dana.channelId belum dikonfigurasi — fail-closed',
      );
      return reject(
        'DANA_MERCHANT_BINDING_UNCONFIGURED',
        'DANA merchant binding is not configured',
      );
    }
    if (!partnerId || partnerId !== expectedPartnerId) {
      return reject('WEBHOOK_PARTNER_ID_MISMATCH', 'X-PARTNER-ID mismatch');
    }
    if (!externalId) {
      return reject('WEBHOOK_EXTERNAL_ID_MISSING', 'X-EXTERNAL-ID missing');
    }
    if (channelId !== expectedChannelId) {
      return reject('WEBHOOK_CHANNEL_ID_MISMATCH', 'CHANNEL-ID mismatch');
    }
  }

  private async applyStatus(notify: DanaDisbursementNotify): Promise<void> {
    const disb = await this.prisma.escrowDisbursement.findUnique({
      where: { danaPartnerReferenceNo: notify.originalPartnerReferenceNo },
    });
    if (!disb) {
      // Notify untuk disbursement tak dikenal — catat saja, tanpa perubahan.
      this.logger.log(
        `DANA disburs notify: partnerReferenceNo tak dikenal (${notify.originalPartnerReferenceNo}) — tanpa perubahan status`,
      );
      return;
    }

    const s = notify.latestTransactionStatus;
    // Status final tidak boleh mundur (fail-closed).
    if (disb.status === 'SUCCESS' || disb.status === 'FAILED' || disb.status === 'CANCELLED') {
      this.logger.log(
        `DANA disburs notify: disbursement ${disb.id} sudah final (${disb.status}) — idempoten skip`,
      );
      return;
    }

    if (s === '00') {
      await this.prisma.escrowDisbursement.update({
        where: { id: disb.id },
        data: {
          status: 'SUCCESS',
          danaReferenceNo: notify.originalReferenceNo || disb.danaReferenceNo,
          releasedAt: new Date(),
          lastError: null,
        },
      });
      this.logger.log(`DANA disburs notify: disbursement ${disb.id} → SUCCESS`);
      return;
    }
    if (s === '01' || s === '02' || s === '03') {
      await this.prisma.escrowDisbursement.update({
        where: { id: disb.id },
        data: { status: 'PROCESSING', lastError: null },
      });
      this.logger.log(
        `DANA disburs notify: disbursement ${disb.id} → PROCESSING (status ${s})`,
      );
      return;
    }
    if (s === '04' || s === '05' || s === '06' || s === '07') {
      // 04/05/06/07 = gagal — bisa retry via idempotencyKey (fail-closed).
      await this.prisma.escrowDisbursement.update({
        where: { id: disb.id },
        data: {
          status: 'FAILED',
          lastError: `DANA disburs notify: ${s} ${notify.transactionStatusDesc}`.slice(0, 500),
        },
      });
      this.logger.warn(
        `DANA disburs notify: disbursement ${disb.id} → FAILED (status ${s})`,
      );
      return;
    }
    // Status di luar 00–07: TAK DIKENAL. Keputusan eksplisit (2026-09-30):
    // JANGAN otomatis FAILED — kode status yang tidak dipahami tidak boleh
    // diterjemahkan menjadi keputusan finansial. Tandai NEEDS_REVIEW agar
    // admin meninjau manual (cek di DANA dashboard) sebelum memutuskan
    // retry / FAILED / SUCCESS. Baris NEEDS_REVIEW tidak disentuh retryDue.
    await this.prisma.escrowDisbursement.update({
      where: { id: disb.id },
      data: {
        status: 'NEEDS_REVIEW',
        lastError:
          `DANA disburs notify: status tak dikenal "${s}" (${notify.transactionStatusDesc}) — butuh review manual`.slice(
            0,
            500,
          ),
      },
    });
    this.logger.error(
      `DANA disburs notify: disbursement ${disb.id} → NEEDS_REVIEW (status tak dikenal "${s}")`,
    );
  }
}
