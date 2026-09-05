import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { SanitizeBodyPipe } from '../../common/pipes/sanitize-body.pipe';
import { PaymentController } from './payment.controller';
import { PaymentService } from './payment.service';

/*
 * PAY-021 regression.
 *
 * The webhook body used to be typed as `@Body() n: MidtransNotificationDto`, which
 * handed it to the *global* ValidationPipe (whitelist + forbidNonWhitelisted). A real
 * Midtrans notification carries many fields the DTO does not declare, so every genuine
 * webhook was rejected with 400 — no wallet credit, and no WebhookLog row either,
 * because the pipe throws before the controller runs.
 *
 * The old e2e fixture missed it by building its payload from the DTO's own field list.
 * These tests mount the controller behind the same global pipe chain as main.ts and post
 * the payload Midtrans actually sends, so the failure mode is reproducible here.
 */

// Shape of a settled bank-transfer charge, per Midtrans notification docs.
function realMidtransSettlementPayload(): Record<string, unknown> {
  return {
    transaction_time: '2026-08-07 06:12:03',
    transaction_status: 'settlement',
    transaction_id: '9aed5972-5b6a-401e-894b-a32c91ed1a3a',
    status_message: 'midtrans payment notification',
    status_code: '200',
    signature_key: 'a'.repeat(128),
    settlement_time: '2026-08-07 06:12:40',
    payment_type: 'bank_transfer',
    order_id: 'PAY-20260807-000001',
    merchant_id: 'G123456789',
    gross_amount: '1000000.00',
    fraud_status: 'accept',
    currency: 'IDR',
    va_numbers: [{ bank: 'bca', va_number: '12345678901' }],
    payment_amounts: [],
    expiry_time: '2026-08-08 06:12:03',
  };
}

const WEBHOOK_PATH = '/payments/midtrans-webhook';

describe('PaymentController — Midtrans webhook body handling', () => {
  let app: INestApplication;
  let handleMidtransWebhook: jest.Mock;

  beforeEach(async () => {
    handleMidtransWebhook = jest.fn().mockResolvedValue({ message: 'OK' });

    const moduleFixture: TestingModule = await Test.createTestingModule({
      controllers: [PaymentController],
      providers: [{ provide: PaymentService, useValue: { handleMidtransWebhook } }],
    }).compile();

    app = moduleFixture.createNestApplication();
    // Mirrors main.ts exactly — this is the chain that used to reject the webhook.
    app.useGlobalPipes(
      new SanitizeBodyPipe(),
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
        transformOptions: { enableImplicitConversion: false },
      }),
    );
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  it('accepts a real Midtrans payload carrying fields beyond the DTO', async () => {
    await request(app.getHttpServer())
      .post(WEBHOOK_PATH)
      .send(realMidtransSettlementPayload())
      .expect(200, { message: 'OK' });

    expect(handleMidtransWebhook).toHaveBeenCalledTimes(1);
  });

  it('forwards undeclared fields so WebhookLog keeps a complete audit trail', async () => {
    await request(app.getHttpServer()).post(WEBHOOK_PATH).send(realMidtransSettlementPayload()).expect(200);

    // payment.service.ts persists this object as WebhookLog.payload.
    const forwarded = handleMidtransWebhook.mock.calls[0][0] as Record<string, unknown>;
    expect(forwarded.merchant_id).toBe('G123456789');
    expect(forwarded.settlement_time).toBe('2026-08-07 06:12:40');
    expect(forwarded.currency).toBe('IDR');
    expect(forwarded.va_numbers).toEqual([{ bank: 'bca', va_number: '12345678901' }]);
    // ...alongside the ones it does declare.
    expect(forwarded.order_id).toBe('PAY-20260807-000001');
    expect(forwarded.transaction_status).toBe('settlement');
  });

  it.each([
    'order_id',
    'status_code',
    'gross_amount',
    'signature_key',
    'transaction_status',
    'transaction_id',
  ])('rejects a payload missing required field %s', async (field) => {
    const payload = realMidtransSettlementPayload();
    delete payload[field];

    await request(app.getHttpServer()).post(WEBHOOK_PATH).send(payload).expect(400);
    expect(handleMidtransWebhook).not.toHaveBeenCalled();
  });

  it('rejects a required field of the wrong type', async () => {
    await request(app.getHttpServer())
      .post(WEBHOOK_PATH)
      .send({ ...realMidtransSettlementPayload(), order_id: { nested: 'object' } })
      .expect(400);

    expect(handleMidtransWebhook).not.toHaveBeenCalled();
  });

  it('rejects an empty body rather than passing it to the service', async () => {
    await request(app.getHttpServer()).post(WEBHOOK_PATH).send({}).expect(400);
    expect(handleMidtransWebhook).not.toHaveBeenCalled();
  });

  it('rejects an over-long required field', async () => {
    await request(app.getHttpServer())
      .post(WEBHOOK_PATH)
      .send({ ...realMidtransSettlementPayload(), order_id: 'x'.repeat(256) })
      .expect(400);

    expect(handleMidtransWebhook).not.toHaveBeenCalled();
  });

  it.each([
    { status_code: '20x', gross_amount: '1000000.00' },
    { status_code: '200', gross_amount: '-1.00' },
    { status_code: '200', gross_amount: '1000000.999' },
  ])('rejects malformed payment amount/status format', async (override) => {
    await request(app.getHttpServer())
      .post(WEBHOOK_PATH)
      .send({ ...realMidtransSettlementPayload(), ...override })
      .expect(400);

    expect(handleMidtransWebhook).not.toHaveBeenCalled();
  });

  it('still applies body sanitization to the forwarded payload', async () => {
    await request(app.getHttpServer())
      .post(WEBHOOK_PATH)
      .send({ ...realMidtransSettlementPayload(), status_message: '<script>alert(1)</script>ok' })
      .expect(200);

    const forwarded = handleMidtransWebhook.mock.calls[0][0] as Record<string, unknown>;
    expect(forwarded.status_message).toBe('ok');
  });
});
