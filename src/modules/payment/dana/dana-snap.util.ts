import { createHash, createSign, createVerify, randomUUID } from 'crypto';
import { ForbiddenException } from '@nestjs/common';
import { WEBHOOK_TIMESTAMP_STALE } from '../../../common/constants/error-codes';

/**
 * Util signature SNAP DANA (asymmetric RSA-SHA256, PKCS1v15).
 *
 * Dipetakan 1:1 dari SDK resmi dana-python
 * (dana/utils/snap_header.py + dana/webhook/webhook.py):
 *
 * Request (kita → DANA):
 *   stringToSign = "{METHOD}:{resourcePath}:{sha256hex(body)}:{X-TIMESTAMP}"
 *   X-SIGNATURE  = base64(RSA-SHA256(stringToSign, privateKey))
 *   Header: X-TIMESTAMP, X-SIGNATURE, X-PARTNER-ID, X-EXTERNAL-ID,
 *           CHANNEL-ID, ORIGIN (+ X-DEBUG di sandbox)
 *   X-TIMESTAMP format: YYYY-MM-DDTHH:mm:ss+07:00 (waktu Jakarta)
 *
 * Webhook (DANA → kita):
 *   stringToVerify = "{METHOD}:{path}:{sha256hex(rawBody)}:{X-TIMESTAMP}"
 *   diverifikasi dengan public key DANA (RSA-SHA256, PKCS1v15).
 *   Beberapa bentuk body dicoba (raw, minified) mengikuti SDK resmi,
 *   karena whitespace/escaping bisa berbeda antar pengirim.
 */

const JAKARTA_OFFSET_MS = 7 * 60 * 60 * 1000;

/** "YYYY-MM-DDTHH:mm:ss+07:00" — zona Jakarta, sesuai spek DANA. */
export function jakartaTimestamp(date: Date = new Date()): string {
  const jkt = new Date(date.getTime() + JAKARTA_OFFSET_MS);
  const p = (n: number) => String(n).padStart(2, '0');
  return (
    `${jkt.getUTCFullYear()}-${p(jkt.getUTCMonth() + 1)}-${p(jkt.getUTCDate())}` +
    `T${p(jkt.getUTCHours())}:${p(jkt.getUTCMinutes())}:${p(jkt.getUTCSeconds())}+07:00`
  );
}

export function sha256HexLower(data: string): string {
  return createHash('sha256').update(data, 'utf8').digest('hex');
}

/**
 * Audit 2026-10-03 (SEC-206): jendela kesegaran X-TIMESTAMP webhook DANA.
 * Timestamp di luar ±5 menit dari jam server ditolak SEBELUM verifikasi
 * signature RSA (defense-in-depth terhadap replay; dedup eventKey saja
 * tidak cukup sebagai satu-satunya pertahanan).
 */
export const WEBHOOK_TIMESTAMP_TOLERANCE_MS = 5 * 60 * 1000;

/**
 * True bila X-TIMESTAMP (format SNAP `YYYY-MM-DDTHH:mm:ss+07:00`) berada
 * dalam ±`toleranceMs` dari `nowMs`. Timestamp yang tidak bisa di-parse
 * dianggap basi (fail-closed).
 */
export function isWebhookTimestampFresh(
  timestamp: string,
  nowMs: number = Date.now(),
  toleranceMs: number = WEBHOOK_TIMESTAMP_TOLERANCE_MS,
): boolean {
  if (!timestamp) return false;
  const parsed = Date.parse(timestamp);
  if (!Number.isFinite(parsed)) return false;
  return Math.abs(nowMs - parsed) <= toleranceMs;
}

/**
 * SEC-206: tolak webhook dengan X-TIMESTAMP basi → 403 WEBHOOK_TIMESTAMP_STALE.
 * Dipanggil handler webhook SEBELUM verifyDanaWebhookSignature.
 */
export function assertWebhookTimestampFresh(
  timestamp: string,
  nowMs: number = Date.now(),
): void {
  if (!isWebhookTimestampFresh(timestamp, nowMs)) {
    throw new ForbiddenException({
      code: WEBHOOK_TIMESTAMP_STALE,
      message: 'Webhook timestamp is outside the allowed ±5 minute window',
    });
  }
}

/**
 * Normalisasi private/public key: terima PEM utuh, PEM dengan "\n" yang
 * ter-escape (gaya env var), atau base64 mentah tanpa header.
 */
export function normalizePemKey(
  key: string,
  type: 'PRIVATE' | 'PUBLIC',
): string {
  let k = key.trim().replace(/\\n/g, '\n').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const beginStd = `-----BEGIN ${type} KEY-----`;
  const endStd = `-----END ${type} KEY-----`;
  const beginRsa = `-----BEGIN RSA ${type} KEY-----`;
  const endRsa = `-----END RSA ${type} KEY-----`;
  if (k.includes(beginStd) && k.includes(endStd)) return k;
  if (k.includes(beginRsa) && k.includes(endRsa)) return k;
  const body = k.replace(/\s+/g, '');
  const chunked = body.replace(/(.{64})/g, '$1\n');
  return `${beginStd}\n${chunked}\n${endStd}`;
}

export interface SnapSignInput {
  method: 'POST' | 'GET' | 'PUT' | 'DELETE';
  /** Path persis seperti di docs, mis. '/payment-gateway/v1.0/debit/payment-host-to-host.htm'. */
  resourcePath: string;
  /** String JSON body persis yang akan dikirim. */
  body: string;
  privateKeyPem: string;
}

export interface SnapSignedRequest {
  timestamp: string;
  signature: string;
  externalId: string;
}

/** Tandatangani request SNAP. */
export function signSnapRequest(input: SnapSignInput): SnapSignedRequest {
  const timestamp = jakartaTimestamp();
  const bodyHash = sha256HexLower(input.body);
  const stringToSign = `${input.method}:${input.resourcePath}:${bodyHash}:${timestamp}`;
  const signature = createSign('RSA-SHA256')
    .update(stringToSign, 'utf8')
    .sign(normalizePemKey(input.privateKeyPem, 'PRIVATE'), 'base64');
  const externalId = `sdk${randomUUID().replace(/-/g, '').slice(3)}`;
  return { timestamp, signature, externalId };
}

export interface DanaRequestHeadersInput {
  partnerId: string;
  origin: string;
  channelId: string;
  debug: boolean;
  signed: SnapSignedRequest;
}

/** Header HTTP untuk request ke DANA. */
export function buildDanaHeaders(input: DanaRequestHeadersInput): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    'X-TIMESTAMP': input.signed.timestamp,
    'X-SIGNATURE': input.signed.signature,
    'X-PARTNER-ID': input.partnerId,
    'X-EXTERNAL-ID': input.signed.externalId,
    'CHANNEL-ID': input.channelId,
    ORIGIN: input.origin,
  };
  if (input.debug) headers['X-DEBUG'] = 'true';
  return headers;
}

/**
 * Bentuk-bentuk body yang dicoba saat verifikasi signature webhook,
 * mengikuti dana/webhook/webhook.py (SDK resmi).
 */
export function webhookBodyCandidates(rawBody: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const add = (s: string) => {
    if (s && !seen.has(s)) {
      seen.add(s);
      out.push(s);
    }
  };
  add(rawBody);
  try {
    const parsed: unknown = JSON.parse(rawBody);
    // Minified dengan urutan key asli (Express/Nest preserve insertion order).
    add(JSON.stringify(parsed));
  } catch {
    // rawBody bukan JSON valid — hanya bentuk raw yang dicoba.
  }
  return out;
}

export interface VerifyWebhookInput {
  method: 'POST';
  /** Path webhook kita, mis. '/v1/webhooks/dana/payment'. */
  path: string;
  /** Raw body persis seperti diterima (Buffer → string utf8). */
  rawBody: string;
  timestamp: string;
  signature: string;
  /** Public key DANA (PEM). */
  publicKeyPem: string;
  /**
   * SEC-206: bila true, X-TIMESTAMP di luar ±5 menit langsung melempar
   * 403 WEBHOOK_TIMESTAMP_STALE SEBELUM verifikasi RSA (bukan sekadar
   * mengembalikan false). Default false demi kompatibilitas pemanggil lama.
   */
  enforceFreshness?: boolean;
}

/**
 * Verifikasi signature webhook finish-notify DANA.
 * @returns true bila signature valid untuk salah satu bentuk body.
 * @throws ForbiddenException WEBHOOK_TIMESTAMP_STALE bila
 * `enforceFreshness=true` dan X-TIMESTAMP basi.
 */
export function verifyDanaWebhookSignature(input: VerifyWebhookInput): boolean {
  if (!input.timestamp || !input.signature) return false;
  if (input.enforceFreshness) assertWebhookTimestampFresh(input.timestamp);
  const path = input.path.startsWith('/') ? input.path : `/${input.path}`;
  let signatureBytes: Buffer;
  try {
    signatureBytes = Buffer.from(input.signature, 'base64');
  } catch {
    return false;
  }
  const publicKey = normalizePemKey(input.publicKeyPem, 'PUBLIC');
  for (const body of webhookBodyCandidates(input.rawBody)) {
    const stringToVerify = `${input.method}:${path}:${sha256HexLower(body)}:${input.timestamp}`;
    try {
      const ok = createVerify('RSA-SHA256')
        .update(stringToVerify, 'utf8')
        .verify(publicKey, signatureBytes);
      if (ok) return true;
    } catch {
      // Lanjut ke kandidat berikutnya.
    }
  }
  return false;
}

/**
 * Public key webhook DANA untuk SANDBOX — disalin dari SDK resmi
 * dana-python (dana/webhook/webhook.py :: SANDBOX_WEBHOOK_PUBLIC_KEY).
 * Dipakai bila DANA_PUBLIC_KEY tidak di-set (mode sandbox).
 */
export const DANA_SANDBOX_WEBHOOK_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAnaKVGRbin4Wh4KN35OPh
ytJBjYTz7QZKSZjmHfiHxFmulfT87rta+IvGJ0rCBgg+1EtKk1hX8G5gPGJs1htJ
5jHa3/jCk9l+luzjnuT9UVlwJahvzmFw+IoDoM7hIPjsLtnIe04SgYo0tZBpEmkQ
vUGhmHPqYnUGSSMIpDLJDvbyr8gtwluja1SbRphgDCoYVXq+uUJ5HzPS049aaxTS
nfXh/qXuDoB9EzCrgppLDS2ubmk21+dr7WaO/3RFjnwx5ouv6w+iC1XOJKar3CTk
X6JV1OSST1C9sbPGzMHZ8AGB51BM0mok7davD/5irUk+f0C25OgzkwtxAt80dkDo
/QIDAQAB
-----END PUBLIC KEY-----`;
