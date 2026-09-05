import { validateEnv } from './env.validation';

describe('validateEnv', () => {
  const baseEnv: Record<string, string> = {
    DATABASE_URL: 'postgresql://user:pass@localhost:5432/kahade',
    REDIS_URL: 'redis://localhost:6379',
    BULL_REDIS_URL: 'redis://localhost:6379',
    JWT_SECRET: 'super-secret-jwt-key-32chars-min',
    JWT_REFRESH_SECRET: 'super-secret-refresh-key-32chars',
    JWT_ADMIN_SECRET: 'super-secret-admin-key-32chars-m',
    JWT_ADMIN_REFRESH_SECRET: 'super-secret-admin-refresh-key-32c',
    JWT_TEMP_SECRET: 'super-secret-temp-key-32chars-min',
    AES_SECRET_KEY: 'a0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1',
    HMAC_SECRET_KEY: 'f0e1d2c3b4a5f6e7d8c9b0a1f2e3d4c5b6a7f8e9d0c1b2a3f4e5d6c7b8a9f0e1',
    AES_KDF_SALT: 'kdf-salt-value-32-characters-min',
    WALLET_PIN_PEPPER: 'wallet-pin-pepper-value-at-least-32-chars-long',
    MIDTRANS_SERVER_KEY: 'SB-Mid-server-test-key',
    MIDTRANS_CLIENT_KEY: 'SB-Mid-client-test-key',
    MIDTRANS_IRIS_KEY: 'Iris-test-key',
    R2_ACCESS_KEY_ID: 'test-r2-access-key-id',
    R2_SECRET_ACCESS_KEY: 'test-r2-secret-access-key',
    R2_ACCOUNT_ID: 'test-account-id',
    R2_BUCKET_PUBLIC: 'kahade-uploads-public',
    R2_BUCKET_PRIVATE: 'kahade-uploads-private',
    SMTP_HOST: 'smtp.example.com',
    SMTP_PORT: '587',
    SMTP_USER: 'noreply@kahade.id',
    SMTP_PASS: 'smtp-password',
    SMTP_FROM: 'Kahade <noreply@kahade.id>',
  };

  it('returns the env object unchanged when all required vars are valid', () => {
    const result = validateEnv({ ...baseEnv });
    expect(result).toMatchObject(baseEnv);
  });

  it('throws when a required variable is missing', () => {
    const env = { ...baseEnv };
    delete env['DATABASE_URL'];
    expect(() => validateEnv(env)).toThrow('DATABASE_URL is required but missing or empty');
  });

  it('throws when REDIS_URL is missing', () => {
    const env = { ...baseEnv };
    delete env['REDIS_URL'];
    expect(() => validateEnv(env)).toThrow('REDIS_URL');
  });

  it('throws when JWT_SECRET is empty string', () => {
    const env = { ...baseEnv, JWT_SECRET: '' };
    expect(() => validateEnv(env)).toThrow('JWT_SECRET');
  });

  it('throws when SMTP_PORT is out of range', () => {
    const env = { ...baseEnv, SMTP_PORT: '70000' };
    expect(() => validateEnv(env)).toThrow('SMTP_PORT');
  });

  it('throws when SMTP_PORT is not a number', () => {
    const env = { ...baseEnv, SMTP_PORT: 'not-a-port' };
    expect(() => validateEnv(env)).toThrow('SMTP_PORT');
  });

  it('throws when KAHADE_FEE_RATE is out of range (> 10)', () => {
    const env = { ...baseEnv, KAHADE_FEE_RATE: '11' };
    expect(() => validateEnv(env)).toThrow('KAHADE_FEE_RATE');
  });

  it('accepts KAHADE_FEE_RATE = 0 (zero fee)', () => {
    const env = { ...baseEnv, KAHADE_FEE_RATE: '0' };
    expect(() => validateEnv(env)).not.toThrow();
  });

  it('accepts KAHADE_FEE_RATE = 2.5 (default)', () => {
    const env = { ...baseEnv, KAHADE_FEE_RATE: '2.5' };
    expect(() => validateEnv(env)).not.toThrow();
  });

  it('throws when ORDER_MIN_VALUE is below minimum', () => {
    const env = { ...baseEnv, ORDER_MIN_VALUE: '100' };
    expect(() => validateEnv(env)).toThrow('ORDER_MIN_VALUE');
  });

  it('throws when MIDTRANS_API_URL is not a valid URL', () => {
    const env = { ...baseEnv, MIDTRANS_API_URL: 'not-a-url' };
    expect(() => validateEnv(env)).toThrow('MIDTRANS_API_URL');
  });

  it('accepts MIDTRANS_API_URL as a valid https URL', () => {
    const env = { ...baseEnv, MIDTRANS_API_URL: 'https://api.sandbox.midtrans.com' };
    expect(() => validateEnv(env)).not.toThrow();
  });

  it('throws NODE_ENV rejection for unknown env names', () => {
    const env = { ...baseEnv, NODE_ENV: 'unknown-env' };
    expect(() => validateEnv(env)).toThrow('NODE_ENV');
  });

  it('throws multiple errors at once and lists all invalid vars', () => {
    const env: Record<string, string> = {
      ...baseEnv,
      SMTP_PORT: '99999',
      KAHADE_FEE_RATE: '50',
      ORDER_MIN_VALUE: '50',
    };
    expect(() => validateEnv(env)).toThrow(/SMTP_PORT/);
  });

  it('accepts optional vars being absent entirely', () => {
    const minimalEnv = { ...baseEnv };
    delete minimalEnv['SMTP_PORT'];
    delete minimalEnv['KAHADE_FEE_RATE'];
    delete minimalEnv['NODE_ENV'];
    expect(() => validateEnv(minimalEnv)).not.toThrow();
  });

  it('throws when CORS_ORIGINS is missing in production', () => {
    const env: Record<string, string> = { ...baseEnv, NODE_ENV: 'production' };
    delete env['CORS_ORIGINS'];
    expect(() => validateEnv(env)).toThrow('CORS_ORIGINS');
  });

  it('requires a valid R2 public URL in production so public media remains renderable', () => {
    const env: Record<string, string> = { ...baseEnv, NODE_ENV: 'production', CORS_ORIGINS: 'https://kahade.id', MIDTRANS_ALLOWED_CIDRS: '103.20.51.0/24', OTP_PROVIDER: 'fonnte', FONNTE_API_TOKEN: 'test-token' };
    expect(() => validateEnv(env)).toThrow('R2_PUBLIC_URL');
    env.R2_PUBLIC_URL = 'not-a-url';
    expect(() => validateEnv(env)).toThrow('R2_PUBLIC_URL');
    env.R2_PUBLIC_URL = 'https://cdn.kahade.id';
    expect(() => validateEnv(env)).not.toThrow();
  });

  it('does not throw when CORS_ORIGINS is absent in development', () => {
    const env: Record<string, string> = { ...baseEnv, NODE_ENV: 'development' };
    delete env['CORS_ORIGINS'];
    expect(() => validateEnv(env)).not.toThrow();
  });

  it.each(['REDIS_AUTH_FAIL_OPEN', 'IDEMPOTENCY_FAIL_OPEN'])('rejects %s=true in production', (key) => {
    const env: Record<string, string> = {
      ...baseEnv,
      NODE_ENV: 'production',
      CORS_ORIGINS: 'https://app.kahade.id',
      MIDTRANS_ALLOWED_CIDRS: '0.0.0.0/0',
      [key]: 'true',
    };
    expect(() => validateEnv(env)).toThrow(`${key} must be false in production`);
  });

  it.each(['REDIS_AUTH_FAIL_OPEN', 'IDEMPOTENCY_FAIL_OPEN'])('rejects invalid boolean value for %s', (key) => {
    const env: Record<string, string> = { ...baseEnv, [key]: 'enabled' };
    expect(() => validateEnv(env)).toThrow(`${key} must be exactly "true" or "false"`);
  });

  it('accepts explicit false fail-open flags in production', () => {
    const env: Record<string, string> = {
      ...baseEnv,
      NODE_ENV: 'production',
      CORS_ORIGINS: 'https://app.kahade.id',
      MIDTRANS_ALLOWED_CIDRS: '0.0.0.0/0',
      R2_PUBLIC_URL: 'https://cdn.kahade.id',
      OTP_PROVIDER: 'fonnte',
      FONNTE_API_TOKEN: 'test-fonnte-token',
      REDIS_AUTH_FAIL_OPEN: 'false',
      IDEMPOTENCY_FAIL_OPEN: 'false',
    };
    expect(() => validateEnv(env)).not.toThrow();
  });

  it.each([
    ['*', 'wildcard'],
    ['http://app.kahade.id', 'insecure'],
    ['https://localhost:3000', 'localhost'],
  ])('rejects %s CORS origin in production (%s)', (origin) => {
    const env: Record<string, string> = {
      ...baseEnv,
      NODE_ENV: 'production',
      CORS_ORIGINS: origin,
      MIDTRANS_ALLOWED_CIDRS: '0.0.0.0/0',
      OTP_PROVIDER: 'fonnte',
      FONNTE_API_TOKEN: 'test-fonnte-token',
      REDIS_AUTH_FAIL_OPEN: 'false',
      IDEMPOTENCY_FAIL_OPEN: 'false',
    };
    expect(() => validateEnv(env)).toThrow('CORS_ORIGINS');
  });
});
