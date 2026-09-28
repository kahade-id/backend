/**
 * Batch 8 (MONEY) — EO-008: admin force-complete menulis ORDER_RELEASE dengan
 * basis komponen saldo yang benar-benar bergerak (buyer: escrowBalance,
 * seller: availableBalance), selaras dengan jalur completeOrder user &
 * auto-complete. Delta (= ΔtotalBalance) tidak berubah sehingga basis
 * rekonsiliasi ledger aman.
 */
import { AdminOrdersService } from './admin-orders.service';
import { WalletTransactionType } from '@prisma/client';

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
    );

    const result = await service.forceComplete('ORD-2026-1', 'admin-1', { reason: 'Buyer tidak merespons konfirmasi' } as never);
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
