import { Test } from '@nestjs/testing';
import { OrderStatus, WalletTransactionStatus, WalletTransactionType } from '@prisma/client';
import { AdminOrdersService } from '../orders/admin-orders.service';
import { PrismaService } from '../../../prisma/prisma.service';
import { AuditLogService } from '../../../common/services/audit-log.service';
import { OrderStateService } from '../../orders/order-state.service';
import { FeeCalculatorService } from '../../orders/fee-calculator.service';
import { WalletTxSerialService } from '../../../common/services/wallet-tx-serial.service';
import { ReferralService } from '../../referral/referral.service';
import { MembershipRankService } from '../../orders/membership-rank.service';

function buildPrisma() {
  const buyerWallet = { id: 'wallet-buyer', availableBalance: 0n, escrowBalance: 0n, totalBalance: 0n, version: 1, isLocked: false };
  const sellerWallet = { id: 'wallet-seller', availableBalance: 0n, escrowBalance: 0n, totalBalance: 0n, version: 1, isLocked: false };
  const order = {
    id: 'order-1', orderId: 'ORD-1', status: OrderStatus.PROCESSING, buyerId: 'buyer', sellerId: 'seller',
    buyerPayAmount: 0n, sellerReceiveAmount: 0n, feeAmount: 0n, orderValue: 0n, isKahadePlus: false,
    buyer: { wallet: buyerWallet }, seller: { wallet: sellerWallet },
  };
  const prisma = {
    order: { findFirst: jest.fn().mockResolvedValue(order), updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    orderExtensionRequest: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    deliveryProof: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    walletTransaction: { findFirst: jest.fn().mockResolvedValue({ amount: 0n, status: WalletTransactionStatus.SUCCESS, type: WalletTransactionType.ORDER_LOCK }), create: jest.fn() },
    wallet: { findUnique: jest.fn().mockResolvedValueOnce(buyerWallet).mockResolvedValueOnce(sellerWallet) },
    orderStatusHistory: { create: jest.fn() },
    user: { update: jest.fn().mockResolvedValue({}) },
    subscription: { findFirst: jest.fn().mockResolvedValue(null) },
    notification: { create: jest.fn().mockResolvedValue({}) },
    emitNotificationCreated: jest.fn(),
    $queryRaw: jest.fn().mockResolvedValue([]),
    $executeRaw: jest.fn().mockResolvedValue(0),
    $transaction: jest.fn(),
  };
  prisma.$transaction.mockImplementation(async (fn: (tx: typeof prisma) => Promise<unknown>) => fn(prisma));
  return prisma;
}

describe('AdminOrdersService — forceComplete terminal cleanup', () => {
  it('resolves pending extension and submitted proof in the same transaction', async () => {
    const prisma = buildPrisma();
    const module = await Test.createTestingModule({
      providers: [
        AdminOrdersService,
        { provide: PrismaService, useValue: prisma },
        { provide: AuditLogService, useValue: { logAdminAction: jest.fn() } },
        { provide: OrderStateService, useValue: {} },
        { provide: FeeCalculatorService, useValue: { getFeeConfig: jest.fn(), getPlusSavingsSen: jest.fn() } },
        { provide: WalletTxSerialService, useValue: { getNext: jest.fn().mockResolvedValue(1) } },
        { provide: ReferralService, useValue: { createReferralRewardIfEligible: jest.fn() } },
        { provide: MembershipRankService, useValue: { checkAndUpdateMembershipRank: jest.fn() } },
      ],
    }).compile();

    const service = module.get(AdminOrdersService);
    await expect(service.forceComplete('ORD-1', 'admin-1', { reason: 'Force completion with sufficient operational evidence' })).resolves.toEqual({ orderId: 'ORD-1', status: OrderStatus.COMPLETED });

    expect(prisma.orderExtensionRequest.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: { orderId: 'order-1', status: 'PENDING' }, data: expect.objectContaining({ status: 'REJECTED' }) }));
    expect(prisma.deliveryProof.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: { orderId: 'order-1', status: 'SUBMITTED' }, data: expect.objectContaining({ status: 'ACCEPTED' }) }));
  });
});
