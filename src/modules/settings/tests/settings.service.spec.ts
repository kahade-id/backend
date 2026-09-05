import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { NotFoundException, BadRequestException, ConflictException } from '@nestjs/common';
import { SettingsService } from '../settings.service';
import { PrismaService } from '../../../prisma/prisma.service';
import { AuditLogService } from '../../../common/services/audit-log.service';
import { RedisService } from '../../../redis/redis.service';
import { UploadService } from '../../upload/upload.service';
import { NotificationQueueService } from '../../queue/notification-queue.service';

const mockPrisma = {
  blockList: { findMany: jest.fn(), count: jest.fn(), findUnique: jest.fn(), create: jest.fn(), delete: jest.fn() },
  follow: { deleteMany: jest.fn(), findMany: jest.fn() },
  userFavorite: { deleteMany: jest.fn(), findMany: jest.fn() },
  userSavedProfile: { deleteMany: jest.fn(), findMany: jest.fn() },
  user: { findUnique: jest.fn(), update: jest.fn() },
  userReport: { findFirst: jest.fn(), create: jest.fn(), findMany: jest.fn(), count: jest.fn() },
  order: { findUnique: jest.fn() },
  userSession: { findMany: jest.fn() },
  userDevice: { findMany: jest.fn() },
  bankAccount: { findMany: jest.fn() },
  userLink: { findMany: jest.fn() },
  userBadge: { findMany: jest.fn() },
  notificationPreference: { findUnique: jest.fn() },
  $transaction: jest.fn(),
};
const mockAudit = { logUserAction: jest.fn() };
const mockRedis = { get: jest.fn(), set: jest.fn(), setex: jest.fn(), setNx: jest.fn(), releaseLock: jest.fn() };
const mockConfig = { get: jest.fn() };
const mockUpload = { uploadPrivateAccountExport: jest.fn() };
const mockNotification = { enqueue: jest.fn() };
const mockEmailQueue = { add: jest.fn() };

describe('SettingsService', () => {
  let service: SettingsService;

  beforeEach(async () => {
    jest.resetAllMocks();
    mockRedis.setNx.mockResolvedValue(true);
    mockRedis.releaseLock.mockResolvedValue(true);
    mockPrisma.$transaction.mockImplementation(async (callback: (tx: typeof mockPrisma) => Promise<unknown>) => callback(mockPrisma));
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SettingsService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: AuditLogService, useValue: mockAudit },
        { provide: RedisService, useValue: mockRedis },
        { provide: ConfigService, useValue: mockConfig },
        { provide: UploadService, useValue: mockUpload },
        { provide: NotificationQueueService, useValue: mockNotification },
        { provide: 'BullQueue_email', useValue: mockEmailQueue },
      ],
    }).compile();
    service = module.get<SettingsService>(SettingsService);
  });

  it('should be defined', () => expect(service).toBeDefined());

  describe('blockUser', () => {
    it('throws when blocking self', async () => {
      await expect(service.blockUser('u1', 'u1')).rejects.toThrow(BadRequestException);
    });

    it('throws when target missing', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(null);
      await expect(service.blockUser('u1', 'u2')).rejects.toThrow(NotFoundException);
    });

    it('throws when already blocked', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({ id: 'u2' });
      mockPrisma.blockList.findUnique.mockResolvedValue({ id: 'b1' });
      await expect(service.blockUser('u1', 'u2')).rejects.toThrow(ConflictException);
    });

    it('creates block, cleans social relations, and logs audit', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({ id: 'u2' });
      mockPrisma.$transaction.mockImplementation(async (callback: (tx: typeof mockPrisma) => Promise<unknown>) => callback(mockPrisma));
      mockPrisma.blockList.findUnique.mockResolvedValue(null);
      mockPrisma.blockList.create.mockResolvedValue({ id: 'b1' });
      const res = await service.blockUser('u1', 'u2');
      expect(res.message).toContain('blocked');
      expect(mockPrisma.follow.deleteMany).toHaveBeenCalled();
      expect(mockPrisma.userFavorite.deleteMany).toHaveBeenCalled();
      expect(mockPrisma.userSavedProfile.deleteMany).toHaveBeenCalled();
      expect(mockAudit.logUserAction).toHaveBeenCalled();
    });
  });

  describe('unblockUser', () => {
    it('throws when not blocked', async () => {
      mockPrisma.blockList.findUnique.mockResolvedValue(null);
      await expect(service.unblockUser('u1', 'u2')).rejects.toThrow(NotFoundException);
    });

    it('deletes block and logs', async () => {
      mockPrisma.blockList.findUnique.mockResolvedValue({ id: 'b1' });
      mockPrisma.blockList.delete.mockResolvedValue({});
      const res = await service.unblockUser('u1', 'u2');
      expect(res.message).toContain('unblocked');
    });
  });

  describe('listBlockedUsers', () => {
    it('returns paginated list', async () => {
      mockPrisma.blockList.findMany.mockResolvedValue([]);
      mockPrisma.blockList.count.mockResolvedValue(0);
      const res = await service.listBlockedUsers('u1', 1, 10);
      expect(res.total).toBe(0);
    });
  });

  describe('reportUser', () => {
    it('throws when reporting self', async () => {
      await expect(service.reportUser('u1', { targetId: 'u1', category: 'SPAM', description: 'x' } as any)).rejects.toThrow(BadRequestException);
    });

    it('throws when target missing', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(null);
      await expect(service.reportUser('u1', { targetId: 'u2', category: 'SPAM', description: 'x' } as any)).rejects.toThrow(NotFoundException);
    });

    it('rejects a related order that does not include both reporter and target', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({ id: 'u2' });
      mockPrisma.order.findUnique.mockResolvedValue({ buyerId: 'unrelated-buyer', sellerId: 'unrelated-seller' });
      await expect(service.reportUser('u1', {
        targetId: 'u2', category: 'SPAM', description: 'This report has enough context to be valid.', relatedOrderId: 'order-1',
      } as any)).rejects.toMatchObject({ response: { code: 'ORDER_NOT_FOUND' } });
      expect(mockPrisma.userReport.create).not.toHaveBeenCalled();
    });

    it('throws on rate limit', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({ id: 'u2' });
      mockPrisma.userReport.findFirst.mockResolvedValue({ id: 'r0' });
      await expect(service.reportUser('u1', { targetId: 'u2', category: 'SPAM', description: 'x' } as any)).rejects.toThrow(BadRequestException);
      expect(mockRedis.releaseLock).toHaveBeenCalledWith(expect.stringContaining('user-report:cooldown:u1:u2'), expect.any(String));
    });

    it('rejects a concurrent report while the Redis cooldown lock is held', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({ id: 'u2' });
      mockPrisma.userReport.findFirst.mockResolvedValue(null);
      mockRedis.setNx.mockResolvedValue(false);
      await expect(service.reportUser('u1', { targetId: 'u2', category: 'SPAM', description: 'x' } as any)).rejects.toMatchObject({ response: { code: 'RATE_LIMIT_EXCEEDED' } });
      expect(mockPrisma.userReport.create).not.toHaveBeenCalled();
    });

    it('releases the report cooldown if database creation fails', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({ id: 'u2' });
      mockPrisma.userReport.findFirst.mockResolvedValue(null);
      mockPrisma.userReport.create.mockRejectedValue(new Error('database unavailable'));
      await expect(service.reportUser('u1', { targetId: 'u2', category: 'SPAM', description: 'x' } as any)).rejects.toThrow('database unavailable');
      expect(mockRedis.releaseLock).toHaveBeenCalledWith(expect.stringContaining('user-report:cooldown:u1:u2'), expect.any(String));
    });

    it('releases the report cooldown if the recent-report lookup fails', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({ id: 'u2' });
      mockPrisma.userReport.findFirst.mockRejectedValue(new Error('database unavailable'));
      await expect(service.reportUser('u1', { targetId: 'u2', category: 'SPAM', description: 'x' } as any)).rejects.toThrow('database unavailable');
      expect(mockRedis.releaseLock).toHaveBeenCalledWith(expect.stringContaining('user-report:cooldown:u1:u2'), expect.any(String));
    });

    it('rejects evidence URL with non-trusted host', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({ id: 'u2' });
      mockPrisma.userReport.findFirst.mockResolvedValue(null);
      mockConfig.get.mockReturnValue('https://kahade.r2.cloudflarestorage.com');
      await expect(service.reportUser('u1', {
        targetId: 'u2', category: 'SPAM', description: 'x',
        evidenceUrls: ['https://evil.example.com/file.png'],
      } as any)).rejects.toThrow(BadRequestException);
    });

    it('creates report when valid', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({ id: 'u2' });
      mockPrisma.userReport.findFirst.mockResolvedValue(null);
      mockPrisma.userReport.create.mockResolvedValue({ id: 'r1' });
      const res = await service.reportUser('u1', { targetId: 'u2', category: 'SPAM', description: 'x' } as any);
      expect(res.reportId).toBe('r1');
    });
  });

  describe('listMyReports', () => {
    it('paginates user reports', async () => {
      mockPrisma.userReport.findMany.mockResolvedValue([]);
      mockPrisma.userReport.count.mockResolvedValue(0);
      const res = await service.listMyReports('u1', 1, 10);
      expect(res.total).toBe(0);
    });
  });

  describe('privacy', () => {
    it('returns cached privacy settings when present', async () => {
      mockRedis.get.mockResolvedValue(JSON.stringify({ profileVisible: true, showOnlineStatus: false }));
      const res = await service.getPrivacySettings('u1');
      expect(res.showOnlineStatus).toBe(false);
      expect(mockPrisma.user.findUnique).not.toHaveBeenCalled();
    });

    it('falls back to DB on cache miss', async () => {
      mockRedis.get.mockResolvedValue(null);
      mockPrisma.user.findUnique.mockResolvedValue({ id: 'u1', profileVisible: true, showOnlineStatus: true });
      const res = await service.getPrivacySettings('u1');
      expect(res.profileVisible).toBe(true);
      expect(mockRedis.set).toHaveBeenCalled();
    });

    it('throws when user missing', async () => {
      mockRedis.get.mockResolvedValue(null);
      mockPrisma.user.findUnique.mockResolvedValue(null);
      await expect(service.getPrivacySettings('u1')).rejects.toThrow(NotFoundException);
    });

    it('updatePrivacySettings persists and caches', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({ id: 'u1', profileVisible: true, showOnlineStatus: true });
      mockPrisma.user.update.mockResolvedValue({});
      const res = await service.updatePrivacySettings('u1', { profileVisible: false });
      expect(res.profileVisible).toBe(false);
      expect(mockRedis.set).toHaveBeenCalled();
    });
  });

  describe('language', () => {
    it('returns cached language without hitting the database', async () => {
      mockRedis.get.mockResolvedValue('en');
      const res = await service.getLanguage('u1');
      expect(res.language).toBe('en');
      expect(mockPrisma.user.findUnique).not.toHaveBeenCalled();
    });

    it('reads language from User and backfills cache after a miss', async () => {
      mockRedis.get.mockResolvedValue(null);
      mockPrisma.user.findUnique.mockResolvedValue({ id: 'u1', language: 'en' });
      const res = await service.getLanguage('u1');
      expect(res.language).toBe('en');
      expect(mockRedis.setex).toHaveBeenCalledWith(expect.stringContaining('user_language:u1'), expect.any(Number), 'en');
    });

    it('persists language and caches it with 1y TTL', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({ id: 'u1' });
      mockPrisma.user.update.mockResolvedValue({});
      const res = await service.updateLanguage('u1', 'en');
      expect(res.language).toBe('en');
      expect(mockPrisma.user.update).toHaveBeenCalledWith({ where: { id: 'u1' }, data: { language: 'en' } });
      expect(mockRedis.setex).toHaveBeenCalled();
    });

    it('rejects an unsupported language', async () => {
      await expect(service.updateLanguage('u1', 'fr')).rejects.toMatchObject({ response: { code: 'VALIDATION_ERROR' } });
      expect(mockPrisma.user.findUnique).not.toHaveBeenCalled();
    });

    it('throws when user missing', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(null);
      await expect(service.updateLanguage('u1', 'en')).rejects.toThrow(NotFoundException);
    });
  });

  describe('requestDataExport', () => {
    const exportUser = {
      id: 'u1', userId: 'USR-1', username: 'alice', email: 'x@y', fullName: 'Alice', bio: 'Bio',
      avatarUrl: null, headerUrl: null, accountType: 'PERSONAL', phoneNumber: '+628123456789', phoneVerified: true,
      dateOfBirth: null, gender: null, address: null, emailVerified: true, emailVerifiedAt: null,
      kycStatus: 'UNVERIFIED', kycApprovedAt: null, isKahadePlus: false, subscriptionExpiresAt: null,
      profileVisible: true, showOnlineStatus: true, language: 'id', membershipRank: 'BRONZE',
      memberSince: new Date('2025-01-01'), createdAt: new Date('2025-01-01'), updatedAt: new Date('2025-01-02'),
    };

    beforeEach(() => {
      mockPrisma.userSession.findMany.mockResolvedValue([]);
      mockPrisma.userDevice.findMany.mockResolvedValue([]);
      mockPrisma.bankAccount.findMany.mockResolvedValue([]);
      mockPrisma.userLink.findMany.mockResolvedValue([]);
      mockPrisma.follow.findMany.mockResolvedValue([]);
      mockPrisma.userFavorite.findMany.mockResolvedValue([]);
      mockPrisma.userBadge.findMany.mockResolvedValue([]);
      mockPrisma.notificationPreference.findUnique.mockResolvedValue(null);
      mockPrisma.blockList.count.mockResolvedValue(0);
      mockPrisma.userReport.count.mockResolvedValue(0);
      mockRedis.setNx.mockResolvedValue(true);
      mockRedis.releaseLock.mockResolvedValue(true);
      mockUpload.uploadPrivateAccountExport.mockResolvedValue({ downloadUrl: 'https://private.example/export.json', expiresAt: new Date('2026-08-19T00:00:00.000Z') });
      mockEmailQueue.add.mockResolvedValue({});
      mockNotification.enqueue.mockResolvedValue(undefined);
    });

    it('throws on cooldown active using atomic setNx', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(exportUser);
      mockRedis.setNx.mockResolvedValue(false);
      await expect(service.requestDataExport('u1')).rejects.toThrow(BadRequestException);
      expect(mockRedis.get).not.toHaveBeenCalled();
      expect(mockUpload.uploadPrivateAccountExport).not.toHaveBeenCalled();
    });

    it('builds, uploads, emails, and notifies a sanitized export', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(exportUser);
      const res = await service.requestDataExport('u1');
      expect(res.message).toContain('siap diunduh');
      expect(res.downloadUrl).toBe('https://private.example/export.json');
      expect(res.expiresAt).toEqual(new Date('2026-08-19T00:00:00.000Z'));
      expect(mockRedis.setNx).toHaveBeenCalledWith(expect.stringContaining('data-export:cooldown:u1'), expect.any(String), 86400);
      expect(mockUpload.uploadPrivateAccountExport).toHaveBeenCalledWith('u1', expect.any(Buffer));
      expect(mockEmailQueue.add).toHaveBeenCalledWith('send', expect.objectContaining({ to: 'x@y', templateName: 'data-export', subject: 'Data Akun Kahade Anda' }));
      expect(mockNotification.enqueue).toHaveBeenCalledWith(expect.objectContaining({ userId: 'u1', type: 'DATA_EXPORT_READY', actionUrl: 'https://private.example/export.json' }));
    });

    it('releases the cooldown when artifact generation fails', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(exportUser);
      mockUpload.uploadPrivateAccountExport.mockRejectedValue(new Error('storage unavailable'));
      await expect(service.requestDataExport('u1')).rejects.toThrow('storage unavailable');
      expect(mockRedis.releaseLock).toHaveBeenCalledWith(expect.stringContaining('data-export:cooldown:u1'), expect.any(String));
    });
  });
});
