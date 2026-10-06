import { UnshippedOrderCancelService } from '../unshipped-order-cancel.service';
import { OrderStatus, OrderCancelReason, DisputeStatus } from '@prisma/client';
import { ConflictException, NotFoundException } from '@nestjs/common';

/**
 * Wave 3 P0 — buyer stuck: seller tidak kirim → auto-cancel + auto-refund.
 * Guard yang diuji: due predicate, skip dispute berjalan, idempotensi race,
 * dan refund hanya via primitif adminCancelOrder (tidak ada logika uang baru).
 */
describe('UnshippedOrderCancelService', () => {
  const prisma: any = {
    order: { findFirst: jest.fn(), findUnique: jest.fn(), findMany: jest.fn() },
    dispute: { findFirst: jest.fn() },
  };
  const orderStateService: any = { adminCancelOrder: jest.fn() };

  let service: UnshippedOrderCancelService;
  const OLD = new Date(Date.now() - 5 * 24 * 3600_000); // 5 hari lalu
  const RECENT = new Date(Date.now() - 1 * 3600_000); // 1 jam lalu

  function orderRow(overrides: Record<string, unknown> = {}) {
    return {
      id: 'order-internal-1',
      orderId: 'ORD-20260928-000001-TEST',
      status: OrderStatus.PROCESSING,
      shippedAt: null,
      processingDeadlineAt: OLD,
      paidAt: OLD,
      buyerId: 'buyer-1',
      buyerPayAmount: BigInt(150000),
      ...overrides,
    };
  }

  beforeEach(() => {
    jest.clearAllMocks();
    prisma.dispute.findFirst.mockResolvedValue(null);
    orderStateService.adminCancelOrder.mockResolvedValue(undefined);
    service = new UnshippedOrderCancelService(prisma, orderStateService);
  });

  it('membatalkan + refund order PROCESSING yang lewat batas kirim (cancelReason TIMEOUT_PROCESSING)', async () => {
    prisma.order.findFirst.mockResolvedValue(orderRow());
    const result = await service.cancelUnshippedOrder('ORD-20260928-000001-TEST', 'system:test', 'reason');

    expect(result.outcome).toBe('CANCELLED_REFUNDED');
    expect(orderStateService.adminCancelOrder).toHaveBeenCalledWith(
      'ORD-20260928-000001-TEST',
      'system:test',
      'reason',
      OrderCancelReason.TIMEOUT_PROCESSING,
    );
  });

  it('melewatkan order dengan dispute berjalan (tidak tabrakan dengan dispute)', async () => {
    prisma.order.findFirst.mockResolvedValue(orderRow());
    prisma.dispute.findFirst.mockResolvedValue({ id: 'dsp-1' });

    const result = await service.cancelUnshippedOrder('ORD-20260928-000001-TEST', 'system:test', 'reason');

    expect(result.outcome).toBe('SKIPPED_DISPUTED');
    expect(orderStateService.adminCancelOrder).not.toHaveBeenCalled();
    // Pastikan filter dispute memakai semua status non-RESOLVED.
    expect(prisma.dispute.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: { in: expect.arrayContaining([DisputeStatus.OPEN, DisputeStatus.ESCALATED]) },
        }),
      }),
    );
  });

  it('melewatkan order yang belum lewat batas kirim', async () => {
    prisma.order.findFirst.mockResolvedValue(orderRow({ processingDeadlineAt: new Date(Date.now() + 3600_000), paidAt: RECENT }));

    const result = await service.cancelUnshippedOrder('ORD-20260928-000001-TEST', 'system:test', 'reason');

    expect(result.outcome).toBe('SKIPPED_NOT_DUE');
    expect(orderStateService.adminCancelOrder).not.toHaveBeenCalled();
  });

  it('melewatkan order yang sudah dikirim (IN_DELIVERY / shippedAt terisi)', async () => {
    prisma.order.findFirst.mockResolvedValue(orderRow({ status: OrderStatus.IN_DELIVERY, shippedAt: RECENT }));

    const result = await service.cancelUnshippedOrder('ORD-20260928-000001-TEST', 'system:test', 'reason');

    expect(result.outcome).toBe('SKIPPED_NOT_DUE');
    expect(orderStateService.adminCancelOrder).not.toHaveBeenCalled();
  });

  it('mengembalikan ALREADY_HANDLED untuk order yang sudah CANCELLED', async () => {
    prisma.order.findFirst.mockResolvedValue(orderRow({ status: OrderStatus.CANCELLED }));

    const result = await service.cancelUnshippedOrder('ORD-20260928-000001-TEST', 'system:test', 'reason');

    expect(result.outcome).toBe('ALREADY_HANDLED');
    expect(orderStateService.adminCancelOrder).not.toHaveBeenCalled();
  });

  it('404 untuk order yang tidak ada', async () => {
    prisma.order.findFirst.mockResolvedValue(null);
    await expect(service.cancelUnshippedOrder('NOPE', 'system:test', 'reason')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('backfill implisit: order lama tanpa processingDeadlineAt tetap due via paidAt', async () => {
    prisma.order.findFirst.mockResolvedValue(orderRow({ processingDeadlineAt: null, paidAt: OLD }));

    const result = await service.cancelUnshippedOrder('ORD-20260928-000001-TEST', 'system:test', 'reason');

    expect(result.outcome).toBe('CANCELLED_REFUNDED');
    expect(orderStateService.adminCancelOrder).toHaveBeenCalled();
  });

  it('race: ConflictException + status sudah CANCELLED → ALREADY_HANDLED (idempoten)', async () => {
    prisma.order.findFirst.mockResolvedValue(orderRow());
    orderStateService.adminCancelOrder.mockRejectedValue(new ConflictException({ code: 'OPTIMISTIC_LOCK_CONFLICT', message: 'x' }));
    prisma.order.findUnique.mockResolvedValue({ status: OrderStatus.CANCELLED });

    const result = await service.cancelUnshippedOrder('ORD-20260928-000001-TEST', 'system:test', 'reason');

    expect(result.outcome).toBe('ALREADY_HANDLED');
  });

  it('race: ConflictException + status berubah ke DISPUTED → SKIPPED_NOT_DUE (fail closed)', async () => {
    prisma.order.findFirst.mockResolvedValue(orderRow());
    orderStateService.adminCancelOrder.mockRejectedValue(new ConflictException({ code: 'OPTIMISTIC_LOCK_CONFLICT', message: 'x' }));
    prisma.order.findUnique.mockResolvedValue({ status: OrderStatus.DISPUTED });

    const result = await service.cancelUnshippedOrder('ORD-20260928-000001-TEST', 'system:test', 'reason');

    expect(result.outcome).toBe('SKIPPED_NOT_DUE');
  });

  it('findDueUnshippedOrders memakai predikat PROCESSING + belum dikirim + tanpa dispute terbuka', async () => {
    prisma.order.findMany.mockResolvedValue([]);
    await service.findDueUnshippedOrders(200);

    expect(prisma.order.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: OrderStatus.PROCESSING,
          deletedAt: null,
          shippedAt: null,
        }),
        take: 200,
      }),
    );
    const where = prisma.order.findMany.mock.calls[0][0].where;
    // Backfill implisit order lama ikut dalam OR.
    expect(JSON.stringify(where.OR)).toContain('processingDeadlineAt');
    expect(JSON.stringify(where.OR)).toContain('paidAt');
  });

  // TX-AUDIT2 (P1-C): guard sweep untuk PREORDER legacy hasil backfill.
  it('P1-C: findDueUnshippedOrders mengecualikan PREORDER legacy (estimasi null, paidAt < 30 hari)', async () => {
    prisma.order.findMany.mockResolvedValue([]);
    const now = new Date();
    await service.findDueUnshippedOrders(200, now);

    const where = prisma.order.findMany.mock.calls[0][0].where;
    const firstBranch = where.OR[0];
    // Cabang processingDeadlineAt < now harus punya guard NOT untuk
    // PREORDER legacy (estimasi null + paidAt dalam 30 hari).
    const notClause = JSON.stringify(firstBranch.NOT);
    expect(notClause).toContain('PREORDER');
    expect(notClause).toContain('preorderEstimatedDate');
    // Guard (b): estimasi null + paidAt > (now - 30 hari).
    expect(notClause).toContain('paidAt');
  });

  it('P1-C: cancelUnshippedOrder melewatkan PREORDER legacy (estimasi null, paidAt 5 hari lalu)', async () => {
    prisma.order.findFirst.mockResolvedValue(
      orderRow({
        fulfillment: 'PREORDER',
        preorderEstimatedDate: null,
        // processingDeadlineAt legacy = paidAt + 2 hari (sudah lewat),
        // tapi preorder dapat jatah 30 hari.
        processingDeadlineAt: new Date(Date.now() - 3 * 24 * 3600_000),
        paidAt: new Date(Date.now() - 5 * 24 * 3600_000),
      }),
    );

    const result = await service.cancelUnshippedOrder('ORD-20260928-000001-TEST', 'system:test', 'reason');

    expect(result.outcome).toBe('SKIPPED_NOT_DUE');
    expect(orderStateService.adminCancelOrder).not.toHaveBeenCalled();
  });

  it('P1-C: cancelUnshippedOrder tetap membatalkan PREORDER legacy yang paidAt > 30 hari', async () => {
    prisma.order.findFirst.mockResolvedValue(
      orderRow({
        fulfillment: 'PREORDER',
        preorderEstimatedDate: null,
        processingDeadlineAt: new Date(Date.now() - 35 * 24 * 3600_000),
        paidAt: new Date(Date.now() - 40 * 24 * 3600_000),
      }),
    );

    const result = await service.cancelUnshippedOrder('ORD-20260928-000001-TEST', 'system:test', 'reason');

    expect(result.outcome).toBe('CANCELLED_REFUNDED');
    expect(orderStateService.adminCancelOrder).toHaveBeenCalled();
  });

  it('P1-C: cancelUnshippedOrder melewatkan PREORDER dengan estimasi di masa depan', async () => {
    prisma.order.findFirst.mockResolvedValue(
      orderRow({
        fulfillment: 'PREORDER',
        preorderEstimatedDate: new Date(Date.now() + 10 * 24 * 3600_000),
        processingDeadlineAt: new Date(Date.now() - 1 * 24 * 3600_000),
        paidAt: new Date(Date.now() - 3 * 24 * 3600_000),
      }),
    );

    const result = await service.cancelUnshippedOrder('ORD-20260928-000001-TEST', 'system:test', 'reason');

    expect(result.outcome).toBe('SKIPPED_NOT_DUE');
    expect(orderStateService.adminCancelOrder).not.toHaveBeenCalled();
  });
});
