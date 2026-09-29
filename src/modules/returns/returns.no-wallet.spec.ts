import { ReturnsService } from './returns.service';

/**
 * M3 — refund retur dalam mode tanpa-wallet (BI-safe): refund ke metode
 * bayar asal via DANA Refund API, idempoten per RETURN:<returnDbId>.
 * Wallet TIDAK disentuh; approval dipakai sebagai klaim idempoten.
 */
type TimelineCall = [{ data: { event: string; metadata?: Record<string, unknown> } }];

describe('ReturnsService.executeRefundForReturn (M3 no-wallet)', () => {
  function build(walletEnabled: boolean) {
    const j = <T>() => jest.fn() as jest.Mock<Promise<T>, []>;
    const returnTimelineCreate = j<unknown>();
    returnTimelineCreate.mockResolvedValue({});
    const walletFindFirst = j<unknown>();
    walletFindFirst.mockRejectedValue(new Error('WALLET_TOUCHED'));
    const prisma = {
      paymentTransaction: { findFirst: j<unknown>() },
      danaRefundAttempt: { findUnique: j<unknown>() },
      wallet: { findFirst: walletFindFirst },
      returnTimeline: { create: returnTimelineCreate },
      // Model yang dibutuhkan getReturnsDb (returns.db.ts).
      returnPolicy: {},
      returnRequest: {},
      returnAttachment: {},
      returnNote: {},
      returnShipmentEvent: {},
      returnRefundApproval: {},
    };
    const claimExecution = j<boolean>();
    claimExecution.mockResolvedValue(true);
    const markVoid = () => { const m = j<void>(); m.mockResolvedValue(undefined); return m; };
    const ledgerRefund = j<unknown>();
    ledgerRefund.mockRejectedValue(new Error('WALLET_LEDGER_TOUCHED'));
    const refundService = {
      getApproval: j<unknown>(),
      claimExecution,
      createApproval: j<unknown>(),
      markExecuted: markVoid(),
      markFailed: markVoid(),
      executeLedgerRefund: ledgerRefund,
    };
    const walletMode = { isWalletEnabled: jest.fn(() => walletEnabled) };
    const danaDirectRefundService = { refundAmount: jest.fn() };
    const svc = new ReturnsService(
      prisma as never,
      {} as never,
      {} as never,
      {} as never,
      { notifyStage: jest.fn() } as never,
      refundService as never,
      walletMode as never,
      danaDirectRefundService as never,
    );
    return { svc, prisma, refundService, danaDirectRefundService, returnTimelineCreate };
  }

  const ret = {
    id: 'ret-1', returnId: 'RTN-20260929-000001', orderId: 'order-1',
    buyerId: 'buyer-1', sellerId: 'seller-1',
  };
  const approval = { id: 'ap-1', amount: BigInt(5_000_00), status: 'PENDING' };

  it('wallet mati → refund DANA ke metode bayar asal, wallet tak tersentuh', async () => {
    const { svc, prisma, refundService, danaDirectRefundService, returnTimelineCreate } = build(false);
    refundService.getApproval.mockResolvedValue(approval);
    prisma.paymentTransaction.findFirst.mockResolvedValue({ id: 'pay-1' });
    danaDirectRefundService.refundAmount.mockResolvedValue({ refunded: true, already: false, amountSen: approval.amount });
    prisma.danaRefundAttempt.findUnique.mockResolvedValue({ partnerRefundNo: 'RFD-ABC', danaReferenceNo: 'DANA-REF-1' });

    await (svc as unknown as { executeRefundForReturn: (r: unknown, a: string, ar: string) => Promise<void> })
      .executeRefundForReturn(ret, 'admin-1', 'ADMIN');

    expect(danaDirectRefundService.refundAmount).toHaveBeenCalledWith({
      paymentDbId: 'pay-1',
      amountSen: approval.amount,
      reason: expect.stringContaining('RTN-20260929-000001'),
      idempotencyKey: 'RETURN:ret-1',
    });
    expect(refundService.markExecuted).toHaveBeenCalledWith('ap-1', ['dana:DANA-REF-1']);
    expect(refundService.executeLedgerRefund).not.toHaveBeenCalled();
    expect(prisma.wallet.findFirst).not.toHaveBeenCalled();
    const calls = returnTimelineCreate.mock.calls as unknown as TimelineCall[];
    const executedEvents = calls.filter(([args]) => args.data.event === 'REFUND_EXECUTED');
    expect(executedEvents).toHaveLength(1);
    expect(executedEvents[0]?.[0].data.metadata?.channel).toBe('DANA_REFUND');
  });

  it('wallet mati + tanpa payment DANA → fail-closed, approval FAILED', async () => {
    const { svc, prisma, refundService, danaDirectRefundService } = build(false);
    refundService.getApproval.mockResolvedValue(approval);
    prisma.paymentTransaction.findFirst.mockResolvedValue(null);

    await expect(
      (svc as unknown as { executeRefundForReturn: (r: unknown, a: string, ar: string) => Promise<void> })
        .executeRefundForReturn(ret, 'admin-1', 'ADMIN'),
    ).rejects.toThrow();

    expect(danaDirectRefundService.refundAmount).not.toHaveBeenCalled();
    expect(refundService.markFailed).toHaveBeenCalledWith('ap-1', expect.any(String));
    expect(refundService.markExecuted).not.toHaveBeenCalled();
  });

  it('wallet hidup → jalur ledger wallet lama', async () => {
    const { svc, prisma, refundService, danaDirectRefundService } = build(true);
    refundService.getApproval.mockResolvedValue(approval);
    prisma.wallet.findFirst
      .mockResolvedValueOnce({ id: 'w-seller' })
      .mockResolvedValueOnce({ id: 'w-buyer' });
    refundService.executeLedgerRefund.mockResolvedValue(['tx-1']);

    await (svc as unknown as { executeRefundForReturn: (r: unknown, a: string, ar: string) => Promise<void> })
      .executeRefundForReturn(ret, 'admin-1', 'ADMIN');

    expect(danaDirectRefundService.refundAmount).not.toHaveBeenCalled();
    expect(refundService.executeLedgerRefund).toHaveBeenCalledTimes(1);
  });
});
