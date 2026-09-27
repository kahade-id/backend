import { initializeCrypto } from '../../utils/crypto.util';
import {
  OTP_COOLDOWN,
  OTP_PHONE_RATE,
  OTP_EMAIL_RATE,
  OTP_TRIGGER_COOLDOWN,
  OTP_TRIGGER_PHONE_RATE,
} from '../redis-keys';

describe('SEC-303: HMAC Redis keys untuk identifier PII OTP', () => {
  beforeEach(() => {
    initializeCrypto({
      aesSecretKey: 'test-aes-secret-key-min-32-chars-ok',
      hmacSecretKey: 'test-hmac-secret-key-min-32-chars-ok',
    });
  });

  const families: Array<[string, (id: string) => string]> = [
    ['OTP_COOLDOWN', (id) => OTP_COOLDOWN(id, 'LOGIN')],
    ['OTP_PHONE_RATE', (id) => OTP_PHONE_RATE(id, 'LOGIN')],
    ['OTP_EMAIL_RATE', (id) => OTP_EMAIL_RATE(id, 'LOGIN')],
    ['OTP_TRIGGER_COOLDOWN', (id) => OTP_TRIGGER_COOLDOWN(id, 'LOGIN')],
    ['OTP_TRIGGER_PHONE_RATE', (id) => OTP_TRIGGER_PHONE_RATE(id)],
  ];

  it.each(families)('%s deterministik untuk identifier yang sama', (_name, build) => {
    expect(build('+6281234567890')).toBe(build('+6281234567890'));
  });

  it.each(families)('%s tidak memuat phone/email plaintext', (_name, build) => {
    const phone = '+6281234567890';
    const email = 'korban@example.com';
    expect(build(phone)).not.toContain(phone);
    expect(build(phone)).not.toContain('6281234567890');
    expect(build(email)).not.toContain(email);
    expect(build(email)).not.toContain('korban');
  });

  it.each(families)('%s: identifier berbeda menghasilkan key berbeda', (_name, build) => {
    expect(build('+6281234567890')).not.toBe(build('+6289876543210'));
  });

  it('domain separation: identifier sama di family berbeda menghasilkan key berbeda', () => {
    const id = '+6281234567890';
    const keys = new Set([
      OTP_COOLDOWN(id, 'LOGIN'),
      OTP_PHONE_RATE(id, 'LOGIN'),
      OTP_TRIGGER_COOLDOWN(id, 'LOGIN'),
      OTP_TRIGGER_PHONE_RATE(id),
    ]);
    expect(keys.size).toBe(4);
  });

  it('key tetap diawali prefix family agar mudah dikenali di Redis', () => {
    expect(OTP_COOLDOWN('x', 'LOGIN')).toMatch(/^otp_cooldown:[0-9a-f]{64}:LOGIN$/);
    expect(OTP_PHONE_RATE('x', 'LOGIN')).toMatch(/^otp_phone_rate:[0-9a-f]{64}:LOGIN$/);
    expect(OTP_EMAIL_RATE('x', 'LOGIN')).toMatch(/^otp_email_rate:[0-9a-f]{64}:LOGIN$/);
    expect(OTP_TRIGGER_COOLDOWN('x', 'LOGIN')).toMatch(/^otp_trigger_cooldown:[0-9a-f]{64}:LOGIN$/);
    expect(OTP_TRIGGER_PHONE_RATE('x')).toMatch(/^otp_trigger_phone_rate:[0-9a-f]{64}$/);
  });

  it('whitespace di sekitar identifier dinormalisasi', () => {
    expect(OTP_PHONE_RATE('  +6281234567890  ', 'LOGIN')).toBe(
      OTP_PHONE_RATE('+6281234567890', 'LOGIN'),
    );
  });
});
