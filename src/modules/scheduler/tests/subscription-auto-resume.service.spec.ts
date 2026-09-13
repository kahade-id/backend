import { Test } from '@nestjs/testing';
import { SubscriptionStatus } from '@prisma/client';
import { SubscriptionAutoResumeService } from '../services/subscription-auto-resume.service';
import { PrismaService } from '../../../prisma/prisma.service';
import { RedisService } from '../../../redis/redis.service';
import { VerificationBadgeService } from '../../users/verification-badge.service';

jest.mock('../../../common/utils/cron-jitter.util', () => ({
  cronJitter: jest.fn(async () => undefined),
}));

describe('SubscriptionAutoResumeService', () => {
  it('auto-resumes paused subscriptions whose resumeAt has arrived', async () => {
    const paused = {
      id: 'sub-1',
      userId: 'user-1',
      status: SubscriptionStatus.PAUSED,
      resumeAt: new Date(Date.now() - 60_000),
      currentPeriodEnd: new Date(Date.now() + 86_400_000),
    };
    const tx = {
      subscription: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      user: { update: jest.fn().mockResolvedValue({}) },
    };
    const prisma = {
      subscription: {
        findMany: jest.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([paused]),
      },
      $transaction: jest.fn(async (fn: (client: typeof tx) => Promise<unknown>) => fn(tx)),
    };
    const redis = {
      isHealthy: jest.fn().mockResolvedValue(true),
      setNx: jest.fn().mockResolvedValue(true),
      releaseLock: jest.fn().mockResolvedValue(true),
      del: jest.fn().mockResolvedValue(1),
    };
    const badges = { invalidate: jest.fn().mockResolvedValue(undefined) };
    const module = await Test.createTestingModule({
      providers: [
        SubscriptionAutoResumeService,
        { provide: PrismaService, useValue: prisma },
        { provide: RedisService, useValue: redis },
        { provide: VerificationBadgeService, useValue: badges },
      ],
    }).compile();

    await module.get(SubscriptionAutoResumeService).handleAutoResume();

    expect(tx.subscription.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: 'sub-1', status: SubscriptionStatus.PAUSED }),
      data: { status: SubscriptionStatus.ACTIVE, pausedAt: null, resumeAt: null },
    }));
    expect(tx.user.update).toHaveBeenCalledWith({
      where: { id: 'user-1' },
      data: { isKahadePlus: true, subscriptionExpiresAt: paused.currentPeriodEnd },
    });
    expect(redis.del).toHaveBeenCalledWith('subscription_status:user-1');
    expect(badges.invalidate).toHaveBeenCalledWith('user-1');
  });
});
