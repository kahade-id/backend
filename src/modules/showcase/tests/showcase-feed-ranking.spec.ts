import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { ShowcaseVisibility } from '@prisma/client';
import { ShowcaseService } from '../showcase.service';
import { ShowcaseFeedQueryDto } from '../dto/showcase-feed-query.dto';
import { PrismaService } from '../../../prisma/prisma.service';
import { RedisService } from '../../../redis/redis.service';
import { UploadService } from '../../upload/upload.service';
import { AuditLogService } from '../../../common/services/audit-log.service';
import { VerificationBadgeService } from '../../users/verification-badge.service';
import { SubscriptionsService } from '../../subscriptions/subscriptions.service';
import { AdminShowcaseReportsService } from '../../admin/showcase-reports/admin-showcase-reports.service';
import * as ErrorCodes from '../../../common/constants/error-codes';

const USER_A = 'user-a';
const USER_B = 'user-b';
const USER_C = 'user-c';
const USER_D = 'user-d';
const USER_E = 'user-e';

/** Baris etalase untuk test ranking: semua field yang dipakai skor/serialisasi. */
function rankRow(index: number, overrides: Record<string, unknown> = {}) {
  const id = `cshowcase${String(index).padStart(18, '0')}`;
  const twoHoursAgo = new Date(Date.now() - 2 * 3600 * 1000);
  return {
    id,
    userId: `seller-${index}`,
    title: `Item ${index}`,
    description: `Deskripsi item ${index}.`,
    category: 'netral',
    visibility: ShowcaseVisibility.PUBLIC,
    priceMin: BigInt(100000),
    priceMax: null,
    isActive: true,
    sortOrder: 0,
    likeCount: 5,
    commentCount: 0,
    viewCount: 100,
    // hotViews: view pada hari kalender berjalan (populer harian).
    hotViews: 10,
    hotViewDate: null,
    createdAt: twoHoursAgo,
    updatedAt: twoHoursAgo,
    images: [{ id: `img-${index}`, imageUrl: `https://cdn.test/${index}.jpg`, sortOrder: 0 }],
    user: {
      id: `seller-${index}`,
      userId: `USR-${index}`,
      username: `seller${index}`,
      fullName: `Seller ${index}`,
      avatarUrl: null,
      kycStatus: 'APPROVED',
      isVip: false,
      membershipRank: 'BRONZE',
    },
    ...overrides,
  };
}

function decodeCursor(cursor: string): any {
  return JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
}

/** Sinyal like per user: daftar kategori yang di-like (untuk getForYouSignals). */
let likeSignals: Record<string, Array<{ showcase: { category: string | null } }>> = {};
/** Sinyal follow per user: daftar seller yang di-follow. */
let followSignals: Record<string, Array<{ followingId: string }>> = {};
/** Dataset pool kandidat (peran "DB" untuk 3 pool foryou). */
let poolRows: any[] = [];

const mockPrisma: any = {
  blockList: { findMany: jest.fn() },
  userShowcase: { findMany: jest.fn() },
  showcaseLike: { findMany: jest.fn() },
  follow: { findMany: jest.fn() },
};
const mockRedis = { setNx: jest.fn() };
const mockUpload = {
  verifyUserFileKeys: jest.fn(),
  buildPublicUrl: jest.fn((key: string) => `https://cdn.test/${key}`),
  cleanupFileKeys: jest.fn(),
  uploadDirect: jest.fn(),
};
const mockConfig = { get: jest.fn() };
const mockSubscriptions = {
  isActive: jest.fn().mockResolvedValue(false),
  getMaxShowcaseImages: jest.fn().mockResolvedValue(8),
};

const feed = (service: ShowcaseService, viewerId: string | undefined, query: Partial<ShowcaseFeedQueryDto>) =>
  service.getFeed(viewerId, query as ShowcaseFeedQueryDto);

describe('ShowcaseService.getFeed — ranking foryou & popular harian', () => {
  let service: ShowcaseService;

  beforeEach(async () => {
    jest.clearAllMocks();
    likeSignals = {};
    followSignals = {};
    poolRows = [];
    mockPrisma.blockList.findMany.mockResolvedValue([]);
    // Peran "DB": pool afinitas disaring kategori, pool followed disaring
    // userId, pool recent mengembalikan semuanya (service yang memberi skor
    // + mengurutkan di aplikasi).
    mockPrisma.userShowcase.findMany.mockImplementation((args: any) => {
      const w = args?.where ?? {};
      if (w.category?.in) return Promise.resolve(poolRows.filter((r) => w.category.in.includes(r.category)));
      if (w.userId?.in) return Promise.resolve(poolRows.filter((r) => w.userId.in.includes(r.userId)));
      return Promise.resolve(poolRows);
    });
    // Dua pemakaian showcaseLike: sinyal afinitas (where: {userId}) dan
    // lookup isLiked (where: {userId, showcaseId: {in}}).
    mockPrisma.showcaseLike.findMany.mockImplementation((args: any) => {
      if (args?.where?.showcaseId?.in) return Promise.resolve([]);
      return Promise.resolve(likeSignals[args?.where?.userId] ?? []);
    });
    mockPrisma.follow.findMany.mockImplementation((args: any) =>
      Promise.resolve(followSignals[args?.where?.followerId] ?? []),
    );

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ShowcaseService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: RedisService, useValue: mockRedis },
        { provide: UploadService, useValue: mockUpload },
        { provide: ConfigService, useValue: mockConfig },
        { provide: AuditLogService, useValue: { logUserAction: jest.fn(), logAdminAction: jest.fn() } },
        { provide: VerificationBadgeService, useValue: { getBadges: jest.fn().mockResolvedValue([]) } },
        { provide: SubscriptionsService, useValue: mockSubscriptions },
        { provide: AdminShowcaseReportsService, useValue: { linkReportToCluster: jest.fn() } },
      ],
    }).compile();
    service = module.get<ShowcaseService>(ShowcaseService);
  });

  describe('sort=foryou — personalisasi per user', () => {
    beforeEach(() => {
      // Semua item: umur & keramaian sama → hanya afinitas kategori yang
      // membedakan skor.
      poolRows = [
        rankRow(1, { category: 'fotografi' }),
        rankRow(2, { category: 'fotografi' }),
        rankRow(3, { category: 'kuliner' }),
        rankRow(4, { category: 'kuliner' }),
        rankRow(5, { category: 'jasa' }),
      ];
      likeSignals = {
        [USER_A]: [
          { showcase: { category: 'fotografi' } },
          { showcase: { category: 'fotografi' } },
          { showcase: { category: 'fotografi' } },
        ],
        [USER_B]: [
          { showcase: { category: 'kuliner' } },
          { showcase: { category: 'kuliner' } },
          { showcase: { category: 'kuliner' } },
        ],
      };
    });

    it('memberi urutan berbeda untuk dua user dengan riwayat like berbeda', async () => {
      const a = (await feed(service, USER_A, { sort: 'foryou', limit: 10 })) as any;
      const b = (await feed(service, USER_B, { sort: 'foryou', limit: 10 })) as any;
      expect(a.sort).toBe('foryou');
      expect(b.sort).toBe('foryou');
      const orderA = a.items.map((i: any) => i.category);
      const orderB = b.items.map((i: any) => i.category);
      // User A (suka fotografi): item fotografi di atas.
      expect(orderA.slice(0, 2)).toEqual(['fotografi', 'fotografi']);
      // User B (suka kuliner): item kuliner di atas.
      expect(orderB.slice(0, 2)).toEqual(['kuliner', 'kuliner']);
      // Hasilnya benar-benar berbeda antar user.
      expect(orderA).not.toEqual(orderB);
    });

    it('memberi boost besar untuk seller yang di-follow (mengalahkan kesegaran)', async () => {
      poolRows = [
        rankRow(1, { userId: 'seller-x', category: 'jasa', createdAt: new Date(Date.now() - 20 * 3600 * 1000) }),
        rankRow(2, { userId: 'seller-y', category: 'jasa', createdAt: new Date(Date.now() - 1 * 3600 * 1000) }),
      ];
      likeSignals = {};
      followSignals = { [USER_C]: [{ followingId: 'seller-x' }] };
      const result = (await feed(service, USER_C, { sort: 'foryou', limit: 10 })) as any;
      const ids = result.items.map((i: any) => i.id);
      // Item seller-x (20 jam lalu, di-follow) mengalahkan item seller-y (1 jam lalu).
      expect(ids[0]).toBe(poolRows[0].id);
    });

    it('meneruskan filter query (kategori/search/harga/lokasi) ke semua pool kandidat', async () => {
      await feed(service, USER_A, { sort: 'foryou', category: 'fotografi' });
      const recentPoolWhere = mockPrisma.userShowcase.findMany.mock.calls.at(-1)[0].where;
      expect(recentPoolWhere.AND).toEqual(expect.arrayContaining([{ category: 'fotografi' }]));
    });
  });

  describe('sort=foryou — fallback', () => {
    it('tamu (tanpa viewerId) mendapat populer harian', async () => {
      const result = (await feed(service, undefined, { sort: 'foryou' })) as any;
      expect(result.sort).toBe('popular');
      expect(mockPrisma.follow.findMany).not.toHaveBeenCalled();
      expect(mockPrisma.userShowcase.findMany.mock.calls[0][0].orderBy).toEqual([
        { hotViews: 'desc' },
        { createdAt: 'desc' },
        { id: 'desc' },
      ]);
    });

    it('user tanpa sinyal (cold start) mendapat populer harian', async () => {
      likeSignals = {};
      followSignals = {};
      const result = (await feed(service, USER_D, { sort: 'foryou' })) as any;
      expect(result.sort).toBe('popular');
    });
  });

  describe('sort=foryou — cursor', () => {
    beforeEach(() => {
      poolRows = [
        rankRow(1, { category: 'fotografi' }),
        rankRow(2, { category: 'fotografi' }),
        rankRow(3, { category: 'kuliner' }),
        rankRow(4, { category: 'jasa' }),
        rankRow(5, { category: 'jasa' }),
      ];
      likeSignals = {
        [USER_E]: [{ showcase: { category: 'fotografi' } }, { showcase: { category: 'fotografi' } }],
      };
    });

    it('halaman 1 → 2 → 3 tanpa duplikat dan tanpa lompatan', async () => {
      const page1 = (await feed(service, USER_E, { sort: 'foryou', limit: 2 })) as any;
      expect(page1.items).toHaveLength(2);
      expect(page1.hasMore).toBe(true);
      expect(page1.nextCursor).toBeTruthy();
      // Cursor foryou membawa skor personal.
      expect(decodeCursor(page1.nextCursor).s).toEqual(expect.any(Number));

      const page2 = (await feed(service, USER_E, { sort: 'foryou', limit: 2, cursor: page1.nextCursor })) as any;
      expect(page2.items).toHaveLength(2);
      expect(page2.hasMore).toBe(true);

      const page3 = (await feed(service, USER_E, { sort: 'foryou', limit: 2, cursor: page2.nextCursor })) as any;
      expect(page3.items).toHaveLength(1);
      expect(page3.hasMore).toBe(false);
      expect(page3.nextCursor).toBeNull();

      const allIds = [...page1.items, ...page2.items, ...page3.items].map((i: any) => i.id);
      // 5 item unik, tidak ada duplikat, tidak ada yang hilang.
      expect(new Set(allIds).size).toBe(5);
      expect(allIds.sort()).toEqual(poolRows.map((r) => r.id).sort());
    });

    it('menolak cursor tanpa skor (mis. cursor sort latest/popular) dengan INVALID_CURSOR', async () => {
      const latestCursor = Buffer.from(
        JSON.stringify({ v: 2, t: Date.now(), l: 7, i: poolRows[0].id }),
        'utf8',
      ).toString('base64url');
      await expect(feed(service, USER_E, { sort: 'foryou', cursor: latestCursor })).rejects.toMatchObject({
        response: { code: ErrorCodes.INVALID_CURSOR },
      });
    });
  });

  describe('sort=popular — populer harian', () => {
    it('item sepi hari ini turun peringkat walau likeCount all-time besar', async () => {
      // P1: legenda all-time (1000 like) tapi sepi hari ini (2 view).
      // P2: biasa saja all-time (3 like) tapi ramai hari ini (80 view).
      const staleLegend = rankRow(1, { likeCount: 1000, hotViews: 2 });
      const todayHot = rankRow(2, { likeCount: 3, hotViews: 80 });
      // Peran "DB": mengembalikan sesuai orderBy hotViews desc yang diminta service.
      poolRows = [todayHot, staleLegend];
      const result = (await feed(service, undefined, { sort: 'popular', limit: 1 })) as any;
      expect(mockPrisma.userShowcase.findMany.mock.calls[0][0].orderBy).toEqual([
        { hotViews: 'desc' },
        { createdAt: 'desc' },
        { id: 'desc' },
      ]);
      expect(result.items).toHaveLength(1);
      expect(result.items[0].id).toBe(todayHot.id);
      expect(result.hasMore).toBe(true);
      // Cursor membawa kunci harian (hotViews), bukan likeCount all-time.
      const decoded = decodeCursor(result.nextCursor);
      expect(decoded.l).toBe(80);
    });

    it('keyset halaman 2 memakai hotViews sebagai batas', async () => {
      const t = Date.UTC(2026, 8, 5, 12, 0, 0);
      const cursor = Buffer.from(
        JSON.stringify({ v: 2, t, l: 80, i: 'cshowcase000000000000002' }),
        'utf8',
      ).toString('base64url');
      await feed(service, undefined, { sort: 'popular', cursor });
      const keyset = mockPrisma.userShowcase.findMany.mock.calls[0][0].where.AND.find((c: any) => c.OR !== undefined);
      expect(keyset.OR).toEqual([
        { hotViews: { lt: 80 } },
        { hotViews: 80, createdAt: { lt: new Date(t) } },
        {
          hotViews: 80,
          createdAt: { gte: new Date(t), lt: new Date(t + 1) },
          id: { lt: 'cshowcase000000000000002' },
        },
      ]);
    });
  });
});
