import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { OrdersService } from './orders.service';

/**
 * Audit 2026-10-03 — Worker C2.
 * (c) SEC-401: GET /v1/orders/:orderId/payment-status — hanya buyer/seller
 * (selain itu 403); PAID hanya bila paymentTransaction SUCCESS terverifikasi.
 */
describe('OrdersService.getCanonicalPaymentStatus (SEC-401, audit 2026-10-03)', () => {
  function makeService() {
    const prisma: any = {
      order: { findUnique: jest.fn() },
      paymentTransaction: { findFirst: jest.fn() },
    };
    const config = { get: () => undefined };
    const svc = new OrdersService(prisma, {} as any, {} as any, {} as any, config as any, {} as any, {} as any);
    return { svc, prisma };
  }

  const order = { id: 'oid1', orderId: 'ORD-20261003-0001', buyerId: 'buyer1', sellerId: 'seller1' };

  it('non-buyer/non-seller → 403 NOT_ORDER_PARTICIPANT', async () => {
    const { svc, prisma } = makeService();
    prisma.order.findUnique.mockResolvedValue(order);

    const err = await svc.getCanonicalPaymentStatus('ORD-20261003-0001', 'stranger').catch((e) => e);
    expect(err).toBeInstanceOf(ForbiddenException);
    expect(err.response.code).toBe('NOT_ORDER_PARTICIPANT');
    // Tidak ada query pembayaran untuk pihak yang tidak berhak.
    expect(prisma.paymentTransaction.findFirst).not.toHaveBeenCalled();
  });

  it('order tidak ada → 404 ORDER_NOT_FOUND', async () => {
    const { svc, prisma } = makeService();
    prisma.order.findUnique.mockResolvedValue(null);

    const err = await svc.getCanonicalPaymentStatus('ORD-XXXX', 'buyer1').catch((e) => e);
    expect(err).toBeInstanceOf(NotFoundException);
    expect(err.response.code).toBe('ORDER_NOT_FOUND');
  });

  it('buyer + payment SUCCESS → PAID + paidAt', async () => {
    const { svc, prisma } = makeService();
    prisma.order.findUnique.mockResolvedValue(order);
    const paidAt = new Date('2026-10-03T01:00:00Z');
    prisma.paymentTransaction.findFirst.mockResolvedValue({ status: 'SUCCESS', paidAt });

    const out = await svc.getCanonicalPaymentStatus('ORD-20261003-0001', 'buyer1');
    expect(out).toEqual({ orderId: 'ORD-20261003-0001', status: 'PAID', paidAt, isBuyer: true });
  });

  it('seller boleh membaca status kanonis (isBuyer=false)', async () => {
    const { svc, prisma } = makeService();
    prisma.order.findUnique.mockResolvedValue(order);
    prisma.paymentTransaction.findFirst.mockResolvedValue({ status: 'PENDING', paidAt: null });

    const out = await svc.getCanonicalPaymentStatus('ORD-20261003-0001', 'seller1');
    expect(out.status).toBe('PENDING');
    expect(out.isBuyer).toBe(false);
  });

  it('tanpa payment → PENDING; EXPIRED/CANCELLED/FAILED dipetakan apa adanya', async () => {
    const { svc, prisma } = makeService();
    prisma.order.findUnique.mockResolvedValue(order);
    prisma.paymentTransaction.findFirst.mockResolvedValue(null);
    expect((await svc.getCanonicalPaymentStatus('ORD-20261003-0001', 'buyer1')).status).toBe('PENDING');

    for (const db of ['EXPIRED', 'CANCELLED', 'FAILED', 'REFUNDED'] as const) {
      prisma.paymentTransaction.findFirst.mockResolvedValue({ status: db, paidAt: null });
      const out = await svc.getCanonicalPaymentStatus('ORD-20261003-0001', 'buyer1');
      expect(out.status).toBe(db);
      expect(out.paidAt).toBeNull();
    }
  });

  it('payment PENDING tidak pernah dilaporkan sebagai PAID', async () => {
    const { svc, prisma } = makeService();
    prisma.order.findUnique.mockResolvedValue(order);
    prisma.paymentTransaction.findFirst.mockResolvedValue({ status: 'PENDING', paidAt: new Date() });

    const out = await svc.getCanonicalPaymentStatus('ORD-20261003-0001', 'buyer1');
    expect(out.status).toBe('PENDING');
    expect(out.paidAt).toBeNull();
  });
});
