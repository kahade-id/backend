/**
 * GAP-E (G376–G400) — test perilaku admin ops:
 * - emergency grant non-SUPER_ADMIN → 403
 * - suspend mempertahankan audit ADMIN_SUSPENDED
 * - updateAdmin: alasan wajib bila role berubah + audit ADMIN_ROLE_CHANGED
 * - revokeAdminSession: revokedAt + audit + epoch token dibatalkan
 */
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { AuditAction } from '@prisma/client';
import { AdminManagementService } from '../admin-management.service';

describe('AdminManagementService — GAP-E admin ops', () => {
  const prisma = {
    adminUser: { findFirst: jest.fn(), update: jest.fn(), count: jest.fn() },
    adminSession: { findMany: jest.fn(), findFirst: jest.fn(), update: jest.fn() },
    emergencyAccessGrant: { findFirst: jest.fn(), findMany: jest.fn(), create: jest.fn(), update: jest.fn() },
  };
  const auditLog = { logAdminAction: jest.fn() };
  const redis = { setex: jest.fn().mockResolvedValue(undefined), get: jest.fn() };
  let service: AdminManagementService;

  beforeEach(() => {
    jest.resetAllMocks();
    redis.setex.mockResolvedValue(undefined);
    prisma.adminUser.count.mockResolvedValue(2);
    service = new AdminManagementService(prisma as never, auditLog as never, redis as never);
  });

  it('emergency grant oleh non-SUPER_ADMIN → 403', async () => {
    await expect(
      service.createEmergencyGrant(
        { adminId: 'target', reason: 'insiden darurat produksi', scope: 'finance:read', expiresInMinutes: 30 } as never,
        'granter',
        'CUSTOMER_SUPPORT',
        '198.51.100.10',
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.emergencyAccessGrant.create).not.toHaveBeenCalled();
    expect(auditLog.logAdminAction).not.toHaveBeenCalled();
  });

  it('suspend mempertahankan audit ADMIN_SUSPENDED {before, after}', async () => {
    prisma.adminUser.findFirst.mockResolvedValue({
      id: 'target', adminId: 'ADM-2', fullName: 'Target', role: 'KYC_ADMIN', isActive: true,
    });
    prisma.adminUser.update.mockResolvedValue({ id: 'target', isActive: false });

    await service.suspendAdmin('target', { reason: 'pelanggaran kebijakan' } as never, 'actor', '198.51.100.10');

    expect(prisma.adminUser.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'target' }, data: { isActive: false } }),
    );
    expect(auditLog.logAdminAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: AuditAction.ADMIN_SUSPENDED,
        targetType: 'AdminUser',
        targetId: 'target',
        before: { isActive: true },
        after: expect.objectContaining({ isActive: false, reason: 'pelanggaran kebijakan' }),
      }),
    );
  });

  it('updateAdmin: ganti role tanpa alasan → 400', async () => {
    prisma.adminUser.findFirst.mockResolvedValue({
      id: 'target', adminId: 'ADM-2', fullName: 'Target', role: 'KYC_ADMIN', isActive: true,
    });

    await expect(
      service.updateAdmin('target', { role: 'FINANCE_ADMIN' } as never, 'updater', '198.51.100.10'),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.adminUser.update).not.toHaveBeenCalled();
  });

  it('updateAdmin: ganti role dengan alasan → audit ADMIN_ROLE_CHANGED {before, after}', async () => {
    prisma.adminUser.findFirst.mockResolvedValue({
      id: 'target', adminId: 'ADM-2', fullName: 'Target', role: 'KYC_ADMIN', isActive: true,
    });
    prisma.adminUser.update.mockResolvedValue({ id: 'target', role: 'FINANCE_ADMIN', isActive: true });

    await service.updateAdmin(
      'target',
      { role: 'FINANCE_ADMIN', reason: 'rotasi tim keuangan' } as never,
      'updater',
      '198.51.100.10',
    );

    expect(auditLog.logAdminAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: AuditAction.ADMIN_ROLE_CHANGED,
        targetType: 'AdminUser',
        targetId: 'target',
        before: { role: 'KYC_ADMIN' },
        after: { role: 'FINANCE_ADMIN', reason: 'rotasi tim keuangan' },
      }),
    );
  });

  it('revokeAdminSession: revokedAt + audit + epoch token dibatalkan (fail-safe)', async () => {
    prisma.adminUser.findFirst.mockResolvedValue({
      id: 'admin1', adminId: 'ADM-1', fullName: 'A', role: 'KYC_ADMIN', isActive: true,
    });
    prisma.adminSession.findFirst.mockResolvedValue({ id: 'sess1', adminId: 'admin1', revokedAt: null });
    prisma.adminSession.update.mockResolvedValue({});

    await service.revokeAdminSession('admin1', 'sess1', 'super1', '198.51.100.10');

    expect(prisma.adminSession.update).toHaveBeenCalledWith({
      where: { id: 'sess1' },
      data: { revokedAt: expect.any(Date), revokedBy: 'super1' },
    });
    expect(auditLog.logAdminAction).toHaveBeenCalledWith(
      expect.objectContaining({ action: AuditAction.ADMIN_SESSION_REVOKED, targetId: 'admin1' }),
    );
    // JWT stateless tidak tertaut per-sesi → epoch dibump agar token ikut batal.
    expect(redis.setex).toHaveBeenCalledWith(
      'admin_revoked:admin1',
      expect.any(Number),
      expect.stringMatching(/^\d+$/),
      { throwOnError: true },
    );
  });

  it('listEmergencyGrants(false) menampilkan riwayat termasuk yang dicabut', async () => {
    prisma.emergencyAccessGrant.findMany.mockResolvedValue([
      { id: 'g1', revokedAt: new Date(), admin: { id: 'a1' } },
    ]);
    const result = (await service.listEmergencyGrants(false)) as { data: unknown[]; total: number };
    expect(prisma.emergencyAccessGrant.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: {} }),
    );
    expect(result.total).toBe(1);
  });

  it('listEmergencyGrants(true) memfilter hanya yang aktif', async () => {
    prisma.emergencyAccessGrant.findMany.mockResolvedValue([]);
    await service.listEmergencyGrants(true);
    expect(prisma.emergencyAccessGrant.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { revokedAt: null, expiresAt: { gt: expect.any(Date) } },
      }),
    );
  });

  it('listAdminAuditLog: 404 bila admin tidak ada; paginasi aman', async () => {
    prisma.adminUser.findFirst.mockResolvedValue(null);
    await expect(service.listAdminAuditLog('nope', 1, 20)).rejects.toThrow();
    prisma.adminUser.findFirst.mockResolvedValue({ id: 'a1' });
    const prismaWithLog = {
      ...prisma,
      adminAuditLog: { findMany: jest.fn().mockResolvedValue([]), count: jest.fn().mockResolvedValue(0) },
    };
    const svc = new AdminManagementService(prismaWithLog as never, auditLog as never, redis as never);
    const result = (await svc.listAdminAuditLog('a1', 1, 20)) as { total: number; page: number };
    expect(result.total).toBe(0);
    expect(result.page).toBe(1);
  });

  it('exportAdminActivityCsv: header CSV + audit USER_EXPORTED', async () => {
    const prismaWithLog = {
      ...prisma,
      adminAuditLog: { findMany: jest.fn().mockResolvedValue([]), count: jest.fn().mockResolvedValue(0) },
    };
    const svc = new AdminManagementService(prismaWithLog as never, auditLog as never, redis as never);
    const csv = await svc.exportAdminActivityCsv({}, 'super1', '198.51.100.10');
    expect(csv.split('\n')[0]).toBe('id,admin_id,admin_name,action,description,ip_address,created_at');
    expect(auditLog.logAdminAction).toHaveBeenCalledWith(
      expect.objectContaining({ action: AuditAction.USER_EXPORTED, adminId: 'super1' }),
    );
  });
});
