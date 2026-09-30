import { OrderStatus } from '@prisma/client';
import { OrderStateService } from './order-state.service';

/**
 * E1 (2026-09-30) — completeOrder dalam mode tanpa-wallet (DANA-direct):
 * order single-stage yang dibayar via DANA harus bisa complete TANPA
 * melempar ESCROW_LOCK_MISSING (tidak ada ORDER_LOCK di mode ini).
 * Sebagai gantinya: baris escrowDisbursement PENDING dibuat di dalam tx
 * (durable, idempoten via key ORDER:<orderDbId>), settlement DANA
 * dieksekusi post-commit via EscrowDisbursementService.releaseForOrder
 * (pola sama M5 milestone). Seluruh blok ledger wallet dilewati.
 */

function buildTx() {
  const orderRow = {
    id: 'order-db-1',
    orderId: 'ORD-20260930-000001-E1',
    status: OrderStatus.IN_DELIVERY as OrderStatus,
    buyerId: 'buyer-1',
    sellerId: 'seller-1',
    buyerPayAmount: BigInt(100_000_00),
    sellerReceiveAmount: BigInt(95_000_00),
    feeAmount: BigInt(5_000_00),
    orderValue: BigInt(100_000_00),
    isKahadePlus: false,
  };
  const tx = {
    // $queryRaw dipakai sebagai template tag untuk row lock wallet (FOR UPDATE).
    $queryRaw: jest.fn(async () => []) as jest.Mock,
    order: {
      findFirst: jest.fn(async () => ({ ...orderRow })),
      updateMany: jest.fn(async () => ({ count: 1 })),
    },
    orderMilestone: { count: jest.fn(async () => 0) },
    deliveryProof: { findFirst: jest.fn(async () => ({ id: 'proof-1', status: 'ACCEPTED' })) },
    orderStatusHistory: { create: jest.fn(async () => ({})) },
    orderExtensionRequest: { updateMany: jest.fn(async () => ({})) },
    escrowDisbursement: {
      findUnique: jest.fn(async () => null) as jest.Mock,
      create: jest.fn(async (args: { data: Record<string, unknown> }) => ({ id: 'disb-1', ...args.data })) as jest.Mock,
    },
    user: { update: jest.fn(async () => ({})) },
    // Wallet TIDAK boleh disentuh dalam mode DANA-direct — bila salah satu
    // mock ini terpanggil, test gagal eksplisit (E1 = ESCROW_LOCK_MISSING).
    // Diketik sebagai jest.Mock agar test ketiga bisa me-mock ulang perilakunya.
    wallet: {
      findUnique: jest.fn(async () => { throw new Error('WALLET_TOUCHED'); }) as jest.Mock,
      updateMany: jest.fn(async () => { throw new Error('WALLET_TOUCHED'); }) as jest.Mock,
    },
    walletTransaction: {
      findFirst: jest.fn(async () => { throw new Error('WALLET_TX_TOUCHED'); }) as jest.Mock,
      create: jest.fn(async () => { throw new Error('WALLET_TX_TOUCHED'); }) as jest.Mock,
    },
  };
  return { tx, orderRow };
}

function buildService(opts: { walletEnabled: boolean }) {
  const { tx, orderRow } = buildTx();
  const prisma = {
    // GAP-C preflight: null -> lewati optimasi hemat serial, cek milestone di dalam tx.
    order: { findFirst: jest.fn(async () => null) },
    orderMilestone: { count: jest.fn(async () => 0) },
    $transaction: jest.fn(async (cb: (tx: unknown) => unknown) => cb(tx)),
  };
  const redis = { del: jest.fn(async () => 1) };
  const walletMode = { isWalletEnabled: jest.fn(() => opts.walletEnabled) };
  const walletTxSerialService = { getNext: jest.fn(async () => 42) };
  const referralService = {
    createReferralRewardIfEligible: jest.fn(async () => false),
    invalidateLeaderboardCache: jest.fn(async () => undefined),
  };
  const membershipRankService = { checkAndUpdateMembershipRank: jest.fn(async () => undefined) };
  const escrowDisbursementService = {
    releaseForOrder: jest.fn(async () => ({ outcome: 'RELEASED', disbursementId: 'disb-1' })),
  };
  const svc = new OrderStateService(
    prisma as never,
    redis as never,
    {} as never, // walletService
    walletMode as never,
    {} as never, // orderQrisPaymentService
    {} as never, // danaDirectRefundService
    escrowDisbursementService as never,
    walletTxSerialService as never,
    referralService as never,
    {} as never, // feeCalculator
    {} as never, // realtime
    membershipRankService as never,
    {} as never, // notificationQueue
  );
  return { svc, tx, orderRow, walletMode, escrowDisbursementService, redis };
}

const flushPostCommit = () => new Promise((r) => setTimeout(r, 30));

describe('OrderStateService.completeOrder (E1 no-wallet release)', () => {
  it('wallet mati -> complete sukses tanpa sentuh wallet; baris PENDING dibuat; releaseForOrder dipanggil post-commit', async () => {
    const { svc, tx, orderRow, escrowDisbursementService } = buildService({ walletEnabled: false });

    await svc.completeOrder(orderRow.orderId, orderRow.buyerId);
    await flushPostCommit();

    // Order ditandai COMPLETED di dalam tx.
    expect(tx.order.updateMany).toHaveBeenCalledTimes(1);

    // Wallet sama sekali tidak disentuh (E1: dulu lempar ESCROW_LOCK_MISSING di sini).
    expect(tx.wallet.findUnique).not.toHaveBeenCalled();
    expect(tx.wallet.updateMany).not.toHaveBeenCalled();
    expect(tx.walletTransaction.findFirst).not.toHaveBeenCalled();
    expect(tx.walletTransaction.create).not.toHaveBeenCalled();

    // Baris disbursement PENDING dibuat di dalam tx — idempoten, nominal bersih seller.
    expect(tx.escrowDisbursement.create).toHaveBeenCalledTimes(1);
    const createArgs = tx.escrowDisbursement.create.mock.calls[0][0] as { data: Record<string, unknown> };
    expect(createArgs.data.idempotencyKey).toBe(`ORDER:${orderRow.id}`);
    expect(createArgs.data.amountSen).toBe(orderRow.sellerReceiveAmount);
    expect(createArgs.data.orderId).toBe(orderRow.id);
    expect(createArgs.data.sellerId).toBe(orderRow.sellerId);

    // Settlement DANA dieksekusi post-commit via releaseForOrder.
    expect(escrowDisbursementService.releaseForOrder).toHaveBeenCalledTimes(1);
    expect(escrowDisbursementService.releaseForOrder).toHaveBeenCalledWith(orderRow.id);
  });

  it('wallet mati + disbursement row sudah ada -> tidak buat duplikat (idempoten)', async () => {
    const { svc, tx, orderRow, escrowDisbursementService } = buildService({ walletEnabled: false });
    tx.escrowDisbursement.findUnique.mockResolvedValueOnce({ id: 'disb-existing' });

    await svc.completeOrder(orderRow.orderId, orderRow.buyerId);
    await flushPostCommit();

    expect(tx.escrowDisbursement.create).not.toHaveBeenCalled();
    expect(escrowDisbursementService.releaseForOrder).toHaveBeenCalledWith(orderRow.id);
  });

  it('wallet hidup -> jalur wallet lama tetap dipakai (tidak ada disbursement DANA)', async () => {
    const { svc, tx, orderRow, escrowDisbursementService } = buildService({ walletEnabled: true });
    // Mock wallet untuk jalur lama: ORDER_LOCK ada & cocok, bukan peserta patungan.
    const walletRow = (userId: string) => ({
      id: `wallet-${userId}`, userId, isLocked: false,
      escrowBalance: BigInt(100_000_00), availableBalance: BigInt(0),
      totalBalance: BigInt(100_000_00), version: 1,
    });
    tx.wallet.findUnique.mockImplementation(async (args: { where: { userId?: string; id?: string } }) => {
      if (args.where.userId) return { id: `wallet-${args.where.userId}` };
      return walletRow(args.where.id!.replace('wallet-', ''));
    });
    tx.wallet.updateMany.mockResolvedValue({ count: 1 });
    tx.walletTransaction.findFirst.mockResolvedValue({ amount: orderRow.buyerPayAmount });
    tx.walletTransaction.create.mockResolvedValue({ id: 'wtx-1' });
    (tx as Record<string, unknown>).patunganParticipant = {
      findUnique: jest.fn(async () => null), // bukan order patungan -> rebate dilewati
    };

    await svc.completeOrder(orderRow.orderId, orderRow.buyerId);
    await flushPostCommit();

    // Jalur wallet: ledger wallet ditulis ...
    expect(tx.wallet.updateMany).toHaveBeenCalled();
    expect(tx.walletTransaction.create).toHaveBeenCalled();
    // ... dan TIDAK ada disbursement DANA.
    expect(tx.escrowDisbursement.create).not.toHaveBeenCalled();
    expect(escrowDisbursementService.releaseForOrder).not.toHaveBeenCalled();
  });
});
