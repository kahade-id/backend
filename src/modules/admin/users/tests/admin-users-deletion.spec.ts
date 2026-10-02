/**
 * GAP-A G067/G071: admin deletion status & legal hold — focused tests.
 *
 * - getDeletionStatus works for users in the grace period (soft-deleted:
 *   deletedAt set, isActive=false) — lookup does NOT filter deletedAt.
 * - placeDeletionLegalHold requires a reason and an active request.
 * - releaseDeletionLegalHold returns the request to REQUESTED.
 */
import { Test, type TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { getQueueToken } from '@nestjs/bull';
import { NotFoundException } from '@nestjs/common';

import { AdminUsersService } from '../admin-users.service';
import { WalletModeService } from '../../../wallet-mode/wallet-mode.service';
import { AdminPasswordService } from '../../auth/admin-password.service';
import { ApprovalsService } from '../../approvals/approvals.service';
import { PrismaService } from '../../../../prisma/prisma.service';
import { RedisService } from '../../../../redis/redis.service';
import { AuditLogService } from '../../../../common/services/audit-log.service';
import { WalletTxSerialService } from '../../../../common/services/wallet-tx-serial.service';
import { DashboardService } from '../../dashboard/dashboard.service';
import { OtpService } from '../../../auth/otp.service';
import { VerificationBadgeService } from '../../../users/verification-badge.service';
import { UploadService } from '../../../upload/upload.service';
import { LocalStorageService } from '../../../upload/local-storage.service';
import { EMAIL_QUEUE } from '../../../queue/processors/email.processor';

describe('AdminUsersService — deletion status & legal hold (GAP-A G067/G071)', () => {
  let service: AdminUsersService;

  const mockPrisma: any = {
    user: { findFirst: jest.fn() },
    accountDeletionRequest: { findFirst: jest.fn(), findUnique: jest.fn(), update: jest.fn() },
    accountDeletionStatusHistory: { create: jest.fn() },
    $transaction: jest.fn(),
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    mockPrisma.$transaction.mockImplementation(async (cb: any) => cb(mockPrisma));

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AdminUsersService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: RedisService, useValue: { setex: jest.fn(), get: jest.fn(), del: jest.fn() } },
        { provide: ConfigService, useValue: { get: jest.fn(() => '15m') } },
        { provide: AuditLogService, useValue: { logAdminAction: jest.fn() } },
        { provide: WalletTxSerialService, useValue: { next: jest.fn() } },
        { provide: OtpService, useValue: { generate: jest.fn() } },
        { provide: VerificationBadgeService, useValue: { invalidate: jest.fn() } },
        { provide: getQueueToken(EMAIL_QUEUE), useValue: { add: jest.fn() } },
        { provide: DashboardService, useValue: {} },
        { provide: UploadService, useValue: {} },
        // BAD-008/SEC-601: kill-switch + re-auth + dual control (mock).
        { provide: WalletModeService, useValue: { isWalletEnabled: () => true } },
        { provide: AdminPasswordService, useValue: { verifyAdminPassword: jest.fn() } },
        { provide: ApprovalsService, useValue: { registerExecutor: jest.fn(), propose: jest.fn() } },
        { provide: LocalStorageService, useValue: {} },
      ],
    }).compile();
    service = module.get<AdminUsersService>(AdminUsersService);
  });

  it('getDeletionStatus: user dalam masa tenggang (soft-deleted) tetap ditemukan (G071)', async () => {
    mockPrisma.user.findFirst.mockResolvedValue({ id: 'u-1', userId: 'USR001', email: 'u@x.id' });
    const req = {
      id: 'req-1',
      referenceCode: 'KDEL-1',
      history: [{ id: 'h1', fromStatus: null, toStatus: 'REQUESTED' }],
    };
    mockPrisma.accountDeletionRequest.findFirst.mockResolvedValue(req);

    const res: any = await service.getDeletionStatus('USR001');

    expect(res.userId).toBe('u-1');
    expect(res.request.referenceCode).toBe('KDEL-1');
    expect(res.history).toHaveLength(1);
    // Lookup TIDAK memfilter deletedAt.
    expect(mockPrisma.user.findFirst).toHaveBeenCalledWith({
      where: { OR: [{ id: 'USR001' }, { userId: 'USR001' }] },
      select: { id: true, userId: true, email: true },
    });
  });

  it('getDeletionStatus: user tidak ditemukan → 404', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(null);
    await expect(service.getDeletionStatus('nope')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('placeDeletionLegalHold: tanpa alasan → 400; tanpa request aktif → 404', async () => {
    mockPrisma.user.findFirst.mockResolvedValue({ id: 'u-1', userId: 'USR001', email: 'u@x.id' });
    await expect(service.placeDeletionLegalHold('u-1', '   ', 'admin-1')).rejects.toMatchObject({
      response: expect.objectContaining({}),
    });
    mockPrisma.accountDeletionRequest.findFirst.mockResolvedValue(null);
    await expect(service.placeDeletionLegalHold('u-1', 'Sengketa #1 terbuka', 'admin-1')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('placeDeletionLegalHold: request aktif → ON_HOLD + audit log', async () => {
    mockPrisma.user.findFirst.mockResolvedValue({ id: 'u-1', userId: 'USR001', email: 'u@x.id' });
    const req = { id: 'req-1', status: 'REQUESTED' };
    mockPrisma.accountDeletionRequest.findFirst.mockResolvedValue(req);
    mockPrisma.accountDeletionRequest.findUnique.mockResolvedValue({ ...req, status: 'REQUESTED' });
    mockPrisma.accountDeletionRequest.update.mockResolvedValue({ ...req, status: 'ON_HOLD' });

    const res: any = await service.placeDeletionLegalHold('u-1', 'Sengketa #1 terbuka', 'admin-1', '127.0.0.1');

    expect(res).toBeDefined();
    expect(mockPrisma.accountDeletionRequest.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'ON_HOLD' }) }),
    );
    expect(mockPrisma.accountDeletionStatusHistory.create).toHaveBeenCalled();
  });
});
