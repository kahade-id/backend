import { Test, TestingModule } from '@nestjs/testing';
import {
  NotFoundException,
  BadRequestException,
  ForbiddenException,
  UnauthorizedException,
  ConflictException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { getQueueToken } from '@nestjs/bull';
import { WalletService } from '../wallet.service';
import { PrismaService } from '../../../prisma/prisma.service';
import { RedisService } from '../../../redis/redis.service';
import { WalletTxSerialService } from '../../../common/services/wallet-tx-serial.service';
import { AuditLogService } from '../../../common/services/audit-log.service';
import { MidtransService } from '../../payment/midtrans.service';
import { OtpService } from '../../auth/otp.service';
import { RealtimeService } from '../../realtime/realtime.service';
import { EMAIL_QUEUE } from '../../queue/processors/email.processor';
import { PaymentMethod } from '@prisma/client';
import { bcryptHash, encryptAES, initializeCrypto } from '../../../common/utils/crypto.util';

const mockWallet = {
  id: 'wallet-1',
  userId: 'user-1',
  availableBalance: BigInt(100000),
  escrowBalance: BigInt(0),
  totalBalance: BigInt(100000),
  todayTopupAmount: BigInt(0),
  todayWithdrawAmount: BigInt(0),
  isLocked: false,
  walletPinHash: null,
  version: 1,
};

const mockPrisma = {
  wallet: {
    findUnique: jest.fn(),
    update: jest.fn(),
    updateMany: jest.fn(),
  },
  walletTransaction: {
    findMany: jest.fn(),
    findFirst: jest.fn(),
    count: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    updateMany: jest.fn(),
    aggregate: jest.fn(),
  },
  paymentTransaction: {
    create: jest.fn(),
    findFirst: jest.fn(),
    findUnique: jest.fn(),
    updateMany: jest.fn(),
  },
  user: {
    findUnique: jest.fn(),
    findFirst: jest.fn(),
  },
  bankAccount: {
    findFirst: jest.fn(),
  },
  notification: {
    create: jest.fn(),
    createMany: jest.fn(),
  },
  $queryRaw: jest.fn().mockResolvedValue([{ id: 'wallet-1' }]),
  $transaction: jest.fn(),
  emitNotificationCreated: jest.fn(),
};

const mockRedis = {
  get: jest.fn().mockResolvedValue(null),
  set: jest.fn().mockResolvedValue('OK'),
  setex: jest.fn().mockResolvedValue('OK'),
  del: jest.fn().mockResolvedValue(1),
  incr: jest.fn().mockResolvedValue(1),
  decr: jest.fn().mockResolvedValue(0),
  incrBy: jest.fn().mockResolvedValue(1),
  decrBy: jest.fn().mockResolvedValue(0),
  expire: jest.fn().mockResolvedValue(1),
  ttl: jest.fn().mockResolvedValue(-2),
  eval: jest.fn().mockResolvedValue(null),
  setNx: jest.fn().mockResolvedValue(true),
  releaseLock: jest.fn().mockResolvedValue(true),
};

const mockConfig = {
  get: jest.fn((key: string) => {
    const values: Record<string, unknown> = {
      'app.walletDailyTopupLimit': 50000000,
      'app.walletDailyWithdrawLimit': 50000000,
      'app.walletMinWithdraw': 50000,
      'app.topupExpiryHours': 24,
      'jwt.expiresIn': '15m',
      'app.walletPinPepper': 'test-pepper-12345678901234567890',
      WALLET_PIN_PEPPER: 'test-pepper-12345678901234567890',
      'app.bcryptRounds': 4,
    };
    return values[key];
  }),
};

const mockWalletTxSerial = {
  getNext: jest.fn().mockResolvedValue(1),
  getNextForPrefix: jest.fn().mockResolvedValue(1),
};

const mockAuditLog = {
  logUserAction: jest.fn(),
};

const mockMidtrans = {
  chargeTransaction: jest.fn().mockResolvedValue({
    statusCode: '201',
    transactionId: 'tx-123',
    orderId: 'PAY-001',
    paymentType: 'bank_transfer',
    transactionStatus: 'pending',
    grossAmount: '14000',
    vaNumber: '1234567890',
    bankName: 'bca',
  }),
  getTransactionStatus: jest.fn(),
};

const mockOtpService = {
  generateOtp: jest.fn(),
  verifyOtp: jest.fn(),
  verifyOtpWithMetadata: jest.fn(),
  consumeVerifiedOtp: jest.fn(),
  invalidateOtps: jest.fn(),
};

const mockEmailQueue = {
  add: jest.fn().mockResolvedValue({ id: 'job-1' }),
};

describe('WalletService', () => {
  let service: WalletService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WalletService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: RedisService, useValue: mockRedis },
        { provide: ConfigService, useValue: mockConfig },
        { provide: WalletTxSerialService, useValue: mockWalletTxSerial },
        { provide: AuditLogService, useValue: mockAuditLog },
        { provide: MidtransService, useValue: mockMidtrans },
        { provide: OtpService, useValue: mockOtpService },
        { provide: RealtimeService, useValue: { sendToUser: jest.fn(), emitToUser: jest.fn() } },
        { provide: getQueueToken(EMAIL_QUEUE), useValue: mockEmailQueue },
      ],
    }).compile();

    service = module.get<WalletService>(WalletService);
    await service.onModuleInit();
    jest.clearAllMocks();
    mockRedis.get.mockResolvedValue(null);
    mockRedis.set.mockResolvedValue('OK');
    mockRedis.del.mockResolvedValue(1);
    mockRedis.incr.mockResolvedValue(1);
    mockRedis.expire.mockResolvedValue(1);
    mockRedis.setNx.mockResolvedValue(true);
    mockRedis.releaseLock.mockResolvedValue(true);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('escrow idempotency', () => {
    it('returns the existing lock transaction on a duplicate order lock', async () => {
      const txFindFirst = jest
        .fn()
        .mockResolvedValue({ txId: 'WLT-existing-lock', amount: BigInt(1000) });
      mockPrisma.$transaction.mockImplementationOnce(
        async (callback: (tx: unknown) => Promise<unknown>) =>
          callback({
            $queryRaw: jest.fn().mockResolvedValue([]),
            walletTransaction: { findFirst: txFindFirst, create: jest.fn() },
            wallet: { findUnique: jest.fn(), updateMany: jest.fn() },
          }),
      );
      mockPrisma.wallet.findUnique.mockResolvedValue({ userId: 'user-1' });

      await expect(service.lockEscrowForOrder('wallet-1', BigInt(1000), 'order-1')).resolves.toBe(
        'WLT-existing-lock',
      );
      expect(txFindFirst).toHaveBeenCalled();
    });

    it('does not repeat a release when the source wallet already has a successful release ledger', async () => {
      const txFindFirst = jest.fn().mockResolvedValue({
        id: 'release-row',
        txId: 'WLT-existing-release',
        amount: BigInt(1000),
      });
      mockPrisma.$transaction.mockImplementationOnce(
        async (callback: (tx: unknown) => Promise<unknown>) =>
          callback({
            $queryRaw: jest.fn().mockResolvedValue([]),
            walletTransaction: { findFirst: txFindFirst, create: jest.fn() },
            wallet: { findUnique: jest.fn(), updateMany: jest.fn() },
          }),
      );

      await expect(
        service.releaseEscrow('wallet-1', 'wallet-2', BigInt(1000), 'order-1'),
      ).resolves.toBeUndefined();
      expect(txFindFirst).toHaveBeenCalled();
    });
  });

  describe('post-settlement top-up reversal', () => {
    it('ignores a stale non-reversal event after the top-up already settled', async () => {
      mockPrisma.paymentTransaction.findUnique.mockResolvedValue({
        id: 'payment-stale-1',
        userId: 'user-1',
        status: 'SUCCESS',
        amount: BigInt(100000),
        createdAt: new Date(),
      });

      await service.handleTopupFailure('PAY-STALE-1', 'EXPIRE');

      expect(mockPrisma.$transaction).not.toHaveBeenCalled();
      expect(mockPrisma.wallet.updateMany).not.toHaveBeenCalled();
      expect(mockPrisma.walletTransaction.create).not.toHaveBeenCalled();
    });

    it('does not decrement today top-up limit for a payment created on a previous day', async () => {
      const oldPayment = {
        id: 'payment-yesterday-1',
        userId: 'user-1',
        status: 'PENDING',
        amount: BigInt(100000),
        createdAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000),
      };
      const tx = {
        paymentTransaction: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
        walletTransaction: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
        wallet: {
          findUnique: jest
            .fn()
            .mockResolvedValue({ ...mockWallet, todayTopupAmount: BigInt(750000) }),
          updateMany: jest.fn(),
        },
      };
      mockPrisma.paymentTransaction.findUnique.mockResolvedValue(oldPayment);
      mockPrisma.notification.create.mockResolvedValue({ id: 'notification-1' });
      mockPrisma.$transaction.mockImplementationOnce(
        async (callback: (client: typeof tx) => Promise<unknown>) => callback(tx),
      );

      await service.handleTopupFailure('PAY-YESTERDAY-1', 'EXPIRE');

      expect(tx.wallet.updateMany).not.toHaveBeenCalled();
    });

    it('does not emit a duplicate failure notification when another webhook already claimed the pending payment', async () => {
      const paymentTx = {
        id: 'payment-duplicate-failure-1',
        userId: 'user-1',
        status: 'PENDING',
        amount: BigInt(100000),
        createdAt: new Date(),
      };
      const tx = {
        paymentTransaction: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
        walletTransaction: { updateMany: jest.fn() },
        wallet: { findUnique: jest.fn(), updateMany: jest.fn() },
      };
      mockPrisma.paymentTransaction.findUnique.mockResolvedValue(paymentTx);
      mockPrisma.$transaction.mockImplementationOnce(
        async (callback: (client: typeof tx) => Promise<unknown>) => callback(tx),
      );

      await service.handleTopupFailure('PAY-DUPLICATE-FAILURE-1', 'EXPIRE');

      expect(mockPrisma.notification.create).not.toHaveBeenCalled();
      expect(mockPrisma.emitNotificationCreated).not.toHaveBeenCalled();
      expect(tx.walletTransaction.updateMany).not.toHaveBeenCalled();
    });

    it('debits only the newly reported cumulative partial-refund delta', async () => {
      const paymentTx = {
        id: 'payment-1',
        userId: 'user-1',
        status: 'SUCCESS',
        amount: BigInt(10_000_000),
        refundedAmount: BigInt(2_000_000),
      };
      const txWallet = {
        ...mockWallet,
        availableBalance: BigInt(10_000_000),
        totalBalance: BigInt(10_000_000),
        todayTopupAmount: BigInt(10_000_000),
      };
      const tx = {
        $queryRaw: jest.fn().mockResolvedValue([{ id: 'payment-1' }]),
        paymentTransaction: {
          findUnique: jest.fn().mockResolvedValue(paymentTx),
          update: jest.fn().mockResolvedValue(paymentTx),
        },
        wallet: {
          findUnique: jest.fn().mockResolvedValue(txWallet),
          updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        },
        walletTransaction: {
          findFirst: jest.fn().mockResolvedValue({ id: 'topup-ledger' }),
          create: jest.fn().mockResolvedValue({ id: 'reversal-ledger' }),
          update: jest.fn().mockResolvedValue({}),
        },
      };
      mockPrisma.paymentTransaction.findUnique.mockResolvedValue(paymentTx);
      mockPrisma.$transaction.mockImplementationOnce(
        async (callback: (client: typeof tx) => Promise<unknown>) => callback(tx),
      );

      await service.handleTopupFailure('PAY-PARTIAL-1', 'PARTIAL_REFUND', {
        refundAmount: '50000.00',
        refundReference: 'refund-second',
      });

      const expectedDelta = BigInt(3_000_000);
      expect(tx.wallet.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            availableBalance: { decrement: expectedDelta },
            totalBalance: { decrement: expectedDelta },
          }),
        }),
      );
      expect(tx.walletTransaction.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ amount: expectedDelta }),
        }),
      );
      expect(tx.paymentTransaction.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ refundedAmount: { increment: expectedDelta } }),
        }),
      );
    });

    it('treats partial chargeback as a post-settlement partial reversal', async () => {
      const paymentTx = {
        id: 'payment-chargeback-1',
        userId: 'user-1',
        status: 'SUCCESS',
        amount: BigInt(10_000_000),
        refundedAmount: BigInt(0),
      };
      const tx = {
        $queryRaw: jest.fn().mockResolvedValue([{ id: paymentTx.id }]),
        paymentTransaction: {
          findUnique: jest.fn().mockResolvedValue(paymentTx),
          update: jest.fn().mockResolvedValue(paymentTx),
        },
        wallet: {
          findUnique: jest.fn().mockResolvedValue({
            ...mockWallet,
            availableBalance: BigInt(10_000_000),
            totalBalance: BigInt(10_000_000),
            todayTopupAmount: BigInt(10_000_000),
          }),
          updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        },
        walletTransaction: {
          findFirst: jest.fn().mockResolvedValue({ id: 'topup-ledger' }),
          create: jest.fn().mockResolvedValue({ id: 'chargeback-ledger' }),
          update: jest.fn().mockResolvedValue({}),
        },
      };
      mockPrisma.paymentTransaction.findUnique.mockResolvedValue(paymentTx);
      mockPrisma.$transaction.mockImplementationOnce(
        async (callback: (client: typeof tx) => Promise<unknown>) => callback(tx),
      );

      await service.handleTopupFailure('PAY-CHARGEBACK-1', 'PARTIAL_CHARGEBACK', {
        refundAmount: '25000.00',
      });

      expect(tx.wallet.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ availableBalance: { decrement: BigInt(2_500_000) } }),
        }),
      );
    });
  });

  // ─── getWallet ───────────────────────────────────────────────────

  describe('getWallet', () => {
    it('should return wallet balances for existing user', async () => {
      mockPrisma.wallet.findUnique.mockResolvedValue(mockWallet);

      const result = (await service.getWallet('user-1')) as unknown as Record<string, unknown>;

      expect(result).toHaveProperty('availableBalance');
      expect(result).toHaveProperty('escrowBalance');
      expect(result).toHaveProperty('totalBalance');
      expect(result.dailyTopupLimit).toBe(50000000);
    });

    it('should throw NotFoundException when wallet does not exist', async () => {
      mockPrisma.wallet.findUnique.mockResolvedValue(null);

      await expect(service.getWallet('user-nonexistent')).rejects.toThrow(NotFoundException);
    });
  });

  // ─── topup ───────────────────────────────────────────────────────

  describe('topup', () => {
    it('rejects a fractional IDR amount before taking a wallet lock or creating payment state', async () => {
      await expect(service.topup('user-1', 10_000.5, PaymentMethod.QRIS)).rejects.toMatchObject({
        response: expect.objectContaining({ code: 'VALIDATION_ERROR' }),
      });
      expect(mockPrisma.wallet.findUnique).not.toHaveBeenCalled();
      expect(mockRedis.setNx).not.toHaveBeenCalled();
    });

    it('should throw BadRequestException when using KAHADE_WALLET as payment method', async () => {
      await expect(service.topup('user-1', 100000, PaymentMethod.KAHADE_WALLET)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('should throw BadRequestException when daily topup limit exceeded', async () => {
      const limitedWallet = {
        ...mockWallet,
        todayTopupAmount: BigInt(50000000 * 100),
      };

      mockRedis.setNx.mockResolvedValue(true);
      mockRedis.del.mockResolvedValue(1);
      mockPrisma.$transaction.mockImplementation(
        async (fn: (tx: typeof mockPrisma) => Promise<unknown>) => {
          return fn(mockPrisma);
        },
      );
      mockPrisma.wallet.findUnique.mockResolvedValue(limitedWallet);

      await expect(service.topup('user-1', 100000, PaymentMethod.QRIS)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('should throw ForbiddenException when wallet is locked', async () => {
      const lockedWallet = { ...mockWallet, isLocked: true };

      mockRedis.setNx.mockResolvedValue(true);
      mockRedis.del.mockResolvedValue(1);
      mockPrisma.$transaction.mockImplementation(
        async (fn: (tx: typeof mockPrisma) => Promise<unknown>) => {
          return fn(mockPrisma);
        },
      );
      mockPrisma.wallet.findUnique.mockResolvedValue(lockedWallet);

      await expect(service.topup('user-1', 100000, PaymentMethod.QRIS)).rejects.toThrow(
        ForbiddenException,
      );
    });

    it('should throw ConflictException when a concurrent topup holds the Redis wallet lock', async () => {
      // Simulate another operation already holding the per-wallet Redis lock.
      // setNx returns false → lock acquisition fails → ConflictException (not a partial DB write).
      mockPrisma.wallet.findUnique.mockResolvedValueOnce({ id: 'wallet-1' });
      mockRedis.setNx.mockResolvedValueOnce(false);

      await expect(service.topup('user-1', 100000, PaymentMethod.QRIS)).rejects.toThrow(
        ConflictException,
      );

      // No transaction should have been started — the guard fires before any DB write.
      expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    });

    it('keeps a top-up pending when a charge error cannot be reconciled with Midtrans', async () => {
      mockPrisma.wallet.findUnique.mockResolvedValue({ ...mockWallet, id: 'wallet-1' });
      mockPrisma.wallet.updateMany.mockResolvedValue({ count: 1 });
      mockPrisma.paymentTransaction.create.mockResolvedValue({
        id: 'payment-1',
        midtransOrderId: 'PAY-001',
      });
      mockPrisma.walletTransaction.create.mockResolvedValue({ id: 'wallet-tx-1' });
      mockPrisma.user.findUnique.mockResolvedValue({ email: 'user@example.com', fullName: 'User' });
      mockPrisma.$transaction.mockImplementation(
        async (callback: (tx: typeof mockPrisma) => Promise<unknown>) => callback(mockPrisma),
      );
      mockMidtrans.chargeTransaction.mockRejectedValue(new Error('network timeout'));
      mockMidtrans.getTransactionStatus.mockRejectedValue(new Error('status unavailable'));

      await expect(service.topup('user-1', 10_000, PaymentMethod.QRIS)).rejects.toMatchObject({
        response: expect.objectContaining({
          code: 'PAYMENT_INITIATION_UNCERTAIN',
          paymentTxId: expect.any(String),
        }),
      });
      expect(mockPrisma.paymentTransaction.updateMany).not.toHaveBeenCalled();
      expect(mockPrisma.walletTransaction.updateMany).not.toHaveBeenCalled();
    });

    it('resolves a synchronous terminal provider response instead of returning a pending payment instruction', async () => {
      mockPrisma.wallet.findUnique.mockResolvedValue({ ...mockWallet, id: 'wallet-1' });
      mockPrisma.wallet.updateMany.mockResolvedValue({ count: 1 });
      mockPrisma.paymentTransaction.create.mockResolvedValue({
        id: 'payment-1',
        midtransOrderId: 'PAY-001',
      });
      mockPrisma.walletTransaction.create.mockResolvedValue({ id: 'wallet-tx-1' });
      mockPrisma.user.findUnique.mockResolvedValue({ email: 'user@example.com', fullName: 'User' });
      mockPrisma.$transaction.mockImplementation(
        async (callback: (tx: typeof mockPrisma) => Promise<unknown>) => callback(mockPrisma),
      );
      mockMidtrans.chargeTransaction.mockResolvedValue({
        statusCode: '202',
        transactionId: 'midtrans-deny-1',
        orderId: 'PAY-001',
        paymentType: 'credit_card',
        transactionStatus: 'deny',
        grossAmount: '10000.00',
      });
      const failSpy = jest.spyOn(service, 'handleTopupFailure').mockResolvedValue(undefined);

      await expect(service.topup('user-1', 10_000, PaymentMethod.QRIS)).rejects.toMatchObject({
        response: expect.objectContaining({ code: 'PAYMENT_INITIATION_DECLINED' }),
      });
      expect(failSpy).toHaveBeenCalledWith(expect.any(String), 'DENY');
      expect(mockAuditLog.logUserAction).not.toHaveBeenCalled();
    });

    it('returns the successful top-up instruction when Redis lock release fails after persistence', async () => {
      mockPrisma.wallet.findUnique.mockResolvedValue({ ...mockWallet, id: 'wallet-1' });
      mockPrisma.wallet.updateMany.mockResolvedValue({ count: 1 });
      mockPrisma.paymentTransaction.create.mockResolvedValue({
        id: 'payment-1',
        midtransOrderId: 'PAY-001',
      });
      mockPrisma.walletTransaction.create.mockResolvedValue({ id: 'wallet-tx-1' });
      mockPrisma.user.findUnique.mockResolvedValue({ email: 'user@example.com', fullName: 'User' });
      mockPrisma.$transaction.mockImplementation(
        async (callback: (tx: typeof mockPrisma) => Promise<unknown>) => callback(mockPrisma),
      );
      mockMidtrans.chargeTransaction.mockResolvedValue({
        statusCode: '201',
        transactionId: 'midtrans-pending-1',
        orderId: 'PAY-001',
        paymentType: 'bank_transfer',
        transactionStatus: 'pending',
        grossAmount: '10070.00',
      });
      mockRedis.releaseLock.mockRejectedValueOnce(new Error('redis release unavailable'));

      await expect(service.topup('user-1', 10_000, PaymentMethod.QRIS)).resolves.toMatchObject({
        paymentTxId: expect.any(String),
        transactionStatus: 'pending',
      });
    });
  });

  // ─── concurrent topup race ────────────────────────────────────
  describe('concurrent topup – true parallel execution', () => {
    it('should allow exactly one topup when N concurrent callers race for the lock', async () => {
      const N = 5;

      mockPrisma.wallet.findUnique.mockResolvedValue(mockWallet);
      mockPrisma.wallet.updateMany.mockResolvedValue({ count: 1 });
      mockPrisma.$transaction.mockImplementation(
        async (fn: (tx: typeof mockPrisma) => Promise<unknown>) => {
          mockPrisma.wallet.updateMany.mockResolvedValue({ count: 1 });
          mockPrisma.walletTransaction.create.mockResolvedValue({ id: 'tx-1' });
          mockPrisma.paymentTransaction.create.mockResolvedValue({
            id: 'pt-1',
            midtransOrderId: 'PAY-001',
          });
          return fn(mockPrisma);
        },
      );
      mockPrisma.user.findUnique.mockResolvedValue({ email: 'a@b.com', fullName: 'Test' });
      (mockMidtrans as Record<string, unknown>).chargeTransaction = jest.fn().mockResolvedValue({
        statusCode: '201',
        transactionId: 'tx-123',
        orderId: 'PAY-001',
        paymentType: 'bank_transfer',
        transactionStatus: 'pending',
        grossAmount: '10070',
        vaNumber: '1234567890',
        bankName: 'bca',
      });

      let lockHeld = false;
      mockRedis.setNx.mockImplementation(async () => {
        if (lockHeld) return false;
        lockHeld = true;
        return true;
      });
      mockRedis.releaseLock.mockImplementation(async () => {
        lockHeld = false;
        return true;
      });

      const results = await Promise.allSettled(
        Array.from({ length: N }, () => service.topup('user-1', 10000, PaymentMethod.QRIS)),
      );

      const fulfilled = results.filter(r => r.status === 'fulfilled');
      const rejected = results.filter(r => r.status === 'rejected');

      expect(fulfilled.length).toBe(1);
      expect(rejected.length).toBe(N - 1);
      rejected.forEach(r => {
        expect((r as PromiseRejectedResult).reason).toBeInstanceOf(ConflictException);
      });
    });
  });

  // ─── setPin ──────────────────────────────────────────────────────

  describe('setPin', () => {
    it('should set wallet PIN successfully', async () => {
      mockPrisma.wallet.findUnique.mockResolvedValue(mockWallet);
      mockPrisma.wallet.update.mockResolvedValue({ ...mockWallet, walletPinHash: 'hashed' });
      mockPrisma.user.findUnique.mockResolvedValue({
        password: await bcryptHash('Password123!', 4),
      });

      const result = await service.setPin('user-1', '481723', undefined, 'Password123!');

      expect(result).toEqual({ message: 'Wallet PIN has been set successfully' });
      expect(mockPrisma.wallet.update).toHaveBeenCalled();
    });

    it('requires the account password before setting the first wallet PIN', async () => {
      mockPrisma.wallet.findUnique.mockResolvedValue({ ...mockWallet, walletPinHash: null });

      await expect(service.setPin('user-1', '481723')).rejects.toThrow(BadRequestException);
      expect(mockPrisma.wallet.update).not.toHaveBeenCalled();
    });

    it('should throw NotFoundException when wallet not found during setPin', async () => {
      mockPrisma.wallet.findUnique.mockResolvedValue(null);

      await expect(service.setPin('user-nonexistent', '481723')).rejects.toThrow(NotFoundException);
    });
  });

  // ─── verifyPin ───────────────────────────────────────────────────

  describe('verifyPin', () => {
    it('should throw NotFoundException when wallet not found', async () => {
      mockPrisma.wallet.findUnique.mockResolvedValue(null);

      await expect(service.verifyPin('user-nonexistent', '123456')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('should throw BadRequestException when wallet PIN is not set', async () => {
      mockPrisma.wallet.findUnique.mockResolvedValue({ ...mockWallet, walletPinHash: null });
      mockRedis.get.mockResolvedValue('0');

      await expect(service.verifyPin('user-1', '481723')).rejects.toThrow(BadRequestException);
    });

    it('should throw ForbiddenException when too many failed PIN attempts', async () => {
      mockPrisma.wallet.findUnique.mockResolvedValue({
        ...mockWallet,
        walletPinHash: 'hashed-pin',
      });
      mockRedis.get.mockResolvedValueOnce('5'); // currentAttempts >= 5 → lockout before PIN check

      await expect(service.verifyPin('user-1', 'wrongpin')).rejects.toThrow(ForbiddenException);
    });

    it('should return { valid: true } for correct PIN', async () => {
      const bcrypt = require('bcrypt');
      const { hmacPinDigest } = require('../../../common/utils/crypto.util');
      const digest = hmacPinDigest('test-pepper-12345678901234567890', '481723');
      const hashedPin = await bcrypt.hash(digest, 4);

      mockPrisma.wallet.findUnique.mockResolvedValue({ ...mockWallet, walletPinHash: hashedPin });
      mockRedis.get.mockResolvedValue('0');
      mockRedis.incr.mockResolvedValue(1);
      mockRedis.del.mockResolvedValue(1);

      const result = await service.verifyPin('user-1', '481723');

      expect(result).toEqual({ valid: true });
    });

    it('should throw UnauthorizedException for incorrect PIN', async () => {
      const bcrypt = require('bcrypt');
      const { hmacPinDigest } = require('../../../common/utils/crypto.util');
      const digest = hmacPinDigest('test-pepper-12345678901234567890', '481723');
      const hashedPin = await bcrypt.hash(digest, 4);

      mockPrisma.wallet.findUnique.mockResolvedValue({ ...mockWallet, walletPinHash: hashedPin });
      mockRedis.get.mockResolvedValue('0');
      mockRedis.incr.mockResolvedValue(1);

      await expect(service.verifyPin('user-1', 'wrongpin')).rejects.toThrow(UnauthorizedException);
    });
  });

  // ─── getTransactions ─────────────────────────────────────────────

  describe('getTransactions', () => {
    it('should return paginated transactions', async () => {
      mockPrisma.wallet.findUnique.mockResolvedValue(mockWallet);
      mockPrisma.walletTransaction.findMany.mockResolvedValue([]);
      mockPrisma.walletTransaction.count.mockResolvedValue(0);

      const result = (await service.getTransactions('user-1', 1, 10)) as unknown as Record<
        string,
        unknown
      >;

      expect(result).toHaveProperty('data');
      expect(result.total).toBe(0);
      expect(result.page).toBe(1);
    });

    it('should throw NotFoundException when wallet not found', async () => {
      mockPrisma.wallet.findUnique.mockResolvedValue(null);

      await expect(service.getTransactions('user-nonexistent', 1, 10)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('should cap limit at 100 to prevent oversized queries', async () => {
      mockPrisma.wallet.findUnique.mockResolvedValue(mockWallet);
      mockPrisma.walletTransaction.findMany.mockResolvedValue([]);
      mockPrisma.walletTransaction.count.mockResolvedValue(0);

      const result = (await service.getTransactions('user-1', 1, 999)) as unknown as Record<
        string,
        unknown
      >;
      expect(result.limit).toBe(100);
    });

    it('interprets date-only filters as an inclusive WIB calendar day', async () => {
      mockPrisma.wallet.findUnique.mockResolvedValue(mockWallet);
      mockPrisma.walletTransaction.findMany.mockResolvedValue([]);
      mockPrisma.walletTransaction.count.mockResolvedValue(0);

      await service.getTransactions('user-1', 1, 10, undefined, '2026-08-21', '2026-08-21');

      expect(mockPrisma.walletTransaction.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            createdAt: {
              gte: new Date('2026-08-20T17:00:00.000Z'),
              lte: new Date('2026-08-21T16:59:59.999Z'),
            },
          }),
        }),
      );
    });
  });

  // ─── settlement and money movement concurrency guards ───────────
  describe('settlement and money movement concurrency', () => {
    it('rejects malformed provider gross amount before a pending top-up can claim payment or credit balance', async () => {
      mockPrisma.paymentTransaction.findUnique.mockResolvedValue({
        id: 'payment-malformed-amount',
        midtransOrderId: 'PAY-MALFORMED-1',
        userId: 'user-1',
        status: 'PENDING',
        amount: BigInt(10_000),
        grossAmount: BigInt(10_000),
      });

      await expect(
        service.handleTopupSuccess('PAY-MALFORMED-1', '100.00unexpected'),
      ).rejects.toMatchObject({
        response: expect.objectContaining({ code: 'INVALID_PROVIDER_AMOUNT' }),
      });
      expect(mockPrisma.paymentTransaction.updateMany).not.toHaveBeenCalled();
      expect(mockPrisma.wallet.updateMany).not.toHaveBeenCalled();
    });

    it('credits a duplicate settlement at most once when updateMany claims the payment atomically', async () => {
      const paymentTx = {
        id: 'payment-1',
        midtransOrderId: 'PAY-RACE-1',
        userId: 'user-1',
        status: 'PENDING',
        amount: BigInt(10000),
        grossAmount: BigInt(10000),
      };
      mockPrisma.paymentTransaction.findUnique.mockResolvedValue(paymentTx);
      mockPrisma.wallet.findUnique.mockImplementation(
        async ({ where }: { where: Record<string, string> }) => {
          if (where.userId === 'user-1')
            return { ...mockWallet, availableBalance: BigInt(50000), totalBalance: BigInt(50000) };
          return { availableBalance: BigInt(60000), totalBalance: BigInt(60000) };
        },
      );
      mockPrisma.walletTransaction.findFirst.mockResolvedValue(null);
      mockPrisma.walletTransaction.aggregate.mockResolvedValue({ _sum: { amount: BigInt(10000) } });
      mockPrisma.notification.create.mockResolvedValue({ id: 'notification-1' });
      mockPrisma.emitNotificationCreated.mockImplementation(() => undefined);

      let paymentClaimed = false;
      mockPrisma.paymentTransaction.updateMany.mockImplementation(async () => {
        if (paymentClaimed) return { count: 0 };
        paymentClaimed = true;
        return { count: 1 };
      });
      mockPrisma.wallet.updateMany.mockResolvedValue({ count: 1 });
      mockPrisma.walletTransaction.create.mockResolvedValue({ id: 'wallet-tx-1' });
      mockPrisma.$transaction.mockImplementation(
        async (fn: (tx: typeof mockPrisma) => Promise<unknown>) => fn(mockPrisma),
      );

      const results = await Promise.allSettled(
        Array.from({ length: 5 }, () => service.handleTopupSuccess('PAY-RACE-1', '100.00')),
      );

      expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(5);
      expect(mockPrisma.paymentTransaction.updateMany).toHaveBeenCalledTimes(5);
      expect(mockPrisma.wallet.updateMany).toHaveBeenCalledTimes(1);
      expect(mockPrisma.walletTransaction.create).toHaveBeenCalledTimes(1);
      expect(mockPrisma.notification.create).toHaveBeenCalledTimes(1);
      expect(mockPrisma.emitNotificationCreated).toHaveBeenCalledTimes(1);
    });
  });

  describe('escrow helper idempotency', () => {
    it('returns the existing successful lock instead of creating a duplicate', async () => {
      mockPrisma.walletTransaction.findFirst.mockResolvedValue({
        txId: 'WLT-LOCK-1',
        amount: BigInt(10000),
      });
      mockPrisma.$transaction.mockImplementation(
        async (fn: (tx: typeof mockPrisma) => Promise<unknown>) => fn(mockPrisma),
      );
      mockPrisma.wallet.findUnique.mockResolvedValue({ ...mockWallet, userId: 'user-1' });

      await expect(service.lockEscrowForOrder('wallet-1', BigInt(10000), 'order-1')).resolves.toBe(
        'WLT-LOCK-1',
      );
      expect(mockPrisma.wallet.updateMany).not.toHaveBeenCalled();
      expect(mockPrisma.walletTransaction.create).not.toHaveBeenCalled();
    });

    it('returns successfully when the release ledger already exists', async () => {
      mockPrisma.walletTransaction.findFirst.mockResolvedValue({ amount: BigInt(10000) });
      mockPrisma.$transaction.mockImplementation(
        async (fn: (tx: typeof mockPrisma) => Promise<unknown>) => fn(mockPrisma),
      );
      mockPrisma.wallet.findUnique.mockResolvedValue({ ...mockWallet, userId: 'user-1' });

      await expect(
        service.releaseEscrow('wallet-1', 'wallet-2', BigInt(10000), 'order-1'),
      ).resolves.toBeUndefined();
      expect(mockPrisma.walletTransaction.create).not.toHaveBeenCalled();
    });
  });

  // ─── transfer and withdrawal concurrency guards ─────────────────
  describe('money movement concurrency', () => {
    it('rejects withdrawal before reserving funds when the user has no verified email for confirmation OTP', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({
        id: 'user-1',
        email: null,
        emailVerified: false,
        kycStatus: 'APPROVED',
      });

      await expect(service.withdraw('user-1', 50000, 'bank-1', '481723')).rejects.toMatchObject({
        response: expect.objectContaining({ code: 'EMAIL_NOT_CONFIGURED' }),
      });
      expect(mockPrisma.wallet.findUnique).not.toHaveBeenCalled();
      expect(mockOtpService.generateOtp).not.toHaveBeenCalled();
      expect(mockEmailQueue.add).not.toHaveBeenCalled();
    });

    it('rejects a fractional withdrawal before wallet lookup or PIN verification', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({
        id: 'user-1',
        email: 'user@example.com',
        kycStatus: 'APPROVED',
      });

      await expect(service.withdraw('user-1', 50_000.5, 'bank-1', '481723')).rejects.toMatchObject({
        response: expect.objectContaining({ code: 'VALIDATION_ERROR' }),
      });
      expect(mockPrisma.wallet.findUnique).not.toHaveBeenCalled();
      expect(mockRedis.get).not.toHaveBeenCalled();
    });

    it('does not verify or resend legacy pending-withdrawal OTPs against an empty email identity', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({ id: 'user-1', email: null });

      await expect(service.confirmWithdrawOtp('user-1', 'WLT-1', '123456')).rejects.toMatchObject({
        response: expect.objectContaining({ code: 'EMAIL_NOT_CONFIGURED' }),
      });
      await expect(service.resendWithdrawOtp('user-1', 'WLT-1')).rejects.toMatchObject({
        response: expect.objectContaining({ code: 'EMAIL_NOT_CONFIGURED' }),
      });
      expect(mockPrisma.wallet.findUnique).not.toHaveBeenCalled();
      expect(mockOtpService.verifyOtpWithMetadata).not.toHaveBeenCalled();
      expect(mockOtpService.generateOtp).not.toHaveBeenCalled();
    });

    it('rejects a valid withdrawal OTP that is missing transaction-binding metadata', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({ id: 'user-1', email: 'user@example.com' });
      mockPrisma.wallet.findUnique.mockResolvedValue({ ...mockWallet, isLocked: false });
      mockPrisma.walletTransaction.findFirst.mockResolvedValue({
        id: 'withdrawal-1',
        txId: 'WLT-1',
        amount: BigInt(5000000),
        bankAccountId: 'bank-1',
        withdrawStatus: 'PENDING_OTP',
      });
      mockOtpService.verifyOtpWithMetadata.mockResolvedValue({
        valid: true,
        otpId: 'otp-1',
        metadata: {},
      });

      await expect(service.confirmWithdrawOtp('user-1', 'WLT-1', '123456')).rejects.toMatchObject({
        response: expect.objectContaining({ code: 'OTP_TX_MISMATCH' }),
      });
      expect(mockPrisma.$transaction).not.toHaveBeenCalled();
      expect(mockOtpService.consumeVerifiedOtp).not.toHaveBeenCalled();
    });

    it('rejects an otherwise valid withdrawal OTP after the configured five-minute lifetime', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({ id: 'user-1', email: 'user@example.com' });
      mockPrisma.wallet.findUnique.mockResolvedValue({ ...mockWallet, isLocked: false });
      mockPrisma.walletTransaction.findFirst.mockResolvedValue({
        id: 'withdrawal-1',
        txId: 'WLT-1',
        amount: BigInt(5000000),
        bankAccountId: 'bank-1',
        withdrawStatus: 'PENDING_OTP',
      });
      mockOtpService.verifyOtpWithMetadata.mockResolvedValue({
        valid: true,
        otpId: 'otp-1',
        metadata: {
          walletTxId: 'WLT-1',
          bankAccountId: 'bank-1',
          amountSen: '5000000',
          timestamp: Date.now() - 6 * 60 * 1000,
        },
      });

      await expect(service.confirmWithdrawOtp('user-1', 'WLT-1', '123456')).rejects.toMatchObject({
        response: expect.objectContaining({ code: 'OTP_INVALID' }),
      });
      expect(mockPrisma.$transaction).not.toHaveBeenCalled();
      expect(mockOtpService.consumeVerifiedOtp).not.toHaveBeenCalled();
    });

    it('allows one transfer winner while concurrent callers receive a wallet conflict', async () => {
      const bcrypt = require('bcrypt');
      const { hmacPinDigest } = require('../../../common/utils/crypto.util');
      const pinHash = await bcrypt.hash(
        hmacPinDigest('test-pepper-12345678901234567890', '481723'),
        4,
      );
      const sender = {
        id: 'user-1',
        userId: 'USR-1',
        fullName: 'Sender',
        email: 'sender@example.com',
        username: 'sender',
        kycStatus: 'APPROVED',
        isActive: true,
        isBanned: false,
      };
      const recipient = {
        id: 'user-2',
        userId: 'USR-2',
        fullName: 'Recipient',
        email: 'recipient@example.com',
        username: 'recipient',
        kycStatus: 'APPROVED',
        isActive: true,
        isBanned: false,
      };
      const senderWallet = {
        ...mockWallet,
        id: 'wallet-1',
        userId: 'user-1',
        walletPinHash: pinHash,
        availableBalance: BigInt(1000000),
        totalBalance: BigInt(1000000),
      };
      const recipientWallet = {
        ...mockWallet,
        id: 'wallet-2',
        userId: 'user-2',
        walletPinHash: null,
        availableBalance: BigInt(0),
        totalBalance: BigInt(0),
      };

      mockPrisma.user.findUnique.mockResolvedValue(sender);
      mockPrisma.user.findFirst.mockResolvedValue(recipient);
      mockPrisma.wallet.findUnique.mockImplementation(
        ({ where }: { where: Record<string, string> }) => {
          if (where.userId === 'user-1' || where.id === 'wallet-1')
            return Promise.resolve(senderWallet);
          return Promise.resolve(recipientWallet);
        },
      );
      mockPrisma.wallet.updateMany.mockResolvedValue({ count: 1 });
      mockPrisma.walletTransaction.create.mockResolvedValue({ id: 'wallet-tx' });
      mockPrisma.notification.createMany.mockResolvedValue({ count: 2 });
      mockPrisma.$transaction.mockImplementation(
        async (fn: (tx: typeof mockPrisma) => Promise<unknown>) => {
          await new Promise(resolve => setTimeout(resolve, 5));
          return fn(mockPrisma);
        },
      );

      let lockHeld = false;
      mockRedis.setNx.mockImplementation(async () => {
        if (lockHeld) return false;
        lockHeld = true;
        return true;
      });
      // Keep the synthetic lock held until the Promise.all batch has completed;
      // the production Redis lock expires/release semantics are tested separately.
      mockRedis.releaseLock.mockImplementation(async () => true);

      const results = await Promise.allSettled(
        Array.from({ length: 4 }, () => service.transfer('user-1', 'user-2', 10000, '481723')),
      );

      expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
      expect(results.filter(result => result.status === 'rejected')).toHaveLength(3);
      expect(mockPrisma.walletTransaction.create).toHaveBeenCalledTimes(2);
    });

    it('rejects a fractional transfer before PIN verification or the transfer lock', async () => {
      const sender = {
        id: 'user-1',
        userId: 'USR-1',
        fullName: 'Sender',
        email: 'sender@example.com',
        username: 'sender',
        kycStatus: 'APPROVED',
        isActive: true,
        isBanned: false,
      };
      const recipient = {
        id: 'user-2',
        userId: 'USR-2',
        fullName: 'Recipient',
        email: 'recipient@example.com',
        username: 'recipient',
        kycStatus: 'APPROVED',
        isActive: true,
        isBanned: false,
      };
      mockPrisma.user.findUnique.mockResolvedValue(sender);
      mockPrisma.user.findFirst.mockResolvedValue(recipient);
      mockPrisma.wallet.findUnique.mockResolvedValue({ ...mockWallet, walletPinHash: 'unused' });

      await expect(service.transfer('user-1', 'user-2', 10_000.5, '481723')).rejects.toMatchObject({
        response: expect.objectContaining({ code: 'VALIDATION_ERROR' }),
      });
      expect(mockRedis.get).not.toHaveBeenCalled();
      expect(mockRedis.setNx).not.toHaveBeenCalled();
    });

    it('rolls back the daily transfer counter when Redis cannot attach its expiry', async () => {
      const bcrypt = require('bcrypt');
      const { hmacPinDigest } = require('../../../common/utils/crypto.util');
      const pinHash = await bcrypt.hash(
        hmacPinDigest('test-pepper-12345678901234567890', '481723'),
        4,
      );
      const sender = {
        id: 'user-1',
        userId: 'USR-1',
        fullName: 'Sender',
        email: 'sender@example.com',
        username: 'sender',
        kycStatus: 'APPROVED',
        isActive: true,
        isBanned: false,
      };
      const recipient = {
        id: 'user-2',
        userId: 'USR-2',
        fullName: 'Recipient',
        email: 'recipient@example.com',
        username: 'recipient',
        kycStatus: 'APPROVED',
        isActive: true,
        isBanned: false,
      };
      const senderWallet = {
        ...mockWallet,
        id: 'wallet-1',
        userId: 'user-1',
        walletPinHash: pinHash,
        availableBalance: BigInt(1000000),
        totalBalance: BigInt(1000000),
      };
      const recipientWallet = {
        ...mockWallet,
        id: 'wallet-2',
        userId: 'user-2',
        walletPinHash: null,
        availableBalance: BigInt(0),
        totalBalance: BigInt(0),
      };

      mockPrisma.user.findUnique.mockResolvedValue(sender);
      mockPrisma.user.findFirst.mockResolvedValue(recipient);
      mockPrisma.wallet.findUnique.mockImplementation(
        ({ where }: { where: Record<string, string> }) =>
          Promise.resolve(where.userId === 'user-1' ? senderWallet : recipientWallet),
      );
      mockRedis.incrBy.mockResolvedValue(1_000_000);
      mockRedis.ttl.mockResolvedValue(-2);
      mockRedis.expire.mockRejectedValue(new Error('redis ttl unavailable'));

      await expect(service.transfer('user-1', 'user-2', 10000, '481723')).rejects.toThrow(
        'redis ttl unavailable',
      );

      expect(mockRedis.decrBy).toHaveBeenCalledWith(
        expect.stringMatching(/^daily_transfer:user-1:/),
        1_000_000,
      );
      expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    });

    it('rolls back the daily transfer counter when allocating a ledger serial fails', async () => {
      const bcrypt = require('bcrypt');
      const { hmacPinDigest } = require('../../../common/utils/crypto.util');
      const pinHash = await bcrypt.hash(
        hmacPinDigest('test-pepper-12345678901234567890', '481723'),
        4,
      );
      const sender = {
        id: 'user-1',
        userId: 'USR-1',
        fullName: 'Sender',
        email: 'sender@example.com',
        username: 'sender',
        kycStatus: 'APPROVED',
        isActive: true,
        isBanned: false,
      };
      const recipient = {
        id: 'user-2',
        userId: 'USR-2',
        fullName: 'Recipient',
        email: 'recipient@example.com',
        username: 'recipient',
        kycStatus: 'APPROVED',
        isActive: true,
        isBanned: false,
      };
      const senderWallet = {
        ...mockWallet,
        id: 'wallet-1',
        userId: 'user-1',
        walletPinHash: pinHash,
        availableBalance: BigInt(1000000),
        totalBalance: BigInt(1000000),
      };
      const recipientWallet = {
        ...mockWallet,
        id: 'wallet-2',
        userId: 'user-2',
        walletPinHash: null,
        availableBalance: BigInt(0),
        totalBalance: BigInt(0),
      };

      mockPrisma.user.findUnique.mockResolvedValue(sender);
      mockPrisma.user.findFirst.mockResolvedValue(recipient);
      mockPrisma.wallet.findUnique.mockImplementation(
        ({ where }: { where: Record<string, string> }) =>
          Promise.resolve(where.userId === 'user-1' ? senderWallet : recipientWallet),
      );
      mockRedis.incrBy.mockResolvedValue(1_000_000);
      mockRedis.ttl.mockResolvedValue(3600);
      jest
        .spyOn(service as any, 'getNextWalletTxSerial')
        .mockRejectedValueOnce(new Error('serial allocator unavailable'));

      await expect(service.transfer('user-1', 'user-2', 10000, '481723')).rejects.toThrow(
        'serial allocator unavailable',
      );

      expect(mockRedis.decrBy).toHaveBeenCalledWith(
        expect.stringMatching(/^daily_transfer:user-1:/),
        1_000_000,
      );
      expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    });

    it('rejects concurrent withdrawal requests when the per-wallet lock is held', async () => {
      const bcrypt = require('bcrypt');
      const { hmacPinDigest } = require('../../../common/utils/crypto.util');
      const pinHash = await bcrypt.hash(
        hmacPinDigest('test-pepper-12345678901234567890', '481723'),
        4,
      );
      mockPrisma.user.findUnique.mockResolvedValue({
        id: 'user-1',
        email: 'user@example.com',
        kycStatus: 'APPROVED',
      });
      mockPrisma.wallet.findUnique.mockResolvedValue({ ...mockWallet, walletPinHash: pinHash });
      mockPrisma.bankAccount.findFirst.mockResolvedValue({
        id: 'bank-1',
        userId: 'user-1',
        bankName: 'BCA',
        accountNumber: 'encrypted-placeholder',
        deletedAt: null,
        isVerified: true,
      });
      mockRedis.setNx.mockResolvedValue(false);
      mockPrisma.$transaction.mockClear();
      const results = await Promise.allSettled(
        Array.from({ length: 4 }, () => service.withdraw('user-1', 50000, 'bank-1', '481723')),
      );
      expect(results).toHaveLength(4);
      results.forEach(result => {
        expect(result.status).toBe('rejected');
        expect((result as PromiseRejectedResult).reason).toBeInstanceOf(ConflictException);
      });
      expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    });

    it('does not resend withdrawal OTP when the wallet becomes locked', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({ id: 'user-1', email: 'user@example.com' });
      mockPrisma.wallet.findUnique.mockResolvedValue({ ...mockWallet, isLocked: true });

      await expect(service.resendWithdrawOtp('user-1', 'WLT-1')).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      expect(mockRedis.setNx).not.toHaveBeenCalled();
      expect(mockOtpService.generateOtp).not.toHaveBeenCalled();
    });

    it('rejects a resend while another withdrawal OTP lifecycle operation holds the transaction mutex', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({ id: 'user-1', email: 'user@example.com' });
      mockPrisma.wallet.findUnique.mockResolvedValue({ ...mockWallet, isLocked: false });
      mockPrisma.walletTransaction.findFirst.mockResolvedValue({
        id: 'withdraw-1',
        txId: 'WLT-1',
        walletId: 'wallet-1',
        withdrawStatus: 'PENDING_OTP',
        amount: BigInt(50000),
        bankAccountId: 'bank-1',
      });
      mockRedis.setNx.mockResolvedValueOnce(false);

      await expect(service.resendWithdrawOtp('user-1', 'WLT-1')).rejects.toBeInstanceOf(
        ConflictException,
      );

      expect(mockOtpService.invalidateOtps).not.toHaveBeenCalled();
      expect(mockOtpService.generateOtp).not.toHaveBeenCalled();
      expect(mockEmailQueue.add).not.toHaveBeenCalled();
    });

    it('rejects OTP confirmation while another withdrawal lifecycle operation holds the transaction mutex', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({ id: 'user-1', email: 'user@example.com' });
      mockPrisma.wallet.findUnique.mockResolvedValue({ ...mockWallet, isLocked: false });
      mockRedis.setNx.mockResolvedValueOnce(false);

      try {
        await expect(
          service.confirmWithdrawOtp('user-1', 'WLT-1', '123456'),
        ).rejects.toBeInstanceOf(ConflictException);
      } finally {
        mockRedis.setNx.mockReset().mockResolvedValue(true);
      }

      expect(mockPrisma.walletTransaction.findFirst).not.toHaveBeenCalled();
      expect(mockOtpService.verifyOtpWithMetadata).not.toHaveBeenCalled();
    });

    it('compensates a reserved withdrawal when OTP setup fails', async () => {
      initializeCrypto({
        aesSecretKey: '0'.repeat(64),
        aesKdfSalt: 'wallet-otp-compensation-test',
        hmacSecretKey: '1'.repeat(64),
      });
      const reservedWallet = {
        ...mockWallet,
        walletPinHash: 'unused-in-this-test',
        availableBalance: BigInt(5000000),
        totalBalance: BigInt(5000000),
      };
      const encryptedAccount = await encryptAES('1234567890');
      const tx = {
        $queryRaw: jest.fn().mockResolvedValue([{ id: 'wallet-1' }]),
        wallet: {
          findUnique: jest.fn().mockResolvedValue(reservedWallet),
          updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        },
        walletTransaction: {
          findFirst: jest.fn().mockResolvedValue(null),
          create: jest.fn().mockResolvedValue({ id: 'withdraw-1' }),
        },
        bankAccount: {
          findFirst: jest.fn().mockResolvedValue({
            id: 'bank-1',
            userId: 'user-1',
            bankName: 'BCA',
            accountNumber: encryptedAccount,
            deletedAt: null,
            isVerified: true,
          }),
        },
        order: { findMany: jest.fn().mockResolvedValue([]) },
      };
      mockPrisma.user.findUnique.mockResolvedValue({
        id: 'user-1',
        email: 'user@example.com',
        kycStatus: 'APPROVED',
      });
      mockPrisma.wallet.findUnique.mockResolvedValue(reservedWallet);
      mockPrisma.bankAccount.findFirst.mockResolvedValue({
        id: 'bank-1',
        userId: 'user-1',
        bankName: 'BCA',
        accountNumber: encryptedAccount,
        deletedAt: null,
        isVerified: true,
      });
      mockPrisma.$transaction.mockImplementationOnce(
        async (callback: (client: typeof tx) => Promise<unknown>) => callback(tx),
      );
      const serviceWithPrivatePin = service as unknown as {
        verifyWalletPin: (...args: unknown[]) => Promise<void>;
      };
      jest.spyOn(serviceWithPrivatePin, 'verifyWalletPin').mockResolvedValue(undefined);
      const cancelSpy = jest
        .spyOn(service, 'cancelPendingWithdrawal')
        .mockResolvedValue({ message: 'Pending withdrawal cancelled and funds restored' });
      mockOtpService.invalidateOtps.mockRejectedValueOnce(new Error('otp store unavailable'));

      await expect(service.withdraw('user-1', 50000, 'bank-1', '481723')).rejects.toThrow(
        'otp store unavailable',
      );

      expect(cancelSpy).toHaveBeenCalledWith('user-1', expect.stringMatching(/^WLT-/));
      expect(mockEmailQueue.add).not.toHaveBeenCalled();
    });

    it('compensates a reserved withdrawal when the OTP email cannot be queued', async () => {
      initializeCrypto({
        aesSecretKey: '0'.repeat(64),
        aesKdfSalt: 'wallet-email-compensation-test',
        hmacSecretKey: '1'.repeat(64),
      });
      const reservedWallet = {
        ...mockWallet,
        walletPinHash: 'unused-in-this-test',
        availableBalance: BigInt(5000000),
        totalBalance: BigInt(5000000),
      };
      const encryptedAccount = await encryptAES('1234567890');
      const tx = {
        $queryRaw: jest.fn().mockResolvedValue([{ id: 'wallet-1' }]),
        wallet: {
          findUnique: jest.fn().mockResolvedValue(reservedWallet),
          updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        },
        walletTransaction: {
          findFirst: jest.fn().mockResolvedValue(null),
          create: jest.fn().mockResolvedValue({ id: 'withdraw-1' }),
        },
        bankAccount: {
          findFirst: jest.fn().mockResolvedValue({
            id: 'bank-1',
            userId: 'user-1',
            bankName: 'BCA',
            accountNumber: encryptedAccount,
            deletedAt: null,
            isVerified: true,
          }),
        },
        order: { findMany: jest.fn().mockResolvedValue([]) },
      };
      mockPrisma.user.findUnique.mockResolvedValue({
        id: 'user-1',
        email: 'user@example.com',
        kycStatus: 'APPROVED',
      });
      mockPrisma.wallet.findUnique.mockResolvedValue(reservedWallet);
      mockPrisma.bankAccount.findFirst.mockResolvedValue({
        id: 'bank-1',
        userId: 'user-1',
        bankName: 'BCA',
        accountNumber: encryptedAccount,
        deletedAt: null,
        isVerified: true,
      });
      mockPrisma.$transaction.mockImplementationOnce(
        async (callback: (client: typeof tx) => Promise<unknown>) => callback(tx),
      );
      const serviceWithPrivatePin = service as unknown as {
        verifyWalletPin: (...args: unknown[]) => Promise<void>;
      };
      jest.spyOn(serviceWithPrivatePin, 'verifyWalletPin').mockResolvedValue(undefined);
      const cancelSpy = jest
        .spyOn(service, 'cancelPendingWithdrawal')
        .mockResolvedValue({ message: 'Pending withdrawal cancelled and funds restored' });
      mockOtpService.invalidateOtps.mockResolvedValue(undefined);
      mockOtpService.generateOtp.mockResolvedValue('123456');
      mockEmailQueue.add.mockRejectedValueOnce(new Error('email queue unavailable'));

      await expect(service.withdraw('user-1', 50000, 'bank-1', '481723')).rejects.toThrow(
        'email queue unavailable',
      );

      expect(cancelSpy).toHaveBeenCalledWith('user-1', expect.stringMatching(/^WLT-/));
    });

    it('rolls back the resend cooldown when email delivery fails', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({ id: 'user-1', email: 'user@example.com' });
      mockPrisma.wallet.findUnique.mockResolvedValue({ ...mockWallet, isLocked: false });
      mockPrisma.walletTransaction.findFirst.mockResolvedValue({
        id: 'withdraw-1',
        txId: 'WLT-1',
        walletId: 'wallet-1',
        withdrawStatus: 'PENDING_OTP',
        amount: BigInt(50000),
        bankAccountId: 'bank-1',
      });
      mockOtpService.invalidateOtps.mockResolvedValue(undefined);
      mockOtpService.generateOtp.mockResolvedValue('123456');
      mockEmailQueue.add.mockRejectedValueOnce(new Error('email provider unavailable'));

      await expect(service.resendWithdrawOtp('user-1', 'WLT-1')).rejects.toThrow(
        'email provider unavailable',
      );
      expect(mockRedis.del).toHaveBeenCalledWith('withdraw_otp_cooldown:user-1');
    });

    it('refreshes the pending withdrawal timestamp after a successful OTP resend', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({ id: 'user-1', email: 'user@example.com' });
      mockPrisma.wallet.findUnique.mockResolvedValue({ ...mockWallet, isLocked: false });
      mockPrisma.walletTransaction.findFirst.mockResolvedValue({
        id: 'withdraw-1',
        txId: 'WLT-1',
        walletId: 'wallet-1',
        withdrawStatus: 'PENDING_OTP',
        amount: BigInt(50000),
        bankAccountId: 'bank-1',
      });
      mockOtpService.invalidateOtps.mockResolvedValue(undefined);
      mockOtpService.generateOtp.mockResolvedValue('123456');
      mockEmailQueue.add.mockResolvedValue(undefined);
      mockPrisma.walletTransaction.updateMany.mockResolvedValue({ count: 1 });

      await expect(service.resendWithdrawOtp('user-1', 'WLT-1')).resolves.toMatchObject({
        message: 'OTP resent successfully',
      });

      expect(mockPrisma.walletTransaction.updateMany).toHaveBeenCalledWith({
        where: {
          id: 'withdraw-1',
          type: 'WITHDRAW',
          status: 'PENDING',
          withdrawStatus: 'PENDING_OTP',
        },
        data: { updatedAt: expect.any(Date) },
      });
    });
  });
});
