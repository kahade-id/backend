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
 *
 * Alur keamanan (fail-closed, pola sama dengan finish-notify):
 *  1. Verifikasi signature RSA-SHA256 DANA atas raw body terhadap path
 *     callback merchant (/v1/webhooks/dana/disbursement). Gagal → 403.
 *  2. Durable inbox `webhookLog` (source='DANA', eventKey unik) — idempoten.
 *  3. Lookup EscrowDisbursement via `danaPartnerReferenceNo`
 *     (= originalPartnerReferenceNo). Tidak ditemukan → catat saja,
 *     TANPA perubahan status.
 *  4. Hanya transisi status yang valid; tidak ada logika finansial baru —
 *     dana sudah keluar saat transfer-bank dipanggil, notify hanya
 *     mengonfirmasi hasil akhirnya.
 *
 * Selalu balas 200 untuk outcome bisnis agar DANA tidak retry tanpa henti;
 * 4xx hanya untuk signature invalid.
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
        headers: { 'x-timestamp': timestamp } as Prisma.InputJsonValue,
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
    }

    await this.prisma.webhookLog.update({
      where: { id: webhookLog.id },
      data: { isProcessed: true, processedAt: new Date(), errorMessage: null },
    });
    return DANA_DISBURSE_NOTIFY_ACK;
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
  }
}
