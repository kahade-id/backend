/**
 * courier-tracking-sweep.service.spec.ts — audit alamat & kurir A03/A04.
 * Sweep menarik tracking untuk shipment aktif yang sunyi, dan mengirim alert
 * macet SEKALI (idempoten lewat CourierService.notifyStaleTracking).
 */
jest.mock('../../../common/utils/redis-health.util', () => ({
  ensureRedisAvailable: jest.fn().mockResolvedValue(true),
}));

import { ShipmentBookingState, ShipmentStatus } from '@prisma/client';
import {
  CourierTrackingSweepService,
  TRACKING_PULL_AFTER_HOURS,
  TRACKING_STALE_ALERT_HOURS,
} from '../services/courier-tracking-sweep.service';

const HOUR = 3600 * 1000;

describe('CourierTrackingSweepService', () => {
  const now = new Date('2026-10-10T12:00:00Z');
  const prisma = { shipment: { findMany: jest.fn() } };
  const redis = { setNx: jest.fn(), releaseLock: jest.fn() };
  const courier = { refreshTrackingSystem: jest.fn(), notifyStaleTracking: jest.fn() };
  let service: CourierTrackingSweepService;

  const mkShipment = (over: Record<string, unknown> = {}) => ({
    id: 'ship-1', orderId: 'order-db-1', buyerId: 'b', sellerId: 's', providerCode: 'jne',
    trackingNumber: 'JNE1', isManual: false, status: ShipmentStatus.IN_TRANSIT,
    lastEventAt: new Date(now.getTime() - 3 * HOUR), createdAt: new Date(now.getTime() - 24 * HOUR),
    staleAlertSentAt: null, ...over,
  });

  beforeEach(() => {
    jest.clearAllMocks();
    redis.setNx.mockResolvedValue(true);
    redis.releaseLock.mockResolvedValue(true);
    courier.refreshTrackingSystem.mockResolvedValue({ status: ShipmentStatus.IN_TRANSIT, events: 1, timeout: false });
    courier.notifyStaleTracking.mockResolvedValue(true);
    service = new CourierTrackingSweepService(prisma as never, redis as never, courier as never);
  });

  it('hanya memilih shipment BOOKED non-manual aktif yang sunyi > ambang pull', async () => {
    prisma.shipment.findMany.mockResolvedValue([]);
    await service.runOnce(now);
    const where = prisma.shipment.findMany.mock.calls[0][0].where;
    expect(where.bookingState).toBe(ShipmentBookingState.BOOKED);
    expect(where.isManual).toBe(false);
    expect(where.status.in).not.toContain(ShipmentStatus.DELIVERED);
    expect(where.status.in).not.toContain(ShipmentStatus.RETURNED);
    const cutoff = where.OR[0].lastEventAt.lt as Date;
    expect(now.getTime() - cutoff.getTime()).toBe(TRACKING_PULL_AFTER_HOURS * HOUR);
  });

  it('menarik tracking tiap shipment; satu gagal tidak menghentikan yang lain', async () => {
    prisma.shipment.findMany.mockResolvedValue([mkShipment({ id: 'a' }), mkShipment({ id: 'b' })]);
    courier.refreshTrackingSystem
      .mockRejectedValueOnce(new Error('provider meledak'))
      .mockResolvedValueOnce({ status: ShipmentStatus.IN_TRANSIT, events: 2, timeout: false });
    const result = await service.runOnce(now);
    expect(courier.refreshTrackingSystem).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ scanned: 2, refreshed: 1, failed: 1, staleAlerts: 0 });
  });

  it('alert macet hanya bila tidak ada event baru DAN sunyi > ambang stale, belum pernah dialert', async () => {
    const stale = mkShipment({ id: 'stale', lastEventAt: new Date(now.getTime() - (TRACKING_STALE_ALERT_HOURS + 1) * HOUR) });
    const fresh = mkShipment({ id: 'fresh' });
    const alreadyAlerted = mkShipment({ id: 'done', lastEventAt: stale.lastEventAt, staleAlertSentAt: new Date() });
    prisma.shipment.findMany.mockResolvedValue([stale, fresh, alreadyAlerted]);
    courier.refreshTrackingSystem.mockResolvedValue({ status: ShipmentStatus.IN_TRANSIT, events: 0, timeout: false });
    const result = await service.runOnce(now);
    expect(courier.notifyStaleTracking).toHaveBeenCalledTimes(1);
    expect(courier.notifyStaleTracking).toHaveBeenCalledWith(expect.objectContaining({ id: 'stale' }));
    expect(result.staleAlerts).toBe(1);
  });

  it('timeout provider dihitung terpisah, bukan sebagai gagal', async () => {
    prisma.shipment.findMany.mockResolvedValue([mkShipment()]);
    courier.refreshTrackingSystem.mockResolvedValue({ status: ShipmentStatus.UNKNOWN, events: 0, timeout: true });
    const result = await service.runOnce(now);
    expect(result).toMatchObject({ timeout: 1, failed: 0, refreshed: 0 });
  });

  it('sweep() single-flight: lock gagal → tidak memindai', async () => {
    redis.setNx.mockResolvedValue(false);
    await service.sweep();
    expect(prisma.shipment.findMany).not.toHaveBeenCalled();
  });

  it('sweep() melepas lock walau runOnce melempar', async () => {
    prisma.shipment.findMany.mockRejectedValue(new Error('db down'));
    await service.sweep();
    expect(redis.releaseLock).toHaveBeenCalledWith('cron_lock:courier_tracking_sweep', expect.any(String));
  });
});
