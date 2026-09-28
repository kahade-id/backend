import {
  PatunganParticipantStatus,
  PatunganStatus,
  Prisma,
  WalletTransactionStatus,
  WalletTransactionType,
} from '@prisma/client';

type Tx = Prisma.TransactionClient;

/** Prefix deskripsi ledger agar rebate idempoten & ter-audit. */
export const PATUNGAN_REBATE_DESCRIPTION_PREFIX = 'Patungan overfunding rebate';

export interface PatunganRebate {
  participantId: string;
  groupId: string;
  /** Rupiah (sen). */
  rebateSen: bigint;
}

const COUNTED_PARTICIPANT_STATUSES: PatunganParticipantStatus[] = [
  PatunganParticipantStatus.PAID,
  PatunganParticipantStatus.RELEASED,
];

const REBATE_ELIGIBLE_GROUP_STATUSES: PatunganStatus[] = [
  PatunganStatus.TARGET_REACHED,
  PatunganStatus.CONTEST,
  PatunganStatus.RELEASED,
];

/**
 * M6 (SEC-B ronde 2) — overfunding patungan HARUS mengurangi beban peserta
 * secara nyata, bukan sekadar angka informatif di response.
 *
 * Dipanggil dari dalam transaksi escrow-release (completeOrder): bila order
 * yang selesai ditautkan ke peserta patungan pada grup yang sudah mencapai
 * target, kelebihan dana (totalPaid − target) dibagi rata ke tiap peserta
 * sebagai rebate: pembeli menerima kembali `rebateSen` ke saldo available,
 * host menerima `sellerReceiveAmount − rebateSen`.
 *
 * Tanpa migrasi/schema baru:
 * - Tidak ada kolom baru — rebate dihitung deterministik dari peserta
 *   berstatus PAID/RELEASED (himpunan final setelah grup keluar dari OPEN).
 * - Ledger memakai tipe existing ORDER_REFUND dengan prefix deskripsi khusus.
 *
 * Idempoten: (1) berjalan di dalam tx completion yang di-guard transisi
 * status order; (2) guard tambahan — bila baris ORDER_REFUND rebate untuk
 * order ini sudah ada, kembalikan null.
 *
 * Fail-safe: rebate di-cap oleh pemanggil agar tidak melebihi
 * sellerReceiveAmount (tidak pernah membuat kredit negatif ke host).
 */
export async function computePatunganRebateTx(tx: Tx, orderDbId: string): Promise<PatunganRebate | null> {
  const participant = await tx.patunganParticipant.findUnique({
    where: { orderId: orderDbId },
    select: { id: true, groupId: true, status: true },
  });
  if (!participant) return null;
  if (!COUNTED_PARTICIPANT_STATUSES.includes(participant.status)) return null;

  const group = await tx.patunganGroup.findUnique({
    where: { id: participant.groupId },
    select: { status: true, targetAmount: true },
  });
  if (!group || !REBATE_ELIGIBLE_GROUP_STATUSES.includes(group.status)) return null;

  const alreadyRebated = await tx.walletTransaction.findFirst({
    where: {
      orderId: orderDbId,
      type: WalletTransactionType.ORDER_REFUND,
      description: { startsWith: PATUNGAN_REBATE_DESCRIPTION_PREFIX },
    },
    select: { id: true },
  });
  if (alreadyRebated) return null;

  const paid = await tx.patunganParticipant.findMany({
    where: { groupId: participant.groupId, status: { in: COUNTED_PARTICIPANT_STATUSES } },
    select: { amount: true },
  });
  if (paid.length === 0) return null;
  const totalPaid = paid.reduce((sum, p) => sum + p.amount, 0n);
  const overfunding = totalPaid - group.targetAmount;
  if (overfunding <= 0n) return null;

  // Dibagi rata, floor — sisa pembulatan (dust) tetap ke host.
  const rebateSen = overfunding / BigInt(paid.length);
  if (rebateSen <= 0n) return null;

  return { participantId: participant.id, groupId: participant.groupId, rebateSen };
}

/** Baris ledger ORDER_REFUND untuk rebate — dipanggil pemegang tx. */
export async function createPatunganRebateLedgerTx(
  tx: Tx,
  args: {
    txId: string;
    buyerWalletId: string;
    orderDbId: string;
    orderPublicId: string;
    groupId: string;
    rebateSen: bigint;
    buyerAvailableBefore: bigint;
  },
): Promise<void> {
  await tx.walletTransaction.create({
    data: {
      txId: args.txId,
      walletId: args.buyerWalletId,
      type: WalletTransactionType.ORDER_REFUND,
      status: WalletTransactionStatus.SUCCESS,
      amount: args.rebateSen,
      balanceBefore: args.buyerAvailableBefore,
      balanceAfter: args.buyerAvailableBefore + args.rebateSen,
      orderId: args.orderDbId,
      description: `${PATUNGAN_REBATE_DESCRIPTION_PREFIX} ${args.rebateSen} group=${args.groupId} order=${args.orderPublicId}`,
    },
  });
}
