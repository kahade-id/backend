/**
 * ADM-404 — force-cancel order di luar konteks sengketa hanya untuk SUPER_ADMIN.
 * DISPUTE_ADMIN hanya boleh force-cancel bila order memiliki dispute aktif
 * (status selain RESOLVED). Tanpa dispute aktif → 403 fail-closed.
 */
import { ForbiddenException } from '@nestjs/common';
import { AdminOrdersService } from './admin-orders.service';

function makeService(deps: {
  order?: unknown;
  dispute?: unknown;
}) {
  const prisma = {
    order: { findFirst: jest.fn().mockResolvedValue(deps.order ?? null) },
    dispute: { findFirst: jest.fn().mockResolvedValue(deps.dispute ?? null) },
  };
  const orderStateService = { adminCancelOrder: jest.fn().mockResolvedValue({}) };
  const auditLog = { logAdminAction: jest.fn() };
  const dashboard = { invalidateSummaryCache: jest.fn().mockResolvedValue(undefined) };
  const service = new AdminOrdersService(
    prisma as never,
    auditLog as never,
    {} as never, // redis
    orderStateService as never,
    {} as never, // feeCalculator
    {} as never, // walletTxSerialService
    {} as never, // referralService
    {} as never, // membershipRankService
    dashboard as never,
  );
  return { service, prisma, orderStateService };
}

const orderRow = { id: 'order-db-1', orderId: 'ORD-1', status: 'IN_DELIVERY' };
const dto = { reason: 'Alasan force-cancel yang cukup panjang' };

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
