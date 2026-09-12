import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { ContentHiddenReason, ShowcaseVisibility } from '@prisma/client';
import { ShowcaseService } from '../showcase.service';
import { PrismaService } from '../../../prisma/prisma.service';
import { RedisService } from '../../../redis/redis.service';
import { UploadService } from '../../upload/upload.service';
import * as ErrorCodes from '../../../common/constants/error-codes';
import { SHOWCASE_COMMENT_MAX_LENGTH } from '../../../common/constants/app.constants';

const OWNER_ID = 'owner-1';
const VIEWER_ID = 'viewer-1';
const ENEMY_ID = 'enemy-1';
const SHOWCASE_ID = 'cshowcase000000000000001';
const COMMENT_ID = 'ccomment0000000000000001';
const REPLY_ID = 'ccomment0000000000000002';

function showcaseRow(overrides: Record<string, unknown> = {}) {
  return {
    id: SHOWCASE_ID,
    userId: OWNER_ID,
    title: 'Ilustrasi karakter',
    description: 'Deskripsi yang cukup panjang untuk OrderLink.',
    category: 'ilustrasi',
    visibility: ShowcaseVisibility.PUBLIC,
    priceMin: 150000n,
    priceMax: null,
    isActive: true,
    sortOrder: 0,
    likeCount: 4,
    commentCount: 2,
    viewCount: 10,
    createdAt: new Date('2026-09-01T00:00:00.000Z'),
    updatedAt: new Date('2026-09-01T00:00:00.000Z'),
    images: [],
    user: {
      id: OWNER_ID,
      userId: 'USR-OWNER01',
      username: 'seller',
      fullName: 'Toko Seller',
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

function commentRow(overrides: Record<string, unknown> = {}) {
  return {
    id: COMMENT_ID,
    showcaseId: SHOWCASE_ID,
    userId: VIEWER_ID,
    parentId: null,
    content: 'Berapa harga untuk dua karakter?',
    isHidden: false,
    hiddenReason: null,
    hiddenAt: null,
    hiddenBy: null,
    createdAt: new Date('2026-09-02T00:00:00.000Z'),
    updatedAt: new Date('2026-09-02T00:00:00.000Z'),
    user: { userId: 'USR-VIEWER01', username: 'viewer', fullName: 'Viewer', avatarUrl: null },
    ...overrides,
  };
}

function ownerHealthy(row: any): boolean {
  const u = row.user;
  return u.isActive !== false && u.isBanned !== true && u.deletedAt == null && u.profileVisible !== false;
}

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
  blockList: { findFirst: jest.fn(), findMany: jest.fn() },
  userShowcase: {
    findFirst: jest.fn(),
    findUnique: jest.fn(),
    update: jest.fn(),
    updateMany: jest.fn(),
  },
  showcaseLike: { findMany: jest.fn(), create: jest.fn(), deleteMany: jest.fn() },
  showcaseComment: {
    findMany: jest.fn(),
    findFirst: jest.fn(),
    findUnique: jest.fn(),
    count: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
  },
  $transaction: jest.fn(),
};

const mockRedis = { setNx: jest.fn() };
const mockUpload = { verifyUserFileKeys: jest.fn(), buildPublicUrl: jest.fn(), cleanupFileKeys: jest.fn(), uploadDirect: jest.fn() };
const mockConfig = { get: jest.fn() };

/** Error Prisma P2002 (unique constraint) — dipakai untuk menguji like ganda. */
function uniqueViolation() {
  return Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });
}

describe('ShowcaseService — like & komentar', () => {
  let service: ShowcaseService;
  let dbShowcase: any;

  beforeEach(async () => {
    jest.clearAllMocks();
    dbShowcase = showcaseRow();
    mockPrisma.$transaction.mockImplementation(async (arg: unknown) =>
      typeof arg === 'function' ? (arg as (tx: unknown) => Promise<unknown>)(mockPrisma) : Promise.all(arg as never[]),
    );
    mockPrisma.userShowcase.findFirst.mockImplementation(async (args: any) =>
      matchesShowcaseWhere(dbShowcase, args?.where) ? dbShowcase : null,
    );
    mockPrisma.userShowcase.findUnique.mockImplementation(async (args: any) =>
      dbShowcase && args?.where?.id === dbShowcase.id ? { id: dbShowcase.id, likeCount: dbShowcase.likeCount, userId: dbShowcase.userId } : null,
    );
    mockPrisma.userShowcase.update.mockResolvedValue({ likeCount: 5 });
    mockPrisma.userShowcase.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.blockList.findFirst.mockResolvedValue(null);
    mockPrisma.blockList.findMany.mockResolvedValue([]);
    mockPrisma.showcaseLike.findMany.mockResolvedValue([]);
    mockPrisma.showcaseLike.create.mockResolvedValue({ id: 'like-1' });
    mockPrisma.showcaseLike.deleteMany.mockResolvedValue({ count: 1 });
    mockPrisma.showcaseComment.findMany.mockResolvedValue([]);
    mockPrisma.showcaseComment.findFirst.mockResolvedValue(null);
    mockPrisma.showcaseComment.findUnique.mockResolvedValue(null);
    mockPrisma.showcaseComment.count.mockResolvedValue(0);
    mockPrisma.showcaseComment.create.mockImplementation(async (args: any) => commentRow(args.data));
    mockPrisma.showcaseComment.update.mockImplementation(async (args: any) => commentRow(args.data));
    mockPrisma.showcaseComment.delete.mockResolvedValue({ id: COMMENT_ID });

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
  // Like
  // ------------------------------------------------------------------
  describe('likeShowcase', () => {
    it('creates the like and bumps likeCount inside one transaction', async () => {
      const result = await service.likeShowcase(VIEWER_ID, SHOWCASE_ID);
      expect(result).toEqual({ liked: true, likeCount: 5 });
      expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1);
      expect(mockPrisma.showcaseLike.create).toHaveBeenCalledWith({ data: { userId: VIEWER_ID, showcaseId: SHOWCASE_ID } });
      expect(mockPrisma.userShowcase.update).toHaveBeenCalledWith({
        where: { id: SHOWCASE_ID },
        data: { likeCount: { increment: 1 } },
        select: { likeCount: true },
      });
    });

    it('returns 404 for a PRIVATE item liked by someone else', async () => {
      dbShowcase = showcaseRow({ visibility: ShowcaseVisibility.PRIVATE });
      await expect(service.likeShowcase(VIEWER_ID, SHOWCASE_ID)).rejects.toMatchObject({
        response: { code: ErrorCodes.SHOWCASE_NOT_FOUND },
      });
      expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    });

    it('returns 404 when the owner is banned or deleted', async () => {
      for (const overrides of [{ isActive: false }, { isBanned: true }, { deletedAt: new Date() }, { profileVisible: false }]) {
        dbShowcase = showcaseRow({ user: { ...showcaseRow().user, ...overrides } });
        await expect(service.likeShowcase(VIEWER_ID, SHOWCASE_ID)).rejects.toThrow(NotFoundException);
      }
      expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    });

    it('rejects interaction across a block relationship with 403 USER_BLOCKED', async () => {
      mockPrisma.blockList.findFirst.mockResolvedValue({ id: 'b1' });
      await expect(service.likeShowcase(VIEWER_ID, SHOWCASE_ID)).rejects.toThrow(ForbiddenException);
      await expect(service.likeShowcase(VIEWER_ID, SHOWCASE_ID)).rejects.toMatchObject({
        response: { code: ErrorCodes.USER_BLOCKED },
      });
      expect(mockPrisma.blockList.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            OR: [
              { blockerId: VIEWER_ID, blockedId: OWNER_ID },
              { blockerId: OWNER_ID, blockedId: VIEWER_ID },
            ],
          },
        }),
      );
      expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    });

    it('maps a unique-constraint race to 409 SHOWCASE_ALREADY_LIKED with the live count', async () => {
      mockPrisma.showcaseLike.create.mockRejectedValue(uniqueViolation());
      await expect(service.likeShowcase(VIEWER_ID, SHOWCASE_ID)).rejects.toMatchObject({
        response: { code: ErrorCodes.SHOWCASE_ALREADY_LIKED, likeCount: 4 },
      });
    });

    it('rethrows a non-unique database error untouched', async () => {
      const boom = new Error('db down');
      mockPrisma.showcaseLike.create.mockRejectedValue(boom);
      await expect(service.likeShowcase(VIEWER_ID, SHOWCASE_ID)).rejects.toBe(boom);
    });

    it('lets the owner like their own item without a block check', async () => {
      await service.likeShowcase(OWNER_ID, SHOWCASE_ID);
      expect(mockPrisma.blockList.findFirst).not.toHaveBeenCalled();
      expect(mockPrisma.showcaseLike.create).toHaveBeenCalled();
    });
  });

  describe('unlikeShowcase', () => {
    it('deletes the like and decrements with a non-negative guard', async () => {
      const result = await service.unlikeShowcase(VIEWER_ID, SHOWCASE_ID);
      expect(mockPrisma.showcaseLike.deleteMany).toHaveBeenCalledWith({ where: { userId: VIEWER_ID, showcaseId: SHOWCASE_ID } });
      expect(mockPrisma.userShowcase.updateMany).toHaveBeenCalledWith({
        where: { id: SHOWCASE_ID, likeCount: { gt: 0 } },
        data: { likeCount: { decrement: 1 } },
      });
      expect(result).toEqual({ liked: false, likeCount: 4 });
    });

    it('returns 404 SHOWCASE_NOT_LIKED when there is nothing to remove', async () => {
      mockPrisma.showcaseLike.deleteMany.mockResolvedValue({ count: 0 });
      await expect(service.unlikeShowcase(VIEWER_ID, SHOWCASE_ID)).rejects.toMatchObject({
        response: { code: ErrorCodes.SHOWCASE_NOT_LIKED },
      });
      // Transaksi harus rollback: counter tidak boleh ikut berkurang.
      expect(mockPrisma.userShowcase.updateMany).not.toHaveBeenCalled();
    });

    it('returns 404 for an invisible item', async () => {
      dbShowcase = showcaseRow({ visibility: ShowcaseVisibility.PRIVATE });
      await expect(service.unlikeShowcase(VIEWER_ID, SHOWCASE_ID)).rejects.toThrow(NotFoundException);
      expect(mockPrisma.showcaseLike.deleteMany).not.toHaveBeenCalled();
    });
  });

  // ------------------------------------------------------------------
  // Komentar
  // ------------------------------------------------------------------
  describe('addComment', () => {
    it('creates a root comment and bumps commentCount in one transaction', async () => {
      const result = (await service.addComment(VIEWER_ID, SHOWCASE_ID, { content: '  Masih tersedia?  ' })) as any;
      expect(result.content).toBe('Masih tersedia?');
      expect(result.parentId).toBeNull();
      expect(mockPrisma.showcaseComment.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ showcaseId: SHOWCASE_ID, userId: VIEWER_ID, parentId: null, content: 'Masih tersedia?' }) }),
      );
      expect(mockPrisma.userShowcase.update).toHaveBeenCalledWith({
        where: { id: SHOWCASE_ID },
        data: { commentCount: { increment: 1 } },
      });
    });

    it('rejects an empty or whitespace-only comment', async () => {
      await expect(service.addComment(VIEWER_ID, SHOWCASE_ID, { content: '   ' })).rejects.toThrow(BadRequestException);
      expect(mockPrisma.showcaseComment.create).not.toHaveBeenCalled();
    });

    it(`rejects a comment longer than ${SHOWCASE_COMMENT_MAX_LENGTH} characters`, async () => {
      await expect(
        service.addComment(VIEWER_ID, SHOWCASE_ID, { content: 'a'.repeat(SHOWCASE_COMMENT_MAX_LENGTH + 1) }),
      ).rejects.toMatchObject({ response: { code: ErrorCodes.VALIDATION_ERROR } });
    });

    it('returns 404 for an invisible item and never writes', async () => {
      dbShowcase = showcaseRow({ visibility: ShowcaseVisibility.PRIVATE });
      await expect(service.addComment(VIEWER_ID, SHOWCASE_ID, { content: 'halo' })).rejects.toThrow(NotFoundException);
      expect(mockPrisma.showcaseComment.create).not.toHaveBeenCalled();
    });

    it('rejects commenting across a block relationship', async () => {
      mockPrisma.blockList.findFirst.mockResolvedValue({ id: 'b1' });
      await expect(service.addComment(VIEWER_ID, SHOWCASE_ID, { content: 'halo' })).rejects.toMatchObject({
        response: { code: ErrorCodes.USER_BLOCKED },
      });
      expect(mockPrisma.showcaseComment.create).not.toHaveBeenCalled();
    });

    it('attaches a reply to a root comment', async () => {
      mockPrisma.showcaseComment.findFirst.mockResolvedValue({ id: COMMENT_ID, parentId: null, isHidden: false });
      await service.addComment(VIEWER_ID, SHOWCASE_ID, { content: 'balasan', parentId: COMMENT_ID });
      expect(mockPrisma.showcaseComment.findFirst).toHaveBeenCalledWith({
        where: { id: COMMENT_ID, showcaseId: SHOWCASE_ID },
        select: { id: true, parentId: true, isHidden: true },
      });
      expect(mockPrisma.showcaseComment.create.mock.calls[0][0].data.parentId).toBe(COMMENT_ID);
    });

    it('returns 404 when the parent comment belongs to another showcase', async () => {
      mockPrisma.showcaseComment.findFirst.mockResolvedValue(null);
      await expect(
        service.addComment(VIEWER_ID, SHOWCASE_ID, { content: 'balasan', parentId: REPLY_ID }),
      ).rejects.toMatchObject({ response: { code: ErrorCodes.SHOWCASE_COMMENT_NOT_FOUND } });
    });

    it('refuses to nest a reply deeper than one level', async () => {
      mockPrisma.showcaseComment.findFirst.mockResolvedValue({ id: REPLY_ID, parentId: COMMENT_ID, isHidden: false });
      await expect(
        service.addComment(VIEWER_ID, SHOWCASE_ID, { content: 'balasan berantai', parentId: REPLY_ID }),
      ).rejects.toMatchObject({ response: { code: ErrorCodes.SHOWCASE_COMMENT_DEPTH_EXCEEDED } });
      expect(mockPrisma.showcaseComment.create).not.toHaveBeenCalled();
    });

    it('refuses to reply to a hidden comment', async () => {
      mockPrisma.showcaseComment.findFirst.mockResolvedValue({ id: COMMENT_ID, parentId: null, isHidden: true });
      await expect(
        service.addComment(VIEWER_ID, SHOWCASE_ID, { content: 'balasan', parentId: COMMENT_ID }),
      ).rejects.toMatchObject({ response: { code: ErrorCodes.SHOWCASE_COMMENT_HIDDEN } });
    });
  });

  describe('listComments', () => {
    it('nests replies under their root comment with a single extra query', async () => {
      const root = commentRow();
      const reply = commentRow({ id: REPLY_ID, parentId: COMMENT_ID, userId: OWNER_ID, content: 'Masih, silakan DM.' });
      mockPrisma.showcaseComment.findMany
        .mockResolvedValueOnce([root])
        .mockResolvedValueOnce([reply]);
      mockPrisma.showcaseComment.count.mockResolvedValue(1);

      const result = (await service.listComments(SHOWCASE_ID, VIEWER_ID, 1, 20)) as any;
      expect(result.data).toHaveLength(1);
      expect(result.data[0].replies).toHaveLength(1);
      expect(result.data[0].replies[0]).toMatchObject({ id: REPLY_ID, content: 'Masih, silakan DM.' });
      expect(mockPrisma.showcaseComment.findMany).toHaveBeenCalledTimes(2);
      expect(mockPrisma.showcaseComment.findMany.mock.calls[1][0].where.parentId).toEqual({ in: [COMMENT_ID] });
    });

    it('hides moderated comments from everyone except the showcase owner', async () => {
      await service.listComments(SHOWCASE_ID, VIEWER_ID, 1, 20);
      expect(mockPrisma.showcaseComment.findMany.mock.calls[0][0].where.isHidden).toBe(false);

      mockPrisma.showcaseComment.findMany.mockClear();
      mockPrisma.showcaseComment.count.mockClear();
      await service.listComments(SHOWCASE_ID, OWNER_ID, 1, 20);
      expect(mockPrisma.showcaseComment.findMany.mock.calls[0][0].where.isHidden).toBeUndefined();
    });

    it('excludes comment authors the viewer has blocked, in both directions', async () => {
      mockPrisma.blockList.findMany.mockResolvedValue([
        { blockerId: VIEWER_ID, blockedId: ENEMY_ID },
        { blockerId: 'enemy-2', blockedId: VIEWER_ID },
      ]);
      await service.listComments(SHOWCASE_ID, VIEWER_ID, 1, 20);
      const authorFilter = mockPrisma.showcaseComment.findMany.mock.calls[0][0].where.user;
      expect(authorFilter.id.notIn).toEqual(expect.arrayContaining([ENEMY_ID, 'enemy-2']));
      expect(authorFilter).toMatchObject({ isActive: true, isBanned: false, deletedAt: null });
    });

    it('paginates roots with a stable { id } tiebreak and reports paging metadata', async () => {
      mockPrisma.showcaseComment.count.mockResolvedValue(45);
      const result = (await service.listComments(SHOWCASE_ID, VIEWER_ID, 2, 20)) as any;
      expect(mockPrisma.showcaseComment.findMany.mock.calls[0][0]).toMatchObject({
        skip: 20,
        take: 20,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      });
      expect(result).toMatchObject({ total: 45, page: 2, limit: 20, totalPages: 3, hasNext: true, hasPrev: true });
    });

    it('clamps page and limit into a safe range', async () => {
      await service.listComments(SHOWCASE_ID, VIEWER_ID, -5, 9999);
      expect(mockPrisma.showcaseComment.findMany.mock.calls[0][0]).toMatchObject({ skip: 0, take: 50 });
    });

    it('orders replies oldest-first so a thread reads chronologically', async () => {
      mockPrisma.showcaseComment.findMany.mockResolvedValueOnce([commentRow()]).mockResolvedValueOnce([]);
      await service.listComments(SHOWCASE_ID, VIEWER_ID, 1, 20);
      expect(mockPrisma.showcaseComment.findMany.mock.calls[1][0].orderBy).toEqual([{ createdAt: 'asc' }, { id: 'asc' }]);
    });

    it('skips the replies query when the page has no roots', async () => {
      mockPrisma.showcaseComment.findMany.mockResolvedValueOnce([]);
      await service.listComments(SHOWCASE_ID, VIEWER_ID, 1, 20);
      expect(mockPrisma.showcaseComment.findMany).toHaveBeenCalledTimes(1);
    });

    it('returns 404 for an invisible item', async () => {
      dbShowcase = showcaseRow({ visibility: ShowcaseVisibility.PRIVATE });
      await expect(service.listComments(SHOWCASE_ID, VIEWER_ID, 1, 20)).rejects.toThrow(NotFoundException);
      expect(mockPrisma.showcaseComment.findMany).not.toHaveBeenCalled();
    });

    it('serializes the hidden reason only for hidden comments', async () => {
      mockPrisma.showcaseComment.findMany.mockResolvedValueOnce([
        commentRow({ isHidden: true, hiddenReason: ContentHiddenReason.SPAM }),
      ]);
      const result = (await service.listComments(SHOWCASE_ID, OWNER_ID, 1, 20)) as any;
      expect(result.data[0]).toMatchObject({ isHidden: true, hiddenReason: ContentHiddenReason.SPAM });

      mockPrisma.showcaseComment.findMany.mockResolvedValueOnce([
        commentRow({ isHidden: false, hiddenReason: null }),
      ]);
      const visible = (await service.listComments(SHOWCASE_ID, OWNER_ID, 1, 20)) as any;
      expect(visible.data[0]).toMatchObject({ isHidden: false, hiddenReason: null });
    });
  });

  describe('updateComment', () => {
    it('lets the author edit their own comment', async () => {
      mockPrisma.showcaseComment.findUnique.mockResolvedValue({ id: COMMENT_ID, userId: VIEWER_ID, isHidden: false });
      const result = (await service.updateComment(VIEWER_ID, COMMENT_ID, { content: '  sudah diedit  ' })) as any;
      expect(result.content).toBe('sudah diedit');
      expect(mockPrisma.showcaseComment.update).toHaveBeenCalledWith({
        where: { id: COMMENT_ID },
        data: { content: 'sudah diedit' },
        include: expect.anything(),
      });
    });

    it('returns 404 for an unknown comment', async () => {
      mockPrisma.showcaseComment.findUnique.mockResolvedValue(null);
      await expect(service.updateComment(VIEWER_ID, COMMENT_ID, { content: 'x' })).rejects.toMatchObject({
        response: { code: ErrorCodes.SHOWCASE_COMMENT_NOT_FOUND },
      });
    });

    it('rejects editing somebody else\'s comment', async () => {
      mockPrisma.showcaseComment.findUnique.mockResolvedValue({ id: COMMENT_ID, userId: OWNER_ID, isHidden: false });
      await expect(service.updateComment(VIEWER_ID, COMMENT_ID, { content: 'x' })).rejects.toMatchObject({
        response: { code: ErrorCodes.FORBIDDEN },
      });
      expect(mockPrisma.showcaseComment.update).not.toHaveBeenCalled();
    });

    it('rejects editing a comment that has been hidden', async () => {
      mockPrisma.showcaseComment.findUnique.mockResolvedValue({ id: COMMENT_ID, userId: VIEWER_ID, isHidden: true });
      await expect(service.updateComment(VIEWER_ID, COMMENT_ID, { content: 'x' })).rejects.toMatchObject({
        response: { code: ErrorCodes.SHOWCASE_COMMENT_HIDDEN },
      });
    });

    it('rejects empty content', async () => {
      await expect(service.updateComment(VIEWER_ID, COMMENT_ID, { content: '  ' })).rejects.toThrow(BadRequestException);
      expect(mockPrisma.showcaseComment.findUnique).not.toHaveBeenCalled();
    });
  });

  describe('deleteComment', () => {
    it('lets the author delete their own reply without touching siblings', async () => {
      mockPrisma.showcaseComment.findUnique.mockResolvedValue({
        id: REPLY_ID, userId: VIEWER_ID, showcaseId: SHOWCASE_ID, parentId: COMMENT_ID, isHidden: false,
      });
      await expect(service.deleteComment(VIEWER_ID, REPLY_ID)).resolves.toEqual({ message: 'Comment deleted successfully' });
      expect(mockPrisma.showcaseComment.delete).toHaveBeenCalledWith({ where: { id: REPLY_ID } });
      expect(mockPrisma.userShowcase.updateMany).toHaveBeenCalledWith({
        where: { id: SHOWCASE_ID, commentCount: { gte: 1 } },
        data: { commentCount: { decrement: 1 } },
      });
    });

    it('lets the showcase owner delete a comment made by someone else', async () => {
      mockPrisma.showcaseComment.findUnique.mockResolvedValue({
        id: COMMENT_ID, userId: VIEWER_ID, showcaseId: SHOWCASE_ID, parentId: null, isHidden: false,
      });
      await expect(service.deleteComment(OWNER_ID, COMMENT_ID)).resolves.toBeDefined();
      expect(mockPrisma.showcaseComment.delete).toHaveBeenCalled();
    });

    it('rejects a stranger deleting somebody else\'s comment', async () => {
      mockPrisma.showcaseComment.findUnique.mockResolvedValue({
        id: COMMENT_ID, userId: VIEWER_ID, showcaseId: SHOWCASE_ID, parentId: null, isHidden: false,
      });
      dbShowcase = showcaseRow({ userId: 'someone-else' });
      await expect(service.deleteComment(ENEMY_ID, COMMENT_ID)).rejects.toMatchObject({
        response: { code: ErrorCodes.FORBIDDEN },
      });
      expect(mockPrisma.showcaseComment.delete).not.toHaveBeenCalled();
    });

    it('subtracts cascaded replies from commentCount when a root is deleted', async () => {
      mockPrisma.showcaseComment.findUnique.mockResolvedValue({
        id: COMMENT_ID, userId: VIEWER_ID, showcaseId: SHOWCASE_ID, parentId: null, isHidden: false,
      });
      mockPrisma.showcaseComment.count.mockResolvedValue(3);
      await service.deleteComment(VIEWER_ID, COMMENT_ID);
      expect(mockPrisma.showcaseComment.count).toHaveBeenCalledWith({ where: { parentId: COMMENT_ID, isHidden: false } });
      expect(mockPrisma.userShowcase.updateMany).toHaveBeenCalledWith({
        where: { id: SHOWCASE_ID, commentCount: { gte: 4 } },
        data: { commentCount: { decrement: 4 } },
      });
    });

    it('does not decrement for a reply that was already hidden', async () => {
      mockPrisma.showcaseComment.findUnique.mockResolvedValue({
        id: REPLY_ID, userId: VIEWER_ID, showcaseId: SHOWCASE_ID, parentId: COMMENT_ID, isHidden: true,
      });
      await service.deleteComment(VIEWER_ID, REPLY_ID);
      expect(mockPrisma.showcaseComment.delete).toHaveBeenCalled();
      expect(mockPrisma.userShowcase.updateMany).not.toHaveBeenCalled();
    });

    it('returns 404 for an unknown comment', async () => {
      mockPrisma.showcaseComment.findUnique.mockResolvedValue(null);
      await expect(service.deleteComment(VIEWER_ID, COMMENT_ID)).rejects.toThrow(NotFoundException);
    });
  });

  describe('setCommentHidden', () => {
    beforeEach(() => {
      mockPrisma.showcaseComment.findUnique.mockResolvedValue({ id: COMMENT_ID, showcaseId: SHOWCASE_ID, isHidden: false });
    });

    it('hides a comment with a reason and decrements the visible counter', async () => {
      await service.setCommentHidden(OWNER_ID, COMMENT_ID, true, ContentHiddenReason.SPAM);
      // Baris hasil update ikut memuat relasi author (COMMENT_INCLUDE) supaya
      // tidak perlu query kedua setelah commit.
      expect(mockPrisma.showcaseComment.update).toHaveBeenCalledWith({
        where: { id: COMMENT_ID },
        data: {
          isHidden: true,
          hiddenReason: ContentHiddenReason.SPAM,
          hiddenAt: expect.any(Date),
          hiddenBy: OWNER_ID,
        },
        include: expect.objectContaining({ user: expect.anything() }),
      });
      expect(mockPrisma.userShowcase.updateMany).toHaveBeenCalledWith({
        where: { id: SHOWCASE_ID, commentCount: { gt: 0 } },
        data: { commentCount: { decrement: 1 } },
      });
    });

    it('unhides a comment, clears the moderation fields and increments the counter', async () => {
      mockPrisma.showcaseComment.findUnique.mockResolvedValue({ id: COMMENT_ID, showcaseId: SHOWCASE_ID, isHidden: true });
      await service.setCommentHidden(OWNER_ID, COMMENT_ID, false);
      expect(mockPrisma.showcaseComment.update).toHaveBeenCalledWith({
        where: { id: COMMENT_ID },
        data: { isHidden: false, hiddenReason: null, hiddenAt: null, hiddenBy: null },
        include: expect.objectContaining({ user: expect.anything() }),
      });
      expect(mockPrisma.userShowcase.update).toHaveBeenCalledWith({
        where: { id: SHOWCASE_ID },
        data: { commentCount: { increment: 1 } },
      });
    });

    it('requires a reason when hiding', async () => {
      await expect(service.setCommentHidden(OWNER_ID, COMMENT_ID, true)).rejects.toMatchObject({
        response: { code: ErrorCodes.VALIDATION_ERROR },
      });
      expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    });

    it('only lets the showcase owner moderate', async () => {
      await expect(service.setCommentHidden(VIEWER_ID, COMMENT_ID, true, ContentHiddenReason.SPAM)).rejects.toMatchObject({
        response: { code: ErrorCodes.FORBIDDEN },
      });
      expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    });

    it('rejects a no-op transition with 409', async () => {
      await expect(service.setCommentHidden(OWNER_ID, COMMENT_ID, false)).rejects.toThrow(ConflictException);
      mockPrisma.showcaseComment.findUnique.mockResolvedValue({ id: COMMENT_ID, showcaseId: SHOWCASE_ID, isHidden: true });
      await expect(service.setCommentHidden(OWNER_ID, COMMENT_ID, true, ContentHiddenReason.OTHER)).rejects.toThrow(ConflictException);
    });

    it('returns 404 for an unknown comment', async () => {
      mockPrisma.showcaseComment.findUnique.mockResolvedValue(null);
      await expect(service.setCommentHidden(OWNER_ID, COMMENT_ID, true, ContentHiddenReason.SPAM)).rejects.toThrow(NotFoundException);
    });

    it('serializes the moderation result from the transaction without a second read', async () => {
      mockPrisma.showcaseComment.update.mockResolvedValue(
        commentRow({ isHidden: true, hiddenReason: ContentHiddenReason.HARASSMENT }),
      );
      const result = (await service.setCommentHidden(OWNER_ID, COMMENT_ID, true, ContentHiddenReason.HARASSMENT)) as any;
      expect(result).toMatchObject({ isHidden: true, hiddenReason: ContentHiddenReason.HARASSMENT });
      // findUnique hanya dipakai untuk gate awal (1x), bukan untuk membaca ulang hasil.
      expect(mockPrisma.showcaseComment.findUnique).toHaveBeenCalledTimes(1);
    });
  });
});
