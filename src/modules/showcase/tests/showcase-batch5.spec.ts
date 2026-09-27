/**
 * Audit Batch 5 — Showcase & Sosial (backend).
 *
 * Mencakup:
 * - SS-005: metadata share bersifat read-only (tidak menambah shareCount);
 *   pencatatan share eksplisit menambah counter atomik.
 * - SS-008: filter block tidak dibatasi 1000 id (tanpa take).
 * - SS-012: daftar item soft-delete milik user (deletedAt, daysRemaining).
 */
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { ShowcaseVisibility } from '@prisma/client';
import { ShowcaseService } from '../showcase.service';
import { PrismaService } from '../../../prisma/prisma.service';
import { RedisService } from '../../../redis/redis.service';
import { UploadService } from '../../upload/upload.service';
import { AuditLogService } from '../../../common/services/audit-log.service';
import { VerificationBadgeService } from '../../users/verification-badge.service';
import { SubscriptionsService } from '../../subscriptions/subscriptions.service';
import { AdminShowcaseReportsService } from '../../admin/showcase-reports/admin-showcase-reports.service';

const OWNER_ID = 'owner-5';
const VIEWER_ID = 'viewer-5';
const SHOWCASE_ID = 'cshowcase000000000005001';

function showcaseRow(overrides: Record<string, unknown> = {}) {
  return {
    id: SHOWCASE_ID,
    userId: OWNER_ID,
    title: 'Etalase uji',
    description: 'Deskripsi',
    category: 'ilustrasi',
    visibility: ShowcaseVisibility.PUBLIC,
    priceMin: 100000n,
    priceMax: null,
    isActive: true,
    sortOrder: 0,
    likeCount: 0,
    commentCount: 0,
    viewCount: 0,
    shareCount: 3,
    deletedAt: null,
    createdAt: new Date('2026-09-01T00:00:00.000Z'),
    updatedAt: new Date('2026-09-01T00:00:00.000Z'),
    images: [],
    user: {
      id: OWNER_ID,
      userId: 'USR-OWNER05',
      username: 'seller5',
      fullName: 'Seller Lima',
      avatarUrl: null,
      kycStatus: 'PENDING',
      isVip: false,
      membershipRank: 'BRONZE',
      isActive: true,
      isBanned: false,
      deletedAt: null,
      profileVisible: true,
    },
    ...overrides,
  };
}

const mockPrisma: any = {
  blockList: { findFirst: jest.fn(), findMany: jest.fn() },
  userShowcase: {
    findFirst: jest.fn(),
    findUnique: jest.fn(),
    findMany: jest.fn(),
    count: jest.fn(),
    update: jest.fn(),
    updateMany: jest.fn(),
  },
  showcaseLike: { findMany: jest.fn(), create: jest.fn(), deleteMany: jest.fn() },
  showcaseComment: { findMany: jest.fn(), findFirst: jest.fn(), findUnique: jest.fn(), count: jest.fn(), groupBy: jest.fn(), create: jest.fn(), update: jest.fn(), delete: jest.fn() },
  $transaction: jest.fn(),
};

const mockRedis = { setNx: jest.fn() };
const mockUpload = { verifyUserFileKeys: jest.fn(), buildPublicUrl: jest.fn(), cleanupFileKeys: jest.fn(), uploadDirect: jest.fn() };
const mockConfig = { get: jest.fn() };
const mockSubscriptions = {
  isActive: jest.fn().mockResolvedValue(false),
  getMaxShowcaseImages: jest.fn().mockResolvedValue(8),
};

describe('ShowcaseService — audit Batch 5', () => {
  let service: ShowcaseService;
  let dbShowcase: any;

  beforeEach(async () => {
    jest.clearAllMocks();
    dbShowcase = showcaseRow();
    mockPrisma.$transaction.mockImplementation(async (arg: unknown) =>
      typeof arg === 'function' ? (arg as (tx: unknown) => Promise<unknown>)(mockPrisma) : Promise.all(arg as never[]),
    );
    mockPrisma.userShowcase.findFirst.mockImplementation(async (args: any) => {
      const where = args?.where ?? {};
      if (!dbShowcase) return null;
      if (where.id && dbShowcase.id !== where.id) return null;
      if (where.userId && dbShowcase.userId !== where.userId) return null;
      if (where.deletedAt !== undefined && where.deletedAt === null && dbShowcase?.deletedAt !== null) return null;
      // Emulasi cabang visibilitas: item public hanya terlihat bila owner sehat.
      if (Array.isArray(where.OR)) {
        const ok = where.OR.some((branch: any) => {
          if (branch.userId !== undefined) return dbShowcase.userId === branch.userId;
          if (branch.visibility !== undefined) {
            const u = dbShowcase.user;
            return dbShowcase.visibility === branch.visibility &&
              u.isActive === true && u.isBanned === false && u.deletedAt == null && u.profileVisible === true;
          }
          return false;
        });
        if (!ok) return null;
      }
      return dbShowcase;
    });
    mockPrisma.userShowcase.findUnique.mockResolvedValue(dbShowcase);
    mockPrisma.userShowcase.update.mockImplementation(async (args: any) => {
      const data = { ...args.data };
      if (data.shareCount?.increment) data.shareCount = (dbShowcase.shareCount ?? 0) + data.shareCount.increment;
      return { ...dbShowcase, ...data };
    });
    mockPrisma.userShowcase.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.userShowcase.findMany.mockResolvedValue([]);
    mockPrisma.userShowcase.count.mockResolvedValue(0);
    mockPrisma.blockList.findFirst.mockResolvedValue(null);
    mockPrisma.blockList.findMany.mockResolvedValue([]);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ShowcaseService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: RedisService, useValue: mockRedis },
        { provide: UploadService, useValue: mockUpload },
        { provide: ConfigService, useValue: mockConfig },
        { provide: AuditLogService, useValue: { logUserAction: jest.fn(), logAdminAction: jest.fn() } },
        { provide: VerificationBadgeService, useValue: { getBadges: jest.fn().mockResolvedValue([]), getSealTierMap: jest.fn().mockResolvedValue(new Map()) } },
        { provide: SubscriptionsService, useValue: mockSubscriptions },
        { provide: AdminShowcaseReportsService, useValue: { linkReportToCluster: jest.fn() } },
      ],
    }).compile();
    service = module.get<ShowcaseService>(ShowcaseService);
  });

  // ------------------------------------------------------------------
  // SS-005: metadata share read-only; pencatatan eksplisit menambah counter
  // ------------------------------------------------------------------
  describe('share semantics (SS-005)', () => {
    it('getSharePayload tidak mengubah shareCount di DB', async () => {
      await service.getSharePayload(SHOWCASE_ID, VIEWER_ID);
      expect(mockPrisma.userShowcase.update).not.toHaveBeenCalled();
      expect(mockPrisma.userShowcase.updateMany).not.toHaveBeenCalled();
    });

    it('getSharePayload mengembalikan shareCount yang sama tanpa increment', async () => {
      const payload = (await service.getSharePayload(SHOWCASE_ID, VIEWER_ID)) as { shareCount: number };
      expect(payload.shareCount).toBe(3);
    });

    it('recordShareOpen menaikkan counter atomik setelah validasi visibilitas', async () => {
      const result = await service.recordShareOpen(SHOWCASE_ID, VIEWER_ID);
      expect(result).toEqual({ shareCount: 4 });
      expect(mockPrisma.userShowcase.update).toHaveBeenCalledWith({
        where: { id: SHOWCASE_ID },
        data: { shareCount: { increment: 1 } },
        select: { shareCount: true },
      });
    });

    it('recordShareOpen menolak item milik akun ter-ban (404)', async () => {
      dbShowcase = showcaseRow({ user: { ...showcaseRow().user, isBanned: true } });
      await expect(service.recordShareOpen(SHOWCASE_ID, VIEWER_ID)).rejects.toThrow();
      expect(mockPrisma.userShowcase.update).not.toHaveBeenCalled();
    });
  });

  // ------------------------------------------------------------------
  // SS-008: filter block tidak di-cap 1000
  // ------------------------------------------------------------------
  describe('block filter tanpa cap (SS-008)', () => {
    it('getViewerExcludedIds memanggil findMany tanpa take', async () => {
      // Cara tidak langsung: ambil feed publik sebagai viewer — getViewerExcludedIds
      // dipanggil internal tanpa `take`.
      mockPrisma.userShowcase.findMany.mockResolvedValue([]);
      await service.getFeed(VIEWER_ID, { limit: 5 } as any);
      const findManyCalls = mockPrisma.blockList.findMany.mock.calls;
      expect(findManyCalls.length).toBeGreaterThan(0);
      for (const call of findManyCalls) {
        expect(call[0]).not.toHaveProperty('take');
      }
    });
  });

  // ------------------------------------------------------------------
  // SS-012: daftar item terhapus milik user
  // ------------------------------------------------------------------
  describe('listDeletedShowcaseItems (SS-012)', () => {
    it('hanya mengembalikan item soft-delete milik user dengan metadata restorasi', async () => {
      const deletedAt = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000); // 5 hari lalu
      mockPrisma.userShowcase.findMany.mockResolvedValue([
        { ...showcaseRow({ id: 'cshowcase000000000005002', deletedAt }), images: [], user: showcaseRow().user },
      ]);
      mockPrisma.userShowcase.count.mockResolvedValue(1);

      const result: any = await service.listDeletedShowcaseItems(OWNER_ID, 1, 20);
      expect(result.total).toBe(1);
      expect(result.items).toHaveLength(1);
      const item = result.items[0];
      expect(item.deletedAt).toBe(deletedAt.toISOString());
      expect(item.daysRemaining).toBe(25);
      expect(item.restorable).toBe(true);

      const where = mockPrisma.userShowcase.findMany.mock.calls[0][0].where;
      expect(where).toEqual({ userId: OWNER_ID, deletedAt: { not: null } });
    });

    it('menandai item yang sudah melewati 30 hari sebagai tidak restorable', async () => {
      const deletedAt = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000);
      mockPrisma.userShowcase.findMany.mockResolvedValue([
        { ...showcaseRow({ id: 'cshowcase000000000005003', deletedAt }), images: [], user: showcaseRow().user },
      ]);
      mockPrisma.userShowcase.count.mockResolvedValue(1);

      const result: any = await service.listDeletedShowcaseItems(OWNER_ID, 1, 20);
      expect(result.items[0].restorable).toBe(false);
      expect(result.items[0].daysRemaining).toBe(0);
    });
  });
});
