import { Logger } from '@nestjs/common';
import { RedisService } from '../../redis/redis.service';

/**
 * Audit voucher 2026-10-10 (B08): daftar voucher "tersedia" di-cache per user
 * (ACTIVE_VOUCHERS_LIST, TTL 300 dtk). Tanpa invalidasi, voucher sekali-pakai
 * yang baru saja ditebus masih tampil "Aktif" hingga 5 menit setelah checkout
 * atau top-up. Dipanggil POST-COMMIT (best-effort) oleh jalur penebusan —
 * kegagalan Redis tidak boleh menggagalkan order/top-up yang sudah tersimpan.
 *
 * Format kunci: `public:vouchers:active:<applicableTo>:<audience>:<userId>:<limit>`
 * (lihat redis-keys.ts) — glob `*` Redis cocok lintas tanda titik dua.
 */
export async function invalidateUserVoucherListCache(
  redis: RedisService,
  userId: string,
  logger?: Logger,
): Promise<void> {
  try {
    await redis.delPattern(`public:vouchers:active:*:${userId}:*`, { throwOnError: true });
  } catch (error: unknown) {
    logger?.warn(
      `silent-catch: voucher list cache invalidation failed for user ${userId}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
