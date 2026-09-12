import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { BadRequestException } from '@nestjs/common';
import { ShowcaseVisibility } from '@prisma/client';
import { ShowcaseService } from '../showcase.service';
import { ShowcaseFeedQueryDto } from '../dto/showcase-feed-query.dto';
import { PrismaService } from '../../../prisma/prisma.service';
import { RedisService } from '../../../redis/redis.service';
import { UploadService } from '../../upload/upload.service';
import * as ErrorCodes from '../../../common/constants/error-codes';
import { SHOWCASE_FEED_MAX_LIMIT } from '../../../common/constants/app.constants';

const OWNER_ID = 'owner-1';
const VIEWER_ID = 'viewer-1';
const ENEMY_ID = 'enemy-1';

function feedRow(index: number, overrides: Record<string, unknown> = {}) {
  return {
    id: `cshowcase${String(index).padStart(18, '0')}`,
    userId: OWNER_ID,
    title: `Item ${index}`,
    description: `Deskripsi item nomor ${index} yang cukup panjang.`,
    category: 'ilustrasi',
    visibility: ShowcaseVisibility.PUBLIC,
    priceMin: BigInt(100000 + index),
    priceMax: null,
    isActive: true,
    sortOrder: index,
    likeCount: index,
    commentCount: 0,
    viewCount: 0,
    createdAt: new Date(Date.UTC(2026, 8, 10 - index)),
    updatedAt: new Date(Date.UTC(2026, 8, 10 - index)),
    images: [{ id: `img-${index}`, imageUrl: `https://cdn.test/${index}.jpg`, sortOrder: 0 }],
    user: {
      id: OWNER_ID,
      userId: 'USR-OWNER01',
      username: 'seller',
      fullName: 'Toko Seller',
      avatarUrl: null,
      kycStatus: 'APPROVED',
      isVip: true,
      membershipRank: 'GOLD',
    },
    ...overrides,
  };
}

function rows(count: number) {
  return Array.from({ length: count }, (_, i) => feedRow(i + 1));
}

/** Cursor opaque yang dihasilkan service: base64url(JSON{v,t,l,i}). */
function encodeCursor(t: number, l: number, i: string, version = 1): string {
  return Buffer.from(JSON.stringify({ v: version, t, l, i }), 'utf8').toString('base64url');
}

function decodeCursor(cursor: string): { v: number; t: number; l: number; i: string } {
  return JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
}

const mockPrisma: any = {
  blockList: { findMany: jest.fn() },
  userShowcase: { findMany: jest.fn() },
  showcaseLike: { findMany: jest.fn() },
};
const mockRedis = { setNx: jest.fn() };
const mockUpload = { verifyUserFileKeys: jest.fn(), buildPublicUrl: jest.fn(), cleanupFileKeys: jest.fn(), uploadDirect: jest.fn() };
const mockConfig = { get: jest.fn() };

const feed = (service: ShowcaseService, viewerId: string | undefined, query: Partial<ShowcaseFeedQueryDto>) =>
  service.getFeed(viewerId, query as ShowcaseFeedQueryDto);

describe('ShowcaseService.getFeed — discover feed (cursor-based)', () => {
  let service: ShowcaseService;

  beforeEach(async () => {
    jest.clearAllMocks();
    mockPrisma.blockList.findMany.mockResolvedValue([]);
    mockPrisma.userShowcase.findMany.mockResolvedValue([]);
    mockPrisma.showcaseLike.findMany.mockResolvedValue([]);

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

  const lastQuery = () => mockPrisma.userShowcase.findMany.mock.calls.at(-1)![0];

  describe('visibility & block-list scoping', () => {
    it('only queries PUBLIC, active items from healthy public owners', async () => {
      await feed(service, undefined, {});
      const where = lastQuery().where;
      expect(where.visibility).toBe(ShowcaseVisibility.PUBLIC);
      expect(where.isActive).toBe(true);
      expect(where.user).toEqual({ isActive: true, isBanned: false, deletedAt: null, profileVisible: true });
    });

    it('never returns PRIVATE items, even with a search match', async () => {
      await feed(service, undefined, { search: 'rahasia' });
      expect(lastQuery().where.visibility).toBe(ShowcaseVisibility.PUBLIC);
    });

    it('excludes owners the viewer has blocked, in both directions', async () => {
      mockPrisma.blockList.findMany.mockResolvedValue([
        { blockerId: VIEWER_ID, blockedId: ENEMY_ID },
        { blockerId: 'enemy-2', blockedId: VIEWER_ID },
      ]);
      await feed(service, VIEWER_ID, {});
      expect(mockPrisma.blockList.findMany).toHaveBeenCalledWith({
        where: { OR: [{ blockerId: VIEWER_ID }, { blockedId: VIEWER_ID }] },
        select: { blockerId: true, blockedId: true },
      });
      expect(lastQuery().where.user.id.notIn).toEqual(expect.arrayContaining([ENEMY_ID, 'enemy-2']));
    });

    it('lets an anonymous viewer see every public item without a block lookup', async () => {
      await feed(service, undefined, {});
      expect(mockPrisma.blockList.findMany).not.toHaveBeenCalled();
      expect(lastQuery().where.user.id).toBeUndefined();
    });

    it('does not add an empty notIn clause when the viewer has no blocks', async () => {
      await feed(service, VIEWER_ID, {});
      expect(mockPrisma.blockList.findMany).toHaveBeenCalled();
      expect(lastQuery().where.user.id).toBeUndefined();
    });
  });

  describe('filters', () => {
    it('filters by an exact, normalized category', async () => {
      await feed(service, undefined, { category: '  ILUSTRASI  ' });
      const clause = lastQuery().where.AND.find((c: any) => c.category !== undefined);
      // Category disimpan lowercase, jadi filter ikut dinormalisasi.
      expect(clause).toEqual({ category: 'ilustrasi' });
    });

    it('ignores an empty category', async () => {
      await feed(service, undefined, { category: '' });
      expect(lastQuery().where.AND).toBeUndefined();
    });

    it('escapes LIKE wildcards in the search term', async () => {
      await feed(service, undefined, { search: '100%_off\\deal' });
      const search = lastQuery().where.AND.find((c: any) => c.OR !== undefined);
      // Ratakan { field: {...} } maupun { user: { field: {...} } } jadi daftar kondisi.
      const patterns = search.OR.flatMap((clause: any) => {
        const value = Object.values(clause)[0] as Record<string, unknown>;
        return 'contains' in value ? [value] : Object.values(value) as Record<string, unknown>[];
      });
      expect(patterns).toHaveLength(5);
      for (const pattern of patterns) {
        expect(pattern.contains).toBe('100\\%\\_off\\\\deal');
        expect(pattern.mode).toBe('insensitive');
      }
    });

    it('searches title, description, category and the seller identity', async () => {
      await feed(service, undefined, { search: 'komisi' });
      const search = lastQuery().where.AND.find((c: any) => c.OR !== undefined);
      expect(search.OR).toEqual([
        { title: { contains: 'komisi', mode: 'insensitive' } },
        { description: { contains: 'komisi', mode: 'insensitive' } },
        { category: { contains: 'komisi', mode: 'insensitive' } },
        { user: { username: { contains: 'komisi', mode: 'insensitive' } } },
        { user: { fullName: { contains: 'komisi', mode: 'insensitive' } } },
      ]);
    });

    it('ignores a whitespace-only search term', async () => {
      await feed(service, undefined, { search: '   ' });
      expect(lastQuery().where.AND).toBeUndefined();
    });

    it('combines category and search as separate AND clauses', async () => {
      await feed(service, undefined, { category: 'ilustrasi', search: 'komisi' });
      const and = lastQuery().where.AND;
      expect(and).toHaveLength(2);
      expect(and[0]).toEqual({ category: 'ilustrasi' });
      expect(and[1].OR).toHaveLength(5);
    });
  });

  describe('sorting', () => {
    it('sorts latest-first with an { id } tiebreak by default', async () => {
      const result = (await feed(service, undefined, {})) as any;
      expect(result.sort).toBe('latest');
      expect(lastQuery().orderBy).toEqual([{ createdAt: 'desc' }, { id: 'desc' }]);
    });

    it('sorts popular by likeCount with createdAt and id tiebreaks', async () => {
      const result = (await feed(service, undefined, { sort: 'popular' })) as any;
      expect(result.sort).toBe('popular');
      expect(lastQuery().orderBy).toEqual([{ likeCount: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }]);
    });

    it('falls back to latest for an unknown sort value', async () => {
      const result = (await feed(service, undefined, { sort: 'trending' as never })) as any;
      expect(result.sort).toBe('latest');
      expect(lastQuery().orderBy).toEqual([{ createdAt: 'desc' }, { id: 'desc' }]);
    });
  });

  describe('cursor pagination', () => {
    it('sends no keyset clause on the first page', async () => {
      await feed(service, undefined, {});
      expect(lastQuery().where.cursor).toBeUndefined();
      expect(lastQuery().where.skip).toBeUndefined();
      expect(lastQuery().where.AND).toBeUndefined();
    });

    it('never uses offset pagination', async () => {
      mockPrisma.userShowcase.findMany.mockResolvedValue(rows(3));
      await feed(service, undefined, { cursor: encodeCursor(Date.UTC(2026, 8, 1), 9, 'cshowcase000000000000009') });
      expect(lastQuery().skip).toBeUndefined();
      expect(lastQuery().cursor).toBeUndefined();
    });

    it('applies a (createdAt, id) keyset for the latest sort', async () => {
      const t = Date.UTC(2026, 8, 5, 12, 0, 0);
      await feed(service, undefined, { cursor: encodeCursor(t, 42, 'cshowcase000000000000042') });
      const keyset = lastQuery().where.AND.find((c: any) => c.OR !== undefined);
      expect(keyset.OR).toEqual([
        { createdAt: { lt: new Date(t) } },
        { createdAt: new Date(t), id: { lt: 'cshowcase000000000000042' } },
      ]);
    });

    it('applies a (likeCount, createdAt, id) keyset for the popular sort', async () => {
      const t = Date.UTC(2026, 8, 5, 12, 0, 0);
      await feed(service, undefined, { sort: 'popular', cursor: encodeCursor(t, 42, 'cshowcase000000000000042') });
      const keyset = lastQuery().where.AND.find((c: any) => c.OR !== undefined);
      expect(keyset.OR).toEqual([
        { likeCount: { lt: 42 } },
        { likeCount: 42, createdAt: { lt: new Date(t) } },
        { likeCount: 42, createdAt: new Date(t), id: { lt: 'cshowcase000000000000042' } },
      ]);
    });

    it('keeps search/category and the keyset as independent AND clauses', async () => {
      await feed(service, undefined, {
        category: 'ilustrasi',
        search: 'komisi',
        cursor: encodeCursor(Date.UTC(2026, 8, 5), 1, 'cshowcase000000000000001'),
      });
      expect(lastQuery().where.AND).toHaveLength(3);
    });

    it('rejects a malformed cursor with 400 INVALID_CURSOR', async () => {
      for (const bad of ['not-base64-json', Buffer.from('{"v":1}', 'utf8').toString('base64url'), '!!']) {
        await expect(feed(service, undefined, { cursor: bad })).rejects.toThrow(BadRequestException);
      }
      expect(mockPrisma.userShowcase.findMany).not.toHaveBeenCalled();
    });

    it('rejects a cursor from an older payload version', async () => {
      const legacy = encodeCursor(Date.UTC(2026, 8, 5), 1, 'cshowcase000000000000001', 0);
      await expect(feed(service, undefined, { cursor: legacy })).rejects.toMatchObject({
        response: { code: ErrorCodes.INVALID_CURSOR },
      });
    });

    it('rejects a cursor with a non-finite timestamp or an oversized id', async () => {
      const badTime = Buffer.from(JSON.stringify({ v: 1, t: 'yesterday', l: 1, i: 'x' }), 'utf8').toString('base64url');
      const badId = Buffer.from(JSON.stringify({ v: 1, t: 1, l: 1, i: 'x'.repeat(65) }), 'utf8').toString('base64url');
      await expect(feed(service, undefined, { cursor: badTime })).rejects.toThrow(BadRequestException);
      await expect(feed(service, undefined, { cursor: badId })).rejects.toThrow(BadRequestException);
    });
  });

  describe('paging metadata', () => {
    it('fetches limit+1 rows to decide hasMore without a COUNT query', async () => {
      await feed(service, undefined, { limit: 10 });
      expect(lastQuery().take).toBe(11);
      expect(mockPrisma.userShowcase.count).toBeUndefined();
    });

    it('reports hasMore and trims the extra probe row', async () => {
      mockPrisma.userShowcase.findMany.mockResolvedValue(rows(4));
      const result = (await feed(service, undefined, { limit: 3 })) as any;
      expect(result.items).toHaveLength(3);
      expect(result.hasMore).toBe(true);
      expect(result.limit).toBe(3);
    });

    it('emits a nextCursor built from the last returned row', async () => {
      const page = rows(3);
      mockPrisma.userShowcase.findMany.mockResolvedValue([...page, feedRow(4)]);
      const result = (await feed(service, undefined, { limit: 3 })) as any;
      const decoded = decodeCursor(result.nextCursor);
      expect(decoded).toEqual({ v: 1, t: page[2].createdAt.getTime(), l: page[2].likeCount, i: page[2].id });
    });

    it('returns nextCursor null on the last page', async () => {
      mockPrisma.userShowcase.findMany.mockResolvedValue(rows(2));
      const result = (await feed(service, undefined, { limit: 5 })) as any;
      expect(result.hasMore).toBe(false);
      expect(result.nextCursor).toBeNull();
      expect(result.items).toHaveLength(2);
    });

    it('round-trips: feeding nextCursor back resumes exactly after the last row', async () => {
      const page = rows(2);
      mockPrisma.userShowcase.findMany.mockResolvedValue([...page, feedRow(3)]);
      const first = (await feed(service, undefined, { limit: 2 })) as any;
      await feed(service, undefined, { limit: 2, cursor: first.nextCursor });
      const keyset = lastQuery().where.AND.find((c: any) => c.OR !== undefined);
      expect(keyset.OR[1]).toEqual({ createdAt: page[1].createdAt, id: { lt: page[1].id } });
    });

    it(`clamps limit into 1..${SHOWCASE_FEED_MAX_LIMIT}`, async () => {
      await feed(service, undefined, { limit: 0 });
      expect(lastQuery().take).toBe(2);
      await feed(service, undefined, { limit: 5000 });
      expect(lastQuery().take).toBe(SHOWCASE_FEED_MAX_LIMIT + 1);
      expect(((await feed(service, undefined, { limit: 5000 })) as any).limit).toBe(SHOWCASE_FEED_MAX_LIMIT);
    });

    it('defaults to 20 items per page', async () => {
      const result = (await feed(service, undefined, {})) as any;
      expect(result.limit).toBe(20);
      expect(lastQuery().take).toBe(21);
    });
  });

  describe('item payload', () => {
    it('marks liked items for the viewer in one batched query', async () => {
      const page = rows(2);
      mockPrisma.userShowcase.findMany.mockResolvedValue(page);
      mockPrisma.showcaseLike.findMany.mockResolvedValue([{ showcaseId: page[1].id }]);
      const result = (await feed(service, VIEWER_ID, {})) as any;
      expect(result.items.map((i: any) => i.isLiked)).toEqual([false, true]);
      expect(mockPrisma.showcaseLike.findMany).toHaveBeenCalledTimes(1);
      expect(mockPrisma.showcaseLike.findMany).toHaveBeenCalledWith({
        where: { userId: VIEWER_ID, showcaseId: { in: [page[0].id, page[1].id] } },
        select: { showcaseId: true },
      });
    });

    it('skips the like lookup for an anonymous viewer', async () => {
      mockPrisma.userShowcase.findMany.mockResolvedValue(rows(1));
      await feed(service, undefined, {});
      expect(mockPrisma.showcaseLike.findMany).not.toHaveBeenCalled();
    });

    it('exposes cover image, counters, author badges and OrderLink prefill per item', async () => {
      mockPrisma.userShowcase.findMany.mockResolvedValue([feedRow(1)]);
      const result = (await feed(service, undefined, {})) as any;
      const item = result.items[0];
      expect(item).toMatchObject({
        id: 'cshowcase000000000000000001',
        title: 'Item 1',
        category: 'ilustrasi',
        coverImageUrl: 'https://cdn.test/1.jpg',
        imageUrl: 'https://cdn.test/1.jpg',
        priceMin: 100001,
        priceMax: null,
        likeCount: 1,
        isLiked: false,
        isOwner: false,
      });
      expect(item.author).toMatchObject({ username: 'seller', isKycVerified: true, isVip: true });
      expect(item.orderLink).toMatchObject({ title: 'Item 1', orderValue: 100001, orderValueValid: true, counterpartUsername: 'seller' });
      expect(item.shareUrl).toContain('/showcase/');
    });

    it('never leaks the internal owner id or private visibility flags', async () => {
      mockPrisma.userShowcase.findMany.mockResolvedValue([feedRow(1)]);
      const result = (await feed(service, undefined, {})) as any;
      const item = result.items[0];
      expect(item.author.id).toBeUndefined();
      expect(item.userId).toBeUndefined();
      expect(item.visibility).toBe(ShowcaseVisibility.PUBLIC);
    });

    it('returns an empty page with hasMore false when nothing matches', async () => {
      const result = (await feed(service, undefined, { search: 'tidak-ada' })) as any;
      expect(result).toMatchObject({ items: [], hasMore: false, nextCursor: null });
    });
  });
});
