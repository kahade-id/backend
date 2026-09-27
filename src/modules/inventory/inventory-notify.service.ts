/**
 * GAP-D stok — notifikasi stok ke seller (G273).
 *
 * Memakai pipeline notifikasi existing (NotificationQueueService) dengan tipe
 * existing terdekat `SYSTEM_ANNOUNCEMENT`; payload `pushData.type` dipakai
 * frontend untuk deep-link ke layar produk seller:
 * - PRODUCT_STOCK_OUT      → stok habis
 * - PRODUCT_STOCK_LOW      → stok menipis (melewati ambang per SKU)
 * - PRODUCT_STOCK_RESTORED → stok pulih dari habis
 *
 * Dedup 5 menit di queue memakai (userId, type, actionUrl=/products/<id>)
 * sehingga satu produk tidak membanjiri seller.
 */
import { Injectable, Logger } from '@nestjs/common';
import { NotificationType } from '@prisma/client';
import { NotificationQueueService } from '../queue/notification-queue.service';

export type StockAlertKind = 'OUT' | 'LOW' | 'RESTORED';

const KIND_COPY: Record<StockAlertKind, { title: string; body: (name: string, sku: string) => string }> = {
  OUT: {
    title: 'Stok habis',
    body: (name, sku) => `"${name}" (${sku}) kehabisan stok. Listing otomatis ditandai habis sampai Anda menambah stok.`,
  },
  LOW: {
    title: 'Stok menipis',
    body: (name, sku) => `"${name}" (${sku}) stoknya menipis dan melewati ambang peringatan. Pertimbangkan restock.`,
  },
  RESTORED: {
    title: 'Stok pulih',
    body: (name, sku) => `"${name}" (${sku}) kembali tersedia. Listing otomatis aktif kembali.`,
  },
};

@Injectable()
export class InventoryNotifyService {
  private readonly logger = new Logger(InventoryNotifyService.name);

  constructor(private readonly notificationQueue: NotificationQueueService) {}

  async notifyStockAlert(params: {
    sellerId: string;
    productId: string;
    productName: string;
    sku: string;
    kind: StockAlertKind;
  }): Promise<void> {
    const copy = KIND_COPY[params.kind];
    try {
      await this.notificationQueue.enqueue({
        userId: params.sellerId,
        type: NotificationType.SYSTEM_ANNOUNCEMENT,
        title: copy.title,
        body: copy.body(params.productName, params.sku),
        pushData: {
          type: `PRODUCT_STOCK_${params.kind}`,
          productId: params.productId,
          sku: params.sku,
        },
        actionUrl: `/products/${params.productId}`,
        language: 'id',
      });
    } catch (err) {
      // Best-effort: notifikasi gagal tidak boleh merusak mutasi stok.
      this.logger.warn(
        `notifyStockAlert gagal (${params.kind} ${params.sku}): ${(err as Error).message}`,
      );
    }
  }
}
