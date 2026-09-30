import { AdminFinanceService } from './admin-finance.service';
import * as ErrorCodes from '../../../common/constants/error-codes';

/**
 * ADM-213 — recheck manual withdrawal PROCESSING.
 *
 * BAI-042 (P0, 2026-10-01): recheck legacy DINONAKTIFKAN — implementasi lama
 * men-query Midtrans Iris (getIrisPayoutStatus), provider yang SALAH untuk
 * payout era DANA. `recheckWithdrawal` kini selalu melempar 501
 * NOT_IMPLEMENTED (LEGACY_WITHDRAWAL_RECHECK_DISABLED) sebelum menyentuh
 * provider maupun DB. Untuk disbursement DANA gunakan
 * POST /v1/admin/finance/disbursements/:id/recheck (read-only ke DANA).
 * Test di bawah membuktikan tidak ada efek samping.
 */
describe('AdminFinanceService.recheckWithdrawal (ADM-213)', () => {
  const prisma = {
    walletTransaction: { findFirst: jest.fn(), updateMany: jest.fn() },
    $transaction: jest.fn(),
  };
  const auditLog = { logAdminAction: jest.fn().mockResolvedValue(undefined) };
  const midtrans = {
    getIrisPayoutStatus: jest.fn(),
    createIrisPayout: jest.fn(),
  };
  const dashboard = { invalidateSummaryCache: jest.fn(async () => undefined) };

  const makeService = () =>
    new AdminFinanceService(prisma as never, auditLog as never, midtrans as never, dashboard as never);

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('BAI-042: selalu 501 LEGACY_WITHDRAWAL_RECHECK_DISABLED — tanpa efek samping', async () => {
    const svc = makeService();
    await expect(svc.recheckWithdrawal('WLT-RECHECK-1', 'admin-1', '127.0.0.1')).rejects.toMatchObject({
      response: expect.objectContaining({ code: ErrorCodes.LEGACY_WITHDRAWAL_RECHECK_DISABLED }),
    });
    // Fail-closed: provider tidak dihubungi, DB tidak disentuh, tidak ada audit.
    expect(midtrans.getIrisPayoutStatus).not.toHaveBeenCalled();
    expect(midtrans.createIrisPayout).not.toHaveBeenCalled();
    expect(prisma.walletTransaction.findFirst).not.toHaveBeenCalled();
    expect(prisma.walletTransaction.updateMany).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(auditLog.logAdminAction).not.toHaveBeenCalled();
  });

  it('toBeInstanceOf check: error code tersedia', () => {
    expect(ErrorCodes.LEGACY_WITHDRAWAL_RECHECK_DISABLED).toBe('LEGACY_WITHDRAWAL_RECHECK_DISABLED');
  });
});
