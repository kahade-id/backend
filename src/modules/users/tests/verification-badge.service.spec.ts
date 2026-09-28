import { Test, TestingModule } from '@nestjs/testing';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { BusinessVerificationStatus, KycStatus, UserAccountType } from '@prisma/client';
import {
  VerificationBadgeService,
  VERIFICATION_BADGE_CACHE_TTL_SECONDS,
  VERIFICATION_BADGE_TYPES,
  type BadgeSourceUser,
} from '../verification-badge.service';
import { PrismaService } from '../../../prisma/prisma.service';
import { RedisService } from '../../../redis/redis.service';
import { PROFILE_VERIFICATION_BADGES } from '../../../common/constants/redis-keys';

const NOW = new Date('2026-09-12T00:00:00.000Z');

function baseUser(overrides: Partial<BadgeSourceUser> = {}): BadgeSourceUser {
  return {
    id: 'user-1',
    accountType: UserAccountType.PERSONAL,
    emailVerified: false,
    emailVerifiedAt: null,
    phoneVerified: false,
    phoneVerifiedAt: null,
    kycStatus: KycStatus.UNVERIFIED,
    kycApprovedAt: null,
    isKahadePlus: false,
    subscriptionExpiresAt: null,
    kahadePlusSince: null,
    isVip: false,
    vipGrantedAt: null,
    address: null,
    grayVerifiedRevokedAt: null,
    memberSince: new Date('2025-01-01T00:00:00.000Z'),
    deletedAt: null,
    ...overrides,
  };
}

const mockPrisma: any = {
  user: { findFirst: jest.fn(), findMany: jest.fn(), findUnique: jest.fn() },
  businessVerification: { findFirst: jest.fn(), findMany: jest.fn() },
  blockList: { findFirst: jest.fn() },
};

const mockRedis = {
  get: jest.fn(),
  setex: jest.fn().mockResolvedValue(undefined),
  del: jest.fn().mockResolvedValue(undefined),
};

describe('VerificationBadgeService', () => {
  let service: VerificationBadgeService;

  beforeEach(async () => {
    jest.resetAllMocks();
    mockRedis.get.mockResolvedValue(null);
    mockRedis.setex.mockResolvedValue(undefined);
    mockRedis.del.mockResolvedValue(undefined);
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        VerificationBadgeService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: RedisService, useValue: mockRedis },
      ],
    }).compile();
    service = module.get<VerificationBadgeService>(VerificationBadgeService);
  });

  it('should be defined', () => expect(service).toBeDefined());

  describe('computeBadges — 6 kategori independen', () => {
    it('returns an empty array for a bare account', () => {
      expect(service.computeBadges(baseUser(), null, NOW)).toEqual([]);
    });

    it('CONTACT_VERIFIED requires BOTH email and phone verified', () => {
      expect(service.computeBadges(baseUser({ emailVerified: true }), null, NOW)).toEqual([]);
      expect(service.computeBadges(baseUser({ phoneVerified: true }), null, NOW)).toEqual([]);

      const badges = service.computeBadges(
        baseUser({
          emailVerified: true,
          emailVerifiedAt: new Date('2026-01-01T00:00:00.000Z'),
          phoneVerified: true,
          phoneVerifiedAt: new Date('2026-03-01T00:00:00.000Z'),
        }),
        null,
        NOW,
      );
      expect(badges.map((b) => b.type)).toEqual(['CONTACT_VERIFIED']);
    });

    it('CONTACT_VERIFIED earnedAt is the LATER of the two verification dates', () => {
      const badges = service.computeBadges(
        baseUser({
          emailVerified: true,
          emailVerifiedAt: new Date('2026-05-01T00:00:00.000Z'),
          phoneVerified: true,
          phoneVerifiedAt: new Date('2026-02-01T00:00:00.000Z'),
        }),
        null,
        NOW,
      );
      expect(badges[0].earnedAt).toEqual(new Date('2026-05-01T00:00:00.000Z'));
    });

    it('KYC_VERIFIED only when kycStatus is APPROVED', () => {
      for (const status of [KycStatus.UNVERIFIED, KycStatus.PENDING, KycStatus.REJECTED, KycStatus.REVOKED]) {
        expect(service.computeBadges(baseUser({ kycStatus: status, kycApprovedAt: NOW }), null, NOW)).toEqual([]);
      }
      const badges = service.computeBadges(
        baseUser({ kycStatus: KycStatus.APPROVED, kycApprovedAt: new Date('2026-04-04T00:00:00.000Z') }),
        null,
        NOW,
      );
      expect(badges.map((b) => b.type)).toEqual(['KYC_VERIFIED']);
      expect(badges[0].earnedAt).toEqual(new Date('2026-04-04T00:00:00.000Z'));
    });

    it('BUSINESS_VERIFIED needs an APPROVED row AND accountType BUSINESS', () => {
      const approved = { status: BusinessVerificationStatus.APPROVED, approvedAt: new Date('2026-06-06T00:00:00.000Z') };

      // Akun PERSONAL dengan baris APPROVED (data anomaly) tidak boleh menyala.
      expect(service.computeBadges(baseUser(), approved, NOW)).toEqual([]);

      const badges = service.computeBadges(baseUser({ accountType: UserAccountType.BUSINESS }), approved, NOW);
      expect(badges.map((b) => b.type)).toEqual(['BUSINESS_VERIFIED']);
      expect(badges[0].earnedAt).toEqual(new Date('2026-06-06T00:00:00.000Z'));

      for (const status of [
        BusinessVerificationStatus.PENDING,
        BusinessVerificationStatus.REJECTED,
        BusinessVerificationStatus.REVOKED,
      ]) {
        expect(service.computeBadges(baseUser({ accountType: UserAccountType.BUSINESS }), { status, approvedAt: NOW }, NOW)).toEqual([]);
      }
    });

    it('KAHADE_PLUS honours subscriptionExpiresAt even if isKahadePlus is stale', () => {
      expect(
        service.computeBadges(baseUser({ isKahadePlus: true, subscriptionExpiresAt: new Date('2026-09-11T00:00:00.000Z') }), null, NOW),
      ).toEqual([]);

      const badges = service.computeBadges(
        baseUser({
          isKahadePlus: true,
          subscriptionExpiresAt: new Date('2026-10-01T00:00:00.000Z'),
          kahadePlusSince: new Date('2026-01-15T00:00:00.000Z'),
        }),
        null,
        NOW,
      );
      expect(badges.map((b) => b.type)).toEqual(['KAHADE_PLUS']);
      expect(badges[0].earnedAt).toEqual(new Date('2026-01-15T00:00:00.000Z'));
    });

    it('TRUSTED_BY_KAHADE reuses isVip/vipGrantedAt (no new field)', () => {
      const badges = service.computeBadges(
        baseUser({ isVip: true, vipGrantedAt: new Date('2026-07-07T00:00:00.000Z') }),
        null,
        NOW,
      );
      expect(badges.map((b) => b.type)).toEqual(['TRUSTED_BY_KAHADE']);
      expect(badges[0].earnedAt).toEqual(new Date('2026-07-07T00:00:00.000Z'));
    });

    it('FULLY_VERIFIED (tier abu) requires KYC + email + phone + address + active Kahade+ + not revoked', () => {
      const plusActive = {
        isKahadePlus: true,
        subscriptionExpiresAt: new Date('2026-12-01T00:00:00.000Z'),
        kahadePlusSince: new Date('2026-01-15T00:00:00.000Z'),
      };

      // Tanpa alamat → tidak dapat FULLY_VERIFIED walau KYC+kontak+Plus lengkap.
      const noAddress = service.computeBadges(
        baseUser({
          emailVerified: true,
          emailVerifiedAt: NOW,
          phoneVerified: true,
          phoneVerifiedAt: NOW,
          kycStatus: KycStatus.APPROVED,
          kycApprovedAt: NOW,
          address: null,
          ...plusActive,
        }),
        null,
        NOW,
      );
      expect(noAddress.map((b) => b.type)).not.toContain('FULLY_VERIFIED');

      // Alamat kosong/spasi saja → tidak dihitung.
      const blankAddress = service.computeBadges(
        baseUser({
          emailVerified: true,
          phoneVerified: true,
          kycStatus: KycStatus.APPROVED,
          address: '   ',
          ...plusActive,
        }),
        null,
        NOW,
      );
      expect(blankAddress.map((b) => b.type)).not.toContain('FULLY_VERIFIED');

      // Tanpa Kahade+ aktif → tidak dapat FULLY_VERIFIED (syarat baru).
      const noPlus = service.computeBadges(
        baseUser({
          emailVerified: true,
          phoneVerified: true,
          kycStatus: KycStatus.APPROVED,
          address: 'Jl. Merdeka No. 1, Jakarta',
        }),
        null,
        NOW,
      );
      expect(noPlus.map((b) => b.type)).not.toContain('FULLY_VERIFIED');

      // Kahade+ kedaluwarsa → tidak dapat FULLY_VERIFIED.
      const plusExpired = service.computeBadges(
        baseUser({
          emailVerified: true,
          phoneVerified: true,
          kycStatus: KycStatus.APPROVED,
          address: 'Jl. Merdeka No. 1, Jakarta',
          isKahadePlus: true,
          subscriptionExpiresAt: new Date('2026-09-01T00:00:00.000Z'),
        }),
        null,
        NOW,
      );
      expect(plusExpired.map((b) => b.type)).not.toContain('FULLY_VERIFIED');

      // Di-revoke admin → tidak dapat FULLY_VERIFIED walau syarat otomatis lengkap.
      const revoked = service.computeBadges(
        baseUser({
          emailVerified: true,
          phoneVerified: true,
          kycStatus: KycStatus.APPROVED,
          address: 'Jl. Merdeka No. 1, Jakarta',
          ...plusActive,
          grayVerifiedRevokedAt: new Date('2026-09-20T00:00:00.000Z'),
        }),
        null,
        NOW,
      );
      expect(revoked.map((b) => b.type)).not.toContain('FULLY_VERIFIED');

      // Lengkap semua → dapat FULLY_VERIFIED dengan earnedAt = yang paling belakang.
      const full = service.computeBadges(
        baseUser({
          emailVerified: true,
          emailVerifiedAt: new Date('2026-01-01T00:00:00.000Z'),
          phoneVerified: true,
          phoneVerifiedAt: new Date('2026-02-01T00:00:00.000Z'),
          kycStatus: KycStatus.APPROVED,
          kycApprovedAt: new Date('2026-03-01T00:00:00.000Z'),
          address: 'Jl. Merdeka No. 1, Jakarta',
          ...plusActive,
        }),
        null,
        NOW,
      );
      const fv = full.find((b) => b.type === 'FULLY_VERIFIED');
      expect(fv).toBeDefined();
      expect(fv!.earnedAt).toEqual(new Date('2026-03-01T00:00:00.000Z'));
    });

    it('FULLY_VERIFIED description mentions the Kahade+ requirement', () => {
      const catalog = service.getCatalog();
      const fv = catalog.find((c) => c.type === 'FULLY_VERIFIED');
      expect(fv).toBeDefined();
      expect(fv!.description).toMatch(/Kahade\+/);
    });

    it('orders badges by display priority Full > KYC > Business > Kahade+ > Trusted > Contact', () => {
      const badges = service.computeBadges(
        baseUser({
          accountType: UserAccountType.BUSINESS,
          emailVerified: true,
          emailVerifiedAt: NOW,
          phoneVerified: true,
          phoneVerifiedAt: NOW,
          kycStatus: KycStatus.APPROVED,
          kycApprovedAt: NOW,
          isKahadePlus: true,
          kahadePlusSince: NOW,
          isVip: true,
          vipGrantedAt: NOW,
          address: 'Jl. Merdeka No. 1, Jakarta',
        }),
        { status: BusinessVerificationStatus.APPROVED, approvedAt: NOW },
        NOW,
      );
      expect(badges.map((b) => b.type)).toEqual([...VERIFICATION_BADGE_TYPES]);
      expect(badges.map((b) => b.priority)).toEqual([1, 2, 3, 4, 5, 6]);
    });

    it('every badge carries a stable labelKey, short label and icon for the UI', () => {
      const badges = service.computeBadges(
        baseUser({ kycStatus: KycStatus.APPROVED, kycApprovedAt: NOW, isVip: true }),
        null,
        NOW,
      );
      for (const badge of badges) {
        expect(badge.labelKey).toMatch(/^badge\./);
        expect(badge.shortLabel.length).toBeGreaterThan(0);
        expect(badge.icon.length).toBeGreaterThan(0);
        expect(badge.description.length).toBeGreaterThan(0);
      }
    });
  });

  describe('loadBadges', () => {
    it('throws NotFound for a soft-deleted user', async () => {
      mockPrisma.user.findMany.mockResolvedValue([]);
      await expect(service.loadBadges('missing')).rejects.toThrow(NotFoundException);
      // Soft-delete guard harus ada di query-nya, bukan hanya di hasil.
      expect(mockPrisma.user.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ id: { in: ['missing'] }, deletedAt: null }) }),
      );
    });

    it('skips the businessVerification query entirely for PERSONAL accounts', async () => {
      mockPrisma.user.findMany.mockResolvedValue([baseUser()]);
      await service.loadBadges('user-1', NOW);
      expect(mockPrisma.businessVerification.findMany).not.toHaveBeenCalled();
    });

    it('queries only APPROVED business verifications for BUSINESS accounts', async () => {
      mockPrisma.user.findMany.mockResolvedValue([baseUser({ accountType: UserAccountType.BUSINESS })]);
      mockPrisma.businessVerification.findMany.mockResolvedValue([]);
      await service.loadBadges('user-1', NOW);
      expect(mockPrisma.businessVerification.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { userId: { in: ['user-1'] }, status: BusinessVerificationStatus.APPROVED },
          orderBy: [{ approvedAt: 'desc' }, { id: 'desc' }],
        }),
      );
    });
  });

  describe('loadBadgesBatch — PERF-FIX BD-002', () => {
    it('loads N users with a single user.findMany (not N findFirst)', async () => {
      const users = [
        baseUser({ id: 'u1', kycStatus: KycStatus.APPROVED }),
        baseUser({ id: 'u2', isVip: true }),
        baseUser({ id: 'u3' }),
      ];
      mockPrisma.user.findMany.mockResolvedValue(users);
      const map = await service.loadBadgesBatch(['u1', 'u2', 'u3', 'u1'], NOW); // duplikat di-dedupe
      expect(mockPrisma.user.findMany).toHaveBeenCalledTimes(1);
      expect(mockPrisma.user.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ id: { in: ['u1', 'u2', 'u3'] } }) }),
      );
      expect(mockPrisma.businessVerification.findMany).not.toHaveBeenCalled();
      expect(map.get('u1')!.map((b) => b.type)).toEqual(['KYC_VERIFIED']);
      expect(map.get('u2')!.map((b) => b.type)).toEqual(['TRUSTED_BY_KAHADE']);
      expect(map.get('u3')).toEqual([]);
    });

    it('picks the latest APPROVED businessVerification per user from one findMany', async () => {
      const users = [
        baseUser({ id: 'b1', accountType: UserAccountType.BUSINESS }),
        baseUser({ id: 'b2', accountType: UserAccountType.BUSINESS }),
        baseUser({ id: 'p1' }),
      ];
      mockPrisma.user.findMany.mockResolvedValue(users);
      mockPrisma.businessVerification.findMany.mockResolvedValue([
        { userId: 'b1', status: BusinessVerificationStatus.APPROVED, approvedAt: new Date('2026-01-01T00:00:00.000Z') },
        { userId: 'b1', status: BusinessVerificationStatus.APPROVED, approvedAt: new Date('2026-06-01T00:00:00.000Z') },
        // b2 tidak punya baris APPROVED → tidak dapat badge
      ]);
      const map = await service.loadBadgesBatch(['b1', 'b2', 'p1'], NOW);
      expect(mockPrisma.businessVerification.findMany).toHaveBeenCalledTimes(1);
      expect(mockPrisma.businessVerification.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ userId: { in: ['b1', 'b2'] } }) }),
      );
      expect(map.get('b1')!.map((b) => b.type)).toEqual(['BUSINESS_VERIFIED']);
      expect(map.get('b1')![0].earnedAt).toEqual(new Date('2026-06-01T00:00:00.000Z'));
      expect(map.get('b2')).toEqual([]);
    });

    it('returns an empty map for an empty input without touching the DB', async () => {
      const map = await service.loadBadgesBatch([]);
      expect(map.size).toBe(0);
      expect(mockPrisma.user.findMany).not.toHaveBeenCalled();
    });

    it('omits users missing from the DB result (soft-deleted)', async () => {
      mockPrisma.user.findMany.mockResolvedValue([baseUser({ id: 'u1' })]);
      const map = await service.loadBadgesBatch(['u1', 'gone']);
      expect(map.has('u1')).toBe(true);
      expect(map.has('gone')).toBe(false);
    });
  });

  describe('getBadgesBatch — PERF-FIX BD-002', () => {
    const cachedBadges = (type: string) =>
      JSON.stringify([
        { type, labelKey: 'k', label: 'x', shortLabel: 's', description: 'd', icon: 'i', earnedAt: null, priority: 1 },
      ]);

    it('loads N users with a single user.findMany (not N getBadges)', async () => {
      mockRedis.get.mockResolvedValue(null);
      mockPrisma.user.findMany.mockResolvedValue([
        baseUser({ id: 'u1', kycStatus: KycStatus.APPROVED }),
        baseUser({ id: 'u2', isVip: true }),
      ]);
      const map = await service.getBadgesBatch(['u1', 'u2', 'u1']); // duplikat di-dedupe
      expect(mockPrisma.user.findMany).toHaveBeenCalledTimes(1);
      expect(mockPrisma.user.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ id: { in: ['u1', 'u2'] } }) }),
      );
      expect(map.get('u1')!.map((b) => b.type)).toEqual(['KYC_VERIFIED']);
      expect(map.get('u2')!.map((b) => b.type)).toEqual(['TRUSTED_BY_KAHADE']);
    });

    it('serves cache hits without any DB query and warms the cache for misses with 600s TTL', async () => {
      mockRedis.get.mockImplementation((key: string) =>
        Promise.resolve(key.endsWith('hit-user') ? cachedBadges('TRUSTED_BY_KAHADE') : null),
      );
      mockPrisma.user.findMany.mockResolvedValue([baseUser({ id: 'miss-user', kycStatus: KycStatus.APPROVED })]);
      const map = await service.getBadgesBatch(['hit-user', 'miss-user']);
      expect(map.get('hit-user')!.map((b) => b.type)).toEqual(['TRUSTED_BY_KAHADE']);
      expect(map.get('miss-user')!.map((b) => b.type)).toEqual(['KYC_VERIFIED']);
      expect(mockPrisma.user.findMany).toHaveBeenCalledTimes(1);
      // Hanya yang miss yang dihangatkan — yang hit tidak ditulis ulang.
      expect(mockRedis.setex).toHaveBeenCalledTimes(1);
      expect(mockRedis.setex).toHaveBeenCalledWith(
        PROFILE_VERIFICATION_BADGES('miss-user'),
        600,
        expect.any(String),
      );
    });

    it('omits users missing from the DB result (soft-deleted) instead of throwing', async () => {
      mockRedis.get.mockResolvedValue(null);
      mockPrisma.user.findMany.mockResolvedValue([baseUser({ id: 'u1' })]);
      const map = await service.getBadgesBatch(['u1', 'gone']);
      expect(map.has('u1')).toBe(true);
      expect(map.has('gone')).toBe(false);
    });

    it('never throws when the batch DB load fails — cache hits are still served', async () => {
      mockRedis.get.mockImplementation((key: string) =>
        Promise.resolve(key.endsWith('hit-user') ? cachedBadges('KYC_VERIFIED') : null),
      );
      mockPrisma.user.findMany.mockRejectedValue(new Error('db down'));
      const map = await service.getBadgesBatch(['hit-user', 'u1']);
      expect(map.get('hit-user')!.map((b) => b.type)).toEqual(['KYC_VERIFIED']);
      expect(map.has('u1')).toBe(false);
    });

    it('returns an empty map for empty input without touching Redis or the DB', async () => {
      const map = await service.getBadgesBatch([]);
      expect(map.size).toBe(0);
      expect(mockRedis.get).not.toHaveBeenCalled();
      expect(mockPrisma.user.findMany).not.toHaveBeenCalled();
    });

    it('parses earnedAt back into Date from cached payloads', async () => {
      mockRedis.get.mockResolvedValue(
        JSON.stringify([
          { type: 'KYC_VERIFIED', labelKey: 'k', label: 'x', shortLabel: 's', description: 'd', icon: 'i', earnedAt: '2026-04-04T00:00:00.000Z', priority: 1 },
        ]),
      );
      const map = await service.getBadgesBatch(['u1']);
      expect(map.get('u1')![0].earnedAt).toBeInstanceOf(Date);
    });
  });

  describe('getSealTierMap — PERF-FIX BD-001 + BD-002', () => {
    const cachedBadges = (type: string) =>
      JSON.stringify([
        { type, labelKey: 'k', label: 'x', shortLabel: 's', description: 'd', icon: 'i', earnedAt: null, priority: 1 },
      ]);

    it('serves cache hits without any DB query', async () => {
      mockRedis.get.mockImplementation((key: string) =>
        Promise.resolve(key.endsWith('gold-user') ? cachedBadges('TRUSTED_BY_KAHADE') : null),
      );
      mockPrisma.user.findMany.mockResolvedValue([baseUser({ id: 'db-user', isVip: true })]);
      const map = await service.getSealTierMap(['gold-user', 'db-user']);
      expect(map.get('gold-user')).toBe('gold');
      expect(map.get('db-user')).toBe('gold');
      // Hanya 1 batch findMany untuk yang miss — bukan N findFirst.
      expect(mockPrisma.user.findMany).toHaveBeenCalledTimes(1);
      expect(mockPrisma.user.findFirst).not.toHaveBeenCalled();
    });

    it('returns null tier for a user missing from the DB instead of throwing', async () => {
      mockRedis.get.mockResolvedValue(null);
      mockPrisma.user.findMany.mockResolvedValue([]);
      const map = await service.getSealTierMap(['ghost']);
      expect(map.get('ghost')).toBeNull();
    });

    it('returns null tiers for all misses when the batch DB load fails', async () => {
      mockRedis.get.mockResolvedValue(null);
      mockPrisma.user.findMany.mockRejectedValue(new Error('db down'));
      const map = await service.getSealTierMap(['u1', 'u2']);
      expect(map.get('u1')).toBeNull();
      expect(map.get('u2')).toBeNull();
    });

    it('warms the cache for misses with the new 600s TTL', async () => {
      mockRedis.get.mockResolvedValue(null);
      mockPrisma.user.findMany.mockResolvedValue([baseUser({ id: 'u1', kycStatus: KycStatus.APPROVED })]);
      await service.getSealTierMap(['u1']);
      expect(mockRedis.setex).toHaveBeenCalledWith(
        PROFILE_VERIFICATION_BADGES('u1'),
        600,
        expect.any(String),
      );
    });

    it('returns an empty map for empty input', async () => {
      await expect(service.getSealTierMap([])).resolves.toEqual(new Map());
      expect(mockRedis.get).not.toHaveBeenCalled();
    });
  });

  describe('getBadges — read-through cache', () => {
    it('serves from cache and does not hit the DB', async () => {
      mockRedis.get.mockResolvedValue(
        JSON.stringify([
          { type: 'KYC_VERIFIED', labelKey: 'badge.kycVerified', label: 'x', shortLabel: 'KYC', description: 'd', icon: 'badge-check', earnedAt: '2026-04-04T00:00:00.000Z', priority: 1 },
        ]),
      );
      const badges = await service.getBadges('user-1');
      expect(badges).toHaveLength(1);
      expect(badges[0].earnedAt).toBeInstanceOf(Date);
      expect(mockPrisma.user.findMany).not.toHaveBeenCalled();
    });

    it('bypasses cache when skipCache is requested', async () => {
      mockRedis.get.mockResolvedValue(JSON.stringify([]));
      mockPrisma.user.findMany.mockResolvedValue([baseUser({ kycStatus: KycStatus.APPROVED })]);
      const badges = await service.getBadges('user-1', { skipCache: true });
      expect(badges.map((b) => b.type)).toEqual(['KYC_VERIFIED']);
    });

    it('recomputes instead of failing when the cached payload is corrupt', async () => {
      mockRedis.get.mockResolvedValue('{not-json');
      mockPrisma.user.findMany.mockResolvedValue([baseUser()]);
      await expect(service.getBadges('user-1')).resolves.toEqual([]);
      expect(mockRedis.del).toHaveBeenCalledWith(PROFILE_VERIFICATION_BADGES('user-1'));
    });

    it('writes with the 600s TTL (PERF-FIX BD-001 — revoke tetap via invalidate eksplisit)', async () => {
      mockPrisma.user.findMany.mockResolvedValue([baseUser()]);
      await service.getBadges('user-1');
      expect(VERIFICATION_BADGE_CACHE_TTL_SECONDS).toBe(600);
      expect(mockRedis.setex).toHaveBeenCalledWith(
        PROFILE_VERIFICATION_BADGES('user-1'),
        VERIFICATION_BADGE_CACHE_TTL_SECONDS,
        expect.any(String),
      );
    });

    it('never throws when the cache write fails', async () => {
      mockPrisma.user.findMany.mockResolvedValue([baseUser()]);
      mockRedis.setex.mockRejectedValue(new Error('redis down'));
      await expect(service.getBadges('user-1')).resolves.toEqual([]);
    });
  });

  describe('invalidate', () => {
    it('deletes the badge cache key for the user', async () => {
      await service.invalidate('user-9');
      expect(mockRedis.del).toHaveBeenCalledWith(PROFILE_VERIFICATION_BADGES('user-9'));
    });

    it('swallows redis failures so a revoke is never rolled back by cache trouble', async () => {
      mockRedis.del.mockRejectedValue(new Error('redis down'));
      await expect(service.invalidate('user-9')).resolves.toBeUndefined();
    });
  });

  describe('getPublicBadgesByUsername', () => {
    const visibleOwner = {
      id: 'owner-1',
      username: 'seller',
      profileVisible: true,
      isActive: true,
      isBanned: false,
      deletedAt: null,
    };

    it('throws NotFound for an invisible, inactive, banned or deleted profile', async () => {
      for (const overrides of [
        { profileVisible: false },
        { isActive: false },
        { isBanned: true },
        { deletedAt: new Date() },
      ]) {
        mockPrisma.user.findUnique.mockResolvedValue({ ...visibleOwner, ...overrides });
        await expect(service.getPublicBadgesByUsername('seller')).rejects.toThrow(NotFoundException);
      }
      mockPrisma.user.findUnique.mockResolvedValue(null);
      await expect(service.getPublicBadgesByUsername('seller')).rejects.toThrow(NotFoundException);
    });

    it('rejects a blocked viewer with 403 rather than hiding fields', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(visibleOwner);
      mockPrisma.blockList.findFirst.mockResolvedValue({ id: 'block-1' });
      await expect(service.getPublicBadgesByUsername('seller', 'viewer-1')).rejects.toThrow(ForbiddenException);
      // Kedua arah block harus dicek dalam satu query.
      expect(mockPrisma.blockList.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            OR: [
              { blockerId: 'owner-1', blockedId: 'viewer-1' },
              { blockerId: 'viewer-1', blockedId: 'owner-1' },
            ],
          },
        }),
      );
    });

    it('does not run the block check when the viewer is the owner', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(visibleOwner);
      mockPrisma.user.findMany.mockResolvedValue([baseUser({ id: 'owner-1' })]);
      await service.getPublicBadgesByUsername('seller', 'owner-1');
      expect(mockPrisma.blockList.findFirst).not.toHaveBeenCalled();
    });

    it('returns the ordered badge array for an anonymous viewer', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(visibleOwner);
      mockPrisma.user.findMany.mockResolvedValue([baseUser({ id: 'owner-1', kycStatus: KycStatus.APPROVED, isVip: true })]);
      const result = await service.getPublicBadgesByUsername('seller');
      expect(result.username).toBe('seller');
      expect(result.badges.map((b) => b.type)).toEqual(['KYC_VERIFIED', 'TRUSTED_BY_KAHADE']);
    });
  });

  describe('getCatalog', () => {
    it('lists all six badge types in display priority order', () => {
      const catalog = service.getCatalog();
      expect(catalog.map((c) => c.type)).toEqual([...VERIFICATION_BADGE_TYPES]);
      expect(catalog.every((c) => !('earnedAt' in c))).toBe(true);
    });
  });
});
