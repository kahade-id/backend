import { Logger } from '@nestjs/common';
import { registerAs } from '@nestjs/config';

const logger = new Logger('FlashConfig');

/**
 * Flash Mobile (MNC Group) — payment gateway pengganti Midtrans.
 * Dipakai untuk pembayaran QRIS (termasuk langganan Kahade+).
 *
 * Kredensial (Client Key + Secret/Server Key) didapat dari Flash Dashboard.
 * Docs: https://api-doc.flashmobile.id/
 */
export const flashConfig = registerAs('flash', () => {
  const isProduction = process.env.FLASH_IS_PRODUCTION === 'true';

  // Docs tidak konsisten (.id vs .co.id); default pakai .id sesuai header docs.
  const defaultBaseUrl = isProduction
    ? 'https://app.flashmobile.id'
    : 'https://sandbox-app.flashmobile.id';

  const clientKey = process.env.FLASH_CLIENT_KEY || '';
  const serverKey = process.env.FLASH_SERVER_KEY || '';

  if (!clientKey || !serverKey) {
    logger.warn('FLASH_CLIENT_KEY atau FLASH_SERVER_KEY belum di-set — layanan QRIS Flash berjalan dalam mode degraded.');
  }

  return {
    isProduction,
    baseUrl: process.env.FLASH_BASE_URL || defaultBaseUrl,
    clientKey,
    serverKey,
    // URL callback yang didaftarkan di Flash Merchant Dashboard.
    callbackUrl:
      process.env.FLASH_CALLBACK_URL || 'https://api.kahade.id/v1/webhooks/flash/qris',
    // Masa berlaku QR dalam menit (session_time).
    qrisExpiryMinutes: Number(process.env.FLASH_QRIS_EXPIRY_MINUTES) || 30,
  };
});
