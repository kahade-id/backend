import { DanaRefundRetryService } from '../services/dana-refund-retry.service';

jest.mock('../../../common/utils/cron-jitter.util', () => ({
  cronJitter: jest.fn().mockResolvedValue(undefined),
}));

/**
 * M3 — cron dana-refund-retry: attempt refund DANA yang FAILED dicoba ulang
 * + disbursement PENDING/FAILED direkonsiliasi, di bawah redis lock.
 */
describe('DanaRefundRetryService (M3 no-wallet)', () => {
  function build(healthy = true, lockAcquired = true) {
    const redis = {
      isHealthy: jest.fn(async () => healthy),
      setNx: jest.fn(async () => lockAcquired),
      del: jest.fn(async () => 1),
    };
    const danaDirectRefundService = {
      retryFailedRefunds: jest.fn(async () => ({ retried: 2, succeeded: 1 })),
    };
    const escrowDisbursementService = {
      retryDue: jest.fn(async () => 3),
    };
    const referralService = {
      payoutPendingReferralRewards: jest.fn(async () => ({ attempted: 1, released: 1 })),
    };
    const walletMode = { isWalletEnabled: jest.fn(() => false) };
    const svc = new DanaRefundRetryService(
      {} as never,
      redis as never,
      danaDirectRefundService as never,
      escrowDisbursementService as never,
      referralService as never,
      walletMode as never,
    );
    return { svc, redis, danaDirectRefundService, escrowDisbursementService, referralService, walletMode };
  }

  it('menjalankan retry refund + retry disbursement + payout referral di bawah lock', async () => {
    const { svc, redis, danaDirectRefundService, escrowDisbursementService, referralService } = build();

    await svc.retryStaleNoWalletMoney();

    expect(danaDirectRefundService.retryFailedRefunds).toHaveBeenCalledWith(50);
    expect(escrowDisbursementService.retryDue).toHaveBeenCalledWith(50);
    expect(referralService.payoutPendingReferralRewards).toHaveBeenCalledWith(50);
    expect(redis.setNx).toHaveBeenCalledWith('cron_lock:dana_refund_retry', expect.any(String), 600);
    expect(redis.del).toHaveBeenCalledWith('cron_lock:dana_refund_retry');
  });

  it('M4: payout referral dilewati bila wallet masih hidup', async () => {
    const built = build();
    (built.walletMode.isWalletEnabled as jest.Mock).mockReturnValue(true);

    await built.svc.retryStaleNoWalletMoney();

    expect(built.referralService.payoutPendingReferralRewards).not.toHaveBeenCalled();
  });

  it('skip bila lock tidak didapat (replica lain sedang jalan)', async () => {
    const { svc, danaDirectRefundService, escrowDisbursementService } = build(true, false);

    await svc.retryStaleNoWalletMoney();

    expect(danaDirectRefundService.retryFailedRefunds).not.toHaveBeenCalled();
    expect(escrowDisbursementService.retryDue).not.toHaveBeenCalled();
  });

  it('skip bila redis down', async () => {
    const { svc, danaDirectRefundService, escrowDisbursementService } = build(false);

    await svc.retryStaleNoWalletMoney();

    expect(danaDirectRefundService.retryFailedRefunds).not.toHaveBeenCalled();
    expect(escrowDisbursementService.retryDue).not.toHaveBeenCalled();
  });
});
