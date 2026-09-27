/**
 * Test regresi untuk temuan audit Etalase (P0/P1) — backend.
 *
 * Cakupan per ID temuan:
 *  - SH-B-001: owner boleh preview item nonaktif miliknya; view tidak dihitung.
 *  - SH-B-002: hapus gambar terakhir ditolak (SHOWCASE_IMAGE_MIN_ONE) + row lock.
 *  - SH-B-003: priceMin/priceMax dibatasi ORDER_MAX_VALUE (DTO + assertPriceRange).
 *  - SH-B-004/SH-S-002: share dedupe 24 jam + bot UA tidak menaikkan counter.
 *  - SH-B-005/SH-S-008: recordView fail-open saat Redis down.
 *  - SH-B-006: attachImages — batas gambar dicek ulang di dalam transaksi.
 *  - SH-B-007: consume konfirmasi upload SETELAH update DB sukses.
 *  - SH-B-008: restore item tidak boleh melewati SHOWCASE_MAX_ITEMS.
 *  - SH-B-009: komentar pada item nonaktif/takedown di tengah jalan → rollback.
 *  - SH-B-010: like pada item nonaktif/takedown di tengah jalan → rollback.
 *  - SH-S-001: polyglot `promo.html` (magic JPEG) tersimpan sebagai `.jpg`.
 *  - SH-S-004: downloadOwnFile menolak key traversal dengan 400 terkontrol.
 *  - bot-detection util: pola UA crawler umum.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { validate } from 'class-validator';
import { ShowcaseVisibility } from '@prisma/client';
import { ShowcaseService } from '../showcase.service';
import { CreateShowcaseItemDto } from '../dto/showcase-item.dto';
import { UploadController } from '../../upload/upload.controller';
import { UploadService } from '../../upload/upload.service';
import { LocalStorageService } from '../../upload/local-storage.service';
import { RedisService } from '../../../redis/redis.service';
import { PrismaService } from '../../../prisma/prisma.service';
import { AuditLogService } from '../../../common/services/audit-log.service';
import { VerificationBadgeService } from '../../users/verification-badge.service';
import { SubscriptionsService } from '../../subscriptions/subscriptions.service';
import { AdminShowcaseReportsService } from '../../admin/showcase-reports/admin-showcase-reports.service';
import * as ErrorCodes from '../../../common/constants/error-codes';
import {
  ORDER_MAX_VALUE,
  SHOWCASE_MAX_ITEMS,
} from '../../../common/constants/app.constants';
import { isBotUserAgent } from '../../../common/utils/bot-detection.util';
import { UploadPurpose } from '../../upload/dto/presigned-url.dto';

const OWNER_ID = 'owner-1';
const VIEWER_ID = 'viewer-1';
const SHOWCASE_ID = 'cshowcase000000000000001';
const FILE_KEY = `uploads/showcase-images/${OWNER_ID}/1700000000-abc-photo.jpg`;

function showcaseRow(overrides: Record<string, unknown> = {}) {
  return {
    id: SHOWCASE_ID,
    userId: OWNER_ID,
    title: 'Ilustrasi karakter',
    description: 'Komisi ilustrasi full body.',
    category: 'ilustrasi',
    visibility: ShowcaseVisibility.PUBLIC,
    priceMin: 150000n,
    priceMax: 350000n,
    isActive: true,
    sortOrder: 0,
    likeCount: 4,
    commentCount: 2,
    viewCount: 30,
    shareCount: 7,
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

/** Evaluator `where` mini untuk userShowcase.findFirst (pola spec existing). */
function matchesShowcaseWhere(row: any, where: any): boolean {
  if (!row) return false;
  if (where?.id && row.id !== where.id) return false;
  if (where?.userId && row.userId !== where.userId) return false;
  if (where?.isActive !== undefined && row.isActive !== where.isActive) return false;
  if (where?.deletedAt !== undefined && where.deletedAt === null && row.deletedAt != null) return false;
  if (!where?.OR) return true;
  return where.OR.some((branch: any) => {
    if (branch.userId !== undefined && row.userId !== branch.userId) return false;
    if (branch.visibility !== undefined && row.visibility !== branch.visibility) return false;
    if (branch.isActive !== undefined && row.isActive !== branch.isActive) return false;
    if (branch.user) {
      if (!ownerHealthy(row)) return false;
      const notIn = branch.user.id?.notIn;
      if (Array.isArray(notIn) && notIn.includes(row.userId)) return false;
    }
    return true;
  });
}

function buildMocks() {
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
    showcaseImage: {
      findMany: jest.fn(),
      findFirst: jest.fn(),
      count: jest.fn(),
      createMany: jest.fn(),
      updateMany: jest.fn(),
      delete: jest.fn(),
      deleteMany: jest.fn(),
    },
    showcaseLike: { findMany: jest.fn(), create: jest.fn(), deleteMany: jest.fn() },
    showcaseComment: { findMany: jest.fn(), findFirst: jest.fn(), findUnique: jest.fn(), count: jest.fn(), create: jest.fn(), update: jest.fn(), delete: jest.fn() },
    $transaction: jest.fn(),
    $executeRaw: jest.fn(),
  };
  const mockRedis = {
    setNx: jest.fn(),
    get: jest.fn(),
    set: jest.fn(),
    del: jest.fn(),
    consumeOnce: jest.fn(),
  };
  const mockUpload = {
    verifyUserFileKeys: jest.fn(),
    verifyEvidenceFileKeys: jest.fn(),
    consumeUploadConfirmations: jest.fn(),
    buildPublicUrl: jest.fn((key: string) => `https://cdn.test/${key}`),
    cleanupFileKeys: jest.fn().mockResolvedValue({ deleted: 1, errors: [] }),
    uploadDirect: jest.fn(),
  };
  const mockSubscriptions = {
    isActive: jest.fn().mockResolvedValue(false),
    getMaxShowcaseImages: jest.fn().mockResolvedValue(8),
  };
  return { mockPrisma, mockRedis, mockUpload, mockSubscriptions };
}

async function buildService(mocks: ReturnType<typeof buildMocks>, dbRow: any) {
  const { mockPrisma, mockRedis, mockUpload, mockSubscriptions } = mocks;
  mockPrisma.$transaction.mockImplementation(async (arg: unknown) =>
    typeof arg === 'function' ? (arg as (tx: unknown) => Promise<unknown>)(mockPrisma) : Promise.all(arg as never[]),
  );
  mockPrisma.$executeRaw.mockResolvedValue(1);
  mockPrisma.blockList.findFirst.mockResolvedValue(null);
  mockPrisma.blockList.findMany.mockResolvedValue([]);
  mockPrisma.userShowcase.count.mockResolvedValue(0);
  mockPrisma.userShowcase.findFirst.mockImplementation(async (args: any) =>
    matchesShowcaseWhere(dbRow, args?.where) ? dbRow : null,
  );
  mockPrisma.userShowcase.findMany.mockResolvedValue([]);
  mockPrisma.userShowcase.findUnique.mockResolvedValue(null);
  mockPrisma.userShowcase.updateMany.mockResolvedValue({ count: 1 });
  mockPrisma.showcaseLike.findMany.mockResolvedValue([]);
  mockPrisma.showcaseComment.findMany.mockResolvedValue([]);
  mockRedis.setNx.mockResolvedValue(true);
  mockUpload.verifyUserFileKeys.mockResolvedValue(undefined);
  mockUpload.consumeUploadConfirmations.mockResolvedValue(undefined);
  mockUpload.cleanupFileKeys.mockResolvedValue({ deleted: 1, errors: [] });

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

describe('Audit fixes — bot detection util (SH-B-004/SH-S-002)', () => {
  it('flags common crawler user-agents as bots', () => {
    expect(isBotUserAgent('Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)')).toBe(true);
    expect(isBotUserAgent('facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)')).toBe(true);
    expect(isBotUserAgent('WhatsApp/2.23.12.75 A')).toBe(true);
    expect(isBotUserAgent('TelegramBot (like TwitterBot)')).toBe(true);
    expect(isBotUserAgent('Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)')).toBe(true);
  });

  it('does not flag human browsers or empty UA (no under-count)', () => {
    expect(isBotUserAgent('Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36')).toBe(false);
    expect(isBotUserAgent('Expo/54.0.0 (Android)')).toBe(false);
    expect(isBotUserAgent('')).toBe(false);
    expect(isBotUserAgent(undefined)).toBe(false);
  });
});

describe('Audit fixes — ShowcaseService (SH-B-001/002/003/004/005/006/007/008/009/010)', () => {
  let mocks: ReturnType<typeof buildMocks>;

  beforeEach(() => {
    mocks = buildMocks();
    jest.clearAllMocks();
  });

  // ---------------------------------------------------------------
  // SH-B-001
  // ---------------------------------------------------------------
  describe('SH-B-001 owner preview of inactive item', () => {
    it('owner can view own inactive item; view is NOT counted', async () => {
      const service = await buildService(mocks, showcaseRow({ isActive: false }));
      const result = (await service.getShowcaseDetail(SHOWCASE_ID, OWNER_ID)) as any;
      expect(result.isOwner).toBe(true);
      expect(result.title).toBe('Ilustrasi karakter');
      // Preview item nonaktif tidak menaikkan viewCount.
      expect(mocks.mockRedis.setNx).not.toHaveBeenCalled();
      expect(result.viewCount).toBe(30);
    });

    it('non-owner still gets 404 for inactive item', async () => {
      const service = await buildService(mocks, showcaseRow({ isActive: false }));
      await expect(service.getShowcaseDetail(SHOWCASE_ID, VIEWER_ID)).rejects.toMatchObject({
        response: expect.objectContaining({ code: ErrorCodes.SHOWCASE_NOT_FOUND }),
      });
    });

    it('non-owner viewing ACTIVE item still counts a view', async () => {
      const service = await buildService(mocks, showcaseRow({ isActive: true }));
      const result = (await service.getShowcaseDetail(SHOWCASE_ID, VIEWER_ID)) as any;
      expect(mocks.mockRedis.setNx).toHaveBeenCalled();
      expect(result.viewCount).toBe(31);
    });
  });

  // ---------------------------------------------------------------
  // SH-B-002
  // ---------------------------------------------------------------
  describe('SH-B-002 minimum one image', () => {
    it('rejects deleting the last image with SHOWCASE_IMAGE_MIN_ONE', async () => {
      const service = await buildService(mocks, showcaseRow());
      mocks.mockPrisma.showcaseImage.findFirst.mockResolvedValue({ id: 'img-1', fileKey: FILE_KEY, showcaseId: SHOWCASE_ID });
      mocks.mockPrisma.showcaseImage.count.mockResolvedValue(1);
      await expect(service.removeImage(OWNER_ID, 'img-1')).rejects.toMatchObject({
        response: expect.objectContaining({ code: ErrorCodes.SHOWCASE_IMAGE_MIN_ONE }),
      });
      expect(mocks.mockPrisma.showcaseImage.delete).not.toHaveBeenCalled();
    });

    it('acquires a row lock before count+delete (race-safe)', async () => {
      const service = await buildService(mocks, showcaseRow());
      mocks.mockPrisma.showcaseImage.findFirst.mockResolvedValue({ id: 'img-1', fileKey: FILE_KEY, showcaseId: SHOWCASE_ID });
      mocks.mockPrisma.showcaseImage.count.mockResolvedValue(2);
      mocks.mockPrisma.showcaseImage.delete.mockResolvedValue({ id: 'img-1' });
      await service.removeImage(OWNER_ID, 'img-1');
      // $executeRaw dipanggil sebagai statement pertama di dalam transaksi.
      expect(mocks.mockPrisma.$executeRaw).toHaveBeenCalled();
      const firstTxCall = mocks.mockPrisma.$transaction.mock.calls[0][0].toString();
      expect(firstTxCall).toContain('FOR UPDATE');
    });
  });

  // ---------------------------------------------------------------
  // SH-B-003
  // ---------------------------------------------------------------
  describe('SH-B-003 price upper bound ORDER_MAX_VALUE', () => {
    it('DTO rejects priceMax above ORDER_MAX_VALUE', async () => {
      const dto = new CreateShowcaseItemDto();
      dto.title = 'Komisi';
      dto.priceMin = 0;
      dto.priceMax = ORDER_MAX_VALUE + 1;
      dto.imageFileKeys = ['uploads/showcase-images/x/1-a.jpg'];
      const errors = await validate(dto);
      const priceErrors = errors.filter((e) => e.property === 'priceMax');
      expect(priceErrors.length).toBeGreaterThan(0);
      expect(JSON.stringify(priceErrors)).toContain('max');
    });

    it('service assertPriceRange rejects priceMax above ORDER_MAX_VALUE even bypassing DTO', async () => {
      const service = await buildService(mocks, showcaseRow());
      mocks.mockPrisma.userShowcase.findFirst.mockImplementation(async () => showcaseRow());
      mocks.mockPrisma.userShowcase.update.mockImplementation(async (args: any) => showcaseRow({ ...args.data }));
      await expect(
        service.updateShowcaseItem(OWNER_ID, SHOWCASE_ID, { priceMax: ORDER_MAX_VALUE + 1 } as any),
      ).rejects.toMatchObject({ response: expect.objectContaining({ code: ErrorCodes.VALIDATION_ERROR }) });
    });
  });

  // ---------------------------------------------------------------
  // SH-B-004 / SH-S-002
  // ---------------------------------------------------------------
  describe('SH-B-004/SH-S-002 share dedupe + bot filter', () => {
    it('dedupes repeat shares from the same viewer within the window', async () => {
      const service = await buildService(mocks, showcaseRow());
      mocks.mockRedis.setNx.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
      mocks.mockPrisma.userShowcase.update.mockResolvedValue({ shareCount: 8 });
      const first = await service.recordShareOpen(SHOWCASE_ID, VIEWER_ID, { userAgent: 'Expo/54.0.0' });
      expect(first.shareCount).toBe(8);
      const second = await service.recordShareOpen(SHOWCASE_ID, VIEWER_ID, { userAgent: 'Expo/54.0.0' });
      expect(second.shareCount).toBe(7); // tanpa increment kedua
      expect(mocks.mockPrisma.userShowcase.update).toHaveBeenCalledTimes(1);
      const redisKey = mocks.mockRedis.setNx.mock.calls[0][0] as string;
      expect(redisKey).toContain('showcase:share:');
      expect(redisKey).toContain(VIEWER_ID);
    });

    it('does not count shares from bots/crawlers', async () => {
      const service = await buildService(mocks, showcaseRow());
      const result = await service.recordShareOpen(SHOWCASE_ID, VIEWER_ID, {
        userAgent: 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)',
      });
      expect(result.shareCount).toBe(7);
      expect(mocks.mockRedis.setNx).not.toHaveBeenCalled();
      expect(mocks.mockPrisma.userShowcase.update).not.toHaveBeenCalled();
    });

    it('dedupes anonymous shares per IP hash (no auth required)', async () => {
      const service = await buildService(mocks, showcaseRow());
      mocks.mockPrisma.userShowcase.update.mockResolvedValue({ shareCount: 8 });
      await service.recordShareOpen(SHOWCASE_ID, undefined, { clientIp: '203.0.113.9', userAgent: 'Mozilla/5.0' });
      const redisKey = mocks.mockRedis.setNx.mock.calls[0][0] as string;
      expect(redisKey).toContain('ip:');
      expect(redisKey).not.toContain('203.0.113.9'); // IP di-hash, bukan plaintext
    });

    it('still counts the share (fail-open) when Redis is down', async () => {
      const service = await buildService(mocks, showcaseRow());
      mocks.mockRedis.setNx.mockRejectedValue(new Error('Redis down'));
      mocks.mockPrisma.userShowcase.update.mockResolvedValue({ shareCount: 8 });
      const result = await service.recordShareOpen(SHOWCASE_ID, VIEWER_ID, { userAgent: 'Expo/54.0.0' });
      expect(result.shareCount).toBe(8);
    });
  });

  // ---------------------------------------------------------------
  // SH-B-005 / SH-S-008
  // ---------------------------------------------------------------
  describe('SH-B-005/SH-S-008 view counting survives Redis outage', () => {
    it('GET detail still succeeds when Redis setNx throws', async () => {
      const service = await buildService(mocks, showcaseRow({ isActive: true }));
      mocks.mockRedis.setNx.mockRejectedValue(new Error('Redis down'));
      const result = (await service.getShowcaseDetail(SHOWCASE_ID, VIEWER_ID)) as any;
      expect(result.title).toBe('Ilustrasi karakter');
    });
  });

  // ---------------------------------------------------------------
  // SH-B-006
  // ---------------------------------------------------------------
  describe('SH-B-006 attachImages limit enforced inside the transaction', () => {
    it('rejects when current + new images exceed the limit (checked under lock)', async () => {
      const service = await buildService(mocks, showcaseRow());
      mocks.mockPrisma.showcaseImage.count.mockResolvedValue(7);
      await expect(
        service.attachImages(OWNER_ID, SHOWCASE_ID, ['k1', 'k2']),
      ).rejects.toMatchObject({
        response: expect.objectContaining({ code: ErrorCodes.SHOWCASE_IMAGE_LIMIT_REACHED }),
      });
      expect(mocks.mockPrisma.showcaseImage.createMany).not.toHaveBeenCalled();
      expect(mocks.mockPrisma.$executeRaw).toHaveBeenCalled();
    });

    it('creates images when under the limit', async () => {
      const service = await buildService(mocks, showcaseRow());
      mocks.mockPrisma.showcaseImage.count.mockResolvedValue(6);
      mocks.mockPrisma.showcaseImage.createMany.mockResolvedValue({ count: 1 });
      mocks.mockPrisma.showcaseImage.findMany.mockResolvedValue([{ id: 'img-9', imageUrl: 'x', fileKey: 'k1', sortOrder: 7 }]);
      const result = (await service.attachImages(OWNER_ID, SHOWCASE_ID, ['k1'])) as any;
      expect(result.added).toBe(1);
    });
  });

  // ---------------------------------------------------------------
  // SH-B-007
  // ---------------------------------------------------------------
  describe('SH-B-007 upload confirmations consumed AFTER db update', () => {
    it('validates without consuming, then consumes after a successful update', async () => {
      const service = await buildService(mocks, showcaseRow());
      const newKey = `uploads/showcase-images/${OWNER_ID}/1700000001-xyz-new.jpg`;
      mocks.mockPrisma.userShowcase.update.mockImplementation(async (args: any) =>
        showcaseRow({ images: (args.data.images.create ?? []).map((img: any, i: number) => ({ id: `img-n${i}`, ...img })) }),
      );
      await service.updateShowcaseItem(OWNER_ID, SHOWCASE_ID, { imageFileKeys: [newKey] } as any);
      // Validasi jalan dengan consume:false …
      expect(mocks.mockUpload.verifyUserFileKeys).toHaveBeenCalledWith(
        OWNER_ID, [newKey], UploadPurpose.SHOWCASE_IMAGE, expect.objectContaining({ consume: false }),
      );
      // … dan consume terjadi SETELAH update DB.
      expect(mocks.mockUpload.consumeUploadConfirmations).toHaveBeenCalledWith(OWNER_ID, [newKey]);
      const verifyOrder = mocks.mockUpload.verifyUserFileKeys.mock.invocationCallOrder[0];
      const updateOrder = mocks.mockPrisma.userShowcase.update.mock.invocationCallOrder[0];
      const consumeOrder = mocks.mockUpload.consumeUploadConfirmations.mock.invocationCallOrder[0];
      expect(verifyOrder).toBeLessThan(updateOrder);
      expect(updateOrder).toBeLessThan(consumeOrder);
    });

    it('does NOT consume confirmations when the db update fails', async () => {
      const service = await buildService(mocks, showcaseRow());
      const newKey = `uploads/showcase-images/${OWNER_ID}/1700000001-xyz-new.jpg`;
      mocks.mockPrisma.userShowcase.update.mockRejectedValue(new Error('db down'));
      await expect(
        service.updateShowcaseItem(OWNER_ID, SHOWCASE_ID, { imageFileKeys: [newKey] } as any),
      ).rejects.toThrow('db down');
      expect(mocks.mockUpload.consumeUploadConfirmations).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------
  // SH-B-008
  // ---------------------------------------------------------------
  describe('SH-B-008 restore respects SHOWCASE_MAX_ITEMS', () => {
    it('rejects restore when the owner already has the maximum active items', async () => {
      const deleted = showcaseRow({ id: 'cshowcase000000000000099', deletedAt: new Date('2026-09-20T00:00:00.000Z') });
      const service = await buildService(mocks, showcaseRow());
      mocks.mockPrisma.userShowcase.findFirst.mockImplementation(async (args: any) =>
        matchesShowcaseWhere(deleted, args?.where) ? deleted : null,
      );
      mocks.mockPrisma.userShowcase.count.mockResolvedValue(SHOWCASE_MAX_ITEMS);
      await expect(service.restoreShowcaseItem(OWNER_ID, deleted.id)).rejects.toMatchObject({
        response: expect.objectContaining({ code: ErrorCodes.SHOWCASE_ITEM_LIMIT_REACHED }),
      });
      expect(mocks.mockPrisma.userShowcase.update).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------
  // SH-B-009
  // ---------------------------------------------------------------
  describe('SH-B-009 comment counter guarded by item status', () => {
    it('rolls back the comment when the item is deactivated mid-transaction', async () => {
      const service = await buildService(mocks, showcaseRow());
      mocks.mockPrisma.showcaseComment.create.mockResolvedValue({ id: 'cmt-1', content: 'Bagus!', user: { id: VIEWER_ID } });
      // Simulasi: item di-takedown tepat di antara visibility check dan commit.
      mocks.mockPrisma.userShowcase.updateMany.mockResolvedValue({ count: 0 });
      await expect(
        service.addComment(VIEWER_ID, SHOWCASE_ID, { content: 'Bagus!' } as any),
      ).rejects.toMatchObject({
        response: expect.objectContaining({ code: ErrorCodes.SHOWCASE_NOT_FOUND }),
      });
      const updateManyArgs = mocks.mockPrisma.userShowcase.updateMany.mock.calls[0][0];
      expect(updateManyArgs.where).toMatchObject({ id: SHOWCASE_ID, deletedAt: null, isActive: true });
    });

    it('increments normally when the item stays active', async () => {
      const service = await buildService(mocks, showcaseRow());
      mocks.mockPrisma.showcaseComment.create.mockResolvedValue({ id: 'cmt-1', content: 'Bagus!', user: { id: VIEWER_ID } });
      mocks.mockPrisma.userShowcase.updateMany.mockResolvedValue({ count: 1 });
      await service.addComment(VIEWER_ID, SHOWCASE_ID, { content: 'Bagus!' } as any);
      expect(mocks.mockPrisma.userShowcase.updateMany).toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------
  // SH-B-010
  // ---------------------------------------------------------------
  describe('SH-B-010 like counter guarded by item status', () => {
    it('rolls back the like when the item is deactivated mid-transaction', async () => {
      const service = await buildService(mocks, showcaseRow());
      mocks.mockPrisma.showcaseLike.create.mockResolvedValue({ id: 'like-1' });
      mocks.mockPrisma.userShowcase.updateMany.mockResolvedValue({ count: 0 });
      await expect(service.likeShowcase(VIEWER_ID, SHOWCASE_ID)).rejects.toMatchObject({
        response: expect.objectContaining({ code: ErrorCodes.SHOWCASE_NOT_FOUND }),
      });
      const updateManyArgs = mocks.mockPrisma.userShowcase.updateMany.mock.calls[0][0];
      expect(updateManyArgs.where).toMatchObject({ id: SHOWCASE_ID, deletedAt: null, isActive: true });
    });
  });
});

describe('Audit fixes — SH-S-001 stored-XSS via extension (UploadService)', () => {
  let service: UploadService;
  let mockLocalStorage: any;
  let mockRedis: any;

  const JPEG_MAGIC = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]);

  beforeEach(async () => {
    jest.clearAllMocks();
    mockLocalStorage = {
      saveFile: jest.fn().mockResolvedValue(undefined),
      getPublicUrl: jest.fn((key: string) => `https://cdn.test/${key}`),
      getFileSize: jest.fn().mockResolvedValue(2048),
      getContentType: jest.fn().mockResolvedValue('image/jpeg'),
      deleteFile: jest.fn().mockResolvedValue(true),
    };
    mockRedis = { setNx: jest.fn().mockResolvedValue(true), get: jest.fn(), del: jest.fn(), consumeOnce: jest.fn().mockResolvedValue(true) };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        UploadService,
        { provide: RedisService, useValue: mockRedis },
        { provide: ConfigService, useValue: { get: jest.fn(() => null) } },
        { provide: LocalStorageService, useValue: mockLocalStorage },
      ],
    }).compile();
    service = module.get<UploadService>(UploadService);
  });

  it('stores promo.html with JPEG magic bytes as .jpg (extension comes from detected MIME)', async () => {
    const payload = Buffer.concat([JPEG_MAGIC, Buffer.alloc(2048 - JPEG_MAGIC.length, 0x41)]);
    const result = await service.uploadDirect('user-1', UploadPurpose.SHOWCASE_IMAGE, 'promo.html', 'image/jpeg', payload);
    expect(result.fileKey.endsWith('.jpg')).toBe(true);
    expect(result.fileKey).not.toContain('.html');
  });

  it('still rejects when declared type mismatches detected content', async () => {
    const payload = Buffer.concat([JPEG_MAGIC, Buffer.alloc(2048 - JPEG_MAGIC.length, 0x41)]);
    await expect(
      service.uploadDirect('user-1', UploadPurpose.SHOWCASE_IMAGE, 'photo.jpg', 'image/png', payload),
    ).rejects.toMatchObject({ response: expect.objectContaining({ code: ErrorCodes.MIME_TYPE_MISMATCH }) });
  });

  it('rejects content whose type cannot be identified (fail-closed)', async () => {
    const payload = Buffer.alloc(2048, 0x7f);
    await expect(
      service.uploadDirect('user-1', UploadPurpose.SHOWCASE_IMAGE, 'blob.bin', 'image/jpeg', payload),
    ).rejects.toThrow(BadRequestException);
  });
});

describe('Audit fixes — SH-S-004 downloadOwnFile validates key shape first', () => {
  let controller: UploadController;
  let mockUploadService: any;

  beforeEach(() => {
    jest.clearAllMocks();
    mockUploadService = {
      getPrivateFileStream: jest.fn().mockResolvedValue({ stream: null, contentType: 'image/jpeg', size: 10 }),
    };
    // Instansiasi langsung: method yang diuji tidak memakai guard/DI lain
    // (@UseGuards(PhoneVerifiedGuard) di level class butuh PrismaService —
    // tidak relevan untuk unit test validasi key ini).
    controller = new UploadController(mockUploadService);
  });

  it('rejects a traversal key with controlled 400 (VALIDATION_ERROR), not a crash', async () => {
    await expect(
      controller.downloadOwnFile('user-1', '../../etc/passwd'),
    ).rejects.toMatchObject({ response: expect.objectContaining({ code: 'VALIDATION_ERROR' }) });
    expect(mockUploadService.getPrivateFileStream).not.toHaveBeenCalled();
  });

  it('rejects a key with an unexpected segment count', async () => {
    await expect(
      controller.downloadOwnFile('user-1', 'uploads/a/b/c/d/e.jpg'),
    ).rejects.toThrow(BadRequestException);
    expect(mockUploadService.getPrivateFileStream).not.toHaveBeenCalled();
  });
});
