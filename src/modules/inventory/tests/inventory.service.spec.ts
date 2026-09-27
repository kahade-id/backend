/**
 * GAP-D inventory — unit test (G275).
 *
 * Mencakup:
 * - reserveForOrder idempoten (2x panggil → 1x reservasi; klaim RESERVE:<orderId>)
 * - releaseForOrder idempoten (tanpa reservasi aktif → { released: 0 })
 * - decrementForOrder idempoten (2x panggil → alreadyDone)
 * - INSUFFICIENT_STOCK saat stok tidak mencukupi (anti-overselling)
 * - race: dua reserve konkuren untuk order sama → hanya satu yang memproses
 * - varian/produk invalid → error
 *
 * Prisma di-mock penuh — tidak butuh database. Sifat atomik anti-overselling
 * dijamin oleh single conditional UPDATE di atomicAdjust (diuji via SQL guard).
 */
import { ConflictException } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { InventoryService } from '../inventory.service';

function makeDelegate(extra: Record<string, jest.Mock> = {}) {
  return {
    findUnique: jest.fn().mockResolvedValue(null),
    findFirst: jest.fn().mockResolvedValue(null),
    findMany: jest.fn().mockResolvedValue([]),
    count: jest.fn().mockResolvedValue(0),
    create: jest.fn().mockResolvedValue({}),
    update: jest.fn().mockResolvedValue({}),
    updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
    ...extra,
  };
}

function makePrisma() {
  const delegates = {
    product: makeDelegate(),
    productVariant: makeDelegate(),
    orderItem: makeDelegate(),
    stockReservation: makeDelegate(),
    stockMovement: makeDelegate(),
    inventoryOperation: makeDelegate(),
    productModerationEvent: makeDelegate(),
  };
  const txDelegates = {
    product: makeDelegate(),
    productVariant: makeDelegate(),
    orderItem: makeDelegate(),
    stockReservation: makeDelegate(),
    stockMovement: makeDelegate(),
    inventoryOperation: makeDelegate(),
    productModerationEvent: makeDelegate(),
  };
  const tx = {
    ...txDelegates,
    $queryRawUnsafe: jest.fn(),
  };
  const prisma = {
    ...delegates,
    $transaction: jest.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(tx)),
  } as unknown as PrismaService & { $queryRawUnsafe: jest.Mock };
  // $queryRawUnsafe juga tersedia di root untuk jalur non-transaksional
  (prisma as unknown as Record<string, jest.Mock>).$queryRawUnsafe = jest.fn();
  return { prisma, delegates, txDelegates, tx };
}

function productRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'prod-1',
    sku: 'SKU-001',
    sellerId: 'seller-1',
    name: 'Produk Uji',
    status: 'ACTIVE',
    moderationStatus: 'APPROVED',
    quantityAvailable: 10,
    quantityReserved: 0,
    ...overrides,
  };
}

function orderLine(overrides: Record<string, unknown> = {}) {
  return {
    id: 'line-1',
    orderId: 'order-db-1',
    productId: 'prod-1',
    variantId: null,
    sku: 'SKU-001',
    productName: 'Produk Uji',
    qty: 2,
    unitPriceSen: BigInt(50000),
    ...overrides,
  };
}

describe('InventoryService (GAP-D stok)', () => {
  let ctx: ReturnType<typeof makePrisma>;
  let service: InventoryService;

  beforeEach(() => {
    ctx = makePrisma();
    service = new InventoryService(ctx.prisma);
    jest.clearAllMocks();
  });

  function mockResolveTarget(available = 10, reserved = 0) {
    ctx.delegates.product.findFirst.mockResolvedValue(productRow({ quantityAvailable: available, quantityReserved: reserved }));
    ctx.txDelegates.product.findFirst.mockResolvedValue(productRow({ quantityAvailable: available, quantityReserved: reserved }));
  }

  function mockAtomicAdjustSuccess() {
    // atomicAdjust sukses: kembalikan baris baru
    ctx.tx.$queryRawUnsafe.mockImplementation(async (_sql: string, rDelta: number, aDelta: number) => {
      return [{ quantityAvailable: 10 + aDelta, quantityReserved: 0 + rDelta }];
    });
  }

  describe('reserveForOrder', () => {
    it('idempoten: klaim kedua mengembalikan { reserved: 0 }', async () => {
      // Klaim pertama sukses, kedua gagal (unique violation)
      ctx.delegates.inventoryOperation.create
        .mockResolvedValueOnce({ idempotencyKey: 'RESERVE:order-db-1' })
        .mockRejectedValueOnce(new Error('Unique constraint failed'));
      ctx.delegates.orderItem.findMany.mockResolvedValue([orderLine()]);
      mockResolveTarget();
      mockAtomicAdjustSuccess();
      ctx.txDelegates.stockReservation.create.mockResolvedValue({});

      const first = await service.reserveForOrder('order-db-1');
      expect(first.reserved).toBe(2);
      expect(first.lines).toBe(1);

      const second = await service.reserveForOrder('order-db-1');
      expect(second).toEqual({ reserved: 0, lines: 0 });
      // Transaksi hanya jalan sekali
      expect(ctx.prisma.$transaction).toHaveBeenCalledTimes(1);
    });

    it('menolak saat stok tidak mencukupi (INSUFFICIENT_STOCK)', async () => {
      ctx.delegates.inventoryOperation.create.mockResolvedValue({});
      ctx.delegates.orderItem.findMany.mockResolvedValue([orderLine({ qty: 99 })]);
      mockResolveTarget(10, 0);
      // Simulasi guard sellable gagal: UPDATE tidak mengembalikan baris
      ctx.tx.$queryRawUnsafe.mockResolvedValue([]);

      await expect(service.reserveForOrder('order-db-1')).rejects.toMatchObject({
        response: expect.objectContaining({ code: 'INSUFFICIENT_STOCK' }),
      });
    });

    it('no-op untuk order tanpa order lines', async () => {
      ctx.delegates.inventoryOperation.create.mockResolvedValue({});
      ctx.delegates.orderItem.findMany.mockResolvedValue([]);

      const res = await service.reserveForOrder('order-db-1');
      expect(res).toEqual({ reserved: 0, lines: 0 });
      expect(ctx.prisma.$transaction).not.toHaveBeenCalled();
    });

    it('race: dua reserve konkuren untuk order sama → satu diproses', async () => {
      let claimCount = 0;
      ctx.delegates.inventoryOperation.create.mockImplementation(async () => {
        claimCount += 1;
        if (claimCount > 1) throw new Error('Unique constraint failed');
        return { idempotencyKey: 'RESERVE:order-db-1' };
      });
      ctx.delegates.orderItem.findMany.mockResolvedValue([orderLine()]);
      mockResolveTarget();
      mockAtomicAdjustSuccess();
      ctx.txDelegates.stockReservation.create.mockResolvedValue({});

      const [a, b] = await Promise.all([
        service.reserveForOrder('order-db-1'),
        service.reserveForOrder('order-db-1'),
      ]);
      const total = a.reserved + b.reserved;
      expect(total).toBe(2); // tepat satu yang mereservasi
      expect([a.reserved, b.reserved].sort()).toEqual([0, 2]);
    });
  });

  describe('releaseForOrder', () => {
    it('idempoten: tanpa reservasi aktif → { released: 0 }', async () => {
      ctx.delegates.stockReservation.findMany.mockResolvedValue([]);
      const res = await service.releaseForOrder('order-db-1', 'TEST');
      expect(res).toEqual({ released: 0 });
      expect(ctx.prisma.$transaction).not.toHaveBeenCalled();
    });

    it('melepas reservasi aktif dan menandai RELEASED', async () => {
      const reservation = {
        id: 'res-1', orderId: 'order-db-1', productId: 'prod-1',
        variantId: null, sku: 'SKU-001', qty: 2, status: 'ACTIVE',
      };
      ctx.delegates.stockReservation.findMany.mockResolvedValue([reservation]);
      ctx.txDelegates.product.findFirst.mockResolvedValue(productRow({ quantityAvailable: 10, quantityReserved: 2 }));
      ctx.tx.$queryRawUnsafe.mockResolvedValue([{ quantityAvailable: 10, quantityReserved: 0 }]);
      ctx.txDelegates.stockReservation.update.mockResolvedValue({});
      ctx.txDelegates.stockMovement.create.mockResolvedValue({});

      const res = await service.releaseForOrder('order-db-1', 'ORDER_CANCELLED');
      expect(res).toEqual({ released: 2 });
      expect(ctx.txDelegates.stockReservation.update).toHaveBeenCalledWith({
        where: { id: 'res-1' },
        data: expect.objectContaining({ status: 'RELEASED' }),
      });
    });
  });

  describe('decrementForOrder', () => {
    it('idempoten: klaim kedua → alreadyDone', async () => {
      ctx.delegates.inventoryOperation.create
        .mockResolvedValueOnce({})
        .mockRejectedValueOnce(new Error('Unique constraint failed'));
      ctx.delegates.orderItem.findMany.mockResolvedValue([orderLine()]);
      mockResolveTarget(10, 2);
      ctx.txDelegates.stockReservation.findFirst.mockResolvedValue({ id: 'res-1', qty: 2 });
      ctx.tx.$queryRawUnsafe.mockResolvedValue([{ quantityAvailable: 8, quantityReserved: 0 }]);
      ctx.txDelegates.stockReservation.update.mockResolvedValue({});
      ctx.txDelegates.stockMovement.create.mockResolvedValue({});

      const first = await service.decrementForOrder('order-db-1');
      expect(first.alreadyDone).toBe(false);
      expect(first.deducted).toBe(2);

      const second = await service.decrementForOrder('order-db-1');
      expect(second).toEqual({ deducted: 0, alreadyDone: true });
    });
  });

  describe('resolveTarget', () => {
    it('menolak produk yang tidak dapat dibeli (status non-ACTIVE)', async () => {
      ctx.delegates.inventoryOperation.create.mockResolvedValue({});
      ctx.delegates.orderItem.findMany.mockResolvedValue([orderLine()]);
      ctx.delegates.product.findFirst.mockResolvedValue(productRow({ status: 'ARCHIVED' }));
      ctx.txDelegates.product.findFirst.mockResolvedValue(productRow({ status: 'ARCHIVED' }));

      await expect(service.reserveForOrder('order-db-1')).rejects.toBeInstanceOf(ConflictException);
    });

    it('menolak varian yang tidak ditemukan', async () => {
      ctx.delegates.inventoryOperation.create.mockResolvedValue({});
      ctx.delegates.orderItem.findMany.mockResolvedValue([orderLine({ variantId: 'var-x' })]);
      ctx.delegates.product.findFirst.mockResolvedValue(productRow());
      ctx.txDelegates.product.findFirst.mockResolvedValue(productRow());
      ctx.txDelegates.productVariant.findFirst.mockResolvedValue(null);

      await expect(service.reserveForOrder('order-db-1')).rejects.toThrow();
    });
  });

  describe('atomicAdjust SQL guard (anti-overselling)', () => {
    it('menyertakan guard sellable saat reserve', async () => {
      ctx.delegates.inventoryOperation.create.mockResolvedValue({});
      ctx.delegates.orderItem.findMany.mockResolvedValue([orderLine({ qty: 3 })]);
      mockResolveTarget(10, 0);
      ctx.tx.$queryRawUnsafe.mockResolvedValue([{ quantityAvailable: 10, quantityReserved: 3 }]);
      ctx.txDelegates.stockReservation.create.mockResolvedValue({});
      ctx.txDelegates.stockMovement.create.mockResolvedValue({});

      await service.reserveForOrder('order-db-1');

      expect(ctx.tx.$queryRawUnsafe).toHaveBeenCalled();
      const [sql, rDelta, aDelta, id, need] = ctx.tx.$queryRawUnsafe.mock.calls[0];
      expect(sql).toContain('quantityAvailable" - s."quantityReserved") >= $4');
      expect(rDelta).toBe(3);
      expect(aDelta).toBe(0);
      expect(need).toBe(3);
      // Guard non-negatif selalu ada
      expect(sql).toContain('s."quantityAvailable" + $2 >= 0');
      expect(sql).toContain('s."quantityReserved" + $1 >= 0');
    });
  });
});
