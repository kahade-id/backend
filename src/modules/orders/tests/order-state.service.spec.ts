import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, ConflictException, Logger } from '@nestjs/common';
import { OrderStateService } from '../order-state.service';
import { PrismaService } from '../../../prisma/prisma.service';
import { RedisService } from '../../../redis/redis.service';
import { WalletService } from '../../wallet/wallet.service';
import { OrderQrisPaymentService } from '../../payment/order-qris-payment.service';
import { WalletTxSerialService } from '../../../common/services/wallet-tx-serial.service';
import { ReferralService } from '../../referral/referral.service';
import { FeeCalculatorService } from '../fee-calculator.service';
import { RealtimeService } from '../../realtime/realtime.service';
import { MembershipRankService } from '../membership-rank.service';
import { NotificationQueueService } from '../../queue/notification-queue.service';
import { OrderStatus, FeeResponsibility, OrderType, Prisma } from '@prisma/client';

const mockOrder = {
  id: 'order-internal-1',
  orderId: 'ORD-20260101-001',
  buyerId: 'user-db-1',
  sellerId: 'user-db-2',
  title: 'Test Order',
  description: 'Test description',
  orderType: OrderType.PHYSICAL_GOODS,
  status: OrderStatus.WAITING_CONFIRMATION,
  orderValue: BigInt(10_000_000),
  feeAmount: BigInt(150_000),
  feeResponsibility: FeeResponsibility.BUYER,
  buyerFeeAmount: BigInt(150_000),
  sellerFeeAmount: BigInt(0),
  buyerPayAmount: BigInt(10_150_000),
  sellerReceiveAmount: BigInt(10_000_000),
  isKahadePlus: false,
  feeRate: 1.5,
  deliveryDeadlineDays: 7,
  voucherDiscount: BigInt(0),
  voucherId: null,
  createdByBuyer: true,
  paymentDeadlineAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

const mockBuyerWallet = {
  id: 'wallet-1',
  userId: 'user-db-1',
  availableBalance: BigInt(20_000_000),
  escrowBalance: BigInt(0),
  totalBalance: BigInt(20_000_000),
  isLocked: false,
  version: 1,
};

const mockSellerWallet = {
  id: 'wallet-2',
  userId: 'user-db-2',
  availableBalance: BigInt(0),
  escrowBalance: BigInt(0),
  totalBalance: BigInt(0),
  isLocked: false,
  version: 1,
};

const mockPrisma = {
  order: {
    findFirst: jest.fn(),
    findUnique: jest.fn(),
    update: jest.fn(),
    updateMany: jest.fn(),
  },
  wallet: {
    findFirst: jest.fn(),
    findUnique: jest.fn(),
    update: jest.fn(),
    updateMany: jest.fn().mockResolvedValue({ count: 1 }),
  },
  walletTransaction: {
    create: jest.fn(),
    findFirst: jest.fn(),
  },
  paymentTransaction: {
    findFirst: jest.fn().mockResolvedValue(null),
  },
  orderStatusHistory: {
    create: jest.fn(),
  },
  orderExtensionRequest: {
    updateMany: jest.fn(),
  },
  voucherUsage: {
    deleteMany: jest.fn(),
  },
  voucher: {
    updateMany: jest.fn(),
  },
  user: {
    update: jest.fn(),
  },
  subscription: {
    findFirst: jest.fn().mockResolvedValue(null),
    update: jest.fn(),
  },
  deliveryProof: {
    create: jest.fn(),
    findFirst: jest.fn().mockResolvedValue({ id: 'proof-1' }),
    findUnique: jest.fn(),
  },
  $transaction: jest.fn(),
  $queryRaw: jest.fn().mockResolvedValue([]),
  $executeRaw: jest.fn().mockResolvedValue(0),
};

const mockRedis = {
  get: jest.fn(),
  setex: jest.fn(),
  del: jest.fn(),
  incr: jest.fn(),
};

const mockWalletService = {
  releaseEscrow: jest.fn(),
  verifyPin: jest.fn().mockResolvedValue(true),
};

const mockOrderQrisPaymentService = {
  cancelPendingPaymentForOrder: jest.fn().mockResolvedValue(undefined),
  requestRefundForOrder: jest.fn().mockResolvedValue(undefined),
};

const mockMembershipRankService = {
  updateUserRank: jest.fn().mockResolvedValue(undefined),
  checkAndUpdateMembershipRank: jest.fn().mockResolvedValue(undefined),
};

const mockNotificationQueueService = {
  enqueue: jest.fn().mockResolvedValue(undefined),
  queueOrderStatusUpdate: jest.fn().mockResolvedValue(undefined),
  queueDispute: jest.fn().mockResolvedValue(undefined),
};

const mockWalletTxSerial = {
  getNext: jest.fn().mockResolvedValue(1),
};

const mockReferralService = {
  createReferralRewardIfEligible: jest.fn().mockResolvedValue(undefined),
};

const mockFeeCalculator = {
  getFeeConfig: jest.fn().mockResolvedValue({ kahadeFeeRateBps: 150, kahadePlusFeeRateBps: 50 }),
};

describe('OrderStateService', () => {
  let service: OrderStateService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        OrderStateService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: RedisService, useValue: mockRedis },
        { provide: WalletService, useValue: mockWalletService },
        { provide: OrderQrisPaymentService, useValue: mockOrderQrisPaymentService },
        { provide: WalletTxSerialService, useValue: mockWalletTxSerial },
        { provide: ReferralService, useValue: mockReferralService },
        { provide: FeeCalculatorService, useValue: mockFeeCalculator },
        { provide: RealtimeService, useValue: { sendToUser: jest.fn(), emitOrderUpdate: jest.fn(), emitToOrder: jest.fn() } },
        { provide: MembershipRankService, useValue: mockMembershipRankService },
        { provide: NotificationQueueService, useValue: mockNotificationQueueService },
      ],
    }).compile();

    service = module.get<OrderStateService>(OrderStateService);
    jest.clearAllMocks();

    mockWalletTxSerial.getNext.mockResolvedValue(1);
    mockPrisma.wallet.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.order.update.mockResolvedValue({});
    mockPrisma.order.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.orderStatusHistory.create.mockResolvedValue({});
    mockPrisma.orderExtensionRequest.updateMany.mockResolvedValue({ count: 0 });
    mockPrisma.walletTransaction.create.mockResolvedValue({});
    mockPrisma.walletTransaction.findFirst.mockResolvedValue({ amount: BigInt(10_150_000) });
    mockPrisma.paymentTransaction.findFirst.mockResolvedValue(null);
    mockPrisma.voucherUsage.deleteMany.mockResolvedValue({ count: 1 });
    mockPrisma.voucher.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.user.update.mockResolvedValue({});
    mockPrisma.$queryRaw.mockResolvedValue([]);
    mockReferralService.createReferralRewardIfEligible.mockResolvedValue(undefined);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  // ─── handleConfirmAction ───────────────────────────────────────────────────

  describe('handleConfirmAction', () => {
    it('should return WAITING_PAYMENT status on ACCEPT action', async () => {
      mockPrisma.$transaction.mockImplementation(async (fn: (tx: typeof mockPrisma) => Promise<unknown>) => {
        mockPrisma.order.findUnique.mockResolvedValue({ ...mockOrder, status: OrderStatus.WAITING_CONFIRMATION, sellerId: 'seller-id' });
        return fn(mockPrisma);
      });

      const result = await service.handleConfirmAction('ORD-001', 'seller-id', 'ACCEPT');

      expect(result.status).toBe('WAITING_PAYMENT');
    });

    it('should return CANCELLED status on REJECT action', async () => {
      mockPrisma.$transaction.mockImplementation(async (fn: (tx: typeof mockPrisma) => Promise<unknown>) => {
        mockPrisma.order.findUnique.mockResolvedValue({ ...mockOrder, status: OrderStatus.WAITING_CONFIRMATION, sellerId: 'seller-id' });
        return fn(mockPrisma);
      });

      const result = await service.handleConfirmAction('ORD-001', 'seller-id', 'REJECT', 'Not interested');

      expect(result.status).toBe('CANCELLED');
    });

    it('returns committed confirmation even when post-commit notification fails', async () => {
      mockPrisma.$transaction.mockImplementation(async (fn: (tx: typeof mockPrisma) => Promise<unknown>) => {
        mockPrisma.order.findUnique.mockResolvedValue({ ...mockOrder, status: OrderStatus.WAITING_CONFIRMATION, sellerId: 'seller-id' });
        return fn(mockPrisma);
      });
      mockNotificationQueueService.enqueue.mockRejectedValueOnce(new Error('queue unavailable'));

      await expect(service.handleConfirmAction('ORD-001', 'seller-id', 'ACCEPT')).resolves.toMatchObject({
        status: 'WAITING_PAYMENT',
      });
    });
  });

  // ─── confirmOrder ──────────────────────────────────────────────────────────

  describe('confirmOrder', () => {
    it('should throw BadRequestException when order not found', async () => {
      mockPrisma.$transaction.mockImplementation(async (fn: (tx: typeof mockPrisma) => Promise<unknown>) => {
        mockPrisma.order.findUnique.mockResolvedValue(null);
        return fn(mockPrisma);
      });

      await expect(service.confirmOrder('ORD-INVALID', 'seller-id')).rejects.toThrow(BadRequestException);
    });

    it('should throw BadRequestException when order is not WAITING_CONFIRMATION', async () => {
      mockPrisma.$transaction.mockImplementation(async (fn: (tx: typeof mockPrisma) => Promise<unknown>) => {
        mockPrisma.order.findUnique.mockResolvedValue({ ...mockOrder, status: OrderStatus.PROCESSING, sellerId: 'seller-id' });
        return fn(mockPrisma);
      });

      await expect(service.confirmOrder('ORD-001', 'seller-id')).rejects.toThrow(BadRequestException);
    });

    it('should throw BadRequestException when confirmer is not the seller', async () => {
      mockPrisma.$transaction.mockImplementation(async (fn: (tx: typeof mockPrisma) => Promise<unknown>) => {
        mockPrisma.order.findUnique.mockResolvedValue({ ...mockOrder, status: OrderStatus.WAITING_CONFIRMATION, sellerId: 'real-seller-id' });
        return fn(mockPrisma);
      });

      await expect(service.confirmOrder('ORD-001', 'wrong-seller-id')).rejects.toThrow(BadRequestException);
    });

    it('should update order to WAITING_PAYMENT on successful confirm', async () => {
      mockPrisma.$transaction.mockImplementation(async (fn: (tx: typeof mockPrisma) => Promise<unknown>) => {
        mockPrisma.order.findUnique.mockResolvedValue({ ...mockOrder, status: OrderStatus.WAITING_CONFIRMATION, sellerId: 'seller-id' });
        return fn(mockPrisma);
      });

      await service.confirmOrder('ORD-001', 'seller-id');

      expect(mockPrisma.order.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: OrderStatus.WAITING_PAYMENT }),
        }),
      );
    });

    it('should create an orderStatusHistory record on confirm', async () => {
      mockPrisma.$transaction.mockImplementation(async (fn: (tx: typeof mockPrisma) => Promise<unknown>) => {
        mockPrisma.order.findUnique.mockResolvedValue({ ...mockOrder, status: OrderStatus.WAITING_CONFIRMATION, sellerId: 'seller-id' });
        return fn(mockPrisma);
      });

      await service.confirmOrder('ORD-001', 'seller-id');

      expect(mockPrisma.orderStatusHistory.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            fromStatus: OrderStatus.WAITING_CONFIRMATION,
            toStatus: OrderStatus.WAITING_PAYMENT,
          }),
        }),
      );
    });
  });

  // ─── rejectOrder ───────────────────────────────────────────────────────────

  describe('rejectOrder', () => {
    it('should throw BadRequestException when order not found', async () => {
      mockPrisma.$transaction.mockImplementation(async (fn: (tx: typeof mockPrisma) => Promise<unknown>) => {
        mockPrisma.order.findUnique.mockResolvedValue(null);
        return fn(mockPrisma);
      });

      await expect(service.rejectOrder('ORD-INVALID', 'seller-id')).rejects.toThrow(BadRequestException);
    });

    it('should throw BadRequestException when rejecter is not the seller', async () => {
      mockPrisma.$transaction.mockImplementation(async (fn: (tx: typeof mockPrisma) => Promise<unknown>) => {
        mockPrisma.order.findUnique.mockResolvedValue({ ...mockOrder, status: OrderStatus.WAITING_CONFIRMATION, sellerId: 'real-seller' });
        return fn(mockPrisma);
      });

      await expect(service.rejectOrder('ORD-001', 'wrong-seller')).rejects.toThrow(BadRequestException);
    });

    it('should update order to CANCELLED and restore voucher usage on reject', async () => {
      const orderWithVoucher = { ...mockOrder, status: OrderStatus.WAITING_CONFIRMATION, sellerId: 'seller-id', voucherId: 'voucher-1' };

      mockPrisma.$transaction.mockImplementation(async (fn: (tx: typeof mockPrisma) => Promise<unknown>) => {
        mockPrisma.order.findUnique.mockResolvedValue(orderWithVoucher);
        return fn(mockPrisma);
      });

      await service.rejectOrder('ORD-001', 'seller-id', 'Not suitable');

      expect(mockPrisma.order.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ status: OrderStatus.CANCELLED }) }),
      );
      expect(mockPrisma.voucherUsage.deleteMany).toHaveBeenCalled();
      expect(mockPrisma.voucher.updateMany).toHaveBeenCalled();
    });
  });

  // ─── payOrder ──────────────────────────────────────────────────────────────

  describe('payOrder', () => {
    it('should throw BadRequestException when order not found', async () => {
      mockPrisma.order.findFirst.mockResolvedValue(null);

      await expect(service.payOrder('ORD-INVALID', 'buyer-id')).rejects.toThrow(BadRequestException);
    });

    it('should throw BadRequestException when order is not WAITING_PAYMENT', async () => {
      mockPrisma.order.findFirst.mockResolvedValue({
        ...mockOrder,
        status: OrderStatus.PROCESSING,
        buyerId: 'buyer-id',
        buyer: { wallet: { id: 'wallet-1' } },
      });

      await expect(service.payOrder('ORD-001', 'buyer-id')).rejects.toThrow(BadRequestException);
    });

    it('should throw BadRequestException when buyer is not the order buyer', async () => {
      mockPrisma.order.findFirst.mockResolvedValue({
        ...mockOrder,
        status: OrderStatus.WAITING_PAYMENT,
        buyerId: 'real-buyer-id',
        buyer: { wallet: { id: 'wallet-1' } },
      });

      await expect(service.payOrder('ORD-001', 'wrong-buyer-id')).rejects.toThrow(BadRequestException);
    });

    it('should throw BadRequestException when buyer wallet not found', async () => {
      mockPrisma.order.findFirst.mockResolvedValue({
        ...mockOrder,
        status: OrderStatus.WAITING_PAYMENT,
        buyerId: 'buyer-id',
        buyer: { wallet: null },
      });

      await expect(service.payOrder('ORD-001', 'buyer-id')).rejects.toThrow(BadRequestException);
    });

    it('should throw BadRequestException when insufficient balance', async () => {
      mockPrisma.order.findFirst.mockResolvedValue({
        ...mockOrder,
        status: OrderStatus.WAITING_PAYMENT,
        buyerId: 'buyer-id',
        buyerPayAmount: BigInt(100_000_000),
        buyer: { wallet: { id: 'wallet-1' } },
      });

      mockPrisma.$transaction.mockImplementation(async (fn: (tx: typeof mockPrisma) => Promise<unknown>) => {
        mockPrisma.wallet.findUnique.mockResolvedValue({ ...mockBuyerWallet, availableBalance: BigInt(1_000) });
        return fn(mockPrisma);
      });

      await expect(service.payOrder('ORD-001', 'buyer-id')).rejects.toThrow(BadRequestException);
    });

    it('should throw BadRequestException on optimistic lock conflict during payment', async () => {
      mockPrisma.order.findFirst.mockResolvedValue({
        ...mockOrder,
        status: OrderStatus.WAITING_PAYMENT,
        buyerId: 'buyer-id',
        buyerPayAmount: BigInt(10_150_000),
        buyer: { wallet: { id: 'wallet-1' } },
      });

      mockPrisma.$transaction.mockImplementation(async (fn: (tx: typeof mockPrisma) => Promise<unknown>) => {
        mockPrisma.wallet.findUnique.mockResolvedValue(mockBuyerWallet);
        mockPrisma.wallet.updateMany.mockResolvedValue({ count: 0 });
        return fn(mockPrisma);
      });

      await expect(service.payOrder('ORD-001', 'buyer-id')).rejects.toThrow(BadRequestException);
    });

    it('retries a transient Serializable payment conflict with the same wallet transaction serial', async () => {
      const orderFixture = {
        ...mockOrder,
        status: OrderStatus.WAITING_PAYMENT,
        buyerId: 'buyer-id',
        buyerPayAmount: BigInt(10_150_000),
        buyer: { wallet: { id: 'wallet-1' } },
      };
      mockPrisma.order.findUnique.mockResolvedValue(orderFixture);
      mockPrisma.order.findFirst.mockResolvedValue(orderFixture);
      let attempt = 0;
      mockPrisma.$transaction.mockImplementation(async (fn: (tx: typeof mockPrisma) => Promise<unknown>) => {
        attempt += 1;
        mockPrisma.order.findUnique.mockResolvedValue(orderFixture);
        mockPrisma.wallet.findUnique.mockResolvedValue(mockBuyerWallet);
        mockPrisma.wallet.updateMany.mockResolvedValue({ count: 1 });
        await fn(mockPrisma);
        if (attempt === 1) throw new Prisma.PrismaClientUnknownRequestError('serialization failure SQLSTATE 40001', { clientVersion: 'test' });
        return undefined;
      });

      await expect(service.payOrder('ORD-001', 'buyer-id')).resolves.toHaveProperty('walletTxId');
      expect(mockPrisma.$transaction).toHaveBeenCalledTimes(2);
      expect(mockWalletTxSerial.getNext).toHaveBeenCalledTimes(1);
    });

    it('should return walletTxId on successful payment', async () => {
      const orderFixture = {
        ...mockOrder,
        status: OrderStatus.WAITING_PAYMENT,
        buyerId: 'buyer-id',
        buyerPayAmount: BigInt(10_150_000),
        buyer: { wallet: { id: 'wallet-1' } },
      };
      mockPrisma.order.findFirst.mockResolvedValue(orderFixture);
      mockPrisma.order.findUnique.mockResolvedValue(orderFixture);

      mockPrisma.$transaction.mockImplementation(async (fn: (tx: typeof mockPrisma) => Promise<unknown>) => {
        mockPrisma.order.findUnique.mockResolvedValue(orderFixture);
        mockPrisma.wallet.findUnique.mockResolvedValue(mockBuyerWallet);
        mockPrisma.wallet.updateMany.mockResolvedValue({ count: 1 });
        return fn(mockPrisma);
      });

      const result = await service.payOrder('ORD-001', 'buyer-id');

      expect(result).toHaveProperty('walletTxId');
      expect(typeof result.walletTxId).toBe('string');
    });
  });

  // ─── handlePayOrder ────────────────────────────────────────────────────────

  describe('handlePayOrder', () => {
    it('should return orderId, PROCESSING status, and walletTxId', async () => {
      const orderFixture = {
        ...mockOrder,
        status: OrderStatus.WAITING_PAYMENT,
        buyerId: 'buyer-id',
        buyerPayAmount: BigInt(10_150_000),
        buyer: { wallet: { id: 'wallet-1' } },
      };
      mockPrisma.order.findFirst.mockResolvedValue(orderFixture);
      mockPrisma.order.findUnique.mockResolvedValue(orderFixture);

      mockPrisma.$transaction.mockImplementation(async (fn: (tx: typeof mockPrisma) => Promise<unknown>) => {
        mockPrisma.order.findUnique.mockResolvedValue(orderFixture);
        mockPrisma.wallet.findUnique.mockResolvedValue(mockBuyerWallet);
        mockPrisma.wallet.updateMany.mockResolvedValue({ count: 1 });
        return fn(mockPrisma);
      });

      const result = await service.handlePayOrder('ORD-001', 'buyer-id', '481723', '127.0.0.1');

      expect(result.status).toBe('PROCESSING');
      expect(result).toHaveProperty('walletTxId');
    });
  });

  // ─── cancelOrder ───────────────────────────────────────────────────────────

  describe('cancelOrder', () => {
    it('should throw BadRequestException when order not found', async () => {
      mockPrisma.$transaction.mockImplementation(async (fn: (tx: typeof mockPrisma) => Promise<unknown>) => {
        mockPrisma.order.findUnique.mockResolvedValue(null);
        return fn(mockPrisma);
      });

      await expect(service.cancelOrder('ORD-INVALID', 'user-id', 'reason')).rejects.toThrow(BadRequestException);
    });

    it('should throw BadRequestException when user is not a participant', async () => {
      mockPrisma.$transaction.mockImplementation(async (fn: (tx: typeof mockPrisma) => Promise<unknown>) => {
        mockPrisma.order.findUnique.mockResolvedValue({ ...mockOrder, buyerId: 'buyer-id', sellerId: 'seller-id' });
        return fn(mockPrisma);
      });

      await expect(service.cancelOrder('ORD-001', 'outsider-id', 'reason')).rejects.toThrow(BadRequestException);
    });

    it('should allow buyer to cancel at WAITING_CONFIRMATION', async () => {
      mockPrisma.$transaction.mockImplementation(async (fn: (tx: typeof mockPrisma) => Promise<unknown>) => {
        mockPrisma.order.findUnique.mockResolvedValue({ ...mockOrder, status: OrderStatus.WAITING_CONFIRMATION, buyerId: 'buyer-id', sellerId: 'seller-id', voucherId: null });
        return fn(mockPrisma);
      });

      await service.cancelOrder('ORD-001', 'buyer-id', 'Changed mind');

      expect(mockPrisma.order.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ status: OrderStatus.CANCELLED }) }),
      );
    });

    it('should allow buyer to cancel at WAITING_PAYMENT', async () => {
      mockPrisma.$transaction.mockImplementation(async (fn: (tx: typeof mockPrisma) => Promise<unknown>) => {
        mockPrisma.order.findUnique.mockResolvedValue({ ...mockOrder, status: OrderStatus.WAITING_PAYMENT, buyerId: 'buyer-id', sellerId: 'seller-id', voucherId: null });
        return fn(mockPrisma);
      });

      await service.cancelOrder('ORD-001', 'buyer-id', 'reason');

      expect(mockPrisma.order.updateMany).toHaveBeenCalled();
    });

    it('should throw BadRequestException when seller tries to cancel at PROCESSING', async () => {
      mockPrisma.$transaction.mockImplementation(async (fn: (tx: typeof mockPrisma) => Promise<unknown>) => {
        mockPrisma.order.findUnique.mockResolvedValue({ ...mockOrder, status: OrderStatus.PROCESSING, buyerId: 'buyer-id', sellerId: 'seller-id' });
        return fn(mockPrisma);
      });

      await expect(service.cancelOrder('ORD-001', 'seller-id', 'reason')).rejects.toThrow(BadRequestException);
    });

    it('should restore voucher usage when cancelling an order with a voucher', async () => {
      const orderWithVoucher = {
        ...mockOrder,
        status: OrderStatus.WAITING_CONFIRMATION,
        buyerId: 'buyer-id',
        sellerId: 'seller-id',
        voucherId: 'voucher-1',
      };

      mockPrisma.$transaction.mockImplementation(async (fn: (tx: typeof mockPrisma) => Promise<unknown>) => {
        mockPrisma.order.findUnique.mockResolvedValue(orderWithVoucher);
        return fn(mockPrisma);
      });

      await service.cancelOrder('ORD-001', 'buyer-id', 'reason');

      expect(mockPrisma.voucherUsage.deleteMany).toHaveBeenCalled();
      expect(mockPrisma.voucher.updateMany).toHaveBeenCalled();
    });

    it('does not decrement voucher currentUsage when no usage row was deleted', async () => {
      const orderWithVoucher = {
        ...mockOrder,
        status: OrderStatus.WAITING_CONFIRMATION,
        buyerId: 'buyer-id',
        sellerId: 'seller-id',
        voucherId: 'voucher-1',
      };
      mockPrisma.voucherUsage.deleteMany.mockResolvedValueOnce({ count: 0 });
      mockPrisma.$transaction.mockImplementation(async (fn: (tx: typeof mockPrisma) => Promise<unknown>) => {
        mockPrisma.order.findUnique.mockResolvedValue(orderWithVoucher);
        return fn(mockPrisma);
      });

      await service.cancelOrder('ORD-001', 'buyer-id', 'reason');

      expect(mockPrisma.voucherUsage.deleteMany).toHaveBeenCalled();
      expect(mockPrisma.voucher.updateMany).not.toHaveBeenCalled();
    });
  });

  // ─── handleCancelOrder ─────────────────────────────────────────────────────

  describe('handleCancelOrder', () => {
    it('should return CANCELLED status and refunded: false', async () => {
      mockPrisma.$transaction.mockImplementation(async (fn: (tx: typeof mockPrisma) => Promise<unknown>) => {
        mockPrisma.order.findUnique.mockResolvedValue({ ...mockOrder, buyerId: 'buyer-id', sellerId: 'seller-id', voucherId: null });
        return fn(mockPrisma);
      });

      const result = await service.handleCancelOrder('ORD-001', 'buyer-id', 'CHANGED_MIND');

      expect(result.status).toBe('CANCELLED');
    });
  });

  // ─── completeOrder ─────────────────────────────────────────────────────────

  describe('completeOrder', () => {
    it('should throw BadRequestException when order not found', async () => {
      mockPrisma.$transaction.mockImplementation(async (fn: (tx: typeof mockPrisma) => Promise<unknown>) => {
        mockPrisma.order.findUnique.mockResolvedValue(null);
        return fn(mockPrisma);
      });

      await expect(service.completeOrder('ORD-INVALID', 'buyer-id')).rejects.toThrow(BadRequestException);
    });

    it('should throw BadRequestException when order is not IN_DELIVERY', async () => {
      mockPrisma.$transaction.mockImplementation(async (fn: (tx: typeof mockPrisma) => Promise<unknown>) => {
        mockPrisma.order.findUnique.mockResolvedValue({ ...mockOrder, status: OrderStatus.PROCESSING, buyerId: 'buyer-id' });
        return fn(mockPrisma);
      });

      await expect(service.completeOrder('ORD-001', 'buyer-id')).rejects.toThrow(BadRequestException);
    });

    it('should throw BadRequestException when completer is not the buyer', async () => {
      mockPrisma.$transaction.mockImplementation(async (fn: (tx: typeof mockPrisma) => Promise<unknown>) => {
        mockPrisma.order.findUnique.mockResolvedValue({ ...mockOrder, status: OrderStatus.IN_DELIVERY, buyerId: 'real-buyer-id' });
        return fn(mockPrisma);
      });

      await expect(service.completeOrder('ORD-001', 'wrong-buyer-id')).rejects.toThrow(BadRequestException);
    });

    it('should throw BadRequestException when buyer or seller wallet is missing', async () => {
      mockPrisma.$transaction.mockImplementation(async (fn: (tx: typeof mockPrisma) => Promise<unknown>) => {
        mockPrisma.order.findUnique.mockResolvedValue({ ...mockOrder, status: OrderStatus.IN_DELIVERY, buyerId: 'buyer-id' });
        mockPrisma.wallet.findUnique.mockResolvedValue(null);
        return fn(mockPrisma);
      });

      await expect(service.completeOrder('ORD-001', 'buyer-id')).rejects.toThrow(BadRequestException);
    });

    it('should complete order successfully and update both wallets', async () => {
      mockPrisma.$transaction.mockImplementation(async (fn: (tx: typeof mockPrisma) => Promise<unknown>) => {
        mockPrisma.order.findUnique.mockResolvedValue({
          ...mockOrder,
          status: OrderStatus.IN_DELIVERY,
          buyerId: 'buyer-id',
          sellerId: 'seller-id',
          buyerPayAmount: BigInt(10_150_000),
          sellerReceiveAmount: BigInt(10_000_000),
          feeAmount: BigInt(150_000),
        });
        mockPrisma.wallet.findUnique
          .mockResolvedValueOnce({ id: mockBuyerWallet.id })
          .mockResolvedValueOnce({ id: mockSellerWallet.id })
          .mockResolvedValueOnce(mockBuyerWallet)
          .mockResolvedValueOnce(mockSellerWallet);
        mockPrisma.wallet.updateMany.mockResolvedValue({ count: 1 });
        return fn(mockPrisma);
      });

      await service.completeOrder('ORD-001', 'buyer-id');

      expect(mockPrisma.order.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ status: OrderStatus.IN_DELIVERY }),
          data: expect.objectContaining({ status: OrderStatus.COMPLETED }),
        }),
      );
      expect(mockPrisma.walletTransaction.create).toHaveBeenCalledTimes(3); // ORDER_RELEASE (buyer) + ORDER_RELEASE (seller) + FEE_DEDUCT
    });

    it('should throw ConflictException on optimistic lock conflict during escrow release', async () => {
      mockPrisma.$transaction.mockImplementation(async (fn: (tx: typeof mockPrisma) => Promise<unknown>) => {
        mockPrisma.order.findUnique.mockResolvedValue({
          ...mockOrder,
          status: OrderStatus.IN_DELIVERY,
          buyerId: 'buyer-id',
          sellerId: 'seller-id',
          buyerPayAmount: BigInt(10_150_000),
          sellerReceiveAmount: BigInt(10_000_000),
        });
        mockPrisma.wallet.findUnique
          .mockResolvedValueOnce({ id: mockBuyerWallet.id })
          .mockResolvedValueOnce({ id: mockSellerWallet.id })
          .mockResolvedValueOnce(mockBuyerWallet)
          .mockResolvedValueOnce(mockSellerWallet);
        mockPrisma.wallet.updateMany.mockResolvedValue({ count: 0 });
        return fn(mockPrisma);
      });

      await expect(service.completeOrder('ORD-001', 'buyer-id')).rejects.toThrow(ConflictException);
    });
  });

  /*
   * C-25: `completeOrder` drew all three wallet tx serials as the first statements INSIDE a
   * transaction that sits in a 3-attempt retry loop. `getNextWalletTxSerial` is a Redis INCR, so it
   * does not roll back with the PG transaction — a completion that retried twice burned 9 serials
   * and left 6 gaps in the day's `WLT-YYYYMMDD-NNNN` ledger sequence. The fee serial was also drawn
   * unconditionally while its row is written only when `feeAmount > 0`, so a fully-vouchered order
   * left a gap even with zero retries.
   */
  describe('completeOrder — wallet tx serial draws (C-25)', () => {
    const serializationFailure = () =>
      new Prisma.PrismaClientUnknownRequestError(
        'could not serialize access due to read/write dependencies among transactions (SQLSTATE 40001)',
        { clientVersion: 'test' },
      );

    function arrangeOrder(feeAmount: bigint) {
      mockPrisma.order.findUnique.mockResolvedValue({
        ...mockOrder,
        status: OrderStatus.IN_DELIVERY,
        buyerId: 'buyer-id',
        sellerId: 'seller-id',
        buyerPayAmount: BigInt(10_150_000),
        sellerReceiveAmount: BigInt(10_000_000),
        feeAmount,
      });
      // `completeOrder` reads each wallet twice: a pre-lock lookup by userId, then the full row by
      // id after `FOR UPDATE`. Resolve on whichever key the call used so buyer and seller stay
      // distinct rows.
      mockPrisma.wallet.findUnique.mockImplementation((args: { where: { id?: string; userId?: string } }) => {
        const isSeller = args.where.id === mockSellerWallet.id || args.where.userId === 'seller-id';
        return Promise.resolve(isSeller ? mockSellerWallet : mockBuyerWallet);
      });
      mockPrisma.wallet.findFirst.mockResolvedValue(mockBuyerWallet);
      mockPrisma.wallet.updateMany.mockResolvedValue({ count: 1 });
    }

    beforeEach(() => {
      // mockReset, not clearAllMocks: these tests queue `...Once` behaviours on $transaction.
      mockPrisma.$transaction.mockReset();
      mockWalletTxSerial.getNext.mockReset();
      let serial = 0;
      mockWalletTxSerial.getNext.mockImplementation(() => Promise.resolve(++serial));
      // Read through an optional cast so this suite still compiles against the pre-fix file when
      // the falsification cycle reverts it.
      const logger = (service as unknown as { logger?: Logger }).logger;
      if (logger) {
        jest.spyOn(logger, 'error').mockImplementation(() => undefined);
        jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
      }
    });

    it('fails closed when the matching escrow lock ledger is missing', async () => {
      arrangeOrder(BigInt(150_000));
      mockPrisma.walletTransaction.findFirst.mockResolvedValue(null);
      mockPrisma.$transaction.mockImplementation(async (fn: (tx: typeof mockPrisma) => Promise<unknown>) => fn(mockPrisma));

      await expect(service.completeOrder('ORD-001', 'buyer-id')).rejects.toMatchObject({
        response: { code: 'ESCROW_LOCK_MISSING' },
      });
      expect(mockPrisma.wallet.updateMany).not.toHaveBeenCalled();
    });

    it('draws exactly 3 serials for a fee-bearing completion that needs no retry', async () => {
      arrangeOrder(BigInt(150_000));
      mockPrisma.$transaction.mockImplementation(async (fn: (tx: typeof mockPrisma) => Promise<unknown>) => fn(mockPrisma));

      await service.completeOrder('ORD-001', 'buyer-id');

      expect(mockWalletTxSerial.getNext).toHaveBeenCalledTimes(3);
      expect(mockPrisma.walletTransaction.create).toHaveBeenCalledTimes(3);
    });

    it('draws only 2 serials when the order carries no fee', async () => {
      arrangeOrder(BigInt(0));
      mockPrisma.$transaction.mockImplementation(async (fn: (tx: typeof mockPrisma) => Promise<unknown>) => fn(mockPrisma));

      await service.completeOrder('ORD-001', 'buyer-id');

      // Pre-fix: 3 drawn, 2 written — the third was a permanent gap on every zero-fee completion.
      expect(mockWalletTxSerial.getNext).toHaveBeenCalledTimes(2);
      expect(mockPrisma.walletTransaction.create).toHaveBeenCalledTimes(2);
    });

    it('does NOT redraw serials across 3 failing attempts', async () => {
      arrangeOrder(BigInt(150_000));
      mockPrisma.$transaction.mockImplementation(async (fn: (tx: typeof mockPrisma) => Promise<unknown>) => {
        await fn(mockPrisma);
        throw serializationFailure();
      });

      await expect(service.completeOrder('ORD-001', 'buyer-id')).rejects.toBeTruthy();

      expect(mockPrisma.$transaction).toHaveBeenCalledTimes(3);
      // Pre-fix: 9 draws, so 6 `wallet_tx_serial` values were burned and left gaps in the day's
      // ledger sequence for an escrow release that never committed.
      expect(mockWalletTxSerial.getNext).toHaveBeenCalledTimes(3);
    });

    it('reuses the same txIds on a retry that succeeds', async () => {
      arrangeOrder(BigInt(150_000));
      let attempt = 0;
      mockPrisma.$transaction.mockImplementation(async (fn: (tx: typeof mockPrisma) => Promise<unknown>) => {
        attempt += 1;
        await fn(mockPrisma);
        if (attempt === 1) throw serializationFailure();
        return undefined;
      });

      await service.completeOrder('ORD-001', 'buyer-id');

      expect(mockWalletTxSerial.getNext).toHaveBeenCalledTimes(3);
      const txIds = mockPrisma.walletTransaction.create.mock.calls.map(
        (c) => (c[0] as { data: { txId: string } }).data.txId,
      );
      // `generateWalletTxId` appends a random `cryptoSuffix()`, so the full id necessarily differs
      // per call. The ledger *sequence* is the `WLT-<date>-<serial>` prefix — that is what must not
      // advance across attempts. 6 rows attempted, 3 distinct serials.
      expect(txIds).toHaveLength(6);
      const serialPrefixes = txIds.map((id) => id.split('-').slice(0, 3).join('-'));
      expect(new Set(serialPrefixes).size).toBe(3);
      expect(new Set(serialPrefixes).size).not.toBe(6);
    });

    it('draws the serials before opening the transaction', async () => {
      arrangeOrder(BigInt(150_000));
      mockPrisma.$transaction.mockImplementation(async (fn: (tx: typeof mockPrisma) => Promise<unknown>) => fn(mockPrisma));

      await service.completeOrder('ORD-001', 'buyer-id');

      // The first serial of the day can sleep 100 ms inside `getNextForPrefix`; that must not
      // happen while a Serializable transaction is open.
      expect(mockWalletTxSerial.getNext.mock.invocationCallOrder[0])
        .toBeLessThan(mockPrisma.$transaction.mock.invocationCallOrder[0]);
    });

    it('still burns no serial past the first draw when the order is not IN_DELIVERY', async () => {
      mockPrisma.order.findUnique.mockResolvedValue({ ...mockOrder, status: OrderStatus.PROCESSING, buyerId: 'buyer-id' });
      mockPrisma.$transaction.mockImplementation(async (fn: (tx: typeof mockPrisma) => Promise<unknown>) => fn(mockPrisma));

      await expect(service.completeOrder('ORD-001', 'buyer-id')).rejects.toThrow(BadRequestException);

      // The two unconditional draws are hoisted so they still happen, but the conditional fee draw
      // must not — and a domain rejection must not be retried into more draws.
      expect(mockWalletTxSerial.getNext).toHaveBeenCalledTimes(2);
      expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1);
    });
  });

  // ─── handleCompleteOrder ───────────────────────────────────────────────────

  describe('handleCompleteOrder', () => {
    it('should return orderId and COMPLETED status', async () => {
      mockPrisma.$transaction.mockImplementation(async (fn: (tx: typeof mockPrisma) => Promise<unknown>) => {
        mockPrisma.order.findUnique.mockResolvedValue({
          ...mockOrder,
          status: OrderStatus.IN_DELIVERY,
          buyerId: 'buyer-id',
          sellerId: 'seller-id',
          buyerPayAmount: BigInt(10_150_000),
          sellerReceiveAmount: BigInt(10_000_000),
          feeAmount: BigInt(150_000),
        });
        mockPrisma.wallet.findUnique
          .mockResolvedValueOnce({ id: mockBuyerWallet.id })
          .mockResolvedValueOnce({ id: mockSellerWallet.id })
          .mockResolvedValueOnce(mockBuyerWallet)
          .mockResolvedValueOnce(mockSellerWallet);
        mockPrisma.wallet.updateMany.mockResolvedValue({ count: 1 });
        return fn(mockPrisma);
      });

      const result = await service.handleCompleteOrder('ORD-001', 'buyer-id');

      expect(result.status).toBe('COMPLETED');
      expect(result.orderId).toBe('ORD-001');
    });
  });

  // ─── adminCancelOrder ──────────────────────────────────────────────────────

  describe('adminCancelOrder', () => {
    it('should throw BadRequestException when order not found', async () => {
      mockPrisma.order.findUnique.mockResolvedValue(null);
      mockPrisma.$transaction.mockImplementation(async (fn: (tx: typeof mockPrisma) => Promise<unknown>) => {
        mockPrisma.order.findUnique.mockResolvedValue(null);
        return fn(mockPrisma);
      });

      await expect(service.adminCancelOrder('ORD-INVALID', 'admin-id', 'reason')).rejects.toThrow(BadRequestException);
    });

    it('should throw BadRequestException when order is in a non-cancellable status (COMPLETED)', async () => {
      mockPrisma.order.findUnique.mockResolvedValue({ ...mockOrder, status: OrderStatus.COMPLETED });
      mockPrisma.$transaction.mockImplementation(async (fn: (tx: typeof mockPrisma) => Promise<unknown>) => {
        mockPrisma.order.findUnique.mockResolvedValue({ ...mockOrder, status: OrderStatus.COMPLETED });
        return fn(mockPrisma);
      });

      await expect(service.adminCancelOrder('ORD-001', 'admin-id', 'reason')).rejects.toThrow(BadRequestException);
    });

    it('should cancel order at WAITING_CONFIRMATION without refund', async () => {
      mockPrisma.order.findUnique.mockResolvedValue({ ...mockOrder, status: OrderStatus.WAITING_CONFIRMATION, buyerPayAmount: BigInt(10_150_000) });
      mockPrisma.$transaction.mockImplementation(async (fn: (tx: typeof mockPrisma) => Promise<unknown>) => {
        mockPrisma.order.findUnique.mockResolvedValue({ ...mockOrder, status: OrderStatus.WAITING_CONFIRMATION, buyerPayAmount: BigInt(10_150_000) });
        return fn(mockPrisma);
      });

      await service.adminCancelOrder('ORD-001', 'admin-id', 'reason');

      expect(mockPrisma.order.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ status: OrderStatus.CANCELLED, cancelReason: 'ADMIN_FORCE_CANCEL' }) }),
      );
      expect(mockPrisma.walletTransaction.create).not.toHaveBeenCalled();
    });

    it('should cancel order at PROCESSING with escrow refund', async () => {
      mockPrisma.order.findUnique.mockResolvedValue({ ...mockOrder, status: OrderStatus.PROCESSING, buyerPayAmount: BigInt(10_150_000), buyerId: 'buyer-id' });
      mockPrisma.$transaction.mockImplementation(async (fn: (tx: typeof mockPrisma) => Promise<unknown>) => {
        mockPrisma.order.findUnique.mockResolvedValue({
          ...mockOrder,
          status: OrderStatus.PROCESSING,
          buyerPayAmount: BigInt(10_150_000),
          buyerId: 'buyer-id',
        });
        mockPrisma.wallet.findFirst.mockResolvedValue(mockBuyerWallet);
        // C-05: balances are re-read with findUnique *after* the FOR UPDATE lock.
        mockPrisma.wallet.findUnique.mockResolvedValue(mockBuyerWallet);
        mockPrisma.wallet.updateMany.mockResolvedValue({ count: 1 });
        return fn(mockPrisma);
      });

      await service.adminCancelOrder('ORD-001', 'admin-id', 'reason');

      expect(mockPrisma.walletTransaction.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ type: 'ORDER_REFUND' }),
        }),
      );
    });

    it('C-05: locks the buyer wallet row BEFORE reading balances for the refund', async () => {
      mockPrisma.order.findUnique.mockResolvedValue({ ...mockOrder, status: OrderStatus.PROCESSING, buyerPayAmount: BigInt(10_150_000), buyerId: 'buyer-id' });
      mockPrisma.$transaction.mockImplementation(async (fn: (tx: typeof mockPrisma) => Promise<unknown>) => {
        mockPrisma.order.findUnique.mockResolvedValue({
          ...mockOrder,
          status: OrderStatus.PROCESSING,
          buyerPayAmount: BigInt(10_150_000),
          buyerId: 'buyer-id',
        });
        mockPrisma.wallet.findFirst.mockResolvedValue(mockBuyerWallet);
        mockPrisma.wallet.findUnique.mockResolvedValue(mockBuyerWallet);
        mockPrisma.wallet.updateMany.mockResolvedValue({ count: 1 });
        return fn(mockPrisma);
      });

      await service.adminCancelOrder('ORD-001', 'admin-id', 'reason');

      // The row lock must be taken, and the balance read must come after it —
      // every other escrow-moving path in the codebase locks first.
      expect(mockPrisma.$queryRaw).toHaveBeenCalled();
      const lockOrder = mockPrisma.$queryRaw.mock.invocationCallOrder[0];
      const readOrder = mockPrisma.wallet.findUnique.mock.invocationCallOrder[0];
      const writeOrder = mockPrisma.wallet.updateMany.mock.invocationCallOrder[0];
      expect(lockOrder).toBeLessThan(readOrder);
      expect(readOrder).toBeLessThan(writeOrder);
    });

    it('should throw ConflictException on optimistic lock conflict during admin escrow refund', async () => {
      mockPrisma.order.findUnique.mockResolvedValue({ ...mockOrder, status: OrderStatus.PROCESSING, buyerPayAmount: BigInt(10_150_000), buyerId: 'buyer-id' });
      mockPrisma.$transaction.mockImplementation(async (fn: (tx: typeof mockPrisma) => Promise<unknown>) => {
        mockPrisma.order.findUnique.mockResolvedValue({
          ...mockOrder,
          status: OrderStatus.PROCESSING,
          buyerPayAmount: BigInt(10_150_000),
          buyerId: 'buyer-id',
        });
        mockPrisma.wallet.findFirst.mockResolvedValue(mockBuyerWallet);
        mockPrisma.wallet.findUnique.mockResolvedValue(mockBuyerWallet);
        mockPrisma.wallet.updateMany.mockResolvedValue({ count: 0 });
        return fn(mockPrisma);
      });

      await expect(service.adminCancelOrder('ORD-001', 'admin-id', 'reason')).rejects.toThrow(ConflictException);
    });
  });
});
