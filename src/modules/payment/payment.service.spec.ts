import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { ServiceUnavailableException } from '@nestjs/common';
import { createHash } from 'crypto';
import { PaymentService } from './payment.service';
import { WalletService } from '../wallet/wallet.service';
import { OrderQrisPaymentService } from './order-qris-payment.service';
import { PrismaService } from '../../prisma/prisma.service';
import { RedisService } from '../../redis/redis.service';

const mockConfig = {
  get: jest.fn((key: string) => {
    const config: Record<string, unknown> = {
      'midtrans.serverKey': 'SB-Mid-server-TEST_KEY_12345',
      'midtrans.allowedCidrs': '',
      'midtrans.bypassIpCheck': false,
      'app.nodeEnv': 'test',
    };
    return config[key];
  }),
};

const mockPrisma = {
  paymentTransaction: { findFirst: jest.fn(), update: jest.fn(), updateMany: jest.fn() },
  webhookLog: { upsert: jest.fn(), update: jest.fn() },
};

const mockWalletService = {
  handleTopupSuccess: jest.fn(),
  handleTopupFailure: jest.fn(),
};

const mockOrderQrisPaymentService = {
  handleSettlement: jest.fn(),
  handleFailure: jest.fn(),
  handleRefund: jest.fn(),
};

const mockRedis = {
  get: jest.fn(),
  setNx: jest.fn(),
  setex: jest.fn(),
  del: jest.fn(),
  releaseLock: jest.fn(),
};

describe('PaymentService', () => {
  let service: PaymentService;

  beforeEach(() => {
    jest.clearAllMocks();
    mockConfig.get.mockImplementation((key: string) => {
      const config: Record<string, unknown> = {
        'midtrans.serverKey': 'SB-Mid-server-TEST_KEY_12345',
        'midtrans.allowedCidrs': '',
        'midtrans.bypassIpCheck': false,
        'app.nodeEnv': 'test',
      };
      return config[key];
    });
    mockRedis.setNx.mockResolvedValue(true);
    mockRedis.get.mockResolvedValue(null);
    mockRedis.setex.mockResolvedValue(undefined);
    mockRedis.del.mockResolvedValue(undefined);
    mockRedis.releaseLock.mockResolvedValue(true);
    mockPrisma.webhookLog.upsert.mockResolvedValue({
      id: 'webhook-1',
      isProcessed: false,
      retryCount: 0,
      deadLetteredAt: null,
    });
    mockPrisma.webhookLog.update.mockResolvedValue({ id: 'webhook-1', isProcessed: true });
    mockPrisma.paymentTransaction.findFirst.mockResolvedValue({
      id: 'payment-1',
      userId: 'user-1',
      orderId: null,
      status: 'PENDING',
      purpose: 'TOPUP',
    });
    mockPrisma.paymentTransaction.updateMany.mockResolvedValue({ count: 1 });
  });

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PaymentService,
        { provide: ConfigService, useValue: mockConfig },
        { provide: WalletService, useValue: mockWalletService },
        { provide: OrderQrisPaymentService, useValue: mockOrderQrisPaymentService },
        { provide: PrismaService, useValue: mockPrisma },
        { provide: RedisService, useValue: mockRedis },
      ],
    }).compile();

    service = module.get<PaymentService>(PaymentService);
  });

  describe('verifyMidtransSignature', () => {
    const orderId = 'PAY-20260307-000001';
    const statusCode = '200';
    const grossAmount = '100000.00';
    const serverKey = 'SB-Mid-server-TEST_KEY_12345';

    // Pre-computed: SHA512(orderId + statusCode + grossAmount + serverKey)
    function computeExpected(): string {
      const crypto = require('crypto');
      return crypto
        .createHash('sha512')
        .update(`${orderId}${statusCode}${grossAmount}${serverKey}`)
        .digest('hex');
    }

    it('should return true for valid signature', () => {
      const validSignature = computeExpected();
      expect(
        service.verifyMidtransSignature(orderId, statusCode, grossAmount, validSignature),
      ).toBe(true);
    });

    it('should return false for tampered order_id', () => {
      const validSignature = computeExpected();
      expect(
        service.verifyMidtransSignature('FAKE-ORDER', statusCode, grossAmount, validSignature),
      ).toBe(false);
    });

    it('should return false for tampered gross_amount', () => {
      const validSignature = computeExpected();
      expect(
        service.verifyMidtransSignature(orderId, statusCode, '999999999.00', validSignature),
      ).toBe(false);
    });

    it('should return false for empty signature', () => {
      expect(service.verifyMidtransSignature(orderId, statusCode, grossAmount, '')).toBe(false);
    });

    it('should return false for completely wrong signature', () => {
      expect(service.verifyMidtransSignature(orderId, statusCode, grossAmount, 'deadbeef')).toBe(
        false,
      );
    });
  });

  describe('isValidMidtransSourceIp', () => {
    it('should reject when MIDTRANS_ALLOWED_CIDRS is not configured (fail-closed)', () => {
      expect(service.isValidMidtransSourceIp('192.168.1.1')).toBe(false);
      expect(service.isValidMidtransSourceIp('10.0.0.1')).toBe(false);
    });

    it('should allow any IP when bypass flag is set in non-production', () => {
      mockConfig.get.mockImplementation((key: string) => {
        const config: Record<string, unknown> = {
          'midtrans.serverKey': 'SB-Mid-server-TEST_KEY_12345',
          'midtrans.allowedCidrs': '',
          'midtrans.bypassIpCheck': true,
          'app.nodeEnv': 'test',
        };
        return config[key];
      });
      expect(service.isValidMidtransSourceIp('192.168.1.1')).toBe(true);
    });

    it('should allow IP within configured CIDR range', () => {
      mockConfig.get.mockImplementation((key: string) => {
        const config: Record<string, unknown> = {
          'midtrans.serverKey': 'SB-Mid-server-TEST_KEY_12345',
          'midtrans.allowedCidrs': '103.20.51.0/24',
          'midtrans.bypassIpCheck': false,
          'app.nodeEnv': 'test',
        };
        return config[key];
      });
      expect(service.isValidMidtransSourceIp('103.20.51.10')).toBe(true);
      expect(service.isValidMidtransSourceIp('192.168.1.1')).toBe(false);
    });
  });
});

describe('PaymentService webhook concurrency', () => {
  let service: PaymentService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PaymentService,
        { provide: ConfigService, useValue: mockConfig },
        { provide: WalletService, useValue: mockWalletService },
        { provide: OrderQrisPaymentService, useValue: mockOrderQrisPaymentService },
        { provide: PrismaService, useValue: mockPrisma },
        { provide: RedisService, useValue: mockRedis },
      ],
    }).compile();
    service = module.get<PaymentService>(PaymentService);
    mockConfig.get.mockImplementation((key: string) => {
      const config: Record<string, unknown> = {
        'midtrans.serverKey': 'SB-Mid-server-TEST_KEY_12345',
        'midtrans.allowedCidrs': '103.20.51.0/24',
        'midtrans.bypassIpCheck': false,
        'app.nodeEnv': 'test',
      };
      return config[key];
    });
    mockRedis.setNx.mockResolvedValue(true);
    mockPrisma.webhookLog.upsert.mockResolvedValue({
      id: 'webhook-1',
      isProcessed: false,
      retryCount: 0,
      deadLetteredAt: null,
    });
    mockPrisma.webhookLog.update.mockResolvedValue({ id: 'webhook-1', isProcessed: true });
    mockPrisma.paymentTransaction.findFirst.mockResolvedValue({
      id: 'payment-1',
      userId: 'user-1',
      orderId: null,
      status: 'PENDING',
      purpose: 'TOPUP',
    });
    mockWalletService.handleTopupSuccess.mockResolvedValue(undefined);
    mockRedis.setex.mockResolvedValue(undefined);
    mockRedis.del.mockResolvedValue(undefined);
    mockRedis.releaseLock.mockResolvedValue(true);
  });

  it('processes exactly one of concurrent duplicate SETTLEMENT deliveries', async () => {
    const orderId = 'PAY-RACE-20260817-000001';
    const statusCode = '200';
    const grossAmount = '100000.00';
    const transactionId = 'txn-race-1';
    const serverKey = 'SB-Mid-server-TEST_KEY_12345';
    const signature = createHash('sha512')
      .update(`${orderId}${statusCode}${grossAmount}${serverKey}`)
      .digest('hex');
    const notification = {
      order_id: orderId,
      status_code: statusCode,
      gross_amount: grossAmount,
      signature_key: signature,
      transaction_status: 'settlement',
      transaction_id: transactionId,
      fraud_status: 'accept',
    } as never;

    let lockHeld = false;
    mockRedis.setNx.mockImplementation(async () => {
      if (lockHeld) return false;
      lockHeld = true;
      return true;
    });

    const results = await Promise.allSettled(
      Array.from({ length: 5 }, () => service.handleMidtransWebhook(notification, '103.20.51.10')),
    );

    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.filter(result => result.status === 'rejected');
    expect(rejected).toHaveLength(4);
    rejected.forEach(result =>
      expect((result as PromiseRejectedResult).reason).toBeInstanceOf(ServiceUnavailableException),
    );
    expect(mockWalletService.handleTopupSuccess).toHaveBeenCalledTimes(1);
    expect(mockPrisma.webhookLog.upsert).toHaveBeenCalledTimes(5);
    expect(mockRedis.releaseLock).toHaveBeenCalledTimes(1);
    expect(mockRedis.releaseLock.mock.calls[0][0]).toContain('txn-race-1');
    expect(typeof mockRedis.releaseLock.mock.calls[0][1]).toBe('string');
  });

  it('routes QRIS escrow settlement to the order escrow handler without crediting top up balance', async () => {
    const orderId = 'PAY-ORDER-QRIS-20260820-000001';
    const grossAmount = '100700.00';
    const signature = createHash('sha512')
      .update(`${orderId}200${grossAmount}SB-Mid-server-TEST_KEY_12345`)
      .digest('hex');
    mockPrisma.paymentTransaction.findFirst.mockResolvedValue({
      id: 'payment-order-1',
      userId: 'buyer-1',
      orderId: 'order-db-1',
      status: 'PENDING',
      purpose: 'ORDER_ESCROW',
    });
    mockWalletService.handleTopupSuccess.mockClear();
    mockOrderQrisPaymentService.handleSettlement.mockClear();

    await expect(
      service.handleMidtransWebhook(
        {
          order_id: orderId,
          status_code: '200',
          gross_amount: grossAmount,
          signature_key: signature,
          transaction_status: 'settlement',
          transaction_id: 'txn-order-qris-1',
        } as never,
        '103.20.51.10',
      ),
    ).resolves.toEqual({ message: 'OK' });

    expect(mockOrderQrisPaymentService.handleSettlement).toHaveBeenCalledWith(orderId, grossAmount);
    expect(mockWalletService.handleTopupSuccess).not.toHaveBeenCalled();
  });

  it('marks a failed QRIS escrow payment without invoking the top up failure handler', async () => {
    const orderId = 'PAY-ORDER-QRIS-20260820-000002';
    const grossAmount = '100700.00';
    const signature = createHash('sha512')
      .update(`${orderId}202${grossAmount}SB-Mid-server-TEST_KEY_12345`)
      .digest('hex');
    mockPrisma.paymentTransaction.findFirst.mockResolvedValue({
      id: 'payment-order-2',
      userId: 'buyer-1',
      orderId: 'order-db-2',
      status: 'PENDING',
      purpose: 'ORDER_ESCROW',
    });
    mockWalletService.handleTopupFailure.mockClear();
    mockOrderQrisPaymentService.handleFailure.mockClear();

    await expect(
      service.handleMidtransWebhook(
        {
          order_id: orderId,
          status_code: '202',
          gross_amount: grossAmount,
          signature_key: signature,
          transaction_status: 'expire',
          transaction_id: 'txn-order-qris-2',
        } as never,
        '103.20.51.10',
      ),
    ).resolves.toEqual({ message: 'OK' });

    expect(mockOrderQrisPaymentService.handleFailure).toHaveBeenCalledWith(orderId, 'expire');
    expect(mockWalletService.handleTopupFailure).not.toHaveBeenCalled();
  });

  it('quarantines a validly signed webhook when no payment transaction exists', async () => {
    const orderId = 'PAY-UNKNOWN-20260817-000001';
    const statusCode = '200';
    const grossAmount = '100000.00';
    const transactionId = 'txn-unknown-1';
    const signature = createHash('sha512')
      .update(`${orderId}${statusCode}${grossAmount}SB-Mid-server-TEST_KEY_12345`)
      .digest('hex');
    mockPrisma.paymentTransaction.findFirst.mockResolvedValue(null);
    mockWalletService.handleTopupSuccess.mockClear();
    mockPrisma.webhookLog.update.mockClear();

    await expect(
      service.handleMidtransWebhook(
        {
          order_id: orderId,
          status_code: statusCode,
          gross_amount: grossAmount,
          signature_key: signature,
          transaction_status: 'settlement',
          transaction_id: transactionId,
        } as never,
        '103.20.51.10',
      ),
    ).resolves.toEqual({ message: 'OK' });
    expect(mockWalletService.handleTopupSuccess).not.toHaveBeenCalled();
    expect(mockPrisma.webhookLog.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          errorMessage: 'UNKNOWN_PAYMENT_TRANSACTION: manual review required',
        }),
      }),
    );
  });

  it('quarantines a signed webhook with an unsupported payment purpose', async () => {
    const orderId = 'PAY-UNSUPPORTED-20260820-000001';
    const grossAmount = '100000.00';
    const signature = createHash('sha512')
      .update(`${orderId}200${grossAmount}SB-Mid-server-TEST_KEY_12345`)
      .digest('hex');
    mockPrisma.paymentTransaction.findFirst.mockResolvedValue({
      id: 'payment-unsupported',
      userId: 'user-1',
      orderId: null,
      status: 'PENDING',
      purpose: 'UNKNOWN_PURPOSE',
    });
    mockWalletService.handleTopupSuccess.mockClear();
    mockOrderQrisPaymentService.handleSettlement.mockClear();

    await expect(
      service.handleMidtransWebhook(
        {
          order_id: orderId,
          status_code: '200',
          gross_amount: grossAmount,
          signature_key: signature,
          transaction_status: 'settlement',
          transaction_id: 'txn-unsupported-1',
        } as never,
        '103.20.51.10',
      ),
    ).resolves.toEqual({ message: 'OK' });

    expect(mockWalletService.handleTopupSuccess).not.toHaveBeenCalled();
    expect(mockOrderQrisPaymentService.handleSettlement).not.toHaveBeenCalled();
    expect(mockPrisma.webhookLog.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          errorMessage: expect.stringContaining('UNKNOWN_PAYMENT_PURPOSE'),
        }),
      }),
    );
  });

  it('retries a fraud challenge when persisting its escalation signal fails', async () => {
    const orderId = 'PAY-CHALLENGE-20260820-000001';
    const grossAmount = '100000.00';
    const signature = createHash('sha512')
      .update(`${orderId}200${grossAmount}SB-Mid-server-TEST_KEY_12345`)
      .digest('hex');
    mockPrisma.paymentTransaction.updateMany.mockRejectedValueOnce(
      new Error('database unavailable'),
    );

    await expect(
      service.handleMidtransWebhook(
        {
          order_id: orderId,
          status_code: '200',
          gross_amount: grossAmount,
          signature_key: signature,
          transaction_status: 'capture',
          fraud_status: 'challenge',
          transaction_id: 'txn-challenge-retry-1',
        } as never,
        '103.20.51.10',
      ),
    ).rejects.toThrow('database unavailable');

    expect(mockPrisma.webhookLog.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'webhook-1' },
        data: expect.objectContaining({
          retryCount: 1,
          errorMessage: 'database unavailable',
          nextRetryAt: expect.any(Date),
        }),
      }),
    );
  });

  it('increments durable retryCount only after actual processing failure', async () => {
    const orderId = 'PAY-RETRY-20260817-000001';
    const statusCode = '200';
    const grossAmount = '100000.00';
    const transactionId = 'txn-retry-1';
    const serverKey = 'SB-Mid-server-TEST_KEY_12345';
    const signature = createHash('sha512')
      .update(`${orderId}${statusCode}${grossAmount}${serverKey}`)
      .digest('hex');
    const notification = {
      order_id: orderId,
      status_code: statusCode,
      gross_amount: grossAmount,
      signature_key: signature,
      transaction_status: 'settlement',
      transaction_id: transactionId,
    } as never;

    mockPrisma.webhookLog.upsert.mockResolvedValue({
      id: 'webhook-retry',
      isProcessed: false,
      retryCount: 2,
      deadLetteredAt: null,
    });
    mockRedis.setNx.mockResolvedValue(true);
    mockWalletService.handleTopupSuccess.mockRejectedValueOnce(
      new Error('temporary wallet conflict'),
    );

    await expect(service.handleMidtransWebhook(notification, '103.20.51.10')).rejects.toThrow(
      'temporary wallet conflict',
    );
    expect(mockPrisma.webhookLog.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'webhook-retry' },
        data: expect.objectContaining({ retryCount: 3 }),
      }),
    );
  });

  it('requires a provider refund key for partial refund events', async () => {
    const orderId = 'PAY-REFUND-20260819-000001';
    const grossAmount = '100000.00';
    const signature = createHash('sha512')
      .update(`${orderId}200${grossAmount}SB-Mid-server-TEST_KEY_12345`)
      .digest('hex');

    await expect(
      service.handleMidtransWebhook(
        {
          order_id: orderId,
          status_code: '200',
          gross_amount: grossAmount,
          signature_key: signature,
          transaction_status: 'partial_refund',
          transaction_id: 'txn-partial-1',
          refund_amount: '25000.00',
        } as never,
        '103.20.51.10',
      ),
    ).rejects.toThrow('refund_key is required');
    expect(mockWalletService.handleTopupFailure).not.toHaveBeenCalled();
  });

  it('forwards the cumulative refund amount and reference to wallet reversal', async () => {
    const orderId = 'PAY-REFUND-20260819-000002';
    const grossAmount = '100000.00';
    const signature = createHash('sha512')
      .update(`${orderId}200${grossAmount}SB-Mid-server-TEST_KEY_12345`)
      .digest('hex');

    await expect(
      service.handleMidtransWebhook(
        {
          order_id: orderId,
          status_code: '200',
          gross_amount: grossAmount,
          signature_key: signature,
          transaction_status: 'partial_refund',
          transaction_id: 'txn-partial-2',
          refund_amount: '25000.00',
          refund_key: 'refund-first',
        } as never,
        '103.20.51.10',
      ),
    ).resolves.toEqual({ message: 'OK' });
    expect(mockWalletService.handleTopupFailure).toHaveBeenCalledWith(orderId, 'PARTIAL_REFUND', {
      refundAmount: '25000.00',
      refundReference: 'refund-first',
    });
    expect(mockPrisma.webhookLog.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { eventKey: 'MIDTRANS:txn-partial-2:partial_refund:refund-first' },
      }),
    );
  });

  it('processes signed partial chargeback using the provider amount without requiring a merchant refund key', async () => {
    const orderId = 'PAY-CHARGEBACK-20260820-000001';
    const grossAmount = '100000.00';
    const signature = createHash('sha512')
      .update(`${orderId}200${grossAmount}SB-Mid-server-TEST_KEY_12345`)
      .digest('hex');

    await expect(
      service.handleMidtransWebhook(
        {
          order_id: orderId,
          status_code: '200',
          gross_amount: grossAmount,
          signature_key: signature,
          transaction_status: 'partial_chargeback',
          transaction_id: 'txn-chargeback-partial-1',
          refund_amount: '25000.00',
        } as never,
        '103.20.51.10',
      ),
    ).resolves.toEqual({ message: 'OK' });

    expect(mockWalletService.handleTopupFailure).toHaveBeenCalledWith(
      orderId,
      'PARTIAL_CHARGEBACK',
      {
        refundAmount: '25000.00',
        refundReference: undefined,
      },
    );
    expect(mockPrisma.webhookLog.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { eventKey: 'MIDTRANS:txn-chargeback-partial-1:partial_chargeback:25000.00' },
      }),
    );
  });

  it('rejects partial chargeback without a provider amount rather than debiting the full top-up', async () => {
    const orderId = 'PAY-CHARGEBACK-20260820-000002';
    const grossAmount = '100000.00';
    const signature = createHash('sha512')
      .update(`${orderId}200${grossAmount}SB-Mid-server-TEST_KEY_12345`)
      .digest('hex');
    mockWalletService.handleTopupFailure.mockClear();

    await expect(
      service.handleMidtransWebhook(
        {
          order_id: orderId,
          status_code: '200',
          gross_amount: grossAmount,
          signature_key: signature,
          transaction_status: 'partial_chargeback',
          transaction_id: 'txn-chargeback-partial-2',
        } as never,
        '103.20.51.10',
      ),
    ).rejects.toThrow('refund_amount is required');
    expect(mockWalletService.handleTopupFailure).not.toHaveBeenCalled();
  });
});
