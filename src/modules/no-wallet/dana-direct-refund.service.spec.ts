import { PaymentProvider, PaymentStatus } from '@prisma/client';
import { DanaDirectRefundService, deriveDanaRefundNo } from './dana-direct-refund.service';

const danaSuccessPayment = {
  id: 'pt-1',
  provider: PaymentProvider.DANA,
  status: PaymentStatus.SUCCESS,
  danaPayKind: 'QRIS',
  danaPartnerReferenceNo: 'KDH-ABC123',
  grossAmount: BigInt(1510500),
  refundedAmount: BigInt(0),
};

function buildPrisma(payment: any, attemptStore: Record<string, any> = {}) {
  // State "DB" yang hidup antar panggilan dalam satu test — meniru baris
  // paymentTransaction yang berubah oleh updateMany kondisional.
  const state: any = { ...payment };
  return {
    paymentTransaction: {
      findUnique: jest.fn(async () => ({ ...state })),
      findFirst: jest.fn(async () => ({ ...state })),
      update: jest.fn(async () => ({})),
      // SEC-103: semantik kondisional seperti Prisma asli — increment hanya
      // bila refundedAmount masih sama dengan where; count=0 berarti kalah race.
      updateMany: jest.fn(async (args: any) => {
        if (args.where?.refundedAmount !== undefined && state.refundedAmount !== args.where.refundedAmount) {
          return { count: 0 };
        }
        const inc: bigint = args.data?.refundedAmount?.increment ?? BigInt(0);
        state.refundedAmount = (state.refundedAmount ?? BigInt(0)) + inc;
        const { refundedAmount: _drop, ...rest } = args.data ?? {};
        Object.assign(state, rest, { refundedAmount: state.refundedAmount });
        return { count: 1 };
      }),
    },
    danaRefundAttempt: {
      create: jest.fn(async (args: any) => {
        if (attemptStore[args.data.idempotencyKey]) {
          const err = new Error('Unique constraint failed') as any;
          err.code = 'P2002';
          throw err;
        }
        const row = { id: 'att-1', status: 'EXECUTING', amountSen: args.data.amountSen, partnerRefundNo: args.data.partnerRefundNo };
        attemptStore[args.data.idempotencyKey] = row;
        return row;
      }),
      updateMany: jest.fn(async (args: any) => {
        const row = attemptStore[args.where.idempotencyKey];
        if (row && ['PENDING', 'FAILED'].includes(row.status)) {
          row.status = 'EXECUTING';
          return { count: 1 };
        }
        return { count: 0 };
      }),
      findUnique: jest.fn(async (args: any) => attemptStore[args.where.idempotencyKey] ?? null),
      findUniqueOrThrow: jest.fn(async (args: any) => {
        const row = attemptStore[args.where.idempotencyKey];
        if (!row) throw new Error('not found');
        return row;
      }),
      update: jest.fn(async (args: any) => {
        const row = Object.values(attemptStore).find((r: any) => r.id === args.where.id) as any;
        if (row) Object.assign(row, args.data);
        return row ?? {};
      }),
    },
  };
}

const danaPayment = { refundOrder: jest.fn() };

describe('DanaDirectRefundService (refundAmount kanonis)', () => {
  beforeEach(() => jest.clearAllMocks());

  const build = (payment: unknown, store: Record<string, any> = {}) =>
    new DanaDirectRefundService(buildPrisma(payment, store) as never, danaPayment as never);

  it('no-op (NOT_ELIGIBLE) bila payment bukan DANA-direct', async () => {
    const svc = build({ ...danaSuccessPayment, provider: PaymentProvider.MIDTRANS, danaPayKind: null });
    const res = await svc.refundAmount({ paymentDbId: 'pt-1', reason: 'x', idempotencyKey: 'K:1' });
    expect(res).toEqual({ refunded: false, reason: 'NOT_ELIGIBLE' });
    expect(danaPayment.refundOrder).not.toHaveBeenCalled();
  });

  it('no-op bila tanpa danaPartnerReferenceNo', async () => {
    const svc = build({ ...danaSuccessPayment, danaPartnerReferenceNo: null });
    const res = await svc.refundAmount({ paymentDbId: 'pt-1', reason: 'x', idempotencyKey: 'K:1' });
    expect(res.refunded).toBe(false);
    expect(danaPayment.refundOrder).not.toHaveBeenCalled();
  });

  it('idempoten: sudah REFUNDED → refunded=true already=true tanpa panggil DANA', async () => {
    const svc = build({ ...danaSuccessPayment, status: PaymentStatus.REFUNDED, refundedAmount: BigInt(1510500) });
    const res = await svc.refundAmount({ paymentDbId: 'pt-1', reason: 'x', idempotencyKey: 'K:1' });
    expect(res).toEqual({ refunded: true, already: true, amountSen: BigInt(1510500) });
    expect(danaPayment.refundOrder).not.toHaveBeenCalled();
  });

  it('refund penuh via DANA Refund API memakai originalPartnerReferenceNo', async () => {
    const prisma = buildPrisma(danaSuccessPayment);
    danaPayment.refundOrder.mockResolvedValue({ partnerRefundNo: 'RFD-x', referenceNo: 'DANA-RFD-1', status: 'SUCCESS' });
    const svc = new DanaDirectRefundService(prisma as never, danaPayment as never);

    const res = await svc.refundAmount({ paymentDbId: 'pt-1', reason: 'Cancel sebelum kirim', idempotencyKey: 'ORDER:o-1:FULL' });

    expect(res).toEqual({ refunded: true, already: false, amountSen: BigInt(1510500) });
    expect(danaPayment.refundOrder).toHaveBeenCalledWith(
      expect.objectContaining({
        partnerReferenceNo: 'KDH-ABC123',
        amountIdr: 15105,
        reason: 'Cancel sebelum kirim',
      }),
    );
    // payment ditandai REFUNDED via klaim kondisional (increment, bukan overwrite dari snapshot basi)
    expect(prisma.paymentTransaction.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: 'pt-1', refundedAmount: BigInt(0) }),
        data: expect.objectContaining({
          status: PaymentStatus.REFUNDED,
          refundedAmount: { increment: BigInt(1510500) },
        }),
      }),
    );
    // attempt ditandai SUCCESS
    expect(prisma.danaRefundAttempt.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'SUCCESS' }) }),
    );
  });

  it('refund parsial: status tetap SUCCESS, refundedAmount bertambah', async () => {
    const prisma = buildPrisma(danaSuccessPayment);
    danaPayment.refundOrder.mockResolvedValue({ partnerRefundNo: 'RFD-y', referenceNo: 'DANA-RFD-2', status: 'SUCCESS' });
    const svc = new DanaDirectRefundService(prisma as never, danaPayment as never);

    const res = await svc.refundAmount({
      paymentDbId: 'pt-1',
      amountSen: BigInt(500000),
      reason: 'Retur parsial',
      idempotencyKey: 'RETURN:r-1',
    });

    expect(res).toEqual({ refunded: true, already: false, amountSen: BigInt(500000) });
    expect(danaPayment.refundOrder).toHaveBeenCalledWith(
      expect.objectContaining({ amountIdr: 5000 }),
    );
    expect(prisma.paymentTransaction.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ refundedAmount: BigInt(0) }),
        data: expect.objectContaining({ refundedAmount: { increment: BigInt(500000) } }),
      }),
    );
    // status TIDAK jadi REFUNDED untuk parsial
    const updateData = (prisma.paymentTransaction.updateMany as jest.Mock).mock.calls[0][0].data;
    expect(updateData.status).toBeUndefined();
  });

  it('idempoten via idempotencyKey: panggilan kedua tidak memanggil DANA lagi', async () => {
    const store: Record<string, any> = {};
    const prisma = buildPrisma(danaSuccessPayment, store);
    danaPayment.refundOrder.mockResolvedValue({ partnerRefundNo: 'RFD-z', referenceNo: 'DANA-RFD-3', status: 'SUCCESS' });
    const svc = new DanaDirectRefundService(prisma as never, danaPayment as never);

    const r1 = await svc.refundAmount({ paymentDbId: 'pt-1', reason: 'x', idempotencyKey: 'K:DUP' });
    expect(r1.refunded).toBe(true);
    expect(danaPayment.refundOrder).toHaveBeenCalledTimes(1);

    // Panggilan kedua: klaim gagal (sudah SUCCESS) → hasil existing, tanpa DANA call.
    const r2 = await svc.refundAmount({ paymentDbId: 'pt-1', reason: 'x', idempotencyKey: 'K:DUP' });
    expect(r2).toEqual({ refunded: true, already: true, amountSen: BigInt(1510500) });
    expect(danaPayment.refundOrder).toHaveBeenCalledTimes(1);
  });

  it('attempt FAILED ditandai FAILED agar retry terjadwal bisa ambil alih', async () => {
    const prisma = buildPrisma(danaSuccessPayment);
    danaPayment.refundOrder.mockRejectedValue(new Error('DANA down'));
    const svc = new DanaDirectRefundService(prisma as never, danaPayment as never);
    await expect(
      svc.refundAmount({ paymentDbId: 'pt-1', reason: 'x', idempotencyKey: 'K:FAIL' }),
    ).rejects.toThrow('DANA down');
    expect(prisma.danaRefundAttempt.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: 'FAILED' } }),
    );
  });

  it('refundPayment (kompat) mendelegasikan ke refundAmount penuh', async () => {
    const prisma = buildPrisma(danaSuccessPayment);
    danaPayment.refundOrder.mockResolvedValue({ partnerRefundNo: 'RFD-w', referenceNo: 'DANA-RFD-4', status: 'SUCCESS' });
    const svc = new DanaDirectRefundService(prisma as never, danaPayment as never);
    expect(await svc.refundPayment('pt-1', 'alasan')).toBe(true);
    expect(danaPayment.refundOrder).toHaveBeenCalledTimes(1);
  });

  it('refundOrderEscrow memakai payment SUCCESS terbaru untuk order', async () => {
    const prisma = buildPrisma(danaSuccessPayment);
    danaPayment.refundOrder.mockResolvedValue({ partnerRefundNo: 'RFD-v', referenceNo: 'DANA-RFD-5', status: 'SUCCESS' });
    const svc = new DanaDirectRefundService(prisma as never, danaPayment as never);
    expect(await svc.refundOrderEscrow('order-db-1', 'auto-cancel')).toBe(true);
    expect(prisma.paymentTransaction.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ orderId: 'order-db-1' }) }),
    );
  });

  it('refundOrderEscrow no-op bila tidak ada payment DANA untuk order', async () => {
    const prisma = buildPrisma(danaSuccessPayment);
    (prisma.paymentTransaction.findFirst as jest.Mock).mockResolvedValue(null);
    const svc = new DanaDirectRefundService(prisma as never, danaPayment as never);
    expect(await svc.refundOrderEscrow('order-db-x', 'auto-cancel')).toBe(false);
    expect(danaPayment.refundOrder).not.toHaveBeenCalled();
  });

  describe('SEC-103: refund konkuren dengan key berbeda (anti over-refund)', () => {
    it('dua refund konkuren — total refundedAmount benar (increment), bukan overwrite penulis-terakhir', async () => {
      const prisma = buildPrisma({ ...danaSuccessPayment });
      danaPayment.refundOrder.mockResolvedValue({ partnerRefundNo: 'x', referenceNo: 'DANA-R', status: 'SUCCESS' });
      const svc = new DanaDirectRefundService(prisma as never, danaPayment as never);

      const [r1, r2] = await Promise.all([
        svc.refundAmount({ paymentDbId: 'pt-1', amountSen: BigInt(500000), reason: 'retur', idempotencyKey: 'RETURN:r-1' }),
        svc.refundAmount({ paymentDbId: 'pt-1', amountSen: BigInt(400000), reason: 'dispute', idempotencyKey: 'DISPUTE:d-1:BUYER' }),
      ]);

      expect(r1.refunded).toBe(true);
      expect(r2.refunded).toBe(true);
      // Semua pencatatan memakai increment kondisional — tidak ada overwrite.
      const calls = (prisma.paymentTransaction.updateMany as jest.Mock).mock.calls;
      expect(calls.length).toBeGreaterThanOrEqual(2);
      for (const c of calls) {
        expect(c[0].data.refundedAmount).toEqual({ increment: expect.any(BigInt) });
      }
      // Total TEPAT 900000 — pola overwrite lama akan mencatat 500000 atau 400000.
      const finalState = await (prisma.paymentTransaction.findUnique as jest.Mock)();
      expect(finalState.refundedAmount).toBe(BigInt(900000));
    });

    it('over-refund konkuren diblokir: total melebihi gross → OVER_REFUND_BLOCKED, DB tidak over-record', async () => {
      const prisma = buildPrisma({ ...danaSuccessPayment, grossAmount: BigInt(1000000), refundedAmount: BigInt(0) });
      danaPayment.refundOrder.mockResolvedValue({ partnerRefundNo: 'x', referenceNo: 'DANA-R', status: 'SUCCESS' });
      const svc = new DanaDirectRefundService(prisma as never, danaPayment as never);

      const [r1, r2] = await Promise.allSettled([
        svc.refundAmount({ paymentDbId: 'pt-1', amountSen: BigInt(700000), reason: 'a', idempotencyKey: 'K:A' }),
        svc.refundAmount({ paymentDbId: 'pt-1', amountSen: BigInt(700000), reason: 'b', idempotencyKey: 'K:B' }),
      ]);

      const fulfilled = [r1, r2].filter((r) => r.status === 'fulfilled');
      const rejected = [r1, r2].filter((r) => r.status === 'rejected');
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect((rejected[0] as PromiseRejectedResult).reason.message).toMatch(/OVER_REFUND_BLOCKED/);
      // DB mencatat hanya 700000 — tidak pernah overwrite menjadi 1400000.
      const finalState = await (prisma.paymentTransaction.findUnique as jest.Mock)();
      expect(finalState.refundedAmount).toBe(BigInt(700000));
    });
  });

  describe('P1: partnerRefundNo deterministik (anti double-refund)', () => {
    it('deriveDanaRefundNo stabil per key, unik antar key, format RFD- + 12 hex', () => {
      const a1 = deriveDanaRefundNo('ORDER:o-1:FULL');
      const a2 = deriveDanaRefundNo('ORDER:o-1:FULL');
      const b = deriveDanaRefundNo('ORDER:o-2:FULL');
      expect(a1).toBe(a2);
      expect(a1).not.toBe(b);
      expect(a1).toMatch(/^RFD-[0-9A-F]{12}$/);
    });

    it('refundAmount memakai partnerRefundNo deterministik dari idempotencyKey', async () => {
      const prisma = buildPrisma(danaSuccessPayment);
      danaPayment.refundOrder.mockResolvedValue({ partnerRefundNo: 'x', referenceNo: 'DANA-RFD-9', status: 'SUCCESS' });
      const svc = new DanaDirectRefundService(prisma as never, danaPayment as never);
      await svc.refundAmount({ paymentDbId: 'pt-1', reason: 'x', idempotencyKey: 'ORDER:o-9:FULL' });
      const expected = deriveDanaRefundNo('ORDER:o-9:FULL');
      expect(danaPayment.refundOrder).toHaveBeenCalledWith(
        expect.objectContaining({ partnerRefundNo: expected }),
      );
      expect(prisma.danaRefundAttempt.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ partnerRefundNo: expected }) }),
      );
    });

    it('retry setelah FAILED memakai partnerRefundNo ASLI (bukan yang baru)', async () => {
      const store: Record<string, any> = {};
      const prisma = buildPrisma(danaSuccessPayment, store);
      const svc = new DanaDirectRefundService(prisma as never, danaPayment as never);

      // Attempt 1: DANA timeout setelah menerima refund (hasil ambigu) → FAILED.
      danaPayment.refundOrder.mockRejectedValueOnce(new Error('timeout'));
      await expect(
        svc.refundAmount({ paymentDbId: 'pt-1', reason: 'x', idempotencyKey: 'ORDER:o-8:FULL' }),
      ).rejects.toThrow('timeout');
      const firstRefundNo = store['ORDER:o-8:FULL'].partnerRefundNo;
      expect(firstRefundNo).toBe(deriveDanaRefundNo('ORDER:o-8:FULL'));

      // Retry: klaim baris FAILED → refundNo yang SAMA dikirim ke DANA
      // (DANA dedupe per (merchantId, partnerRefundNo) → bukan refund kedua).
      danaPayment.refundOrder.mockResolvedValue({ partnerRefundNo: 'x', referenceNo: 'DANA-RFD-8', status: 'SUCCESS' });
      const r2 = await svc.refundAmount({ paymentDbId: 'pt-1', reason: 'x', idempotencyKey: 'ORDER:o-8:FULL' });
      expect(r2.refunded).toBe(true);
      const calls = (danaPayment.refundOrder as jest.Mock).mock.calls;
      expect(calls[1][0].partnerRefundNo).toBe(firstRefundNo);
      // Baris attempt TIDAK ditimpa refundNo baru.
      expect(store['ORDER:o-8:FULL'].partnerRefundNo).toBe(firstRefundNo);
    });
  });
});
