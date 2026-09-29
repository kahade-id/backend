import { PaymentProvider, PaymentPurpose, PaymentStatus } from '@prisma/client';
import { DanaDirectRefundService } from './dana-direct-refund.service';

function buildPrisma(payment: unknown) {
  return {
    paymentTransaction: {
      findUnique: jest.fn(async () => payment),
      findFirst: jest.fn(async () => payment),
      updateMany: jest.fn(async () => ({ count: 1 })),
      update: jest.fn(async () => ({})),
    },
  };
}

const danaPayment = { refundOrder: jest.fn() };

const danaSuccessPayment = {
  id: 'pt-1',
  provider: PaymentProvider.DANA,
  purpose: PaymentPurpose.ORDER_ESCROW,
  status: PaymentStatus.SUCCESS,
  danaPayKind: 'QRIS',
  danaPartnerReferenceNo: 'KDH-ABC123',
  grossAmount: BigInt(1510500),
};

describe('DanaDirectRefundService', () => {
  beforeEach(() => jest.clearAllMocks());

  const build = (payment: unknown) =>
    new DanaDirectRefundService(buildPrisma(payment) as never, danaPayment as never);

  it('no-op (false) bila payment bukan DANA-direct', async () => {
    const svc = build({ ...danaSuccessPayment, provider: PaymentProvider.MIDTRANS, danaPayKind: null });
    expect(await svc.refundPayment('pt-1', 'alasan')).toBe(false);
    expect(danaPayment.refundOrder).not.toHaveBeenCalled();
  });

  it('no-op (false) bila tanpa danaPartnerReferenceNo', async () => {
    const svc = build({ ...danaSuccessPayment, danaPartnerReferenceNo: null });
    expect(await svc.refundPayment('pt-1', 'alasan')).toBe(false);
    expect(danaPayment.refundOrder).not.toHaveBeenCalled();
  });

  it('true idempoten bila sudah REFUNDED', async () => {
    const svc = build({ ...danaSuccessPayment, status: PaymentStatus.REFUNDED });
    expect(await svc.refundPayment('pt-1', 'alasan')).toBe(true);
    expect(danaPayment.refundOrder).not.toHaveBeenCalled();
  });

  it('refund penuh via DANA Refund API memakai originalPartnerReferenceNo', async () => {
    const prisma = buildPrisma(danaSuccessPayment);
    danaPayment.refundOrder.mockResolvedValue({ partnerRefundNo: 'RFD-x', referenceNo: 'DANA-RFD-1', status: 'SUCCESS' });
    const svc = new DanaDirectRefundService(prisma as never, danaPayment as never);

    const ok = await svc.refundPayment('pt-1', 'Cancel sebelum kirim');

    expect(ok).toBe(true);
    // Refund ke METODE BAYAR ASAL via DANA — memakai referensi asli.
    expect(danaPayment.refundOrder).toHaveBeenCalledWith(
      expect.objectContaining({
        partnerReferenceNo: 'KDH-ABC123',
        amountIdr: 15105,
        reason: 'Cancel sebelum kirim',
      }),
    );
    const refundNo = (danaPayment.refundOrder as jest.Mock).mock.calls[0][0].partnerRefundNo;
    expect(typeof refundNo).toBe('string');
    // payment ditandai REFUNDED
    expect(prisma.paymentTransaction.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: PaymentStatus.REFUNDED }) }),
    );
  });

  it('melepas klaim bila DANA refund gagal (retry aman)', async () => {
    const prisma = buildPrisma(danaSuccessPayment);
    danaPayment.refundOrder.mockRejectedValue(new Error('DANA down'));
    const svc = new DanaDirectRefundService(prisma as never, danaPayment as never);
    await expect(svc.refundPayment('pt-1', 'alasan')).rejects.toThrow('DANA down');
    // klaim dilepas: updateMany kedua dengan refundRequestedAt: null
    const releaseCall = (prisma.paymentTransaction.updateMany as jest.Mock).mock.calls.find(
      (c: [{ data: { refundRequestedAt: null } }]) => c[0].data.refundRequestedAt === null,
    );
    expect(releaseCall).toBeDefined();
  });

  it('refundOrderEscrow: no-op bila tidak ada payment DANA-direct SUCCESS', async () => {
    const prisma = {
      paymentTransaction: {
        findFirst: jest.fn(async () => null),
        findUnique: jest.fn(),
        updateMany: jest.fn(),
        update: jest.fn(),
      },
    };
    const svc = new DanaDirectRefundService(prisma as never, danaPayment as never);
    expect(await svc.refundOrderEscrow('order-db-1', 'alasan')).toBe(false);
    expect(danaPayment.refundOrder).not.toHaveBeenCalled();
  });
});
