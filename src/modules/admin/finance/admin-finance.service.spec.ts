import { GoneException } from '@nestjs/common';
import { AdminFinanceService } from './admin-finance.service';
import * as ErrorCodes from '../../../common/constants/error-codes';

jest.mock('../../../common/utils/crypto.util', () => ({
  decryptAES: jest.fn(async (value: string) => value),
}));

/**
 * BAI-041 (P0, 2026-10-01): jalur payout Midtrans Iris DI-SUNSET.
 * `approveWithdrawal` selalu 410 GONE sebelum logika apa pun — termasuk saat
 * provider timeout ambigu. Tidak ada claim status, tidak ada mutasi.
 */
describe('AdminFinanceService payout submission safety', () => {
  const prisma = {
    walletTransaction: {
      findFirst: jest.fn(),
      updateMany: jest.fn(),
      update: jest.fn(),
      findUnique: jest.fn(),
      findUniqueOrThrow: jest.fn(),
    },
    adminAuditLog: { findMany: jest.fn(async () => []), create: jest.fn() },
    systemConfig: { findUnique: jest.fn(async () => null) },
    $transaction: jest.fn(),
  };
  const auditLog = { logAdminAction: jest.fn().mockResolvedValue(undefined) };
  const midtrans = { createIrisPayout: jest.fn() };
  const dashboard = { invalidateSummaryCache: jest.fn(async () => undefined) };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('BAI-041: approveWithdrawal 410 GONE bahkan saat provider timeout ambigu — tanpa mutasi', async () => {
    midtrans.createIrisPayout.mockRejectedValueOnce(new Error('request timed out after provider acceptance'));
    const service = new AdminFinanceService(prisma as never, auditLog as never, midtrans as never, dashboard as never);

    const err = await service.approveWithdrawal('WLT-1', {}, 'admin-1').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GoneException);
    expect((err as unknown as { response: { code: string } }).response.code).toBe(ErrorCodes.IRIS_PAYOUT_SUNSET);

    // Tidak ada claim PENDING_PROCESS → PROCESSING, tidak ada transaksi DB.
    expect(prisma.walletTransaction.updateMany).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(midtrans.createIrisPayout).not.toHaveBeenCalled();
  });
});
