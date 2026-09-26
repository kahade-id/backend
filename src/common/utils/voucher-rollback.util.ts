import { Prisma } from '@prisma/client';

/**
 * SP-034: rollback pemakaian voucher pada order (cancel/reject/expire).
 *
 * Menghapus VoucherUsage lalu mengembalikan DUA counter yang di-increment
 * saat redeem: `voucher.currentUsage` DAN `campaign.currentRedemptions`
 * (bila voucher terikat campaign). Sebelumnya hanya currentUsage yang
 * dikembalikan — kuota campaign bocor (berkurang permanen) setiap order
 * dibatalkan.
 *
 * Idempoten: deleteMany.count > 0 sebagai guard (pola yang sudah ada), plus
 * guard { gt: 0 } pada kedua decrement agar counter tidak negatif bila
 * rollback terpanggil ganda.
 */
export async function rollbackOrderVoucherUsage(
  tx: Prisma.TransactionClient,
  orderId: string,
  voucherId: string,
): Promise<void> {
  // Ambil campaignId SEBELUM delete — relasi usage ikut terhapus.
  const voucherRow = await tx.voucher.findUnique({
    where: { id: voucherId },
    select: { campaignId: true },
  });
  const deleted = await tx.voucherUsage.deleteMany({
    where: { orderId, voucherId },
  });
  if (deleted.count === 0) return;
  await tx.voucher.updateMany({
    where: { id: voucherId, currentUsage: { gt: 0 } },
    data: { currentUsage: { decrement: 1 } },
  });
  if (voucherRow?.campaignId) {
    await tx.campaign.updateMany({
      where: { id: voucherRow.campaignId, currentRedemptions: { gt: 0 } },
      data: { currentRedemptions: { decrement: 1 } },
    });
  }
}
