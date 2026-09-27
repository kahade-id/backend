/**
 * DI smoke check: compile AppModule dengan env dummy yang lolos validasi
 * ConfigModule. Dipakai untuk verifikasi DI penuh setelah audit-fix Etalase.
 */
// Env dummy — di-set sebelum AppModule dievaluasi; validasi ConfigModule
// berjalan saat compile(), sehingga process.env di sini cukup.
process.env.DATABASE_URL ??= 'postgresql://user:password@localhost:5432/kahade_test';
process.env.REDIS_URL ??= 'redis://localhost:6379';
process.env.BULL_REDIS_URL ??= 'redis://localhost:6379';
process.env.JWT_SECRET ??= 'super-secret-jwt-key-32chars-min';
process.env.JWT_REFRESH_SECRET ??= 'super-secret-refresh-jwt-key-32chars';
process.env.JWT_ADMIN_SECRET ??= 'super-secret-admin-jwt-key-32chars';
process.env.JWT_ADMIN_REFRESH_SECRET ??= 'super-secret-admin-refresh-jwt-32c';
process.env.JWT_TEMP_SECRET ??= 'super-secret-temp-jwt-key-32chars';
process.env.AES_SECRET_KEY ??= 'a0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1';
process.env.HMAC_SECRET_KEY ??= 'f0e1d2c3b4a5f6e7d8c9b0a1f2e3d4c5b6a7f8e9d0c1b2a3f4e5d6c7b8a9f0e1';
process.env.AES_KDF_SALT ??= 'kdf-salt-value-32-characters-min';
process.env.WALLET_PIN_PEPPER ??= 'wallet-pin-pepper-value-at-least-32-chars-long';
process.env.MIDTRANS_SERVER_KEY ??= 'SB-Mid-server-test-key';
process.env.MIDTRANS_CLIENT_KEY ??= 'SB-Mid-client-test-key';
process.env.MIDTRANS_IRIS_KEY ??= 'Iris-test-key';
process.env.R2_ACCESS_KEY_ID ??= 'test-r2-access-key-id';
process.env.R2_SECRET_ACCESS_KEY ??= 'test-r2-secret-access-key';
process.env.R2_ACCOUNT_ID ??= 'test-account-id';
process.env.R2_BUCKET_PUBLIC ??= 'kahade-uploads-public';
process.env.R2_BUCKET_PRIVATE ??= 'kahade-uploads-private';
process.env.SMTP_HOST ??= 'smtp.example.com';
process.env.SMTP_PORT ??= '587';
process.env.SMTP_USER ??= 'noreply@kahade.id';
process.env.SMTP_PASS ??= 'smtp-password';
process.env.SMTP_FROM ??= 'Kahade <noreply@kahade.id>';

import { Test } from '@nestjs/testing';
import { AppModule } from './app.module';

describe('AppModule DI compile (audit-fix Etalase)', () => {
  it('mengompilasi dependency injection penuh tanpa error', async () => {
    // compile() saja (tanpa init): DI resolution terjadi saat compile.
    // init() di-skip agar tidak membuka koneksi DB/Redis lokal yang tidak ada.
    const module = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    expect(module).toBeDefined();
  }, 120000);
});
