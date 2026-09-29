import { Logger } from '@nestjs/common';
import { registerAs } from '@nestjs/config';

const logger = new Logger('DanaConfig');

/**
 * DANA Enterprise — Gapura Payment Gateway + Disbursement.
 *
 * Provider UTAMA pembayaran Kahade (keputusan produk 2026-09-29,
 * menggantikan Flash/Midtrans untuk uang masuk; Disbursement untuk
 * uang keluar/pencairan menggantikan Iris).
 *
 * Docs: https://dashboard.dana.id/api-docs-v2/
 *   - Create Order: POST /payment-gateway/v1.0/debit/payment-host-to-host.htm
 *     (SNAP service code 54). payMethod QRIS → payOption NETWORK_PAY_PG_QRIS
 *     (externalStoreId WAJIB, partnerReferenceNo maks 25 char);
 *     payMethod VIRTUAL_ACCOUNT → payOption VIRTUAL_ACCOUNT_<BANK>
 *     (DANA auto-generate payment code); payMethod BALANCE.
 *   - Query:   POST /payment-gateway/v1.0/debit/status.htm
 *   - Refund:   POST /payment-gateway/v1.0/debit/refund.htm
 *   - Cancel:   POST /payment-gateway/v1.0/debit/cancel.htm
 *   - Disbursement: /v1.0/emoney/transfer-bank.htm (+ -status),
 *     /rest/v1.0/emoney/topup (+ -status),
 *     /v1.0/emoney/bank-account-inquiry.htm,
 *     /rest/v1.0/emoney/account-inquiry
 *
 * Signature: SNAP asymmetric (RSA-SHA256 PKCS1v15 atas
 *   "{METHOD}:{resourcePath}:{sha256hex(body)}:{X-TIMESTAMP}").
 * Webhook finish-notify diverifikasi dengan skema yang sama memakai
 * public key DANA (sandbox: kunci bawaan SDK resmi; produksi via env).
 *
 * SANDBOX DULU: DANA_ENV=sandbox (default). Pindah ke live =
 * DANA_ENV=production + kredensial produksi (tidak ada perubahan kode).
 */
export const danaConfig = registerAs('dana', () => {
  const env = (process.env.DANA_ENV || 'sandbox').toLowerCase();
  const isProduction = env === 'production';
  const defaultBaseUrl = isProduction
    ? 'https://api.saas.dana.id'
    : 'http://api.sandbox.dana.id';

  const partnerId = process.env.DANA_PARTNER_ID || '';
  const privateKey = process.env.DANA_PRIVATE_KEY || '';
  const merchantId = process.env.DANA_MERCHANT_ID || '';

  if (!partnerId || !privateKey || !merchantId) {
    logger.warn(
      'DANA_PARTNER_ID / DANA_PRIVATE_KEY / DANA_MERCHANT_ID belum di-set — ' +
        'layanan DANA berjalan dalam mode degraded (fail-closed).',
    );
  }

  return {
    env,
    isProduction,
    baseUrl: process.env.DANA_API_BASE_URL || defaultBaseUrl,
    /** X-PARTNER-ID — identifier partner dari DANA dashboard. */
    partnerId,
    /** RSA private key (PEM) untuk signature request. */
    privateKey,
    /**
     * Public key DANA (PEM) untuk verifikasi signature webhook finish-notify.
     * Kosong di sandbox → dipakai kunci publik sandbox bawaan SDK resmi.
     */
    publicKey: process.env.DANA_PUBLIC_KEY || '',
    /** Merchant ID DANA. */
    merchantId,
    /** Header ORIGIN. */
    origin: process.env.DANA_ORIGIN || 'https://kahade.id',
    /** CHANNEL-ID — 95221 (nilai dari SDK resmi). */
    channelId: process.env.DANA_CHANNEL_ID || '95221',
    /** External Shop/Store ID — WAJIB untuk payOption QRIS. */
    externalStoreId: process.env.DANA_EXTERNAL_STORE_ID || '',
    /** URL webhook yang didaftarkan di DANA dashboard (tipe NOTIFICATION). */
    webhookUrl:
      process.env.DANA_WEBHOOK_URL ||
      'https://api.kahade.id/v1/webhooks/dana/payment',
    /** X-DEBUG header — default true di sandbox (mengikuti SDK resmi). */
    debug: process.env.DANA_DEBUG === 'true' || !isProduction,
    /** Masa berlaku order QRIS/VA dalam menit (sandbox: maks 30). */
    orderExpiryMinutes: Number(process.env.DANA_ORDER_EXPIRY_MINUTES) || 30,
  };
});
