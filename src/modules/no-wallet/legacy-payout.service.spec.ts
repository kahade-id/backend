import { ConflictException } from '@nestjs/common';
import { WalletTransactionStatus } from '@prisma/client';
import { LegacyPayoutService } from './legacy-payout.service';

const wallet = { id: 'w-1', userId: 'u-1', availableBalance: BigInt(5000000), totalBalance: BigInt(5000000) };
const bank = { id: 'b-1', bankName: 'BCA' };

function buildDeps() {
  const txState = {
    walletFindUnique: jest.fn(async () => ({ ...wallet })),
    walletUpdate: jest.fn(async () => ({})),
    walletTxFindFirst: jest.fn(async () => null),
    walletTxCreate: jest.fn(async (args: { data: Record<string, unknown> }) => ({
      id: 'wtx-1',
      txId: 'WLT-20260929-000001-x',
      status: WalletTransactionStatus.PENDING,
      amount: args.data.amount,
      ...args.data,
    })),
    walletTxUpdate: jest.fn(async () => ({})),
  };
  const tx = {
    wallet: { findUnique: txState.walletFindUnique, update: txState.walletUpdate },
    walletTransaction: {
      findFirst: txState.walletTxFindFirst,
      create: txState.walletTxCreate,
      update: txState.walletTxUpdate,
    },
  };
  const prisma = {
    wallet: { findUnique: jest.fn(async () => ({ ...wallet })) },
    bankAccount: { findFirst: jest.fn(async () => ({ ...bank })) },
    walletTransaction: { update: jest.fn(async () => ({})) },
    escrowDisbursement: {
      findUnique: jest.fn(async () => null),
      update: jest.fn(async () => ({})),
    },
    $transaction: jest.fn(async (cb: (tx: unknown) => unknown) => cb(tx)),
  };
  const walletService = { verifyPin: jest.fn(async () => ({ valid: true })) };
  const escrowDisbursement = {
    releaseFunds: jest.fn(async () => ({
      outcome: 'RELEASED',
      disbursementId: 'disb-1',
      danaReferenceNo: 'DANA-DSB-9',
    })),
  };
  const serial = { getNextForPrefix: jest.fn(async () => 1) };
  const svc = new LegacyPayoutService(
    prisma as never,
    walletService as never,
    escrowDisbursement as never,
    serial as never,
  );
  return { svc, prisma, txState, walletService, escrowDisbursement };
}

const dto = (over: Record<string, unknown> = {}) => ({
  amountSen: '1000000',
  pin: '123456',
  ...over,
});

describe('LegacyPayoutService', () => {
  beforeEach(() => jest.clearAllMocks());

  it('fail-closed: PIN salah → tanpa debit', async () => {
    const { svc, prisma, walletService, txState } = buildDeps();
    walletService.verifyPin.mockRejectedValue(new Error('PIN salah'));
    await expect(svc.requestPayout('u-1', dto())).rejects.toThrow('PIN salah');
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(txState.walletTxCreate).not.toHaveBeenCalled();
  });

  it('fail-fast: tanpa rekening bank → tanpa debit', async () => {
    const { svc, prisma, txState } = buildDeps();
    (prisma.bankAccount.findFirst as jest.Mock).mockResolvedValue(null);
    await expect(svc.requestPayout('u-1', dto())).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'LEGACY_PAYOUT_NO_BANK' }),
    });
    expect(txState.walletTxCreate).not.toHaveBeenCalled();
  });

  it('saldo tidak cukup → INSUFFICIENT_BALANCE, tanpa debit', async () => {
    const { svc, txState } = buildDeps();
    await expect(svc.requestPayout('u-1', dto({ amountSen: '999999999' }))).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(txState.walletTxCreate).not.toHaveBeenCalled();
  });

  it('sukses: debit atomik + release → walletTx SUCCESS', async () => {
    const { svc, prisma, txState, escrowDisbursement } = buildDeps();
    const res = await svc.requestPayout('u-1', dto({ idempotencyKey: 'k-1' }));

    expect(res.status).toBe('RELEASED');
    expect(res.danaReferenceNo).toBe('DANA-DSB-9');
    // debit: WITHDRAW PENDING + snapshot saldo
    const createCalls = (txState.walletTxCreate as jest.Mock).mock.calls as unknown as { data: Record<string, unknown> }[][];
    const created = createCalls[0][0].data;
    expect(created.type).toBe('WITHDRAW');
    expect(created.amount).toBe(BigInt(1000000));
    expect(created.balanceBefore).toBe(BigInt(5000000));
    expect(created.balanceAfter).toBe(BigInt(4000000));
    expect(txState.walletUpdate).toHaveBeenCalledWith({
      where: { id: 'w-1' },
      data: {
        availableBalance: { decrement: BigInt(1000000) },
        totalBalance: { decrement: BigInt(1000000) },
      },
    });
    // release idempoten ke DANA dengan scope LEGACY_PAYOUT
    expect(escrowDisbursement.releaseFunds).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: 'LEGACY_PAYOUT',
        sellerId: 'u-1',
        amountSen: BigInt(1000000),
        idempotencyKey: 'LEGACY_PAYOUT:wtx-1',
      }),
    );
    expect(prisma.walletTransaction.update).toHaveBeenCalledWith({
      where: { id: 'wtx-1' },
      data: { status: WalletTransactionStatus.SUCCESS, completedAt: expect.any(Date) },
    });
  });

  it('idempoten: idempotencyKey sama → tanpa debit kedua', async () => {
    const { svc, txState, escrowDisbursement } = buildDeps();
    (txState.walletTxFindFirst as jest.Mock).mockResolvedValue({
      id: 'wtx-old',
      txId: 'WLT-OLD',
      status: WalletTransactionStatus.SUCCESS,
      amount: BigInt(1000000),
    });
    const res = await svc.requestPayout('u-1', dto({ idempotencyKey: 'k-1' }));
    expect(res.status).toBe('RELEASED');
    expect(res.walletTxId).toBe('WLT-OLD');
    expect(txState.walletTxCreate).not.toHaveBeenCalled();
    expect(escrowDisbursement.releaseFunds).not.toHaveBeenCalled();
  });

  it('race HELD_NO_BANK → debit dibatalkan via kompensasi (saldo utuh)', async () => {
    const { svc, txState, escrowDisbursement, prisma } = buildDeps();
    (escrowDisbursement.releaseFunds as jest.Mock).mockResolvedValue({
      outcome: 'HELD_NO_BANK',
      disbursementId: 'disb-h',
      danaReferenceNo: null,
    });
    const res = await svc.requestPayout('u-1', dto());

    expect(res.status).toBe('HELD_NO_BANK');
    // kompensasi: kredit ADMIN_CREDIT + original REVERSED
    const createCalls = (txState.walletTxCreate as jest.Mock).mock.calls as unknown as [{ data: Record<string, unknown> }][];
    const creditCall = createCalls.find(c => c[0].data.type === 'ADMIN_CREDIT');
    expect(creditCall).toBeDefined();
    expect(creditCall![0].data.amount).toBe(BigInt(1000000));
    const updateCalls = (txState.walletTxUpdate as jest.Mock).mock.calls as unknown as [{ data: Record<string, unknown> }][];
    const reversedCall = updateCalls.find(c => c[0].data.status === 'REVERSED');
    expect(reversedCall).toBeDefined();
    expect(reversedCall![0].data.reversalTxId).toBeDefined();
    // disbursement dibatalkan
    expect(prisma.escrowDisbursement.update).toHaveBeenCalledWith({
      where: { id: 'disb-h' },
      data: { status: 'CANCELLED' },
    });
  });

  it('release PENDING → walletTx tetap PENDING (retry via scheduler)', async () => {
    const { svc, prisma, escrowDisbursement } = buildDeps();
    (escrowDisbursement.releaseFunds as jest.Mock).mockResolvedValue({
      outcome: 'PENDING',
      disbursementId: 'disb-p',
      danaReferenceNo: null,
    });
    const res = await svc.requestPayout('u-1', dto());
    expect(res.status).toBe('PENDING');
    expect(prisma.walletTransaction.update).not.toHaveBeenCalled();
  });
});
