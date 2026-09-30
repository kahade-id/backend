/**
 * ADM-404 — force-cancel order di luar konteks sengketa hanya untuk SUPER_ADMIN.
 * DISPUTE_ADMIN hanya boleh force-cancel bila order memiliki dispute aktif
 * (status selain RESOLVED). Tanpa dispute aktif → 403 fail-closed.
 */
import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { AdminOrdersService } from './admin-orders.service';

// AUT-013: hash bcrypt (rounds 4, murah untuk test) dari password
// 'CorrectAdm1n!Pass' — dipakai mock adminUser untuk re-auth.
const ADMIN_PASSWORD_HASH = '$2b$04$waM9I26CpDGikc4wm7f./um84AmUcxOOK/U3/vCIlzu10geRiznVS';
const ADMIN_PASSWORD = 'CorrectAdm1n!Pass';
const adminRow = { id: 'admin-1', password: ADMIN_PASSWORD_HASH, isActive: true, deletedAt: null };

function makeService(deps: {
  order?: unknown;
  dispute?: unknown;
}) {
  const prisma = {
    order: { findFirst: jest.fn().mockResolvedValue(deps.order ?? null) },
    dispute: { findFirst: jest.fn().mockResolvedValue(deps.dispute ?? null) },
    adminUser: { findUnique: jest.fn().mockResolvedValue(adminRow) },
  };
  const orderStateService = { adminCancelOrder: jest.fn().mockResolvedValue({}) };
  const auditLog = { logAdminAction: jest.fn() };
  const dashboard = { invalidateSummaryCache: jest.fn().mockResolvedValue(undefined) };
  const service = new AdminOrdersService(
    prisma as never,
    auditLog as never,
    {} as never, // redis
    orderStateService as never,
    {} as never, // unshippedCancelService
    {} as never, // feeCalculator
    {} as never, // walletTxSerialService
    {} as never, // referralService
    {} as never, // membershipRankService
    dashboard as never,
    null as never, // walletMode (@Optional)
    null as never, // disbursement (@Optional)
  );
  return { service, prisma, orderStateService, auditLog };
}

const orderRow = { id: 'order-db-1', orderId: 'ORD-1', status: 'IN_DELIVERY' };
const dto = { reason: 'Alasan force-cancel yang cukup panjang', password: ADMIN_PASSWORD };

describe('ADM-404 forceCancel dispute scoping', () => {
  it('SUPER_ADMIN boleh force-cancel tanpa dispute aktif', async () => {
    const { service, orderStateService } = makeService({ order: orderRow, dispute: null });
    const res = await service.forceCancel('ORD-1', 'admin-1', 'SUPER_ADMIN', dto as never);
    expect(res.status).toBe('CANCELLED');
    expect(orderStateService.adminCancelOrder).toHaveBeenCalled();
  });

  it('DISPUTE_ADMIN + dispute aktif (OPEN) → diizinkan', async () => {
    const { service, orderStateService } = makeService({
      order: orderRow,
      dispute: { id: 'disp-1' },
    });
    const res = await service.forceCancel('ORD-1', 'admin-1', 'DISPUTE_ADMIN', dto as never);
    expect(res.status).toBe('CANCELLED');
    expect(orderStateService.adminCancelOrder).toHaveBeenCalled();
  });

  it('DISPUTE_ADMIN tanpa dispute aktif → 403 fail-closed', async () => {
    const { service, orderStateService, prisma } = makeService({ order: orderRow, dispute: null });
    await expect(
      service.forceCancel('ORD-1', 'admin-1', 'DISPUTE_ADMIN', dto as never),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(orderStateService.adminCancelOrder).not.toHaveBeenCalled();
    // Query dispute mengecualikan RESOLVED (dispute selesai bukan konteks aktif).
    expect(prisma.dispute.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ orderId: 'order-db-1' }),
      }),
    );
  });

  it('role lain (mis. FINANCE_ADMIN) tanpa dispute aktif → 403', async () => {
    const { service } = makeService({ order: orderRow, dispute: null });
    await expect(
      service.forceCancel('ORD-1', 'admin-1', 'FINANCE_ADMIN', dto as never),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});

describe('AUT-013 forceCancel re-auth password', () => {
  it('tanpa password → 401 Unauthorized (re-auth wajib)', async () => {
    const { service, orderStateService } = makeService({ order: orderRow, dispute: null });
    await expect(
      service.forceCancel('ORD-1', 'admin-1', 'SUPER_ADMIN', { reason: 'Alasan force-cancel yang cukup panjang' } as never),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(orderStateService.adminCancelOrder).not.toHaveBeenCalled();
  });

  it('password salah → 401 + diaudit', async () => {
    const { service, orderStateService, auditLog } = makeService({ order: orderRow, dispute: null });
    await expect(
      service.forceCancel('ORD-1', 'admin-1', 'SUPER_ADMIN', { reason: 'Alasan force-cancel yang cukup panjang', password: 'WrongPassword99!' } as never),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(orderStateService.adminCancelOrder).not.toHaveBeenCalled();
    expect(auditLog.logAdminAction).toHaveBeenCalledWith(
      expect.objectContaining({ description: expect.stringContaining('Failed re-authentication') }),
    );
  });

  it('password benar → lolos re-auth, order dibatalkan', async () => {
    const { service, orderStateService } = makeService({ order: orderRow, dispute: null });
    const res = await service.forceCancel('ORD-1', 'admin-1', 'SUPER_ADMIN', dto as never);
    expect(res.status).toBe('CANCELLED');
    expect(orderStateService.adminCancelOrder).toHaveBeenCalled();
  });
});
