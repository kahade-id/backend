/**
 * Batch 8 (MONEY) — EO-008: admin force-complete menulis ORDER_RELEASE dengan
 * basis komponen saldo yang benar-benar bergerak (buyer: escrowBalance,
 * seller: availableBalance), selaras dengan jalur completeOrder user &
 * auto-complete. Delta (= ΔtotalBalance) tidak berubah sehingga basis
 * rekonsiliasi ledger aman.
 */
import { AdminOrdersService } from './admin-orders.service';
import { WalletTransactionType } from '@prisma/client';

// AUT-013: re-auth password — hash bcrypt (rounds 4) dari 'CorrectAdm1n!Pass'.
const ADMIN_PASSWORD_HASH = '$2b$04$waM9I26CpDGikc4wm7f./um84AmUcxOOK/U3/vCIlzu10geRiznVS';
const ADMIN_PASSWORD = 'CorrectAdm1n!Pass';

const SEN = (idr: number) => BigInt(idr) * BigInt(100);

const BUYER_PAY_SEN = SEN(100000); // Rp100.000
const SELLER_RECV_SEN = SEN(97500); // Rp97.500

const orderRow = {
  id: 'order-db-1',
  orderId: 'ORD-2026-1',
  title: 'Kopi Arabika 1kg',
  status: 'IN_DELIVERY',
  buyerId: 'buyer-1',
  sellerId: 'seller-1',
  buyerPayAmount: BUYER_PAY_SEN,
  sellerReceiveAmount: SELLER_RECV_SEN,
  feeAmount: BigInt(0),
  orderValue: SEN(100000),
  isKahadePlus: false,
  buyer: { wallet: { id: 'bw-1', availableBalance: SEN(400000), escrowBalance: BUYER_PAY_SEN, totalBalance: SEN(500000), version: 1 } },
  seller: { wallet: { id: 'sw-1', availableBalance: SEN(200000), totalBalance: SEN(200000), version: 1 } },
};

const freshBuyer = { id: 'bw-1', escrowBalance: BUYER_PAY_SEN, totalBalance: SEN(500000), availableBalance: SEN(400000), version: 1, isLocked: false };
const freshSeller = { id: 'sw-1', escrowBalance: BigInt(0), totalBalance: SEN(200000), availableBalance: SEN(200000), version: 1, isLocked: false };

describe('Batch 8 money — EO-008 force-complete ORDER_RELEASE balance basis', () => {
  it('buyer ORDER_RELEASE memakai escrowBalance; seller memakai availableBalance', async () => {
    const walletTxCreates: any[] = [];
    const ptx = {
      order: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      walletTransaction: {
        findFirst: jest.fn(async (args: any) =>
          args?.where?.type === WalletTransactionType.ORDER_LOCK
            ? { amount: BUYER_PAY_SEN }
            : null,
        ),
        create: jest.fn(async (args: any) => {
          walletTxCreates.push(args.data);
          return { id: 'tx-1' };
        }),
      },
      $queryRaw: jest.fn().mockResolvedValue([]),
      wallet: {
        findUnique: jest.fn(async (args: any) =>
          args?.where?.id === 'bw-1' ? freshBuyer : freshSeller,
        ),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      orderStatusHistory: { create: jest.fn().mockResolvedValue({}) },
      orderExtensionRequest: { updateMany: jest.fn().mockResolvedValue({}) },
      deliveryProof: { updateMany: jest.fn().mockResolvedValue({}) },
      user: { update: jest.fn().mockResolvedValue({}) },
      subscription: { findFirst: jest.fn().mockResolvedValue(null) },
      voucherUsage: { findFirst: jest.fn().mockResolvedValue(null) },
    };
    const prisma = {
      order: { findFirst: jest.fn().mockResolvedValue(orderRow) },
      adminUser: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'admin-1',
          password: ADMIN_PASSWORD_HASH,
          isActive: true,
          deletedAt: null,
        }),
      },
      $transaction: jest.fn(async (cb: any) => cb(ptx)),
      notification: { create: jest.fn().mockResolvedValue({}) },
      emitNotificationCreated: jest.fn(),
    };
    let serial = 0;
    const walletTxSerialService = { getNext: jest.fn(async () => ++serial) };
    const auditLog = { logAdminAction: jest.fn() };
    const redis = { del: jest.fn().mockResolvedValue(1) };
    const referralService = { createReferralRewardIfEligible: jest.fn().mockResolvedValue(undefined) };
    const membershipRankService = { checkAndUpdateMembershipRank: jest.fn().mockResolvedValue(undefined) };
    const dashboard = { invalidateSummaryCache: jest.fn().mockResolvedValue(undefined) };

    const service = new AdminOrdersService(
      prisma as never,
      auditLog as never,
      redis as never,
      {} as never, // orderStateService
      {} as never, // unshippedCancelService
      {} as never, // feeCalculator
      walletTxSerialService as never,
      referralService as never,
      membershipRankService as never,
      dashboard as never,
      { isWalletEnabled: () => true } as never, // M4 no-wallet: wallet aktif → jalur wallet lama
      null as never, // disbursement (tidak dipakai saat wallet aktif)
    );

    const result = await service.forceComplete('ORD-2026-1', 'admin-1', { reason: 'Buyer tidak merespons konfirmasi', password: ADMIN_PASSWORD } as never);
    expect(result.status).toBe('COMPLETED');

    const releases = walletTxCreates.filter((c) => c.type === WalletTransactionType.ORDER_RELEASE);
    expect(releases).toHaveLength(2);

    const buyerRelease = releases.find((c) => c.walletId === 'bw-1');
    const sellerRelease = releases.find((c) => c.walletId === 'sw-1');

    // Buyer: basis escrowBalance.
    expect(buyerRelease.balanceBefore).toBe(freshBuyer.escrowBalance);
    expect(buyerRelease.balanceAfter).toBe(freshBuyer.escrowBalance - BUYER_PAY_SEN);
    expect(buyerRelease.amount).toBe(BUYER_PAY_SEN);
    // Delta tetap = −buyerPayAmount (ΔtotalBalance) → basis rekonsiliasi aman.
    expect(buyerRelease.balanceAfter - buyerRelease.balanceBefore).toBe(-BUYER_PAY_SEN);

    // Seller: basis availableBalance.
    expect(sellerRelease.balanceBefore).toBe(freshSeller.availableBalance);
    expect(sellerRelease.balanceAfter).toBe(freshSeller.availableBalance + SELLER_RECV_SEN);
    expect(sellerRelease.amount).toBe(SELLER_RECV_SEN);
    expect(sellerRelease.balanceAfter - sellerRelease.balanceBefore).toBe(SELLER_RECV_SEN);
  });
});

/**
 * Audit transaksi 2026-10-10 — force-complete di mode no-wallet (produksi):
 * order dibayar DANA-direct, tidak ada wallet/ORDER_LOCK. Harus selesai +
 * membuat baris EscrowDisbursement PENDING di dalam tx, lalu cair post-commit.
 */
describe('Force-complete no-wallet (audit 2026-10-10)', () => {
  function buildNoWallet() {
    const disbursementCreates: any[] = [];
    const ptx = {
      order: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      walletTransaction: { findFirst: jest.fn().mockResolvedValue(null), create: jest.fn() },
      wallet: { findUnique: jest.fn(), updateMany: jest.fn() },
      $queryRaw: jest.fn().mockResolvedValue([]),
      escrowDisbursement: {
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn(async (args: any) => { disbursementCreates.push(args.data); return { id: 'disb-1' }; }),
      },
      orderStatusHistory: { create: jest.fn().mockResolvedValue({}) },
      orderExtensionRequest: { updateMany: jest.fn().mockResolvedValue({}) },
      deliveryProof: { updateMany: jest.fn().mockResolvedValue({}) },
      user: { update: jest.fn().mockResolvedValue({}) },
      subscription: { findFirst: jest.fn().mockResolvedValue(null) },
      voucherUsage: { findFirst: jest.fn().mockResolvedValue(null) },
    };
    const orderNoWallet = { ...orderRow, buyer: { wallet: null }, seller: { wallet: null } };
    const prisma = {
      order: { findFirst: jest.fn().mockResolvedValue(orderNoWallet) },
      paymentTransaction: { findFirst: jest.fn().mockResolvedValue({ id: 'pay-1' }) },
      adminUser: {
        findUnique: jest.fn().mockResolvedValue({ id: 'admin-1', password: ADMIN_PASSWORD_HASH, isActive: true, deletedAt: null }),
      },
      $transaction: jest.fn(async (cb: any) => cb(ptx)),
      notification: { create: jest.fn().mockResolvedValue({}) },
      emitNotificationCreated: jest.fn(),
    };
    const walletTxSerialService = { getNext: jest.fn(async () => 1) };
    const disbursement = { releaseForOrder: jest.fn().mockResolvedValue({ outcome: 'RELEASED', disbursementId: 'disb-1', danaReferenceNo: 'ref' }) };
    const service = new AdminOrdersService(
      prisma as never,
      { logAdminAction: jest.fn() } as never,
      { del: jest.fn().mockResolvedValue(1) } as never,
      {} as never,
      {} as never,
      {} as never,
      walletTxSerialService as never,
      { createReferralRewardIfEligible: jest.fn().mockResolvedValue(false), invalidateLeaderboardCache: jest.fn() } as never,
      { checkAndUpdateMembershipRank: jest.fn().mockResolvedValue(undefined) } as never,
      { invalidateSummaryCache: jest.fn().mockResolvedValue(undefined) } as never,
      { isWalletEnabled: () => false } as never,
      disbursement as never,
    );
    return { service, ptx, prisma, disbursement, disbursementCreates, walletTxSerialService };
  }

  it('wallet mati + payment DANA → COMPLETED, baris ORDER_ESCROW PENDING di tx, release post-commit, ledger wallet tak disentuh', async () => {
    const { service, ptx, disbursement, disbursementCreates, walletTxSerialService } = buildNoWallet();

    const result = await service.forceComplete('ORD-2026-1', 'admin-1', { reason: 'Buyer tidak merespons', password: ADMIN_PASSWORD } as never);

    expect(result.status).toBe('COMPLETED');
    expect(disbursementCreates).toHaveLength(1);
    expect(disbursementCreates[0]).toMatchObject({
      idempotencyKey: 'ORDER:order-db-1',
      scope: 'ORDER_ESCROW',
      sellerId: 'seller-1',
      amountSen: SELLER_RECV_SEN,
      status: 'PENDING',
    });
    expect(disbursement.releaseForOrder).toHaveBeenCalledWith('order-db-1');
    expect(ptx.walletTransaction.create).not.toHaveBeenCalled();
    expect(ptx.wallet.updateMany).not.toHaveBeenCalled();
    expect(walletTxSerialService.getNext).not.toHaveBeenCalled();
    // Statistik user tetap ditulis (sebelumnya terlewat oleh early-return).
    expect(ptx.user.update).toHaveBeenCalledTimes(2);
  });

  it('wallet mati TANPA payment DANA dan tanpa wallet → NOT_FOUND (fail-closed, tidak menebak)', async () => {
    const { service, prisma } = buildNoWallet();
    prisma.paymentTransaction.findFirst.mockResolvedValue(null);

    await expect(
      service.forceComplete('ORD-2026-1', 'admin-1', { reason: 'x', password: ADMIN_PASSWORD } as never),
    ).rejects.toMatchObject({ response: { code: 'NOT_FOUND' } });
  });
});
