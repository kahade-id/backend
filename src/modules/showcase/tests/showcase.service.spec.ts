import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { ShowcaseVisibility } from '@prisma/client';
import { ShowcaseService } from '../showcase.service';
import { CreateShowcaseItemDto, UpdateShowcaseItemDto } from '../dto/showcase-item.dto';
import { PrismaService } from '../../../prisma/prisma.service';
import { RedisService } from '../../../redis/redis.service';
import { UploadService } from '../../upload/upload.service';
import * as ErrorCodes from '../../../common/constants/error-codes';
import { SHOWCASE_MAX_IMAGES, SHOWCASE_MAX_ITEMS } from '../../../common/constants/app.constants';

const OWNER_ID = 'owner-1';
const VIEWER_ID = 'viewer-1';
const SHOWCASE_ID = 'cshowcase000000000000001';
const FILE_KEY = `uploads/showcase-images/${OWNER_ID}/1700000000-abc-photo.jpg`;

function showcaseRow(overrides: Record<string, unknown> = {}) {
  return {
    id: SHOWCASE_ID,
    userId: OWNER_ID,
    title: 'Ilustrasi karakter',
    description: 'Komisi ilustrasi full body dengan dua kali revisi.',
    category: 'ilustrasi',
    visibility: ShowcaseVisibility.PUBLIC,
    priceMin: 150000n,
    priceMax: 350000n,
    isActive: true,
    sortOrder: 0,
    likeCount: 4,
    commentCount: 2,
    viewCount: 30,
    createdAt: new Date('2026-09-01T00:00:00.000Z'),
    updatedAt: new Date('2026-09-01T00:00:00.000Z'),
    images: [{ id: 'img-1', imageUrl: 'https://cdn.test/a.jpg', fileKey: FILE_KEY, sortOrder: 0 }],
    user: {
      id: OWNER_ID,
      userId: 'USR-OWNER01',
      username: 'seller',
      fullName: 'Toko Seller',
      avatarUrl: 'https://cdn.test/avatar.jpg',
      kycStatus: 'APPROVED',
      isVip: false,
      membershipRank: 'GOLD',
      // Field kesehatan akun pemilik: dipakai mock "DB" di bawah untuk
      // mengevaluasi filter visibilitas, tidak ikut diserialisasi.
      isActive: true,
      isBanned: false,
      deletedAt: null,
      profileVisible: true,
    },
    ...overrides,
  };
}

function ownerHealthy(row: any): boolean {
  const u = row.user;
  return u.isActive !== false && u.isBanned !== true && u.deletedAt == null && u.profileVisible !== false;
}

/**
 * Evaluator `where` mini untuk userShowcase.findFirst. Tanpa ini, mock selalu
 * mengembalikan barisnya sehingga gate visibilitas (PRIVATE / owner tidak sehat /
 * block-list) tidak benar-benar teruji.
 */
function matchesShowcaseWhere(row: any, where: any): boolean {
  if (!row) return false;
  if (where?.id && row.id !== where.id) return false;
  if (where?.userId && row.userId !== where.userId) return false;
  if (where?.isActive !== undefined && row.isActive !== where.isActive) return false;
  if (!where?.OR) return true;
  return where.OR.some((branch: any) => {
    if (branch.userId !== undefined && row.userId !== branch.userId) return false;
    if (branch.visibility !== undefined && row.visibility !== branch.visibility) return false;
    if (branch.user) {
      if (!ownerHealthy(row)) return false;
      const notIn = branch.user.id?.notIn;
      if (Array.isArray(notIn) && notIn.includes(row.userId)) return false;
    }
    return true;
  });
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
  showcaseImage: { findMany: jest.fn(), findFirst: jest.fn(), createMany: jest.fn(), updateMany: jest.fn(), delete: jest.fn() },
  showcaseLike: { findMany: jest.fn(), create: jest.fn(), deleteMany: jest.fn() },
  showcaseComment: { findMany: jest.fn(), findFirst: jest.fn(), findUnique: jest.fn(), count: jest.fn(), create: jest.fn(), update: jest.fn(), delete: jest.fn() },
  $transaction: jest.fn(),
};

const mockRedis = { setNx: jest.fn(), get: jest.fn(), set: jest.fn(), del: jest.fn() };
const mockUpload = {
  verifyUserFileKeys: jest.fn(),
  buildPublicUrl: jest.fn((key: string) => `https://cdn.test/${key}`),
  cleanupFileKeys: jest.fn().mockResolvedValue({ deleted: 1, errors: [] }),
  uploadDirect: jest.fn(),
};
const mockConfig = { get: jest.fn((key: string) => (key === 'app.publicWebBaseUrl' ? 'https://kahade.id' : undefined)) };

describe('ShowcaseService — owner CRUD, images, public read, view counter', () => {
  let service: ShowcaseService;
  /** Baris yang "ada di database" untuk userShowcase.findFirst. */
  let dbRow: any;

  beforeEach(async () => {
    jest.clearAllMocks();
    mockUpload.buildPublicUrl.mockImplementation((key: string) => `https://cdn.test/${key}`);
    mockUpload.cleanupFileKeys.mockResolvedValue({ deleted: 1, errors: [] });
    mockConfig.get.mockImplementation((key: string) => (key === 'app.publicWebBaseUrl' ? 'https://kahade.id' : undefined));

    // $transaction mendukung dua bentuk: callback (dijalankan dengan prisma mock
    // sebagai tx) dan array of promises.
    mockPrisma.$transaction.mockImplementation(async (arg: unknown) =>
      typeof arg === 'function' ? (arg as (tx: unknown) => Promise<unknown>)(mockPrisma) : Promise.all(arg as never[]),
    );

    mockPrisma.blockList.findFirst.mockResolvedValue(null);
    mockPrisma.blockList.findMany.mockResolvedValue([]);
    mockPrisma.userShowcase.count.mockResolvedValue(0);
    dbRow = showcaseRow();
    mockPrisma.userShowcase.findFirst.mockImplementation(async (args: any) =>
      matchesShowcaseWhere(dbRow, args?.where) ? dbRow : null,
    );
    mockPrisma.userShowcase.findMany.mockResolvedValue([showcaseRow()]);
    mockPrisma.userShowcase.findUnique.mockResolvedValue({ id: SHOWCASE_ID, likeCount: 4, viewCount: 30, commentCount: 2 });
    // Mock create/update meniru perilaku Prisma: nested `images.create`
    // dikembalikan sebagai baris gambar, bukan sebagai objek perintah.
    mockPrisma.userShowcase.create.mockImplementation(async (args: any) => {
      const d = args.data;
      return showcaseRow({
        ...d,
        priceMin: d.priceMin ?? null,
        priceMax: d.priceMax ?? null,
        likeCount: 0,
        commentCount: 0,
        viewCount: 0,
        images: (d.images?.create ?? []).map((img: any, i: number) => ({ id: `img-${i}`, ...img })),
      });
    });
    mockPrisma.userShowcase.update.mockImplementation(async (args: any) => {
      const d = { ...args.data };
      const images = d.images
        ? (d.images.create ?? []).map((img: any, i: number) => ({ id: `img-${i}`, ...img }))
        : showcaseRow().images;
      delete d.images;
      return showcaseRow({ ...d, images });
    });
    mockUpload.verifyUserFileKeys.mockResolvedValue(undefined);
    mockPrisma.userShowcase.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.showcaseImage.findMany.mockResolvedValue([]);
    mockPrisma.showcaseImage.createMany.mockResolvedValue({ count: 1 });
    mockPrisma.showcaseImage.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.showcaseLike.findMany.mockResolvedValue([]);
    mockRedis.setNx.mockResolvedValue(true);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ShowcaseService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: RedisService, useValue: mockRedis },
        { provide: UploadService, useValue: mockUpload },
        { provide: ConfigService, useValue: mockConfig },
      ],
    }).compile();
    service = module.get<ShowcaseService>(ShowcaseService);
  });

  // ------------------------------------------------------------------
  // getMyShowcase
  // ------------------------------------------------------------------
  describe('getMyShowcase', () => {
    it('returns every item including inactive and private ones', async () => {
      mockPrisma.userShowcase.findMany.mockResolvedValue([
        showcaseRow(),
        showcaseRow({ id: 'cshowcase000000000000002', isActive: false, visibility: ShowcaseVisibility.PRIVATE }),
      ]);
      const result = (await service.getMyShowcase(OWNER_ID)) as any;
      expect(result.total).toBe(2);
      expect(result.items.every((i: any) => i.isOwner)).toBe(true);
      expect(result.limits).toEqual({ maxItems: SHOWCASE_MAX_ITEMS, maxImagesPerItem: SHOWCASE_MAX_IMAGES });
      const where = mockPrisma.userShowcase.findMany.mock.calls[0][0].where;
      // Tidak ada filter isActive/visibility di jalur owner.
      expect(where).toEqual({ userId: OWNER_ID });
    });

    it('serializes BigInt prices to numbers and keeps a deprecated imageUrl alias', async () => {
      const result = (await service.getMyShowcase(OWNER_ID)) as any;
      const item = result.items[0];
      expect(item.priceMin).toBe(150000);
      expect(item.priceMax).toBe(350000);
      expect(item.imageUrl).toBe('https://cdn.test/a.jpg');
      expect(item.coverImageUrl).toBe('https://cdn.test/a.jpg');
      expect(item.images).toEqual([{ id: 'img-1', imageUrl: 'https://cdn.test/a.jpg', sortOrder: 0 }]);
    });

    it('exposes ready-to-use OrderLink data on every item', async () => {
      const result = (await service.getMyShowcase(OWNER_ID)) as any;
      expect(result.items[0].orderLink).toEqual({
        title: 'Ilustrasi karakter',
        description: 'Komisi ilustrasi full body dengan dua kali revisi.',
        orderValue: 150000,
        orderValueValid: true,
        counterpartUsername: 'seller',
      });
    });

    it('builds an OrderLink description fallback when the showcase has none', async () => {
      mockPrisma.userShowcase.findMany.mockResolvedValue([showcaseRow({ description: null })]);
      const result = (await service.getMyShowcase(OWNER_ID)) as any;
      expect(result.items[0].orderLink.description).toContain('Pesan "Ilustrasi karakter" dari @seller');
      expect(result.items[0].orderLink.description.length).toBeGreaterThanOrEqual(10);
    });

    it('flags an OrderLink value outside the allowed order range instead of silently clamping', async () => {
      mockPrisma.userShowcase.findMany.mockResolvedValue([showcaseRow({ priceMin: 1000n, priceMax: null })]);
      const result = (await service.getMyShowcase(OWNER_ID)) as any;
      expect(result.items[0].orderLink).toMatchObject({ orderValue: 1000, orderValueValid: false });
    });

    it('reports orderValue null and invalid when the item has no price', async () => {
      mockPrisma.userShowcase.findMany.mockResolvedValue([showcaseRow({ priceMin: null, priceMax: null })]);
      const result = (await service.getMyShowcase(OWNER_ID)) as any;
      expect(result.items[0].orderLink).toMatchObject({ orderValue: null, orderValueValid: false });
    });

    it('orders items by sortOrder with an { id } tiebreak', async () => {
      await service.getMyShowcase(OWNER_ID);
      expect(mockPrisma.userShowcase.findMany.mock.calls[0][0].orderBy).toEqual([{ sortOrder: 'asc' }, { id: 'asc' }]);
    });
  });

  // ------------------------------------------------------------------
  // createShowcaseItem
  // ------------------------------------------------------------------
  describe('createShowcaseItem', () => {
    const dto = (overrides: Partial<CreateShowcaseItemDto> = {}) =>
      ({ title: 'Item baru', ...overrides }) as CreateShowcaseItemDto;

    it('creates an item with PUBLIC visibility by default', async () => {
      await service.createShowcaseItem(OWNER_ID, dto());
      const data = mockPrisma.userShowcase.create.mock.calls[0][0].data;
      expect(data).toMatchObject({ userId: OWNER_ID, title: 'Item baru', visibility: ShowcaseVisibility.PUBLIC, sortOrder: 0 });
    });

    it('appends after the existing item count when sortOrder is omitted', async () => {
      mockPrisma.userShowcase.count.mockResolvedValue(7);
      await service.createShowcaseItem(OWNER_ID, dto());
      expect(mockPrisma.userShowcase.create.mock.calls[0][0].data.sortOrder).toBe(7);
    });

    it(`rejects creation beyond ${SHOWCASE_MAX_ITEMS} items`, async () => {
      mockPrisma.userShowcase.count.mockResolvedValue(SHOWCASE_MAX_ITEMS);
      await expect(service.createShowcaseItem(OWNER_ID, dto())).rejects.toMatchObject({
        response: { code: ErrorCodes.SHOWCASE_ITEM_LIMIT_REACHED },
      });
      expect(mockPrisma.userShowcase.create).not.toHaveBeenCalled();
    });

    it('rejects a whitespace-only title', async () => {
      await expect(service.createShowcaseItem(OWNER_ID, dto({ title: '   ' }))).rejects.toThrow(BadRequestException);
    });

    it('rejects priceMin greater than priceMax', async () => {
      await expect(service.createShowcaseItem(OWNER_ID, dto({ priceMin: 500, priceMax: 100 }))).rejects.toMatchObject({
        response: { code: ErrorCodes.VALIDATION_ERROR },
      });
      expect(mockPrisma.userShowcase.create).not.toHaveBeenCalled();
    });

    it('stores prices as BigInt', async () => {
      await service.createShowcaseItem(OWNER_ID, dto({ priceMin: 150000, priceMax: 350000 }));
      const data = mockPrisma.userShowcase.create.mock.calls[0][0].data;
      expect(data.priceMin).toBe(150000n);
      expect(data.priceMax).toBe(350000n);
    });

    it('normalizes the category to lowercase and maps an empty one to null', async () => {
      await service.createShowcaseItem(OWNER_ID, dto({ category: '  Ilustrasi  ' }));
      expect(mockPrisma.userShowcase.create.mock.calls[0][0].data.category).toBe('ilustrasi');

      await service.createShowcaseItem(OWNER_ID, dto({ category: '   ' }));
      expect(mockPrisma.userShowcase.create.mock.calls[1][0].data.category).toBeNull();
    });

    it('verifies image keys through the presigned-upload pipeline before storing them', async () => {
      await service.createShowcaseItem(OWNER_ID, dto({ imageFileKeys: [FILE_KEY] }));
      expect(mockUpload.verifyUserFileKeys).toHaveBeenCalledWith(OWNER_ID, [FILE_KEY], 'SHOWCASE_IMAGE', {
        maxFiles: SHOWCASE_MAX_IMAGES,
        consume: true,
        label: 'Showcase image',
      });
      const images = mockPrisma.userShowcase.create.mock.calls[0][0].data.images.create;
      expect(images).toEqual([{ imageUrl: `https://cdn.test/${FILE_KEY}`, fileKey: FILE_KEY, sortOrder: 0 }]);
    });

    it('assigns ascending sortOrder to multiple images', async () => {
      const keys = [FILE_KEY, FILE_KEY.replace('photo', 'photo2'), FILE_KEY.replace('photo', 'photo3')];
      await service.createShowcaseItem(OWNER_ID, dto({ imageFileKeys: keys }));
      const images = mockPrisma.userShowcase.create.mock.calls[0][0].data.images.create;
      expect(images.map((i: any) => i.sortOrder)).toEqual([0, 1, 2]);
    });

    it(`rejects more than ${SHOWCASE_MAX_IMAGES} images`, async () => {
      const keys = Array.from({ length: SHOWCASE_MAX_IMAGES + 1 }, (_, i) => FILE_KEY.replace('photo', `photo${i}`));
      await expect(service.createShowcaseItem(OWNER_ID, dto({ imageFileKeys: keys }))).rejects.toMatchObject({
        response: { code: ErrorCodes.SHOWCASE_IMAGE_LIMIT_REACHED },
      });
      expect(mockUpload.verifyUserFileKeys).not.toHaveBeenCalled();
      expect(mockPrisma.userShowcase.create).not.toHaveBeenCalled();
    });

    it('propagates an upload verification failure without creating the item', async () => {
      mockUpload.verifyUserFileKeys.mockRejectedValue(new BadRequestException({ code: ErrorCodes.UPLOAD_NOT_CONFIRMED }));
      await expect(service.createShowcaseItem(OWNER_ID, dto({ imageFileKeys: [FILE_KEY] }))).rejects.toMatchObject({
        response: { code: ErrorCodes.UPLOAD_NOT_CONFIRMED },
      });
      expect(mockPrisma.userShowcase.create).not.toHaveBeenCalled();
    });
  });

  // ------------------------------------------------------------------
  // updateShowcaseItem / deleteShowcaseItem
  // ------------------------------------------------------------------
  describe('updateShowcaseItem', () => {
    it('rejects an item that does not belong to the caller', async () => {
      dbRow = null;
      await expect(service.updateShowcaseItem(VIEWER_ID, SHOWCASE_ID, {} as UpdateShowcaseItemDto)).rejects.toMatchObject({
        response: { code: ErrorCodes.SHOWCASE_NOT_FOUND },
      });
      expect(mockPrisma.userShowcase.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: SHOWCASE_ID, userId: VIEWER_ID } }),
      );
    });

    it('validates the merged price range, not just the submitted fields', async () => {
      // Item punya priceMax 350000; update priceMin 500000 harus ditolak walau
      // priceMax tidak ikut dikirim.
      await expect(
        service.updateShowcaseItem(OWNER_ID, SHOWCASE_ID, { priceMin: 500000 } as UpdateShowcaseItemDto),
      ).rejects.toMatchObject({ response: { code: ErrorCodes.VALIDATION_ERROR } });
      expect(mockPrisma.userShowcase.update).not.toHaveBeenCalled();
    });

    it('can flip an item to PRIVATE', async () => {
      await service.updateShowcaseItem(OWNER_ID, SHOWCASE_ID, { visibility: ShowcaseVisibility.PRIVATE } as UpdateShowcaseItemDto);
      expect(mockPrisma.userShowcase.update.mock.calls[0][0].data).toMatchObject({ visibility: ShowcaseVisibility.PRIVATE });
    });

    it('replaces every image when imageFileKeys is provided and cleans the old objects', async () => {
      await service.updateShowcaseItem(OWNER_ID, SHOWCASE_ID, { imageFileKeys: [FILE_KEY] } as UpdateShowcaseItemDto);
      const data = mockPrisma.userShowcase.update.mock.calls[0][0].data;
      expect(data.images.deleteMany).toEqual({});
      expect(data.images.create).toHaveLength(1);
      expect(mockUpload.cleanupFileKeys).toHaveBeenCalledWith(OWNER_ID, [FILE_KEY]);
    });

    it('clears all images when imageFileKeys is an empty array', async () => {
      await service.updateShowcaseItem(OWNER_ID, SHOWCASE_ID, { imageFileKeys: [] } as UpdateShowcaseItemDto);
      const data = mockPrisma.userShowcase.update.mock.calls[0][0].data;
      expect(data.images.deleteMany).toEqual({});
      expect(data.images.create).toEqual([]);
    });

    it('does not touch images when imageFileKeys is omitted', async () => {
      await service.updateShowcaseItem(OWNER_ID, SHOWCASE_ID, { title: 'Judul baru' } as UpdateShowcaseItemDto);
      const data = mockPrisma.userShowcase.update.mock.calls[0][0].data;
      expect(data.images).toBeUndefined();
      expect(mockUpload.cleanupFileKeys).not.toHaveBeenCalled();
    });

    it('survives an R2 cleanup failure (storage cleanup must not fail the update)', async () => {
      mockUpload.cleanupFileKeys.mockRejectedValue(new Error('r2 down'));
      await expect(
        service.updateShowcaseItem(OWNER_ID, SHOWCASE_ID, { imageFileKeys: [] } as UpdateShowcaseItemDto),
      ).resolves.toBeDefined();
    });
  });

  describe('deleteShowcaseItem', () => {
    it('deletes the item and cleans up its stored images', async () => {
      await expect(service.deleteShowcaseItem(OWNER_ID, SHOWCASE_ID)).resolves.toEqual({
        message: 'Showcase item deleted successfully',
      });
      expect(mockPrisma.userShowcase.delete).toHaveBeenCalledWith({ where: { id: SHOWCASE_ID } });
      expect(mockUpload.cleanupFileKeys).toHaveBeenCalledWith(OWNER_ID, [FILE_KEY]);
    });

    it('rejects deleting an item owned by someone else', async () => {
      dbRow = null;
      await expect(service.deleteShowcaseItem(VIEWER_ID, SHOWCASE_ID)).rejects.toThrow(NotFoundException);
      expect(mockPrisma.userShowcase.delete).not.toHaveBeenCalled();
    });
  });

  // ------------------------------------------------------------------
  // Image management
  // ------------------------------------------------------------------
  describe('image management', () => {
    it('appends attached images after the highest existing sortOrder', async () => {
      dbRow = showcaseRow({
        images: [
          { id: 'img-1', imageUrl: 'a', fileKey: 'k1', sortOrder: 3 },
          { id: 'img-2', imageUrl: 'b', fileKey: 'k2', sortOrder: 1 },
        ],
      });
      await service.attachImages(OWNER_ID, SHOWCASE_ID, [FILE_KEY]);
      expect(mockPrisma.showcaseImage.createMany.mock.calls[0][0].data).toEqual([
        { showcaseId: SHOWCASE_ID, imageUrl: `https://cdn.test/${FILE_KEY}`, fileKey: FILE_KEY, sortOrder: 4 },
      ]);
    });

    it('rejects attaching images past the per-item limit', async () => {
      dbRow = showcaseRow({ images: Array.from({ length: SHOWCASE_MAX_IMAGES }, (_, i) => ({ id: `i${i}`, imageUrl: 'x', fileKey: null, sortOrder: i })) });
      await expect(service.attachImages(OWNER_ID, SHOWCASE_ID, [FILE_KEY])).rejects.toMatchObject({
        response: { code: ErrorCodes.SHOWCASE_IMAGE_LIMIT_REACHED },
      });
      expect(mockPrisma.showcaseImage.createMany).not.toHaveBeenCalled();
    });

    it('only removes an image that belongs to the caller', async () => {
      mockPrisma.showcaseImage.findFirst.mockResolvedValue(null);
      await expect(service.removeImage(VIEWER_ID, 'img-1')).rejects.toThrow(NotFoundException);
      expect(mockPrisma.showcaseImage.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'img-1', showcase: { userId: VIEWER_ID } } }),
      );
      expect(mockPrisma.showcaseImage.delete).not.toHaveBeenCalled();
    });

    it('deletes the stored object when removing an image', async () => {
      mockPrisma.showcaseImage.findFirst.mockResolvedValue({ id: 'img-1', fileKey: FILE_KEY, showcaseId: SHOWCASE_ID });
      await service.removeImage(OWNER_ID, 'img-1');
      expect(mockPrisma.showcaseImage.delete).toHaveBeenCalledWith({ where: { id: 'img-1' } });
      expect(mockUpload.cleanupFileKeys).toHaveBeenCalledWith(OWNER_ID, [FILE_KEY]);
    });

    it('requires the exact image set when reordering', async () => {
      dbRow = showcaseRow({ images: [{ id: 'img-1', imageUrl: 'a', fileKey: null, sortOrder: 0 }, { id: 'img-2', imageUrl: 'b', fileKey: null, sortOrder: 1 }] });
      await expect(service.reorderImages(OWNER_ID, SHOWCASE_ID, ['img-1'])).rejects.toMatchObject({
        response: { code: ErrorCodes.VALIDATION_ERROR },
      });
      await expect(service.reorderImages(OWNER_ID, SHOWCASE_ID, ['img-1', 'img-9'])).rejects.toThrow(BadRequestException);
      expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    });

    it('writes sortOrder 0..n-1 in the requested order', async () => {
      dbRow = showcaseRow({ images: [{ id: 'img-1', imageUrl: 'a', fileKey: null, sortOrder: 0 }, { id: 'img-2', imageUrl: 'b', fileKey: null, sortOrder: 1 }] });
      await service.reorderImages(OWNER_ID, SHOWCASE_ID, ['img-2', 'img-1']);
      const ops = mockPrisma.$transaction.mock.calls[0][0];
      expect(ops).toHaveLength(2);
      expect(mockPrisma.showcaseImage.updateMany).toHaveBeenCalledWith({ where: { id: 'img-2', showcaseId: SHOWCASE_ID }, data: { sortOrder: 0 } });
      expect(mockPrisma.showcaseImage.updateMany).toHaveBeenCalledWith({ where: { id: 'img-1', showcaseId: SHOWCASE_ID }, data: { sortOrder: 1 } });
    });
  });

  describe('uploadShowcaseImageDirect', () => {
    it('routes the legacy multipart upload through UploadService with the showcase purpose', async () => {
      mockUpload.uploadDirect.mockResolvedValue({ fileKey: FILE_KEY, fileUrl: `https://cdn.test/${FILE_KEY}` });
      const result = await service.uploadShowcaseImageDirect(OWNER_ID, 'photo.jpg', 'image/jpeg', Buffer.from('x'));
      expect(mockUpload.uploadDirect).toHaveBeenCalledWith(OWNER_ID, 'SHOWCASE_IMAGE', 'photo.jpg', 'image/jpeg', expect.any(Buffer));
      expect(result).toEqual({ imageUrl: `https://cdn.test/${FILE_KEY}`, fileKey: FILE_KEY });
    });
  });

  // ------------------------------------------------------------------
  // getShowcaseByUsername (etalase profil publik)
  // ------------------------------------------------------------------
  describe('getShowcaseByUsername', () => {
    const healthyOwner = { id: OWNER_ID, profileVisible: true, isActive: true, isBanned: false, deletedAt: null };

    beforeEach(() => {
      mockPrisma.user.findUnique.mockResolvedValue(healthyOwner);
    });

    it('returns 404 for an unknown, private, inactive, banned or deleted owner', async () => {
      for (const overrides of [
        null,
        { profileVisible: false },
        { isActive: false },
        { isBanned: true },
        { deletedAt: new Date() },
      ]) {
        mockPrisma.user.findUnique.mockResolvedValue(overrides ? { ...healthyOwner, ...overrides } : null);
        await expect(service.getShowcaseByUsername('seller')).rejects.toThrow(NotFoundException);
      }
      expect(mockPrisma.userShowcase.findMany).not.toHaveBeenCalled();
    });

    it('rejects with 403 USER_BLOCKED across a block relationship in either direction', async () => {
      mockPrisma.blockList.findFirst.mockResolvedValue({ id: 'b1' });
      await expect(service.getShowcaseByUsername('seller', VIEWER_ID)).rejects.toThrow(ForbiddenException);
      await expect(service.getShowcaseByUsername('seller', VIEWER_ID)).rejects.toMatchObject({
        response: { code: ErrorCodes.USER_BLOCKED },
      });
      expect(mockPrisma.userShowcase.findMany).not.toHaveBeenCalled();
    });

    it('skips the block check for an anonymous viewer and for the owner', async () => {
      await service.getShowcaseByUsername('seller');
      await service.getShowcaseByUsername('seller', OWNER_ID);
      expect(mockPrisma.blockList.findFirst).not.toHaveBeenCalled();
    });

    it('only lists PUBLIC and active items of a healthy owner', async () => {
      await service.getShowcaseByUsername('seller', VIEWER_ID);
      const args = mockPrisma.userShowcase.findMany.mock.calls[0][0];
      expect(args.where.isActive).toBe(true);
      expect(args.where.visibility).toBe(ShowcaseVisibility.PUBLIC);
      expect(args.where.userId).toBe(OWNER_ID);
      expect(args.where.user).toMatchObject({ isActive: true, isBanned: false, deletedAt: null, profileVisible: true });
      expect(args.orderBy).toEqual([{ sortOrder: 'asc' }, { id: 'asc' }]);
    });

    it('lowercases the username before lookup', async () => {
      await service.getShowcaseByUsername('SeLLer');
      expect(mockPrisma.user.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({ where: { username: 'seller' } }),
      );
    });

    it('marks which items the viewer liked in a single batched query', async () => {
      mockPrisma.userShowcase.findMany.mockResolvedValue([showcaseRow(), showcaseRow({ id: 'cshowcase000000000000002' })]);
      mockPrisma.showcaseLike.findMany.mockResolvedValue([{ showcaseId: 'cshowcase000000000000002' }]);
      const result = (await service.getShowcaseByUsername('seller', VIEWER_ID)) as any;
      expect(result.items.map((i: any) => i.isLiked)).toEqual([false, true]);
      expect(mockPrisma.showcaseLike.findMany).toHaveBeenCalledTimes(1);
    });
  });

  // ------------------------------------------------------------------
  // getShowcaseDetail + viewCount
  // ------------------------------------------------------------------
  describe('getShowcaseDetail', () => {
    it('returns 404 for a PRIVATE item viewed by someone else', async () => {
      dbRow = showcaseRow({ visibility: ShowcaseVisibility.PRIVATE });
      await expect(service.getShowcaseDetail(SHOWCASE_ID, VIEWER_ID)).rejects.toMatchObject({
        response: { code: ErrorCodes.SHOWCASE_NOT_FOUND },
      });
    });

    it('lets the owner read their own PRIVATE item', async () => {
      dbRow = showcaseRow({ visibility: ShowcaseVisibility.PRIVATE });
      const result = (await service.getShowcaseDetail(SHOWCASE_ID, OWNER_ID)) as any;
      expect(result.isOwner).toBe(true);
      expect(result.visibility).toBe(ShowcaseVisibility.PRIVATE);
    });

    it('asks the database for the owner-visible OR self branch', async () => {
      await service.getShowcaseDetail(SHOWCASE_ID, VIEWER_ID);
      const where = mockPrisma.userShowcase.findFirst.mock.calls[0][0].where;
      expect(where.OR).toHaveLength(2);
      expect(where.OR[0]).toEqual({ userId: VIEWER_ID });
      expect(where.OR[1]).toEqual({
        visibility: ShowcaseVisibility.PUBLIC,
        user: expect.objectContaining({ isActive: true, isBanned: false, deletedAt: null, profileVisible: true }),
      });
    });

    it('increments viewCount atomically and returns the post-increment value', async () => {
      const result = (await service.getShowcaseDetail(SHOWCASE_ID, VIEWER_ID)) as any;
      expect(mockPrisma.userShowcase.updateMany).toHaveBeenCalledWith({
        where: { id: SHOWCASE_ID },
        data: { viewCount: { increment: 1 } },
      });
      expect(result.viewCount).toBe(31);
    });

    it('counts a view only once per viewer within the dedupe window', async () => {
      mockRedis.setNx.mockResolvedValue(false);
      const result = (await service.getShowcaseDetail(SHOWCASE_ID, VIEWER_ID)) as any;
      expect(mockPrisma.userShowcase.updateMany).not.toHaveBeenCalled();
      expect(result.viewCount).toBe(30);
    });

    it('scopes the dedupe key to the viewer and never stores a raw IP', async () => {
      await service.getShowcaseDetail(SHOWCASE_ID, VIEWER_ID);
      expect(mockRedis.setNx.mock.calls[0][0]).toBe(`showcase:view:${SHOWCASE_ID}:u:${VIEWER_ID}`);
      expect(mockRedis.setNx.mock.calls[0][2]).toBeGreaterThan(0);

      mockRedis.setNx.mockClear();
      await service.getShowcaseDetail(SHOWCASE_ID, undefined, { clientIp: '203.0.113.9' });
      const anonKey = mockRedis.setNx.mock.calls[0][0] as string;
      expect(anonKey).not.toContain('203.0.113.9');
      expect(anonKey.startsWith(`showcase:view:${SHOWCASE_ID}:ip:`)).toBe(true);
    });

    it('still counts a view for an anonymous caller without an IP', async () => {
      await service.getShowcaseDetail(SHOWCASE_ID);
      expect(mockRedis.setNx).not.toHaveBeenCalled();
      expect(mockPrisma.userShowcase.updateMany).toHaveBeenCalled();
    });
  });

  // ------------------------------------------------------------------
  // getSharePayload
  // ------------------------------------------------------------------
  describe('getSharePayload', () => {
    it('refuses to share a PRIVATE item', async () => {
      dbRow = showcaseRow({ visibility: ShowcaseVisibility.PRIVATE });
      await expect(service.getSharePayload(SHOWCASE_ID)).rejects.toThrow(NotFoundException);
    });

    it('builds the web share URL and the app deep link', async () => {
      const payload = (await service.getSharePayload(SHOWCASE_ID)) as any;
      expect(payload.shareUrl).toBe(`https://kahade.id/showcase/${SHOWCASE_ID}`);
      expect(payload.appUrl).toBe(`kahade-frontend://showcase/${SHOWCASE_ID}`);
      expect(payload).toMatchObject({ title: 'Ilustrasi karakter', authorUsername: 'seller', imageUrl: 'https://cdn.test/a.jpg' });
    });

    it('renders a price range, a single price, or a negotiation label', async () => {
      expect(((await service.getSharePayload(SHOWCASE_ID)) as any).priceLabel).toBe('Rp 150000 - Rp 350000');
      dbRow = showcaseRow({ priceMin: 150000n, priceMax: 150000n });
      expect(((await service.getSharePayload(SHOWCASE_ID)) as any).priceLabel).toBe('Rp 150000');
      dbRow = showcaseRow({ priceMin: null, priceMax: null, description: null });
      const payload = (await service.getSharePayload(SHOWCASE_ID)) as any;
      expect(payload.priceLabel).toBe('Harga lewat diskusi');
      expect(payload.description).toBe('Harga lewat diskusi');
    });

    it('falls back to the public userId when the owner has no username', async () => {
      dbRow = showcaseRow({ user: { id: OWNER_ID, userId: 'USR-OWNER01', username: null, fullName: 'T', avatarUrl: null, kycStatus: 'PENDING', isVip: false, membershipRank: 'BRONZE' } });
      const payload = (await service.getSharePayload(SHOWCASE_ID)) as any;
      expect(payload.authorUsername).toBe('USR-OWNER01');
    });
  });
});
