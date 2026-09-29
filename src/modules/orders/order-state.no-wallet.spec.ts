import { OrderStatus } from '@prisma/client';
import { OrderStateService } from './order-state.service';

/**
 * M3 — adminCancelOrder dalam mode tanpa-wallet (BI-safe):
 * order DANA-direct yang di-cancel admin/auto-cancel 2 hari harus refund ke
 * metode bayar asal via DANA Refund API — TIDAK menyentuh wallet,
 * TIDAK memanggil refund Midtrans, dan copy notifikasi tidak mengklaim
 * "kembali ke wallet".
 */

function buildTx() {
  const orderRow = {
    id: 'order-db-1',
    orderId: 'ORD-20260929-000001',
    status: OrderStatus.PROCESSING as OrderStatus,
    buyerPayAmount: BigInt(100_000_00),
    voucherId: null,
    buyerId: 'buyer-1',
    sellerId: 'seller-1',
  };
  const tx = {
    order: {
      findFirst: jest.fn(async () => ({ ...orderRow })),
      updateMany: jest.fn(async () => ({ count: 1 })),
    },
    orderStatusHistory: { create: jest.fn(async () => ({})) },
    user: { update: jest.fn(async () => ({})) },
    // Wallet TIDAK boleh disentuh dalam mode DANA-direct — bila salah satu
    // mock ini terpanggil, test di bawah gagal eksplisit.
    wallet: { findFirst: jest.fn(async () => { throw new Error('WALLET_TOUCHED'); }) },
    walletTransaction: { create: jest.fn(async () => { throw new Error('WALLET_TX_TOUCHED'); }) },
  };
  return { tx, orderRow };
}

type EnqueueCall = [{ userId: string; type: string; body: string }];
const enqueueCalls = (enqueue: { mock: { calls: unknown[][] } }) =>
  enqueue.mock.calls as unknown as EnqueueCall[];

function buildService(opts: { walletEnabled: boolean; danaPayment: boolean; legacyNoEscrow?: boolean }) {
  const { tx, orderRow } = buildTx();
  if (opts.legacyNoEscrow) {
    // Jalur legacy tanpa escrow wallet (WAITING_CONFIRMATION): fokus test =
    // refund provider + copy notifikasi, bukan ledger wallet.
    orderRow.status = OrderStatus.WAITING_CONFIRMATION;
    orderRow.buyerPayAmount = BigInt(0);
  }
  const prisma = {
    order: {
      findUnique: jest.fn(async (args: { where: { orderId: string } }) => {
        // Preflight select { status, buyerPayAmount }; post-commit select { id } /
        // { buyerId, sellerId, title } — kembalikan baris penuh untuk semua.
        if (args.where.orderId === orderRow.orderId) return { ...orderRow, title: 'Kopi Susu' };
        return null;
      }),
      findFirst: jest.fn(async () => ({ id: orderRow.id })),
    },
    paymentTransaction: {
      findFirst: jest.fn(async (args: { where: Record<string, unknown> }) => {
        const where = args.where as Record<string, unknown>;
        if (where.provider === 'DANA') {
          return opts.danaPayment ? { id: 'pay-dana-1' } : null;
        }
        return null; // tidak ada payment QRIS/Midtrans SUCCESS
      }),
    },
    $transaction: jest.fn(async (cb: (tx: unknown) => unknown) => cb(tx)),
  };
  const walletMode = { isWalletEnabled: jest.fn(() => opts.walletEnabled) };
  const orderQrisPaymentService = {
    requestRefundForOrder: jest.fn(async () => undefined),
    cancelPendingPaymentForOrder: jest.fn(async () => undefined),
  };
  const danaDirectRefundService = {
    refundOrderEscrow: jest.fn(async () => ({ refunded: true, already: false, amountSen: orderRow.buyerPayAmount })),
  };
  const realtime = { emitToOrder: jest.fn() };
  const walletTxSerialService = { getNext: jest.fn(async () => 42) };
  const notificationQueue = { enqueue: jest.fn(async (_args: unknown) => undefined) };
  const svc = new OrderStateService(
    prisma as never,
    {} as never,
    {} as never,
    walletMode as never,
    orderQrisPaymentService as never,
    danaDirectRefundService as never,
    walletTxSerialService as never,
    {} as never,
    {} as never,
    realtime as never,
    {} as never,
    notificationQueue as never,
  );
  return { svc, prisma, tx, orderRow, walletMode, orderQrisPaymentService, danaDirectRefundService, realtime, notificationQueue };
}

const flushPostCommit = () => new Promise((r) => setTimeout(r, 20));

describe('OrderStateService.adminCancelOrder (M3 no-wallet)', () => {
  it('order DANA-direct + wallet mati → refund via DANA Refund API, wallet tak tersentuh', async () => {
    const { svc, tx, orderRow, orderQrisPaymentService, danaDirectRefundService, notificationQueue } =
      buildService({ walletEnabled: false, danaPayment: true });

    await svc.adminCancelOrder(orderRow.orderId, 'admin-1', 'seller tidak kirim');
    await flushPostCommit();

    // Escrow wallet tidak disentuh di dalam transaksi.
    expect(tx.wallet.findFirst).not.toHaveBeenCalled();
    expect(tx.walletTransaction.create).not.toHaveBeenCalled();

    // Refund Midtrans tidak dipanggil; refund DANA dipanggil dengan orderDbId.
    expect(orderQrisPaymentService.requestRefundForOrder).not.toHaveBeenCalled();
    expect(danaDirectRefundService.refundOrderEscrow).toHaveBeenCalledTimes(1);
    expect(danaDirectRefundService.refundOrderEscrow).toHaveBeenCalledWith(
      orderRow.id,
      expect.stringContaining('Admin cancelled order'),
    );

    // Copy notifikasi buyer menyebut metode bayar asal, bukan wallet.
    const calls = enqueueCalls(notificationQueue.enqueue);
    const buyerCancels = calls.filter(
      ([args]) => args.userId === 'buyer-1' && args.type === 'ORDER_CANCELLED',
    );
    expect(buyerCancels).toHaveLength(1);
    expect(buyerCancels[0][0].body).toContain('metode pembayaran asal');
    const walletRefundNotifs = calls.filter(([args]) => args.type === 'WALLET_REFUND_RECEIVED');
    expect(walletRefundNotifs).toHaveLength(0);
  });

  it('wallet hidup → jalur lama (refund Midtrans, notifikasi wallet)', async () => {
    const { svc, orderRow, orderQrisPaymentService, danaDirectRefundService, notificationQueue } =
      buildService({ walletEnabled: true, danaPayment: true, legacyNoEscrow: true });

    await svc.adminCancelOrder(orderRow.orderId, 'admin-1', 'alasan');
    await flushPostCommit();

    expect(danaDirectRefundService.refundOrderEscrow).not.toHaveBeenCalled();
    expect(orderQrisPaymentService.requestRefundForOrder).toHaveBeenCalledTimes(1);
    const walletRefundNotifs = enqueueCalls(notificationQueue.enqueue).filter(([args]: EnqueueCall) => args.type === 'WALLET_REFUND_RECEIVED');
    expect(walletRefundNotifs).toHaveLength(1);
  });
});
