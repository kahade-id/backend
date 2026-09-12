import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { UsersService } from '../users.service';
import { PrismaService } from '../../../prisma/prisma.service';
import { RedisService } from '../../../redis/redis.service';
import { AuditLogService } from '../../../common/services/audit-log.service';
import { OgMetadataService } from '../og-metadata.service';
import { VerificationBadgeService } from '../verification-badge.service';
import { ReportFlagService } from '../../../common/services/report-flag.service';
import * as ErrorCodes from '../../../common/constants/error-codes';

jest.mock('../../../common/utils/pii.util', () => ({
  decryptPiiSafe: jest.fn(async (s: string | null) => s),
  encryptPii: jest.fn(async (s: string) => s),
  hashPhoneNumber: jest.fn(async (s: string) => `h:${s}`),
  normalizePhoneNumber: jest.fn((s: string) => s),
}));

const OWNER_ID = 'owner-1';
const VIEWER_ID = 'viewer-1';

const mockPrisma: any = {
  user: { findUnique: jest.fn() },
  blockList: { findFirst: jest.fn() },
  rating: { findMany: jest.fn(), count: jest.fn() },
};
const mockRedis = { get: jest.fn(), set: jest.fn(), del: jest.fn(), setex: jest.fn(), setNx: jest.fn(), releaseLock: jest.fn(), getPrefix: jest.fn().mockReturnValue('test:'), getClient: jest.fn() };
const mockAudit = { logUserAction: jest.fn() };
const mockConfig = { get: jest.fn() };
const mockOg = { invalidateUserOgCache: jest.fn() };
const mockVerificationBadges = { getBadges: jest.fn(), invalidate: jest.fn() };

function healthyOwner(overrides: Record<string, unknown> = {}) {
  return {
    id: OWNER_ID,
    averageRating: 4.75,
    totalRatingCount: 30,
    profileVisible: true,
    isActive: true,
    isBanned: false,
    deletedAt: null,
    ...overrides,
  };
}

describe('UsersService — daftar rating publik (Section 5)', () => {
  let service: UsersService;

  beforeEach(async () => {
    jest.clearAllMocks();
    mockPrisma.user.findUnique.mockResolvedValue(healthyOwner());
    mockPrisma.blockList.findFirst.mockResolvedValue(null);
    mockPrisma.rating.findMany.mockResolvedValue([]);
    mockPrisma.rating.count.mockResolvedValue(0);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        UsersService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: RedisService, useValue: mockRedis },
        { provide: ConfigService, useValue: mockConfig },
        { provide: AuditLogService, useValue: mockAudit },
        { provide: OgMetadataService, useValue: mockOg },
        { provide: VerificationBadgeService, useValue: mockVerificationBadges },
        // Section 6: agregasi laporan -> flag moderasi internal.
        { provide: ReportFlagService, useValue: { evaluateTarget: jest.fn(async () => ({ flaggedForReview: false, distinctReporters: 0 })) } },
      ],
    }).compile();
    service = module.get<UsersService>(UsersService);
  });

  describe('ordering', () => {
    it('orders with an { id } tiebreak so offset pages never duplicate or skip', async () => {
      await service.getUserRatings('owner', 1, 10);
      expect(mockPrisma.rating.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] }),
      );
    });

    it('matches the ordering used by the profile ratings preview', async () => {
      // Preview di getPublicProfile memakai arah yang sama; kalau berbeda,
      // "rating terbaru" di profil tidak sama dengan halaman 1 list.
      await service.getUserRatings('owner', 1, 10);
      const listOrder = mockPrisma.rating.findMany.mock.calls[0][0].orderBy;
      expect(listOrder).toEqual([{ createdAt: 'desc' }, { id: 'desc' }]);
    });

    it('computes skip from the normalized page/limit', async () => {
      await service.getUserRatings('owner', 3, 10);
      expect(mockPrisma.rating.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ skip: 20, take: 10 }),
      );
    });

    it('normalizes a non-finite page/limit instead of passing NaN to Prisma', async () => {
      const result = (await service.getUserRatings('owner', Number.NaN, Number.NaN)) as any;
      expect(result.page).toBe(1);
      expect(result.limit).toBe(100);
      expect(mockPrisma.rating.findMany).toHaveBeenCalledWith(expect.objectContaining({ skip: 0, take: 100 }));
    });

    it('clamps the limit to the shared MAX_LIMIT', async () => {
      const result = (await service.getUserRatings('owner', 1, 5000)) as any;
      expect(result.limit).toBe(100);
    });
  });

  describe('payload', () => {
    it('exposes averageRating together with totalRatingCount', async () => {
      const result = (await service.getUserRatings('owner', 1, 10)) as any;
      expect(result).toMatchObject({ averageRating: 4.75, totalRatingCount: 30, total: 0, page: 1, limit: 10 });
    });

    it('coerces a null aggregate to 0 instead of leaking null', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(healthyOwner({ averageRating: null, totalRatingCount: 0 }));
      const result = (await service.getUserRatings('owner', 1, 10)) as any;
      expect(result.averageRating).toBe(0);
      expect(result.totalRatingCount).toBe(0);
    });

    it('keeps the filtered count separate from the denormalized profile count', async () => {
      mockPrisma.rating.count.mockResolvedValue(12);
      const result = (await service.getUserRatings('owner', 1, 10, 'negative')) as any;
      expect(result.total).toBe(12);
      expect(result.totalRatingCount).toBe(30);
      expect(result.filter).toBe('negative');
    });

    it('echoes filter as null when unfiltered', async () => {
      const result = (await service.getUserRatings('owner', 1, 10)) as any;
      expect(result.filter).toBeNull();
    });

    it('projects only presenter-safe rating fields', async () => {
      await service.getUserRatings('owner', 1, 10);
      const { select } = mockPrisma.rating.findMany.mock.calls[0][0];
      expect(select).toMatchObject({ id: true, stars: true, comment: true, createdAt: true });
      expect(select.giverId).toBeUndefined();
      expect(select.orderId).toBeUndefined();
      expect(select.isHidden).toBeUndefined();
      expect(select.giver).toEqual({ select: { username: true, avatarUrl: true } });
    });

    it('counts with exactly the same predicate it lists with', async () => {
      await service.getUserRatings('owner', 1, 10, 'positive');
      const listWhere = mockPrisma.rating.findMany.mock.calls[0][0].where;
      const countWhere = mockPrisma.rating.count.mock.calls[0][0].where;
      expect(countWhere).toEqual(listWhere);
    });
  });

  describe('star filters', () => {
    it('maps positive/neutral/negative onto star ranges', async () => {
      const expected: Record<string, unknown> = {
        positive: { gte: 4 },
        neutral: { equals: 3 },
        negative: { lte: 2 },
      };
      for (const [filter, stars] of Object.entries(expected)) {
        await service.getUserRatings('owner', 1, 10, filter);
        expect(mockPrisma.rating.findMany.mock.calls.at(-1)?.[0].where.stars).toEqual(stars);
      }
    });

    it('applies no star predicate when the filter is empty', async () => {
      await service.getUserRatings('owner', 1, 10, '');
      expect(mockPrisma.rating.findMany.mock.calls[0][0].where.stars).toBeUndefined();
    });

    it('rejects an unknown filter before touching the database', async () => {
      await expect(service.getUserRatings('owner', 1, 10, 'glowing')).rejects.toMatchObject({
        response: { code: ErrorCodes.VALIDATION_ERROR },
      });
      expect(mockPrisma.rating.findMany).not.toHaveBeenCalled();
    });
  });

  describe('visibility scope', () => {
    it('lists only unhidden ratings from healthy, publicly visible givers', async () => {
      await service.getUserRatings('owner', 1, 10);
      expect(mockPrisma.rating.findMany.mock.calls[0][0].where).toMatchObject({
        receiverId: OWNER_ID,
        isHidden: false,
        giver: { isActive: true, isBanned: false, deletedAt: null, profileVisible: true },
      });
    });

    it('returns 404 for an unknown username', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(null);
      await expect(service.getUserRatings('ghost', 1, 10)).rejects.toThrow(NotFoundException);
      expect(mockPrisma.rating.findMany).not.toHaveBeenCalled();
    });

    it('looks the username up in lowercase', async () => {
      await service.getUserRatings('OwnerName', 1, 10);
      expect(mockPrisma.user.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({ where: { username: 'ownername' } }),
      );
    });

    it('returns 404 for a private profile to other viewers but not to the owner', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(healthyOwner({ profileVisible: false }));
      await expect(service.getUserRatings('owner', 1, 10, undefined, VIEWER_ID)).rejects.toMatchObject({
        response: { code: ErrorCodes.USER_NOT_FOUND },
      });
      await expect(service.getUserRatings('owner', 1, 10, undefined, undefined)).rejects.toThrow(NotFoundException);
      await expect(service.getUserRatings('owner', 1, 10, undefined, OWNER_ID)).resolves.toBeDefined();
    });

    it('returns 404 for an inactive, banned or soft-deleted owner', async () => {
      for (const overrides of [{ isActive: false }, { isBanned: true }, { deletedAt: new Date() }]) {
        mockPrisma.user.findUnique.mockResolvedValue(healthyOwner(overrides));
        await expect(service.getUserRatings('owner', 1, 10)).rejects.toThrow(NotFoundException);
      }
      expect(mockPrisma.rating.findMany).not.toHaveBeenCalled();
    });

    it('returns 404 — not 403 — across a block relationship so existence is not leaked', async () => {
      mockPrisma.blockList.findFirst.mockResolvedValue({ id: 'b1' });
      await expect(service.getUserRatings('owner', 1, 10, undefined, VIEWER_ID)).rejects.toThrow(NotFoundException);
      await expect(service.getUserRatings('owner', 1, 10, undefined, VIEWER_ID)).rejects.toMatchObject({
        response: { code: ErrorCodes.USER_NOT_FOUND },
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
      expect(mockPrisma.rating.findMany).not.toHaveBeenCalled();
    });

    it('skips the block check for anonymous viewers and for the owner', async () => {
      await service.getUserRatings('owner', 1, 10, undefined, undefined);
      await service.getUserRatings('owner', 1, 10, undefined, OWNER_ID);
      expect(mockPrisma.blockList.findFirst).not.toHaveBeenCalled();
    });

    it('never throws a bare ForbiddenException from this endpoint', async () => {
      mockPrisma.blockList.findFirst.mockResolvedValue({ id: 'b1' });
      await expect(service.getUserRatings('owner', 1, 10, undefined, VIEWER_ID)).rejects.not.toBeInstanceOf(
        ForbiddenException,
      );
    });
  });
});
