/**
 * [CRY-024] Centralized ID and random generation utility. All random value
 * generation in the backend uses crypto.randomBytes (CSPRNG) via the
 * secureRandom() helper below, ensuring uniform security properties.
 */
import { randomBytes } from 'crypto';
import { customAlphabet } from 'nanoid';
import { toWIB } from './date.util';

const ALPHANUM = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const safeNanoId = customAlphabet(ALPHANUM, 16);

function secureRandom(chars: string, length: number): string {
  const limit = 256 - (256 % chars.length);
  let result = '';
  const maxIterations = length * 20;
  let iterations = 0;
  while (result.length < length) {
    if (++iterations > maxIterations) {
      throw new Error(`secureRandom exceeded max iterations (${maxIterations})`);
    }
    const buf = randomBytes(Math.max(1, (length - result.length) * 2));
    for (let i = 0; i < buf.length && result.length < length; i++) {
      if (buf[i] < limit) result += chars.charAt(buf[i] % chars.length);
    }
  }
  return result;
}

export function generateUserId(): string {
  return 'USR-' + secureRandom('ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789', 8);
}

function jakartaDateStr(): string {
  return toWIB().format('YYYYMMDD');
}

function cryptoSuffix(len = 4): string {
  return secureRandom('0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ', len);
}

export function generateOrderId(serial: number): string {
  return `ORD-${jakartaDateStr()}-${serial.toString().padStart(6, '0')}-${cryptoSuffix()}`;
}

export function generateKycId(serial: number): string {
  return `KYC-${jakartaDateStr()}-${serial.toString().padStart(6, '0')}-${cryptoSuffix()}`;
}

export function generateDisputeId(serial: number): string {
  return `DSP-${jakartaDateStr()}-${serial.toString().padStart(6, '0')}-${cryptoSuffix()}`;
}

export function generateWalletTxId(serial: number): string {
  return `WLT-${jakartaDateStr()}-${serial.toString().padStart(6, '0')}-${cryptoSuffix()}`;
}

export function generatePaymentTxId(serial: number): string {
  return `PAY-${jakartaDateStr()}-${serial.toString().padStart(6, '0')}-${cryptoSuffix()}`;
}

export function generateNotifId(): string {
  return `NTF-${safeNanoId()}`;
}

export function generateAdminId(): string {
  return 'ADMIN-' + secureRandom('ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789', 5);
}

export function generateReferralCode(): string {
  return 'KH' + secureRandom('ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789', 8);
}

export function generateOrderLinkId(serial: number): string {
  return `OLK-${jakartaDateStr()}-${serial.toString().padStart(6, '0')}-${cryptoSuffix()}`;
}

export function generateOrderLinkToken(): string {
  return secureRandom('abcdefghijklmnopqrstuvwxyz0123456789', 24);
}

export function generateCampaignId(serial: number): string {
  return `CMP-${jakartaDateStr()}-${serial.toString().padStart(6, '0')}-${cryptoSuffix()}`;
}
