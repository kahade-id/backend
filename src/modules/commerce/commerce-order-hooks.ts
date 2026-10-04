import { Logger } from '@nestjs/common';

/**
 * POIN 2 (2026-10-04) — unifikasi transaksi escrow: jembatan event order → commerce.
 *
 * Modul orders memanggil `CommerceOrderHooks.emitOrderPaid(...)` best-effort
 * setelah pembayaran order terkonfirmasi (post-commit). Service commerce
 * (jastip/patungan) mendaftarkan handler-nya di `onModuleInit` untuk
 * menandai peserta terkait sebagai PAID (PRICE_LOCKED/PENDING → PAID) —
 * menggantikan pola lama "link order yang SUDAH dibayar".
 *
 * Disengaja sebagai registry statis (bukan DI), mengikuti pola ChatOrderHooks,
 * supaya modul orders TIDAK perlu mengimpor CommerceModule — menghindari
 * circular dependency dengan modul commerce. Kegagalan handler tidak pernah
 * menggagalkan alur order: emit selalu fire-and-forget dan error hanya di-log.
 * Scheduler commerce (`syncPaidParticipants`, tiap 5 menit) menjadi fallback
 * idempoten bila event terlewat.
 */
export type CommerceOrderPaidHandler = (orderPublicId: string) => Promise<void>;

const logger = new Logger('CommerceOrderHooks');

export class CommerceOrderHooks {
  private static handlers: CommerceOrderPaidHandler[] = [];

  /** Daftarkan handler; boleh lebih dari satu (tidak seperti ChatOrderHooks). */
  static onOrderPaid(handler: CommerceOrderPaidHandler): void {
    CommerceOrderHooks.handlers.push(handler);
  }

  /** Dipakai test untuk membersihkan handler antar test. */
  static reset(): void {
    CommerceOrderHooks.handlers = [];
  }

  static emitOrderPaid(orderPublicId: string): void {
    for (const handler of [...CommerceOrderHooks.handlers]) {
      void handler(orderPublicId).catch((error: unknown) => {
        logger.warn(
          `Commerce order-paid hook failed for order ${orderPublicId}: ${(error as Error)?.message ?? error}`,
        );
      });
    }
  }
}
