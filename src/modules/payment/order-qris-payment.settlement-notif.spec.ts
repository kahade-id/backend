import { PaymentProvider, PaymentPurpose, PaymentStatus, OrderStatus } from '@prisma/client';
import { OrderQrisPaymentService } from './order-qris-payment.service';

/**
 * TX-AUDIT2 (P1-F): handleSettlement WAJIB notifikasi seller (ORDER_PAYMENT_RECEIVED)
 * setelah settlement sukses. Satu titik ini memperbaiki jalur QRIS Midtrans dan
 * DANA-direct (keduanya memanggil handleSettlement). Tanpa ini, SLA kirim 2 hari
 * berjalan tanpa seller sadari escrow sudah didanai.
 */
describe('OrderQrisPaymentService.handleSettlement — P1-F seller notification', () => {
  const SEN = 100n;
  const buyerPaySen = 1_000_000n * SEN;

  function build() {
    const order = {
      id: 'ord-1',
      orderId: 'ORD-20261006-000001',
      title: 'Test Order',
      buyerId: 'buyer-1',
      sellerId: 'seller-1',
      status: OrderStatus.WAITING_PAYMENT,
      paymentDeadlineAt: new Date(Date.now() + 3600_000),
      buyerPayAmount: buyerPaySen,
      deliveryDeadlineDays: 3,
      deliveryDeadlineAt: null,
      fulfillment: 'BIASA',
      preorderEstimatedDate: null,
    };
    const payment = {
      id: 'pay-1',
      midtransOrderId: 'KDH-QRIS-1',
      purpose: PaymentPurpose.ORDER_ESCROW,
      status: PaymentStatus.PENDING,
      grossAmount: buyerPaySen,
      amount: buyerPaySen,
      paymentFee: 0n,
    };
    const wallet = {
      id: 'w-buyer',
      version: 1,
      isLocked: false,
      escrowBalance: 0n,
      totalBalance: 0n,
    };

    const tx = {
      paymentTransaction: {
        findUnique: jest.fn(async () => ({ ...payment, order, status: PaymentStatus.PENDING })),
        update: jest.fn(async () => ({})),
      },
      wallet: {
        findUnique: jest.fn(async () => wallet),
        updateMany: jest.fn(async () => ({ count: 1 })),
      },
      walletTransaction: {
        create: jest.fn(async () => ({})),
        findFirst: jest.fn(async () => null),
      },
      order: {
        updateMany: jest.fn(async () => ({ count: 1 })),
      },
      orderStatusHistory: { create: jest.fn(async () => ({})) },
      orderMilestone: { findMany: jest.fn(async () => []) },
      $queryRaw: jest.fn(async () => []),
    };

    const prisma = {
      paymentTransaction: {
        findUnique: jest.fn(async () => ({
          id: payment.id,
          purpose: payment.purpose,
          grossAmount: payment.grossAmount,
        })),
      },
      $transaction: jest.fn(async (cb: (t: typeof tx) => Promise<void>) => cb(tx)),
    };
    const midtrans = {};
    const config = { get: jest.fn(() => undefined) };
    const walletTxSerialService = { getNext: jest.fn(async () => 1) };
    const danaPayment = {};
    const notificationQueue = { enqueue: jest.fn(async () => undefined) };

    const svc = new OrderQrisPaymentService(
      prisma as never,
      midtrans as never,
      config as never,
      walletTxSerialService as never,
      danaPayment as never,
      notificationQueue as never,
    );
    return { svc, prisma, tx, notificationQueue, order };
  }

  it('mengirim ORDER_PAYMENT_RECEIVED ke seller setelah settlement sukses', async () => {
    const { svc, notificationQueue, order } = build();

    await svc.handleSettlement('KDH-QRIS-1', (Number(order.buyerPayAmount) / 100).toFixed(2));

    expect(notificationQueue.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: order.sellerId,
        type: 'ORDER_PAYMENT_RECEIVED',
        pushData: expect.objectContaining({
          type: 'ORDER_PAYMENT_RECEIVED',
          orderId: order.orderId,
        }),
      }),
    );
  });

  it('TIDAK notifikasi bila settlement gagal (refundReason di-set)', async () => {
    const { svc, prisma, notificationQueue } = build();
    // Simulasi: order sudah tidak WAITING_PAYMENT → refundReason di-set.
    (prisma.$transaction as jest.Mock).mockImplementation(
      async (cb: (t: Record<string, never>) => Promise<void>) => {
        const fakeTx = {
          paymentTransaction: {
            findUnique: jest.fn(async () => ({
              id: 'pay-1',
              status: PaymentStatus.PENDING,
              order: { status: OrderStatus.CANCELLED },
            })),
            update: jest.fn(async () => ({})),
          },
        };
        return cb(fakeTx as never);
      },
    );
    // requestRefund butuh payment record.
    (prisma.paymentTransaction.findUnique as jest.Mock).mockResolvedValue({
      id: 'pay-1',
      purpose: PaymentPurpose.ORDER_ESCROW,
      status: PaymentStatus.SUCCESS,
      grossAmount: 1_000_000n * 100n,
      refundRequestedAt: null,
    });

    const svcWithRefund = svc;
    // Mock requestRefund agar tidak memanggil provider.
    jest.spyOn(svcWithRefund as never, 'requestRefund' as never).mockResolvedValue(undefined as never);

    await svcWithRefund.handleSettlement('KDH-QRIS-1', '1000000.00');

    expect(notificationQueue.enqueue).not.toHaveBeenCalled();
  });
});
