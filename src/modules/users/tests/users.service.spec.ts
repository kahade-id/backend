import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { NotFoundException, BadRequestException, ConflictException } from '@nestjs/common';
import { UsersService } from '../users.service';
import { PrismaService } from '../../../prisma/prisma.service';
import { RedisService } from '../../../redis/redis.service';
import { AuditLogService } from '../../../common/services/audit-log.service';
import { OgMetadataService } from '../og-metadata.service';
import { Prisma } from '@prisma/client';
import { bcryptHash } from '../../../common/utils/crypto.util';
import * as cryptoUtils from '../../../common/utils/crypto.util';
import * as speakeasy from 'speakeasy';

jest.mock('../../../common/utils/pii.util', () => ({
  decryptPiiSafe: jest.fn(async (s: string | null) => s),
  encryptPii: jest.fn(async (s: string) => s),
  hashPhoneNumber: jest.fn(async (s: string) => `h:${s}`),
  normalizePhoneNumber: jest.fn((s: string) => s),
}));

const mockPrisma: any = {
  user: { findUnique: jest.fn(), findFirst: jest.fn(), update: jest.fn() },
  follow: { findUnique: jest.fn(), findMany: jest.fn(), count: jest.fn(), create: jest.fn(), delete: jest.fn(), deleteMany: jest.fn() },
  blockList: { findUnique: jest.fn(), findFirst: jest.fn(), findMany: jest.fn(), count: jest.fn(), create: jest.fn(), delete: jest.fn() },
  userFavorite: { findUnique: jest.fn(), findMany: jest.fn(), count: jest.fn(), create: jest.fn(), delete: jest.fn(), deleteMany: jest.fn() },
  userSavedProfile: { findUnique: jest.fn(), findMany: jest.fn(), count: jest.fn(), create: jest.fn(), deleteMany: jest.fn() },
  rating: { findMany: jest.fn(), count: jest.fn(), aggregate: jest.fn() },
  userReport: { findFirst: jest.fn(), count: jest.fn(), create: jest.fn() },
  order: { count: jest.fn(), findUnique: jest.fn() },
  wallet: { findUnique: jest.fn() },
  userDevice: { findMany: jest.fn(), count: jest.fn(), findFirst: jest.fn(), update: jest.fn(), updateMany: jest.fn(), delete: jest.fn() },
  notification: { create: jest.fn().mockResolvedValue({}) },
  emitNotificationCreated: jest.fn(),
  userSession: { findMany: jest.fn(), updateMany: jest.fn() },
  walletTransaction: { count: jest.fn() },
  auditLog: { findMany: jest.fn(), count: jest.fn() },
  userShowcase: { findMany: jest.fn(), count: jest.fn(), create: jest.fn(), update: jest.fn(), findFirst: jest.fn(), delete: jest.fn() },
  twoFactorAuth: { findUnique: jest.fn(), updateMany: jest.fn() },
  userLink: { findMany: jest.fn(), delete: jest.fn(), update: jest.fn(), create: jest.fn() },
  $transaction: jest.fn(),
};
const mockRedis = { get: jest.fn(), set: jest.fn(), del: jest.fn(), setex: jest.fn(), setNx: jest.fn(), releaseLock: jest.fn(), getPrefix: jest.fn().mockReturnValue('test:'), getClient: jest.fn() };
const mockAudit = { logUserAction: jest.fn() };
const mockConfig = { get: jest.fn() };
const mockOg = { invalidateUserOgCache: jest.fn() };

describe('UsersService', () => {
  let service: UsersService;

  beforeEach(async () => {
    jest.resetAllMocks();
    mockRedis.del.mockResolvedValue(1);
    mockRedis.setNx.mockResolvedValue(true);
    mockRedis.releaseLock.mockResolvedValue(true);
    mockPrisma.notification.create.mockResolvedValue({});
    mockOg.invalidateUserOgCache.mockResolvedValue(undefined);
    mockPrisma.$transaction.mockImplementation(async (fn: any) => fn(mockPrisma));
    mockPrisma.rating.aggregate.mockResolvedValue({ _avg: { stars: null } });
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        UsersService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: RedisService, useValue: mockRedis },
        { provide: ConfigService, useValue: mockConfig },
        { provide: AuditLogService, useValue: mockAudit },
        { provide: OgMetadataService, useValue: mockOg },
      ],
    }).compile();
    service = module.get<UsersService>(UsersService);
  });

  it('should be defined', () => expect(service).toBeDefined());

  describe('device session revocation', () => {
    it('revokes sessions bound to the removed device and unbound legacy sessions', async () => {
      mockPrisma.userDevice.findFirst.mockResolvedValue({ id: 'device-row-1', deviceId: 'device-fingerprint-1' });
      mockPrisma.userSession.findMany.mockResolvedValue([{ id: 'session-device' }, { id: 'session-legacy' }]);
      mockPrisma.userSession.updateMany.mockResolvedValue({ count: 2 });
      mockPrisma.userDevice.delete.mockResolvedValue({});
      mockConfig.get.mockReturnValue('15m');
      mockRedis.setex.mockResolvedValue('OK');

      await expect(service.removeDevice('user-1', 'device-row-1')).resolves.toEqual({ message: 'Device removed successfully' });

      expect(mockPrisma.userSession.findMany).toHaveBeenCalledWith(expect.objectContaining({
        where: expect.objectContaining({
          userId: 'user-1',
          OR: [{ deviceId: 'device-fingerprint-1' }, { deviceId: null }],
        }),
      }));
      expect(mockPrisma.userSession.updateMany).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({ isRevoked: true, revokedReason: 'device_removed' }),
      }));
      expect(mockRedis.setex).toHaveBeenCalledWith('session_revoked:session-device', 900, '1', { throwOnError: true });
      expect(mockRedis.setex).toHaveBeenCalledWith('session_revoked:session-legacy', 900, '1', { throwOnError: true });
    });
  });

  describe('sensitive identity changes', () => {
    it('rejects phone number changes through the generic profile endpoint', async () => {
      await expect(service.updateProfile('user-1', { phoneNumber: '+6281234567890' } as any))
        .rejects.toThrow(BadRequestException);
      expect(mockPrisma.user.update).not.toHaveBeenCalled();
    });

    it('requires an authenticator code before changing device trust when 2FA is enabled', async () => {
      const passwordHash = await bcryptHash('Password123!', 4);
      mockPrisma.user.findUnique.mockResolvedValue({ id: 'user-1', password: passwordHash });
      mockPrisma.twoFactorAuth.findUnique.mockResolvedValue({ isEnabled: true, secret: 'encrypted-secret' });
      mockPrisma.userDevice.findFirst.mockResolvedValue({ id: 'device-1', isTrusted: false });

      await expect(service.setDeviceTrust('user-1', 'device-1', true, 'Password123!'))
        .rejects.toMatchObject({ response: { code: 'TWO_FA_REQUIRED' } });
      expect(mockPrisma.userDevice.findFirst).toHaveBeenCalledWith({ where: { id: 'device-1', userId: 'user-1' } });
    });

    it('rejects reuse of a TOTP after it has authorized a trusted-device mutation', async () => {
      const passwordHash = await bcryptHash('Password123!', 4);
      const secret = 'JBSWY3DPEHPK3PXP';
      const code = speakeasy.totp({ secret, encoding: 'base32' });
      const redisClient = { sadd: jest.fn().mockResolvedValueOnce(1).mockResolvedValueOnce(0), expire: jest.fn().mockResolvedValue(1) };
      mockPrisma.user.findUnique.mockResolvedValue({ id: 'user-1', password: passwordHash });
      mockPrisma.twoFactorAuth.findUnique.mockResolvedValue({ isEnabled: true, secret: 'encrypted-secret' });
      mockPrisma.userDevice.findFirst.mockResolvedValue({ id: 'device-1', deviceId: 'device-fingerprint-1', deviceName: 'Test device', isTrusted: false });
      mockPrisma.userDevice.update.mockResolvedValue({});
      mockConfig.get.mockImplementation((key: string) => key === 'crypto.hmacSecretKey' ? 'test-hmac' : undefined);
      mockRedis.getPrefix.mockReturnValue('test:');
      mockRedis.getClient.mockReturnValue(redisClient);
      jest.spyOn(cryptoUtils, 'decryptAES').mockResolvedValue(secret);

      await expect(service.setDeviceTrust('user-1', 'device-1', true, 'Password123!', code))
        .resolves.toEqual({ message: 'Device marked as trusted' });
      await expect(service.setDeviceTrust('user-1', 'device-1', true, 'Password123!', code))
        .rejects.toMatchObject({ response: { code: 'INVALID_2FA_CODE' } });

      expect(redisClient.expire).toHaveBeenCalledWith('test:totp_used:user-1', 90);
    });

    it('records an in-app security alert when a device is marked as trusted', async () => {
      const passwordHash = await bcryptHash('Password123!', 4);
      mockPrisma.user.findUnique.mockResolvedValue({ id: 'user-1', password: passwordHash });
      mockPrisma.twoFactorAuth.findUnique.mockResolvedValue({ isEnabled: false, secret: null });
      mockPrisma.userDevice.findFirst.mockResolvedValue({ id: 'device-1', deviceId: 'device-fingerprint-1', deviceName: 'Test device', isTrusted: false });
      mockPrisma.userDevice.update.mockResolvedValue({});

      await expect(service.setDeviceTrust('user-1', 'device-1', true, 'Password123!'))
        .resolves.toEqual({ message: 'Device marked as trusted' });
      await new Promise((resolve) => setImmediate(resolve));

      expect(mockPrisma.notification.create).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({ title: 'Device Marked as Trusted', userId: 'user-1' }),
      }));
    });
  });

  describe('checkUsernameAvailability', () => {
    it('returns available true when no user', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(null);
      const res: any = await service.checkUsernameAvailability('alice');
      expect(res.available).toBe(true);
      expect(res.suggestion).toBeUndefined();
    });

    it('returns available false with suggestion when taken', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({ id: 'u1' });
      const res: any = await service.checkUsernameAvailability('alice');
      expect(res.available).toBe(false);
      expect(res.suggestion).toContain('alice');
    });
  });

  describe('followUser', () => {
    it('throws NotFound when target missing', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(null);
      await expect(service.followUser('me', 'x')).rejects.toThrow(NotFoundException);
    });

    it('throws BadRequest when self-follow', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({ id: 'me' });
      await expect(service.followUser('me', 'me')).rejects.toThrow(BadRequestException);
    });

    it('throws NotFound when blocked', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({ id: 'other' });
      mockPrisma.blockList.findFirst.mockResolvedValue({ id: 'b' });
      await expect(service.followUser('me', 'other')).rejects.toThrow(NotFoundException);
    });

    it('throws Conflict when already following', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({ id: 'other' });
      mockPrisma.blockList.findFirst.mockResolvedValue(null);
      mockPrisma.follow.findUnique.mockResolvedValue({ id: 'f1' });
      await expect(service.followUser('me', 'other')).rejects.toThrow(ConflictException);
    });

    it('creates follow when valid', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({ id: 'other' });
      mockPrisma.blockList.findFirst.mockResolvedValue(null);
      mockPrisma.follow.findUnique.mockResolvedValue(null);
      mockPrisma.follow.create.mockResolvedValue({});
      const res = await service.followUser('me', 'other');
      expect(res.message).toContain('Followed');
    });
  });

  describe('unfollowUser', () => {
    it('throws NotFound when target missing', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(null);
      await expect(service.unfollowUser('me', 'x')).rejects.toThrow(NotFoundException);
    });

    it('throws BadRequest when not following', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({ id: 'other' });
      mockPrisma.follow.findUnique.mockResolvedValue(null);
      await expect(service.unfollowUser('me', 'other')).rejects.toThrow(BadRequestException);
    });

    it('deletes follow when valid', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({ id: 'other' });
      mockPrisma.follow.findUnique.mockResolvedValue({ id: 'f1' });
      mockPrisma.follow.delete.mockResolvedValue({});
      const res = await service.unfollowUser('me', 'other');
      expect(res.message).toContain('Unfollowed');
    });
  });

  describe('getFollowers / getFollowing', () => {
    it('throws NotFound when user missing (followers)', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(null);
      await expect(service.getFollowers('x', 1, 10)).rejects.toThrow(NotFoundException);
    });

    it('returns paginated followers', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({ id: 'u1' });
      mockPrisma.follow.findMany.mockResolvedValue([{
        createdAt: new Date(), follower: { username: 'a', fullName: 'A', avatarUrl: null, membershipRank: 'BRONZE' },
      }]);
      mockPrisma.follow.count.mockResolvedValue(1);
      const res: any = await service.getFollowers('x', 1, 10);
      expect(res.total).toBe(1);
    });

    it('applies search filter on followers', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({ id: 'u1' });
      mockPrisma.follow.findMany.mockResolvedValue([]);
      mockPrisma.follow.count.mockResolvedValue(0);
      await service.getFollowers('x', 1, 10, 'alice');
      const call = mockPrisma.follow.findMany.mock.calls[0][0];
      expect(call.where.follower).toBeDefined();
    });

    it('returns paginated following', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({ id: 'u1' });
      mockPrisma.follow.findMany.mockResolvedValue([]);
      mockPrisma.follow.count.mockResolvedValue(0);
      const res: any = await service.getFollowing('x', 1, 10);
      expect(res.total).toBe(0);
    });
  });

  describe('blockUser', () => {
    it('throws NotFound when target missing', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(null);
      await expect(service.blockUser('me', 'KH-X')).rejects.toThrow(NotFoundException);
    });

    it('throws BadRequest when self-block', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({ id: 'me' });
      await expect(service.blockUser('me', 'KH-me')).rejects.toThrow(BadRequestException);
    });

    it('throws Conflict when already blocked', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({ id: 'other' });
      mockPrisma.blockList.findUnique.mockResolvedValue({ id: 'b' });
      await expect(service.blockUser('me', 'KH-other')).rejects.toThrow(ConflictException);
    });

    it('blocks and cleans follows/favorites', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({ id: 'other' });
      mockPrisma.blockList.findUnique.mockResolvedValue(null);
      mockPrisma.blockList.create.mockResolvedValue({});
      mockPrisma.follow.deleteMany.mockResolvedValue({ count: 0 });
      mockPrisma.userFavorite.deleteMany.mockResolvedValue({ count: 0 });
      const res = await service.blockUser('me', 'KH-other');
      expect(res.message).toContain('blocked');
    });
  });

  describe('unblockUser', () => {
    it('throws NotFound when target missing', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(null);
      await expect(service.unblockUser('me', 'KH-X')).rejects.toThrow(NotFoundException);
    });

    it('throws BadRequest when not blocked', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({ id: 'other' });
      mockPrisma.blockList.findUnique.mockResolvedValue(null);
      await expect(service.unblockUser('me', 'KH-other')).rejects.toThrow(BadRequestException);
    });

    it('deletes block when present', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({ id: 'other' });
      mockPrisma.blockList.findUnique.mockResolvedValue({ id: 'b1' });
      mockPrisma.blockList.delete.mockResolvedValue({});
      const res = await service.unblockUser('me', 'KH-other');
      expect(res.message).toContain('unblocked');
    });
  });

  describe('getBlockedUsers', () => {
    it('returns paginated blocked list', async () => {
      mockPrisma.blockList.findMany.mockResolvedValue([]);
      mockPrisma.blockList.count.mockResolvedValue(0);
      const res: any = await service.getBlockedUsers('me', 1, 10);
      expect(res.total).toBe(0);
    });
  });

  describe('addFavorite', () => {
    it('throws NotFound when target missing', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(null);
      await expect(service.addFavorite('me', 'x')).rejects.toThrow(NotFoundException);
    });

    it('throws BadRequest when self-favorite', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({ id: 'me' });
      await expect(service.addFavorite('me', 'me')).rejects.toThrow(BadRequestException);
    });

    it('does not add a deactivated target to favorites', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({ id: 'other', isActive: false, isBanned: false, deletedAt: null });

      await expect(service.addFavorite('me', 'other')).rejects.toThrow(NotFoundException);
      expect(mockPrisma.userFavorite.create).not.toHaveBeenCalled();
    });

    it('throws NotFound when blocked', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({ id: 'other' });
      mockPrisma.blockList.findFirst.mockResolvedValue({ id: 'b' });
      await expect(service.addFavorite('me', 'other')).rejects.toThrow(NotFoundException);
    });

    it('is a successful no-op when already favorited', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({ id: 'other' });
      mockPrisma.blockList.findFirst.mockResolvedValue(null);
      mockPrisma.userFavorite.findUnique.mockResolvedValue({ id: 'f' });
      await expect(service.addFavorite('me', 'other')).resolves.toEqual({ message: 'Added to favorites successfully' });
    });

    it('adds favorite when valid', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({ id: 'other' });
      mockPrisma.blockList.findFirst.mockResolvedValue(null);
      mockPrisma.userFavorite.findUnique.mockResolvedValue(null);
      mockPrisma.userFavorite.create.mockResolvedValue({});
      const res = await service.addFavorite('me', 'other');
      expect(res.message).toContain('favorites');
    });
  });

  describe('removeFavorite', () => {
    it('throws NotFound when target missing', async () => {
      mockPrisma.user.findFirst.mockResolvedValue(null);
      await expect(service.removeFavorite('me', 'x')).rejects.toThrow(NotFoundException);
    });

    it('is a successful no-op when already removed', async () => {
      mockPrisma.user.findFirst.mockResolvedValue({ id: 'other' });
      mockPrisma.userFavorite.deleteMany.mockResolvedValue({ count: 0 });
      await expect(service.removeFavorite('me', 'other')).resolves.toEqual({ message: 'Removed from favorites successfully' });
    });

    it('removes favorite when present', async () => {
      mockPrisma.user.findFirst.mockResolvedValue({ id: 'other' });
      mockPrisma.userFavorite.deleteMany.mockResolvedValue({ count: 1 });
      const res = await service.removeFavorite('me', 'other');
      expect(res.message).toContain('Removed');
      expect(mockPrisma.userFavorite.deleteMany).toHaveBeenCalledWith({ where: { userId: 'me', favoriteUserId: 'other' } });
    });
  });

  describe('checkFavorite', () => {
    it('throws NotFound when target missing', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(null);
      await expect(service.checkFavorite('me', 'x')).rejects.toThrow(NotFoundException);
    });

    it('returns true when favorited', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({ id: 'other' });
      mockPrisma.userFavorite.findUnique.mockResolvedValue({ id: 'f' });
      const res = await service.checkFavorite('me', 'other');
      expect(res.isFavorited).toBe(true);
    });

    it('returns false when not favorited', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({ id: 'other' });
      mockPrisma.blockList.findFirst.mockResolvedValue(null);
      mockPrisma.userFavorite.findUnique.mockResolvedValue(null);
      const res = await service.checkFavorite('me', 'other');
      expect(res.isFavorited).toBe(false);
    });

    it('hides favorite status across a block relationship', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({ id: 'other' });
      mockPrisma.blockList.findFirst.mockResolvedValue({ id: 'block-1' });

      await expect(service.checkFavorite('me', 'other')).rejects.toThrow(NotFoundException);
      expect(mockPrisma.userFavorite.findUnique).not.toHaveBeenCalled();
    });
  });

  describe('saved profiles', () => {
    it('saves a profile idempotently when no relationship exists', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({ id: 'other' });
      mockPrisma.blockList.findFirst.mockResolvedValue(null);
      mockPrisma.userSavedProfile.findUnique.mockResolvedValue(null);
      mockPrisma.userSavedProfile.create.mockResolvedValue({ id: 'saved-1' });

      await expect(service.saveProfile('me', 'other')).resolves.toEqual({ message: 'Profile saved successfully' });
    });

    it('does not expose saved status across a block relationship', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({ id: 'other' });
      mockPrisma.blockList.findFirst.mockResolvedValue({ id: 'block-1' });

      await expect(service.checkSavedProfile('me', 'other')).rejects.toThrow(NotFoundException);
      expect(mockPrisma.userSavedProfile.findUnique).not.toHaveBeenCalled();
    });

    it('does not save a banned target profile', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({ id: 'other', isActive: true, isBanned: true, deletedAt: null });

      await expect(service.saveProfile('me', 'other')).rejects.toThrow(NotFoundException);
      expect(mockPrisma.userSavedProfile.create).not.toHaveBeenCalled();
    });

    it('filters unavailable targets from favorites and saved profile lists', async () => {
      mockPrisma.userFavorite.findMany.mockResolvedValue([]);
      mockPrisma.userFavorite.count.mockResolvedValue(0);
      mockPrisma.userSavedProfile.findMany.mockResolvedValue([]);
      mockPrisma.userSavedProfile.count.mockResolvedValue(0);

      await service.getFavorites('me', 1, 20);
      await service.getSavedProfiles('me', 1, 20);

      expect(mockPrisma.userFavorite.findMany).toHaveBeenCalledWith(expect.objectContaining({
        where: { userId: 'me', favoriteUser: { isActive: true, isBanned: false, deletedAt: null } },
      }));
      expect(mockPrisma.userSavedProfile.findMany).toHaveBeenCalledWith(expect.objectContaining({
        where: { userId: 'me', savedUser: { isActive: true, isBanned: false, deletedAt: null } },
      }));
    });

    it('removes a saved profile atomically as a successful no-op when absent', async () => {
      mockPrisma.user.findFirst.mockResolvedValue({ id: 'other' });
      mockPrisma.userSavedProfile.deleteMany.mockResolvedValue({ count: 0 });

      await expect(service.removeSavedProfile('me', 'other')).resolves.toEqual({ message: 'Removed saved profile successfully' });
    });
  });

  describe('reportUser evidence host validation', () => {
    it('rejects attacker-owned R2 wildcard hosts', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({ id: 'target' });
      mockPrisma.userReport.findFirst.mockResolvedValue(null);
      mockPrisma.userReport.count.mockResolvedValue(0);
      mockConfig.get.mockImplementation((key: string) => ({
        'r2.bucketPublic': 'kahade-public',
        'r2.bucketPrivate': 'kahade-private',
        'r2.endpointUrl': 'https://account.r2.cloudflarestorage.com',
        'r2.publicUrl': 'https://cdn.kahade.id',
      } as Record<string, string>)[key]);

      await expect(service.reportUser('reporter', 'KH-target', {
        category: 'SPAM',
        description: 'Spam report',
        evidenceUrls: ['https://attacker.r2.dev/evidence.png'],
      } as any)).rejects.toMatchObject({ response: { code: 'VALIDATION_ERROR' } });
      expect(mockPrisma.userReport.create).not.toHaveBeenCalled();
    });
  });

  describe('report related-order authorization', () => {
    it('rejects a related order that does not include both reporter and target', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({ id: 'target-id' });
      mockPrisma.order.findUnique.mockResolvedValue({ buyerId: 'unrelated-buyer', sellerId: 'unrelated-seller' });
      await expect(service.reportUser('reporter-id', 'KH-target', {
        category: 'SPAM', description: 'This report has enough context to be valid.', relatedOrderId: 'order-1',
      } as any)).rejects.toMatchObject({ response: { code: 'ORDER_NOT_FOUND' } });
      expect(mockPrisma.userReport.create).not.toHaveBeenCalled();
    });
  });

  describe('report cooldown', () => {
    it('rejects a concurrent public report while the Redis cooldown lock is held', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({ id: 'target-id' });
      mockPrisma.userReport.findFirst.mockResolvedValue(null);
      mockPrisma.userReport.count.mockResolvedValue(0);
      mockRedis.setNx.mockResolvedValue(false);
      await expect(service.reportUser('me', 'target', { category: 'SPAM', description: 'spam' } as any)).rejects.toMatchObject({ response: { code: 'DUPLICATE_REPORT' } });
      expect(mockPrisma.userReport.create).not.toHaveBeenCalled();
    });
  });

  describe('updateLinks', () => {
    it('rejects duplicate platforms case-insensitively before replacing links', async () => {
      await expect(service.updateLinks('me', {
        links: [
          { platform: 'Instagram', url: 'https://example.com/one' },
          { platform: ' instagram ', url: 'https://example.com/two' },
        ],
      } as any)).rejects.toThrow(ConflictException);
      expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    });
  });

  describe('profile privacy cache', () => {
    it('invalidates privacy cache when profile visibility changes through profile update', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({ username: 'alice' });
      mockPrisma.user.update.mockResolvedValue({ username: 'alice', phoneNumber: null });
      mockPrisma.twoFactorAuth.findUnique.mockResolvedValue({ isEnabled: false });
      await service.updateProfile('me', { profileVisible: false } as any);
      expect(mockRedis.del).toHaveBeenCalledWith('user_privacy:me');
    });

    it('maps a concurrent username unique violation to USERNAME_TAKEN', async () => {
      mockPrisma.user.findUnique
        .mockResolvedValueOnce({ password: 'hash', username: 'alice', phoneNumber: null, contactEmail: null, contactPhone: null })
        .mockResolvedValueOnce({ username: 'alice', usernameChangedAt: null })
        .mockResolvedValueOnce({ username: 'alice' });
      mockPrisma.user.update.mockRejectedValue(new Prisma.PrismaClientKnownRequestError('Unique constraint failed', { code: 'P2002', clientVersion: '5.0.0', meta: { target: ['username'] } }));
      await expect(service.updateProfile('me', { username: 'alice' } as any)).rejects.toMatchObject({ response: { code: 'USERNAME_TAKEN' } });
    });
  });

  describe('account deletion safeguards', () => {
    it('rejects deletion when the wallet still has a positive balance', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({ password: await bcryptHash('pass', 10) });
      mockPrisma.twoFactorAuth.findUnique.mockResolvedValue(null);
      mockPrisma.order.count.mockResolvedValue(0);
      mockPrisma.walletTransaction.count.mockResolvedValue(0);
      mockPrisma.wallet.findUnique.mockResolvedValue({ escrowBalance: 0n, availableBalance: 100n, totalBalance: 100n });
      await expect(service.requestAccountDeletion('me', 'jti', 'pass')).rejects.toMatchObject({ response: { code: 'WALLET_BALANCE_PRESENT' } });
      expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    });

    it('rechecks escrow balance inside the deletion transaction', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({ password: await bcryptHash('pass', 10) });
      mockPrisma.twoFactorAuth.findUnique.mockResolvedValue(null);
      mockPrisma.order.count.mockResolvedValue(0);
      mockPrisma.walletTransaction.count.mockResolvedValue(0);
      mockPrisma.wallet.findUnique.mockResolvedValue({ escrowBalance: 0n, availableBalance: 0n, totalBalance: 0n });
      mockPrisma.$transaction.mockImplementationOnce(async (callback: (tx: unknown) => Promise<unknown>) => callback({
        order: { count: jest.fn().mockResolvedValue(0) },
        walletTransaction: { count: jest.fn().mockResolvedValue(0) },
        wallet: { findUnique: jest.fn().mockResolvedValue({ escrowBalance: 100n, availableBalance: 0n, totalBalance: 100n }) },
        user: { update: jest.fn() },
        userSession: { updateMany: jest.fn() },
        userDevice: { updateMany: jest.fn() },
      }));
      await expect(service.requestAccountDeletion('me', 'jti', 'pass')).rejects.toMatchObject({ response: { code: 'ESCROW_BALANCE_PRESENT' } });
    });

    it('rejects deletion while a withdrawal is pending', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({ password: await bcryptHash('pass', 10) });
      mockPrisma.twoFactorAuth.findUnique.mockResolvedValue(null);
      mockPrisma.order.count.mockResolvedValue(0);
      mockPrisma.walletTransaction.count.mockResolvedValue(1);
      mockPrisma.wallet.findUnique.mockResolvedValue({ escrowBalance: 0n, availableBalance: 0n, totalBalance: 0n });
      await expect(service.requestAccountDeletion('me', 'jti', 'pass')).rejects.toMatchObject({ response: { code: 'ACTIVE_ORDERS_PRESENT' } });
      expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    });

    it('accepts and atomically consumes an unused 2FA backup code for account deletion', async () => {
      const backupCode = 'AB12CD34EF56GH78';
      const backupCodeHash = await bcryptHash(backupCode, 10);
      mockPrisma.user.findUnique.mockResolvedValue({ password: await bcryptHash('pass', 10) });
      mockPrisma.twoFactorAuth.findUnique.mockResolvedValue({
        id: 'two-factor-1',
        isEnabled: true,
        secret: 'encrypted-secret',
        backupCodes: [backupCodeHash],
        usedBackupCodes: [],
      });
      jest.spyOn(cryptoUtils, 'decryptAES').mockResolvedValue('JBSWY3DPEHPK3PXP');
      mockPrisma.twoFactorAuth.updateMany.mockResolvedValue({ count: 1 });
      mockPrisma.order.count.mockResolvedValue(0);
      mockPrisma.walletTransaction.count.mockResolvedValue(0);
      mockPrisma.wallet.findUnique.mockResolvedValue({ escrowBalance: 0n, availableBalance: 0n, totalBalance: 0n });
      mockPrisma.userSession.findMany.mockResolvedValue([]);
      mockRedis.setex.mockResolvedValue('OK');

      await expect(service.requestAccountDeletion('me', 'jti', 'pass', undefined, backupCode)).resolves.toMatchObject({ message: expect.stringContaining('Account deletion requested') });

      expect(mockPrisma.twoFactorAuth.updateMany).toHaveBeenCalledWith(expect.objectContaining({
        where: expect.objectContaining({ id: 'two-factor-1' }),
        data: { usedBackupCodes: { push: backupCodeHash } },
      }));
    });

    it('returns success when account deletion is persisted but Redis propagation fails', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({ password: await bcryptHash('pass', 10) });
      mockPrisma.twoFactorAuth.findUnique.mockResolvedValue(null);
      mockPrisma.order.count.mockResolvedValue(0);
      mockPrisma.walletTransaction.count.mockResolvedValue(0);
      mockPrisma.wallet.findUnique.mockResolvedValue({ escrowBalance: 0n, availableBalance: 0n, totalBalance: 0n });
      mockPrisma.userSession.findMany.mockResolvedValue([{ id: 'session-1' }]);
      mockRedis.setex.mockRejectedValue(new Error('redis unavailable'));

      await expect(service.requestAccountDeletion('me', 'jti', 'pass')).resolves.toMatchObject({ message: expect.stringContaining('Account deletion requested') });
      expect(mockPrisma.user.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ isActive: false }) }));
    });
  });

  describe('device privacy and trust policy', () => {
    it('masks device IP addresses before returning them', async () => {
      mockPrisma.userDevice.findMany.mockResolvedValue([{ id: 'd1', deviceId: 'device-1', ipAddress: '10.20.30.40', isTrusted: false }]);
      mockPrisma.userDevice.count.mockResolvedValue(1);
      const result = await service.getMyDevices('me', 1, 20) as any;
      expect(result.devices[0].ipAddress).toBe('10.20.***.***');
    });

    it('uses configured trusted-device expiry rather than a stale hard-coded value', () => {
      mockConfig.get.mockImplementation((key: string) => key === 'app.trustedDeviceDays' ? 1 : undefined);
      expect(service.isDeviceTrustValid(new Date(Date.now() - 23 * 60 * 60 * 1000))).toBe(true);
      expect(service.isDeviceTrustValid(new Date(Date.now() - 25 * 60 * 60 * 1000))).toBe(false);
    });

    it('normalizes invalid device pagination', async () => {
      mockPrisma.userDevice.findMany.mockResolvedValue([]);
      mockPrisma.userDevice.count.mockResolvedValue(0);
      const result = await service.getMyDevices('me', -1, 0) as any;
      expect(mockPrisma.userDevice.findMany).toHaveBeenCalledWith(expect.objectContaining({ skip: 0, take: 1 }));
      expect(result.meta).toMatchObject({ page: 1, limit: 1 });
    });
  });

  describe('pagination and account-status hardening', () => {
    it('normalizes activity-log pagination before querying Prisma', async () => {
      mockPrisma.auditLog.findMany.mockResolvedValue([]);
      mockPrisma.auditLog.count.mockResolvedValue(0);
      const result: any = await service.getActivityLog('me', -3, 0);
      expect(mockPrisma.auditLog.findMany).toHaveBeenCalledWith(expect.objectContaining({ skip: 0, take: 1 }));
      expect(result).toMatchObject({ page: 1, limit: 1, totalPages: 0 });
    });

    it('normalizes public follower pagination before querying Prisma', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({ id: 'owner', profileVisible: true, isActive: true, isBanned: false, deletedAt: null });
      mockPrisma.follow.findMany.mockResolvedValue([]);
      mockPrisma.follow.count.mockResolvedValue(0);
      const result: any = await service.getFollowers('owner', -2, 0);
      expect(mockPrisma.follow.findMany).toHaveBeenCalledWith(expect.objectContaining({ skip: 0, take: 1 }));
      expect(result).toMatchObject({ page: 1, limit: 1 });
    });

    it('does not expose an inactive public profile', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({ id: 'owner', profileVisible: true, isActive: false, isBanned: false, deletedAt: null });
      await expect(service.getPublicProfile('owner')).rejects.toThrow(NotFoundException);
    });

    it('does not expose showcase for a banned user', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({ id: 'owner', profileVisible: true, isActive: true, isBanned: true, deletedAt: null });
      await expect(service.getShowcaseByUsername('owner')).rejects.toThrow(NotFoundException);
      expect(mockPrisma.userShowcase.findMany).not.toHaveBeenCalled();
    });
  });

  describe('public relationship privacy', () => {
    it('does not expose followers of a private profile to anonymous viewers', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({ id: 'owner', profileVisible: false });
      await expect(service.getFollowers('private-user', 1, 20)).rejects.toThrow(NotFoundException);
      expect(mockPrisma.follow.findMany).not.toHaveBeenCalled();
    });

    it('does not expose following of a profile across a block relationship', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({ id: 'owner', profileVisible: true });
      mockPrisma.blockList.findFirst.mockResolvedValue({ id: 'block-1' });
      await expect(service.getFollowing('owner', 1, 20, 'viewer')).rejects.toThrow(NotFoundException);
      expect(mockPrisma.follow.findMany).not.toHaveBeenCalled();
    });

    it('does not expose ratings of a private profile to anonymous viewers', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({ id: 'target-id', profileVisible: false });
      await expect(service.getUserRatings('target', 1, 10, undefined, undefined)).rejects.toThrow(NotFoundException);
      expect(mockPrisma.rating.findMany).not.toHaveBeenCalled();
    });

    it('returns public ratings with a minimal presenter-safe projection', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({ id: 'target', averageRating: 4.5, profileVisible: true, isActive: true, isBanned: false, deletedAt: null });
      mockPrisma.rating.findMany.mockResolvedValue([]);
      mockPrisma.rating.count.mockResolvedValue(0);

      await service.getUserRatings('public-user', 1, 20, undefined, 'viewer');
      expect(mockPrisma.rating.findMany).toHaveBeenCalledWith(expect.objectContaining({
        select: expect.objectContaining({ id: true, stars: true, comment: true, createdAt: true }),
      }));
      const call = mockPrisma.rating.findMany.mock.calls.at(-1)[0];
      expect(call.select.giverId).toBeUndefined();
      expect(call.select.orderId).toBeUndefined();
    });

    it('rejects an unknown public ratings filter', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({ id: 'target', averageRating: 4.5, profileVisible: true, isActive: true, isBanned: false, deletedAt: null });

      await expect(service.getUserRatings('public-user', 1, 20, 'anything-else', 'viewer')).rejects.toThrow(BadRequestException);
      expect(mockPrisma.rating.findMany).not.toHaveBeenCalled();
    });

    it('does not expose showcase across a block relationship', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({ id: 'target-id', profileVisible: true });
      mockPrisma.blockList.findUnique.mockResolvedValue({ id: 'block-1' });
      await expect(service.getShowcaseByUsername('target', 'viewer-id')).rejects.toThrow(NotFoundException);
      expect(mockPrisma.userShowcase.findMany).not.toHaveBeenCalled();
    });
  });

  describe('trusted-device factor preservation', () => {
    it('does not consume or verify TOTP for an already-trusted device no-op', async () => {
      const passwordHash = await bcryptHash('Password123!', 12);
      mockPrisma.user.findUnique.mockResolvedValue({ password: passwordHash });
      mockPrisma.userDevice.findFirst.mockResolvedValue({ id: 'device-1', isTrusted: true });
      mockPrisma.twoFactorAuth.findUnique.mockResolvedValue({ isEnabled: true, secret: 'unused' });

      await expect(service.setDeviceTrust('user-1', 'device-1', true, 'Password123!', '123456'))
        .resolves.toEqual({ message: 'Device is already trusted' });
      expect(mockPrisma.twoFactorAuth.findUnique).not.toHaveBeenCalled();
      expect(mockRedis.getClient).not.toHaveBeenCalled();
    });
  });

  describe('deleteHeader', () => {
    it('skips R2 deletion when no header set', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({ headerUrl: null });
      mockPrisma.user.update.mockResolvedValue({});
      const res = await service.deleteHeader('me');
      expect(res.message).toContain('deleted');
    });

    it('clears headerUrl even when bucket not configured', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({ headerUrl: 'http://x/h.png' });
      mockConfig.get.mockReturnValue(null);
      mockPrisma.user.update.mockResolvedValue({});
      const res = await service.deleteHeader('me');
      expect(mockPrisma.user.update).toHaveBeenCalledWith(expect.objectContaining({
        data: { headerUrl: null },
      }));
      expect(res.message).toContain('deleted');
    });
  });
});
