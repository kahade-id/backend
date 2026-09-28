import { Logger } from '@nestjs/common';

/**
 * Batch 43 BE-CHAT: jembatan event order → pesan sistem chat.
 *
 * Modul orders memanggil `ChatOrderHooks.emit(...)` best-effort setelah
 * transisi status order berhasil (bayar diterima, resi diupload, dikirim,
 * dana cair). ChatService mendaftarkan handler-nya di `onModuleInit`.
 *
 * Disengaja sebagai registry statis (bukan DI) supaya modul orders TIDAK
 * perlu mengimpor ChatModule — menghindari circular dependency dengan modul
 * finansial yang sensitif. Kegagalan handler tidak pernah menggagalkan alur
 * order: emit selalu di-fire-and-forget dan error hanya di-log.
 */
export type ChatOrderEventKind =
  | 'ORDER_PAID'
  | 'ORDER_TRACKING_UPDATED'
  | 'ORDER_SHIPPED'
  | 'ORDER_COMPLETED';

export interface ChatOrderEventData {
  trackingNumber?: string | null;
  courierName?: string | null;
}

type ChatOrderEventHandler = (
  orderId: string,
  kind: ChatOrderEventKind,
  data?: ChatOrderEventData,
) => Promise<void>;

const logger = new Logger('ChatOrderHooks');

export class ChatOrderHooks {
  private static handler: ChatOrderEventHandler | null = null;

  static register(handler: ChatOrderEventHandler): void {
    ChatOrderHooks.handler = handler;
  }

  /** Dipakai test untuk membersihkan handler antar test. */
  static reset(): void {
    ChatOrderHooks.handler = null;
  }

  static emit(orderId: string, kind: ChatOrderEventKind, data?: ChatOrderEventData): void {
    const handler = ChatOrderHooks.handler;
    if (!handler) return;
    // Fire-and-forget: pesan sistem tidak boleh menggagalkan alur order.
    void handler(orderId, kind, data).catch((error: unknown) => {
      logger.warn(`Chat system message hook failed for order ${orderId} (${kind}): ${(error as Error)?.message ?? error}`);
    });
  }
}
