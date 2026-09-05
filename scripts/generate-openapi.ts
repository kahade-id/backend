/**
 * Generate openapi.json by booting AppModule (without starting an HTTP server)
 * and serializing the Swagger document. Output goes to <repo-root>/openapi.json.
 *
 * Usage:
 *   npm run openapi:generate
 *
 * Env requirements: same vars validated by src/config/env.validation.ts. The
 * script applies CI-style deterministic stubs for any missing var so that
 * generation works in fresh clones / CI without real secrets, but never
 * overwrites a value the developer has already set.
 *
 * Frontends consume the resulting openapi.json via openapi-typescript / @hey-api
 * to generate typed SDKs (audit items C9 + B61).
 */

// Env stubs MUST be applied before importing AppModule, because module
// instantiation runs env.validation.ts at top-level imports.
const STUBS: Record<string, string> = {
  NODE_ENV: 'development',
  OPENAPI_GENERATE: 'true',
  PORT: '3000',
  DATABASE_URL: 'postgresql://kahade:kahade@localhost:5432/kahade_db',
  REDIS_URL: 'redis://localhost:6379',
  BULL_REDIS_URL: 'redis://localhost:6379',
  JWT_SECRET: 'openapi-stub-jwt-secret-deterministic-32chrs',
  JWT_REFRESH_SECRET: 'openapi-stub-jwt-refresh-secret-deterministic',
  JWT_ADMIN_SECRET: 'openapi-stub-jwt-admin-secret-deterministic-',
  JWT_ADMIN_REFRESH_SECRET: 'openapi-stub-jwt-admin-refresh-secret-determ',
  JWT_TEMP_SECRET: 'openapi-stub-jwt-temp-secret-deterministic-3',
  AES_SECRET_KEY: '0'.repeat(63) + '1',
  HMAC_SECRET_KEY: '0'.repeat(63) + '2',
  AES_KDF_SALT: '0'.repeat(31) + '3',
  WALLET_PIN_PEPPER: 'openapi-stub-wallet-pin-pepper-deterministic',
  R2_ACCESS_KEY_ID: 'stub-r2-access-key-id',
  R2_SECRET_ACCESS_KEY: 'stub-r2-secret-access-key',
  R2_ACCOUNT_ID: 'stub-r2-account-id',
  R2_BUCKET_PUBLIC: 'kahade-uploads-public',
  R2_BUCKET_PRIVATE: 'kahade-uploads-private',
  R2_PUBLIC_URL: 'https://stub.example.invalid',
  SMTP_HOST: 'smtp.example.com',
  SMTP_PORT: '587',
  SMTP_USER: 'noreply@kahade.id',
  SMTP_PASS: 'stub-smtp-password',
  SMTP_FROM: 'Kahade <noreply@kahade.id>',
  OTP_PROVIDER: 'mock',
};
for (const [k, v] of Object.entries(STUBS)) {
  if (!process.env[k]) process.env[k] = v;
}

import { writeFileSync } from 'fs';
import { join } from 'path';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';

import { AppModule } from '../src/app.module';

async function main(): Promise<void> {
  // Use a quiet logger so the JSON output isn't drowned by Nest's banner, but
  // keep error/warn so we still see real failures during generation.
  const app = await NestFactory.create(AppModule, {
    logger: ['warn', 'error'],
  });
  await app.init();

  // Match the global prefix used by src/main.ts so generated paths match what
  // a real client hits at runtime (e.g. /v1/auth/login, not /auth/login).
  // SwaggerModule.createDocument applies this prefix to every path key.
  const apiPrefix = process.env.API_PREFIX || 'v1';
  app.setGlobalPrefix(apiPrefix);

  const config = new DocumentBuilder()
    .setTitle('Kahade API')
    .setDescription('PT Kawal Hak Dengan Aman — Platform Escrow P2C Indonesia')
    .setVersion('1.0')
    .addBearerAuth(
      { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
      'access-token',
    )
    .addCookieAuth('refresh_token', {
      type: 'apiKey',
      in: 'cookie',
      name: 'kahade_refresh_token',
    })
    .addTag('auth', 'Authentication & Authorization')
    .addTag('users', 'User Profile & Stats')
    .addTag('wallet', 'Wallet & Transactions')
    .addTag('orders', 'Escrow Orders')
    .addTag('payments', 'Payment Webhooks')
    .addTag('health', 'Health Checks')
    .build();

  const document = SwaggerModule.createDocument(app, config);
  const outPath = join(process.cwd(), 'openapi.json');
  writeFileSync(outPath, JSON.stringify(document, null, 2) + '\n');

  const pathCount = Object.keys(document.paths ?? {}).length;
  const schemaCount = Object.keys(document.components?.schemas ?? {}).length;
  // eslint-disable-next-line no-console
  console.log(
    `[openapi] wrote ${outPath} (${pathCount} paths, ${schemaCount} schemas)`,
  );

  if (process.env.OPENAPI_GENERATE === 'true') {
    process.exit(0);
  }
  await app.close();
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[openapi] generation failed:', err);
  process.exit(1);
});
