/**
 * Batch 139 BE-API1 — test item 110–112.
 *
 * 110: GET /v1/orders → `paymentDeadlineAt` + `confirmationDeadlineAt` di daftar.
 * 111: GET /v1/orders/:id → `returnWindowUntil` (turunan, null bila tak berlaku).
 * 112: GET /v1/orders/:id → `availableActions: string[]` (read-only).
 */
import { OrdersService } from '../orders.service';
import { OrderStatus, OrderType } from '@prisma/client';

const BUYER_ID = 'buyer-1';
const SELLER_ID = 'seller-1';

function orderRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'ord-internal-1',
    orderId: 'ORD-001',
    title: 'Kopi susu 1kg',
    description: 'Deskripsi order',
    orderType: OrderType.PHYSICAL_GOODS,
    status: OrderStatus.WAITING_PAYMENT,
    buyerId: BUYER_ID,
    sellerId: SELLER_ID,
    orderValue: 10000000n,
    feeAmount: 100000n,
    feeResponsibility: 'BUYER',
    buyerFeeAmount: 100000n,
    sellerFeeAmount: 0n,
    buyerPayAmount: 10100000n,
    sellerReceiveAmount: 10000000n,
    voucherDiscount: 0n,
    isKahadePlus: false,
    feeRate: 1,
    deliveryDeadlineDays: 3,
    deliveryDeadlineAt: null,
    paymentDeadlineAt: new Date('2026-09-29T00:00:00.000Z'),
    confirmationDeadlineAt: new Date('2026-09-30T00:00:00.000Z'),
    processingDeadlineAt: null,
    trackingNumber: null,
    courierName: null,
    trackingNotes: null,
    createdByBuyer: true,
    createdAt: new Date('2026-09-28T00:00:00.000Z'),
    confirmedAt: null,
    paidAt: null,
    completedAt: null,
    cancelledAt: null,
    shippedAt: null,
    processedAt: null,
    disputedAt: null,
    updatedAt: new Date('2026-09-28T00:00:00.000Z'),
    deletedAt: null,
    buyer: { userId: 'USR-BUYER', username: 'buyer', fullName: 'Buyer', avatarUrl: null },
    seller: { userId: 'USR-SELLER', username: 'seller', fullName: 'Seller', avatarUrl: null },
    voucher: null,
    statusHistories: [],
    dispute: null,
    chatRoom: null,
    ...overrides,
  };
}

function makeService(prisma: Record<string, unknown>) {
  const service = Object.create(OrdersService.prototype) as OrdersService;
  (service as any).prisma = prisma;
  return service;
}

describe('Batch 139 BE-API1 — item 110: deadline bayar & konfirmasi di GET /v1/orders', () => {
  it('daftar order memuat paymentDeadlineAt + confirmationDeadlineAt', async () => {
    const prisma = {
      order: {
        findMany: jest.fn(async () => [orderRow()]),
        count: jest.fn(async () => 1),
      },
    };
    const service = makeService(prisma);
    const res = (await service.getOrders(BUYER_ID, 1, 20)) as {
      orders: Array<{ paymentDeadlineAt: Date | null; confirmationDeadlineAt: Date | null }>;
    };
    expect(res.orders).toHaveLength(1);
    expect(res.orders[0].paymentDeadlineAt).toEqual(new Date('2026-09-29T00:00:00.000Z'));
    expect(res.orders[0].confirmationDeadlineAt).toEqual(new Date('2026-09-30T00:00:00.000Z'));
  });
});

describe('Batch 139 BE-API1 — item 111: returnWindowUntil di GET /v1/orders/:id', () => {
  function makeDetailService(row: Record<string, unknown>, policy: { returnWindowDays: number } | null) {
    const prisma = {
      order: { findFirst: jest.fn(async () => row) },
      rating: { findUnique: jest.fn(async () => null) },
      returnPolicy: { findFirst: jest.fn(async () => policy) },
      chatRoom: { findUnique: jest.fn(async () => null) },
    };
    return makeService(prisma);
  }

  it('COMPLETED → completedAt + returnWindowDays kebijakan', async () => {
    const completedAt = new Date('2026-09-20T00:00:00.000Z');
    const service = makeDetailService(
      orderRow({ status: OrderStatus.COMPLETED, completedAt, paidAt: completedAt }),
      { returnWindowDays: 7 },
    );
    const res = (await service.getOrderDetail(BUYER_ID, 'ORD-001')) as {
      order: { returnWindowUntil: Date | null };
    };
    expect(res.order.returnWindowUntil).toEqual(new Date('2026-09-27T00:00:00.000Z'));
  });

  it('fallback DEFAULT_RETURN_WINDOW_DAYS bila policy belum di-seed', async () => {
    const completedAt = new Date('2026-09-20T00:00:00.000Z');
    const service = makeDetailService(
      orderRow({ status: OrderStatus.COMPLETED, completedAt, paidAt: completedAt }),
      null,
    );
    const res = (await service.getOrderDetail(BUYER_ID, 'ORD-001')) as {
      order: { returnWindowUntil: Date | null };
    };
    expect(res.order.returnWindowUntil).toEqual(new Date('2026-09-27T00:00:00.000Z'));
  });

  it('belum COMPLETED → null', async () => {
    const service = makeDetailService(orderRow({ status: OrderStatus.IN_DELIVERY }), {
      returnWindowDays: 7,
    });
    const res = (await service.getOrderDetail(BUYER_ID, 'ORD-001')) as {
      order: { returnWindowUntil: Date | null };
    };
    expect(res.order.returnWindowUntil).toBeNull();
  });
});

describe('Batch 139 BE-API1 — item 112: availableActions di GET /v1/orders/:id', () => {
  function makeDetailService(row: Record<string, unknown>) {
    const prisma = {
      order: { findFirst: jest.fn(async () => row) },
      rating: { findUnique: jest.fn(async () => null) },
      returnPolicy: { findFirst: jest.fn(async () => ({ returnWindowDays: 30 })) },
      chatRoom: { findUnique: jest.fn(async () => null) },
    };
    return makeService(prisma);
  }

  async function actionsFor(status: OrderStatus, viewerId: string, extra: Record<string, unknown> = {}) {
    const service = makeDetailService(orderRow({ status, ...extra }));
    const res = (await service.getOrderDetail(viewerId, 'ORD-001')) as {
      order: { availableActions: string[] };
    };
    return res.order.availableActions;
  }

  it('WAITING_PAYMENT + buyer → PAY, CANCEL', async () => {
    expect(await actionsFor(OrderStatus.WAITING_PAYMENT, BUYER_ID)).toEqual(['PAY', 'CANCEL']);
  });

  it('WAITING_PAYMENT + seller → CANCEL saja (tanpa PAY)', async () => {
    expect(await actionsFor(OrderStatus.WAITING_PAYMENT, SELLER_ID)).toEqual(['CANCEL']);
  });

  it('WAITING_CONFIRMATION + seller → CONFIRM, CANCEL', async () => {
    expect(await actionsFor(OrderStatus.WAITING_CONFIRMATION, SELLER_ID)).toEqual([
      'CONFIRM',
      'CANCEL',
    ]);
  });

  it('PROCESSING + seller → SHIP, DISPUTE', async () => {
    expect(await actionsFor(OrderStatus.PROCESSING, SELLER_ID)).toEqual(['SHIP', 'DISPUTE']);
  });

  it('IN_DELIVERY + buyer → REVIEW_DELIVERY, DISPUTE', async () => {
    expect(await actionsFor(OrderStatus.IN_DELIVERY, BUYER_ID)).toEqual([
      'REVIEW_DELIVERY',
      'DISPUTE',
    ]);
  });

  it('IN_DELIVERY + seller → VIEW_PROOF, DISPUTE, EXTEND', async () => {
    expect(await actionsFor(OrderStatus.IN_DELIVERY, SELLER_ID)).toEqual([
      'VIEW_PROOF',
      'DISPUTE',
      'EXTEND',
    ]);
  });

  it('COMPLETED + buyer dalam jendela → RATE, RETURN', async () => {
    const completedAt = new Date(Date.now() - 2 * 86_400_000); // 2 hari lalu
    const actions = await actionsFor(OrderStatus.COMPLETED, BUYER_ID, {
      completedAt,
      paidAt: completedAt,
    });
    expect(actions).toEqual(['RATE', 'RETURN']);
  });

  it('COMPLETED lewat jendela rating & retur → kosong', async () => {
    const completedAt = new Date(Date.now() - 40 * 86_400_000); // 40 hari lalu
    const actions = await actionsFor(OrderStatus.COMPLETED, BUYER_ID, {
      completedAt,
      paidAt: completedAt,
    });
    expect(actions).toEqual([]);
  });

  it('CANCELLED → kosong (tidak ada aksi)', async () => {
    expect(await actionsFor(OrderStatus.CANCELLED, BUYER_ID)).toEqual([]);
  });

  it('bukan partisipan → 403 (perilaku lama tak berubah)', async () => {
    const service = makeDetailService(orderRow({}));
    await expect(service.getOrderDetail('orang-asing', 'ORD-001')).rejects.toMatchObject({
      name: 'ForbiddenException',
    });
  });
});
