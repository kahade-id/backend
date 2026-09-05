import { SubscriptionExpiryService } from '../services/subscription-expiry.service';

describe('SubscriptionExpiryService auto-renewal', () => {
  const prisma = {
    $transaction: jest.fn(),
    wallet: { findUnique: jest.fn(), updateMany: jest.fn() },
    walletTransaction: { create: jest.fn() },
    subscription: { updateMany: jest.fn() },
    user: { update: jest.fn() },
    notification: { create: jest.fn() },
    emitNotificationCreated: jest.fn(),
  };
  const redis = {};
  const serial = { getNext: jest.fn() };
  const config = {
    get: jest.fn((key: string) => {
      if (key === 'app.subscriptionMonthlyPriceSen') return 10000;
      if (key === 'app.subscriptionAnnualPriceSen') return 100000;
      if (key === 'app.feeSavingsLimit') return 5000000;
      return undefined;
    }),
  };

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-08-20T00:00:00.000Z'));
    serial.getNext.mockResolvedValue(1);
    prisma.wallet.findUnique.mockResolvedValue({ id: 'wallet-1', availableBalance: BigInt(50000), totalBalance: BigInt(50000), version: 1 });
    prisma.wallet.updateMany.mockResolvedValue({ count: 1 });
    prisma.walletTransaction.create.mockResolvedValue({});
    prisma.subscription.updateMany.mockResolvedValue({ count: 1 });
    prisma.user.update.mockResolvedValue({});
    prisma.notification.create.mockResolvedValue({});
    prisma.$transaction.mockImplementation(async (callback: (tx: typeof prisma) => Promise<unknown>) => callback(prisma));
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('renews from the present when an active subscription period is already long expired', async () => {
    const service = new SubscriptionExpiryService(prisma as never, redis as never, serial as never, config as never);

    const result = await (service as unknown as { tryAutoRenew: (subscription: unknown) => Promise<string> }).tryAutoRenew({
      id: 'sub-1',
      userId: 'user-1',
      plan: 'MONTHLY',
      status: 'ACTIVE',
      currentPeriodEnd: new Date('2026-01-01T00:00:00.000Z'),
      user: { id: 'user-1' },
    });

    expect(result).toBe('SUCCESS');
    expect(prisma.subscription.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        currentPeriodEnd: new Date('2026-09-19T00:00:00.000Z'),
      }),
    }));
  });
});
