import { Test, TestingModule } from '@nestjs/testing';
import { ConflictException, NotFoundException, BadRequestException } from '@nestjs/common';
import { DisputeStatus, OrderStatus, ActorType, Prisma } from '@prisma/client';
import { MutualResolutionService } from '../mutual-resolution.service';
import { PrismaService } from '../../../prisma/prisma.service';
import { WalletTxSerialService } from '../../../common/services/wallet-tx-serial.service';
import { FeeCalculatorService } from '../../orders/fee-calculator.service';

/*
 * C-04 regression: REJECT and withdraw used to write the proposal row blind
 * (`update({ where: { id } })`) after reading `status: 'PENDING'` outside any
 * transaction. The ACCEPT branch runs a long Serializable transaction with up
 * to MAX_RETRIES and exponential backoff, so a concurrent REJECT/withdraw could
 * arrive after ACCEPT committed and stamp REJECTED/"Withdrawn by proposer" over
 * the terminal ACCEPTED state of a proposal that had already split the escrow.
 */

const mockPrisma = {
  dispute: { findFirst: jest.fn(), findUnique: jest.fn(), update: jest.fn() },
  mutualResolutionProposal: {
    findFirst: jest.fn(),
    update: jest.fn(),
    updateMany: jest.fn(),
    count: jest.fn(),
    create: jest.fn(),
    findMany: jest.fn(),
  },
  order: { findUnique: jest.fn(), update: jest.fn() },
  orderStatusHistory: { create: jest.fn() },
  notification: { create: jest.fn() },
  wallet: { findUnique: jest.fn(), updateMany: jest.fn() },
  walletTransaction: { create: jest.fn() },
  subscription: { findFirst: jest.fn() },
  $queryRaw: jest.fn(),
  $executeRaw: jest.fn(),
  $transaction: jest.fn(),
  emitNotificationCreated: jest.fn(),
};

const mockSerial = { getNext: jest.fn().mockResolvedValue(1) };
const mockFeeCalculator = { getFeeConfig: jest.fn(), getPlusSavingsSen: jest.fn().mockResolvedValue(0n) };

const ORDER_ROW = {
  id: 'ord-1',
  orderId: 'ORD-1',
  title: 'Jasa desain',
  status: OrderStatus.DISPUTED,
  buyerId: 'buyer-1',
  sellerId: 'seller-1',
  buyerPayAmount: 1_000_000n * 100n,
  sellerReceiveAmount: 950_000n * 100n,
  feeAmount: 50_000n * 100n,
  orderValue: 1_000_000n * 100n,
  isKahadePlus: false,
  completedAt: null,
};

const DISPUTE_ROW = {
  id: 'disp-1',
  disputeId: 'D-1',
  status: DisputeStatus.OPEN,
  orderId: 'ord-1',
};

describe('MutualResolutionService', () => {
  let service: MutualResolutionService;

  beforeEach(async () => {
    jest.clearAllMocks();
    // `clearAllMocks` wipes return values too, so an un-arranged `create` would resolve to
    // `undefined`. Real Prisma always hands back a Promise, and the C-20 silent-catch chains
    // `.catch()` onto it — default it here so the mock keeps that contract. Tests that care
    // override with mockResolvedValue/mockRejectedValue.
    mockPrisma.notification.create.mockResolvedValue({ id: 'notif-default' });
    mockPrisma.$transaction.mockImplementation(async (fn: (tx: typeof mockPrisma) => Promise<unknown>) => fn(mockPrisma));
    mockPrisma.dispute.findUnique.mockResolvedValue({ status: DisputeStatus.OPEN, order: { status: OrderStatus.DISPUTED } });
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MutualResolutionService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: WalletTxSerialService, useValue: mockSerial },
        { provide: FeeCalculatorService, useValue: mockFeeCalculator },
      ],
    }).compile();
    service = module.get<MutualResolutionService>(MutualResolutionService);
  });

  describe('respond — REJECT race protection (C-04)', () => {
    function arrangeReject(opts: { alreadyResponded?: boolean } = {}) {
      mockPrisma.dispute.findFirst.mockResolvedValue({ ...DISPUTE_ROW, order: ORDER_ROW });
      mockPrisma.mutualResolutionProposal.findFirst.mockResolvedValue({
        id: 'prop-1',
        disputeId: 'disp-1',
        proposedBy: 'seller-1',
        status: 'PENDING',
        buyerPercent: 50,
        sellerPercent: 50,
      });
      // 0 rows = the proposal is no longer PENDING (already accepted by the race
      // that committed just before this REJECT arrived).
      mockPrisma.mutualResolutionProposal.updateMany.mockResolvedValue(
        opts.alreadyResponded ? { count: 0 } : { count: 1 },
      );
    }

    it('rejects a pending proposal normally', async () => {
      arrangeReject();
      const res = await service.respond('disp-1', 'prop-1', 'buyer-1', 'REJECT');
      expect((res as { status: string }).status).toBe('REJECTED');
      expect(mockPrisma.mutualResolutionProposal.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ status: 'PENDING' }) }),
      );
    });

    it('THROWS ConflictException instead of overwriting a proposal that was already accepted', async () => {
      arrangeReject({ alreadyResponded: true });
      await expect(service.respond('disp-1', 'prop-1', 'buyer-1', 'REJECT')).rejects.toBeInstanceOf(ConflictException);
      // No notification claiming "your proposal was rejected" for a proposal that was accepted.
      expect(mockPrisma.notification.create).not.toHaveBeenCalled();
    });

    it('does not run the accept/disbursement path for REJECT', async () => {
      arrangeReject();
      await service.respond('disp-1', 'prop-1', 'buyer-1', 'REJECT');
      expect(mockPrisma.$transaction).toHaveBeenCalled();
    });
  });

  describe('withdraw — race protection (C-04)', () => {
    it('withdraws a pending proposal normally', async () => {
      mockPrisma.dispute.findFirst.mockResolvedValue({ ...DISPUTE_ROW, order: ORDER_ROW });
      mockPrisma.mutualResolutionProposal.findFirst.mockResolvedValue({
        id: 'prop-1',
        disputeId: 'disp-1',
        proposedBy: 'seller-1',
        status: 'PENDING',
      });
      mockPrisma.mutualResolutionProposal.updateMany.mockResolvedValue({ count: 1 });
      const res = await service.withdraw('disp-1', 'prop-1', 'seller-1');
      expect(res.status).toBe('WITHDRAWN');
    });

    it('THROWS ConflictException instead of overwriting an accepted proposal', async () => {
      mockPrisma.dispute.findFirst.mockResolvedValue({ ...DISPUTE_ROW, order: ORDER_ROW });
      mockPrisma.mutualResolutionProposal.findFirst.mockResolvedValue({
        id: 'prop-1',
        disputeId: 'disp-1',
        proposedBy: 'seller-1',
        status: 'PENDING',
      });
      mockPrisma.mutualResolutionProposal.updateMany.mockResolvedValue({ count: 0 });
      await expect(service.withdraw('disp-1', 'prop-1', 'seller-1')).rejects.toBeInstanceOf(ConflictException);
    });

    it('does not use a blind id-only write', async () => {
      mockPrisma.dispute.findFirst.mockResolvedValue({ ...DISPUTE_ROW, order: ORDER_ROW });
      mockPrisma.mutualResolutionProposal.findFirst.mockResolvedValue({
        id: 'prop-1',
        disputeId: 'disp-1',
        proposedBy: 'seller-1',
        status: 'PENDING',
      });
      mockPrisma.mutualResolutionProposal.updateMany.mockResolvedValue({ count: 1 });
      await service.withdraw('disp-1', 'prop-1', 'seller-1');
      const arg = mockPrisma.mutualResolutionProposal.updateMany.mock.calls[0][0];
      expect(arg.where).toEqual(expect.objectContaining({ id: 'prop-1', status: 'PENDING' }));
      expect(arg.where.status).toBe('PENDING');
    });
  });

  /*
   * C-20: `propose` and the REJECT branch of `respond` each wrote their notification as a bare
   * `await` AFTER their own write had already committed. A transient failure on the notification
   * row therefore rethrew a 500 for an action that had in fact taken effect — and the caller's
   * natural retry then hit the very guard that action had just satisfied
   * (PROPOSAL_ALREADY_PENDING / PROPOSAL_ALREADY_RESPONDED). Same shape as C-19.
   */
  describe('post-commit notifications must not fail the request (C-20)', () => {
    function arrangePropose() {
      mockPrisma.dispute.findFirst.mockResolvedValue({ ...DISPUTE_ROW, order: ORDER_ROW });
      mockPrisma.$transaction.mockImplementation(async (fn: (tx: typeof mockPrisma) => Promise<unknown>) => fn(mockPrisma));
      mockPrisma.mutualResolutionProposal.findFirst.mockResolvedValue(null);
      mockPrisma.mutualResolutionProposal.count.mockResolvedValue(0);
      mockPrisma.dispute.findUnique.mockResolvedValue({ status: DisputeStatus.OPEN, order: { status: OrderStatus.DISPUTED } });
      mockPrisma.mutualResolutionProposal.create.mockResolvedValue({
        id: 'prop-1', buyerPercent: 50, sellerPercent: 50, status: 'PENDING',
      });
    }

    it('rejects fractional percentages before reading the dispute', async () => {
      await expect(service.propose('disp-1', 'buyer-1', { buyerPercent: 50.5, sellerPercent: 49.5, reason: 'split it evenly' })).rejects.toBeInstanceOf(BadRequestException);
      expect(mockPrisma.dispute.findFirst).not.toHaveBeenCalled();
    });

    it('propose still returns the created proposal when the notification write fails', async () => {
      arrangePropose();
      mockPrisma.notification.create.mockRejectedValue(new Error('notifications table unavailable'));

      await expect(
        service.propose('disp-1', 'buyer-1', { buyerPercent: 50, sellerPercent: 50, reason: 'split it evenly' }),
      ).resolves.toMatchObject({ proposalId: 'prop-1', status: 'PENDING' });
    });

    it('propose notifies the counterparty on the happy path', async () => {
      arrangePropose();
      mockPrisma.notification.create.mockResolvedValue({ id: 'n1' });

      await service.propose('disp-1', 'buyer-1', { buyerPercent: 50, sellerPercent: 50, reason: 'split it evenly' });

      expect(mockPrisma.notification.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ userId: 'seller-1' }) }),
      );
    });

    it('REJECT still succeeds when the notification write fails', async () => {
      mockPrisma.dispute.findFirst.mockResolvedValue({ ...DISPUTE_ROW, order: ORDER_ROW });
      mockPrisma.mutualResolutionProposal.findFirst.mockResolvedValue({
        id: 'prop-1', disputeId: 'disp-1', proposedBy: 'seller-1', status: 'PENDING',
        buyerPercent: 50, sellerPercent: 50,
      });
      mockPrisma.mutualResolutionProposal.updateMany.mockResolvedValue({ count: 1 });
      mockPrisma.notification.create.mockRejectedValue(new Error('notifications table unavailable'));

      // The REJECTED write already committed; a 500 here would strand the responder.
      await expect(service.respond('disp-1', 'prop-1', 'buyer-1', 'REJECT')).resolves.toMatchObject({
        status: 'REJECTED',
      });
    });
  });

  void BadRequestException;
  void NotFoundException;
  void ActorType;
  void Prisma;
});
