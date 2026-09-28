jest.mock('../../../common/utils/redis-health.util', () => ({
  ensureRedisAvailable: jest.fn().mockResolvedValue(true),
}));

import { ExpireUnshippedOrdersService } from '../services/expire-unshipped-orders.service';

/**
 * Wave 3 P0 — sweep expire-unshipped-orders (5 menit): single-flight via
 * Redis lock, delegasi ke UnshippedOrderCancelService, lock selalu dilepas.
 */
describe('ExpireUnshippedOrdersService', () => {
  const prisma: any = {};
  const redis: any = {
    setNx: jest.fn(),
    get: jest.fn(),
    renewLock: jest.fn(),
    releaseLock: jest.fn(),
  };
  const unshippedCancelService: any = {
    findDueUnshippedOrders: jest.fn(),
    cancelUnshippedOrder: jest.fn(),
  };
  const inventoryService: any = { safeReleaseForOrder: jest.fn() };

  let service: ExpireUnshippedOrdersService;

  beforeEach(() => {
    jest.clearAllMocks();
    redis.setNx.mockResolvedValue(true);
    redis.releaseLock.mockResolvedValue(true);
    unshippedCancelService.findDueUnshippedOrders.mockResolvedValue([]);
    service = new ExpireUnshippedOrdersService(prisma, redis, unshippedCancelService, inventoryService);
  });

  it('tidak jalan bila lock tidak didapat (single-flight)', async () => {
    redis.setNx.mockResolvedValue(false);
    await service.expireUnshippedOrders();
    expect(unshippedCancelService.findDueUnshippedOrders).not.toHaveBeenCalled();
    expect(redis.releaseLock).not.toHaveBeenCalled();
  });

  it('tidak jalan bila redis tidak tersedia', async () => {
    const { ensureRedisAvailable } = jest.requireMock('../../../common/utils/redis-health.util');
    ensureRedisAvailable.mockResolvedValueOnce(false);
    await service.expireUnshippedOrders();
    expect(redis.setNx).not.toHaveBeenCalled();
  });

  it('cancel + refund order due, lepas stok, lalu lepas lock', async () => {
    const due = { id: 'o1', orderId: 'ORD-1', buyerPayAmount: BigInt(100000) };
    unshippedCancelService.findDueUnshippedOrders.mockResolvedValue([due]);
    unshippedCancelService.cancelUnshippedOrder.mockResolvedValue({ orderId: 'ORD-1', outcome: 'CANCELLED_REFUNDED' });

    await service.expireUnshippedOrders();

    expect(unshippedCancelService.cancelUnshippedOrder).toHaveBeenCalledWith(
      'o1',
      'system:expire-unshipped-orders',
      expect.stringContaining('batas kirim'),
    );
    expect(inventoryService.safeReleaseForOrder).toHaveBeenCalledWith('o1', 'ORDER_EXPIRED:TIMEOUT_PROCESSING');
    expect(redis.releaseLock).toHaveBeenCalledWith('cron_lock:expire_unshipped_orders', expect.any(String));
  });

  it('tidak lepas stok untuk outcome non-cancel', async () => {
    const due = { id: 'o2', orderId: 'ORD-2', buyerPayAmount: BigInt(100000) };
    unshippedCancelService.findDueUnshippedOrders.mockResolvedValue([due]);
    unshippedCancelService.cancelUnshippedOrder.mockResolvedValue({ orderId: 'ORD-2', outcome: 'SKIPPED_DISPUTED' });

    await service.expireUnshippedOrders();

    expect(inventoryService.safeReleaseForOrder).not.toHaveBeenCalled();
    expect(redis.releaseLock).toHaveBeenCalled();
  });

  it('tetap lepas lock walau batch query throw', async () => {
    unshippedCancelService.findDueUnshippedOrders.mockRejectedValue(new Error('db down'));
    await service.expireUnshippedOrders();
    expect(redis.releaseLock).toHaveBeenCalled();
  });
});
