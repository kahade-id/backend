import { PaymentProvider, PaymentPurpose, PaymentStatus } from '@prisma/client';
import { OrderQrisPaymentService } from './order-qris-payment.service';

/**
 * E3 (2026-09-30): cancelPendingPaymentForOrder harus membatalkan order ke
 * PROVIDER YANG BENAR. Sebelumnya selalu memanggil midtrans.cancelTransaction
 * — order DANA tetap hidup di DANA (buyer masih bisa bayar setelah CANCELLED).
 */
describe('OrderQrisPaymentService.cancelPendingPaymentForOrder (E3)', () => {
  function build(paymentRow: unknown) {
    const prisma = {
      paymentTransaction: { findFirst: jest.fn(async () => paymentRow) },
    };
    const midtrans = { cancelTransaction: jest.fn(async () => ({})) };
    const danaPayment = { cancelOrder: jest.fn(async () => undefined) };
    const notificationQueue = { enqueue: jest.fn(async () => undefined) };
    const svc = new OrderQrisPaymentService(
      prisma as never,
      midtrans as never,
      {} as never,
      {} as never,
      danaPayment as never,
      notificationQueue as never,
    );
    return { svc, prisma, midtrans, danaPayment };
  }

  const danaPending = {
    provider: PaymentProvider.DANA,
    midtransOrderId: 'KDH-DANA-1',
    danaPartnerReferenceNo: 'KDH-DANA-1',
    purpose: PaymentPurpose.ORDER_ESCROW,
    status: PaymentStatus.PENDING,
  };

  it('payment DANA → danaPayment.cancelOrder, midtrans TIDAK dipanggil', async () => {
    const { svc, midtrans, danaPayment } = build(danaPending);
    await svc.cancelPendingPaymentForOrder('ORD-1');
    expect(danaPayment.cancelOrder).toHaveBeenCalledWith(
      'KDH-DANA-1',
      expect.any(String),
    );
    expect(midtrans.cancelTransaction).not.toHaveBeenCalled();
  });

  it('payment DANA tanpa danaPartnerReferenceNo → fallback midtrans (fail-safe)', async () => {
    const { svc, midtrans, danaPayment } = build({ ...danaPending, danaPartnerReferenceNo: null });
    await svc.cancelPendingPaymentForOrder('ORD-1');
    expect(danaPayment.cancelOrder).not.toHaveBeenCalled();
    expect(midtrans.cancelTransaction).toHaveBeenCalledWith('KDH-DANA-1');
  });

  it('payment Midtrans legacy → midtrans.cancelTransaction (tidak berubah)', async () => {
    const { svc, midtrans, danaPayment } = build({
      provider: PaymentProvider.MIDTRANS,
      midtransOrderId: 'MT-1',
      danaPartnerReferenceNo: null,
    });
    await svc.cancelPendingPaymentForOrder('ORD-1');
    expect(midtrans.cancelTransaction).toHaveBeenCalledWith('MT-1');
    expect(danaPayment.cancelOrder).not.toHaveBeenCalled();
  });

  it('tidak ada payment PENDING → no-op', async () => {
    const { svc, midtrans, danaPayment } = build(null);
    await svc.cancelPendingPaymentForOrder('ORD-1');
    expect(midtrans.cancelTransaction).not.toHaveBeenCalled();
    expect(danaPayment.cancelOrder).not.toHaveBeenCalled();
  });

  it('DANA cancel gagal (race settlement) → warn, tidak throw', async () => {
    const { svc, danaPayment } = build(danaPending);
    danaPayment.cancelOrder.mockRejectedValueOnce(new Error('already settled'));
    await expect(svc.cancelPendingPaymentForOrder('ORD-1')).resolves.toBeUndefined();
  });
});
