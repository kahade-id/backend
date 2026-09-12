import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { AuditAction, BusinessVerificationStatus, NotificationType } from '@prisma/client';
import { AdminBusinessVerificationService } from '../admin-business-verification.service';
import { PrismaService } from '../../../../prisma/prisma.service';
import { AuditLogService } from '../../../../common/services/audit-log.service';
import { UploadService } from '../../../upload/upload.service';
import { NotificationQueueService } from '../../../queue/notification-queue.service';
import { VerificationBadgeService } from '../../../users/verification-badge.service';
import * as ErrorCodes from '../../../../common/constants/error-codes';

jest.mock('../../../../common/utils/crypto.util', () => ({
  bcryptCompare: jest.fn(async (_pw: string, hash: string) => hash === 'good-hash'),
  decryptAES: jest.fn(async (value: string) => {
    if (value.startsWith('corrupt:')) throw new Error('cannot decrypt');
    return value.replace(/^enc:/, '');
  }),
}));

const pending = {
  id: 'bv-1',
  verificationId: 'BIZ-20260912-000007-ABCD',
  userId: 'user-1',
  status: BusinessVerificationStatus.PENDING,
  businessName: 'PT Kawal Hak Dengan Aman',
};

const mockPrisma: any = {
  businessVerification: {
    findFirst: jest.fn(),
    findMany: jest.fn(),
    findUniqueOrThrow: jest.fn(),
    count: jest.fn(),
    updateMany: jest.fn(),
  },
  adminUser: { findUnique: jest.fn() },
};

const mockAuditLog = { logAdminAction: jest.fn() };
const mockUpload = { generateDownloadUrl: jest.fn() };
const mockNotificationQueue = { enqueue: jest.fn().mockResolvedValue(undefined), enqueueMany: jest.fn() };
const mockBadges = { invalidate: jest.fn().mockResolvedValue(undefined) };

describe('AdminBusinessVerificationService', () => {
  let service: AdminBusinessVerificationService;

  beforeEach(async () => {
    jest.clearAllMocks();
    mockPrisma.businessVerification.findFirst.mockResolvedValue(pending);
    mockPrisma.businessVerification.findMany.mockResolvedValue([]);
    mockPrisma.businessVerification.count.mockResolvedValue(0);
    mockPrisma.businessVerification.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.businessVerification.findUniqueOrThrow.mockResolvedValue({ ...pending, status: BusinessVerificationStatus.APPROVED });
    mockPrisma.$transaction = jest.fn(async (fn: any) => fn(mockPrisma));
    mockNotificationQueue.enqueue.mockResolvedValue(undefined);
    mockBadges.invalidate.mockResolvedValue(undefined);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AdminBusinessVerificationService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: AuditLogService, useValue: mockAuditLog },
        { provide: UploadService, useValue: mockUpload },
        { provide: NotificationQueueService, useValue: mockNotificationQueue },
        { provide: VerificationBadgeService, useValue: mockBadges },
      ],
    }).compile();
    service = module.get<AdminBusinessVerificationService>(AdminBusinessVerificationService);
  });

  it('should be defined', () => expect(service).toBeDefined());

  describe('getQueue', () => {
    it('normalizes pagination and reviews FIFO with an { id } tiebreak', async () => {
      await service.getQueue(-3, 9999);
      expect(mockPrisma.businessVerification.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ skip: 0, take: 100, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] }),
      );
    });

    it('rejects an unknown status filter', async () => {
      await expect(service.getQueue(1, 20, 'MAYBE')).rejects.toMatchObject({
        response: expect.objectContaining({ code: ErrorCodes.INVALID_STATUS }),
      });
      expect(mockPrisma.businessVerification.findMany).not.toHaveBeenCalled();
    });

    it('accepts every documented status', async () => {
      for (const status of ['PENDING', 'APPROVED', 'REJECTED', 'REVOKED']) {
        await service.getQueue(1, 20, status);
        expect(mockPrisma.businessVerification.findMany).toHaveBeenLastCalledWith(
          expect.objectContaining({ where: { status } }),
        );
      }
    });

    it('never returns the encrypted NPWP in the queue projection', async () => {
      await service.getQueue(1, 20);
      const select = mockPrisma.businessVerification.findMany.mock.calls[0][0].select;
      expect(select.npwpNumber).toBeUndefined();
      expect(select.npwpNumberHash).toBeUndefined();
      expect(select.documentFileKeys).toBeUndefined();
    });
  });

  describe('getDetail', () => {
    it('accepts either the cuid or the BIZ- verificationId', async () => {
      await service.getDetail('BIZ-20260912-000007-ABCD');
      expect(mockPrisma.businessVerification.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { OR: [{ id: 'BIZ-20260912-000007-ABCD' }, { verificationId: 'BIZ-20260912-000007-ABCD' }] },
        }),
      );
    });

    it('throws NotFound for a missing request', async () => {
      mockPrisma.businessVerification.findFirst.mockResolvedValue(null);
      await expect(service.getDetail('bv-x')).rejects.toThrow(NotFoundException);
    });

    it('audits the view when an admin id is supplied', async () => {
      await service.getDetail('bv-1', 'admin-1', '9.9.9.9');
      expect(mockAuditLog.logAdminAction).toHaveBeenCalledWith(
        expect.objectContaining({ adminId: 'admin-1', targetType: 'BUSINESS_VERIFICATION', ipAddress: '9.9.9.9' }),
      );
    });

    it('does not leak the NPWP or document keys in the detail payload', async () => {
      await service.getDetail('bv-1');
      const select = mockPrisma.businessVerification.findFirst.mock.calls[0][0].select;
      expect(select.npwpNumber).toBeUndefined();
      expect(select.npwpNumberHash).toBeUndefined();
      expect(select.documentFileKeys).toBeUndefined();
    });
  });

  describe('approve', () => {
    it('flips PENDING -> APPROVED with an atomic status guard', async () => {
      await service.approve('bv-1', 'admin-1', 'looks good', '9.9.9.9');
      expect(mockPrisma.businessVerification.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'bv-1', status: BusinessVerificationStatus.PENDING },
          data: expect.objectContaining({ status: BusinessVerificationStatus.APPROVED, reviewedBy: 'admin-1' }),
        }),
      );
      const data = mockPrisma.businessVerification.updateMany.mock.calls[0][0].data;
      expect(data.approvedAt).toEqual(data.reviewedAt);
    });

    it('refuses to process a request that is not PENDING', async () => {
      mockPrisma.businessVerification.findFirst.mockResolvedValue({ ...pending, status: BusinessVerificationStatus.APPROVED });
      await expect(service.approve('bv-1', 'admin-1')).rejects.toMatchObject({
        response: expect.objectContaining({ code: ErrorCodes.INVALID_STATUS }),
      });
    });

    it('reports the lost race when another admin processed it first', async () => {
      mockPrisma.businessVerification.updateMany.mockResolvedValue({ count: 0 });
      await expect(service.approve('bv-1', 'admin-1')).rejects.toThrow(BadRequestException);
      // Tidak boleh ada side effect setelah guard gagal.
      expect(mockBadges.invalidate).not.toHaveBeenCalled();
      expect(mockNotificationQueue.enqueue).not.toHaveBeenCalled();
    });

    it('invalidates the badge cache post-commit so the badge appears immediately', async () => {
      await service.approve('bv-1', 'admin-1');
      expect(mockBadges.invalidate).toHaveBeenCalledWith('user-1');
    });

    it('audits with BUSINESS_VERIFICATION_APPROVED and notifies the user', async () => {
      await service.approve('bv-1', 'admin-1');
      expect(mockAuditLog.logAdminAction).toHaveBeenCalledWith(
        expect.objectContaining({ action: AuditAction.BUSINESS_VERIFICATION_APPROVED, targetId: 'bv-1' }),
      );
      expect(mockNotificationQueue.enqueue).toHaveBeenCalledWith(
        expect.objectContaining({ userId: 'user-1', type: NotificationType.BUSINESS_VERIFICATION_APPROVED }),
      );
    });
  });

  describe('reject', () => {
    it('requires a non-blank reason', async () => {
      await expect(service.reject('bv-1', 'admin-1', '   ')).rejects.toMatchObject({
        response: expect.objectContaining({ code: ErrorCodes.VALIDATION_ERROR }),
      });
    });

    it('flips PENDING -> REJECTED and invalidates the badge cache', async () => {
      await service.reject('bv-1', 'admin-1', 'Dokumen tidak terbaca');
      expect(mockPrisma.businessVerification.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'bv-1', status: BusinessVerificationStatus.PENDING },
          data: expect.objectContaining({ status: BusinessVerificationStatus.REJECTED }),
        }),
      );
      expect(mockBadges.invalidate).toHaveBeenCalledWith('user-1');
      expect(mockNotificationQueue.enqueue).toHaveBeenCalledWith(
        expect.objectContaining({ type: NotificationType.BUSINESS_VERIFICATION_REJECTED }),
      );
    });

    it('HTML-escapes the reason before it reaches the user notification', async () => {
      await service.reject('bv-1', 'admin-1', '<script>alert(1)</script> dokumen palsu');
      const body = mockNotificationQueue.enqueue.mock.calls[0][0].body as string;
      expect(body).not.toContain('<script>');
      expect(body).toContain('&lt;script&gt;');
    });
  });

  describe('revoke', () => {
    it('only revokes from APPROVED', async () => {
      await expect(service.revoke('bv-1', 'admin-1', 'Pelanggaran ketentuan layanan')).rejects.toMatchObject({
        response: expect.objectContaining({ code: ErrorCodes.INVALID_STATUS }),
      });
    });

    it('flips APPROVED -> REVOKED, sets revokedAt and drops the badge immediately', async () => {
      mockPrisma.businessVerification.findFirst.mockResolvedValue({ ...pending, status: BusinessVerificationStatus.APPROVED });
      await service.revoke('bv-1', 'admin-1', 'Pelanggaran ketentuan layanan');
      const arg = mockPrisma.businessVerification.updateMany.mock.calls[0][0];
      expect(arg.where).toEqual({ id: 'bv-1', status: BusinessVerificationStatus.APPROVED });
      expect(arg.data.status).toBe(BusinessVerificationStatus.REVOKED);
      expect(arg.data.revokedAt).toBeInstanceOf(Date);
      expect(mockBadges.invalidate).toHaveBeenCalledWith('user-1');
      expect(mockNotificationQueue.enqueue).toHaveBeenCalledWith(
        expect.objectContaining({ type: NotificationType.BUSINESS_VERIFICATION_REVOKED }),
      );
      expect(mockAuditLog.logAdminAction).toHaveBeenCalledWith(
        expect.objectContaining({ action: AuditAction.BUSINESS_VERIFICATION_REVOKED }),
      );
    });
  });

  describe('getDocumentUrls', () => {
    const withDocs = {
      id: 'bv-1',
      userId: 'user-1',
      npwpNumber: 'enc:012345678901000',
      documentFileKeys: ['enc:uploads/business-documents/user-1/a.pdf', 'enc:uploads/business-documents/user-1/b.pdf'],
    };

    it('requires re-authentication with the admin password', async () => {
      await expect(service.getDocumentUrls('bv-1', 'admin-1')).rejects.toThrow(UnauthorizedException);
      expect(mockPrisma.businessVerification.findFirst).not.toHaveBeenCalled();
    });

    it('rejects a wrong password and audits the attempt', async () => {
      mockPrisma.adminUser.findUnique.mockResolvedValue({ id: 'admin-1', password: 'bad-hash' });
      await expect(service.getDocumentUrls('bv-1', 'admin-1', '9.9.9.9', 'wrong')).rejects.toMatchObject({
        response: expect.objectContaining({ code: ErrorCodes.INVALID_CREDENTIALS }),
      });
      expect(mockAuditLog.logAdminAction).toHaveBeenCalled();
    });

    it('returns the decrypted NPWP plus short-lived signed URLs', async () => {
      mockPrisma.adminUser.findUnique.mockResolvedValue({ id: 'admin-1', password: 'good-hash' });
      mockPrisma.businessVerification.findFirst.mockResolvedValue(withDocs);
      mockUpload.generateDownloadUrl.mockResolvedValue('https://signed/url');

      const result = await service.getDocumentUrls('bv-1', 'admin-1', '9.9.9.9', 'pw');
      expect(result.npwpNumber).toBe('012345678901000');
      expect(result.documentUrls).toEqual(['https://signed/url', 'https://signed/url']);
      expect(mockUpload.generateDownloadUrl).toHaveBeenCalledWith(expect.any(String), 300);
      expect(mockAuditLog.logAdminAction).toHaveBeenCalledWith(
        expect.objectContaining({ action: AuditAction.BUSINESS_DOCUMENTS_ACCESSED }),
      );
    });

    it('reports partial errors instead of failing when one document is corrupt', async () => {
      mockPrisma.adminUser.findUnique.mockResolvedValue({ id: 'admin-1', password: 'good-hash' });
      mockPrisma.businessVerification.findFirst.mockResolvedValue({
        ...withDocs,
        documentFileKeys: ['corrupt:x', 'enc:uploads/business-documents/user-1/b.pdf'],
      });
      mockUpload.generateDownloadUrl.mockResolvedValue('https://signed/url');

      const result = await service.getDocumentUrls('bv-1', 'admin-1', '9.9.9.9', 'pw');
      expect(result.documentUrls).toEqual(['https://signed/url']);
      expect(result.partialErrors).toEqual(['One document is unavailable']);
    });

    it('fails loudly when nothing at all could be decrypted', async () => {
      mockPrisma.adminUser.findUnique.mockResolvedValue({ id: 'admin-1', password: 'good-hash' });
      mockPrisma.businessVerification.findFirst.mockResolvedValue({
        ...withDocs,
        npwpNumber: 'corrupt:npwp',
        documentFileKeys: ['corrupt:a'],
      });
      await expect(service.getDocumentUrls('bv-1', 'admin-1', '9.9.9.9', 'pw')).rejects.toMatchObject({
        response: expect.objectContaining({ code: ErrorCodes.INTERNAL_SERVER_ERROR }),
      });
    });
  });
});
