process.env.DATABASE_URL ??= 'postgresql://u:p@localhost:5432/db';
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
import { Test } from '@nestjs/testing';
import { ShowcaseModule } from '../showcase.module';
import { UsersModule } from '../../users/users.module';
import { HighlightsController } from '../highlights/highlights.controller';
import { HighlightsService } from '../highlights/highlights.service';

describe('DI wiring TIM A', () => {
  it('ShowcaseModule menyediakan HighlightsService + HighlightsController', async () => {
    const module = await Test.createTestingModule({ imports: [ShowcaseModule] }).compile();
    expect(module.get(HighlightsService)).toBeDefined();
    expect(module.get(HighlightsController)).toBeDefined();
  }, 60000);
  it('UsersModule dapat menginject HighlightsService ke UsersController', async () => {
    const module = await Test.createTestingModule({ imports: [UsersModule] }).compile();
    expect(module.get(HighlightsService)).toBeDefined();
  }, 60000);
});
