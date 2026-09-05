import { AdminManagementService } from '../admin-management.service';

import { ForbiddenException } from '@nestjs/common';

describe('AdminManagementService token revocation epochs', () => {
  const prisma = {
    adminUser: {
      findFirst: jest.fn(),
      update: jest.fn(),
      count: jest.fn(),
    },
  };
  const auditLog = { logAdminAction: jest.fn() };
  const redis = { setex: jest.fn().mockResolvedValue(undefined) };
  let service: AdminManagementService;

  beforeEach(() => {
    jest.resetAllMocks();
    redis.setex.mockResolvedValue(undefined);
    prisma.adminUser.count.mockResolvedValue(2);
    service = new AdminManagementService(prisma as never, auditLog as never, redis as never);
  });

  it('revokes old tokens after a role change', async () => {
    prisma.adminUser.findFirst.mockResolvedValue({ id: 'target', adminId: 'ADM-1', fullName: 'Target', role: 'KYC_ADMIN', isActive: true, isMfaEnabled: true });
    prisma.adminUser.update.mockResolvedValue({ id: 'target', adminId: 'ADM-1', fullName: 'Target', role: 'FINANCE_ADMIN', isActive: true, isMfaEnabled: true });

    await service.updateAdmin('target', { role: 'FINANCE_ADMIN' } as never, 'updater', '198.51.100.10');

    expect(redis.setex).toHaveBeenCalledWith(
      'admin_revoked:target',
      2 * 60 * 60,
      expect.stringMatching(/^\d+$/),
      { throwOnError: true },
    );
  });

  it('revokes old tokens after resetting 2FA', async () => {
    prisma.adminUser.findFirst.mockResolvedValue({ id: 'target', fullName: 'Target', adminId: 'ADM-1', isMfaEnabled: true, mfaSecret: 'encrypted' });
    prisma.adminUser.update.mockResolvedValue({});

    await service.resetAdmin2fa('target', 'updater', '198.51.100.10');

    expect(redis.setex).toHaveBeenCalledWith('admin_revoked:target', 2 * 60 * 60, expect.stringMatching(/^\d+$/), { throwOnError: true });
  });

  it('revokes old tokens after unlocking an admin account', async () => {
    prisma.adminUser.findFirst.mockResolvedValue({ id: 'target', fullName: 'Target', adminId: 'ADM-1', lockedUntil: new Date(Date.now() + 60_000), failedLoginAttempts: 5 });
    prisma.adminUser.update.mockResolvedValue({});

    await service.unlockAdmin('target', 'updater', '198.51.100.10');

    expect(redis.setex).toHaveBeenCalledWith('admin_revoked:target', 2 * 60 * 60, expect.stringMatching(/^\d+$/), { throwOnError: true });
  });

  it('rejects resetting the current admin own 2FA', async () => {
    prisma.adminUser.findFirst.mockResolvedValue({ id: 'target', fullName: 'Target', adminId: 'ADM-1', isMfaEnabled: true, mfaSecret: 'encrypted' });
    await expect(service.resetAdmin2fa('target', 'target', '198.51.100.10')).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.adminUser.update).not.toHaveBeenCalled();
  });

  it('rejects demoting the last active super admin', async () => {
    prisma.adminUser.findFirst.mockResolvedValue({ id: 'target', fullName: 'Target', role: 'SUPER_ADMIN', isActive: true });
    prisma.adminUser.count.mockResolvedValue(1);
    await expect(service.updateAdmin('target', { role: 'CUSTOMER_SUPPORT' } as never, 'updater', '198.51.100.10')).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.adminUser.update).not.toHaveBeenCalled();
  });

  it('rejects deleting the last active super admin', async () => {
    prisma.adminUser.findFirst.mockResolvedValue({ id: 'target', fullName: 'Target', role: 'SUPER_ADMIN', isActive: true });
    prisma.adminUser.count.mockResolvedValue(1);
    await expect(service.deleteAdmin('target', 'deleter', '198.51.100.10')).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.adminUser.update).not.toHaveBeenCalled();
  });

  it('revokes old tokens after soft-deleting an admin account', async () => {
    prisma.adminUser.findFirst.mockResolvedValue({ id: 'target', fullName: 'Target', adminId: 'ADM-1' });
    prisma.adminUser.update.mockResolvedValue({});

    await service.deleteAdmin('target', 'deleter', '198.51.100.10');

    expect(redis.setex).toHaveBeenCalledWith('admin_revoked:target', 2 * 60 * 60, expect.stringMatching(/^\d+$/), { throwOnError: true });
  });
});
