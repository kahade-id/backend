import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createPublicKey, createVerify, type KeyObject, type JsonWebKey } from 'node:crypto';

/**
 * GAP-A (G009–G011): verifikasi token identitas Apple (Sign in with Apple).
 *
 * Alur:
 *  - Ambil JWKS publik Apple dari https://appleid.apple.com/auth/keys (cache 24 jam).
 *  - Verifikasi signature RS256 dengan kunci yang cocok (kid), lalu validasi
 *    klaim: iss === 'https://appleid.apple.com', aud === APPLE_CLIENT_ID,
 *    exp belum lewat, dan nonce cocok dengan yang dikirim saat otorisasi
 *    (anti-replay, G011).
 *
 * Modul ini TIDAK aktif kecuali APPLE_CLIENT_ID dikonfigurasi; AuthService
 * tetap melempar SOCIAL_PROVIDER_NOT_SUPPORTED bila belum dikonfigurasi (G002/G005).
 */
interface AppleJwk {
  kty: string;
  kid: string;
  use: string;
  alg: string;
  n: string;
  e: string;
}

export interface VerifiedAppleIdentity {
  sub: string;
  email?: string;
  emailVerified?: boolean;
}

const APPLE_JWKS_URL = 'https://appleid.apple.com/auth/keys';
const APPLE_ISSUER = 'https://appleid.apple.com';
const JWKS_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

@Injectable()
export class AppleAuthService {
  private readonly logger = new Logger(AppleAuthService.name);
  private jwksCache: { fetchedAt: number; keys: AppleJwk[] } | null = null;

  constructor(private readonly configService: ConfigService) {}

  /** True bila provider Apple dikonfigurasi di server (G002). */
  isConfigured(): boolean {
    const clientId =
      this.configService.get<string>('app.appleClientId') || process.env.APPLE_CLIENT_ID;
    return !!clientId;
  }

  getClientId(): string | undefined {
    return (
      this.configService.get<string>('app.appleClientId') || process.env.APPLE_CLIENT_ID || undefined
    );
  }

  private async getJwks(): Promise<AppleJwk[]> {
    const now = Date.now();
    if (this.jwksCache && now - this.jwksCache.fetchedAt < JWKS_CACHE_TTL_MS) {
      return this.jwksCache.keys;
    }
    // G010: pemuatan + cache JWKS Apple.
    const res = await fetch(APPLE_JWKS_URL, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) {
      throw new Error(`Apple JWKS fetch failed: HTTP ${res.status}`);
    }
    const body = (await res.json()) as { keys?: AppleJwk[] };
    const keys = Array.isArray(body.keys) ? body.keys : [];
    if (keys.length === 0) throw new Error('Apple JWKS returned no keys');
    this.jwksCache = { fetchedAt: now, keys };
    return keys;
  }

  private base64UrlDecode(input: string): Buffer {
    const padded = input.replace(/-/g, '+').replace(/_/g, '/');
    return Buffer.from(padded, 'base64');
  }

  /**
   * Verifikasi identityToken Apple. Melempar Error bila tidak valid.
   * @param identityToken JWT dari Apple.
   * @param expectedNonce nonce yang dikirim saat request otorisasi (wajib, G011).
   */
  async verifyIdentityToken(identityToken: string, expectedNonce?: string): Promise<VerifiedAppleIdentity> {
    const clientId = this.getClientId();
    if (!clientId) {
      throw new Error('Apple login is not configured on this server');
    }
    const parts = identityToken.split('.');
    if (parts.length !== 3) throw new Error('Malformed Apple identity token');
    const [headerB64, payloadB64, signatureB64] = parts;
    let header: { kid?: string; alg?: string };
    let payload: Record<string, unknown>;
    try {
      header = JSON.parse(this.base64UrlDecode(headerB64).toString('utf8'));
      payload = JSON.parse(this.base64UrlDecode(payloadB64).toString('utf8'));
    } catch {
      throw new Error('Malformed Apple identity token');
    }
    if (header.alg !== 'RS256') throw new Error('Unexpected Apple token algorithm');
    if (!header.kid) throw new Error('Apple token missing kid');

    const keys = await this.getJwks().catch((e) => {
      this.logger.warn(`Apple JWKS fetch failed: ${(e as Error).message}`);
      throw new Error('Unable to verify Apple token at this time');
    });
    const jwk = keys.find((k) => k.kid === header.kid);
    if (!jwk) throw new Error('Apple signing key not found');

    let publicKey: KeyObject;
    try {
      publicKey = createPublicKey({ key: jwk as unknown as JsonWebKey, format: 'jwk' });
    } catch {
      throw new Error('Invalid Apple signing key');
    }
    const verifier = createVerify('RSA-SHA256');
    verifier.update(`${headerB64}.${payloadB64}`);
    const signature = this.base64UrlDecode(signatureB64);
    if (!verifier.verify(publicKey, signature)) {
      throw new Error('Invalid Apple token signature');
    }

    // Validasi klaim.
    const nowSec = Math.floor(Date.now() / 1000);
    if (payload.iss !== APPLE_ISSUER) throw new Error('Invalid Apple token issuer');
    const aud = payload.aud as string | string[] | undefined;
    const audOk = Array.isArray(aud) ? aud.includes(clientId) : aud === clientId;
    if (!audOk) throw new Error('Invalid Apple token audience');
    if (typeof payload.exp !== 'number' || payload.exp <= nowSec) {
      throw new Error('Apple token expired');
    }
    if (typeof payload.iat === 'number' && payload.iat > nowSec + 300) {
      throw new Error('Apple token issued in the future');
    }
    // G011: nonce mengikat token ke percobaan login ini — tolak replay.
    if (!expectedNonce) {
      throw new Error('Nonce is required for Apple login');
    }
    if (payload.nonce !== expectedNonce) {
      throw new Error('Apple token nonce mismatch (possible replay)');
    }
    const sub = payload.sub;
    if (typeof sub !== 'string' || sub.length === 0) {
      throw new Error('Apple token missing subject');
    }
    const email = typeof payload.email === 'string' ? payload.email : undefined;
    return {
      sub,
      email,
      emailVerified: payload.email_verified === true || payload.email_verified === 'true',
    };
  }
}
