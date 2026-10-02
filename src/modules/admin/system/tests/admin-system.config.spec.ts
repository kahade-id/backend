import { ConflictException, NotFoundException } from '@nestjs/common';
import { AdminSystemService } from '../admin-system.service';

describe('AdminSystemService config approval controls', () => {
  const prisma = {
    systemConfig: { findUnique: jest.fn(), update: jest.fn() },
  };
  const redis = {
    get: jest.fn(),
    set: jest.fn(),
    setNx: jest.fn(),
    del: jest.fn(),
    releaseLock: jest.fn(),
    scan: jest.fn(),
    getPrefix: jest.fn(),
  };
  const auditLogService = { logAdminAction: jest.fn() };
  const approvals = {
    registerExecutor: jest.fn(),
    findPendingByActionTarget: jest.fn(),
    propose: jest.fn(),
    approve: jest.fn(),
    listPending: jest.fn(),
  };
  let service: AdminSystemService;

  beforeEach(() => {
    jest.resetAllMocks();
    redis.setNx.mockResolvedValue(true);
    redis.del.mockResolvedValue(undefined);
    redis.releaseLock.mockResolvedValue(true);
    service = new AdminSystemService(prisma as never, redis as never, auditLogService as never, { enqueueMany: jest.fn() } as never, approvals as never);
  });

  it('does not overwrite an existing pending financial config proposal', async () => {
    prisma.systemConfig.findUnique.mockResolvedValue({ id: 'cfg-1', key: 'platform_fee', value: '1', description: null, dataType: 'NUMBER' });
    // SYS-B-405: satu usulan pending per key — dideteksi via tabel approvals
    // (bukan Redis lock seperti sebelum konsolidasi).
    approvals.findPendingByActionTarget.mockResolvedValue({ approvalId: 'appr-1' });

    await expect(service.updateConfig('platform_fee', { value: '2' } as never, 'admin-1', 'SUPER_ADMIN' as never, '127.0.0.1'))
      .rejects.toBeInstanceOf(ConflictException);
    expect(auditLogService.logAdminAction).not.toHaveBeenCalled();
  });

  it('rejects approval when no pending change exists (NotFound)', async () => {
    // SYS-B-405: tidak ada mekanisme lock Redis lagi — konkurensi
    // ditangani tabel approvals; tanpa usulan pending → NotFound.
    approvals.findPendingByActionTarget.mockResolvedValue(null);
    await expect(service.approveConfigChange('platform_fee', 'admin-2', 'SUPER_ADMIN' as never, '127.0.0.1'))
      .rejects.toBeInstanceOf(NotFoundException);
    expect(approvals.approve).not.toHaveBeenCalled();
  });
});
