import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, ConflictException } from '@nestjs/common';
import { KycStatus, UserAuditAction } from '@prisma/client';
import { KycService } from '../kyc.service';
import { PrismaService } from '../../../prisma/prisma.service';
import { AuditLogService } from '../../../common/services/audit-log.service';
import { WalletTxSerialService } from '../../../common/services/wallet-tx-serial.service';
import { UploadService } from '../../upload/upload.service';

jest.mock('../../../common/utils/crypto.util', () => ({
  encryptAES: jest.fn().mockResolvedValue('encrypted'),
  decryptAES: jest.fn().mockResolvedValue('decrypted'),
  encryptKycNik: jest.fn().mockResolvedValue('encrypted-nik'),
  encryptKycKtp: jest.fn().mockResolvedValue('encrypted-ktp'),
  encryptKycSelfie: jest.fn().mockResolvedValue('encrypted-selfie'),
  argon2HashNik: jest.fn().mockResolvedValue('nik-hash'),
  hmacSHA256: jest.fn().mockReturnValue('nik-hash-legacy'),
}));

const userId = 'user-001';
const ktpFileKey = `uploads/kyc-ktp/${userId}/1234-ktp.jpg`;
const selfieFileKey = `uploads/kyc-selfie/${userId}/1234-selfie.jpg`;
const nik = '1234567890123456';

const mockPrisma = {
  user: {
    findUnique: jest.fn(),
    update: jest.fn(),
  },
  kycRequest: {
    findFirst: jest.fn(),
    findMany: jest.fn(),
    findUnique: jest.fn(),
    count: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    updateMany: jest.fn(),
  },
  $transaction: jest.fn(),
};

const mockAuditLog = {
  logUserAction: jest.fn(),
};

const mockSerial = {
  getNextForPrefix: jest.fn().mockResolvedValue(1),
};

const mockUpload = {
  isConfirmedUploadKey: jest.fn(),
};

describe('KycService', () => {
  let service: KycService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        KycService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: AuditLogService, useValue: mockAuditLog },
        { provide: WalletTxSerialService, useValue: mockSerial },
        { provide: UploadService, useValue: mockUpload },
      ],
    }).compile();

    service = module.get<KycService>(KycService);

    jest.clearAllMocks();

    // Default: upload keys are confirmed
    mockUpload.isConfirmedUploadKey.mockResolvedValue(true);
    // Default policy: phone verification enables KYC onboarding; email is recovery-only.
    mockPrisma.user.findUnique.mockResolvedValue({ phoneVerified: true, emailVerified: false });
    mockPrisma.kycRequest.findMany.mockResolvedValue([]);
  });

  describe('submit()', () => {
    it('should allow a phone-verified user even when email is not verified', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({ phoneVerified: true, emailVerified: false });
      mockPrisma.kycRequest.findFirst.mockResolvedValueOnce(null);

      mockPrisma.$transaction.mockImplementation(async (fn: (tx: typeof mockPrisma) => Promise<unknown>) => {
        mockPrisma.kycRequest.findFirst
          .mockResolvedValueOnce(null)
          .mockResolvedValueOnce(null);
        mockPrisma.kycRequest.findUnique.mockResolvedValueOnce(null);
        mockPrisma.kycRequest.count.mockResolvedValueOnce(0);
        mockPrisma.kycRequest.create.mockResolvedValueOnce({
          id: 'kyc-001',
          kycId: 'KYC001',
          status: KycStatus.PENDING,
          attemptNumber: 1,
          createdAt: new Date(),
        });
        mockPrisma.user.update.mockResolvedValueOnce({});
        return fn(mockPrisma);
      });

      await expect(service.submit(userId, ktpFileKey, selfieFileKey, nik)).resolves.toMatchObject({
        status: KycStatus.PENDING,
      });
    });

    it('should throw PHONE_NOT_VERIFIED if phone is not verified', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({ phoneVerified: false, emailVerified: true });

      await expect(
        service.submit(userId, ktpFileKey, selfieFileKey, nik),
      ).rejects.toMatchObject({ response: { code: 'PHONE_NOT_VERIFIED' } });
    });

    it('should throw if upload keys are not confirmed', async () => {
      mockUpload.isConfirmedUploadKey.mockResolvedValue(false);

      await expect(
        service.submit(userId, ktpFileKey, selfieFileKey, nik),
      ).rejects.toMatchObject({
        response: { code: 'UPLOAD_NOT_CONFIRMED' },
      });
    });

    it('should succeed for a first-time submission', async () => {
      mockPrisma.kycRequest.findFirst.mockResolvedValueOnce(null); // no prior KYC

      mockPrisma.$transaction.mockImplementation(async (fn: (tx: typeof mockPrisma) => Promise<unknown>) => {
        mockPrisma.kycRequest.findFirst
          .mockResolvedValueOnce(null)  // no PENDING
          .mockResolvedValueOnce(null); // no APPROVED
        mockPrisma.kycRequest.findUnique.mockResolvedValueOnce(null); // NIK not taken
        mockPrisma.kycRequest.count.mockResolvedValueOnce(0);
        mockPrisma.kycRequest.create.mockResolvedValueOnce({
          id: 'kyc-001',
          kycId: 'KYC001',
          status: KycStatus.PENDING,
          attemptNumber: 1,
          createdAt: new Date(),
        });
        mockPrisma.user.update.mockResolvedValueOnce({});
        return fn(mockPrisma);
      });

      const result = await service.submit(userId, ktpFileKey, selfieFileKey, nik);
      expect(result).toMatchObject({ status: KycStatus.PENDING });
    });

    it('should block a REJECTED user from bypassing cooldown via submit()', async () => {
      const rejectedAt = new Date(Date.now() - 2 * 3_600_000); // 2 hours ago (< 24h)
      // Pre-transaction REJECTED check returns the rejected record
      mockPrisma.kycRequest.findFirst.mockResolvedValueOnce({
        status: KycStatus.REJECTED,
        reviewedAt: rejectedAt,
      });

      await expect(
        service.submit(userId, ktpFileKey, selfieFileKey, nik),
      ).rejects.toMatchObject({
        response: { code: 'KYC_COOLDOWN_ACTIVE' },
      });
    });

    it('should block a REJECTED user even after cooldown via submit() — must use resubmit()', async () => {
      const rejectedAt = new Date(Date.now() - 25 * 3_600_000); // 25 hours ago (> 24h)
      // Pre-transaction REJECTED check returns the rejected record (cooldown expired)
      mockPrisma.kycRequest.findFirst.mockResolvedValueOnce({
        status: KycStatus.REJECTED,
        reviewedAt: rejectedAt,
      });

      await expect(
        service.submit(userId, ktpFileKey, selfieFileKey, nik),
      ).rejects.toMatchObject({
        response: { code: 'KYC_USE_RESUBMIT' },
      });
    });

    it('should block a REVOKED user — REVOKED is a terminal state', async () => {
      mockPrisma.kycRequest.findFirst.mockResolvedValueOnce({
        status: 'REVOKED',
        reviewedAt: null,
      });

      await expect(
        service.submit(userId, ktpFileKey, selfieFileKey, nik),
      ).rejects.toMatchObject({
        response: { code: 'KYC_REVOKED' },
      });
    });

    it('should throw KYC_ALREADY_PENDING if a pending request exists', async () => {
      // Pre-flight check finds PENDING status — throws before encryption
      mockPrisma.kycRequest.findFirst.mockResolvedValueOnce({
        status: KycStatus.PENDING,
        reviewedAt: null,
      });

      await expect(
        service.submit(userId, ktpFileKey, selfieFileKey, nik),
      ).rejects.toMatchObject({
        response: { code: 'KYC_ALREADY_PENDING' },
      });
    });

    it('should throw KYC_ALREADY_APPROVED if already approved', async () => {
      // Pre-flight check finds APPROVED status — throws before encryption
      mockPrisma.kycRequest.findFirst.mockResolvedValueOnce({
        status: KycStatus.APPROVED,
        reviewedAt: null,
      });

      await expect(
        service.submit(userId, ktpFileKey, selfieFileKey, nik),
      ).rejects.toMatchObject({
        response: { code: 'KYC_ALREADY_APPROVED' },
      });
    });
  });

  describe('resubmit()', () => {
    it('should throw PHONE_NOT_VERIFIED if phone is not verified on resubmit', async () => {
      mockPrisma.user.findUnique.mockResolvedValueOnce({ phoneVerified: false, emailVerified: true });

      await expect(
        service.resubmit(userId, ktpFileKey, selfieFileKey, nik),
      ).rejects.toMatchObject({ response: { code: 'PHONE_NOT_VERIFIED' } });
    });

    it('should block a REVOKED user — REVOKED is terminal, not resubmittable', async () => {
      mockPrisma.kycRequest.findFirst.mockResolvedValueOnce({
        id: 'kyc-001',
        status: 'REVOKED',
        reviewedAt: null,
      });

      await expect(
        service.resubmit(userId, ktpFileKey, selfieFileKey, nik),
      ).rejects.toMatchObject({
        response: { code: 'KYC_REVOKED' },
      });
    });

    it('should throw if no rejected request exists', async () => {
      mockPrisma.kycRequest.findFirst.mockResolvedValueOnce(null);

      await expect(
        service.resubmit(userId, ktpFileKey, selfieFileKey, nik),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('should throw KYC_COOLDOWN_ACTIVE within 24h of rejection', async () => {
      const rejectedAt = new Date(Date.now() - 3 * 3_600_000); // 3 hours ago
      mockPrisma.kycRequest.findFirst.mockResolvedValueOnce({
        id: 'kyc-001',
        status: KycStatus.REJECTED,
        reviewedAt: rejectedAt,
      });

      await expect(
        service.resubmit(userId, ktpFileKey, selfieFileKey, nik),
      ).rejects.toMatchObject({
        response: { code: 'KYC_COOLDOWN_ACTIVE' },
      });
    });

    it('should throw UPLOAD_NOT_CONFIRMED if files not confirmed', async () => {
      const rejectedAt = new Date(Date.now() - 25 * 3_600_000); // 25 hours ago
      mockPrisma.kycRequest.findFirst.mockResolvedValueOnce({
        id: 'kyc-001',
        status: KycStatus.REJECTED,
        reviewedAt: rejectedAt,
      });
      mockUpload.isConfirmedUploadKey.mockResolvedValue(false);

      await expect(
        service.resubmit(userId, ktpFileKey, selfieFileKey, nik),
      ).rejects.toMatchObject({
        response: { code: 'UPLOAD_NOT_CONFIRMED' },
      });
    });

    it('should succeed after cooldown with confirmed files', async () => {
      const rejectedAt = new Date(Date.now() - 25 * 3_600_000); // 25 hours ago
      const updatedKyc = {
        id: 'kyc-001',
        kycId: 'KYC001',
        status: KycStatus.PENDING,
        attemptNumber: 2,
        createdAt: new Date(),
      };

      mockPrisma.kycRequest.findFirst.mockResolvedValueOnce({
        id: 'kyc-001',
        status: KycStatus.REJECTED,
        reviewedAt: rejectedAt,
      });

      mockPrisma.$transaction.mockImplementation(async (fn: (tx: typeof mockPrisma) => Promise<unknown>) => {
        mockPrisma.kycRequest.count.mockResolvedValueOnce(1);
        mockPrisma.kycRequest.findFirst
          .mockResolvedValueOnce(null) // no concurrent PENDING
          .mockResolvedValueOnce(null) // no concurrent APPROVED
          .mockResolvedValueOnce(null) // no existing NIK owner
          .mockResolvedValueOnce({ id: 'kyc-001', status: KycStatus.REJECTED }); // locked row found
        mockPrisma.kycRequest.create.mockResolvedValueOnce(updatedKyc);
        mockPrisma.user.update.mockResolvedValueOnce({});
        return fn(mockPrisma);
      });

      const result = await service.resubmit(userId, ktpFileKey, selfieFileKey, nik);
      expect(result).toMatchObject({ status: KycStatus.PENDING });
    });

    it('should throw KYC_STATE_CHANGED when concurrent resubmit wins the race', async () => {
      const rejectedAt = new Date(Date.now() - 25 * 3_600_000); // 25 hours ago
      mockPrisma.kycRequest.findFirst.mockResolvedValueOnce({
        id: 'kyc-001',
        status: KycStatus.REJECTED,
        reviewedAt: rejectedAt,
      });

      mockPrisma.$transaction.mockImplementation(async (fn: (tx: typeof mockPrisma) => Promise<unknown>) => {
        mockPrisma.kycRequest.count.mockResolvedValueOnce(1);
        mockPrisma.kycRequest.findFirst
          .mockResolvedValueOnce(null) // no concurrent PENDING
          .mockResolvedValueOnce(null) // no concurrent APPROVED
          .mockResolvedValueOnce(null) // no existing NIK owner
          .mockResolvedValueOnce(null); // locked row not found — concurrent winner
        return fn(mockPrisma);
      });

      await expect(
        service.resubmit(userId, ktpFileKey, selfieFileKey, nik),
      ).rejects.toBeInstanceOf(ConflictException);
    });
  });

  describe('getStatus()', () => {
    it('should return UNVERIFIED when no request exists', async () => {
      mockPrisma.kycRequest.findFirst.mockResolvedValueOnce(null);
      const result = await service.getStatus(userId);
      expect(result).toMatchObject({ status: KycStatus.UNVERIFIED, latestRequest: null });
    });

    it('should return latestRequest with status', async () => {
      const mockRequest = {
        kycId: 'KYC001',
        status: KycStatus.PENDING,
        rejectionReason: null,
        attemptNumber: 1,
        createdAt: new Date(),
        reviewedAt: null,
      };
      mockPrisma.kycRequest.findFirst.mockResolvedValueOnce(mockRequest);
      const result = await service.getStatus(userId);
      expect(result).toMatchObject({ status: KycStatus.PENDING });
    });
  });
});
