import { EscrowDisbursementScope } from '@prisma/client';
import { DisputeDanaSettlementService } from './dispute-dana-settlement.service';

/**
 * M3 — DisputeDanaSettlementService: eksekusi finansial putusan sengketa
 * tanpa wallet. Porsi buyer → DANA Refund API; porsi seller → disbursement
 * ke bank seller; pasca-completion → fail-closed.
 */

function build() {
  const prisma = {
    order: { findUnique: jest.fn() },
    paymentTransaction: { findFirst: jest.fn() },
    // K2: bukti "dana sudah cair ke seller" = baris ORDER_ESCROW; default tidak ada.
    escrowDisbursement: { findFirst: jest.fn().mockResolvedValue(null) },
  };
  const danaDirectRefundService = { refundAmount: jest.fn() };
  const escrowDisbursementService = { releaseFunds: jest.fn() };
  const svc = new DisputeDanaSettlementService(
    prisma as never,
    danaDirectRefundService as never,
    escrowDisbursementService as never,
  );
  return { svc, prisma, danaDirectRefundService, escrowDisbursementService };
}

const baseInput = {
  orderDbId: 'order-1',
  disputeDbId: 'dis-1',
  decision: 'SPLIT' as const,
  buyerAmountSen: BigInt(5_000_00),
  sellerAmountSen: BigInt(4_000_00),
  reason: 'test',
};

function mockPreCompletion(prisma: { order: { findUnique: jest.Mock }; paymentTransaction: { findFirst: jest.Mock } }) {
  prisma.order.findUnique.mockResolvedValue({ id: 'order-1', sellerId: 'seller-1', completedAt: null });
  prisma.paymentTransaction.findFirst.mockResolvedValue({ id: 'pay-1' });
}

describe('DisputeDanaSettlementService (M3 no-wallet)', () => {
  it('SPLIT pra-completion → refund DANA (buyer) + disbursement DISPUTE_RELEASE (seller)', async () => {
    const { svc, prisma, danaDirectRefundService, escrowDisbursementService } = build();
    mockPreCompletion(prisma);
    danaDirectRefundService.refundAmount.mockResolvedValue({ refunded: true, already: false, amountSen: baseInput.buyerAmountSen });
    escrowDisbursementService.releaseFunds.mockResolvedValue({ outcome: 'RELEASED', disbursementId: 'd1', danaReferenceNo: 'ref-1' });

    const res = await svc.settleDisputeNoWallet(baseInput);

    expect(danaDirectRefundService.refundAmount).toHaveBeenCalledWith({
      paymentDbId: 'pay-1',
      amountSen: baseInput.buyerAmountSen,
      reason: 'test',
      idempotencyKey: 'DISPUTE:dis-1:BUYER',
    });
    expect(escrowDisbursementService.releaseFunds).toHaveBeenCalledWith({
      idempotencyKey: 'DISPUTE:dis-1:SELLER',
      scope: EscrowDisbursementScope.DISPUTE_RELEASE,
      scopeRefId: 'dis-1',
      orderId: 'order-1',
      sellerId: 'seller-1',
      amountSen: baseInput.sellerAmountSen,
      reason: expect.any(String),
    });
    expect(res.buyerRefunded).toBe(true);
    expect(res.sellerDisbursement?.outcome).toBe('RELEASED');
  });

  it('FULL_SELLER → tidak ada refund DANA (porsi buyer 0)', async () => {
    const { svc, prisma, danaDirectRefundService, escrowDisbursementService } = build();
    mockPreCompletion(prisma);
    escrowDisbursementService.releaseFunds.mockResolvedValue({ outcome: 'RELEASED', disbursementId: 'd1', danaReferenceNo: null });

    await svc.settleDisputeNoWallet({ ...baseInput, decision: 'FULL_SELLER', buyerAmountSen: BigInt(0) });

    expect(danaDirectRefundService.refundAmount).not.toHaveBeenCalled();
    expect(escrowDisbursementService.releaseFunds).toHaveBeenCalledTimes(1);
  });

  it('SEC-104(a): refund buyer GAGAL → THROW (jangan lanjut diam-diam ke porsi seller)', async () => {
    const { svc, prisma, danaDirectRefundService, escrowDisbursementService } = build();
    mockPreCompletion(prisma);
    // DANA Refund API tidak berhasil (mis. NOT_ELIGIBLE) — bukan {refunded:true}.
    danaDirectRefundService.refundAmount.mockResolvedValue({ refunded: false, already: false, reason: 'NOT_ELIGIBLE' });

    let code: string | undefined;
    try {
      await svc.settleDisputeNoWallet(baseInput);
    } catch (e) {
      code = (e as { response?: { code?: string } }).response?.code;
    }
    expect(code).toBe('DISPUTE_BUYER_REFUND_FAILED');
    // Porsi seller TIDAK BOLEH dicairkan diam-diam saat refund buyer gagal.
    expect(escrowDisbursementService.releaseFunds).not.toHaveBeenCalled();
  });

  it('K2: completedAt terisi oleh tx putusan (FULL_SELLER) TANPA pencairan ORDER_ESCROW → tetap settle', async () => {
    const { svc, prisma, danaDirectRefundService, escrowDisbursementService } = build();
    // Tx putusan FULL_SELLER/SPLIT & mutual resolution menulis completedAt
    // SEBELUM settlement — sebelumnya ini dibaca sebagai "pasca-completion"
    // sehingga uang tidak pernah bergerak.
    prisma.order.findUnique.mockResolvedValue({ id: 'order-1', sellerId: 'seller-1', completedAt: new Date() });
    prisma.paymentTransaction.findFirst.mockResolvedValue({ id: 'pay-1' });
    prisma.escrowDisbursement.findFirst.mockResolvedValue(null);
    escrowDisbursementService.releaseFunds.mockResolvedValue({ outcome: 'RELEASED', disbursementId: 'd1', danaReferenceNo: 'ref-1' });

    const res = await svc.settleDisputeNoWallet({ ...baseInput, decision: 'FULL_SELLER', buyerAmountSen: BigInt(0) });

    expect(danaDirectRefundService.refundAmount).not.toHaveBeenCalled();
    expect(escrowDisbursementService.releaseFunds).toHaveBeenCalledTimes(1);
    expect(res.sellerDisbursement?.outcome).toBe('RELEASED');
    expect(res.sellerAlreadyPaid).toBe(false);
  });

  it('K2: SPLIT dengan completedAt terisi oleh tx putusan → refund buyer + disbursement seller', async () => {
    const { svc, prisma, danaDirectRefundService, escrowDisbursementService } = build();
    prisma.order.findUnique.mockResolvedValue({ id: 'order-1', sellerId: 'seller-1', completedAt: new Date() });
    prisma.paymentTransaction.findFirst.mockResolvedValue({ id: 'pay-1' });
    prisma.escrowDisbursement.findFirst.mockResolvedValue(null);
    danaDirectRefundService.refundAmount.mockResolvedValue({ refunded: true, already: false, amountSen: baseInput.buyerAmountSen });
    escrowDisbursementService.releaseFunds.mockResolvedValue({ outcome: 'RELEASED', disbursementId: 'd1', danaReferenceNo: 'ref-1' });

    const res = await svc.settleDisputeNoWallet(baseInput);

    expect(res.buyerRefunded).toBe(true);
    expect(res.sellerDisbursement?.outcome).toBe('RELEASED');
  });

  it('K2: pasca-completion sungguhan (ada ORDER_ESCROW) + FULL_SELLER → tidak ada pergerakan dana, sellerAlreadyPaid', async () => {
    const { svc, prisma, danaDirectRefundService, escrowDisbursementService } = build();
    prisma.order.findUnique.mockResolvedValue({ id: 'order-1', sellerId: 'seller-1', completedAt: new Date() });
    prisma.escrowDisbursement.findFirst.mockResolvedValue({ id: 'disb-order', status: 'SUCCESS' });

    const res = await svc.settleDisputeNoWallet({ ...baseInput, decision: 'FULL_SELLER', buyerAmountSen: BigInt(0) });

    expect(res.sellerAlreadyPaid).toBe(true);
    expect(res.sellerDisbursement).toBeNull();
    expect(danaDirectRefundService.refundAmount).not.toHaveBeenCalled();
    expect(escrowDisbursementService.releaseFunds).not.toHaveBeenCalled();
  });

  it('pasca-completion (ada pencairan ORDER_ESCROW) + porsi buyer → fail-closed DISPUTE_POST_COMPLETION_MANUAL_REVIEW', async () => {
    const { svc, prisma, danaDirectRefundService, escrowDisbursementService } = build();
    prisma.order.findUnique.mockResolvedValue({ id: 'order-1', sellerId: 'seller-1', completedAt: new Date() });
    prisma.escrowDisbursement.findFirst.mockResolvedValue({ id: 'disb-order', status: 'PENDING' });

    let code: string | undefined;
    try {
      await svc.settleDisputeNoWallet(baseInput);
    } catch (e) {
      code = (e as { response?: { code?: string } }).response?.code;
    }
    expect(code).toBe('DISPUTE_POST_COMPLETION_MANUAL_REVIEW');
    expect(danaDirectRefundService.refundAmount).not.toHaveBeenCalled();
    expect(escrowDisbursementService.releaseFunds).not.toHaveBeenCalled();
  });

  it('tanpa payment DANA-direct → fail-closed DISPUTE_NO_DANA_PAYMENT', async () => {
    const { svc, prisma, danaDirectRefundService, escrowDisbursementService } = build();
    prisma.order.findUnique.mockResolvedValue({ id: 'order-1', sellerId: 'seller-1', completedAt: null });
    prisma.paymentTransaction.findFirst.mockResolvedValue(null);

    let code: string | undefined;
    try {
      await svc.settleDisputeNoWallet(baseInput);
    } catch (e) {
      code = (e as { response?: { code?: string } }).response?.code;
    }
    expect(code).toBe('DISPUTE_NO_DANA_PAYMENT');
    expect(danaDirectRefundService.refundAmount).not.toHaveBeenCalled();
    expect(escrowDisbursementService.releaseFunds).not.toHaveBeenCalled();
  });
});
