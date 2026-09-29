import { EscrowDisbursementScope } from '@prisma/client';
import { ReferralService } from '../referral.service';

/**
 * M4 — referral tanpa wallet internal:
 * - creditReward (wallet mati): klaim reward TANPA menyentuh wallet; payout
 *   aktual didorong scheduler via disbursement DANA scope REFERRAL.
 * - payoutPendingReferralRewards: idempoten (key REFERRAL:<rewardId>),
 *   isCredited=true hanya setelah RELEASED; HELD_NO_BANK tetap pending.
 */
describe('ReferralService (M4 no-wallet)', () => {
  function build(walletEnabled: boolean) {
    const tx = {
      referralReward: {
        findFirst: jest.fn(async () => null),
        create: jest.fn(async (args: { data: Record<string, unknown> }) => ({ id: 'rw-1', ...args.data })),
        update: jest.fn(async () => ({})),
      },
      referralCode: { updateMany: jest.fn(async () => ({ count: 1 })) },
      wallet: {
        count: jest.fn(async () => { throw new Error('WALLET_TOUCHED'); }),
        update: jest.fn(async () => { throw new Error('WALLET_TOUCHED'); }),
      },
      walletTransaction: {
        findFirst: jest.fn(async () => { throw new Error('WALLET_TOUCHED'); }),
        create: jest.fn(async () => { throw new Error('WALLET_TOUCHED'); }),
      },
    };
    const prisma = {
      referralReward: {
        findMany: jest.fn(async () => []),
        update: jest.fn(async () => ({})),
      },
    };
    const releaseFunds = jest.fn(async () => ({ outcome: 'RELEASED', disbursementId: 'd-1' }));
    const svc = new ReferralService(
      prisma as never,
      {} as never,
      { getNext: jest.fn(async () => 1) } as never,
      {} as never,
      { isWalletEnabled: () => walletEnabled } as never,
      { releaseFunds } as never,
    );
    return { svc, tx, prisma, releaseFunds };
  }

  it('wallet mati → creditReward klaim reward tanpa menyentuh wallet', async () => {
    const { svc, tx } = build(false);

    const ok = await (svc as unknown as {
      creditReward: (u: string, a: bigint, f: bigint, o: string, r: string, d: string, t: unknown) => Promise<boolean>;
    }).creditReward('user-2', BigInt(500_000), BigInt(0), 'order-1', 'rel-1', 'desc', tx);

    expect(ok).toBe(true);
    expect(tx.referralReward.create).toHaveBeenCalledTimes(1);
    expect(tx.referralCode.updateMany).toHaveBeenCalled();
    // Wallet tidak tersentuh sama sekali (semua mock wallet melempar bila dipanggil).
    expect(tx.wallet.count).not.toHaveBeenCalled();
    expect(tx.wallet.update).not.toHaveBeenCalled();
    expect(tx.walletTransaction.create).not.toHaveBeenCalled();
  });

  it('wallet mati → payoutPendingReferralRewards membayar via DANA scope REFERRAL', async () => {
    const { svc, prisma, releaseFunds } = build(false);
    (prisma.referralReward.findMany as jest.Mock).mockResolvedValue([
      { id: 'rw-1', referrerId: 'user-2', rewardAmount: BigInt(500_000), triggeredByOrderId: 'order-1' },
    ]);

    const res = await svc.payoutPendingReferralRewards(50);

    expect(res).toEqual({ attempted: 1, released: 1 });
    expect(releaseFunds).toHaveBeenCalledWith({
      idempotencyKey: 'REFERRAL:rw-1',
      scope: EscrowDisbursementScope.REFERRAL,
      sellerId: 'user-2',
      amountSen: BigInt(500_000),
      reason: expect.stringContaining('order-1'),
    });
    expect(prisma.referralReward.update).toHaveBeenCalledWith({
      where: { id: 'rw-1' },
      data: { isCredited: true, creditedAt: expect.any(Date) },
    });
  });

  it('HELD_NO_BANK → isCredited tetap false (fail-closed, dicoba lagi scheduler)', async () => {
    const { svc, prisma, releaseFunds } = build(false);
    releaseFunds.mockResolvedValue({ outcome: 'HELD_NO_BANK', disbursementId: 'd-1' });
    (prisma.referralReward.findMany as jest.Mock).mockResolvedValue([
      { id: 'rw-2', referrerId: 'user-3', rewardAmount: BigInt(500_000), triggeredByOrderId: 'order-2' },
    ]);

    const res = await svc.payoutPendingReferralRewards(50);

    expect(res).toEqual({ attempted: 1, released: 0 });
    expect(prisma.referralReward.update).not.toHaveBeenCalled();
  });
});
