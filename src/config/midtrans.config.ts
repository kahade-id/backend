import { Logger } from '@nestjs/common';
import { registerAs } from '@nestjs/config';

const isProduction = process.env.NODE_ENV === 'production';
const logger = new Logger('MidtransConfig');

export const midtransConfig = registerAs('midtrans', () => {
  if (isProduction && !process.env.MIDTRANS_ALLOWED_CIDRS?.trim()) {
    throw new Error('FATAL: MIDTRANS_ALLOWED_CIDRS is required in production to validate webhook source IPs.');
  }

  const serverKey = process.env.MIDTRANS_SERVER_KEY || '';
  const clientKey = process.env.MIDTRANS_CLIENT_KEY || '';

  if (!serverKey || !clientKey) {
    logger.warn('MIDTRANS_SERVER_KEY or MIDTRANS_CLIENT_KEY is missing — Midtrans service will start in degraded mode.');
  }

  return {
    serverKey,
    clientKey,
    isProduction: process.env.MIDTRANS_IS_PRODUCTION === 'true',
    notificationUrl: process.env.MIDTRANS_NOTIFICATION_URL || 'https://api.kahade.id/v1/payments/midtrans-webhook',
    irisKey: process.env.MIDTRANS_IRIS_KEY || '',
    irisIsProduction: process.env.MIDTRANS_IRIS_IS_PRODUCTION === 'true',
    allowedCidrs: process.env.MIDTRANS_ALLOWED_CIDRS || '',
    bypassIpCheck: process.env.MIDTRANS_BYPASS_IP_CHECK === 'true',
    callbackUrl: process.env.MIDTRANS_CALLBACK_URL || process.env.APP_URL || 'https://kahade.id',
  };
});
