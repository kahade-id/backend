import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { AdminUsersService } from '../admin-users.service';
import { PrismaService } from '../../../../prisma/prisma.service';
import { RedisService } from '../../../../redis/redis.service';
import { AuditLogService } from '../../../../common/services/audit-log.service';
import { WalletTxSerialService } from '../../../../common/services/wallet-tx-serial.service';
import { OtpService } from '../../../auth/otp.service';
import { EMAIL_QUEUE } from '../../../queue/processors/email.processor';

jest.mock('../../../../common/utils/pii.util', () => ({
  decryptPiiSafe: jest.fn(async (value: string | null) => value),
  encryptPii: jest.fn(async (value: string) => value),
  hashPhoneNumber: jest.fn(async (value: string) => `h:${value}`),
  normalizePhoneNumber: jest.fn((value: string) => value),
}));

const ADMIN_ID = 'admin-1';
const FLAGGED_AT = new Date('2026-09-12T00:00:00.000Z');

const mockPrisma: any = {
  user: { findFirst: jest.fn(), findMany: jest.fn(), count: jest.fn(), update: jest.fn(), updateMany: jest.fn() },
  userSession: { findMany: jest.fn(), updateMany: jest.fn() },
};
const mockRedis = { setex: jest.fn(), get: jest.fn(), del: jest.fn() };
const mockConfig = { get: jest.fn(() => '15m') };
const mockAudit = { logAdminAction: jest.fn() };
const mockSerial = { next: jest.fn() };
const mockOtp = { generate: jest.fn() };
const mockEmailQueue = { add: jest.fn() };

describe('AdminUsersService — siklus hidup flaggedForReview (Section 6)', () => {
  let service: AdminUsersService;

  beforeEach(async () => {
    jest.clearAllMocks();
    mockPrisma.user.findFirst.mockResolvedValue({
      id: 'user-1', userId: 'USR-1', flaggedForReview: true, flaggedForReviewAt: FLAGGED_AT, isBanned: false,
    });
    mockPrisma.user.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.user.update.mockImplementation(async (args: any) => ({ userId: 'USR-1', ...args.data }));
    mockPrisma.userSession.findMany.mockResolvedValue([]);
    mockRedis.setex.mockResolvedValue('OK');

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AdminUsersService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: RedisService, useValue: mockRedis },
        { provide: ConfigService, useValue: mockConfig },
        { provide: AuditLogService, useValue: mockAudit },
        { provide: WalletTxSerialService, useValue: mockSerial },
        { provide: OtpService, useValue: mockOtp },
        { provide: `BullQueue_${EMAIL_QUEUE}`, useValue: mockEmailQueue },
      ],
    }).compile();
    service = module.get<AdminUsersService>(AdminUsersService);
  });

  describe('clearReviewFlag', () => {
    it('clears the flag and records who cleared it', async () => {
      await expect(service.clearReviewFlag('user-1', ADMIN_ID, '1.2.3.4')).resolves.toEqual({
        message: 'Review flag cleared',
        userId: 'USR-1',
        flaggedForReview: false,
      });
      expect(mockPrisma.user.updateMany).toHaveBeenCalledWith({
        where: { id: 'user-1', flaggedForReview: true },
        data: { flaggedForReview: false, flaggedForReviewAt: null },
      });
      expect(mockAudit.logAdminAction).toHaveBeenCalledWith(
        expect.objectContaining({
          adminId: ADMIN_ID,
          targetType: 'User',
          targetId: 'user-1',
          ipAddress: '1.2.3.4',
          before: { flaggedForReview: true, flaggedForReviewAt: FLAGGED_AT },
          after: { flaggedForReview: false, flaggedForReviewAt: null },
        }),
      );
    });

    it('accepts either the internal id or the public userId', async () => {
      await service.clearReviewFlag('USR-1', ADMIN_ID);
      expect(mockPrisma.user.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({ where: { OR: [{ id: 'USR-1' }, { userId: 'USR-1' }], deletedAt: null } }),
      );
    });

    it('returns 404 for an unknown or soft-deleted user', async () => {
      mockPrisma.user.findFirst.mockResolvedValue(null);
      await expect(service.clearReviewFlag('ghost', ADMIN_ID)).rejects.toThrow(NotFoundException);
      expect(mockPrisma.user.updateMany).not.toHaveBeenCalled();
    });

    it('returns 400 when the user was never flagged', async () => {
      mockPrisma.user.findFirst.mockResolvedValue({ id: 'user-1', userId: 'USR-1', flaggedForReview: false, flaggedForReviewAt: null, isBanned: false });
      await expect(service.clearReviewFlag('user-1', ADMIN_ID)).rejects.toThrow(BadRequestException);
      expect(mockPrisma.user.updateMany).not.toHaveBeenCalled();
      expect(mockAudit.logAdminAction).not.toHaveBeenCalled();
    });

    it('returns 409 when a second admin cleared it first', async () => {
      mockPrisma.user.updateMany.mockResolvedValue({ count: 0 });
      await expect(service.clearReviewFlag('user-1', ADMIN_ID)).rejects.toThrow(ConflictException);
      expect(mockAudit.logAdminAction).not.toHaveBeenCalled();
    });

    it('takes no other action against the user', async () => {
      await service.clearReviewFlag('user-1', ADMIN_ID);
      // "NO auto-ban" berlaku dua arah: menghapus flag juga tidak boleh
      // ikut-ikutan mengubah status akun.
      const data = mockPrisma.user.updateMany.mock.calls[0][0].data;
      expect(Object.keys(data).sort()).toEqual(['flaggedForReview', 'flaggedForReviewAt']);
      expect(mockPrisma.userSession.updateMany).not.toHaveBeenCalled();
    });
  });

  describe('flag cleared by a sanction', () => {
    it('is removed when the admin bans the flagged user', async () => {
      await service.banUser('user-1', 'Fraud confirmed', ADMIN_ID, '1.2.3.4');
      expect(mockPrisma.user.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ isBanned: true, flaggedForReview: false, flaggedForReviewAt: null }),
        }),
      );
    });

    it('is removed when the admin unbans the user after an appeal', async () => {
      mockPrisma.user.findFirst.mockResolvedValue({ id: 'user-1', userId: 'USR-1', isBanned: true, flaggedForReview: true });
      await service.unbanUser('user-1', ADMIN_ID, '1.2.3.4');
      expect(mockPrisma.user.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ isBanned: false, flaggedForReview: false, flaggedForReviewAt: null }),
        }),
      );
    });
  });

  describe('moderation queue surface', () => {
    beforeEach(() => {
      mockPrisma.user.findMany.mockResolvedValue([]);
      mockPrisma.user.count.mockResolvedValue(0);
    });

    it('exposes a status=flagged filter for the review queue', async () => {
      await service.listUsers(1, 20, undefined, 'flagged');
      expect(mockPrisma.user.findMany.mock.calls[0][0].where.flaggedForReview).toBe(true);
      expect(mockPrisma.user.count.mock.calls[0][0].where.flaggedForReview).toBe(true);
    });

    it('does not filter on the flag for other statuses', async () => {
      await service.listUsers(1, 20, undefined, 'banned');
      expect(mockPrisma.user.findMany.mock.calls[0][0].where.flaggedForReview).toBeUndefined();
      expect(mockPrisma.user.findMany.mock.calls[0][0].where.isBanned).toBe(true);
    });

    it('returns the flag fields in the list projection', async () => {
      await service.listUsers(1, 20);
      const select = mockPrisma.user.findMany.mock.calls[0][0].select;
      expect(select.flaggedForReview).toBe(true);
      expect(select.flaggedForReviewAt).toBe(true);
    });

    it('returns the flag fields in the detail projection', async () => {
      mockPrisma.user.findFirst.mockResolvedValue({
        id: 'user-1',
        userId: 'USR-1',
        email: 'user@example.com',
        phoneNumber: null,
        flaggedForReview: true,
        flaggedForReviewAt: FLAGGED_AT,
        wallet: null,
        _count: { followers: 0, following: 0, blockedUsers: 0, reportsReceived: 4 },
      });
      const detail = (await service.getUserDetail('user-1', ADMIN_ID, '1.2.3.4')) as Record<string, unknown>;
      const select = mockPrisma.user.findFirst.mock.calls[0][0].select;
      expect(select.flaggedForReview).toBe(true);
      expect(select.flaggedForReviewAt).toBe(true);
      // Flag ikut terbawa ke payload detail supaya admin tahu kenapa user ini
      // masuk antrean, bersamaan dengan jumlah laporan yang diterimanya.
      expect(detail.flaggedForReview).toBe(true);
      expect(detail.flaggedForReviewAt).toEqual(FLAGGED_AT);
      expect(detail.reportsReceivedCount).toBe(4);
    });
  });
});
