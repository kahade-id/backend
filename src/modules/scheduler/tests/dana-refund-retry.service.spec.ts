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
    const svc = new DanaRefundRetryService(
      {} as never,
      redis as never,
      danaDirectRefundService as never,
      escrowDisbursementService as never,
    );
    return { svc, redis, danaDirectRefundService, escrowDisbursementService };
  }

  it('menjalankan retry refund + retry disbursement di bawah lock', async () => {
    const { svc, redis, danaDirectRefundService, escrowDisbursementService } = build();

    await svc.retryStaleNoWalletMoney();

    expect(danaDirectRefundService.retryFailedRefunds).toHaveBeenCalledWith(50);
    expect(escrowDisbursementService.retryDue).toHaveBeenCalledWith(50);
    expect(redis.setNx).toHaveBeenCalledWith('cron_lock:dana_refund_retry', expect.any(String), 600);
    expect(redis.del).toHaveBeenCalledWith('cron_lock:dana_refund_retry');
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
