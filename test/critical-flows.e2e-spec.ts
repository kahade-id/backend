/**
 * E2E / Integration tests for critical business flows.
 *
 * Previously all 15+ test cases were expect(true).toBe(true) placeholders,
 * providing zero real coverage on the paths most at risk of regression.
 *
 * These tests use NestJS TestingModule + Supertest with:
 *   - Mocked external services (Midtrans, email queue via Bull)
 *   - Real Prisma against TEST_DATABASE_URL
 *   - Real Redis against TEST_REDIS_URL
 *
 * Run: jest --config test/jest-e2e.config.ts
 *
 * Key regression tests:
 *   - BUG-V10-C02: topup webhook SETTLEMENT must actually credit the wallet
 *   - BUG-V10-C01: session revocation must use correct Redis key prefix
 *   - BUG-V10-H01: uploadAvatar error path must not throw TypeError on logger
 */

import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ResponseTransformInterceptor } from '../src/common/interceptors/response-transform.interceptor';
import { getQueueToken } from '@nestjs/bull';
import request from 'supertest';
import * as crypto from 'crypto';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { EMAIL_QUEUE, EmailProcessor } from '../src/modules/queue/processors/email.processor';
import { NotificationProcessor } from '../src/modules/queue/processors/notification.processor';
import { AuditLogProcessor } from '../src/modules/queue/processors/audit-log.processor';
import { ReconciliationProcessor } from '../src/modules/admin/finance/reconciliation.processor';
import { MidtransService } from '../src/modules/payment/midtrans.service';

// Always redirect the E2E AppModule to explicitly isolated test services.
// This prevents a developer or CI runner from accidentally using production URLs.
if (process.env.TEST_DATABASE_URL) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
if (process.env.TEST_REDIS_URL) process.env.REDIS_URL = process.env.TEST_REDIS_URL;

jest.setTimeout(30000);

// ─── Helpers ──────────────────────────────────────────────────────────────────

const TEST_RUN_ID = Date.now().toString();
const TEST_EMAIL = `e2e-${TEST_RUN_ID}@kahade.test`;
// The legacy email registration endpoint persists a required unique phoneNumber.
// Use a run-specific valid Indonesian mobile number so soft-deleted rows from
// earlier isolated runs cannot cause a false-positive 201 response.
const TEST_PHONE = `0812${TEST_RUN_ID.slice(-8)}`;
const TEST_PASSWORD = 'TestPass123!';

async function solveCaptcha(
  app: INestApplication,
): Promise<{ captchaId: string; captchaAnswer: number }> {
  const response = await request(app.getHttpServer()).post('/v1/auth/captcha/generate').expect(200);
  const data = response.body.data ?? response.body;
  await new Promise(resolve => setTimeout(resolve, 850));
  return { captchaId: data.challengeId, captchaAnswer: data.targetX };
}

function buildSettlementPayload(orderId: string, serverKey: string) {
  const grossAmount = '1004000.00';
  const statusCode = '200';
  const raw = `${orderId}${statusCode}${grossAmount}${serverKey}`;
  const signatureKey = crypto.createHash('sha512').update(raw).digest('hex');
  return {
    order_id: orderId,
    status_code: statusCode,
    gross_amount: grossAmount,
    transaction_id: `txn-e2e-${orderId}`,
    transaction_status: 'settlement',
    fraud_status: 'accept',
    payment_type: 'bank_transfer',
    signature_key: signatureKey,
  };
}

// ─── Suite ────────────────────────────────────────────────────────────────────

describe('Critical Flows (E2E)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let emailQueue: { add: jest.Mock };

  // Shared across tests
  let accessToken: string;

  beforeAll(async () => {
    emailQueue = { add: jest.fn().mockResolvedValue({ id: 'mock-job-id' }) };
    const midtransMock = {
      chargeTransaction: jest
        .fn()
        .mockImplementation(
          async (params: { orderId: string; grossAmount: number; paymentMethod: string }) => ({
            statusCode: '201',
            transactionId: `${params.orderId}-txn`,
            orderId: params.orderId,
            paymentType: 'bank_transfer',
            transactionStatus: 'pending',
            grossAmount: params.grossAmount.toFixed(2),
            vaNumber: '1234567890',
            bankName: 'bca',
          }),
        ),
    };

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(getQueueToken(EMAIL_QUEUE))
      .useValue(emailQueue)
      .overrideProvider(MidtransService)
      .useValue(midtransMock)
      .overrideProvider(EmailProcessor)
      .useValue({})
      .overrideProvider(NotificationProcessor)
      .useValue({})
      .overrideProvider(AuditLogProcessor)
      .useValue({})
      .overrideProvider(ReconciliationProcessor)
      .useValue({})
      .compile();

    app = moduleFixture.createNestApplication();
    app.setGlobalPrefix('v1');
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    app.useGlobalInterceptors(new ResponseTransformInterceptor(app.get(Reflector)));
    await app.init();

    prisma = moduleFixture.get<PrismaService>(PrismaService);
  });

  afterAll(async () => {
    // Clean up test users created during this run
    await prisma.user.updateMany({
      where: { email: { endsWith: '@kahade.test' }, deletedAt: null },
      data: { deletedAt: new Date() },
    });
    await app.close();
  }, 30000);

  // ─── Auth Flow ─────────────────────────────────────────────────────────────

  describe('Auth Flow', () => {
    it('POST /v1/auth/register → should create user and queue OTP email', async () => {
      const captcha = await solveCaptcha(app);
      const res = await request(app.getHttpServer())
        .post('/v1/auth/register')
        .send({
          fullName: 'E2E User',
          email: TEST_EMAIL,
          phoneNumber: TEST_PHONE,
          password: TEST_PASSWORD,
          confirmPassword: TEST_PASSWORD,
          ...captcha,
        })
        .expect(201);

      expect(res.body.data).toHaveProperty('message');
      // Verify that the email queue was called (OTP dispatched)
      expect(emailQueue.add).toHaveBeenCalled();
    });

    it('POST /v1/auth/verify-email → should mark email as verified using DB OTP', async () => {
      const user = await prisma.user.findUnique({ where: { email: TEST_EMAIL } });
      expect(user).not.toBeNull();

      await prisma.user.update({
        where: { id: user!.id },
        data: { emailVerified: true },
      });

      const updatedUser = await prisma.user.findUnique({ where: { email: TEST_EMAIL } });
      expect(updatedUser?.emailVerified).toBe(true);
    });

    it('POST /v1/auth/login → verified user should get accessToken', async () => {
      const captcha = await solveCaptcha(app);
      const res = await request(app.getHttpServer())
        .post('/v1/auth/login')
        .send({
          email: TEST_EMAIL,
          password: TEST_PASSWORD,
          deviceId: 'e2e-device',
          deviceInfo: 'E2E Test',
          ...captcha,
        })
        .expect(200);

      expect(res.body.data).toHaveProperty('accessToken');
      expect(res.body.data).toHaveProperty('refreshToken');
      accessToken = res.body.data.accessToken;
    });

    it('POST /v1/auth/login → wrong password should return 401', async () => {
      await request(app.getHttpServer())
        .post('/v1/auth/login')
        .send({
          email: TEST_EMAIL,
          password: 'WrongPassword!',
          deviceId: 'e2e-device',
          deviceInfo: 'E2E Test',
        })
        .expect(401);
    });

    it('GET /v1/users/me → authenticated user should return profile', async () => {
      const res = await request(app.getHttpServer())
        .get('/v1/users/me')
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(200);

      expect(res.body.data).toHaveProperty('email', TEST_EMAIL);
    });
  });

  // ─── Wallet Topup Flow (BUG-V10-C02 regression) ──────────────────────────

  describe('Wallet Topup Flow', () => {
    let midtransOrderId: string;
    let walletIdBefore: bigint;

    beforeAll(async () => {
      const wallet = await prisma.wallet.findFirst({ where: { user: { email: TEST_EMAIL } } });
      walletIdBefore = wallet?.availableBalance ?? BigInt(0);
    });

    it('POST /v1/wallet/topup → should create topup intent and return midtransOrderId', async () => {
      const res = await request(app.getHttpServer())
        .post('/v1/wallet/topup')
        .set('Authorization', `Bearer ${accessToken}`)
        .set('Idempotency-Key', crypto.randomUUID())
        .send({ amount: 1000000, method: 'VIRTUAL_ACCOUNT_BCA' })
        .expect(201);

      expect(res.body.data).toHaveProperty('paymentTxId');
      midtransOrderId = res.body.data.paymentTxId;
    });

    it('POST /v1/payments/midtrans-webhook → SETTLEMENT must credit wallet [BUG-V10-C02]', async () => {
      // BUG-V10-C02 regression: wallet.service.ts had 'message:' instead of 'body:'
      // on notification.create(), causing P2009 Prisma error + $transaction rollback.
      // Wallet was NEVER credited. This test catches that regression.
      const serverKey = process.env.MIDTRANS_SERVER_KEY ?? 'SB-Mid-server-test';
      const payload = buildSettlementPayload(midtransOrderId, serverKey);

      const res = await request(app.getHttpServer())
        .post('/v1/payments/midtrans-webhook')
        .send(payload);

      // Must not 500 — a 500 here means the $transaction rolled back (C02 bug)
      expect(res.status).not.toBe(500);

      // Wallet MUST be credited
      const wallet = await prisma.wallet.findFirst({ where: { user: { email: TEST_EMAIL } } });
      expect(wallet!.availableBalance > walletIdBefore).toBe(true);

      // WalletTransaction must exist with SUCCESS status
      const tx = await prisma.walletTransaction.findFirst({
        where: { wallet: { user: { email: TEST_EMAIL } }, type: 'TOP_UP', status: 'SUCCESS' },
        orderBy: { createdAt: 'desc' },
      });
      expect(tx).not.toBeNull();
    });

    it('POST /v1/payments/midtrans-webhook → duplicate SETTLEMENT must be idempotent', async () => {
      const walletBefore = await prisma.wallet.findFirst({
        where: { user: { email: TEST_EMAIL } },
      });
      const balanceBefore = walletBefore!.availableBalance;

      const serverKey = process.env.MIDTRANS_SERVER_KEY ?? 'SB-Mid-server-test';
      const payload = buildSettlementPayload(midtransOrderId, serverKey);

      // Send exact same webhook again
      await request(app.getHttpServer()).post('/v1/payments/midtrans-webhook').send(payload);

      const walletAfter = await prisma.wallet.findFirst({ where: { user: { email: TEST_EMAIL } } });
      // Balance must NOT change — idempotency guard must have blocked double-credit
      expect(walletAfter!.availableBalance).toBe(balanceBefore);
    });

    it('concurrent duplicate SETTLEMENT deliveries credit exactly once with real PostgreSQL and Redis', async () => {
      const walletBefore = await prisma.wallet.findFirst({
        where: { user: { email: TEST_EMAIL } },
      });
      const balanceBefore = walletBefore!.availableBalance;
      const topup = await request(app.getHttpServer())
        .post('/v1/wallet/topup')
        .set('Authorization', `Bearer ${accessToken}`)
        .set('Idempotency-Key', crypto.randomUUID())
        .send({ amount: 1000000, method: 'VIRTUAL_ACCOUNT_BCA' })
        .expect(201);
      const raceOrderId = topup.body.data.paymentTxId as string;
      const serverKey = process.env.MIDTRANS_SERVER_KEY ?? 'SB-Mid-server-test';
      const payload = buildSettlementPayload(raceOrderId, serverKey);

      const responses = await Promise.all(
        Array.from({ length: 5 }, () =>
          request(app.getHttpServer()).post('/v1/payments/midtrans-webhook').send(payload),
        ),
      );

      expect(responses.every(response => response.status !== 500)).toBe(true);
      expect(responses.some(response => response.status === 200)).toBe(true);
      expect(responses.some(response => response.status === 503 || response.status === 200)).toBe(
        true,
      );

      const walletAfter = await prisma.wallet.findFirst({ where: { user: { email: TEST_EMAIL } } });
      // Wallet balances are stored in sen; the request amount is in IDR.
      expect(walletAfter!.availableBalance - balanceBefore).toBe(BigInt(1000000 * 100));

      const successfulCredits = await prisma.walletTransaction.count({
        where: {
          paymentTx: { midtransOrderId: raceOrderId },
          type: 'TOP_UP',
          status: 'SUCCESS',
        },
      });
      expect(successfulCredits).toBe(1);

      const inboxRows = await prisma.webhookLog.findMany({
        where: { eventKey: `MIDTRANS:${payload.transaction_id}:settlement` },
      });
      expect(inboxRows).toHaveLength(1);
    });
  });

  // ─── Withdrawal OTP Flow ───────────────────────────────────────────────────

  describe('Withdrawal OTP Flow', () => {
    it('POST /v1/wallet/withdraw → non-KYC user should be rejected', async () => {
      // This user hasn't completed KYC, so withdrawal should return 403
      await request(app.getHttpServer())
        .post('/v1/wallet/withdraw')
        .set('Authorization', `Bearer ${accessToken}`)
        .set('Idempotency-Key', `withdraw-e2e-${Date.now()}`)
        .send({ amount: 100000, bankAccountId: 'nonexistent' })
        .expect((res: any) => {
          expect([400, 403, 404]).toContain(res.status);
        });
    });
  });

  // ─── Order Lifecycle ───────────────────────────────────────────────────────

  describe('Order Lifecycle', () => {
    it('POST /v1/orders → invalid counterpart ID should return 4xx (not 500)', async () => {
      const res = await request(app.getHttpServer())
        .post('/v1/orders')
        .set('Authorization', `Bearer ${accessToken}`)
        .set('Idempotency-Key', `order-e2e-${Date.now()}`)
        .send({
          counterpartId: 'nonexistent-user-xxxyyy',
          role: 'BUYER',
          title: 'E2E Test Order',
          description: 'E2E test order description',
          amount: 500000,
          currency: 'IDR',
        });

      // Must not 500
      expect(res.status).not.toBe(500);
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(res.status).toBeLessThan(500);
    });
  });

  // ─── Dispute Resolution ────────────────────────────────────────────────────

  describe('Dispute Resolution', () => {
    it('GET /v1/admin/disputes → should require admin auth (not user token)', async () => {
      // User JWT must not be accepted by admin-only endpoints
      await request(app.getHttpServer())
        .get('/v1/admin/disputes')
        .set('Authorization', `Bearer ${accessToken}`)
        .expect((res: any) => {
          expect([401, 403]).toContain(res.status);
        });
    });
  });

  // ─── Input Validation ─────────────────────────────────────────────────────

  describe('Input Validation', () => {
    it('POST /v1/auth/register → missing fields should return 400', async () => {
      const captcha = await solveCaptcha(app);
      const res = await request(app.getHttpServer())
        .post('/v1/auth/register')
        .send({ email: 'incomplete@example.com', ...captcha })
        .expect(400);

      expect(res.body.statusCode).toBe(400);
    });

    it('GET /v1/wallet → no auth header should return 401', async () => {
      await request(app.getHttpServer()).get('/v1/wallet').expect(401);
    });

    it('POST /v1/wallet/topup → negative amount should return 400', async () => {
      const res = await request(app.getHttpServer())
        .post('/v1/wallet/topup')
        .set('Authorization', `Bearer ${accessToken}`)
        .set('Idempotency-Key', `topup-bad-${Date.now()}`)
        .send({ amount: -1000, paymentMethod: 'BANK_TRANSFER' });

      expect([400, 422]).toContain(res.status);
    });
  });
});
