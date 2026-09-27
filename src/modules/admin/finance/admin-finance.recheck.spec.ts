import { ConflictException, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { AdminFinanceService } from './admin-finance.service';
import * as ErrorCodes from '../../../common/constants/error-codes';

/**
 * ADM-213 — recheck manual withdrawal PROCESSING.
 * Membuktikan:
 *  1. Hanya status PROCESSING yang bisa dicek ulang (409 WITHDRAWAL_NOT_PROCESSING).
 *  2. Tx tidak ada → 404; provider mengeksekusi completed/processed → SUCCESS.
 *  3. Provider failed → FAILED + refund wallet (tanpa payout baru).
 *  4. Provider queued/not_found/tidak terjangkau → tetap PROCESSING, tanpa mutasi.
 *  5. TIDAK PERNAH memanggil createIrisPayout (bukan retry).
 *  6. Setiap recheck dicatat dengan aksi audit WITHDRAWAL_RECHECKED.
 */
describe('AdminFinanceService.recheckWithdrawal (ADM-213)', () => {
  const ptx = {
    walletTransaction: { updateMany: jest.fn() },
    wallet: { findUnique: jest.fn(), updateMany: jest.fn() },
  };
  const prisma = {
    walletTransaction: { findFirst: jest.fn(), updateMany: jest.fn() },
    wallet: { findUnique: jest.fn(), updateMany: jest.fn() },
    $transaction: jest.fn(),
  };
  const auditLog = { logAdminAction: jest.fn().mockResolvedValue(undefined) };
  const midtrans = {
    getIrisPayoutStatus: jest.fn(),
    createIrisPayout: jest.fn(),
  };
  const dashboard = { invalidateSummaryCache: jest.fn(async () => undefined) };

  const makeTx = (withdrawStatus: string) => ({
    id: 'withdraw-internal-1',
    txId: 'WLT-RECHECK-1',
    amount: 5000000n,
    walletId: 'wallet-1',
    withdrawStatus,
    description: 'Processing by admin',
    createdAt: new Date(),
  });

  const makeService = () =>
    new AdminFinanceService(prisma as never, auditLog as never, midtrans as never, dashboard as never);

  beforeEach(() => {
    jest.clearAllMocks();
    prisma.$transaction.mockImplementation(async (cb: (t: unknown) => Promise<unknown>) => cb(ptx));
    ptx.walletTransaction.updateMany.mockResolvedValue({ count: 1 });
    ptx.wallet.findUnique.mockResolvedValue({
      id: 'wallet-1',
      version: 7,
      todayWithdrawAmount: 0n,
    });
    ptx.wallet.updateMany.mockResolvedValue({ count: 1 });
    prisma.walletTransaction.updateMany.mockResolvedValue({ count: 1 });
  });

  it('404 bila withdrawal tidak ditemukan', async () => {
    prisma.walletTransaction.findFirst.mockResolvedValue(null);
    const svc = makeService();
    const err = await svc.recheckWithdrawal('WLT-X', 'admin-1', '127.0.0.1').catch(e => e);
    expect(err).toBeInstanceOf(NotFoundException);
    expect(err.response.code).toBe(ErrorCodes.NOT_FOUND);
    expect(midtrans.getIrisPayoutStatus).not.toHaveBeenCalled();
  });

  it('409 WITHDRAWAL_NOT_PROCESSING bila status bukan PROCESSING (provider tidak dihubungi)', async () => {
    prisma.walletTransaction.findFirst.mockResolvedValue(makeTx('PENDING_PROCESS'));
    const svc = makeService();
    const err = await svc.recheckWithdrawal('WLT-RECHECK-1', 'admin-1', '127.0.0.1').catch(e => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect(err.response.code).toBe(ErrorCodes.WITHDRAWAL_NOT_PROCESSING);
    expect(midtrans.getIrisPayoutStatus).not.toHaveBeenCalled();
    expect(prisma.walletTransaction.updateMany).not.toHaveBeenCalled();
  });

  it.each(['completed', 'processed'])('provider %s → SUCCESS + audit WITHDRAWAL_RECHECKED', async providerStatus => {
    prisma.walletTransaction.findFirst.mockResolvedValue(makeTx('PROCESSING'));
    midtrans.getIrisPayoutStatus.mockResolvedValue({ status: providerStatus, referenceNo: 'WLT-RECHECK-1' });
    const svc = makeService();
    const res = (await svc.recheckWithdrawal('WLT-RECHECK-1', 'admin-1', '127.0.0.1')) as {
      outcome: string; changed: boolean; providerStatus: string;
    };
    expect(res.outcome).toBe('CONFIRMED');
    expect(res.changed).toBe(true);
    expect(res.providerStatus).toBe(providerStatus);
    expect(prisma.walletTransaction.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: 'withdraw-internal-1', withdrawStatus: 'PROCESSING' }),
        data: expect.objectContaining({ withdrawStatus: 'SUCCESS', status: 'SUCCESS' }),
      }),
    );
    expect(auditLog.logAdminAction).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'WITHDRAWAL_RECHECKED', targetId: 'withdraw-internal-1' }),
    );
    expect(midtrans.createIrisPayout).not.toHaveBeenCalled();
  });

  it.each(['failed', 'rejected'])('provider %s → FAILED + refund wallet, tanpa payout baru', async providerStatus => {
    prisma.walletTransaction.findFirst.mockResolvedValue(makeTx('PROCESSING'));
    midtrans.getIrisPayoutStatus.mockResolvedValue({ status: providerStatus, referenceNo: 'WLT-RECHECK-1' });
    const svc = makeService();
    const res = (await svc.recheckWithdrawal('WLT-RECHECK-1', 'admin-1', '127.0.0.1')) as {
      outcome: string; changed: boolean;
    };
    expect(res.outcome).toBe('FAILED_REFUNDED');
    expect(res.changed).toBe(true);
    // refund: wallet di-increment sebesar amount
    expect(ptx.wallet.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: 'wallet-1', version: 7 }),
        data: expect.objectContaining({
          availableBalance: { increment: 5000000n },
          totalBalance: { increment: 5000000n },
        }),
      }),
    );
    const claimData = ptx.walletTransaction.updateMany.mock.calls[0][0].data;
    expect(claimData.withdrawStatus).toBe('FAILED');
    expect(midtrans.createIrisPayout).not.toHaveBeenCalled();
  });

  it.each(['queued', 'processing', 'not_found', 'unknown'])(
    'provider %s → tetap PROCESSING, tanpa mutasi uang',
    async providerStatus => {
      prisma.walletTransaction.findFirst.mockResolvedValue(makeTx('PROCESSING'));
      midtrans.getIrisPayoutStatus.mockResolvedValue({ status: providerStatus, referenceNo: 'WLT-RECHECK-1' });
      const svc = makeService();
      const res = (await svc.recheckWithdrawal('WLT-RECHECK-1', 'admin-1', '127.0.0.1')) as {
        outcome: string; changed: boolean;
      };
      expect(res.changed).toBe(false);
      expect(res.outcome).toBe(providerStatus === 'not_found' ? 'UNKNOWN' : 'STILL_PROCESSING');
      expect(prisma.walletTransaction.updateMany).not.toHaveBeenCalled();
      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(midtrans.createIrisPayout).not.toHaveBeenCalled();
      // recheck tetap diaudit (read-only) dengan aksi spesifik
      expect(auditLog.logAdminAction).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'WITHDRAWAL_RECHECKED' }),
      );
    },
  );

  it('provider tidak terjangkau (503) → error diteruskan, tanpa mutasi', async () => {
    prisma.walletTransaction.findFirst.mockResolvedValue(makeTx('PROCESSING'));
    midtrans.getIrisPayoutStatus.mockRejectedValue(
      new ServiceUnavailableException({ code: 'IRIS_PAYOUT_STATUS_UNAVAILABLE', message: 'down' }),
    );
    const svc = makeService();
    await expect(svc.recheckWithdrawal('WLT-RECHECK-1', 'admin-1', '127.0.0.1')).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    expect(prisma.walletTransaction.updateMany).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(auditLog.logAdminAction).not.toHaveBeenCalled();
  });
});
