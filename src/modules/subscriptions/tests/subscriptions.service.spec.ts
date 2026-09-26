import { Test, TestingModule } from '@nestjs/testing';
import { ConflictException, BadRequestException, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SubscriptionsService } from '../subscriptions.service';
import { PrismaService } from '../../../prisma/prisma.service';
import { RedisService } from '../../../redis/redis.service';
import { WalletTxSerialService } from '../../../common/services/wallet-tx-serial.service';
import { AuditLogService } from '../../../common/services/audit-log.service';
import { WalletService } from '../../wallet/wallet.service';
import { VerificationBadgeService } from '../../users/verification-badge.service';
import { FlashQrisService } from '../../payment/flash-qris.service';
import { SubscriptionPlan, SubscriptionStatus, KycStatus } from '@prisma/client';

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
  subscriptionPromoCode: {
    findUnique: jest.fn(),
    updateMany: jest.fn(),
  },
  subscriptionUsage: {
    upsert: jest.fn(),
    findUnique: jest.fn(),
    update: jest.fn(),
  },
  $queryRaw: jest.fn().mockResolvedValue([]),
  $executeRaw: jest.fn().mockResolvedValue(1),
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

const MONTHLY_PRICE_IDR = 99_000;
const YEARLY_PRICE_IDR = 899_000;
const MONTHLY_PRICE_SEN = MONTHLY_PRICE_IDR * 100;
const YEARLY_PRICE_SEN = YEARLY_PRICE_IDR * 100;

const mockConfigService = {
  get: jest.fn().mockImplementation((key: string) => {
    const config: Record<string, unknown> = {
      'app.subscriptionMonthlyPriceSen': MONTHLY_PRICE_SEN,
      'app.subscriptionYearlyPriceSen': YEARLY_PRICE_SEN,
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

const mockFlashQrisService = {
  createQrisPayment: jest.fn(),
  getPaymentStatus: jest.fn(),
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
        { provide: FlashQrisService, useValue: mockFlashQrisService },
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

      await expect(service.subscribe('user-1', SubscriptionPlan.YEARLY, '123456')).rejects.toThrow(ConflictException);
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

    it('redeems an admin promo code: free subscription with admin-set duration, no PIN', async () => {
      mockPrisma.subscriptionPromoCode.findUnique.mockResolvedValueOnce({
        id: 'promo-1',
        code: 'VIP30',
        durationDays: 30,
        maxRedemptions: 1,
        currentRedemptions: 0,
        assignedUserId: null,
        status: 'ACTIVE',
        expiresAt: null,
      });
      const tx = {
        subscription: {
          findFirst: jest.fn().mockResolvedValue(null),
          create: jest.fn().mockImplementation(async ({ data }) => ({
            id: 'sub-promo',
            userId: 'user-1',
            ...data,
            feeSavingsUsed: BigInt(0),
            cancelledAt: null,
            lastPaymentAt: null,
            createdAt: new Date(),
            updatedAt: new Date(),
          })),
        },
        subscriptionPromoCode: {
          updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        },
        user: {
          findUnique: jest.fn().mockResolvedValue({ kahadePlusSince: null }),
          update: jest.fn().mockResolvedValue({}),
        },
      };
      mockPrisma.$transaction.mockImplementation(async (fn: (client: unknown) => Promise<unknown>) => fn(tx));

      const result = await service.subscribe('user-1', SubscriptionPlan.MONTHLY, undefined, undefined, { promoCode: 'vip30' });

      expect(result.price).toBe(BigInt(0));
      expect(mockWalletService.verifyPin).not.toHaveBeenCalled();
      expect(tx.subscriptionPromoCode.updateMany).toHaveBeenCalled();
      expect(tx.subscription.create).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({ price: BigInt(0), originalPrice: BigInt(MONTHLY_PRICE_SEN), promoCodeUsed: 'VIP30' }),
      }));
      // Durasi dari admin (30 hari), bukan durasi paket.
      const created = (tx.subscription.create as jest.Mock).mock.calls[0][0].data;
      const days = Math.round((created.currentPeriodEnd.getTime() - created.currentPeriodStart.getTime()) / 86_400_000);
      expect(days).toBe(30);
    });

    it('rejects a promo code assigned to another user', async () => {
      mockPrisma.subscriptionPromoCode.findUnique.mockResolvedValueOnce({
        id: 'promo-2',
        code: 'VIP-ABDUL',
        durationDays: 14,
        maxRedemptions: 1,
        currentRedemptions: 0,
        assignedUserId: 'user-other',
        status: 'ACTIVE',
        expiresAt: null,
      });

      await expect(service.subscribe('user-1', SubscriptionPlan.MONTHLY, undefined, undefined, { promoCode: 'VIP-ABDUL' })).rejects.toThrow(BadRequestException);
      expect(mockPrisma.$transaction).not.toHaveBeenCalled();
      expect(mockWalletService.verifyPin).not.toHaveBeenCalled();
    });

    it('rejects an exhausted promo code', async () => {
      mockPrisma.subscriptionPromoCode.findUnique.mockResolvedValueOnce({
        id: 'promo-3',
        code: 'ONE-TIME',
        durationDays: 7,
        maxRedemptions: 1,
        currentRedemptions: 1,
        assignedUserId: null,
        status: 'ACTIVE',
        expiresAt: null,
      });

      await expect(service.subscribe('user-1', SubscriptionPlan.MONTHLY, undefined, undefined, { promoCode: 'ONE-TIME' })).rejects.toThrow(BadRequestException);
      expect(mockPrisma.$transaction).not.toHaveBeenCalled();
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

  describe('cancel at period end / reactivate', () => {
    it('cancel keeps status ACTIVE with cancelAtPeriodEnd=true (benefit jalan terus)', async () => {
      const active = { ...mockActiveSubscription, status: SubscriptionStatus.ACTIVE, cancelAtPeriodEnd: false, currentPeriodEnd: new Date(Date.now() + 86_400_000) };
      mockPrisma.subscription.findFirst.mockResolvedValueOnce(active);
      const tx = {
        subscription: {
          updateMany: jest.fn().mockResolvedValue({ count: 1 }),
          findUniqueOrThrow: jest.fn().mockResolvedValue({ ...active, cancelAtPeriodEnd: true, isAutoRenew: false }),
        },
      };
      mockPrisma.$transaction.mockImplementation(async (fn: (client: unknown) => Promise<unknown>) => fn(tx));

      const result = await service.cancel('user-1');

      expect(result.status).toBe(SubscriptionStatus.ACTIVE);
      expect(result.cancelAtPeriodEnd).toBe(true);
      expect(tx.subscription.updateMany).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({ cancelAtPeriodEnd: true, isAutoRenew: false }),
      }));
      // TIDAK ada transisi ke CANCELLED.
      const dataArg = (tx.subscription.updateMany as jest.Mock).mock.calls[0][0].data;
      expect(dataArg.status).toBeUndefined();
    });

    it('cancel twice is rejected', async () => {
      const active = { ...mockActiveSubscription, status: SubscriptionStatus.ACTIVE, cancelAtPeriodEnd: true };
      mockPrisma.subscription.findFirst.mockResolvedValueOnce(active);

      await expect(service.cancel('user-1')).rejects.toThrow(ConflictException);
      expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    });

    it('reactivate clears cancelAtPeriodEnd and re-enables auto-renew', async () => {
      const cancelled = { ...mockActiveSubscription, status: SubscriptionStatus.ACTIVE, cancelAtPeriodEnd: true, currentPeriodEnd: new Date(Date.now() + 86_400_000) };
      mockPrisma.subscription.findFirst.mockResolvedValueOnce(cancelled);
      mockPrisma.subscription.update.mockResolvedValueOnce({ ...cancelled, cancelAtPeriodEnd: false, isAutoRenew: true });

      const result = await service.reactivate('user-1');

      expect(result.cancelAtPeriodEnd).toBe(false);
      expect(result.isAutoRenew).toBe(true);
      expect(mockPrisma.subscription.update).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({ cancelAtPeriodEnd: false, isAutoRenew: true }),
      }));
    });

    it('reactivate without a pending cancellation is rejected', async () => {
      mockPrisma.subscription.findFirst.mockResolvedValueOnce(null);

      await expect(service.reactivate('user-1')).rejects.toThrow(NotFoundException);
    });
  });

  describe('Kahade+ source of truth & benefits', () => {
    const futureEnd = () => new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    const activeSub = () => ({
      ...mockActiveSubscription,
      id: 'sub-active',
      plan: SubscriptionPlan.MONTHLY,
      status: SubscriptionStatus.ACTIVE,
      currentPeriodStart: new Date(),
      currentPeriodEnd: futureEnd(),
    });

    describe('isActive / getSubscription', () => {
      it('isActive returns true only for ACTIVE subscription with unexpired period', async () => {
        mockPrisma.subscription.findFirst.mockResolvedValueOnce(activeSub());
        await expect(service.isActive('user-1')).resolves.toBe(true);
        expect(mockPrisma.subscription.findFirst).toHaveBeenCalledWith(
          expect.objectContaining({
            where: expect.objectContaining({
              userId: 'user-1',
              status: SubscriptionStatus.ACTIVE,
              currentPeriodEnd: expect.objectContaining({ gt: expect.any(Date) }),
            }),
          }),
        );
      });

      it('isActive returns false when no ACTIVE subscription exists', async () => {
        mockPrisma.subscription.findFirst.mockResolvedValueOnce(null);
        await expect(service.isActive('user-1')).resolves.toBe(false);
      });

      it('getSubscription returns the active row, or null', async () => {
        const sub = activeSub();
        mockPrisma.subscription.findFirst.mockResolvedValueOnce(sub);
        await expect(service.getSubscription('user-1')).resolves.toBe(sub);
        mockPrisma.subscription.findFirst.mockResolvedValueOnce(null);
        await expect(service.getSubscription('user-1')).resolves.toBeNull();
      });
    });

    describe('getMe', () => {
      it('returns the spec shape for an active subscriber', async () => {
        const sub = activeSub();
        mockPrisma.subscription.findFirst.mockResolvedValueOnce(sub); // getSubscription()
        mockPrisma.subscription.findFirst.mockResolvedValueOnce(sub); // getFeeWaivedThisPeriod()
        mockPrisma.subscriptionUsage.findUnique.mockResolvedValueOnce({ feeWaivedAmount: BigInt(1_000_000) });
        mockPrisma.user.findUnique.mockResolvedValueOnce({
          kycStatus: KycStatus.APPROVED,
          emailVerified: true,
          phoneVerified: true,
          address: 'Jl. Merdeka No. 1',
        });

        const me = await service.getMe('user-1');

        expect(me).toEqual({
          isActive: true,
          plan: SubscriptionPlan.MONTHLY,
          status: SubscriptionStatus.ACTIVE,
          currentPeriodStart: sub.currentPeriodStart,
          currentPeriodEnd: sub.currentPeriodEnd,
          cancelAtPeriodEnd: false,
          feeWaivedThisPeriod: 10_000, // 1.000.000 sen
          feeWaiverLimit: 990_000, // PLUS_FEE_WAIVER_QUOTA_SEN default
          showGreyBadge: true,
          earlyAccess: { patungan: true, 'split-bill': true },
        });
      });

      it('returns inactive shape when user has no subscription', async () => {
        mockPrisma.subscription.findFirst.mockResolvedValueOnce(null);

        const me = await service.getMe('user-1');

        expect(me).toEqual({
          isActive: false,
          plan: null,
          status: null,
          currentPeriodStart: null,
          currentPeriodEnd: null,
          cancelAtPeriodEnd: false,
          feeWaivedThisPeriod: 0,
          feeWaiverLimit: 990_000,
          showGreyBadge: false,
          earlyAccess: { patungan: false, 'split-bill': false },
        });
      });
    });

    describe('hasGreyBadge (Benefit 2)', () => {
      it('returns true only when subscriber is active AND KYC is complete', async () => {
        mockPrisma.subscription.findFirst.mockResolvedValueOnce(activeSub());
        mockPrisma.user.findUnique.mockResolvedValueOnce({
          kycStatus: KycStatus.APPROVED,
          emailVerified: true,
          phoneVerified: true,
          address: 'Jl. Merdeka No. 1',
        });
        await expect(service.hasGreyBadge('user-1')).resolves.toBe(true);
      });

      it('returns false when KYC is incomplete (missing address)', async () => {
        mockPrisma.subscription.findFirst.mockResolvedValueOnce(activeSub());
        mockPrisma.user.findUnique.mockResolvedValueOnce({
          kycStatus: KycStatus.APPROVED,
          emailVerified: true,
          phoneVerified: true,
          address: '  ',
        });
        await expect(service.hasGreyBadge('user-1')).resolves.toBe(false);
      });

      it('returns false for non-subscribers without touching the user table', async () => {
        mockPrisma.subscription.findFirst.mockResolvedValueOnce(null);
        await expect(service.hasGreyBadge('user-1')).resolves.toBe(false);
        expect(mockPrisma.user.findUnique).not.toHaveBeenCalled();
      });
    });

    describe('isFeatureEnabled (Benefit 6)', () => {
      it('gates early-access features on active subscription', async () => {
        mockPrisma.subscription.findFirst.mockResolvedValueOnce(activeSub());
        await expect(service.isFeatureEnabled('user-1', 'patungan')).resolves.toBe(true);
        mockPrisma.subscription.findFirst.mockResolvedValueOnce(null);
        await expect(service.isFeatureEnabled('user-1', 'split-bill')).resolves.toBe(false);
      });

      it('returns false for unknown features', async () => {
        await expect(service.isFeatureEnabled('user-1', 'unknown-feature' as never)).resolves.toBe(false);
      });
    });

    describe('getMaxShowcaseImages (Benefit 7)', () => {
      it('returns 18 for active subscribers, 8 otherwise', async () => {
        mockPrisma.subscription.findFirst.mockResolvedValueOnce(activeSub());
        await expect(service.getMaxShowcaseImages('user-1')).resolves.toBe(18);
        mockPrisma.subscription.findFirst.mockResolvedValueOnce(null);
        await expect(service.getMaxShowcaseImages('user-1')).resolves.toBe(8);
      });
    });

    describe('waiveFeeIfEligible (Benefit 1)', () => {
      const feeSen = BigInt(250_000); // Rp 2.500
      // Awal bulan kalender WIB — cerminan getQuotaMonthStart di service.
      const monthStartWib = () => {
        const now = new Date();
        const wib = new Date(now.getTime() + 7 * 60 * 60 * 1000);
        return new Date(Date.UTC(wib.getUTCFullYear(), wib.getUTCMonth(), 1) - 7 * 60 * 60 * 1000);
      };

      it('returns the fee unchanged when user has no active subscription', async () => {
        mockPrisma.subscription.findFirst.mockResolvedValueOnce(null);
        await expect(service.waiveFeeIfEligible('user-1', feeSen)).resolves.toBe(feeSen);
        expect(mockPrisma.subscriptionUsage.upsert).not.toHaveBeenCalled();
      });

      it('waives the fee to zero and records usage when quota is available', async () => {
        const sub = activeSub();
        mockPrisma.subscription.findFirst.mockResolvedValueOnce({ id: sub.id });
        mockPrisma.subscriptionUsage.upsert.mockResolvedValueOnce({ id: 'usage-1' });
        // Baris usage dikunci (SELECT FOR UPDATE) lalu dibaca sisa kuota.
        mockPrisma.$queryRaw.mockResolvedValueOnce([{ feeWaivedAmount: BigInt(0) }]);

        await expect(service.waiveFeeIfEligible('user-1', feeSen)).resolves.toBe(BigInt(0));

        expect(mockPrisma.subscriptionUsage.upsert).toHaveBeenCalledWith(
          expect.objectContaining({
            where: {
              subscriptionId_periodStart: {
                subscriptionId: sub.id,
                periodStart: monthStartWib(),
              },
            },
          }),
        );
        expect(mockPrisma.subscriptionUsage.update).toHaveBeenCalledWith({
          where: { id: 'usage-1' },
          data: { feeWaivedAmount: feeSen },
        });
      });

      it('uses monthly quota period even for YEARLY subscriptions', async () => {
        const sub = activeSub();
        mockPrisma.subscription.findFirst.mockResolvedValueOnce({ id: sub.id });
        mockPrisma.subscriptionUsage.upsert.mockResolvedValueOnce({ id: 'usage-1' });
        mockPrisma.$queryRaw.mockResolvedValueOnce([{ feeWaivedAmount: BigInt(0) }]);

        await service.waiveFeeIfEligible('user-1', feeSen);

        const periodStart = mockPrisma.subscriptionUsage.upsert.mock.calls[0][0].where
          .subscriptionId_periodStart.periodStart as Date;
        const expected = monthStartWib();
        expect(periodStart.getTime()).toBe(expected.getTime());
        // Bukan currentPeriodStart billing (yang untuk YEARLY bisa setahun).
        expect(periodStart.getTime()).not.toBe(sub.currentPeriodStart.getTime());
      });

      it('applies partial waiver when remaining quota is smaller than the fee', async () => {
        const sub = activeSub();
        mockPrisma.subscription.findFirst.mockResolvedValueOnce({ id: sub.id });
        mockPrisma.subscriptionUsage.upsert.mockResolvedValueOnce({ id: 'usage-1' });
        // Sisa kuota Rp 1.000 (= 100.000 sen), fee Rp 2.500 (= 250.000 sen).
        mockPrisma.$queryRaw.mockResolvedValueOnce([{ feeWaivedAmount: BigInt(98_900_000) }]);

        await expect(service.waiveFeeIfEligible('user-1', feeSen)).resolves.toBe(BigInt(150_000));

        expect(mockPrisma.subscriptionUsage.update).toHaveBeenCalledWith({
          where: { id: 'usage-1' },
          data: { feeWaivedAmount: BigInt(99_000_000) },
        });
      });

      it('returns the fee unchanged when the monthly quota is exhausted', async () => {
        const sub = activeSub();
        mockPrisma.subscription.findFirst.mockResolvedValueOnce({ id: sub.id });
        mockPrisma.subscriptionUsage.upsert.mockResolvedValueOnce({ id: 'usage-1' });
        // Kuota Rp 990.000 (= 99.000.000 sen) sudah habis dipakai bulan ini.
        mockPrisma.$queryRaw.mockResolvedValueOnce([{ feeWaivedAmount: BigInt(99_000_000) }]);

        await expect(service.waiveFeeIfEligible('user-1', feeSen)).resolves.toBe(feeSen);
        expect(mockPrisma.subscriptionUsage.update).not.toHaveBeenCalled();
      });

      it('passes through zero/negative fees without touching the DB', async () => {
        await expect(service.waiveFeeIfEligible('user-1', BigInt(0))).resolves.toBe(BigInt(0));
        expect(mockPrisma.subscription.findFirst).not.toHaveBeenCalled();
      });
    });
  });
});
