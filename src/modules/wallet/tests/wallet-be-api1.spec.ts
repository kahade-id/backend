/**
 * Batch 139 BE-API1 — test item 106–109.
 *
 * 106: GET /v1/wallet/transactions → query param `status` (server-side).
 * 107: GET /v1/wallet → `escrowBreakdown: [{orderId, amount}]`.
 * 108: GET /v1/wallet/topup-status/:id → `expiresAt` (ISO absolut).
 * 109: GET /v1/wallet/transactions/:txId → `timeline: [{status, at}]`.
 */
import { WalletService } from '../wallet.service';
import { WalletTransactionStatus, WalletTransactionType } from '@prisma/client';

const mockWallet = {
  id: 'wallet-1',
  userId: 'user-1',
  availableBalance: 100000n,
  escrowBalance: 5000000n,
  totalBalance: 5100000n,
  todayTopupAmount: 0n,
  todayWithdrawAmount: 0n,
  lastLimitResetAt: new Date(),
  isLocked: false,
  walletPinHash: null,
  lockReasonCode: null,
};

function makeService(prisma: Record<string, unknown>) {
  const service = Object.create(WalletService.prototype) as WalletService;
  (service as any).prisma = prisma;
  (service as any).redis = { get: jest.fn(async () => null) };
  return service;
}

describe('Batch 139 BE-API1 — item 106: filter status di GET /v1/wallet/transactions', () => {
  function makeTxService() {
    const findMany = jest.fn(async () => []);
    const prisma = {
      wallet: { findUnique: jest.fn(async () => mockWallet) },
      walletTransaction: { findMany, count: jest.fn(async () => 0) },
    };
    return { service: makeService(prisma), findMany };
  }

  it('status=PENDING diteruskan ke where (dukung chip "Dalam proses")', async () => {
    const { service, findMany } = makeTxService();
    await service.getTransactions('user-1', 1, 20, undefined, undefined, undefined, 'PENDING');
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ status: WalletTransactionStatus.PENDING }),
      }),
    );
  });

  it('tanpa status: where tidak memuat kunci status (kontrak lama)', async () => {
    const { service, findMany } = makeTxService();
    await service.getTransactions('user-1', 1, 20);
    const where = (findMany.mock.calls[0] as any[])?.[0]?.where as Record<string, unknown>;
    expect(where).not.toHaveProperty('status');
  });

  it('status di luar enum → 400 INVALID_TRANSACTION_STATUS', async () => {
    const { service } = makeTxService();
    await expect(
      service.getTransactions('user-1', 1, 20, undefined, undefined, undefined, 'ALL'),
    ).rejects.toMatchObject({ response: expect.objectContaining({ code: 'INVALID_TRANSACTION_STATUS' }) });
  });

  it('kombinasi type + status keduanya diteruskan', async () => {
    const { service, findMany } = makeTxService();
    await service.getTransactions('user-1', 1, 20, WalletTransactionType.TOP_UP, undefined, undefined, 'SUCCESS');
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          type: WalletTransactionType.TOP_UP,
          status: WalletTransactionStatus.SUCCESS,
        }),
      }),
    );
  });
});

describe('Batch 139 BE-API1 — item 107: escrowBreakdown di GET /v1/wallet', () => {
  it('merinci escrow per order buyer yang masih ditahan', async () => {
    const orderFindMany = jest.fn(async () => [
      { orderId: 'ORD-001', buyerPayAmount: 3000000n },
      { orderId: 'ORD-002', buyerPayAmount: 2000000n },
    ]);
    const prisma = {
      wallet: { findUnique: jest.fn(async () => mockWallet) },
      order: { findMany: orderFindMany },
    };
    const service = makeService(prisma);
    const res = (await service.getWallet('user-1')) as {
      escrowBalance: number;
      escrowBreakdown: Array<{ orderId: string; amount: number }>;
    };
    expect(res.escrowBalance).toBe(50000);
    expect(res.escrowBreakdown).toEqual([
      { orderId: 'ORD-001', amount: 30000 },
      { orderId: 'ORD-002', amount: 20000 },
    ]);
    // Hanya order buyer yang sudah dibayar & escrow masih ditahan.
    expect(orderFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          buyerId: 'user-1',
          paidAt: { not: null },
          status: { in: expect.arrayContaining(['PROCESSING', 'IN_DELIVERY', 'DISPUTED']) },
        }),
      }),
    );
  });

  it('escrowBreakdown kosong bila tidak ada order menahan escrow', async () => {
    const prisma = {
      wallet: { findUnique: jest.fn(async () => ({ ...mockWallet, escrowBalance: 0n })) },
      order: { findMany: jest.fn(async () => []) },
    };
    const service = makeService(prisma);
    const res = (await service.getWallet('user-1')) as { escrowBreakdown: unknown[] };
    expect(res.escrowBreakdown).toEqual([]);
  });
});

describe('Batch 139 BE-API1 — item 108: expiredAt + expiresAt di topup-status', () => {
  it('mengembalikan expiredAt (brief) dan expiresAt (alias FE) dengan nilai identik', async () => {
    const expiredAt = new Date('2026-09-28T15:00:00.000Z');
    const prisma = {
      paymentTransaction: {
        findFirst: jest.fn(async () => ({
          midtransOrderId: 'MT-123',
          status: 'PENDING',
          amount: 10000000n,
          expiredAt,
        })),
      },
    };
    const service = makeService(prisma);
    const res = await service.getTopupStatus('user-1', 'MT-123');
    expect(res).toMatchObject({
      status: 'PENDING',
      txId: 'MT-123',
      amount: 100000,
      expiredAt: '2026-09-28T15:00:00.000Z',
      expiresAt: '2026-09-28T15:00:00.000Z',
    });
  });

  it('expiredAt & expiresAt null bila paymentTransaction.expiredAt null', async () => {
    const prisma = {
      paymentTransaction: {
        findFirst: jest.fn(async () => ({
          midtransOrderId: 'MT-124',
          status: 'PENDING',
          amount: 10000000n,
          expiredAt: null,
        })),
      },
    };
    const service = makeService(prisma);
    const res = await service.getTopupStatus('user-1', 'MT-124');
    expect(res.expiresAt).toBeNull();
    expect(res.expiredAt).toBeNull();
  });
});

describe('Batch 139 BE-API1 — item 109: timeline di detail mutasi', () => {
  function makeDetailService(tx: Record<string, unknown>) {
    const prisma = {
      wallet: { findUnique: jest.fn(async () => mockWallet) },
      walletTransaction: { findFirst: jest.fn(async () => tx) },
    };
    return makeService(prisma);
  }

  const baseTx = {
    id: 'wtx-1',
    txId: 'WLT-20260928-0001',
    type: WalletTransactionType.TOP_UP,
    amount: 10000000n,
    description: 'Top-up',
    balanceBefore: 0n,
    balanceAfter: 10000000n,
    metadata: null,
    order: null,
  };

  it('mutasi PENDING: timeline hanya satu entri PENDING@createdAt', async () => {
    const createdAt = new Date('2026-09-28T10:00:00.000Z');
    const service = makeDetailService({
      ...baseTx,
      status: WalletTransactionStatus.PENDING,
      createdAt,
      updatedAt: createdAt,
      completedAt: null,
    });
    const res = (await service.getTransactionDetail('user-1', 'WLT-20260928-0001')) as {
      timeline: Array<{ status: string; at: Date }>;
    };
    expect(res.timeline).toEqual([{ status: 'PENDING', at: createdAt }]);
  });

  it('mutasi SUCCESS: timeline PENDING@createdAt → SUCCESS@completedAt', async () => {
    const createdAt = new Date('2026-09-28T10:00:00.000Z');
    const completedAt = new Date('2026-09-28T10:05:00.000Z');
    const service = makeDetailService({
      ...baseTx,
      status: WalletTransactionStatus.SUCCESS,
      createdAt,
      updatedAt: completedAt,
      completedAt,
    });
    const res = (await service.getTransactionDetail('user-1', 'WLT-20260928-0001')) as {
      timeline: Array<{ status: string; at: Date }>;
    };
    expect(res.timeline).toEqual([
      { status: 'PENDING', at: createdAt },
      { status: 'SUCCESS', at: completedAt },
    ]);
  });

  it('mutasi FAILED tanpa completedAt: memakai updatedAt sebagai acuan akhir', async () => {
    const createdAt = new Date('2026-09-28T10:00:00.000Z');
    const updatedAt = new Date('2026-09-28T10:02:00.000Z');
    const service = makeDetailService({
      ...baseTx,
      status: WalletTransactionStatus.FAILED,
      createdAt,
      updatedAt,
      completedAt: null,
    });
    const res = (await service.getTransactionDetail('user-1', 'WLT-20260928-0001')) as {
      timeline: Array<{ status: string; at: Date }>;
    };
    expect(res.timeline).toEqual([
      { status: 'PENDING', at: createdAt },
      { status: 'FAILED', at: updatedAt },
    ]);
  });

  it('wallet tidak ada → NotFoundException', async () => {
    const prisma = {
      wallet: { findUnique: jest.fn(async () => null) },
      walletTransaction: { findFirst: jest.fn() },
    };
    const service = makeService(prisma);
    await expect(service.getTransactionDetail('ghost', 'WLT-x')).rejects.toMatchObject({
      name: 'NotFoundException',
    });
  });
});
