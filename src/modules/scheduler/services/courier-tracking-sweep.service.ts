/**
 * Audit alamat & kurir A03/A04 (2026-10-10) — sweep tracking kurir.
 *
 * Sebelum ini status pengiriman HANYA berubah lewat webhook provider atau
 * tombol "Muat ulang" manual. Provider yang tidak mengirim webhook (termasuk
 * semua provider mock saat ini) membuat timeline diam selamanya — "tracking
 * tidak update". Sweep ini:
 *   1. Menarik tracking (pull) untuk shipment BOOKED non-manual yang masih
 *      aktif dan event terakhirnya lebih tua dari `PULL_AFTER_HOURS`.
 *   2. Mengirim alert "tracking macet" SEKALI per shipment (G247) bila tidak
 *      ada event selama `STALE_ALERT_HOURS` — kunci idempoten
 *      `staleAlertSentAt` di CourierService.notifyStaleTracking.
 *
 * Pola sama seperti sweep lain: @Cron + Redis lock single-flight + batch kecil
 * + tiap shipment terisolasi (satu gagal tidak menghentikan yang lain).
 * Timeout provider sudah ditangani CourierService (→ UNKNOWN, bukan error).
 */
import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { ShipmentBookingState, ShipmentStatus } from '@prisma/client';
import { randomUUID } from 'crypto';
import { PrismaService } from '../../../prisma/prisma.service';
import { RedisService } from '../../../redis/redis.service';
import { ensureRedisAvailable } from '../../../common/utils/redis-health.util';
import { CourierService } from '../../courier/courier.service';

export const TRACKING_PULL_AFTER_HOURS = 2;
export const TRACKING_STALE_ALERT_HOURS = 48;
const BATCH_SIZE = 50;
const ACTIVE_STATUSES: ShipmentStatus[] = [
  ShipmentStatus.CREATED,
  ShipmentStatus.PICKED_UP,
  ShipmentStatus.IN_TRANSIT,
  ShipmentStatus.OUT_FOR_DELIVERY,
  ShipmentStatus.EXCEPTION,
  ShipmentStatus.UNKNOWN,
];

@Injectable()
export class CourierTrackingSweepService {
  private readonly logger = new Logger(CourierTrackingSweepService.name);

  constructor(
    private prisma: PrismaService,
    private redis: RedisService,
    private courier: CourierService,
  ) {}

  @Cron('*/30 * * * *', { name: 'courier-tracking-sweep' })
  async sweep(): Promise<void> {
    if (!(await ensureRedisAvailable(this.redis, 'courier-tracking-sweep'))) return;
    const lockKey = 'cron_lock:courier_tracking_sweep';
    const lockToken = randomUUID();
    if (!(await this.redis.setNx(lockKey, lockToken, 1500))) return;
    try {
      const result = await this.runOnce(new Date());
      if (result.scanned > 0) {
        this.logger.log(
          `courier-tracking-sweep: scanned=${result.scanned} refreshed=${result.refreshed} timeout=${result.timeout} staleAlerts=${result.staleAlerts} failed=${result.failed}`,
        );
      }
    } catch (err: unknown) {
      this.logger.error(`courier-tracking-sweep gagal: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      await this.redis.releaseLock(lockKey, lockToken);
    }
  }

  /** Dipisah agar bisa diuji tanpa cron/lock. */
  async runOnce(now: Date): Promise<{ scanned: number; refreshed: number; timeout: number; staleAlerts: number; failed: number }> {
    const pullCutoff = new Date(now.getTime() - TRACKING_PULL_AFTER_HOURS * 3600 * 1000);
    const staleCutoff = new Date(now.getTime() - TRACKING_STALE_ALERT_HOURS * 3600 * 1000);
    const shipments = await this.prisma.shipment.findMany({
      where: {
        bookingState: ShipmentBookingState.BOOKED,
        isManual: false,
        trackingNumber: { not: null },
        status: { in: ACTIVE_STATUSES },
        OR: [{ lastEventAt: { lt: pullCutoff } }, { lastEventAt: null, createdAt: { lt: pullCutoff } }],
      },
      orderBy: { lastEventAt: 'asc' },
      take: BATCH_SIZE,
      select: {
        id: true, orderId: true, buyerId: true, sellerId: true, providerCode: true,
        trackingNumber: true, isManual: true, status: true, lastEventAt: true, createdAt: true, staleAlertSentAt: true,
      },
    });

    let refreshed = 0;
    let timeout = 0;
    let staleAlerts = 0;
    let failed = 0;
    for (const s of shipments) {
      try {
        const result = await this.courier.refreshTrackingSystem(s);
        if (result.timeout) timeout++;
        else refreshed++;
        // Alert macet hanya bila setelah pull pun tidak ada event baru.
        const lastSeen = s.lastEventAt ?? s.createdAt;
        if (result.events === 0 && !s.staleAlertSentAt && lastSeen.getTime() < staleCutoff.getTime()) {
          if (await this.courier.notifyStaleTracking(s)) staleAlerts++;
        }
      } catch (err: unknown) {
        failed++;
        this.logger.warn(`Sweep tracking shipment=${s.id} gagal: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return { scanned: shipments.length, refreshed, timeout, staleAlerts, failed };
  }
}
