import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { UsersService } from '../users.service';
import { PrismaService } from '../../../prisma/prisma.service';
import { RedisService } from '../../../redis/redis.service';
import { AuditLogService } from '../../../common/services/audit-log.service';
import { OgMetadataService } from '../og-metadata.service';
import { VerificationBadgeService } from '../verification-badge.service';
import * as ErrorCodes from '../../../common/constants/error-codes';

jest.mock('../../../common/utils/pii.util', () => ({
  decryptPiiSafe: jest.fn(async (s: string | null) => s),
  encryptPii: jest.fn(async (s: string) => s),
  hashPhoneNumber: jest.fn(async (s: string) => `h:${s}`),
  normalizePhoneNumber: jest.fn((s: string) => s),
}));

const OWNER_ID = 'owner-1';
const VIEWER_ID = 'viewer-1';

const visibleOwner = {
  id: OWNER_ID,
  userId: 'USR-OWNER01',
  username: 'seller',
  fullName: 'Toko Seller',
  avatarUrl: 'https://cdn/avatar.jpg',
  headerUrl: 'https://cdn/header.jpg',
  accountType: 'BUSINESS',
  bio: 'Jualan aman',
  kycStatus: 'APPROVED',
  isVip: false,
  membershipRank: 'GOLD',
  totalOrdersCompleted: 42,
  averageRating: 4.75,
  totalRatingCount: 30,
  memberSince: new Date('2025-01-01T00:00:00.000Z'),
  profileVisible: true,
  showContactEmail: false,
  contactEmail: 'hello@seller.id',
  showContactPhone: false,
  contactPhone: '+6281200000000',
  isActive: true,
  isBanned: false,
  deletedAt: null,
  badges: [],
  ratingsReceived: [{ stars: 5, comment: 'ok', createdAt: new Date(), giver: { username: 'b', avatarUrl: null } }],
  links: [{ id: 'l1', platform: 'instagram', url: 'https://instagram.com/seller', label: 'IG', displayOrder: 0 }],
  _count: { followers: 3, following: 1 },
};

const mockPrisma: any = {
  user: { findUnique: jest.fn() },
  blockList: { findFirst: jest.fn(), findMany: jest.fn() },
  follow: { findUnique: jest.fn(), findMany: jest.fn() },
  userFavorite: { findUnique: jest.fn(), findMany: jest.fn(), count: jest.fn() },
};
const mockRedis = { get: jest.fn(), set: jest.fn(), del: jest.fn(), setex: jest.fn() };
const mockVerificationBadges = {
  getBadges: jest.fn().mockResolvedValue([
    {
      type: 'KYC_VERIFIED',
      labelKey: 'badge.kycVerified',
      label: 'Identitas Terverifikasi',
      shortLabel: 'KYC',
      description: 'd',
      icon: 'badge-check',
      earnedAt: new Date('2026-04-04T00:00:00.000Z'),
      priority: 1,
    },
  ]),
};

describe('UsersService.getPublicProfile (Section 2 — Profile Core)', () => {
  let service: UsersService;

  beforeEach(async () => {
    jest.clearAllMocks();
    mockPrisma.user.findUnique.mockResolvedValue(visibleOwner);
    mockPrisma.blockList.findFirst.mockResolvedValue(null);
    mockPrisma.blockList.findMany.mockResolvedValue([]);
    mockPrisma.follow.findUnique.mockResolvedValue(null);
    mockPrisma.follow.findMany.mockResolvedValue([]);
    mockPrisma.userFavorite.findUnique.mockResolvedValue(null);
    mockPrisma.userFavorite.findMany.mockResolvedValue([]);
    mockPrisma.userFavorite.count.mockResolvedValue(0);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        UsersService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: RedisService, useValue: mockRedis },
        { provide: ConfigService, useValue: { get: jest.fn() } },
        { provide: AuditLogService, useValue: { logUserAction: jest.fn() } },
        { provide: OgMetadataService, useValue: { invalidateUserOgCache: jest.fn() } },
        { provide: VerificationBadgeService, useValue: mockVerificationBadges },
      ],
    }).compile();
    service = module.get<UsersService>(UsersService);
  });

  it('returns every profile section explicitly', async () => {
    const result = (await service.getPublicProfile('seller')) as Record<string, any>;
    for (const section of ['identity', 'contact', 'links', 'social', 'favorites', 'badges', 'about', 'ratings', 'stats']) {
      expect(result).toHaveProperty(section);
    }
  });

  describe('identity', () => {
    it('exposes nickname, username, bio, avatarUrl and headerUrl', async () => {
      const { identity } = (await service.getPublicProfile('seller')) as any;
      expect(identity).toMatchObject({
        nickname: 'Toko Seller',
        username: 'seller',
        bio: 'Jualan aman',
        avatarUrl: 'https://cdn/avatar.jpg',
        headerUrl: 'https://cdn/header.jpg',
        userId: 'USR-OWNER01',
      });
    });
  });

  describe('contact privacy', () => {
    it('is null when both show-contact toggles are off even though values exist', async () => {
      const { contact } = (await service.getPublicProfile('seller')) as any;
      expect(contact).toEqual({ email: null, phone: null });
    });

    it('exposes only the channel whose toggle is on', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({ ...visibleOwner, showContactEmail: true });
      const { contact } = (await service.getPublicProfile('seller')) as any;
      expect(contact).toEqual({ email: 'hello@seller.id', phone: null });
    });

    it('is mirrored inside the about section', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({ ...visibleOwner, showContactPhone: true });
      const { about } = (await service.getPublicProfile('seller')) as any;
      expect(about.contact).toEqual({ email: null, phone: '+6281200000000' });
    });
  });

  describe('block-list enforcement', () => {
    it('rejects with 403 USER_BLOCKED when the owner blocked the viewer', async () => {
      mockPrisma.blockList.findFirst.mockResolvedValue({ id: 'b1', blockerId: OWNER_ID });
      await expect(service.getPublicProfile('seller', VIEWER_ID)).rejects.toThrow(ForbiddenException);
      await expect(service.getPublicProfile('seller', VIEWER_ID)).rejects.toMatchObject({
        response: expect.objectContaining({ code: ErrorCodes.USER_BLOCKED }),
      });
      // Tidak boleh ada satu pun query turunan yang bocor setelah ditolak.
      expect(mockPrisma.follow.findMany).not.toHaveBeenCalled();
      expect(mockPrisma.userFavorite.findMany).not.toHaveBeenCalled();
      expect(mockVerificationBadges.getBadges).not.toHaveBeenCalled();
    });

    it('rejects with 403 when the viewer blocked the owner (both directions)', async () => {
      mockPrisma.blockList.findFirst.mockResolvedValue({ id: 'b2', blockerId: VIEWER_ID });
      await expect(service.getPublicProfile('seller', VIEWER_ID)).rejects.toThrow(ForbiddenException);
      expect(mockPrisma.blockList.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            OR: [
              { blockerId: OWNER_ID, blockedId: VIEWER_ID },
              { blockerId: VIEWER_ID, blockedId: OWNER_ID },
            ],
          },
        }),
      );
    });

    it('never runs the block check for the profile owner', async () => {
      await service.getPublicProfile('seller', OWNER_ID);
      expect(mockPrisma.blockList.findFirst).not.toHaveBeenCalled();
      const { viewer } = (await service.getPublicProfile('seller', OWNER_ID)) as any;
      expect(viewer).toEqual({ isOwnProfile: true, isAuthenticated: true });
    });

    it('still serves an anonymous viewer', async () => {
      await expect(service.getPublicProfile('seller')).resolves.toBeDefined();
      expect(mockPrisma.blockList.findFirst).not.toHaveBeenCalled();
    });
  });

  describe('profile visibility', () => {
    it('returns 404 for private, inactive, banned and soft-deleted profiles', async () => {
      for (const overrides of [
        { profileVisible: false },
        { isActive: false },
        { isBanned: true },
        { deletedAt: new Date() },
      ]) {
        mockPrisma.user.findUnique.mockResolvedValue({ ...visibleOwner, ...overrides });
        await expect(service.getPublicProfile('seller')).rejects.toThrow(NotFoundException);
      }
    });
  });

  describe('social section', () => {
    it('returns counts, viewer relationship flags and previews', async () => {
      mockPrisma.follow.findUnique
        .mockResolvedValueOnce({ id: 'f1' }) // viewer -> owner
        .mockResolvedValueOnce(null); // owner -> viewer
      mockPrisma.follow.findMany
        .mockResolvedValueOnce([{ follower: { username: 'a', fullName: 'A', avatarUrl: null } }])
        .mockResolvedValueOnce([{ following: { username: 'b', fullName: 'B', avatarUrl: null } }]);

      const { social } = (await service.getPublicProfile('seller', VIEWER_ID)) as any;
      expect(social).toMatchObject({
        followersCount: 3,
        followingCount: 1,
        isFollowing: true,
        isFollowedBy: false,
      });
      expect(social.followers).toEqual([{ username: 'a', fullName: 'A', avatarUrl: null }]);
      expect(social.following).toEqual([{ username: 'b', fullName: 'B', avatarUrl: null }]);
    });

    it('excludes users the viewer blocks from every preview list', async () => {
      mockPrisma.blockList.findMany.mockResolvedValue([
        { blockerId: VIEWER_ID, blockedId: 'enemy-1' },
        { blockerId: 'enemy-2', blockedId: VIEWER_ID },
      ]);
      await service.getPublicProfile('seller', VIEWER_ID);

      for (const call of mockPrisma.follow.findMany.mock.calls) {
        const rel = call[0].where.follower ?? call[0].where.following;
        expect(rel.id).toEqual({ notIn: expect.arrayContaining(['enemy-1', 'enemy-2']) });
      }
      const favoriteCall = mockPrisma.userFavorite.findMany.mock.calls[0][0];
      expect(favoriteCall.where.favoriteUser.id).toEqual({ notIn: expect.arrayContaining(['enemy-1', 'enemy-2']) });
    });

    it('keeps a stable { id } tiebreak on every preview query', async () => {
      await service.getPublicProfile('seller');
      const orderBys = [
        ...mockPrisma.follow.findMany.mock.calls.map((c: any[]) => c[0].orderBy),
        mockPrisma.userFavorite.findMany.mock.calls[0][0].orderBy,
      ];
      for (const orderBy of orderBys) {
        expect(orderBy[orderBy.length - 1]).toEqual({ id: 'desc' });
      }
    });
  });

  describe('favorites section', () => {
    it('returns the total plus a bounded preview and the viewer flag', async () => {
      mockPrisma.userFavorite.count.mockResolvedValue(20);
      mockPrisma.userFavorite.findMany.mockResolvedValue([
        { createdAt: new Date(), favoriteUser: { userId: 'USR-X', username: 'x', fullName: 'X', avatarUrl: null } },
      ]);
      mockPrisma.userFavorite.findUnique.mockResolvedValue({ id: 'fav-1' });

      const { favorites } = (await service.getPublicProfile('seller', VIEWER_ID)) as any;
      expect(favorites.total).toBe(20);
      expect(favorites.isFavoritedByViewer).toBe(true);
      expect(favorites.items[0]).toMatchObject({ username: 'x', userId: 'USR-X' });
      expect(favorites.items[0].favoritedAt).toBeInstanceOf(Date);
      expect(mockPrisma.userFavorite.findMany.mock.calls[0][0].take).toBeLessThanOrEqual(20);
    });
  });

  describe('badges + about', () => {
    it('embeds the verification badge array from Section 1', async () => {
      const { badges } = (await service.getPublicProfile('seller')) as any;
      expect(badges).toHaveLength(1);
      expect(badges[0].type).toBe('KYC_VERIFIED');
      expect(mockVerificationBadges.getBadges).toHaveBeenCalledWith(OWNER_ID);
    });

    it('lists memberSince and the earned date of each badge', async () => {
      const { about } = (await service.getPublicProfile('seller')) as any;
      expect(about.memberSince).toEqual(new Date('2025-01-01T00:00:00.000Z'));
      expect(about.badgeEarnedDates).toEqual({ KYC_VERIFIED: '2026-04-04T00:00:00.000Z' });
    });

    it('serializes a badge without a recorded earned date as null', async () => {
      mockVerificationBadges.getBadges.mockResolvedValue([
        { type: 'TRUSTED_BY_KAHADE', labelKey: 'badge.trustedByKahade', label: 'l', shortLabel: 's', description: 'd', icon: 'i', earnedAt: null, priority: 4 },
      ]);
      const { about } = (await service.getPublicProfile('seller')) as any;
      expect(about.badgeEarnedDates).toEqual({ TRUSTED_BY_KAHADE: null });
    });
  });

  describe('ratings section (Section 5)', () => {
    it('exposes the aggregate alongside the recent list', async () => {
      const { ratings } = (await service.getPublicProfile('seller')) as any;
      expect(ratings.averageRating).toBe(4.75);
      expect(ratings.totalRatingCount).toBe(30);
      expect(ratings.recent).toHaveLength(1);
    });

    it('filters hidden ratings and orders them with an { id } tiebreak', async () => {
      await service.getPublicProfile('seller');
      const select = mockPrisma.user.findUnique.mock.calls[0][0].select;
      expect(select.ratingsReceived.where.isHidden).toBe(false);
      expect(select.ratingsReceived.orderBy).toEqual([{ createdAt: 'desc' }, { id: 'desc' }]);
    });

    it('uses the same giver visibility rule as GET /users/:username/ratings', async () => {
      // Preview dan list harus sepakat soal siapa yang boleh tampil; pemberi
      // rating yang menyembunyikan profilnya tidak muncul di keduanya.
      await service.getPublicProfile('seller');
      const select = mockPrisma.user.findUnique.mock.calls[0][0].select;
      expect(select.ratingsReceived.where.giver).toEqual({
        isActive: true, isBanned: false, deletedAt: null, profileVisible: true,
      });
    });

    it('caps the preview so the profile payload stays small', async () => {
      await service.getPublicProfile('seller');
      const select = mockPrisma.user.findUnique.mock.calls[0][0].select;
      expect(select.ratingsReceived.take).toBe(5);
    });
  });

  describe('deprecated flat aliases', () => {
    it('keeps the legacy flat fields so existing clients do not break', async () => {
      const result = (await service.getPublicProfile('seller')) as any;
      expect(result.username).toBe('seller');
      expect(result.fullName).toBe('Toko Seller');
      expect(result.isKycVerified).toBe(true);
      expect(result.isVip).toBe(false);
      expect(result.followersCount).toBe(3);
      expect(result.stats).toMatchObject({ totalOrders: 42, avgRating: 4.75, ratingCount: 30 });
      expect(result.recentRatings).toHaveLength(1);
    });

    it('lowercases the username before lookup', async () => {
      await service.getPublicProfile('SeLLer');
      expect(mockPrisma.user.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({ where: { username: 'seller' } }),
      );
    });
  });
});
