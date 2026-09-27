/**
 * Batch 19 TIM A — media etalase (video/spin360), save/unsave, likers/savers,
 * filter feed condition + minSellerRating.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { ShowcaseVisibility } from '@prisma/client';
import { ShowcaseService } from '../showcase.service';
import { PrismaService } from '../../../prisma/prisma.service';
import { RedisService } from '../../../redis/redis.service';
import { UploadService } from '../../upload/upload.service';
import { AuditLogService } from '../../../common/services/audit-log.service';
import { VerificationBadgeService } from '../../users/verification-badge.service';
import { SubscriptionsService } from '../../subscriptions/subscriptions.service';
import { AdminShowcaseReportsService } from '../../admin/showcase-reports/admin-showcase-reports.service';
import * as ErrorCodes from '../../../common/constants/error-codes';

const OWNER_ID = 'owner-tim-a';
const VIEWER_ID = 'viewer-tim-a';
const SHOWCASE_ID = 'cshowcase0000000000000a1';
const IMG_KEY = `uploads/showcase-images/${OWNER_ID}/1700000000-a.jpg`;
const VID_KEY = `uploads/showcase-videos/${OWNER_ID}/1700000000-v.mp4`;
const THUMB_KEY = `uploads/showcase-videos/${OWNER_ID}/1700000000-v-thumb.jpg`;

function showcaseRow(overrides: Record<string, unknown> = {}) {
  return {
    id: SHOWCASE_ID,
    userId: OWNER_ID,
    title: 'Produk uji',
    description: 'Deskripsi produk uji yang cukup panjang.',
    category: 'fashion',
    visibility: ShowcaseVisibility.PUBLIC,
    priceMin: 100000n,
    priceMax: 200000n,
    isActive: true,
    sortOrder: 0,
    likeCount: 1,
    saveCount: 2,
    commentCount: 0,
    viewCount: 10,
    createdAt: new Date('2026-09-01T00:00:00.000Z'),
    updatedAt: new Date('2026-09-01T00:00:00.000Z'),
    images: [{ id: 'img-1', imageUrl: 'https://cdn.test/a.jpg', fileKey: IMG_KEY, sortOrder: 0, kind: 'image' }],
    user: {
      id: OWNER_ID,
      userId: 'USR-OWNERTIMA',
      username: 'sellertima',
      fullName: 'Seller Tim A',
      avatarUrl: null,
      kycStatus: 'APPROVED',
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
  user: { findUnique: jest.fn() },
  blockList: { findFirst: jest.fn(), findMany: jest.fn() },
  userShowcase: {
    findFirst: jest.fn(),
    findMany: jest.fn(),
    findUnique: jest.fn(),
    count: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    updateMany: jest.fn(),
    delete: jest.fn(),
  },
  showcaseImage: { findMany: jest.fn(), findFirst: jest.fn(), count: jest.fn(), createMany: jest.fn(), updateMany: jest.fn(), delete: jest.fn(), deleteMany: jest.fn() },
  showcaseLike: { findMany: jest.fn(), create: jest.fn(), deleteMany: jest.fn(), count: jest.fn() },
  showcaseSave: { findMany: jest.fn(), create: jest.fn(), deleteMany: jest.fn(), count: jest.fn() },
  showcaseComment: { findMany: jest.fn(), findFirst: jest.fn(), findUnique: jest.fn(), count: jest.fn(), create: jest.fn(), update: jest.fn(), delete: jest.fn() },
  showcaseDailyStat: { upsert: jest.fn() },
  $transaction: jest.fn(),
  $executeRaw: jest.fn().mockResolvedValue(1),
};

const mockRedis = { setNx: jest.fn(), get: jest.fn(), set: jest.fn(), del: jest.fn() };
const mockUpload = {
  verifyUserFileKeys: jest.fn(),
  buildPublicUrl: jest.fn((key: string) => `https://cdn.test/${key}`),
  fileKeyFromPublicUrl: jest.fn((url: string) => url.replace('https://cdn.test/', '')),
  cleanupFileKeys: jest.fn().mockResolvedValue({ deleted: 1, errors: [] }),
  uploadDirect: jest.fn(),
  consumeUploadConfirmations: jest.fn().mockResolvedValue(undefined),
};
const mockConfig = { get: jest.fn((key: string) => (key === 'app.publicWebBaseUrl' ? 'https://kahade.id' : undefined)) };
const mockSubscriptions = {
  isActive: jest.fn().mockResolvedValue(false),
  getMaxShowcaseImages: jest.fn().mockResolvedValue(24),
};

describe('ShowcaseService — batch 19 TIM A', () => {
  let service: ShowcaseService;

  beforeEach(async () => {
    jest.clearAllMocks();
    mockUpload.buildPublicUrl.mockImplementation((key: string) => `https://cdn.test/${key}`);
    mockUpload.fileKeyFromPublicUrl.mockImplementation((url: string) => url.replace('https://cdn.test/', ''));
    mockPrisma.$transaction.mockImplementation(async (arg: unknown) =>
      typeof arg === 'function' ? (arg as (tx: unknown) => Promise<unknown>)(mockPrisma) : Promise.all(arg as never[]),
    );
    mockPrisma.blockList.findFirst.mockResolvedValue(null);
    mockPrisma.blockList.findMany.mockResolvedValue([]);
    mockPrisma.userShowcase.count.mockResolvedValue(0);
    mockPrisma.userShowcase.findFirst.mockResolvedValue(showcaseRow());
    mockPrisma.userShowcase.findUnique.mockResolvedValue({ id: SHOWCASE_ID, likeCount: 1, saveCount: 2 });
    mockPrisma.userShowcase.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.userShowcase.create.mockImplementation(async (args: any) => {
      const d = args.data;
      return showcaseRow({ ...d, images: (d.images?.create ?? []).map((img: any, i: number) => ({ id: `img-${i}`, ...img })) });
    });
    mockPrisma.userShowcase.update.mockImplementation(async (args: any) => {
      const d = { ...args.data };
      const images = d.images ? (d.images.create ?? []).map((img: any, i: number) => ({ id: `img-${i}`, ...img })) : showcaseRow().images;
      delete d.images;
      return showcaseRow({ ...d, images });
    });
    mockUpload.verifyUserFileKeys.mockResolvedValue(undefined);
    mockUpload.consumeUploadConfirmations.mockResolvedValue(undefined);
    mockPrisma.showcaseLike.findMany.mockResolvedValue([]);
    mockPrisma.showcaseSave.findMany.mockResolvedValue([]);
    mockPrisma.showcaseSave.count.mockResolvedValue(0);
    mockPrisma.showcaseLike.count.mockResolvedValue(0);

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

  const spinFrames = (n: number, groupKey = 'spin-a1') =>
    Array.from({ length: n }, (_, i) => ({
      fileKey: `uploads/showcase-images/${OWNER_ID}/1700000000-spin-${i}.jpg`,
      kind: 'spin360' as const,
      groupKey,
      groupOrder: i,
    }));

  const createDto = (overrides: Record<string, unknown> = {}) =>
    ({
      title: 'Produk uji',
      description: 'Deskripsi produk uji yang cukup panjang.',
      ...overrides,
    }) as any;

  // ------------------------------------------------------------------
  // Item 2: media etalase (video & spin360)
  // ------------------------------------------------------------------
  describe('media etalase (item 2)', () => {
    it('menolak media dan imageFileKeys yang dikirim bersamaan', async () => {
      const promise = service.createShowcaseItem(OWNER_ID, createDto({
        imageFileKeys: [IMG_KEY],
        media: [{ fileKey: IMG_KEY, kind: 'image' }],
      }));
      await expect(promise).rejects.toMatchObject({ response: { code: ErrorCodes.SHOWCASE_INVALID_MEDIA } });
      expect(mockPrisma.userShowcase.create).not.toHaveBeenCalled();
    });

    it('menolak fileKey duplikat antar entri media', async () => {
      const promise = service.createShowcaseItem(OWNER_ID, createDto({
        media: [
          { fileKey: IMG_KEY, kind: 'image' },
          { fileKey: IMG_KEY, kind: 'image' },
        ],
      }));
      await expect(promise).rejects.toMatchObject({ response: { code: ErrorCodes.SHOWCASE_INVALID_MEDIA } });
      expect(mockPrisma.userShowcase.create).not.toHaveBeenCalled();
    });

    it('menolak video tanpa thumbnailFileKey', async () => {
      const promise = service.createShowcaseItem(OWNER_ID, createDto({
        media: [{ fileKey: VID_KEY, kind: 'video' }],
      }));
      await expect(promise).rejects.toMatchObject({ response: { code: ErrorCodes.SHOWCASE_INVALID_MEDIA } });
    });

    it('menerima video + thumbnail dan menyimpan metadata video', async () => {
      const result = (await service.createShowcaseItem(OWNER_ID, createDto({
        media: [{ fileKey: VID_KEY, kind: 'video', thumbnailFileKey: THUMB_KEY, durationSec: 12, width: 1280, height: 720 }],
      }))) as any;
      const created = mockPrisma.userShowcase.create.mock.calls[0][0].data.images.create[0];
      expect(created.kind).toBe('video');
      expect(created.thumbnailUrl).toBe(`https://cdn.test/${THUMB_KEY}`);
      expect(created.durationSec).toBe(12);
      expect(created.width).toBe(1280);
      // Serializer: cover video memakai thumbnail.
      expect(result.coverImageUrl).toBe(`https://cdn.test/${THUMB_KEY}`);
      expect(result.images[0].kind).toBe('video');
    });

    it('menolak spin360 dengan frame < 8', async () => {
      const promise = service.createShowcaseItem(OWNER_ID, createDto({ media: spinFrames(7) }));
      await expect(promise).rejects.toMatchObject({ response: { code: ErrorCodes.SHOWCASE_SPIN360_INVALID } });
      expect(mockPrisma.userShowcase.create).not.toHaveBeenCalled();
    });

    it('menolak spin360 dengan frame > 24', async () => {
      // Batas per-user (mock) dinaikkan supaya yang diuji adalah batas frame
      // spin360 milik item 2, bukan SHOWCASE_IMAGE_LIMIT_REACHED.
      mockSubscriptions.getMaxShowcaseImages.mockResolvedValue(30);
      const promise = service.createShowcaseItem(OWNER_ID, createDto({ media: spinFrames(25) }));
      await expect(promise).rejects.toMatchObject({ response: { code: ErrorCodes.SHOWCASE_SPIN360_INVALID } });
    });

    it('menolak spin360 dengan groupOrder tidak kontinu', async () => {
      const frames = spinFrames(8);
      frames[3].groupOrder = 9; // melompat
      const promise = service.createShowcaseItem(OWNER_ID, createDto({ media: frames }));
      await expect(promise).rejects.toMatchObject({ response: { code: ErrorCodes.SHOWCASE_SPIN360_INVALID } });
    });

    it('menerima spin360 valid: 8 frame terurut dengan groupKey/groupOrder', async () => {
      await service.createShowcaseItem(OWNER_ID, createDto({ media: spinFrames(8) }));
      const created = mockPrisma.userShowcase.create.mock.calls[0][0].data.images.create;
      expect(created).toHaveLength(8);
      expect(created.every((c: any) => c.kind === 'spin360')).toBe(true);
      expect(created.map((c: any) => c.groupOrder)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
      expect(created.every((c: any) => c.groupKey === 'spin-a1')).toBe(true);
    });

    it('memverifikasi thumbnail spin/video dengan purpose SHOWCASE_IMAGE dan video dengan SHOWCASE_VIDEO', async () => {
      await service.createShowcaseItem(OWNER_ID, createDto({
        media: [{ fileKey: VID_KEY, kind: 'video', thumbnailFileKey: THUMB_KEY }],
      }));
      const calls = mockUpload.verifyUserFileKeys.mock.calls.map((c: any) => ({ purpose: c[2], label: c[3]?.label }));
      expect(calls).toContainEqual(expect.objectContaining({ purpose: 'SHOWCASE_VIDEO', label: 'Showcase video' }));
      expect(calls).toContainEqual(expect.objectContaining({ purpose: 'SHOWCASE_IMAGE', label: 'Video thumbnail' }));
    });
  });

  // ------------------------------------------------------------------
  // Item 3: save / unsave / likers / savers
  // ------------------------------------------------------------------
  describe('save & unsave (item 3)', () => {
    it('save menaikkan saveCount dan mengembalikan { saved: true }', async () => {
      mockPrisma.showcaseSave.create.mockResolvedValue({ id: 'save-1' });
      mockPrisma.userShowcase.findUnique.mockResolvedValue({ id: SHOWCASE_ID, saveCount: 3 });
      const result = (await service.saveShowcase(VIEWER_ID, SHOWCASE_ID)) as any;
      expect(result).toEqual({ saved: true, saveCount: 3 });
      expect(mockPrisma.userShowcase.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({ data: { saveCount: { increment: 1 } } }),
      );
    });

    it('save ganda -> 409 SHOWCASE_ALREADY_SAVED', async () => {
      mockPrisma.showcaseSave.create.mockRejectedValue({ code: 'P2002' });
      await expect(service.saveShowcase(VIEWER_ID, SHOWCASE_ID)).rejects.toMatchObject({
        response: { code: ErrorCodes.SHOWCASE_ALREADY_SAVED },
        });
    });

    it('unsave yang belum pernah save -> 404 SHOWCASE_NOT_SAVED', async () => {
      mockPrisma.showcaseSave.deleteMany.mockResolvedValue({ count: 0 });
      await expect(service.unsaveShowcase(VIEWER_ID, SHOWCASE_ID)).rejects.toMatchObject({
        response: { code: ErrorCodes.SHOWCASE_NOT_SAVED },
        });
    });

    it('unsave menurunkan saveCount dengan guard gt 0', async () => {
      mockPrisma.showcaseSave.deleteMany.mockResolvedValue({ count: 1 });
      mockPrisma.userShowcase.findUnique.mockResolvedValue({ id: SHOWCASE_ID, saveCount: 1 });
      const result = (await service.unsaveShowcase(VIEWER_ID, SHOWCASE_ID)) as any;
      expect(result.saved).toBe(false);
      expect(mockPrisma.userShowcase.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ saveCount: { gt: 0 } }),
          data: { saveCount: { decrement: 1 } },
        }),
      );
    });
  });

  describe('likers & savers (item 3)', () => {
    const likeRow = {
      createdAt: new Date('2026-09-02T00:00:00.000Z'),
      user: { id: 'u-2', userId: 'USR-2', username: 'penyuka', fullName: 'Penyuka', avatarUrl: null },
    };

    it('listLikers publik: mengembalikan username + likedAt dengan pagination stabil', async () => {
      mockPrisma.showcaseLike.findMany.mockResolvedValue([likeRow]);
      mockPrisma.showcaseLike.count.mockResolvedValue(1);
      const result = (await service.listLikers(SHOWCASE_ID, undefined, 1, 20)) as any;
      expect(result.data[0]).toMatchObject({ username: 'penyuka', likedAt: likeRow.createdAt });
      expect(result.total).toBe(1);
      const orderBy = mockPrisma.showcaseLike.findMany.mock.calls[0][0].orderBy;
      expect(orderBy).toEqual([{ createdAt: 'desc' }, { id: 'desc' }]);
    });

    it('listLikers item private -> 404', async () => {
      mockPrisma.userShowcase.findFirst.mockResolvedValue(null);
      await expect(service.listLikers(SHOWCASE_ID, undefined, 1, 20)).rejects.toMatchObject({
        response: { code: ErrorCodes.SHOWCASE_NOT_FOUND },
        });
    });

    it('listSavers oleh NON-owner -> 403 SHOWCASE_FORBIDDEN', async () => {
      await expect(service.listSavers(VIEWER_ID, SHOWCASE_ID, 1, 20)).rejects.toMatchObject({
        response: { code: ErrorCodes.SHOWCASE_FORBIDDEN },
        });
      expect(mockPrisma.showcaseSave.findMany).not.toHaveBeenCalled();
    });

    it('listSavers oleh owner mengembalikan savedAt', async () => {
      mockPrisma.showcaseSave.findMany.mockResolvedValue([
        { createdAt: new Date('2026-09-03T00:00:00.000Z'), user: likeRow.user },
      ]);
      mockPrisma.showcaseSave.count.mockResolvedValue(1);
      const result = (await service.listSavers(OWNER_ID, SHOWCASE_ID, 1, 20)) as any;
      expect(result.data[0]).toMatchObject({ username: 'penyuka' });
      expect(result.data[0].savedAt).toBeInstanceOf(Date);
    });
  });

  // ------------------------------------------------------------------
  // Item 6: filter feed condition + minSellerRating
  // ------------------------------------------------------------------
  describe('filter feed (item 6)', () => {
    beforeEach(() => {
      mockPrisma.userShowcase.findMany.mockResolvedValue([]);
    });

    it('menerapkan condition ke where AND', async () => {
      await service.getFeed(VIEWER_ID, { sort: 'latest', limit: 20, condition: 'BARU' } as any);
      const where = mockPrisma.userShowcase.findMany.mock.calls[0][0].where;
      expect(where.AND).toContainEqual({ condition: 'BARU' });
    });

    it('menerapkan minSellerRating sebagai filter relasi user.averageRating', async () => {
      await service.getFeed(VIEWER_ID, { sort: 'latest', limit: 20, minSellerRating: 4 } as any);
      const where = mockPrisma.userShowcase.findMany.mock.calls[0][0].where;
      expect(where.AND).toContainEqual({ user: { averageRating: { gte: 4 } } });
    });

    it('minSellerRating=0 tidak menambah filter (semua pemilik lolos)', async () => {
      await service.getFeed(VIEWER_ID, { sort: 'latest', limit: 20, minSellerRating: 0 } as any);
      const where = mockPrisma.userShowcase.findMany.mock.calls[0][0].where;
      const ratingClauses = (where.AND ?? []).filter((c: any) => c?.user?.averageRating);
      expect(ratingClauses).toHaveLength(0);
    });

    it('tanpa filter baru: tidak ada klausa condition/rating, filter harga lama tetap jalan', async () => {
      await service.getFeed(VIEWER_ID, { sort: 'latest', limit: 20, minPrice: 50000, maxPrice: 150000 } as any);
      const where = mockPrisma.userShowcase.findMany.mock.calls[0][0].where;
      const hasCondition = (where.AND ?? []).some((c: any) => 'condition' in c);
      expect(hasCondition).toBe(false);
      // Filter harga lama (overlap rentang) tetap ada di AND — bentuknya
      // { AND: [loOk, hiOk] } bersarang, jadi cari via JSON.
      const priceClause = (where.AND ?? []).find((c: any) => JSON.stringify(c).includes('priceMin'));
      expect(priceClause).toBeDefined();
    });

    it('filter baru juga berlaku di sort=popular', async () => {
      await service.getFeed(VIEWER_ID, { sort: 'popular', limit: 20, condition: 'BEKAS', minSellerRating: 3.5 } as any);
      const where = mockPrisma.userShowcase.findMany.mock.calls[0][0].where;
      expect(where.AND).toContainEqual({ condition: 'BEKAS' });
      expect(where.AND).toContainEqual({ user: { averageRating: { gte: 3.5 } } });
    });
  });

  // ------------------------------------------------------------------
  // Item 6: condition di create/update
  // ------------------------------------------------------------------
  describe('condition di create/update (item 6)', () => {
    it('create menyimpan condition', async () => {
      await service.createShowcaseItem(OWNER_ID, createDto({
        imageFileKeys: [IMG_KEY],
        condition: 'BEKAS',
      }));
      const data = mockPrisma.userShowcase.create.mock.calls[0][0].data;
      expect(data.condition).toBe('BEKAS');
    });

    it('update menyimpan condition', async () => {
      await service.updateShowcaseItem(OWNER_ID, SHOWCASE_ID, { condition: 'BARU' } as any);
      const data = mockPrisma.userShowcase.update.mock.calls[0][0].data;
      expect(data.condition).toBe('BARU');
    });

    it('serializer detail mengembalikan condition, saveCount, dan isSaved', async () => {
      mockPrisma.showcaseLike.findMany.mockResolvedValue([]);
      mockPrisma.showcaseSave.findMany.mockResolvedValue([{ userId: VIEWER_ID, showcaseId: SHOWCASE_ID }]);
      const row = showcaseRow({ condition: 'BEKAS', saveCount: 5 });
      mockPrisma.userShowcase.findFirst.mockResolvedValue(row);
      const result = (await service.getShowcaseDetail(SHOWCASE_ID, VIEWER_ID)) as any;
      expect(result.condition).toBe('BEKAS');
      expect(result.saveCount).toBe(5);
      expect(result.isSaved).toBe(true);
      expect(result.isLiked).toBe(false);
    });
  });
});
