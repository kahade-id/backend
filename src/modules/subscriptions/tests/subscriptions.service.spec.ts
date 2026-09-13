import { Test, TestingModule } from '@nestjs/testing';
import { ConflictException, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SubscriptionsService } from '../subscriptions.service';
import { PrismaService } from '../../../prisma/prisma.service';
import { RedisService } from '../../../redis/redis.service';
import { WalletTxSerialService } from '../../../common/services/wallet-tx-serial.service';
import { AuditLogService } from '../../../common/services/audit-log.service';
import { WalletService } from '../../wallet/wallet.service';
import { VerificationBadgeService } from '../../users/verification-badge.service';
import { SubscriptionPlan, SubscriptionStatus } from '@prisma/client';

const mockPrisma = {
  subscription: {
    findFirst: jest.fn(),
    findUnique: jest.fn(),
    findUniqueOrThrow: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    updateMany: jest.fn(),
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
    // Section 1: subscribe/renew membaca kahadePlusSince sebelum memutuskan
    // apakah perlu mengisinya (hanya pertama kali subscribe).
    findUnique: jest.fn().mockResolvedValue({ kahadePlusSince: null }),
  },
  campaign: {
    findFirst: jest.fn(),
    updateMany: jest.fn(),
  },
  $queryRaw: jest.fn().mockResolvedValue([]),
  $transaction: jest.fn(),
};

const mockRedis = {
  get: jest.fn(),
  set: jest.fn(),
  setex: jest.fn(),
  del: jest.fn().mockResolvedValue(undefined),
  delPattern: jest.fn().mockResolvedValue(undefined),
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

const mockWalletService = {
  verifyPin: jest.fn().mockResolvedValue(undefined),
};

const mockAuditLogService = {
  logUserAction: jest.fn(),
};

const mockVerificationBadgeService = {
  invalidate: jest.fn().mockResolvedValue(undefined),
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
        { provide: AuditLogService, useValue: mockAuditLogService },
        { provide: WalletService, useValue: mockWalletService },
        { provide: VerificationBadgeService, useValue: mockVerificationBadgeService },
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

    it('creates a one-lifetime trial without charging wallet or requiring a PIN', async () => {
      mockPrisma.subscription.findFirst.mockResolvedValueOnce(null); // prior trial check
      const tx = {
        subscription: {
          findFirst: jest.fn().mockResolvedValue(null),
          create: jest.fn().mockImplementation(async ({ data }) => ({
            id: 'sub-trial',
            userId: 'user-1',
            ...data,
            feeSavingsUsed: BigInt(0),
            cancelledAt: null,
            lastPaymentAt: null,
            createdAt: new Date(),
            updatedAt: new Date(),
          })),
        },
        user: {
          findUnique: jest.fn().mockResolvedValue({ kahadePlusSince: null }),
          update: jest.fn().mockResolvedValue({}),
        },
      };
      mockPrisma.$transaction.mockImplementation(async (fn: (client: unknown) => Promise<unknown>) => fn(tx));

      const result = await service.subscribe('user-1', SubscriptionPlan.MONTHLY, undefined, undefined, { useTrial: true });

      expect(result.price).toBe(BigInt(0));
      expect(result.trialEndsAt).toEqual(result.currentPeriodEnd);
      expect(mockWalletService.verifyPin).not.toHaveBeenCalled();
      expect(tx.subscription.create).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({ price: BigInt(0), originalPrice: BigInt(MONTHLY_PRICE_SEN), trialEndsAt: expect.any(Date) }),
      }));
    });

    it('rejects a second lifetime trial before any wallet or subscription write', async () => {
      mockPrisma.subscription.findFirst.mockResolvedValueOnce({ id: 'prior-trial' });

      await expect(service.subscribe('user-1', SubscriptionPlan.MONTHLY, undefined, undefined, { useTrial: true })).rejects.toThrow(ConflictException);
      expect(mockPrisma.$transaction).not.toHaveBeenCalled();
      expect(mockWalletService.verifyPin).not.toHaveBeenCalled();
    });

    it('applies first-period subscription promo codes and increments campaign redemption atomically', async () => {
      mockPrisma.campaign.findFirst.mockResolvedValueOnce({
        id: 'campaign-1',
        promoCode: 'PLUS50',
        type: 'SUBSCRIPTION_DISCOUNT',
        status: 'ACTIVE',
        discountValue: null,
        discountPercent: 50,
        maxDiscount: null,
        targetMinRank: null,
        targetNewUserOnly: false,
        targetDormantDays: null,
        maxRedemptions: 10,
        currentRedemptions: 0,
      });
      mockPrisma.user.findUnique.mockResolvedValueOnce({ membershipRank: 'BRONZE', totalOrdersCompleted: 0 });
      const tx = {
        subscription: {
          findFirst: jest.fn().mockResolvedValue(null),
          create: jest.fn().mockImplementation(async ({ data }) => ({ id: 'sub-promo', userId: 'user-1', ...data })),
        },
        wallet: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
        walletTransaction: { create: jest.fn().mockResolvedValue({ id: 'wtx-1' }) },
        campaign: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
        user: {
          findUnique: jest.fn().mockResolvedValue({ kahadePlusSince: null }),
          update: jest.fn().mockResolvedValue({}),
        },
        $queryRaw: jest.fn().mockResolvedValue([{ id: 'wallet-1', userId: 'user-1', availableBalance: BigInt(MONTHLY_PRICE_SEN), totalBalance: BigInt(MONTHLY_PRICE_SEN), version: 1 }]),
      };
      mockPrisma.$transaction.mockImplementation(async (fn: (client: unknown) => Promise<unknown>) => fn(tx));

      const result = await service.subscribe('user-1', SubscriptionPlan.MONTHLY, '123456', '127.0.0.1', { promoCode: 'plus50' });

      expect(result.price).toBe(BigInt(MONTHLY_PRICE_SEN / 2));
      expect(tx.campaign.updateMany).toHaveBeenCalledWith(expect.objectContaining({
        where: expect.objectContaining({ id: 'campaign-1', status: 'ACTIVE' }),
        data: { currentRedemptions: { increment: 1 } },
      }));
      expect(tx.subscription.create).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({ originalPrice: BigInt(MONTHLY_PRICE_SEN) }),
      }));
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

  describe('pause/resume', () => {
    it('pauses an active subscription and clears Kahade Plus entitlement', async () => {
      const active = { ...mockActiveSubscription, status: SubscriptionStatus.ACTIVE, currentPeriodEnd: new Date(Date.now() + 86_400_000) };
      mockPrisma.subscription.findFirst.mockResolvedValueOnce(active);
      const tx = {
        subscription: {
          updateMany: jest.fn().mockResolvedValue({ count: 1 }),
          findUniqueOrThrow: jest.fn().mockResolvedValue({ ...active, status: SubscriptionStatus.PAUSED, pausedAt: new Date(), resumeAt: null }),
        },
        user: { update: jest.fn().mockResolvedValue({}) },
      };
      mockPrisma.$transaction.mockImplementation(async (fn: (client: unknown) => Promise<unknown>) => fn(tx));

      const result = await service.pause('user-1');

      expect(result.status).toBe(SubscriptionStatus.PAUSED);
      expect(tx.subscription.updateMany).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({ status: SubscriptionStatus.PAUSED, isAutoRenew: false }),
      }));
      expect(tx.user.update).toHaveBeenCalledWith(expect.objectContaining({ data: { isKahadePlus: false } }));
    });

    it('resumes a paused subscription and restores Kahade Plus entitlement', async () => {
      const paused = { ...mockActiveSubscription, status: SubscriptionStatus.PAUSED, currentPeriodEnd: new Date(Date.now() + 86_400_000) };
      mockPrisma.subscription.findFirst.mockResolvedValueOnce(paused);
      const tx = {
        subscription: {
          findUnique: jest.fn().mockResolvedValue(paused),
          updateMany: jest.fn().mockResolvedValue({ count: 1 }),
          findUniqueOrThrow: jest.fn().mockResolvedValue({ ...paused, status: SubscriptionStatus.ACTIVE, pausedAt: null, resumeAt: null }),
        },
        user: { update: jest.fn().mockResolvedValue({}) },
      };
      mockPrisma.$transaction.mockImplementation(async (fn: (client: unknown) => Promise<unknown>) => fn(tx));

      const result = await service.resume('user-1');

      expect(result.status).toBe(SubscriptionStatus.ACTIVE);
      expect(tx.subscription.updateMany).toHaveBeenCalledWith(expect.objectContaining({
        data: { status: SubscriptionStatus.ACTIVE, pausedAt: null, resumeAt: null },
      }));
      expect(tx.user.update).toHaveBeenCalledWith(expect.objectContaining({
        where: { id: 'user-1' },
        data: { isKahadePlus: true, subscriptionExpiresAt: paused.currentPeriodEnd },
      }));
    });
  });
});
