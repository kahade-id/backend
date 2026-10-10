import { generateKeyPairSync, createSign, createPublicKey } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { AppleAuthService } from '../apple-auth.service';

/**
 * GAP-A (G009–G011, G025): verifikasi identityToken Apple dengan kunci RSA
 * asli — JWKS fetch/cache, tanda tangan RS256, issuer/audience/expiry,
 * dan pengikatan nonce anti-replay.
 */
describe('AppleAuthService (GAP-A G009–G011)', () => {
  const CLIENT_ID = 'id.kahade.app';
  let service: AppleAuthService;
  let fetchMock: jest.Mock;

  // Kunci RSA nyata untuk JWKS + penandatanganan token uji.
  const { publicKey, privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  const jwk = createPublicKey(publicKey).export({ format: 'jwk' }) as Record<string, unknown>;

  const b64url = (input: string | Buffer): string =>
    Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

  function signToken(payload: Record<string, unknown>, kid = 'test-kid-1', alg = 'RS256'): string {
    const header = b64url(JSON.stringify({ alg, kid, typ: 'JWT' }));
    const body = b64url(JSON.stringify(payload));
    const signer = createSign('RSA-SHA256');
    signer.update(`${header}.${body}`);
    const sig = signer.sign(privateKey);
    return `${header}.${body}.${b64url(sig)}`;
  }

  function validPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    const nowSec = Math.floor(Date.now() / 1000);
    return {
      iss: 'https://appleid.apple.com',
      aud: CLIENT_ID,
      sub: 'apple-sub-123',
      email: 'user@example.com',
      email_verified: 'true',
      iat: nowSec - 10,
      exp: nowSec + 600,
      nonce: 'nonce-abc-123',
      ...overrides,
    };
  }

  beforeEach(() => {
    fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ keys: [{ ...jwk, kid: 'test-kid-1', alg: 'RS256', use: 'sig' }] }),
    });
    (global as any).fetch = fetchMock;
    const configService = { get: jest.fn((key: string) => (key === 'app.appleClientId' ? CLIENT_ID : undefined)) } as unknown as ConfigService;
    service = new AppleAuthService(configService);
  });

  afterEach(() => {
    delete (global as any).fetch;
  });

  it('isConfigured() true bila client id diset (G002)', () => {
    expect(service.isConfigured()).toBe(true);
  });

  it('isConfigured() false bila tidak dikonfigurasi', () => {
    const svc = new AppleAuthService({ get: jest.fn().mockReturnValue(undefined) } as unknown as ConfigService);
    expect(svc.isConfigured()).toBe(false);
  });

  it('memverifikasi token valid dan mengekstrak identitas (G009)', async () => {
    const token = signToken(validPayload());
    const identity = await service.verifyIdentityToken(token, 'nonce-abc-123');
    expect(identity).toEqual({ sub: 'apple-sub-123', email: 'user@example.com', emailVerified: true });
  });

  it('menolak bila nonce tidak cocok — anti replay (G011)', async () => {
    const token = signToken(validPayload({ nonce: 'nonce-abc-123' }));
    await expect(service.verifyIdentityToken(token, 'nonce-OTHER')).rejects.toThrow('nonce mismatch');
  });

  it('menolak bila nonce tidak diberikan (G011)', async () => {
    const token = signToken(validPayload());
    await expect(service.verifyIdentityToken(token)).rejects.toThrow('Nonce is required');
  });

  it('menolak issuer salah', async () => {
    const token = signToken(validPayload({ iss: 'https://evil.example.com' }));
    await expect(service.verifyIdentityToken(token, 'nonce-abc-123')).rejects.toThrow('issuer');
  });

  it('menolak audience salah', async () => {
    const token = signToken(validPayload({ aud: 'com.evil.app' }));
    await expect(service.verifyIdentityToken(token, 'nonce-abc-123')).rejects.toThrow('audience');
  });

  it('menerima audience array yang memuat client id', async () => {
    const token = signToken(validPayload({ aud: ['com.other.app', CLIENT_ID] }));
    const identity = await service.verifyIdentityToken(token, 'nonce-abc-123');
    expect(identity.sub).toBe('apple-sub-123');
  });

  it('menolak token kedaluwarsa', async () => {
    const token = signToken(validPayload({ exp: Math.floor(Date.now() / 1000) - 10 }));
    await expect(service.verifyIdentityToken(token, 'nonce-abc-123')).rejects.toThrow('expired');
  });

  it('menolak kid yang tidak ada di JWKS', async () => {
    const token = signToken(validPayload(), 'unknown-kid');
    await expect(service.verifyIdentityToken(token, 'nonce-abc-123')).rejects.toThrow('signing key not found');
  });

  it('menolak tanda tangan yang dirusak', async () => {
    const token = signToken(validPayload());
    const parts = token.split('.');
    const tamperedSig = parts[2].slice(0, -2) + (parts[2].slice(-2) === 'ab' ? 'cd' : 'ab');
    await expect(service.verifyIdentityToken(`${parts[0]}.${parts[1]}.${tamperedSig}`, 'nonce-abc-123')).rejects.toThrow(
      'signature',
    );
  });

  it('menolak token malformed', async () => {
    await expect(service.verifyIdentityToken('not.a.jwt.at.all', 'nonce-abc-123')).rejects.toThrow();
    await expect(service.verifyIdentityToken('onlyonepart', 'nonce-abc-123')).rejects.toThrow('Malformed');
  });

  it('menolak alg non-RS256', async () => {
    const token = signToken(validPayload(), 'test-kid-1', 'HS256');
    await expect(service.verifyIdentityToken(token, 'nonce-abc-123')).rejects.toThrow('algorithm');
  });

  it('kid tak dikenal → refetch JWKS sekali, lalu verifikasi dengan kunci baru (BE-47)', async () => {
    // Isi cache dengan kunci lama.
    await service.verifyIdentityToken(signToken(validPayload()), 'nonce-abc-123');
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Apple merotasi kunci: JWKS kini memuat kid baru.
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ keys: [{ ...jwk, kid: 'rotated-kid', alg: 'RS256', use: 'sig' }] }),
    });
    const rotated = await service.verifyIdentityToken(signToken(validPayload(), 'rotated-kid'), 'nonce-abc-123');
    expect(rotated.sub).toBeDefined();
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // kid palsu berikutnya dalam 60 d TIDAK memicu fetch lagi (anti-DoS JWKS).
    await expect(service.verifyIdentityToken(signToken(validPayload(), 'bogus-kid'), 'nonce-abc-123')).rejects.toThrow(
      'signing key not found',
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('cache JWKS: fetch hanya sekali untuk dua verifikasi (G010)', async () => {
    const token = signToken(validPayload());
    await service.verifyIdentityToken(token, 'nonce-abc-123');
    await service.verifyIdentityToken(token, 'nonce-abc-123');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('melempar bila Apple belum dikonfigurasi', async () => {
    const svc = new AppleAuthService({ get: jest.fn().mockReturnValue(undefined) } as unknown as ConfigService);
    await expect(svc.verifyIdentityToken(signToken(validPayload()), 'nonce-abc-123')).rejects.toThrow(
      'not configured',
    );
  });
});
