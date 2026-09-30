import { AdminFinanceService } from './admin-finance.service';
import * as ErrorCodes from '../../../common/constants/error-codes';

jest.mock('../../../common/utils/crypto.util', () => ({
  decryptAES: jest.fn(async (value: string) => value),
}));

/**
 * ADM-205 — dual control approve withdrawal (maker-checker).
 *
 * BAI-041 (P0, 2026-10-01): jalur payout Midtrans Iris DI-SUNSET — DANA
 * Enterprise satu-satunya provider. `approveWithdrawal` kini selalu melempar
 * 410 GONE (IRIS_PAYOUT_SUNSET) sebelum menyentuh logika apa pun; test di
 * bawah membuktikan tidak ada efek samping (tidak ada panggilan payout,
 * tidak ada mutasi DB). Logika dual-approval lama tersimpan di riwayat git.
 */
describe('AdminFinanceService withdrawal dual approval (ADM-205)', () => {
  let approvalRows: { adminId: string }[];
  let thresholdValue: string | null;

  const prisma = {
    walletTransaction: {
      findFirst: jest.fn(),
      findUnique: jest.fn(),
      findUniqueOrThrow: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
    },
    adminAuditLog: {
      findMany: jest.fn(async () => [...approvalRows]),
      create: jest.fn(async (args: { data: { adminId: string } }) => {
        approvalRows.push({ adminId: args.data.adminId });
        return { id: 'audit-1' };
      }),
    },
    systemConfig: {
      findUnique: jest.fn(async () => (thresholdValue === null ? null : { value: thresholdValue })),
    },
    $transaction: jest.fn(),
  };
  const auditLog = { logAdminAction: jest.fn().mockResolvedValue(undefined) };
  const midtrans = { createIrisPayout: jest.fn(async () => ({ status: 'ok' })) };
  const dashboard = { invalidateSummaryCache: jest.fn(async () => undefined) };

  const makeTx = () => ({
    id: 'withdraw-internal-1',
    txId: 'WLT-1',
    walletId: 'wallet-1',
    amount: 5000000n, // = Rp50.000 (sen → rupiah)
    type: 'WITHDRAW',
    withdrawStatus: 'PENDING_PROCESS',
    bankAccount: {
      id: 'bank-1',
      accountNumber: '1234567890',
      accountName: 'BUDI SANTOSO',
      bankCode: 'BCA',
    },
  });

  const makeService = () =>
    new AdminFinanceService(prisma as never, auditLog as never, midtrans as never, dashboard as never);

  beforeEach(() => {
    jest.clearAllMocks();
    approvalRows = [];
    thresholdValue = null; // default: belum dikonfigurasi → fail-closed (2 approval)
    prisma.walletTransaction.findFirst.mockResolvedValue(makeTx());
    prisma.walletTransaction.updateMany.mockResolvedValue({ count: 1 });
    prisma.walletTransaction.update.mockResolvedValue({ id: 'withdraw-internal-1' });
    prisma.walletTransaction.findUniqueOrThrow.mockResolvedValue({
      id: 'withdraw-internal-1',
      txId: 'WLT-1',
      amount: 5000000n,
      balanceBefore: 10000000n,
      balanceAfter: 5000000n,
    });
    prisma.walletTransaction.findUnique.mockResolvedValue({ withdrawStatus: 'PROCESSING', txId: 'WLT-1' });
  });

  describe('requiredWithdrawalApprovals (pure)', () => {
    const req = AdminFinanceService.requiredWithdrawalApprovals;
    it('fail-closed: threshold null → 2', () => expect(req(1000, null)).toBe(2));
    it('fail-closed: threshold 0/negatif → 2', () => {
      expect(req(1000, 0)).toBe(2);
      expect(req(1000, -5)).toBe(2);
    });
    it('nominal <= threshold → 1; di atasnya → 2', () => {
      expect(req(500_000, 1_000_000)).toBe(1);
      expect(req(1_000_000, 1_000_000)).toBe(1);
      expect(req(1_000_001, 1_000_000)).toBe(2);
    });
  });

  it('BAI-041: approveWithdrawal selalu 410 GONE (IRIS_PAYOUT_SUNSET) — tanpa efek samping', async () => {
    const service = makeService();
    await expect(service.approveWithdrawal('WLT-1', {}, 'admin-1')).rejects.toMatchObject({
      response: expect.objectContaining({ code: ErrorCodes.IRIS_PAYOUT_SUNSET }),
    });
    // Fail-closed: tidak ada panggilan payout, tidak ada mutasi DB, tidak ada audit.
    expect(midtrans.createIrisPayout).not.toHaveBeenCalled();
    expect(prisma.walletTransaction.findFirst).not.toHaveBeenCalled();
    expect(prisma.walletTransaction.updateMany).not.toHaveBeenCalled();
    expect(prisma.adminAuditLog.create).not.toHaveBeenCalled();
  });

  it('BAI-041: 410 GONE juga untuk approval kedua / admin berbeda (jalur mati total)', async () => {
    approvalRows = [{ adminId: 'admin-2' }]; // approval pertama oleh admin lain
    const service = makeService();
    await expect(service.approveWithdrawal('WLT-1', { adminNote: 'ok' }, 'admin-1')).rejects.toMatchObject({
      response: expect.objectContaining({ code: ErrorCodes.IRIS_PAYOUT_SUNSET }),
    });
    expect(midtrans.createIrisPayout).not.toHaveBeenCalled();
  });

  it('toBeInstanceOf check: error code tersedia', () => {
    expect(ErrorCodes.IRIS_PAYOUT_SUNSET).toBe('IRIS_PAYOUT_SUNSET');
  });
});
