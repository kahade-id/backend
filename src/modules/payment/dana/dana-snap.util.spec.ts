import { createSign, createVerify, generateKeyPairSync } from 'crypto';
import { ForbiddenException } from '@nestjs/common';
import {
  assertWebhookTimestampFresh,
  buildDanaHeaders,
  isWebhookTimestampFresh,
  jakartaTimestamp,
  normalizePemKey,
  sha256HexLower,
  signSnapRequest,
  verifyDanaWebhookSignature,
  webhookBodyCandidates,
} from './dana-snap.util';

function makeKeyPair() {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  return { privateKey, publicKey };
}

describe('dana-snap.util', () => {
  describe('jakartaTimestamp', () => {
    it('format YYYY-MM-DDTHH:mm:ss+07:00', () => {
      const ts = jakartaTimestamp(new Date('2026-09-29T10:00:00Z'));
      expect(ts).toBe('2026-09-29T17:00:00+07:00');
    });
  });

  describe('normalizePemKey', () => {
    it('menerima PEM dengan newline ter-escape (gaya env var)', () => {
      const { privateKey } = makeKeyPair();
      const escaped = privateKey.replace(/\n/g, '\\n');
      const normalized = normalizePemKey(escaped, 'PRIVATE');
      expect(normalized).toContain('-----BEGIN PRIVATE KEY-----');
      expect(normalized).not.toContain('\\n');
    });

    it('menerima base64 mentah tanpa header', () => {
      const { publicKey } = makeKeyPair();
      const raw = publicKey
        .replace('-----BEGIN PUBLIC KEY-----', '')
        .replace('-----END PUBLIC KEY-----', '')
        .replace(/\s+/g, '');
      const normalized = normalizePemKey(raw, 'PUBLIC');
      expect(normalized.startsWith('-----BEGIN PUBLIC KEY-----')).toBe(true);
    });
  });

  describe('signSnapRequest', () => {
    it('stringToSign mengikuti skema SDK resmi dan terverifikasi RSA', () => {
      const { privateKey, publicKey } = makeKeyPair();
      const body = JSON.stringify({ partnerReferenceNo: 'DANA-QR-001' });
      const resourcePath = '/payment-gateway/v1.0/debit/payment-host-to-host.htm';
      const signed = signSnapRequest({ method: 'POST', resourcePath, body, privateKeyPem: privateKey });

      const stringToSign = `POST:${resourcePath}:${sha256HexLower(body)}:${signed.timestamp}`;
      const ok = createVerify('RSA-SHA256')
        .update(stringToSign, 'utf8')
        .verify(publicKey, Buffer.from(signed.signature, 'base64'));
      expect(ok).toBe(true);
      // Cross-check dengan createSign mentah (bukan via util) — memastikan
      // tidak ada perbedaan skema stringToSign.
      const independent = createSign('RSA-SHA256')
        .update(stringToSign, 'utf8')
        .sign(privateKey, 'base64');
      expect(
        createVerify('RSA-SHA256')
          .update(stringToSign, 'utf8')
          .verify(publicKey, Buffer.from(independent, 'base64')),
      ).toBe(true);
      expect(signed.externalId.startsWith('sdk')).toBe(true);
    });
  });

  describe('buildDanaHeaders', () => {
    it('memuat semua header SNAP wajib', () => {
      const headers = buildDanaHeaders({
        partnerId: 'PARTNER-1',
        origin: 'https://kahade.id',
        channelId: '95221',
        debug: true,
        signed: { timestamp: 't', signature: 's', externalId: 'e' },
      });
      expect(headers['X-TIMESTAMP']).toBe('t');
      expect(headers['X-SIGNATURE']).toBe('s');
      expect(headers['X-PARTNER-ID']).toBe('PARTNER-1');
      expect(headers['X-EXTERNAL-ID']).toBe('e');
      expect(headers['CHANNEL-ID']).toBe('95221');
      expect(headers['ORIGIN']).toBe('https://kahade.id');
      expect(headers['X-DEBUG']).toBe('true');
    });

    it('tanpa X-DEBUG bila debug=false', () => {
      const headers = buildDanaHeaders({
        partnerId: 'P',
        origin: 'o',
        channelId: 'c',
        debug: false,
        signed: { timestamp: 't', signature: 's', externalId: 'e' },
      });
      expect(headers['X-DEBUG']).toBeUndefined();
    });
  });

  describe('verifyDanaWebhookSignature', () => {
    const path = '/v1/webhooks/dana/payment';
    const bodyObj = {
      originalPartnerReferenceNo: 'DANA-QR-001',
      originalReferenceNo: '2020102977770000000009',
      latestTransactionStatus: '00',
      amount: { value: '15000.00', currency: 'IDR' },
    };

    /** Mensimulasikan DANA menandatangani webhook. */
    function danaSign(rawBody: string, privateKey: string, timestamp: string): string {
      const stringToVerify = `POST:${path}:${sha256HexLower(rawBody)}:${timestamp}`;
      return createSign('RSA-SHA256').update(stringToVerify, 'utf8').sign(privateKey, 'base64');
    }

    it('valid untuk raw body minified (kasus umum)', () => {
      const { privateKey, publicKey } = makeKeyPair();
      const rawBody = JSON.stringify(bodyObj);
      const timestamp = jakartaTimestamp();
      const signature = danaSign(rawBody, privateKey, timestamp);
      expect(
        verifyDanaWebhookSignature({
          method: 'POST',
          path,
          rawBody,
          timestamp,
          signature,
          publicKeyPem: publicKey,
        }),
      ).toBe(true);
    });

    it('valid untuk raw body pretty-printed (fallback kandidat minified)', () => {
      const { privateKey, publicKey } = makeKeyPair();
      const pretty = JSON.stringify(bodyObj, null, 2);
      const timestamp = jakartaTimestamp();
      // DANA menandatangani bentuk minified (seperti SDK: ensure minified).
      const signature = danaSign(JSON.stringify(bodyObj), privateKey, timestamp);
      expect(
        verifyDanaWebhookSignature({
          method: 'POST',
          path,
          rawBody: pretty,
          timestamp,
          signature,
          publicKeyPem: publicKey,
        }),
      ).toBe(true);
    });

    it('menolak signature yang salah', () => {
      const { publicKey } = makeKeyPair();
      const { privateKey: otherKey } = makeKeyPair();
      const rawBody = JSON.stringify(bodyObj);
      const timestamp = jakartaTimestamp();
      const signature = danaSign(rawBody, otherKey, timestamp);
      expect(
        verifyDanaWebhookSignature({
          method: 'POST',
          path,
          rawBody,
          timestamp,
          signature,
          publicKeyPem: publicKey,
        }),
      ).toBe(false);
    });

    it('menolak bila timestamp/signature kosong', () => {
      const { publicKey } = makeKeyPair();
      expect(
        verifyDanaWebhookSignature({
          method: 'POST',
          path,
          rawBody: '{}',
          timestamp: '',
          signature: '',
          publicKeyPem: publicKey,
        }),
      ).toBe(false);
    });

    it('menolak body yang diubah setelah signing (tamper)', () => {
      const { privateKey, publicKey } = makeKeyPair();
      const rawBody = JSON.stringify(bodyObj);
      const timestamp = jakartaTimestamp();
      const signature = danaSign(rawBody, privateKey, timestamp);
      const tampered = JSON.stringify({
        ...bodyObj,
        amount: { value: '999999.00', currency: 'IDR' },
      });
      expect(
        verifyDanaWebhookSignature({
          method: 'POST',
          path,
          rawBody: tampered,
          timestamp,
          signature,
          publicKeyPem: publicKey,
        }),
      ).toBe(false);
    });
  });

  describe('webhookBodyCandidates', () => {
    it('selalu menyertakan raw body', () => {
      const c = webhookBodyCandidates('not-json{{{');
      expect(c).toEqual(['not-json{{{']);
    });
  });

  describe('isWebhookTimestampFresh / assertWebhookTimestampFresh (SEC-206)', () => {
    const NOW = Date.parse('2026-10-03T10:00:00+07:00');
    const freshPath = '/v1/webhooks/dana/payment';
    const freshBody = { originalPartnerReferenceNo: 'DANA-QR-001', latestTransactionStatus: '00' };
    const ts = (offsetMs: number) => new Date(NOW + offsetMs).toISOString();
    /** Mensimulasikan DANA menandatangani webhook (duplikat lokal agar mandiri). */
    function signLocal(rawBody: string, privateKey: string, timestamp: string): string {
      const stringToVerify = `POST:${freshPath}:${sha256HexLower(rawBody)}:${timestamp}`;
      return createSign('RSA-SHA256').update(stringToVerify, 'utf8').sign(privateKey, 'base64');
    }

    it('timestamp kini → fresh', () => {
      expect(isWebhookTimestampFresh(ts(0), NOW)).toBe(true);
    });

    it('di batas ±5 menit → fresh; di luar batas → basi', () => {
      expect(isWebhookTimestampFresh(ts(5 * 60 * 1000), NOW)).toBe(true);
      expect(isWebhookTimestampFresh(ts(-5 * 60 * 1000), NOW)).toBe(true);
      expect(isWebhookTimestampFresh(ts(5 * 60 * 1000 + 1), NOW)).toBe(false);
      expect(isWebhookTimestampFresh(ts(-6 * 60 * 1000), NOW)).toBe(false);
      expect(isWebhookTimestampFresh(ts(60 * 60 * 1000), NOW)).toBe(false);
    });

    it('format SNAP Jakarta (+07:00) bisa di-parse', () => {
      expect(isWebhookTimestampFresh('2026-10-03T10:04:59+07:00', NOW)).toBe(true);
      expect(isWebhookTimestampFresh('2026-10-03T09:54:00+07:00', NOW)).toBe(false);
    });

    it('timestamp kosong / tidak valid → basi (fail-closed)', () => {
      expect(isWebhookTimestampFresh('', NOW)).toBe(false);
      expect(isWebhookTimestampFresh('bukan-timestamp', NOW)).toBe(false);
    });

    it('assertWebhookTimestampFresh: fresh → tidak throw; basi → 403 WEBHOOK_TIMESTAMP_STALE', () => {
      expect(() => assertWebhookTimestampFresh(ts(0), NOW)).not.toThrow();
      try {
        assertWebhookTimestampFresh(ts(-10 * 60 * 1000), NOW);
        throw new Error('harusnya melempar');
      } catch (e: any) {
        expect(e).toBeInstanceOf(ForbiddenException);
        expect(e.response.code).toBe('WEBHOOK_TIMESTAMP_STALE');
        expect(e.status).toBe(403);
      }
    });

    it('verifyDanaWebhookSignature + enforceFreshness: basi → throw SEBELUM verifikasi RSA', () => {
      const { privateKey, publicKey } = makeKeyPair();
      const rawBody = JSON.stringify(freshBody);
      // Signature VALID untuk timestamp basi 2026-09-30.
      const staleTs = '2026-09-30T15:00:00+07:00';
      const signature = signLocal(rawBody, privateKey, staleTs);
      expect(() =>
        verifyDanaWebhookSignature({
          method: 'POST',
          path: freshPath,
          rawBody,
          timestamp: staleTs,
          signature,
          publicKeyPem: publicKey,
          enforceFreshness: true,
        }),
      ).toThrow(expect.objectContaining({ response: expect.objectContaining({ code: 'WEBHOOK_TIMESTAMP_STALE' }) }));
    });

    it('verifyDanaWebhookSignature tanpa enforceFreshness: perilaku lama (boolean)', () => {
      const { privateKey, publicKey } = makeKeyPair();
      const rawBody = JSON.stringify(freshBody);
      const timestamp = jakartaTimestamp();
      const signature = signLocal(rawBody, privateKey, timestamp);
      expect(
        verifyDanaWebhookSignature({ method: 'POST', path: freshPath, rawBody, timestamp, signature, publicKeyPem: publicKey }),
      ).toBe(true);
    });
  });
});
