/**
 * Unit tests for crypto.util.ts — encrypt/decrypt roundtrip,
 * HMAC determinism, and bcrypt operations.
 *
 * These tests run without a real database or Redis.
 */

// Initialize crypto with test values before importing
process.env.AES_SECRET_KEY = '0'.repeat(64);
process.env.AES_KDF_SALT = 'test-kdf-salt-unit-tests-only';
process.env.HMAC_SECRET_KEY = '1'.repeat(64);

import { initializeCrypto, encryptAES, decryptAES, hmacSHA256, bcryptHash, bcryptCompare, sha256 } from './crypto.util';

beforeAll(() => {
  initializeCrypto({
    aesSecretKey: '0'.repeat(64),
    aesKdfSalt: 'test-kdf-salt-unit-tests-only',
    hmacSecretKey: '1'.repeat(64),
  });
});

describe('AES-256-GCM Encryption', () => {
  const testCases = [
    { name: 'NIK number', plaintext: '3201234567890001' },
    { name: 'Bank account', plaintext: '1234567890' },
    { name: 'Unicode string', plaintext: 'Jalan Merdeka No. 1, Jakarta' },
    { name: 'Empty string', plaintext: '' },
  ];

  for (const { name, plaintext } of testCases) {
    it(`should encrypt and decrypt ${name} correctly (roundtrip)`, async () => {
      const encrypted = await encryptAES(plaintext);
      expect(encrypted).not.toBe(plaintext);
      expect(typeof encrypted).toBe('string');

      const decrypted = await decryptAES(encrypted);
      expect(decrypted).toBe(plaintext);
    });
  }

  it('should produce different ciphertext for same plaintext (random IV)', async () => {
    const plaintext = '3201234567890001';
    const cipher1 = await encryptAES(plaintext);
    const cipher2 = await encryptAES(plaintext);
    // Random IV means two encryptions of same plaintext differ
    expect(cipher1).not.toBe(cipher2);
  });

  it('should throw on tampered ciphertext (GCM auth tag validation)', async () => {
    const encrypted = await encryptAES('test');
    const tampered = encrypted.slice(0, -4) + 'XXXX';
    await expect(decryptAES(tampered)).rejects.toThrow();
  });
});

describe('HMAC-SHA256 (deterministic)', () => {
  it('should produce same hash for same input', () => {
    const hash1 = hmacSHA256('1234567890');
    const hash2 = hmacSHA256('1234567890');
    expect(hash1).toBe(hash2);
  });

  it('should produce different hashes for different inputs', () => {
    expect(hmacSHA256('abc')).not.toBe(hmacSHA256('xyz'));
  });

  it('should return a hex string of length 64', () => {
    const hash = hmacSHA256('test');
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('SHA-256', () => {
  it('should produce deterministic 64-char hex hash', () => {
    const hash = sha256('hello world');
    expect(hash).toBe(sha256('hello world'));
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('bcrypt', () => {
  it('should hash and verify password correctly', async () => {
    const password = 'Kahade@Secure123!';
    const hash = await bcryptHash(password, 10); // use 10 rounds for test speed
    expect(await bcryptCompare(password, hash)).toBe(true);
    expect(await bcryptCompare('WrongPassword', hash)).toBe(false);
  });

  it('should produce different hashes for same password (random salt)', async () => {
    const hash1 = await bcryptHash('samepassword', 10);
    const hash2 = await bcryptHash('samepassword', 10);
    expect(hash1).not.toBe(hash2);
  });
});
