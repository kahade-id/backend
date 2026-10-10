/**
 * Regresi audit etalase 2026-10-10 — backend showcase.
 *
 *  - BEC-01: pemilik TIDAK bisa mengaktifkan ulang item yang di-takedown
 *    moderasi (PUT isActive:true → 403 SHOWCASE_MODERATED); event RESTORED
 *    mencabut enforcement; GET /me/showcase menyertakan field moderasi.
 *  - BES-17: tayangan pemilik tidak pernah dihitung (termasuk item aktif).
 *  - BE-4: restore idempoten — item yang sudah aktif → 200 alreadyRestored.
 *  - BE-8: DELETE komentar mengembalikan commentCount final.
 *  - BES-01: 409 like/save ganda membawa `data` state akhir.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { ShowcaseVisibility } from '@prisma/client';
import { ShowcaseService } from '../showcase.service';
import { UploadService } from '../../upload/upload.service';
import { RedisService } from '../../../redis/redis.service';
import { PrismaService } from '../../../prisma/prisma.service';
import { AuditLogService } from '../../../common/services/audit-log.service';
import { VerificationBadgeService } from '../../users/verification-badge.service';
import { SubscriptionsService } from '../../subscriptions/subscriptions.service';
import { AdminShowcaseReportsService } from '../../admin/showcase-reports/admin-showcase-reports.service';
import * as ErrorCodes from '../../../common/constants/error-codes';

const OWNER_ID = 'owner-1';
const VIEWER_ID = 'viewer-1';
const SHOWCASE_ID = 'cshowcase000000000000001';

function showcaseRow(overrides: Record<string, unknown> = {}) {
  return {
    id: SHOWCASE_ID,
    userId: OWNER_ID,
    title: 'Ilustrasi karakter',
    description: null,
    category: 'ilustrasi',
    visibility: ShowcaseVisibility.PUBLIC,
    priceMin: 150000n,
    priceMax: 350000n,
    isActive: true,
    deletedAt: null,
    sortOrder: 0,
    likeCount: 4,
    commentCount: 2,
    viewCount: 30,
    shareCount: 7,
    saveCount: 1,
    createdAt: new Date('2026-09-01T00:00:00.000Z'),
    updatedAt: new Date('2026-09-01T00:00:00.000Z'),
    images: [{ id: 'img-1', imageUrl: 'https://cdn.test/a.jpg', fileKey: 'uploads/showcase-images/owner-1/a.jpg', sortOrder: 0 }],
    user: {
      id: OWNER_ID,
      userId: 'USR-OWNER01',
      username: 'seller',
      fullName: 'Toko Seller',
      avatarUrl: null,
      kycStatus: 'APPROVED',
      isActive: true,
      isBanned: false,
      deletedAt: null,
      profileVisible: true,
    },
    ...overrides,
  };
}

function matchesWhere(row: any, where: any): boolean {
  if (!row) return false;
  if (where?.id && row.id !== where.id) return false;
  if (where?.userId && row.userId !== where.userId) return false;
  if (where?.deletedAt !== undefined) {
    if (where.deletedAt === null && row.deletedAt != null) return false;
    if (where.deletedAt && typeof where.deletedAt === 'object' && 'not' in where.deletedAt && row.deletedAt == null) return false;
  }
  if (!where?.OR) return true;
  return where.OR.some((branch: any) => {
    if (branch.userId !== undefined && row.userId !== branch.userId) return false;
    if (branch.visibility !== undefined && row.visibility !== branch.visibility) return false;
    if (branch.isActive !== undefined && row.isActive !== branch.isActive) return false;
    return true;
  });
}

function buildMocks() {
  const mockPrisma: any = {
    user: { findUnique: jest.fn() },
    blockList: { findFirst: jest.fn().mockResolvedValue(null), findMany: jest.fn().mockResolvedValue([]) },
    userShowcase: {
      findFirst: jest.fn(),
      findMany: jest.fn().mockResolvedValue([]),
      findUnique: jest.fn().mockResolvedValue(null),
      count: jest.fn().mockResolvedValue(0),
      create: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    showcaseImage: { findMany: jest.fn(), count: jest.fn(), deleteMany: jest.fn() },
    showcaseLike: { findMany: jest.fn().mockResolvedValue([]), create: jest.fn(), deleteMany: jest.fn() },
    showcaseSave: { findMany: jest.fn().mockResolvedValue([]), create: jest.fn(), deleteMany: jest.fn(), count: jest.fn() },
    showcaseComment: { findMany: jest.fn().mockResolvedValue([]), findUnique: jest.fn(), update: jest.fn(), count: jest.fn() },
    showcaseCommentReaction: { groupBy: jest.fn().mockResolvedValue([]), findMany: jest.fn().mockResolvedValue([]) },
    // Fragment moderasi (moderationDb) — event takedown/restore.
    reportModerationEvent: { findMany: jest.fn().mockResolvedValue([]), findFirst: jest.fn().mockResolvedValue(null) },
    $transaction: jest.fn(),
    $executeRaw: jest.fn().mockResolvedValue(1),
  };
  const mockRedis = { setNx: jest.fn().mockResolvedValue(true), get: jest.fn(), set: jest.fn(), del: jest.fn(), consumeOnce: jest.fn() };
  const mockUpload = {
    verifyUserFileKeys: jest.fn().mockResolvedValue(undefined),
    consumeUploadConfirmations: jest.fn().mockResolvedValue(undefined),
    buildPublicUrl: jest.fn((key: string) => `https://cdn.test/${key}`),
    cleanupFileKeys: jest.fn().mockResolvedValue({ deleted: 1, errors: [] }),
    fileKeyFromPublicUrl: jest.fn(() => null),
  };
  const mockSubscriptions = { isActive: jest.fn().mockResolvedValue(false), getMaxShowcaseImages: jest.fn().mockResolvedValue(8) };
  return { mockPrisma, mockRedis, mockUpload, mockSubscriptions };
}

async function buildService(mocks: ReturnType<typeof buildMocks>, dbRow: any) {
  const { mockPrisma, mockRedis, mockUpload, mockSubscriptions } = mocks;
  mockPrisma.$transaction.mockImplementation(async (arg: unknown) =>
    typeof arg === 'function' ? (arg as (tx: unknown) => Promise<unknown>)(mockPrisma) : Promise.all(arg as never[]),
  );
  mockPrisma.userShowcase.findFirst.mockImplementation(async (args: any) => (matchesWhere(dbRow, args?.where) ? dbRow : null));
  mockPrisma.userShowcase.update.mockImplementation(async (args: any) => ({ ...dbRow, ...(args?.data ?? {}) }));
  const module: TestingModule = await Test.createTestingModule({
    providers: [
      ShowcaseService,
      { provide: PrismaService, useValue: mockPrisma },
      { provide: RedisService, useValue: mockRedis },
      { provide: UploadService, useValue: mockUpload },
      { provide: ConfigService, useValue: { get: jest.fn(() => undefined) } },
      { provide: AuditLogService, useValue: { logUserAction: jest.fn(), logAdminAction: jest.fn() } },
      { provide: VerificationBadgeService, useValue: { getBadges: jest.fn().mockResolvedValue([]), getSealTierMap: jest.fn().mockResolvedValue(new Map()) } },
      { provide: SubscriptionsService, useValue: mockSubscriptions },
      { provide: AdminShowcaseReportsService, useValue: { linkReportToCluster: jest.fn() } },
    ],
  }).compile();
  return module.get<ShowcaseService>(ShowcaseService);
}

const takedownEvent = (action: string, createdAt: string) => ({
  reportId: 'rep-1',
  action,
  createdAt: new Date(createdAt),
  note: 'Barang terlarang',
  metadata: {},
  report: { showcaseId: SHOWCASE_ID },
});

describe('Audit etalase 2026-10-10 — ShowcaseService', () => {
  let mocks: ReturnType<typeof buildMocks>;
  beforeEach(() => {
    mocks = buildMocks();
  });

  describe('BEC-01 takedown tidak bisa dibalik pemilik', () => {
    it('PUT isActive:true pada item takedown → 403 SHOWCASE_MODERATED (tanpa update)', async () => {
      mocks.mockPrisma.reportModerationEvent.findMany.mockResolvedValue([takedownEvent('TAKEDOWN', '2026-10-01T00:00:00Z')]);
      const service = await buildService(mocks, showcaseRow({ isActive: false }));
      await expect(service.updateShowcaseItem(OWNER_ID, SHOWCASE_ID, { isActive: true } as never)).rejects.toMatchObject({
        response: expect.objectContaining({ code: ErrorCodes.SHOWCASE_MODERATED, reportId: 'rep-1' }),
      });
      expect(mocks.mockPrisma.userShowcase.update).not.toHaveBeenCalled();
    });

    it('event RESTORED setelah TAKEDOWN mencabut enforcement → aktivasi diizinkan', async () => {
      mocks.mockPrisma.reportModerationEvent.findMany.mockResolvedValue([
        takedownEvent('RESTORED', '2026-10-05T00:00:00Z'),
        takedownEvent('TAKEDOWN', '2026-10-01T00:00:00Z'),
      ]);
      const service = await buildService(mocks, showcaseRow({ isActive: false }));
      await expect(service.updateShowcaseItem(OWNER_ID, SHOWCASE_ID, { isActive: true } as never)).resolves.toBeDefined();
      expect(mocks.mockPrisma.userShowcase.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ isActive: true }) }));
    });

    it('item nonaktif oleh pemilik sendiri (tanpa event) tetap bisa diaktifkan', async () => {
      const service = await buildService(mocks, showcaseRow({ isActive: false }));
      await expect(service.updateShowcaseItem(OWNER_ID, SHOWCASE_ID, { isActive: true } as never)).resolves.toBeDefined();
    });

    it('GET /me/showcase menyertakan field moderasi untuk item yang ditakedown', async () => {
      mocks.mockPrisma.userShowcase.findMany.mockResolvedValue([showcaseRow({ isActive: false })]);
      mocks.mockPrisma.reportModerationEvent.findMany.mockResolvedValue([takedownEvent('TAKEDOWN', '2026-10-01T00:00:00Z')]);
      const service = await buildService(mocks, showcaseRow({ isActive: false }));
      const result = (await service.getMyShowcase(OWNER_ID)) as any;
      expect(result.items[0]).toMatchObject({
        moderationStatus: 'TAKEDOWN',
        moderationReason: 'Barang terlarang',
        moderationReportId: 'rep-1',
      });
    });
  });

  describe('BES-17 tayangan pemilik', () => {
    it('pemilik membuka item AKTIF miliknya → view tidak dihitung', async () => {
      const service = await buildService(mocks, showcaseRow({ isActive: true }));
      await service.getShowcaseDetail(SHOWCASE_ID, OWNER_ID);
      expect(mocks.mockRedis.setNx).not.toHaveBeenCalled();
    });

    it('pengunjung lain tetap dihitung', async () => {
      const service = await buildService(mocks, showcaseRow({ isActive: true }));
      await service.getShowcaseDetail(SHOWCASE_ID, VIEWER_ID);
      expect(mocks.mockRedis.setNx).toHaveBeenCalled();
    });
  });

  describe('BE-4 restore idempoten', () => {
    it('item sudah aktif → 200 alreadyRestored (bukan 404)', async () => {
      const service = await buildService(mocks, showcaseRow({ deletedAt: null }));
      await expect(service.restoreShowcaseItem(OWNER_ID, SHOWCASE_ID)).resolves.toMatchObject({ alreadyRestored: true });
      expect(mocks.mockPrisma.userShowcase.update).not.toHaveBeenCalled();
    });
  });

  describe('BE-8 hapus komentar', () => {
    it('mengembalikan commentCount final setelah decrement', async () => {
      const service = await buildService(mocks, showcaseRow());
      mocks.mockPrisma.showcaseComment.findUnique.mockResolvedValue({
        id: 'c1', userId: VIEWER_ID, showcaseId: SHOWCASE_ID, parentId: null, isHidden: false, deletedAt: null,
      });
      mocks.mockPrisma.userShowcase.findUnique.mockResolvedValue({ id: SHOWCASE_ID, userId: OWNER_ID, commentCount: 1 });
      mocks.mockPrisma.showcaseComment.update.mockResolvedValue({});
      const result = await service.deleteComment(VIEWER_ID, 'c1');
      expect(result).toMatchObject({ commentCount: 1 });
      expect(mocks.mockPrisma.userShowcase.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({ data: { commentCount: { decrement: 1 } } }),
      );
    });
  });

  describe('BES-01 409 membawa state akhir', () => {
    it('like ganda → 409 dengan data {liked:true, likeCount}', async () => {
      const service = await buildService(mocks, showcaseRow());
      mocks.mockPrisma.userShowcase.findUnique.mockResolvedValue({ likeCount: 9 });
      const unique = Object.assign(new Error('dup'), { code: 'P2002' });
      mocks.mockPrisma.$transaction.mockImplementation(async () => { throw unique; });
      const svc: any = service;
      svc.isUniqueViolation = () => true;
      await expect(service.likeShowcase(VIEWER_ID, SHOWCASE_ID)).rejects.toMatchObject({
        response: expect.objectContaining({ code: ErrorCodes.SHOWCASE_ALREADY_LIKED, data: { liked: true, likeCount: 9 } }),
      });
    });
  });
});
