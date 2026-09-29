import { EscrowDisbursementScope } from '@prisma/client';
import {
  planDanaCashback,
  executeDanaCashback,
  danaCashbackKey,
  DanaCashbackIntent,
} from './cashback-credit.util';

/**
 * M4 — cashback tanpa wallet internal:
 * - planDanaCashback: read-only di dalam tx; guard idempotensi via
 *   escrowDisbursement `CASHBACK:<orderDbId>`; TIDAK menyentuh wallet.
 * - executeDanaCashback: payout post-commit via releaseFunds scope CASHBACK.
 */
describe('cashback DANA (M4 no-wallet)', () => {
  const params = { orderDbId: 'order-db-1', orderPublicId: 'ORD-1', source: 'completeOrder' };

  function buildTx(opts: { existingDisbursement?: boolean; usage?: boolean } = {}) {
    const walletTouch = jest.fn(async () => { throw new Error('WALLET_TOUCHED'); });
    return {
      escrowDisbursement: {
        findUnique: jest.fn(async () => (opts.existingDisbursement ? { id: 'ed-1' } : null)),
      },
      voucherUsage: {
        findFirst: jest.fn(async () =>
          opts.usage === false
            ? null
            : { id: 'vu-1', userId: 'buyer-1', discountApplied: BigInt(1_000_000), voucher: { code: 'CB10' } },
        ),
      },
      wallet: { findUnique: walletTouch, updateMany: walletTouch },
      walletTransaction: { create: walletTouch, findFirst: walletTouch },
    };
  }

  it('plan: eligible + belum ada disbursement → intent (wallet tak tersentuh)', async () => {
    const tx = buildTx();
    const intent = await planDanaCashback(tx as never, params);

    expect(intent).toMatchObject({ userId: 'buyer-1', amountSen: BigInt(1_000_000), voucherCode: 'CB10' });
    expect(tx.escrowDisbursement.findUnique).toHaveBeenCalledWith({
      where: { idempotencyKey: 'CASHBACK:order-db-1' },
      select: { id: true },
    });
    expect(tx.wallet.findUnique).not.toHaveBeenCalled();
    expect(tx.wallet.updateMany).not.toHaveBeenCalled();
    expect(tx.walletTransaction.create).not.toHaveBeenCalled();
  });

  it('plan: disbursement sudah ada → null (idempoten, tidak double)', async () => {
    const tx = buildTx({ existingDisbursement: true });
    expect(await planDanaCashback(tx as never, params)).toBeNull();
    expect(tx.voucherUsage.findFirst).not.toHaveBeenCalled();
  });

  it('plan: tanpa voucherUsage cashback → null', async () => {
    const tx = buildTx({ usage: false });
    expect(await planDanaCashback(tx as never, params)).toBeNull();
  });

  it('execute: memanggil releaseFunds dengan key stabil scope CASHBACK', async () => {
    const releaseFunds = jest.fn(async () => ({ outcome: 'RELEASED' }));
    const intent: DanaCashbackIntent = {
      userId: 'buyer-1',
      amountSen: BigInt(1_000_000),
      voucherCode: 'CB10',
      usageId: 'vu-1',
    };

    const res = await executeDanaCashback({ releaseFunds } as never, params, intent);

    expect(res.outcome).toBe('RELEASED');
    expect(releaseFunds).toHaveBeenCalledWith({
      idempotencyKey: danaCashbackKey('order-db-1'),
      scope: EscrowDisbursementScope.CASHBACK,
      sellerId: 'buyer-1',
      amountSen: BigInt(1_000_000),
      reason: expect.stringContaining('ORD-1'),
    });
  });
});
