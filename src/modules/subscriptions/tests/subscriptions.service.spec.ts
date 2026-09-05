import { Test, TestingModule } from '@nestjs/testing';
import { ConflictException, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SubscriptionsService } from '../subscriptions.service';
import { PrismaService } from '../../../prisma/prisma.service';
import { RedisService } from '../../../redis/redis.service';
import { WalletTxSerialService } from '../../../common/services/wallet-tx-serial.service';
import { AuditLogService } from '../../../common/services/audit-log.service';
import { WalletService } from '../../wallet/wallet.service';
import { SubscriptionPlan, SubscriptionStatus } from '@prisma/client';

const mockPrisma = {
  subscription: {
    findFirst: jest.fn(),
    findUnique: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    count: jest.fn(),
  },
  wallet: {
    findUnique: jest.fn(),
    updateMany: jest.fn(),
  },
  walletTransaction: {
    create: jest.fn(),
  },
  user: {
    update: jest.fn(),
  },
  $queryRaw: jest.fn().mockResolvedValue([]),
  $transaction: jest.fn(),
};

const mockRedis = {
  get: jest.fn(),
  set: jest.fn(),
  setex: jest.fn(),
  del: jest.fn(),
  delPattern: jest.fn(),
};

const mockWalletTxSerialService = {
  getNext: jest.fn().mockResolvedValue(1001),
};

const MONTHLY_PRICE_IDR = 29_000;
const ANNUAL_PRICE_IDR = 299_000;
const MONTHLY_PRICE_SEN = MONTHLY_PRICE_IDR * 100;
const ANNUAL_PRICE_SEN = ANNUAL_PRICE_IDR * 100;

const mockConfigService = {
  get: jest.fn().mockImplementation((key: string) => {
    const config: Record<string, unknown> = {
      'app.subscriptionMonthlyPriceSen': MONTHLY_PRICE_SEN,
      'app.subscriptionAnnualPriceSen': ANNUAL_PRICE_SEN,
    };
    return config[key] ?? null;
  }),
};

const mockActiveSubscription = {
  id: 'sub-1',
  userId: 'user-1',
  plan: SubscriptionPlan.MONTHLY,
  status: SubscriptionStatus.ACTIVE,
  currentPeriodStart: new Date(),
  currentPeriodEnd: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
  feeSavingsUsed: BigInt(0),
  feeSavingsLimit: BigInt(5_000_000),
  isAutoRenew: true,
  cancelledAt: null,
  lastPaymentAt: new Date(),
  nextPaymentAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

describe('SubscriptionsService', () => {
  let service: SubscriptionsService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SubscriptionsService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: RedisService, useValue: mockRedis },
        { provide: WalletTxSerialService, useValue: mockWalletTxSerialService },
        { provide: ConfigService, useValue: mockConfigService },
        { provide: AuditLogService, useValue: { logUserAction: jest.fn() } },
        { provide: WalletService, useValue: { verifyPin: jest.fn().mockResolvedValue(undefined) } },
      ],
    }).compile();

    service = module.get<SubscriptionsService>(SubscriptionsService);
    jest.clearAllMocks();
    mockWalletTxSerialService.getNext.mockResolvedValue(1001);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('subscribe', () => {
    it('should throw ConflictException when user already has an active subscription (double-subscribe guard)', async () => {
      mockPrisma.$transaction.mockImplementation(async (fn: (tx: typeof mockPrisma) => Promise<unknown>) => {
        mockPrisma.subscription.findFirst.mockResolvedValueOnce(mockActiveSubscription);
        return fn(mockPrisma);
      });

      await expect(service.subscribe('user-1', SubscriptionPlan.MONTHLY, '123456')).rejects.toThrow(ConflictException);
    });

    it('should throw ConflictException inside $transaction so partial writes cannot occur', async () => {
      let txStarted = false;
      mockPrisma.$transaction.mockImplementation(async (fn: (tx: typeof mockPrisma) => Promise<unknown>) => {
        txStarted = true;
        mockPrisma.subscription.findFirst.mockResolvedValueOnce(mockActiveSubscription);
        try {
          return await fn(mockPrisma);
        } catch (err) {
          throw err;
        }
      });

      await expect(service.subscribe('user-1', SubscriptionPlan.ANNUAL, '123456')).rejects.toThrow(ConflictException);
      expect(txStarted).toBe(true);
      expect(mockPrisma.subscription.create).not.toHaveBeenCalled();
    });

    it('should allow exactly one subscribe when N concurrent callers race for the DB transaction', async () => {
      const N = 5;
      let subscriptionCreated = false;

      const walletData = {
        id: 'wallet-1',
        userId: 'user-1',
        availableBalance: BigInt(10_000_000),
        totalBalance: BigInt(10_000_000),
        isLocked: false,
        version: 1,
      };

      let txQueue = Promise.resolve() as Promise<void>;

      mockPrisma.$transaction.mockImplementation((fn: (tx: typeof mockPrisma) => Promise<unknown>) => {
        let releaseFn!: () => void;
        const myTurn = new Promise<void>(resolve => { releaseFn = resolve; });
        const waitForPrev = txQueue;
        txQueue = myTurn;

        return waitForPrev.then(async () => {
          mockPrisma.subscription.findFirst.mockImplementation(async () =>
            subscriptionCreated ? mockActiveSubscription : null,
          );
          mockPrisma.subscription.create.mockImplementation(async () => {
            subscriptionCreated = true;
            return { ...mockActiveSubscription, id: 'sub-new' };
          });
          mockPrisma.$queryRaw.mockResolvedValue([walletData]);
          mockPrisma.wallet.updateMany.mockResolvedValue({ count: 1 });
          mockPrisma.walletTransaction.create.mockResolvedValue({ id: 'wtx-1' });
          mockPrisma.user.update.mockResolvedValue({});
          try {
            return await fn(mockPrisma);
          } finally {
            releaseFn();
          }
        });
      });

      const results = await Promise.allSettled(
        Array.from({ length: N }, () =>
          service.subscribe('user-1', SubscriptionPlan.MONTHLY, '123456'),
        ),
      );

      const fulfilled = results.filter(r => r.status === 'fulfilled');
      const rejected = results.filter(
        r => r.status === 'rejected' && (r as PromiseRejectedResult).reason instanceof ConflictException,
      );

      expect(fulfilled.length).toBe(1);
      expect(rejected.length).toBe(N - 1);
    });

    it('should throw BadRequestException when wallet is not found', async () => {
      mockPrisma.$transaction.mockImplementation(async (fn: (tx: typeof mockPrisma) => Promise<unknown>) => {
        mockPrisma.subscription.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce(null);
        mockPrisma.$queryRaw.mockResolvedValueOnce([]);
        return fn(mockPrisma);
      });

      await expect(service.subscribe('user-1', SubscriptionPlan.MONTHLY, '123456')).rejects.toThrow(BadRequestException);
    });
  });
});
