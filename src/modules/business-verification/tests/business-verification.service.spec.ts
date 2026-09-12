import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { BusinessVerificationStatus, UserAccountType } from '@prisma/client';
import { BusinessVerificationService } from '../business-verification.service';
import { SubmitBusinessVerificationDto } from '../dto/submit-business-verification.dto';
import { PrismaService } from '../../../prisma/prisma.service';
import { AuditLogService } from '../../../common/services/audit-log.service';
import { WalletTxSerialService } from '../../../common/services/wallet-tx-serial.service';
import { UploadService } from '../../upload/upload.service';
import { VerificationBadgeService } from '../../users/verification-badge.service';
import * as ErrorCodes from '../../../common/constants/error-codes';

jest.mock('../../../common/utils/crypto.util', () => ({
  encryptAES: jest.fn(async (value: string) => `enc:${value}`),
  decryptAES: jest.fn(async (value: string) => value.replace(/^enc:/, '')),
  hmacSHA256: jest.fn((value: string) => `hmac:${value}`),
}));

const userId = 'user-001';
const fileKey = `uploads/business-documents/${userId}/1700000000-abc-npwp.pdf`;

function dto(overrides: Partial<SubmitBusinessVerificationDto> = {}): SubmitBusinessVerificationDto {
  return {
    businessName: 'PT Kawal Hak Dengan Aman',
    npwpNumber: '01.234.567.8-901.000',
    deedNumber: 'AKTA-001',
    siupNumber: undefined,
    documentFileKeys: [fileKey],
    ...overrides,
  } as SubmitBusinessVerificationDto;
}

const mockPrisma: any = {
  user: { findFirst: jest.fn() },
  businessVerification: {
    findFirst: jest.fn(),
    findMany: jest.fn(),
    count: jest.fn(),
    create: jest.fn(),
  },
  $transaction: jest.fn(),
};

const mockAuditLog = { logUserAction: jest.fn() };
const mockSerial = { getNextForPrefix: jest.fn().mockResolvedValue(7) };
const mockUpload = { isConfirmedUploadKey: jest.fn() };
const mockBadges = { invalidate: jest.fn().mockResolvedValue(undefined) };

describe('BusinessVerificationService', () => {
  let service: BusinessVerificationService;

  beforeEach(async () => {
    // clearAllMocks (bukan resetAllMocks) supaya implementasi mock crypto.util
    // yang dideklarasikan di jest.mock() tetap ada.
    jest.clearAllMocks();
    // Default: akun BUSINESS yang sehat, belum pernah mengajukan, dokumen terkonfirmasi.
    mockPrisma.user.findFirst.mockResolvedValue({ accountType: UserAccountType.BUSINESS });
    mockPrisma.businessVerification.findFirst.mockResolvedValue(null);
    mockPrisma.businessVerification.count.mockResolvedValue(0);
    mockPrisma.businessVerification.findMany.mockResolvedValue([]);
    mockPrisma.businessVerification.create.mockResolvedValue({
      id: 'bv-1',
      verificationId: 'BIZ-20260912-000007-ABCD',
      status: BusinessVerificationStatus.PENDING,
      businessName: 'PT Kawal Hak Dengan Aman',
      deedNumber: 'AKTA-001',
      siupNumber: null,
      attemptNumber: 1,
      createdAt: new Date(),
    });
    mockPrisma.$transaction.mockImplementation(async (fn: any) => fn(mockPrisma));
    mockUpload.isConfirmedUploadKey.mockResolvedValue(true);
    mockSerial.getNextForPrefix.mockResolvedValue(7);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BusinessVerificationService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: AuditLogService, useValue: mockAuditLog },
        { provide: WalletTxSerialService, useValue: mockSerial },
        { provide: UploadService, useValue: mockUpload },
        { provide: VerificationBadgeService, useValue: mockBadges },
      ],
    }).compile();
    service = module.get<BusinessVerificationService>(BusinessVerificationService);
  });

  it('should be defined', () => expect(service).toBeDefined());

  describe('submit — eligibility', () => {
    it('rejects a PERSONAL account with BUSINESS_ACCOUNT_REQUIRED', async () => {
      mockPrisma.user.findFirst.mockResolvedValue({ accountType: UserAccountType.PERSONAL });
      await expect(service.submit(userId, dto())).rejects.toMatchObject({
        response: expect.objectContaining({ code: ErrorCodes.BUSINESS_ACCOUNT_REQUIRED }),
      });
      expect(mockPrisma.businessVerification.create).not.toHaveBeenCalled();
    });

    it('rejects a soft-deleted account', async () => {
      mockPrisma.user.findFirst.mockResolvedValue(null);
      await expect(service.submit(userId, dto())).rejects.toThrow(ForbiddenException);
      // Soft-delete guard harus ikut di where clause.
      expect(mockPrisma.user.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: userId, deletedAt: null } }),
      );
    });

    it('rejects when a PENDING submission already exists', async () => {
      mockPrisma.businessVerification.findFirst.mockResolvedValue({ status: BusinessVerificationStatus.PENDING, reviewedAt: null });
      await expect(service.submit(userId, dto())).rejects.toMatchObject({
        response: expect.objectContaining({ code: ErrorCodes.BUSINESS_VERIFICATION_ALREADY_PENDING }),
      });
    });

    it('rejects when already APPROVED', async () => {
      mockPrisma.businessVerification.findFirst.mockResolvedValue({ status: BusinessVerificationStatus.APPROVED, reviewedAt: null });
      await expect(service.submit(userId, dto())).rejects.toMatchObject({
        response: expect.objectContaining({ code: ErrorCodes.BUSINESS_VERIFICATION_ALREADY_APPROVED }),
      });
    });

    it('rejects when previously REVOKED', async () => {
      mockPrisma.businessVerification.findFirst.mockResolvedValue({ status: BusinessVerificationStatus.REVOKED, reviewedAt: null });
      await expect(service.submit(userId, dto())).rejects.toMatchObject({
        response: expect.objectContaining({ code: ErrorCodes.BUSINESS_VERIFICATION_REVOKED }),
      });
    });

    it('enforces a 24h cooldown after REJECTED', async () => {
      mockPrisma.businessVerification.findFirst.mockResolvedValue({
        status: BusinessVerificationStatus.REJECTED,
        reviewedAt: new Date(Date.now() - 3_600_000),
      });
      await expect(service.submit(userId, dto())).rejects.toMatchObject({
        response: expect.objectContaining({ code: ErrorCodes.BUSINESS_VERIFICATION_COOLDOWN_ACTIVE }),
      });
    });

    it('points to /resubmit once the cooldown has passed', async () => {
      mockPrisma.businessVerification.findFirst.mockResolvedValue({
        status: BusinessVerificationStatus.REJECTED,
        reviewedAt: new Date(Date.now() - 48 * 3_600_000),
      });
      await expect(service.submit(userId, dto())).rejects.toMatchObject({
        response: expect.objectContaining({ code: ErrorCodes.BUSINESS_VERIFICATION_USE_RESUBMIT }),
      });
    });
  });

  describe('submit — validation', () => {
    it('requires at least one of deedNumber or siupNumber', async () => {
      await expect(service.submit(userId, dto({ deedNumber: undefined, siupNumber: undefined }))).rejects.toMatchObject({
        response: expect.objectContaining({ code: ErrorCodes.VALIDATION_ERROR }),
      });
    });

    it('accepts siupNumber alone', async () => {
      const result = await service.submit(userId, dto({ deedNumber: undefined, siupNumber: 'NIB-999' }));
      expect(result).toMatchObject({ status: BusinessVerificationStatus.PENDING });
    });

    it('rejects an NPWP whose digit count is not 15 or 16', async () => {
      await expect(service.submit(userId, dto({ npwpNumber: '12345' }))).rejects.toMatchObject({
        response: expect.objectContaining({ code: ErrorCodes.VALIDATION_ERROR }),
      });
    });

    it('normalizes dots and dashes out of the NPWP before hashing', async () => {
      await service.submit(userId, dto({ npwpNumber: '01.234.567.8-901.000' }));
      const createArg = mockPrisma.businessVerification.create.mock.calls[0][0];
      expect(createArg.data.npwpNumberHash).toBe('hmac:012345678901000');
      // NPWP plaintext tidak boleh masuk kolom apa pun.
      expect(createArg.data.npwpNumber).toBe('enc:012345678901000');
    });

    it('rejects an NPWP already used by another active submission', async () => {
      // Panggilan ke-1 = latest submission (null), panggilan ke-2 = cek NPWP.
      mockPrisma.businessVerification.findFirst
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ id: 'other' });
      await expect(service.submit(userId, dto())).rejects.toMatchObject({
        response: expect.objectContaining({ code: ErrorCodes.BUSINESS_VERIFICATION_DUPLICATE_NPWP }),
      });
      expect(mockPrisma.businessVerification.findFirst).toHaveBeenLastCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            status: { in: [BusinessVerificationStatus.PENDING, BusinessVerificationStatus.APPROVED] },
            userId: { not: userId },
          }),
        }),
      );
    });

    it('rejects document keys that do not belong to the user', async () => {
      await expect(
        service.submit(userId, dto({ documentFileKeys: [`uploads/business-documents/victim/1700-npwp.pdf`] })),
      ).rejects.toMatchObject({ response: expect.objectContaining({ code: ErrorCodes.FILE_ACCESS_DENIED }) });
    });

    it('rejects traversal-shaped document keys before the prefix check', async () => {
      await expect(
        service.submit(userId, dto({ documentFileKeys: [`uploads/business-documents/${userId}/../../kyc-ktp/victim/x.jpg`] })),
      ).rejects.toMatchObject({ response: expect.objectContaining({ code: ErrorCodes.FILE_ACCESS_DENIED }) });
    });

    it('rejects duplicate document keys', async () => {
      await expect(service.submit(userId, dto({ documentFileKeys: [fileKey, fileKey] }))).rejects.toMatchObject({
        response: expect.objectContaining({ code: ErrorCodes.VALIDATION_ERROR }),
      });
    });

    it('requires every document to be confirmed via /upload/confirm', async () => {
      mockUpload.isConfirmedUploadKey.mockResolvedValue(false);
      await expect(service.submit(userId, dto())).rejects.toMatchObject({
        response: expect.objectContaining({ code: ErrorCodes.UPLOAD_NOT_CONFIRMED }),
      });
    });
  });

  describe('submit — persistence', () => {
    it('stores encrypted document keys and increments attemptNumber', async () => {
      mockPrisma.businessVerification.count.mockResolvedValue(2);
      await service.submit(userId, dto(), '1.2.3.4');
      const createArg = mockPrisma.businessVerification.create.mock.calls[0][0];
      expect(createArg.data.documentFileKeys).toEqual([`enc:${fileKey}`]);
      expect(createArg.data.attemptNumber).toBe(3);
      expect(createArg.data.submittedIp).toBe('1.2.3.4');
      expect(createArg.data.verificationId).toMatch(/^BIZ-/);
    });

    it('audits the submission as a user action', async () => {
      await service.submit(userId, dto());
      expect(mockAuditLog.logUserAction).toHaveBeenCalledWith(
        expect.objectContaining({ userId, entityType: 'BusinessVerification' }),
      );
    });

    it('translates a P2002 unique violation on the NPWP index into a friendly code', async () => {
      const { Prisma } = require('@prisma/client');
      mockPrisma.$transaction.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
          code: 'P2002',
          clientVersion: '5.22.0',
          meta: { target: ['npwpNumberHash'] },
        }),
      );
      await expect(service.submit(userId, dto())).rejects.toMatchObject({
        response: expect.objectContaining({ code: ErrorCodes.BUSINESS_VERIFICATION_DUPLICATE_NPWP }),
      });
    });

    it('translates a P2002 on the pending index into ALREADY_PENDING', async () => {
      const { Prisma } = require('@prisma/client');
      mockPrisma.$transaction.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
          code: 'P2002',
          clientVersion: '5.22.0',
          meta: { target: ['business_verification_one_pending_per_user'] },
        }),
      );
      await expect(service.submit(userId, dto())).rejects.toMatchObject({
        response: expect.objectContaining({ code: ErrorCodes.BUSINESS_VERIFICATION_ALREADY_PENDING }),
      });
    });

    it('re-checks for a concurrent PENDING row inside the transaction', async () => {
      // findFirst #1 = latest submission (di luar tx) -> null
      // findFirst #2 = cek NPWP -> null
      // findFirst #3 = re-check concurrent pending DI DALAM tx -> ada
      mockPrisma.businessVerification.findFirst
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ id: 'racing' });
      await expect(service.submit(userId, dto())).rejects.toMatchObject({
        response: expect.objectContaining({ code: ErrorCodes.BUSINESS_VERIFICATION_ALREADY_PENDING }),
      });
      expect(mockPrisma.businessVerification.create).not.toHaveBeenCalled();
    });
  });

  describe('resubmit', () => {
    it('rejects when the latest submission is not REJECTED', async () => {
      mockPrisma.businessVerification.findFirst.mockResolvedValue({ status: BusinessVerificationStatus.PENDING });
      await expect(service.resubmit(userId, dto())).rejects.toMatchObject({
        response: expect.objectContaining({ code: ErrorCodes.INVALID_STATUS }),
      });
    });

    it('rejects when there is no submission at all', async () => {
      mockPrisma.businessVerification.findFirst.mockResolvedValue(null);
      await expect(service.resubmit(userId, dto())).rejects.toThrow(BadRequestException);
    });

    it('creates a new submission after a REJECTED one', async () => {
      mockPrisma.businessVerification.findFirst
        .mockResolvedValueOnce({ status: BusinessVerificationStatus.REJECTED }) // resubmit gate
        .mockResolvedValueOnce({ status: BusinessVerificationStatus.REJECTED, reviewedAt: new Date(Date.now() - 48 * 3_600_000) }) // latest
        .mockResolvedValueOnce(null); // npwp check
      const result = await service.resubmit(userId, dto());
      expect(result).toMatchObject({ status: BusinessVerificationStatus.PENDING });
    });
  });

  describe('getStatus', () => {
    it('reports null status when nothing was ever submitted', async () => {
      mockPrisma.businessVerification.findFirst.mockResolvedValue(null);
      await expect(service.getStatus(userId)).resolves.toEqual({
        status: null,
        isBusinessVerified: false,
        latestRequest: null,
      });
    });

    it('exposes isBusinessVerified only for APPROVED', async () => {
      mockPrisma.businessVerification.findFirst.mockResolvedValue({
        verificationId: 'BIZ-1',
        status: BusinessVerificationStatus.APPROVED,
      });
      const result = await service.getStatus(userId);
      expect(result.isBusinessVerified).toBe(true);

      mockPrisma.businessVerification.findFirst.mockResolvedValue({
        verificationId: 'BIZ-1',
        status: BusinessVerificationStatus.PENDING,
      });
      expect((await service.getStatus(userId)).isBusinessVerified).toBe(false);
    });
  });

  describe('getHistory', () => {
    it('normalizes pagination and keeps a stable { id } tiebreak', async () => {
      mockPrisma.businessVerification.count.mockResolvedValue(0);
      const result = await service.getHistory(userId, -5, 9999);
      expect(mockPrisma.businessVerification.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ skip: 0, take: 100, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] }),
      );
      expect(result).toMatchObject({ page: 1, limit: 100, total: 0 });
    });
  });

  describe('invalidateBadgeCache', () => {
    it('delegates to the verification badge service', async () => {
      await service.invalidateBadgeCache(userId);
      expect(mockBadges.invalidate).toHaveBeenCalledWith(userId);
    });
  });
});
