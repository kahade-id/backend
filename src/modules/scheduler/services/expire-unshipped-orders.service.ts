import { Injectable, Logger, Optional } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { randomUUID } from 'crypto';
import { PrismaService } from '../../../prisma/prisma.service';
import { RedisService } from '../../../redis/redis.service';
import { ensureRedisAvailable } from '../../../common/utils/redis-health.util';
import { UnshippedOrderCancelService } from '../../orders/unshipped-order-cancel.service';
// GAP-D (G256): pelepasan reservasi stok saat order kedaluwarsa — @Optional(),
// best-effort, no-op untuk order tanpa order lines katalog.
import { InventoryService } from '../../inventory/inventory.service';

/**
 * Wave 3 P0 (2026-09-28) — sweep auto-cancel + auto-refund order yang
 * melewati batas kirim tanpa pengiriman.
 *
 * Sebelum fix ini tidak ada sweep untuk order escrow regular yang PROCESSING
 * melewati batas kirim — dana buyer nyangkut di escrow sampai buyer dispute
 * manual. KEPUTUSAN USER FINAL: order semacam itu HARUS auto-cancel +
 * auto-refund ke buyer.
 *
 * Pola sama seperti sweep lain: @Cron tiap 5 menit + Redis distributed lock
 * (single-flight antar instance) + batch 200 + idempoten (guard status di
 * UnshippedOrderCancelService + conditional update di adminCancelOrder).
 * Order dengan dispute berjalan di-skip (fail closed).
 */
@Injectable()
export class ExpireUnshippedOrdersService {
  private readonly logger = new Logger(ExpireUnshippedOrdersService.name);

  constructor(
    private prisma: PrismaService,
    private redis: RedisService,
    private unshippedCancelService: UnshippedOrderCancelService,
    @Optional() private inventoryService?: InventoryService,
  ) {}

  // SCH-XXX: tiap 5 menit — samakan kadens dengan commerce refund sweep.
  @Cron('*/5 * * * *', { name: 'expire-unshipped-orders' })
  async expireUnshippedOrders(): Promise<void> {
    if (!(await ensureRedisAvailable(this.redis, 'expire-unshipped-orders'))) return;

    const lockKey = 'cron_lock:expire_unshipped_orders';
    const lockToken = randomUUID();
    const acquired = await this.redis.setNx(lockKey, lockToken, 600);
    if (!acquired) return;

    const now = new Date();
    try {
      const dueOrders = await this.unshippedCancelService.findDueUnshippedOrders(200, now);
      if (dueOrders.length === 0) return;

      this.logger.log(
        `[SECURITY] expire-unshipped-orders: ${dueOrders.length} order PROCESSING melewati batas kirim — auto-cancel + refund`,
      );

      let cancelled = 0;
      let skipped = 0;
      let failed = 0;
      for (const order of dueOrders) {
        try {
          const result = await this.unshippedCancelService.cancelUnshippedOrder(
            order.id,
            'system:expire-unshipped-orders',
            'Auto-cancel: penjual tidak mengirim melewati batas kirim — dana dikembalikan ke buyer',
          );
          if (result.outcome === 'CANCELLED_REFUNDED') {
            cancelled++;
            // GAP-D (G256): lepaskan reservasi stok katalog. Best-effort —
            // tidak pernah throw; no-op bila tidak ada order lines katalog.
            if (this.inventoryService) {
              const inventory = this.inventoryService;
              await inventory.safeReleaseForOrder(order.id, 'ORDER_EXPIRED:TIMEOUT_PROCESSING');
            }
          } else if (result.outcome === 'FAILED') {
            failed++;
          } else {
            skipped++;
          }
        } catch (err: unknown) {
          failed++;
          const errMsg = err instanceof Error ? err.message : String(err);
          this.logger.error(`[SECURITY] expire-unshipped-orders FAILED order=${order.orderId}: ${errMsg}`);
        }
      }

      this.logger.log(
        `[SECURITY] expire-unshipped-orders selesai: cancelled=${cancelled} skipped=${skipped} failed=${failed}`,
      );
    } catch (error) {
      this.logger.error('[SECURITY] ExpireUnshippedOrders FAILED', error);
    } finally {
      await this.redis
        .releaseLock(lockKey, lockToken)
        .catch(err =>
          this.logger.warn(`silent-catch: ${err instanceof Error ? err.message : String(err)}`),
        );
    }
  }
}
