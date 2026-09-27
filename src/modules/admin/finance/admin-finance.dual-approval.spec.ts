import { ConflictException } from '@nestjs/common';
import { AdminFinanceService } from './admin-finance.service';
import * as ErrorCodes from '../../../common/constants/error-codes';

jest.mock('../../../common/utils/crypto.util', () => ({
  decryptAES: jest.fn(async (value: string) => value),
}));

/**
 * ADM-205 — dual control approve withdrawal (maker-checker).
 * Membuktikan:
 *  1. SATU approval TIDAK mengeksekusi payout (status tetap PENDING_PROCESS,
 *     Iris tidak dipanggil).
 *  2. Admin yang sama tidak bisa menyetujui dua kali (409).
 *  3. DUA admin berbeda → payout dieksekusi tepat sekali.
 *  4. Threshold terkonfigurasi: nominal di bawah threshold cukup 1 approval.
 *  5. Race antar approval kedua: yang kalah claim menerima ALREADY_EXECUTED
 *     (bukan error mentah), tanpa payout ganda.
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

  it('SATU approval tidak mengeksekusi payout — mengembalikan AWAITING_SECOND_APPROVAL', async () => {
    const service = makeService();
    const result = (await service.approveWithdrawal('WLT-1', {}, 'admin-1')) as Record<string, unknown>;

    expect(result.status).toBe('AWAITING_SECOND_APPROVAL');
    expect(result.approvals).toBe(1);
    expect(result.requiredApprovals).toBe(2);
    expect(result.executed).toBe(false);
    // Payout TIDAK boleh tersentuh; status TIDAK boleh berubah ke PROCESSING.
    expect(midtrans.createIrisPayout).not.toHaveBeenCalled();
    expect(prisma.walletTransaction.updateMany).not.toHaveBeenCalled();
    // Approval tercatat sebagai baris audit ber-tipe.
    expect(prisma.adminAuditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          adminId: 'admin-1',
          action: 'WITHDRAWAL_APPROVED',
          targetType: 'WithdrawalApproval',
          targetId: 'withdraw-internal-1',
        }),
      }),
    );
  });

  it('admin yang sama menyetujui dua kali → 409 WITHDRAWAL_ALREADY_APPROVED', async () => {
    approvalRows = [{ adminId: 'admin-1' }];
    const service = makeService();

    await expect(service.approveWithdrawal('WLT-1', {}, 'admin-1')).rejects.toMatchObject({
      response: expect.objectContaining({ code: ErrorCodes.WITHDRAWAL_ALREADY_APPROVED }),
    });
    expect(midtrans.createIrisPayout).not.toHaveBeenCalled();
    expect(prisma.walletTransaction.updateMany).not.toHaveBeenCalled();
  });

  it('DUA admin berbeda → payout dieksekusi tepat sekali', async () => {
    approvalRows = [{ adminId: 'admin-2' }]; // approval pertama oleh admin lain
    const service = makeService();

    const result = (await service.approveWithdrawal('WLT-1', { adminNote: 'ok' }, 'admin-1')) as Record<string, unknown>;

    expect(midtrans.createIrisPayout).toHaveBeenCalledTimes(1);
    expect(midtrans.createIrisPayout).toHaveBeenCalledWith(
      expect.objectContaining({ referenceNo: 'WLT-1', amount: 50000 }),
    );
    // Optimistic-lock claim berjalan (PENDING_PROCESS → PROCESSING).
    expect(prisma.walletTransaction.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'withdraw-internal-1', withdrawStatus: 'PENDING_PROCESS' },
        data: expect.objectContaining({ withdrawStatus: 'PROCESSING' }),
      }),
    );
    expect(result.executed).not.toBe(false);
  });

  it('threshold terkonfigurasi: nominal di bawah threshold cukup 1 approval', async () => {
    thresholdValue = '100000'; // Rp100.000; nominal Rp50.000 <= threshold
    const service = makeService();

    await service.approveWithdrawal('WLT-1', {}, 'admin-1');

    expect(midtrans.createIrisPayout).toHaveBeenCalledTimes(1);
  });

  it('race antar approval kedua: yang kalah claim menerima ALREADY_EXECUTED tanpa payout ganda', async () => {
    approvalRows = [{ adminId: 'admin-2' }];
    prisma.walletTransaction.updateMany.mockResolvedValueOnce({ count: 0 }); // claim kalah
    prisma.walletTransaction.findUnique.mockResolvedValueOnce({ withdrawStatus: 'PROCESSING', txId: 'WLT-1' });
    const service = makeService();

    const result = (await service.approveWithdrawal('WLT-1', {}, 'admin-1')) as Record<string, unknown>;

    expect(result.status).toBe('ALREADY_EXECUTED');
    expect(result.executed).toBe(true);
    expect(midtrans.createIrisPayout).not.toHaveBeenCalled();
  });

  it('toBeInstanceOf check: error code tersedia', () => {
    expect(ErrorCodes.WITHDRAWAL_ALREADY_APPROVED).toBe('WITHDRAWAL_ALREADY_APPROVED');
  });

  it('ConflictException dipakai untuk self-approval ganda', async () => {
    approvalRows = [{ adminId: 'admin-1' }];
    const service = makeService();
    await expect(service.approveWithdrawal('WLT-1', {}, 'admin-1')).rejects.toBeInstanceOf(ConflictException);
  });
});
