import { MilestoneStatus, NotificationType } from '@prisma/client';
import { MilestoneAutoReleaseService } from '../milestone-auto-release.service';
import type { MilestonesService } from '../../../milestones/milestones.service';
import { PrismaService } from '../../../../prisma/prisma.service';
import { RedisService } from '../../../../redis/redis.service';

jest.mock('../../../../common/utils/cron-jitter.util', () => ({
  cronJitter: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../../../../common/utils/redis-health.util', () => ({
  ensureRedisAvailable: jest.fn().mockResolvedValue(true),
  alertMoneyCronSkippedRedisDown: jest.fn(),
}));
jest.mock('../../common/money-alert.util', () => ({
  alertAdminsOnMoneyAnomaly: jest.fn().mockResolvedValue(true),
}));

import { alertAdminsOnMoneyAnomaly } from '../../common/money-alert.util';

const alertMock = alertAdminsOnMoneyAnomaly as unknown as jest.Mock;

const MILESTONE_ROW = {
  id: 'm-1',
  seq: 2,
  title: 'Tahap DP',
  acceptedAt: new Date(Date.now() - 6 * 24 * 3600_000), // 6 hari → jendela reminder
  order: { buyerId: 'buyer-1', title: 'Order uji' },
};

function makeService(autoReleaseResult: { checked: number; released: number; skipped: number; held: string[] }) {
  const notificationCreate = jest.fn().mockResolvedValue({});
  const prisma = {
    orderMilestone: { findMany: jest.fn().mockResolvedValue([MILESTONE_ROW]) },
    notification: { create: notificationCreate },
  } as unknown as PrismaService;
  const redis = {
    setNx: jest.fn().mockResolvedValue(true),
    setex: jest.fn().mockResolvedValue('OK'),
    releaseLock: jest.fn().mockResolvedValue(true),
  } as unknown as RedisService;
  const milestonesService = {
    autoReleaseStaleAccepted: jest.fn().mockResolvedValue(autoReleaseResult),
  } as unknown as MilestonesService;
  const svc = new MilestoneAutoReleaseService(prisma, redis, milestonesService);
  return { svc, notificationCreate, milestonesService };
}

describe('MilestoneAutoReleaseService (SYS-B-307)', () => {
  beforeEach(() => jest.clearAllMocks());

  it('ACCEPTED berumur 5–7 hari → reminder ke buyer (dedup 48 jam)', async () => {
    const { svc, notificationCreate } = makeService({ checked: 0, released: 0, skipped: 0, held: [] });
    await svc.runMilestoneAutoRelease();

    expect(notificationCreate).toHaveBeenCalledTimes(1);
    const data = notificationCreate.mock.calls[0][0].data;
    expect(data.userId).toBe('buyer-1');
    expect(data.type).toBe(NotificationType.MILESTONE_DEADLINE_REMINDER);
    expect(data.title).toContain('Dicairkan Otomatis');
    expect(data.refId).toBe('m-1');
    expect(alertMock).not.toHaveBeenCalled(); // tak ada yang DITAHAN
  });

  it('autoReleaseStaleAccepted dipanggil dengan limit 50', async () => {
    const { svc, milestonesService } = makeService({ checked: 1, released: 1, skipped: 0, held: [] });
    await svc.runMilestoneAutoRelease();
    expect(
      (milestonesService.autoReleaseStaleAccepted as unknown as jest.Mock),
    ).toHaveBeenCalledWith(50);
  });

  it('tahap DITAHAN (order tak valid) → alert admin, fail-closed', async () => {
    const { svc } = makeService({ checked: 1, released: 0, skipped: 1, held: ['m-9'] });
    await svc.runMilestoneAutoRelease();

    expect(alertMock).toHaveBeenCalledTimes(1);
    expect(alertMock.mock.calls[0][0].title).toContain('DITAHAN');
    expect(alertMock.mock.calls[0][0].body).toContain('m-9');
  });

  it('reminder tidak dikirim dua kali dalam 48 jam (dedup redis)', async () => {
    const { svc, notificationCreate } = makeService({ checked: 0, released: 0, skipped: 0, held: [] });
    // Simulasi: dedup key sudah ada → setNx false pada panggilan reminder,
    // tetapi lock cron (panggilan setNx pertama) tetap true.
    const redis = (svc as unknown as { redis: { setNx: jest.Mock } }).redis;
    redis.setNx
      .mockResolvedValueOnce(true) // lock cron
      .mockResolvedValue(false); // dedup reminder sudah ada
    await svc.runMilestoneAutoRelease();
    expect(notificationCreate).not.toHaveBeenCalled();
  });
});

describe('MilestoneStatus enum tersedia untuk query ACCEPTED', () => {
  it('ACCEPTED adalah nilai enum yang valid', () => {
    expect(MilestoneStatus.ACCEPTED).toBeDefined();
  });
});
