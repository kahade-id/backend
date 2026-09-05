import { ServiceUnavailableException } from '@nestjs/common';
import { AdminFinanceService } from './admin-finance.service';

jest.mock('../../../common/utils/crypto.util', () => ({
  decryptAES: jest.fn(async (value: string) => value),
}));

describe('AdminFinanceService payout submission safety', () => {
  const prisma = {
    walletTransaction: {
      findFirst: jest.fn(),
      updateMany: jest.fn(),
    },
    $transaction: jest.fn(),
  };
  const auditLog = { logAdminAction: jest.fn().mockResolvedValue(undefined) };
  const midtrans = { createIrisPayout: jest.fn() };

  beforeEach(() => {
    jest.clearAllMocks();
    prisma.walletTransaction.findFirst.mockResolvedValue({
      id: 'withdraw-internal-1',
      txId: 'WLT-1',
      walletId: 'wallet-1',
      amount: 5000000n,
      type: 'WITHDRAW',
      withdrawStatus: 'PENDING_PROCESS',
      bankAccount: {
        id: 'bank-1',
        accountNumber: '1234567890',
        accountName: 'BUDI SANTOSO',
        bankCode: 'BCA',
      },
    });
    prisma.walletTransaction.updateMany.mockResolvedValue({ count: 1 });
  });

  it('keeps withdrawal PROCESSING when Iris submission outcome is ambiguous', async () => {
    midtrans.createIrisPayout.mockRejectedValueOnce(new Error('request timed out after provider acceptance'));
    const service = new AdminFinanceService(prisma as never, auditLog as never, midtrans as never);

    await expect(service.approveWithdrawal('WLT-1', {}, 'admin-1')).rejects.toBeInstanceOf(ServiceUnavailableException);

    expect(prisma.walletTransaction.updateMany).toHaveBeenNthCalledWith(1, expect.objectContaining({
      where: { id: 'withdraw-internal-1', withdrawStatus: 'PENDING_PROCESS' },
      data: expect.objectContaining({ withdrawStatus: 'PROCESSING' }),
    }));
    expect(prisma.walletTransaction.updateMany).toHaveBeenNthCalledWith(2, expect.objectContaining({
      where: { id: 'withdraw-internal-1', withdrawStatus: 'PROCESSING' },
      data: expect.objectContaining({ description: expect.stringContaining('pending reconciliation') }),
    }));
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});
