// GAP-C (G176): aktivasi milestone sebagai fungsi murni atas TransactionClient.
//
// Dipanggil tepat SETELAH escrow order berhasil di-lock, di dalam transaksi
// yang sama, dari:
//   - OrderStateService.payOrder (wallet)
//   - OrderQrisPaymentService.settle... (QRIS)
// Order tanpa milestone → no-op: alur escrow satu tahap existing tidak berubah.
import { ConflictException } from '@nestjs/common';
import { MilestoneActorType, MilestoneEventType, MilestoneStatus, Prisma } from '@prisma/client';

type Tx = Prisma.TransactionClient;

export async function activateMilestonesForOrderTx(tx: Tx, orderId: string): Promise<{ activated: number }> {
  const drafts = await tx.orderMilestone.findMany({
    where: { orderId, status: MilestoneStatus.DRAFT },
    orderBy: { seq: 'asc' },
    select: { id: true, buyerAmount: true, seq: true },
  });
  if (drafts.length === 0) return { activated: 0 };

  const order = await tx.order.findUniqueOrThrow({
    where: { id: orderId },
    select: { buyerPayAmount: true, buyerId: true, orderId: true },
  });

  // Invariant dana (G177/G187): sum(buyerAmount) tahap harus = buyerPayAmount.
  const sumBuyer = drafts.reduce((a, m) => a + m.buyerAmount, 0n);
  if (sumBuyer !== order.buyerPayAmount) {
    throw new ConflictException({
      code: 'MILESTONE_INVARIANT_VIOLATION',
      message: 'Invariant dana milestone rusak: total buyerAmount tahap tidak sama dengan buyerPayAmount.',
    });
  }

  // Guard: escrow buyer harus cukup menampung seluruh alokasi tahap.
  const buyerWallet = await tx.wallet.findFirst({ where: { userId: order.buyerId } });
  if (!buyerWallet || buyerWallet.escrowBalance < sumBuyer) {
    throw new ConflictException({
      code: 'MILESTONE_INVARIANT_VIOLATION',
      message: 'Saldo escrow buyer tidak cukup untuk mengaktifkan milestone.',
    });
  }

  for (const m of drafts) {
    const upd = await tx.orderMilestone.updateMany({
      where: { id: m.id, status: MilestoneStatus.DRAFT },
      data: { status: MilestoneStatus.AWAITING_ACTIVATION, escrowHeld: m.buyerAmount },
    });
    if (upd.count === 0) {
      throw new ConflictException({
        code: 'OPTIMISTIC_LOCK_CONFLICT',
        message: 'Milestone berubah bersamaan saat aktivasi.',
      });
    }
    await tx.milestoneEvent.create({
      data: {
        milestoneId: m.id,
        actorType: MilestoneActorType.SYSTEM,
        eventType: MilestoneEventType.ACTIVATED,
        payload: { escrowHeld: m.buyerAmount.toString() },
      },
    });
  }
  return { activated: drafts.length };
}
