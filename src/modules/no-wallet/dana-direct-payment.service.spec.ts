import { PaymentProvider, PaymentPurpose, PaymentStatus } from '@prisma/client';
import {
  DanaDirectPaymentService,
  generateDanaPartnerReferenceNo,
} from './dana-direct-payment.service';
import { DanaDirectPayKind } from './dto/dana-direct-pay.dto';

/** Mock Prisma tx-aware minimal untuk DanaDirectPaymentService. */
function buildPrisma(overrides: Record<string, unknown> = {}) {
  const txState: Record<string, jest.Mock> = {
    paymentTransactionFindUnique: jest.fn(),
    paymentTransactionUpdate: jest.fn(),
    orderUpdateMany: jest.fn(),
    orderStatusHistoryCreate: jest.fn(),
  };
  const txMocks = {
    paymentTransactionUpdateMany: jest.fn(async () => ({ count: 0 })),
    paymentTransactionCreate: jest.fn(async (args: { data: unknown }) => ({ id: 'pt-tx', ...(args.data as object) })),
  };
  const tx = {
    paymentTransaction: {
      findUnique: txState.paymentTransactionFindUnique,
      update: txState.paymentTransactionUpdate,
      updateMany: txMocks.paymentTransactionUpdateMany,
      create: txMocks.paymentTransactionCreate,
    },
    order: { updateMany: txState.orderUpdateMany },
    orderMilestone: { count: jest.fn(async () => 0) },
    orderStatusHistory: { create: txState.orderStatusHistoryCreate },
  };
  const prisma = {
    order: { findFirst: jest.fn(), findUnique: jest.fn() },
    paymentTransaction: {
      findFirst: jest.fn(),
      updateMany: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    },
    $transaction: jest.fn(async (cb: (tx: unknown) => unknown) => cb(tx)),
    ...overrides,
  };
  return { prisma, txState, txMocks };
}

const danaPayment = {
  createOrder: jest.fn(),
  cancelOrder: jest.fn(),
};
const config = { get: jest.fn(() => undefined) };
const serial = { getNextForPrefix: jest.fn(async () => 7) };
const walletMode = { isWalletEnabled: jest.fn(() => false) };

const baseOrder = {
  id: 'order-db-1',
  orderId: 'ORD-20260929-000001',
  buyerId: 'buyer-1',
  sellerId: 'seller-1',
  status: 'WAITING_PAYMENT',
  paymentDeadlineAt: null,
  buyerPayAmount: BigInt(1500000), // Rp15.000
  deliveryDeadlineAt: null,
  deliveryDeadlineDays: 3,
  buyer: { id: 'buyer-1', fullName: 'Buyer' },
};

describe('generateDanaPartnerReferenceNo', () => {
  it('maks 25 char & unik (syarat QRIS DANA)', () => {
    const refs = new Set(Array.from({ length: 50 }, () => generateDanaPartnerReferenceNo()));
    expect(refs.size).toBe(50);
    for (const r of refs) expect(r.length).toBeLessThanOrEqual(25);
  });
});

describe('DanaDirectPaymentService.initiate', () => {
  beforeEach(() => jest.clearAllMocks());

  const build = (prisma: unknown) =>
    new DanaDirectPaymentService(prisma as never, danaPayment as never, config as never, serial as never, walletMode as never);

  it('menolak bila order tidak ditemukan', async () => {
    const { prisma } = buildPrisma();
    (prisma.order.findFirst as jest.Mock).mockResolvedValue(null);
    await expect(
      build(prisma).initiate('ORD-X', 'buyer-1', { payKind: DanaDirectPayKind.QRIS }),
    ).rejects.toMatchObject({ response: expect.objectContaining({ code: 'ORDER_NOT_FOUND' }) });
  });

  it('menolak bila bukan buyer order tersebut', async () => {
    const { prisma } = buildPrisma();
    (prisma.order.findFirst as jest.Mock).mockResolvedValue(baseOrder);
    await expect(
      build(prisma).initiate('ORD-20260929-000001', 'buyer-lain', { payKind: DanaDirectPayKind.QRIS }),
    ).rejects.toMatchObject({ response: expect.objectContaining({ code: 'NOT_ORDER_PARTICIPANT' }) });
  });

  it('menolak VA tanpa bankCode', async () => {
    const { prisma } = buildPrisma();
    await expect(
      build(prisma).initiate('ORD-1', 'buyer-1', { payKind: DanaDirectPayKind.VA }),
    ).rejects.toMatchObject({ response: expect.objectContaining({ code: 'DANA_VA_BANK_REQUIRED' }) });
  });

  it('membuat charge DANA QRIS baru dan mengembalikan instruksi bayar', async () => {
    const { prisma, txMocks } = buildPrisma();
    (prisma.order.findFirst as jest.Mock).mockResolvedValue(baseOrder);
    (prisma.paymentTransaction.findFirst as jest.Mock).mockResolvedValue(null);
    danaPayment.createOrder.mockResolvedValue({
      partnerReferenceNo: 'KDH-ABC',
      referenceNo: 'DANA-REF-1',
      paymentCode: 'QRIS-STRING-123',
      amountIdr: 15105,
      expiresAt: new Date(),
    });
    (prisma.paymentTransaction.update as jest.Mock).mockImplementation(async (args: { data: unknown; where: unknown }) => ({
      id: 'pt-1',
      midtransOrderId: 'PAY-X',
      status: PaymentStatus.PENDING,
      amount: BigInt(1500000),
      paymentFee: BigInt(10500),
      grossAmount: BigInt(1510500),
      expiredAt: new Date(),
      danaPayKind: 'QRIS',
      ...(args.data as object),
    }));

    const res = await build(prisma).initiate('ORD-20260929-000001', 'buyer-1', {
      payKind: DanaDirectPayKind.QRIS,
    });

    expect(danaPayment.createOrder).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'QRIS', amountIdr: 15105 }),
    );
    expect(res.payKind).toBe(DanaDirectPayKind.QRIS);
    expect(res.escrowAmount).toBe(15000);
    expect(res.providerFee).toBe(105); // 0.7% default
    expect(res.grossAmount).toBe(15105);
    // create DANA dipanggil di dalam tx — TIDAK ada pemanggilan wallet/top-up.
    const created = txMocks.paymentTransactionCreate.mock.calls[0][0].data as Record<string, unknown>;
    expect(created.provider).toBe(PaymentProvider.DANA);
    expect(created.purpose).toBe(PaymentPurpose.ORDER_ESCROW);
    expect(created.danaPayKind).toBe('QRIS');
  });

  it('idempoten: charge PENDING yang masih hidup dikembalikan ulang', async () => {
    const { prisma } = buildPrisma();
    (prisma.order.findFirst as jest.Mock).mockResolvedValue(baseOrder);
    (prisma.paymentTransaction.findFirst as jest.Mock).mockResolvedValue({
      midtransOrderId: 'PAY-OLD',
      status: PaymentStatus.PENDING,
      amount: BigInt(1500000),
      paymentFee: BigInt(0),
      grossAmount: BigInt(1500000),
      expiredAt: new Date(Date.now() + 600000),
      danaPayKind: 'BALANCE',
      providerInstructions: {},
    });
    const res = await build(prisma).initiate('ORD-20260929-000001', 'buyer-1', {
      payKind: DanaDirectPayKind.BALANCE,
    });
    expect(res.paymentTxId).toBe('PAY-OLD');
    expect(danaPayment.createOrder).not.toHaveBeenCalled();
  });

  it('VA memetakan bankCode ke PaymentMethod enum', async () => {
    const { prisma, txMocks } = buildPrisma();
    (prisma.order.findFirst as jest.Mock).mockResolvedValue(baseOrder);
    (prisma.paymentTransaction.findFirst as jest.Mock).mockResolvedValue(null);
    danaPayment.createOrder.mockResolvedValue({
      partnerReferenceNo: 'KDH-VA',
      referenceNo: 'DANA-REF-VA',
      paymentCode: '88081234567890',
      amountIdr: 15000,
      expiresAt: new Date(),
    });
    (prisma.paymentTransaction.update as jest.Mock).mockImplementation(async (args: { data: unknown }) => ({
      id: 'pt-va',
      midtransOrderId: 'PAY-VA',
      status: PaymentStatus.PENDING,
      amount: BigInt(1500000),
      paymentFee: BigInt(0),
      grossAmount: BigInt(1500000),
      expiredAt: new Date(),
      danaPayKind: 'VA',
      ...(args.data as object),
    }));
    const res = await build(prisma).initiate('ORD-20260929-000001', 'buyer-1', {
      payKind: DanaDirectPayKind.VA,
      bankCode: 'BCA',
    });
    expect(danaPayment.createOrder).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'VA', bankCode: 'BCA' }),
    );
    const created = txMocks.paymentTransactionCreate.mock.calls[0][0].data as Record<string, unknown>;
    expect(created.method).toBe('VIRTUAL_ACCOUNT_BCA');
    expect(res.paymentCode).toBe('88081234567890');
  });
});

describe('DanaDirectPaymentService.settleEscrow', () => {
  beforeEach(() => jest.clearAllMocks());

  it('mendanai escrow TANPA menyentuh wallet: order → PROCESSING', async () => {
    const payment = {
      id: 'pt-1',
      purpose: PaymentPurpose.ORDER_ESCROW,
      status: PaymentStatus.PENDING,
      danaPartnerReferenceNo: 'KDH-ABC',
      danaReferenceNo: 'DANA-REF-1',
      danaPayKind: 'QRIS',
      order: { ...baseOrder, status: 'WAITING_PAYMENT' },
    };
    const { prisma, txState } = buildPrisma();
    txState.paymentTransactionFindUnique.mockResolvedValue(payment);
    txState.orderUpdateMany.mockResolvedValue({ count: 1 });

    const svc = new DanaDirectPaymentService(prisma as never, danaPayment as never, config as never, serial as never, walletMode as never);
    await svc.settleEscrow('pt-1');

    // order → PROCESSING + referensi DANA tersimpan (kolom aditif)
    expect(txState.orderUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: 'order-db-1', status: 'WAITING_PAYMENT' }),
        data: expect.objectContaining({
          status: 'PROCESSING',
          danaPartnerReferenceNo: 'KDH-ABC',
          danaReferenceNo: 'DANA-REF-1',
        }),
      }),
    );
    // payment → SUCCESS
    expect(txState.paymentTransactionUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: PaymentStatus.SUCCESS }) }),
    );
    // history tercatat
    expect(txState.orderStatusHistoryCreate).toHaveBeenCalled();
  });

  it('idempoten: payment yang sudah SUCCESS tidak di-settle ulang', async () => {
    const { prisma, txState } = buildPrisma();
    txState.paymentTransactionFindUnique.mockResolvedValue({
      id: 'pt-1',
      purpose: PaymentPurpose.ORDER_ESCROW,
      status: PaymentStatus.SUCCESS,
      order: baseOrder,
    });
    const svc = new DanaDirectPaymentService(prisma as never, danaPayment as never, config as never, serial as never, walletMode as never);
    await svc.settleEscrow('pt-1');
    expect(txState.orderUpdateMany).not.toHaveBeenCalled();
  });

  it('fail-closed: order tak eligible → lempar DANA_DIRECT_ORDER_INELIGIBLE (webhook me-refund)', async () => {
    const { prisma, txState } = buildPrisma();
    txState.paymentTransactionFindUnique.mockResolvedValue({
      id: 'pt-1',
      purpose: PaymentPurpose.ORDER_ESCROW,
      status: PaymentStatus.PENDING,
      danaPayKind: 'QRIS',
      order: { ...baseOrder, status: 'PROCESSING' }, // sudah tidak WAITING_PAYMENT
    });
    const svc = new DanaDirectPaymentService(prisma as never, danaPayment as never, config as never, serial as never, walletMode as never);
    await expect(svc.settleEscrow('pt-1')).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'DANA_DIRECT_ORDER_INELIGIBLE' }),
    });
    // payment tetap ditandai SUCCESS agar tidak retry; refund ditangani webhook
    expect(txState.paymentTransactionUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: PaymentStatus.SUCCESS }) }),
    );
  });
});
