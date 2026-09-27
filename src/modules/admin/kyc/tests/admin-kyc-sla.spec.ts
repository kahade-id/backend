/**
 * GAP-E (G282–G300): test penugasan reviewer & guard bulk antrean KYC.
 * PrismaService di-mock penuh — tidak ada akses DB.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { getQueueToken } from '@nestjs/bull';
import { NotFoundException, BadRequestException, ConflictException } from '@nestjs/common';
import { AuditAction } from '@prisma/client';
import { AdminKycService } from '../admin-kyc.service';
import { PrismaService } from '../../../../prisma/prisma.service';
import { RedisService } from '../../../../redis/redis.service';
import { AuditLogService } from '../../../../common/services/audit-log.service';
import { UploadService } from '../../../upload/upload.service';
import { VerificationBadgeService } from '../../../users/verification-badge.service';
import { DashboardService } from '../../dashboard/dashboard.service';
import { EMAIL_QUEUE } from '../../../queue/processors/email.processor';
import * as ErrorCodes from '../../../../common/constants/error-codes';

const kycRequestRow = {
  id: 'ckyc1',
  kycId: 'KYC-000001',
  userId: 'user-001',
  status: 'PENDING',
  adminNotes: null,
  slaStartedAt: new Date('2026-09-26T00:00:00.000Z'),
  slaPausedAt: null,
  slaPausedAccumMs: BigInt(0),
  createdAt: new Date('2026-09-26T00:00:00.000Z'),
};

const activeReviewer = {
  id: 'admin-uuid-1',
  adminId: 'ADMIN-00001',
  fullName: 'Reviewer Aktif',
  role: 'KYC_ADMIN',
  isActive: true,
  deletedAt: null,
};

/** Ambil error code terstruktur dari HttpException (ada di getResponse(), bukan di instance). */
function codeOf(err: unknown): string | undefined {
  const g = (err as { getResponse?: unknown }).getResponse;
  if (typeof g === 'function') {
    const res = (err as { getResponse: () => unknown }).getResponse();
    if (res && typeof res === 'object') return (res as { code?: string }).code;
  }
  return undefined;
}

async function expectCode(promise: Promise<unknown>, code: string): Promise<void> {
  try {
    await promise;
  } catch (err) {
    expect(codeOf(err)).toBe(code);
    return;
  }
  throw new Error(`harusnya menolak dengan code ${code}`);
}

function buildMocks() {  const mockTx = {
    kycReviewAssignment: { updateMany: jest.fn(), create: jest.fn(), findFirst: jest.fn() },
    kycRequest: { update: jest.fn() },
  };
  const mockPrisma = {
    kycRequest: {
      findFirst: jest.fn(),
      findMany: jest.fn(),
      count: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
    },
    kycReviewAssignment: { findMany: jest.fn() },
    adminUser: { findUnique: jest.fn(), findMany: jest.fn(), findFirst: jest.fn() },
    adminAuditLog: { findMany: jest.fn() },
    operationalSlaConfig: { findUnique: jest.fn(), upsert: jest.fn(), create: jest.fn() },
    operationalSlaConfigAudit: { create: jest.fn() },
    notification: { create: jest.fn().mockResolvedValue({}) },
    $transaction: jest.fn((cb: (tx: unknown) => unknown) => cb(mockTx)),
  };
  const mockAuditLog = { logAdminAction: jest.fn(), logUserAction: jest.fn() };
  return { mockTx, mockPrisma, mockAuditLog };
}

describe('AdminKycService — assignment & bulk guard', () => {
  let service: AdminKycService;
  let mockPrisma: ReturnType<typeof buildMocks>['mockPrisma'];
  let mockTx: ReturnType<typeof buildMocks>['mockTx'];
  let mockAuditLog: ReturnType<typeof buildMocks>['mockAuditLog'];

  beforeEach(async () => {
    const mocks = buildMocks();
    mockPrisma = mocks.mockPrisma;
    mockTx = mocks.mockTx;
    mockAuditLog = mocks.mockAuditLog;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AdminKycService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: RedisService, useValue: { del: jest.fn() } },
        { provide: AuditLogService, useValue: mockAuditLog },
        { provide: UploadService, useValue: {} },
        { provide: VerificationBadgeService, useValue: { invalidate: jest.fn() } },
        { provide: DashboardService, useValue: { invalidateSummaryCache: jest.fn() } },
        { provide: getQueueToken(EMAIL_QUEUE), useValue: { add: jest.fn() } },
      ],
    }).compile();

    service = module.get<AdminKycService>(AdminKycService);
    jest.clearAllMocks();
    mockPrisma.operationalSlaConfig.findUnique.mockResolvedValue({ slaHours: 48, useBusinessHours: false });
  });

  describe('assignReviewer', () => {
    it('menonaktifkan penugasan lama, membuat yang baru, dan mengaudit', async () => {
      mockPrisma.kycRequest.findFirst.mockResolvedValue(kycRequestRow);
      mockPrisma.adminUser.findFirst.mockResolvedValue(activeReviewer);
      mockTx.kycReviewAssignment.create.mockResolvedValue({
        id: 'assign-1',
        assignedAt: new Date('2026-09-26T01:00:00.000Z'),
      });

      const result = await service.assignReviewer('KYC-000001', 'admin-uuid-1', 'admin-uuid-boss', '1.2.3.4');

      expect(mockTx.kycReviewAssignment.updateMany).toHaveBeenCalledWith({
        where: { kycRequestId: 'ckyc1', active: true },
        data: { active: false, releasedAt: expect.any(Date) },
      });
      expect(mockTx.kycReviewAssignment.create).toHaveBeenCalledWith({
        data: { kycRequestId: 'ckyc1', adminId: 'admin-uuid-1', assignedBy: 'admin-uuid-boss' },
      });
      expect(mockTx.kycRequest.update).toHaveBeenCalledWith({
        where: { id: 'ckyc1' },
        data: { assignedReviewerId: 'admin-uuid-1' },
      });
      expect(mockAuditLog.logAdminAction).toHaveBeenCalledWith(
        expect.objectContaining({
          adminId: 'admin-uuid-boss',
          action: AuditAction.KYC_REVIEW_ASSIGNED,
          targetType: 'KYC_REQUEST',
        }),
      );
      expect(result).toMatchObject({ assignmentId: 'assign-1', kycRequestId: 'ckyc1' });
    });

    it('menerima public adminId (mis. ADMIN-00001), bukan hanya DB id', async () => {
      mockPrisma.kycRequest.findFirst.mockResolvedValue(kycRequestRow);
      mockPrisma.adminUser.findFirst.mockResolvedValue(activeReviewer);
      mockTx.kycReviewAssignment.create.mockResolvedValue({
        id: 'assign-9',
        assignedAt: new Date('2026-09-26T01:00:00.000Z'),
      });

      await service.assignReviewer('KYC-000001', 'ADMIN-00001', 'admin-uuid-boss');

      expect(mockPrisma.adminUser.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { OR: [{ id: 'ADMIN-00001' }, { adminId: 'ADMIN-00001' }] },
        }),
      );
      // assignedReviewerId menyimpan DB id (bukan public adminId).
      expect(mockTx.kycReviewAssignment.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ adminId: 'admin-uuid-1' }),
      });
    });

    it('menolak reviewer yang tidak aktif', async () => {
      mockPrisma.kycRequest.findFirst.mockResolvedValue(kycRequestRow);
      mockPrisma.adminUser.findFirst.mockResolvedValue({ ...activeReviewer, isActive: false });
      await expectCode(service.assignReviewer('KYC-000001', 'admin-uuid-1', 'admin-uuid-boss'), ErrorCodes.KYC_REVIEWER_INACTIVE);
      expect(mockTx.kycReviewAssignment.create).not.toHaveBeenCalled();
    });

    it('menolak reviewer tanpa peran KYC', async () => {
      mockPrisma.kycRequest.findFirst.mockResolvedValue(kycRequestRow);
      mockPrisma.adminUser.findFirst.mockResolvedValue({ ...activeReviewer, role: 'FINANCE_ADMIN' });
      await expectCode(service.assignReviewer('KYC-000001', 'admin-uuid-1', 'admin-uuid-boss'), ErrorCodes.KYC_REVIEWER_WRONG_ROLE);
    });

    it('404 bila pengajuan atau reviewer tidak ada', async () => {
      mockPrisma.kycRequest.findFirst.mockResolvedValue(null);
      await expect(service.assignReviewer('NOPE', 'admin-uuid-1', 'admin-uuid-boss')).rejects.toBeInstanceOf(
        NotFoundException,
      );

      mockPrisma.kycRequest.findFirst.mockResolvedValue(kycRequestRow);
      mockPrisma.adminUser.findFirst.mockResolvedValue(null);
      await expectCode(service.assignReviewer('KYC-000001', 'admin-uuid-x', 'admin-uuid-boss'), ErrorCodes.KYC_REVIEWER_NOT_FOUND);
    });
  });

  describe('releaseReviewer', () => {
    it('melepas penugasan aktif dan mengosongkan assignedReviewerId', async () => {
      mockPrisma.kycRequest.findFirst.mockResolvedValue(kycRequestRow);
      mockTx.kycReviewAssignment.findFirst.mockResolvedValue({ id: 'assign-1', adminId: 'admin-uuid-1' });

      const result = await service.releaseReviewer('KYC-000001', 'admin-uuid-boss');

      expect(mockTx.kycReviewAssignment.updateMany).toHaveBeenCalledWith({
        where: { kycRequestId: 'ckyc1', active: true },
        data: { active: false, releasedAt: expect.any(Date) },
      });
      expect(mockTx.kycRequest.update).toHaveBeenCalledWith({
        where: { id: 'ckyc1' },
        data: { assignedReviewerId: null },
      });
      expect(result).toMatchObject({ released: true, kycRequestId: 'ckyc1' });
    });

    it('404 bila tidak ada penugasan aktif', async () => {
      mockPrisma.kycRequest.findFirst.mockResolvedValue(kycRequestRow);
      mockTx.kycReviewAssignment.findFirst.mockResolvedValue(null);
      await expectCode(service.releaseReviewer('KYC-000001', 'admin-uuid-boss'), ErrorCodes.KYC_NO_ACTIVE_ASSIGNMENT);
    });
  });

  describe('bulk expectedStatus guard', () => {
    it('membatalkan item yang statusnya berubah sejak daftar dimuat', async () => {
      const approveSpy = jest.spyOn(service, 'approveKyc').mockResolvedValue({ id: 'x' });
      mockPrisma.kycRequest.findFirst
        .mockResolvedValueOnce({ status: 'PENDING' })
        .mockResolvedValueOnce({ status: 'APPROVED' });

      const result = await service.bulkApproveKyc(
        ['KYC-A', 'KYC-B'],
        'admin-uuid-boss',
        undefined,
        'internal',
        'PENDING',
      );

      expect(result.approved).toEqual(['KYC-A']);
      expect(result.failed).toHaveLength(1);
      expect(result.failed[0].id).toBe('KYC-B');
      expect(approveSpy).toHaveBeenCalledTimes(1);
      expect(approveSpy).toHaveBeenCalledWith('KYC-A', 'admin-uuid-boss', undefined, 'internal');
      approveSpy.mockRestore();
    });

    it('melempar ConflictException dengan kode KYC_STATUS_CHANGED pada guard', async () => {
      mockPrisma.kycRequest.findFirst.mockResolvedValue({ status: 'REJECTED' });
      const guard = (service as unknown as { assertExpectedStatus: (a: string, b: string) => Promise<void> })
        .assertExpectedStatus.bind(service);
      await expect(guard('KYC-B', 'PENDING')).rejects.toBeInstanceOf(ConflictException);
      await expectCode(guard('KYC-B', 'PENDING'), ErrorCodes.KYC_STATUS_CHANGED);
    });

    it('tanpa expectedStatus, guard dilewati (perilaku lama)', async () => {
      const approveSpy = jest.spyOn(service, 'approveKyc').mockResolvedValue({ id: 'x' });
      const result = await service.bulkApproveKyc(['KYC-A'], 'admin-uuid-boss');
      expect(result.approved).toEqual(['KYC-A']);
      expect(mockPrisma.kycRequest.findFirst).not.toHaveBeenCalled();
      approveSpy.mockRestore();
    });
  });

  describe('requestDocuments / resumeSla', () => {
    it('pause: set slaPausedAt dan beri tahu pengguna', async () => {
      mockPrisma.kycRequest.findFirst.mockResolvedValue(kycRequestRow);
      mockPrisma.kycRequest.update.mockResolvedValue({});
      (service as unknown as { prisma: { emitNotificationCreated: jest.Mock } }).prisma.emitNotificationCreated =
        jest.fn();

      const result = await service.requestDocuments(
        'KYC-000001',
        'admin-uuid-boss',
        'Mohon kirim ulang foto KTP yang lebih jelas',
        undefined,
        '1.2.3.4',
      );

      expect(mockPrisma.kycRequest.update).toHaveBeenCalledWith({
        where: { id: 'ckyc1' },
        data: expect.objectContaining({ slaPausedAt: expect.any(Date) }),
      });
      expect(result).toMatchObject({ paused: true, kycRequestId: 'ckyc1' });
    });

    it('menolak pause ganda', async () => {
      mockPrisma.kycRequest.findFirst.mockResolvedValue({
        ...kycRequestRow,
        slaPausedAt: new Date('2026-09-26T05:00:00.000Z'),
      });
      await expectCode(
        service.requestDocuments('KYC-000001', 'admin-uuid-boss', 'Pesan dokumen tambahan', undefined),
        ErrorCodes.KYC_ALREADY_PAUSED,
      );
      expect(mockPrisma.kycRequest.update).not.toHaveBeenCalled();
    });

    it('resume mengakumulasi jeda dan mengosongkan slaPausedAt', async () => {
      const pausedAt = new Date('2026-09-26T10:00:00.000Z');
      mockPrisma.kycRequest.findFirst.mockResolvedValue({
        ...kycRequestRow,
        slaPausedAt: pausedAt,
        slaPausedAccumMs: BigInt(0),
      });
      mockPrisma.kycRequest.update.mockResolvedValue({});

      const result = await service.resumeSla('KYC-000001', 'admin-uuid-boss');

      const updateArg = mockPrisma.kycRequest.update.mock.calls[0][0];
      expect(updateArg.data.slaPausedAt).toBeNull();
      expect(typeof updateArg.data.slaPausedAccumMs).toBe('bigint');
      expect(updateArg.data.slaPausedAccumMs > BigInt(0)).toBe(true);
      expect(result).toMatchObject({ resumed: true, kycRequestId: 'ckyc1' });
    });

    it('menolak resume bila tidak sedang pause', async () => {
      mockPrisma.kycRequest.findFirst.mockResolvedValue(kycRequestRow);
      await expectCode(service.resumeSla('KYC-000001', 'admin-uuid-boss'), ErrorCodes.KYC_NOT_PAUSED);
      expect(BadRequestException).toBeDefined();
    });
  });
});
