/**
 * B1-001: cache Redis untuk sinyal afinitas + merged candidate pool feed
 * "Untuk Anda". Menjamin: (1) halaman 2+ tidak me-refetch 3 pool + 2 query
 * sinyal; (2) hasil/ranking IDENTIK antara cache miss dan cache hit;
 * (3) filter berbeda / viewer berbeda -> cache key berbeda.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { ShowcaseService } from '../showcase.service';
import { PrismaService } from '../../../prisma/prisma.service';
import { RedisService } from '../../../redis/redis.service';
import { UploadService } from '../../upload/upload.service';
import { SubscriptionsService } from '../../subscriptions/subscriptions.service';
import { AdminShowcaseReportsService } from '../../admin/showcase-reports/admin-showcase-reports.service';
import { AuditLogService } from '../../../common/services/audit-log.service';
import { VerificationBadgeService } from '../../users/verification-badge.service';

const row = (id: string, userId: string, category: string, minutesAgo: number, hotViews = 10, likeCount = 5) => ({
  id,
  userId,
  category,
  createdAt: new Date(Date.now() - minutesAgo * 60_000),
  hotViews,
  likeCount,
});

describe('B1-001 getForYouFeed cache', () => {
  let service: ShowcaseService;
  let mockPrisma: any;
  let redisStore: Map<string, string>;

  async function buildService() {
    redisStore = new Map();
    mockPrisma = {
      // Sinyal: bedakan query sinyal (take 200/500, tanpa filter showcaseId)
      // dari query liked-ids (ada showcaseId.in).
      showcaseLike: {
        findMany: jest.fn(async (args: any) => {
          if (args?.where?.showcaseId) return [];
          return [
            { showcase: { category: 'Elektronik' } },
            { showcase: { category: 'Elektronik' } },
            { showcase: { category: 'Fashion' } },
          ];
        }),
      },
      follow: {
        findMany: jest.fn(async (args: any) => {
          if (args?.where?.followingId) return [];
          return [{ followingId: 'seller-1' }];
        }),
      },
      // 3 pool: bedakan dari klausa where.
      userShowcase: {
        findMany: jest.fn(async (args: any) => {
          if (args?.where?.category?.in) {
            return [row('aff-1', 'seller-9', 'elektronik', 60), row('aff-2', 'seller-9', 'elektronik', 120)];
          }
          if (args?.where?.userId?.in) {
            return [row('fol-1', 'seller-1', 'fashion', 30)];
          }
          return [row('rec-1', 'seller-2', 'otomotif', 10), row('aff-1', 'seller-9', 'elektronik', 60)];
        }),
      },
    };
    const mockRedis = {
      get: jest.fn(async (key: string) => redisStore.get(key) ?? null),
      set: jest.fn(async (key: string, value: string) => {
        redisStore.set(key, value);
      }),
      setNx: jest.fn().mockResolvedValue(true),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ShowcaseService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: RedisService, useValue: mockRedis },
        { provide: UploadService, useValue: {} },
        { provide: ConfigService, useValue: { get: jest.fn(() => undefined) } },
        { provide: AuditLogService, useValue: { logUserAction: jest.fn(), logAdminAction: jest.fn() } },
        { provide: VerificationBadgeService, useValue: { getBadgesBatch: jest.fn().mockResolvedValue(new Map()) } },
        { provide: SubscriptionsService, useValue: {} },
        { provide: AdminShowcaseReportsService, useValue: {} },
      ],
    }).compile();
    service = module.get<ShowcaseService>(ShowcaseService);
    // Jangan sentuh serializeFeedPage asli (milik Tim Data) — cukup intip
    // baris yang diteruskan (sudah di-ranking).
    jest
      .spyOn(service as any, 'serializeFeedPage')
      .mockImplementation(async (...args: unknown[]) => ({ ids: (args[1] as any[]).map((r) => r.id) }));
  }

  const callFeed = (viewerId = 'viewer-1', andClauses: any[] = []) =>
    (service as any).getForYouFeed(viewerId, { visibility: 'PUBLIC' }, andClauses, {}, 20);

  beforeEach(async () => {
    await buildService();
  });

  it('halaman 2 (request ulang): tanpa query pool & sinyal baru, hasil identik', async () => {
    const first = await callFeed();
    expect(mockPrisma.userShowcase.findMany).toHaveBeenCalledTimes(3);
    const signalCallsAfterFirst =
      mockPrisma.showcaseLike.findMany.mock.calls.length + mockPrisma.follow.findMany.mock.calls.length;

    const second = await callFeed();
    // TIDAK ada query DB baru untuk pool maupun sinyal.
    expect(mockPrisma.userShowcase.findMany).toHaveBeenCalledTimes(3);
    expect(
      mockPrisma.showcaseLike.findMany.mock.calls.length + mockPrisma.follow.findMany.mock.calls.length,
    ).toBe(signalCallsAfterFirst);
    // Ranking & hasil identik bit-per-bit.
    expect(second).toEqual(first);
    expect(first.ids).toEqual(['fol-1', 'aff-1', 'aff-2', 'rec-1']);
  });

  it('filter berbeda -> cache key berbeda -> pool di-fetch ulang', async () => {
    await callFeed();
    expect(mockPrisma.userShowcase.findMany).toHaveBeenCalledTimes(3);
    await callFeed('viewer-1', [{ category: 'fashion' }]);
    expect(mockPrisma.userShowcase.findMany).toHaveBeenCalledTimes(6);
  });

  it('viewer berbeda -> sinyal & pool di-fetch ulang', async () => {
    await callFeed('viewer-1');
    const poolCalls = mockPrisma.userShowcase.findMany.mock.calls.length;
    await callFeed('viewer-2');
    expect(mockPrisma.userShowcase.findMany.mock.calls.length).toBeGreaterThan(poolCalls);
  });

  it('Redis down (get/set melempar) -> fail-open, hasil tetap benar', async () => {
    const failingRedis = {
      get: jest.fn().mockRejectedValue(new Error('redis down')),
      set: jest.fn().mockRejectedValue(new Error('redis down')),
      setNx: jest.fn().mockResolvedValue(true),
    };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ShowcaseService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: RedisService, useValue: failingRedis },
        { provide: UploadService, useValue: {} },
        { provide: ConfigService, useValue: { get: jest.fn(() => undefined) } },
        { provide: AuditLogService, useValue: { logUserAction: jest.fn(), logAdminAction: jest.fn() } },
        { provide: VerificationBadgeService, useValue: { getBadgesBatch: jest.fn().mockResolvedValue(new Map()) } },
        { provide: SubscriptionsService, useValue: {} },
        { provide: AdminShowcaseReportsService, useValue: {} },
      ],
    }).compile();
    const svc = module.get<ShowcaseService>(ShowcaseService);
    jest
      .spyOn(svc as any, 'serializeFeedPage')
      .mockImplementation(async (...args: unknown[]) => ({ ids: (args[1] as any[]).map((r) => r.id) }));
    const res = await (svc as any).getForYouFeed('viewer-1', { visibility: 'PUBLIC' }, [], {}, 20);
    expect(res.ids).toEqual(['fol-1', 'aff-1', 'aff-2', 'rec-1']);
  });
});
