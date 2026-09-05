import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OrdersService } from '../orders.service';
import { PrismaService } from '../../../prisma/prisma.service';
import { RedisService } from '../../../redis/redis.service';
import { FeeCalculatorService } from '../fee-calculator.service';
import { RealtimeService } from '../../realtime/realtime.service';
import { NotificationQueueService } from '../../queue/notification-queue.service';
import { KycStatus, FeeResponsibility, OrderStatus, OrderType } from '@prisma/client';

const mockUser = {
  id: 'user-db-1',
  userId: 'usr_abc123',
  username: 'buyer01',
  fullName: 'Buyer One',
  avatarUrl: null,
  email: 'buyer@example.com',
  isActive: true,
  isBanned: false,
  kycStatus: KycStatus.APPROVED,
  isKahadePlus: false,
  membershipRank: 'BASIC',
  averageRating: null,
  totalOrdersCompleted: 0,
  totalTransactionValue: BigInt(0),
};

const mockCounterpart = {
  id: 'user-db-2',
  userId: 'usr_xyz789',
  username: 'seller01',
  fullName: 'Seller One',
  avatarUrl: null,
  email: 'seller@example.com',
  isActive: true,
  isBanned: false,
  kycStatus: KycStatus.APPROVED,
  isKahadePlus: false,
  membershipRank: 'BASIC',
  averageRating: null,
};

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
  deliveryDeadlineAt: null,
  trackingNumber: null,
  courierName: null,
  voucherDiscount: BigInt(0),
  voucherId: null,
  createdByBuyer: true,
  confirmationDeadlineAt: new Date(Date.now() + 86400_000),
  paymentDeadlineAt: null,
  paidAt: null,
  confirmedAt: null,
  completedAt: null,
  cancelledAt: null,
  cancelReason: null,
  cancelNote: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  buyer: { userId: 'usr_abc123', username: 'buyer01', fullName: 'Buyer One', avatarUrl: null },
  seller: { userId: 'usr_xyz789', username: 'seller01', fullName: 'Seller One', avatarUrl: null },
  voucher: null,
};

const mockFeeCalculation = {
  feeRate: 1.5,
  feeAmount: BigInt(150_000),
  buyerFeeAmount: BigInt(150_000),
  sellerFeeAmount: BigInt(0),
  buyerPayAmount: BigInt(10_150_000),
  sellerReceiveAmount: BigInt(10_000_000),
  voucherDiscount: BigInt(0),
};

const mockPrisma = {
  user: { findUnique: jest.fn() },
  order: {
    findFirst: jest.fn(),
    findMany: jest.fn(),
    findUnique: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    count: jest.fn(),
    aggregate: jest.fn().mockResolvedValue({ _count: 0, _sum: { buyerPayAmount: null, sellerReceiveAmount: null } }),
  },
  blockList: { findFirst: jest.fn() },
  voucher: { findFirst: jest.fn(), findUnique: jest.fn(), updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
  voucherUsage: { count: jest.fn(), create: jest.fn() },
  chatRoom: { create: jest.fn() },
  orderStatusHistory: { findMany: jest.fn(), count: jest.fn(), create: jest.fn().mockResolvedValue({}) },
  orderExtensionRequest: { count: jest.fn().mockResolvedValue(0) },
  rating: { findUnique: jest.fn().mockResolvedValue(null) },
  notificationPreference: { findUnique: jest.fn().mockResolvedValue(null) },
  subscription: { findFirst: jest.fn().mockResolvedValue(null) },
  $queryRaw: jest.fn().mockResolvedValue([]),
  $transaction: jest.fn(),
};

const mockRedis = {
  get: jest.fn(),
  set: jest.fn(),
  setex: jest.fn(),
  del: jest.fn(),
  incr: jest.fn().mockResolvedValue(1),
  expire: jest.fn(),
  setNx: jest.fn().mockResolvedValue(true),
  releaseLock: jest.fn().mockResolvedValue(true),
  getClient: jest.fn().mockReturnValue({
    eval: jest.fn().mockResolvedValue(1),
    incr: jest.fn().mockResolvedValue(1),
    expire: jest.fn().mockResolvedValue(1),
    get: jest.fn().mockResolvedValue(null),
    set: jest.fn().mockResolvedValue('OK'),
    del: jest.fn().mockResolvedValue(1),
  }),
  getPrefix: jest.fn().mockReturnValue(''),
};

const mockFeeCalculator = {
  getFeeRate: jest.fn().mockReturnValue(1.5),
  getFeeConfig: jest.fn().mockResolvedValue({ kahadeFeeRateBps: 150, kahadePlusFeeRateBps: 50 }),
  calculateFee: jest.fn().mockReturnValue(mockFeeCalculation),
  getStandardFeeSen: jest.fn().mockReturnValue(BigInt(150_000)),
};

const mockNotificationQueue = { enqueue: jest.fn() };

/**
 * OrdersService unit tests — covers order creation, listing, detail, summary,
 * fee calculation, counterpart validation, seller processing, shipping update,
 * and order history.
 *
 * Order lifecycle state transitions (confirmOrder, rejectOrder, payOrder,
 * completeOrder, cancelOrder, adminCancelOrder) live in OrderStateService and
 * are fully covered by order-state.service.spec.ts in this same directory.
 */
describe('OrdersService', () => {
  let service: OrdersService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        OrdersService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: RedisService, useValue: mockRedis },
        { provide: FeeCalculatorService, useValue: mockFeeCalculator },
        { provide: RealtimeService, useValue: { emitToUser: jest.fn(), emitToRoom: jest.fn(), emitToOrder: jest.fn() } },
        { provide: ConfigService, useValue: { get: jest.fn().mockReturnValue(undefined) } },
        { provide: NotificationQueueService, useValue: mockNotificationQueue },
      ],
    }).compile();

    service = module.get<OrdersService>(OrdersService);
    jest.resetAllMocks();
    mockNotificationQueue.enqueue.mockResolvedValue(undefined);

    mockRedis.incr.mockResolvedValue(1);
    mockRedis.expire.mockResolvedValue(1);
    mockRedis.setNx.mockResolvedValue(true);
    mockRedis.releaseLock.mockResolvedValue(true);
    mockRedis.getClient.mockReturnValue({
      eval: jest.fn().mockResolvedValue(1),
      incr: jest.fn().mockResolvedValue(1),
      expire: jest.fn().mockResolvedValue(1),
      get: jest.fn().mockResolvedValue(null),
      set: jest.fn().mockResolvedValue('OK'),
      del: jest.fn().mockResolvedValue(1),
    });
    mockRedis.getPrefix.mockReturnValue('');
    mockPrisma.order.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.order.aggregate.mockResolvedValue({ _count: 0, _sum: { buyerPayAmount: null, sellerReceiveAmount: null } });
    mockPrisma.orderStatusHistory.create.mockResolvedValue({});
    mockPrisma.orderExtensionRequest.count.mockResolvedValue(0);
    mockPrisma.rating.findUnique.mockResolvedValue(null);
    mockPrisma.notificationPreference.findUnique.mockResolvedValue(null);
    mockPrisma.subscription.findFirst.mockResolvedValue(null);
    mockPrisma.voucher.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.$queryRaw.mockResolvedValue([]);
    mockPrisma.$transaction.mockImplementation(async (fn: unknown) => typeof fn === 'function' ? (fn as (tx: typeof mockPrisma) => Promise<unknown>)(mockPrisma) : undefined);
    mockRedis.del.mockResolvedValue(1);
    mockRedis.set.mockResolvedValue('OK');
    mockRedis.get.mockResolvedValue(null);
    mockFeeCalculator.calculateFee.mockReturnValue(mockFeeCalculation);
    mockFeeCalculator.getFeeRate.mockReturnValue(1.5);
    mockFeeCalculator.getFeeConfig.mockResolvedValue({ kahadeFeeRateBps: 150, kahadePlusFeeRateBps: 50 });
    mockFeeCalculator.getStandardFeeSen.mockReturnValue(BigInt(150_000));
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  // ─── createOrder ───────────────────────────────────────────────────────────

  describe('createOrder', () => {
    const dto = {
      role: 'BUYER' as const,
      counterpartUsername: 'seller01',
      title: 'Test Order',
      description: 'Test description',
      orderType: OrderType.PHYSICAL_GOODS,
      orderValue: 100_000,
      deliveryDeadlineDays: 7,
      feeResponsibility: FeeResponsibility.BUYER,
    };

    it('should throw NotFoundException when the requesting user does not exist', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(null);

      await expect(service.createOrder('nonexistent', dto)).rejects.toThrow(NotFoundException);
    });

    it('should throw ForbiddenException when user KYC is not APPROVED and orderValue >= 2M', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({ ...mockUser, kycStatus: KycStatus.PENDING });
      const highValueDto = { ...dto, orderValue: 2_000_000 };

      await expect(service.createOrder('user-db-1', highValueDto)).rejects.toThrow(ForbiddenException);
    });

    it('should allow non-KYC user to create order below 2M threshold', async () => {
      const nonKycUser = { ...mockUser, kycStatus: KycStatus.PENDING };
      mockPrisma.user.findUnique.mockImplementation(({ where }: { where: { id?: string; username?: string } }) => {
        if (where.username === 'seller01') return Promise.resolve(mockCounterpart);
        if (where.id === 'user-db-1') return Promise.resolve(nonKycUser);
        if (where.id === 'user-db-2') return Promise.resolve(mockCounterpart);
        return Promise.resolve(null);
      });
      mockPrisma.blockList.findFirst.mockResolvedValue(null);
      mockPrisma.$transaction.mockImplementation(async (fn: (tx: typeof mockPrisma) => Promise<unknown>) => {
        mockPrisma.order.create.mockResolvedValue(mockOrder);
        mockPrisma.chatRoom.create.mockResolvedValue({ id: 'chat-1' });
        return fn(mockPrisma);
      });
      mockPrisma.order.findFirst.mockResolvedValue(null);

      const result = await service.createOrder('user-db-1', dto) as Record<string, unknown>;
      expect(result).toHaveProperty('orderId');
    });

    it('should throw NotFoundException when counterpart username does not exist', async () => {
      mockPrisma.user.findUnique
        .mockResolvedValueOnce(mockUser)
        .mockResolvedValueOnce(null);

      await expect(service.createOrder('user-db-1', dto)).rejects.toThrow(NotFoundException);
    });

    it('should throw ForbiddenException when counterpart account is suspended', async () => {
      mockPrisma.user.findUnique
        .mockResolvedValueOnce(mockUser)
        .mockResolvedValueOnce({ ...mockCounterpart, isActive: false });

      await expect(service.createOrder('user-db-1', dto)).rejects.toThrow(ForbiddenException);
    });

    it('should throw BadRequestException when user tries to create order with themselves', async () => {
      mockPrisma.user.findUnique
        .mockResolvedValueOnce(mockUser)
        .mockResolvedValueOnce({ ...mockCounterpart, id: 'user-db-1' });

      await expect(service.createOrder('user-db-1', dto)).rejects.toThrow(BadRequestException);
    });

    it('should throw BadRequestException when there is a block between users', async () => {
      mockPrisma.user.findUnique.mockImplementation(({ where }: { where: { id?: string; username?: string } }) => {
        if (where.username === 'seller01') return Promise.resolve(mockCounterpart);
        if (where.id === 'user-db-1') return Promise.resolve(mockUser);
        if (where.id === 'user-db-2') return Promise.resolve(mockCounterpart);
        return Promise.resolve(null);
      });
      mockPrisma.blockList.findFirst.mockResolvedValue({ id: 'block-1' });

      await expect(service.createOrder('user-db-1', dto)).rejects.toThrow(BadRequestException);
    });

    it('rejects title/description that become too short after sanitization', async () => {
      await expect(service.createOrder('user-db-1', { ...dto, title: '<><>', description: '<<<<>>>>' })).rejects.toThrow(BadRequestException);
      expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    });

    it('rejects non-integer order values before fee calculation', async () => {
      await expect(service.createOrder('user-db-1', { ...dto, orderValue: 100000.5 })).rejects.toThrow(BadRequestException);
      expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    });

    it('should create order successfully without voucher', async () => {
      mockPrisma.user.findUnique.mockImplementation(({ where }: { where: { id?: string; username?: string } }) => {
        if (where.username === 'seller01') return Promise.resolve(mockCounterpart);
        if (where.id === 'user-db-1') return Promise.resolve(mockUser);
        if (where.id === 'user-db-2') return Promise.resolve(mockCounterpart);
        return Promise.resolve(null);
      });
      mockPrisma.blockList.findFirst.mockResolvedValue(null);
      mockPrisma.$transaction.mockImplementation(async (fn: (tx: typeof mockPrisma) => Promise<unknown>) => {
        mockPrisma.order.create.mockResolvedValue(mockOrder);
        mockPrisma.chatRoom.create.mockResolvedValue({ id: 'chat-1' });
        return fn(mockPrisma);
      });
      mockPrisma.order.findFirst.mockResolvedValue(null);

      const result = await service.createOrder('user-db-1', dto) as Record<string, unknown>;

      expect(result).toHaveProperty('orderId');
      expect(result).toHaveProperty('status');
      expect(result).toHaveProperty('feeCalculation');
      expect(mockPrisma.order.create).toHaveBeenCalled();
      expect(mockPrisma.chatRoom.create).toHaveBeenCalled();
      expect(mockPrisma.orderStatusHistory.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ fromStatus: null, toStatus: OrderStatus.WAITING_CONFIRMATION }) }));
    });

    it('should assign buyerId/sellerId correctly when role is BUYER', async () => {
      mockPrisma.user.findUnique.mockImplementation(({ where }: { where: { id?: string; username?: string } }) => {
        if (where.username === 'seller01') return Promise.resolve(mockCounterpart);
        if (where.id === 'user-db-1') return Promise.resolve(mockUser);
        if (where.id === 'user-db-2') return Promise.resolve(mockCounterpart);
        return Promise.resolve(null);
      });
      mockPrisma.blockList.findFirst.mockResolvedValue(null);
      mockPrisma.$transaction.mockImplementation(async (fn: (tx: typeof mockPrisma) => Promise<unknown>) => {
        mockPrisma.order.create.mockResolvedValue(mockOrder);
        mockPrisma.chatRoom.create.mockResolvedValue({ id: 'chat-1' });
        return fn(mockPrisma);
      });
      mockPrisma.order.findFirst.mockResolvedValue(null);

      await service.createOrder('user-db-1', dto);

      const createCall = mockPrisma.order.create.mock.calls[0][0].data;
      expect(createCall.buyerId).toBe('user-db-1');
      expect(createCall.sellerId).toBe('user-db-2');
    });

    it('should assign buyerId/sellerId correctly when role is SELLER', async () => {
      const sellerDto = { ...dto, role: 'SELLER' as const };
      mockPrisma.user.findUnique.mockImplementation(({ where }: { where: { id?: string; username?: string } }) => {
        if (where.username === 'seller01') return Promise.resolve(mockCounterpart);
        if (where.id === 'user-db-1') return Promise.resolve(mockUser);
        if (where.id === 'user-db-2') return Promise.resolve(mockCounterpart);
        return Promise.resolve(null);
      });
      mockPrisma.blockList.findFirst.mockResolvedValue(null);
      mockPrisma.$transaction.mockImplementation(async (fn: (tx: typeof mockPrisma) => Promise<unknown>) => {
        mockPrisma.order.create.mockResolvedValue({ ...mockOrder, buyerId: 'user-db-2', sellerId: 'user-db-1', createdByBuyer: false });
        mockPrisma.chatRoom.create.mockResolvedValue({ id: 'chat-1' });
        return fn(mockPrisma);
      });
      mockPrisma.order.findFirst.mockResolvedValue(null);

      await service.createOrder('user-db-1', sellerDto);

      const createCall = mockPrisma.order.create.mock.calls[0][0].data;
      expect(createCall.buyerId).toBe('user-db-2');
      expect(createCall.sellerId).toBe('user-db-1');
    });

    it('should throw BadRequestException when voucher usage limit is reached', async () => {
      const dtoWithVoucher = { ...dto, voucherCode: 'TESTCODE' };
      mockPrisma.user.findUnique.mockImplementation(({ where }: { where: { id?: string; username?: string } }) => {
        if (where.username === 'seller01') return Promise.resolve(mockCounterpart);
        if (where.id === 'user-db-1') return Promise.resolve(mockUser);
        if (where.id === 'user-db-2') return Promise.resolve(mockCounterpart);
        return Promise.resolve(null);
      });
      mockPrisma.blockList.findFirst.mockResolvedValue(null);
      mockPrisma.$queryRaw.mockResolvedValue([{
        id: 'voucher-1',
        code: 'TESTCODE',
        isActive: true,
        voucherType: 'FEE_DISCOUNT_PERCENT',
        discountPercent: 50,
        discountAmount: null,
        maxUsageTotal: 100,
        currentUsage: 100,
        maxUsagePerUser: null,
        validFrom: new Date(0),
        validUntil: new Date(Date.now() + 86400000),
        applicableTo: 'ALL',
        minOrderValue: null,
        maxDiscountAmount: null,
      }]);

      await expect(service.createOrder('user-db-1', dtoWithVoucher)).rejects.toThrow(BadRequestException);
    });

    it('should apply FEE_DISCOUNT_PERCENT voucher discount correctly', async () => {
      const dtoWithVoucher = { ...dto, voucherCode: 'DISC50' };
      mockPrisma.user.findUnique.mockImplementation(({ where }: { where: { id?: string; username?: string } }) => {
        if (where.username === 'seller01') return Promise.resolve(mockCounterpart);
        if (where.id === 'user-db-1') return Promise.resolve(mockUser);
        if (where.id === 'user-db-2') return Promise.resolve(mockCounterpart);
        return Promise.resolve(null);
      });
      mockPrisma.$queryRaw.mockResolvedValue([{
        id: 'voucher-1',
        code: 'DISC50',
        isActive: true,
        voucherType: 'FEE_DISCOUNT_PERCENT',
        discountPercent: 50,
        discountAmount: null,
        maxUsageTotal: null,
        currentUsage: 0,
        maxUsagePerUser: null,
        validFrom: new Date(0),
        validUntil: new Date(Date.now() + 86400000),
        applicableTo: 'ALL',
        minOrderValue: null,
        maxDiscountAmount: null,
      }]);
      mockPrisma.blockList.findFirst.mockResolvedValue(null);
      mockPrisma.voucher.findFirst.mockResolvedValue({
        id: 'voucher-1',
        code: 'DISC50',
        isActive: true,
        voucherType: 'FEE_DISCOUNT_PERCENT',
        discountPercent: 50,
        discountAmount: null,
        maxUsageTotal: null,
        currentUsage: 0,
        maxUsagePerUser: null,
      });
      mockPrisma.$transaction.mockImplementation(async (fn: (tx: typeof mockPrisma) => Promise<unknown>) => {
        mockPrisma.voucher.findUnique.mockResolvedValue({
          id: 'voucher-1',
          isActive: true,
          maxUsageTotal: null,
          currentUsage: 0,
          maxUsagePerUser: null,
        });
        mockPrisma.voucherUsage.count.mockResolvedValue(0);
        mockPrisma.voucherUsage.create.mockResolvedValue({});
        mockPrisma.voucher.updateMany.mockResolvedValue({ count: 1 });
        mockPrisma.order.create.mockResolvedValue(mockOrder);
        mockPrisma.chatRoom.create.mockResolvedValue({ id: 'chat-1' });
        return fn(mockPrisma);
      });
      mockPrisma.order.findFirst.mockResolvedValue(null);

      const result = await service.createOrder('user-db-1', dtoWithVoucher) as Record<string, unknown>;

      expect(result).toHaveProperty('orderId');
      expect(mockFeeCalculator.calculateFee).toHaveBeenCalledWith(
        expect.objectContaining({ voucherDiscountSen: expect.any(BigInt) }),
        expect.objectContaining({ kahadeFeeRateBps: expect.any(Number) }),
      );
    });

    it('should allow a voucher with per-user limit when no locked usage row exists', async () => {
      const dtoWithVoucher = { ...dto, voucherCode: 'ONCEONLY' };
      mockPrisma.user.findUnique.mockImplementation(({ where }: { where: { id?: string; username?: string } }) => {
        if (where.username === 'seller01') return Promise.resolve(mockCounterpart);
        if (where.id === 'user-db-1') return Promise.resolve(mockUser);
        if (where.id === 'user-db-2') return Promise.resolve(mockCounterpart);
        return Promise.resolve(null);
      });
      mockPrisma.blockList.findFirst.mockResolvedValue(null);
      mockPrisma.$queryRaw
        .mockResolvedValueOnce([{
          id: 'voucher-1', code: 'ONCEONLY', isActive: true,
          voucherType: 'FEE_DISCOUNT_AMOUNT', discountPercent: null, discountAmount: BigInt(1000),
          maxUsageTotal: null, currentUsage: 0, maxUsagePerUser: 1,
          validFrom: new Date(0), validUntil: new Date(Date.now() + 86400000),
          applicableTo: 'ALL', minOrderValue: null, maxDiscountAmount: null,
        }])
        .mockResolvedValueOnce([]);
      mockPrisma.$transaction.mockImplementation(async (fn: (tx: typeof mockPrisma) => Promise<unknown>) => {
        mockPrisma.voucherUsage.create.mockResolvedValue({});
        mockPrisma.voucher.updateMany.mockResolvedValue({ count: 1 });
        mockPrisma.order.create.mockResolvedValue(mockOrder);
        mockPrisma.chatRoom.create.mockResolvedValue({ id: 'chat-1' });
        return fn(mockPrisma);
      });
      mockPrisma.order.findFirst.mockResolvedValue(null);

      await expect(service.createOrder('user-db-1', dtoWithVoucher)).resolves.toHaveProperty('orderId');
      expect(mockPrisma.voucherUsage.create).toHaveBeenCalled();
    });
  });

  // ─── getOrders ─────────────────────────────────────────────────────────────

  describe('getOrders', () => {
    it('should return paginated orders for a user', async () => {
      const ordersWithRelations = [
        { ...mockOrder, buyer: { username: 'buyer01', fullName: 'Buyer One', avatarUrl: null }, seller: { username: 'seller01', fullName: 'Seller One', avatarUrl: null } },
      ];
      mockPrisma.order.findMany.mockResolvedValue(ordersWithRelations);
      mockPrisma.order.count.mockResolvedValue(1);

      const result = await service.getOrders('user-db-1', 1, 10) as Record<string, unknown>;

      expect(result).toHaveProperty('orders');
      expect(result).toHaveProperty('total', 1);
      expect(result).toHaveProperty('page', 1);
      expect(result).toHaveProperty('limit', 10);
    });

    it('should filter by BUYER role — only include orders where user is buyer', async () => {
      mockPrisma.order.findMany.mockResolvedValue([]);
      mockPrisma.order.count.mockResolvedValue(0);

      await service.getOrders('user-db-1', 1, 10, undefined, 'BUYER');

      const findManyCall = mockPrisma.order.findMany.mock.calls[0][0];
      expect(findManyCall.where.OR).toEqual(expect.arrayContaining([{ buyerId: 'user-db-1' }]));
      expect(findManyCall.where.OR).toHaveLength(1);
    });

    it('should filter by SELLER role — only include orders where user is seller', async () => {
      mockPrisma.order.findMany.mockResolvedValue([]);
      mockPrisma.order.count.mockResolvedValue(0);

      await service.getOrders('user-db-1', 1, 10, undefined, 'SELLER');

      const findManyCall = mockPrisma.order.findMany.mock.calls[0][0];
      expect(findManyCall.where.OR).toEqual(expect.arrayContaining([{ sellerId: 'user-db-1' }]));
    });

    it('rejects an invalid status filter instead of returning unfiltered orders', async () => {
      await expect(service.getOrders('user-db-1', 1, 10, 'NOT_A_STATUS' as OrderStatus)).rejects.toThrow(BadRequestException);
      expect(mockPrisma.order.findMany).not.toHaveBeenCalled();
    });

    it('should filter by status when provided', async () => {
      mockPrisma.order.findMany.mockResolvedValue([]);
      mockPrisma.order.count.mockResolvedValue(0);

      await service.getOrders('user-db-1', 1, 10, OrderStatus.PROCESSING);

      const findManyCall = mockPrisma.order.findMany.mock.calls[0][0];
      expect(findManyCall.where.status).toBe(OrderStatus.PROCESSING);
    });

    it('should cap limit at 100 to prevent oversized queries', async () => {
      mockPrisma.order.findMany.mockResolvedValue([]);
      mockPrisma.order.count.mockResolvedValue(0);

      const result = await service.getOrders('user-db-1', 1, 999) as Record<string, unknown>;

      expect(result.limit).toBe(100);
    });

    it('should convert BigInt amounts to numbers divided by 100', async () => {
      const ordersWithRelations = [
        {
          ...mockOrder,
          orderValue: BigInt(10_000_000),
          buyerPayAmount: BigInt(10_150_000),
          sellerReceiveAmount: BigInt(10_000_000),
          buyer: { userId: 'usr_abc123', username: 'buyer01', fullName: 'Buyer One', avatarUrl: null },
          seller: { userId: 'usr_xyz789', username: 'seller01', fullName: 'Seller One', avatarUrl: null },
        },
      ];
      mockPrisma.order.findMany.mockResolvedValue(ordersWithRelations);
      mockPrisma.order.count.mockResolvedValue(1);

      const result = await service.getOrders('user-db-1', 1, 10) as Record<string, unknown>;
      const orders = result.orders as Record<string, unknown>[];

      expect(orders[0].orderValue).toBe(100_000);
      expect(orders[0].buyerPayAmount).toBe(101_500);
      expect(orders[0].sellerReceiveAmount).toBe(100_000);
      expect(orders[0].role).toBe('BUYER');
      expect(orders[0].buyer).toMatchObject({ userId: 'usr_abc123', username: 'buyer01', fullName: 'Buyer One' });
      expect(orders[0].seller).toMatchObject({ userId: 'usr_xyz789', username: 'seller01', fullName: 'Seller One' });
    });
  });

  // ─── getOrderDetail ────────────────────────────────────────────────────────

  describe('getOrderDetail', () => {
    it('should return order detail for participant (buyer)', async () => {
      mockPrisma.order.findFirst.mockResolvedValue(mockOrder);

      const result = await service.getOrderDetail('user-db-1', 'ORD-20260101-001') as Record<string, unknown>;

      expect(result).toHaveProperty('order');
      const order = result.order as Record<string, unknown>;
      expect(order).toHaveProperty('orderId', 'ORD-20260101-001');
      expect(order.buyer).toMatchObject({ userId: 'usr_abc123', username: 'buyer01', fullName: 'Buyer One', avatarUrl: null });
      expect(order.seller).toMatchObject({ userId: 'usr_xyz789', username: 'seller01', fullName: 'Seller One', avatarUrl: null });
    });

    it('should throw NotFoundException when order does not exist', async () => {
      mockPrisma.order.findFirst.mockResolvedValue(null);

      await expect(
        service.getOrderDetail('user-db-1', 'ORD-INVALID'),
      ).rejects.toThrow(NotFoundException);
    });

    it('should throw ForbiddenException when user is not a participant', async () => {
      mockPrisma.order.findFirst.mockResolvedValue(mockOrder);

      await expect(
        service.getOrderDetail('user-db-999', 'ORD-20260101-001'),
      ).rejects.toThrow(ForbiddenException);
    });

    it('should allow seller to view their own order', async () => {
      mockPrisma.order.findFirst.mockResolvedValue(mockOrder);

      const result = await service.getOrderDetail('user-db-2', 'ORD-20260101-001') as Record<string, unknown>;

      expect(result).toHaveProperty('order');
    });
  });

  // ─── getOrderSummary ───────────────────────────────────────────────────────

  describe('getOrderSummary', () => {
    it('should return summary with buyer and seller counts', async () => {
      mockPrisma.order.aggregate
        .mockResolvedValueOnce({ _count: 2, _sum: { buyerPayAmount: BigInt(1_500_000) } })
        .mockResolvedValueOnce({ _count: 1, _sum: { sellerReceiveAmount: BigInt(900_000) } });
      mockPrisma.order.count.mockResolvedValue(2);
      mockPrisma.orderExtensionRequest.count.mockResolvedValue(1);

      const result = await service.getOrderSummary('user-db-1');

      expect(result).toHaveProperty('asBuyer');
      expect(result).toHaveProperty('asSeller');
      expect(result).toHaveProperty('inDispute', 2);
      expect(result).toHaveProperty('pendingExtensions', 1);
      expect(result.asBuyer.count).toBe(2);
      expect(result.asSeller.count).toBe(1);
    });

    it('should return zero totals when user has no orders', async () => {
      mockPrisma.order.findMany.mockResolvedValue([]).mockResolvedValue([]);
      mockPrisma.order.count.mockResolvedValue(0);
      mockPrisma.orderExtensionRequest.count.mockResolvedValue(0);

      const result = await service.getOrderSummary('user-db-1');

      expect(result.asBuyer.count).toBe(0);
      expect(result.asBuyer.totalValue).toBe(0);
    });

    it('should sum BigInt amounts correctly and convert to IDR', async () => {
      mockPrisma.order.aggregate
        .mockResolvedValueOnce({ _count: 1, _sum: { buyerPayAmount: BigInt(200_000) } })
        .mockResolvedValueOnce({ _count: 0, _sum: { sellerReceiveAmount: BigInt(0) } });
      mockPrisma.order.count.mockResolvedValue(0);
      mockPrisma.orderExtensionRequest.count.mockResolvedValue(0);

      const result = await service.getOrderSummary('user-db-1');

      // 200_000 sen / 100 = 2_000 IDR
      expect(result.asBuyer.totalValue).toBe(2_000);
    });
  });

  // ─── calculateFee ──────────────────────────────────────────────────────────

  describe('calculateFee', () => {
    it('should throw NotFoundException when user not found', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(null);

      await expect(
        service.calculateFee({ orderValue: 100_000, feeResponsibility: FeeResponsibility.BUYER }, 'nonexistent'),
      ).rejects.toThrow(NotFoundException);
    });

    it('should return fee calculation for a valid user', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(mockUser);

      const result = await service.calculateFee(
        { orderValue: 100_000, feeResponsibility: FeeResponsibility.BUYER },
        'user-db-1',
      );

      expect(result).toHaveProperty('feeRate');
      expect(result).toHaveProperty('feeAmount');
      expect(result).toHaveProperty('buyerFeeAmount');
      expect(result).toHaveProperty('sellerFeeAmount');
      expect(result).toHaveProperty('isKahadePlusApplied', false);
    });

    it('should pass isKahadePlus flag from user to fee calculator', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({ ...mockUser, isKahadePlus: true });
      mockPrisma.subscription.findFirst.mockResolvedValue({
        id: 'sub-1',
        feeSavingsUsed: BigInt(0),
        feeSavingsLimit: BigInt(500_000_000),
      });

      await service.calculateFee(
        { orderValue: 100_000, feeResponsibility: FeeResponsibility.BUYER },
        'user-db-1',
      );

      expect(mockFeeCalculator.calculateFee).toHaveBeenCalledWith(
        expect.objectContaining({ isKahadePlus: true }),
        expect.objectContaining({ kahadeFeeRateBps: expect.any(Number) }),
      );
    });

    it('should throw BadRequestException when voucher usage limit is reached during fee calculation', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(mockUser);
      mockPrisma.voucher.findFirst.mockResolvedValue({
        id: 'voucher-1',
        isActive: true,
        voucherType: 'FEE_DISCOUNT_PERCENT',
        discountPercent: 50,
        discountAmount: null,
        maxUsageTotal: 10,
        currentUsage: 10,
        maxUsagePerUser: null,
      });

      await expect(
        service.calculateFee(
          { orderValue: 100_000, feeResponsibility: FeeResponsibility.BUYER, voucherCode: 'FULL' },
          'user-db-1',
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it('should return fee without voucher discount when voucher not found', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(mockUser);
      mockPrisma.voucher.findFirst.mockResolvedValue(null);

      const result = await service.calculateFee(
        { orderValue: 100_000, feeResponsibility: FeeResponsibility.BUYER, voucherCode: 'NOTEXIST' },
        'user-db-1',
      );

      expect(result).toHaveProperty('feeRate');
      expect(mockFeeCalculator.calculateFee).toHaveBeenCalledWith(
        expect.objectContaining({ voucherDiscountSen: BigInt(0) }),
        expect.objectContaining({ kahadeFeeRateBps: expect.any(Number) }),
      );
    });
  });

  // ─── validateCounterpart ───────────────────────────────────────────────────

  describe('validateCounterpart', () => {
    it('should return null user when counterpart not found', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(null);

      const result = await service.validateCounterpart('user-db-1', 'nonexistent');

      expect(result.user).toBeNull();
      expect(result.canCreateOrder).toBe(false);
      expect(result.reason).toBe('USER_NOT_FOUND');
    });

    it('should throw BadRequestException when validating self as counterpart', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({ ...mockCounterpart, id: 'user-db-1', wallet: null });

      await expect(
        service.validateCounterpart('user-db-1', 'seller01'),
      ).rejects.toThrow(BadRequestException);
    });

    it('should return isBlocked: true when there is a block', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({ ...mockCounterpart, wallet: null });
      mockPrisma.blockList.findFirst.mockResolvedValue({ id: 'block-1' });

      const result = await service.validateCounterpart('user-db-1', 'seller01');

      expect(result.isBlocked).toBe(true);
      expect(result.canCreateOrder).toBe(false);
    });

    it('should return canCreateOrder: true for a valid, unblocked, KYC-approved counterpart', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({ ...mockCounterpart, wallet: null });
      mockPrisma.blockList.findFirst.mockResolvedValue(null);

      const result = await service.validateCounterpart('user-db-1', 'seller01');

      expect(result.canCreateOrder).toBe(true);
      expect(result.isBlocked).toBe(false);
      expect(result.user).not.toBeNull();
    });

    it('should return canCreateOrder: false when counterpart is banned', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({ ...mockCounterpart, isBanned: true, wallet: null });
      mockPrisma.blockList.findFirst.mockResolvedValue(null);

      const result = await service.validateCounterpart('user-db-1', 'seller01');

      expect(result.canCreateOrder).toBe(false);
    });
  });

  // ─── processOrder ──────────────────────────────────────────────────────────

  describe('processOrder', () => {
    it('should throw NotFoundException when order does not exist', async () => {
      mockPrisma.$transaction.mockImplementation(async (fn: (tx: typeof mockPrisma) => Promise<unknown>) => {
        mockPrisma.order.findFirst.mockResolvedValue(null);
        mockPrisma.order.findUnique.mockResolvedValue(null);
        return fn(mockPrisma);
      });

      await expect(service.processOrder('ORD-NOTFOUND', 'user-db-2')).rejects.toThrow();
    });

    it('should throw ForbiddenException when seller is not the order seller', async () => {
      mockPrisma.$transaction.mockImplementation(async (fn: (tx: typeof mockPrisma) => Promise<unknown>) => {
        mockPrisma.order.findFirst.mockResolvedValue(null);
        mockPrisma.order.findUnique.mockResolvedValue({ ...mockOrder, id: 'order-internal-1' });
        return fn(mockPrisma);
      });

      await expect(service.processOrder('ORD-20260101-001', 'user-db-999')).rejects.toThrow();
    });

    it('should throw BadRequestException when order is not in PROCESSING status', async () => {
      mockPrisma.$transaction.mockImplementation(async (fn: (tx: typeof mockPrisma) => Promise<unknown>) => {
        mockPrisma.order.findFirst.mockResolvedValue({ ...mockOrder, status: OrderStatus.WAITING_PAYMENT, sellerId: 'user-db-2' });
        return fn(mockPrisma);
      });

      await expect(service.processOrder('ORD-20260101-001', 'user-db-2')).rejects.toThrow();
    });

    it('should throw BadRequestException when tracking number is missing', async () => {
      mockPrisma.$transaction.mockImplementation(async (fn: (tx: typeof mockPrisma) => Promise<unknown>) => {
        mockPrisma.order.findFirst.mockResolvedValue({ ...mockOrder, status: OrderStatus.PROCESSING, sellerId: 'user-db-2', trackingNumber: null });
        return fn(mockPrisma);
      });

      await expect(service.processOrder('ORD-20260101-001', 'user-db-2')).rejects.toThrow(BadRequestException);
    });

    it('should allow SERVICE orders to enter delivery without a tracking number', async () => {
      mockPrisma.$transaction.mockImplementation(async (fn: (tx: typeof mockPrisma) => Promise<unknown>) => {
        mockPrisma.order.findFirst.mockResolvedValue({
          ...mockOrder,
          orderType: OrderType.SERVICE,
          status: OrderStatus.PROCESSING,
          sellerId: 'user-db-2',
          trackingNumber: null,
          id: 'order-internal-1',
        });
        mockPrisma.order.updateMany.mockResolvedValue({ count: 1 });
        mockPrisma.orderStatusHistory.create.mockResolvedValue({});
        return fn(mockPrisma);
      });

      const result = await service.processOrder('ORD-20260101-001', 'user-db-2');

      expect(result.status).toBe('IN_DELIVERY');
      expect(mockNotificationQueue.enqueue).toHaveBeenCalledWith(expect.objectContaining({ type: 'ORDER_DELIVERED' }));
    });

        it('should return IN_DELIVERY status on success', async () => {
      mockPrisma.$transaction.mockImplementation(async (fn: (tx: typeof mockPrisma) => Promise<unknown>) => {
        mockPrisma.order.findFirst.mockResolvedValue({
          ...mockOrder,
          status: OrderStatus.PROCESSING,
          sellerId: 'user-db-2',
          trackingNumber: 'JNE1234567',
          courierName: 'JNE',
          id: 'order-internal-1',
        });
        mockPrisma.order.update.mockResolvedValue({});
        mockPrisma.orderStatusHistory.create.mockResolvedValue({});
        return fn(mockPrisma);
      });
      const result = await service.processOrder('ORD-20260101-001', 'user-db-2');
      expect(result.status).toBe('IN_DELIVERY');
    });
    it('does not mask a committed process transition when notification enqueue fails', async () => {
      mockNotificationQueue.enqueue.mockRejectedValueOnce(new Error('queue unavailable'));
      mockPrisma.$transaction.mockImplementation(async (fn: (tx: typeof mockPrisma) => Promise<unknown>) => {
        mockPrisma.order.findFirst.mockResolvedValue({
          ...mockOrder,
          status: OrderStatus.PROCESSING,
          sellerId: 'user-db-2',
          trackingNumber: 'JNE1234567',
          courierName: 'JNE',
          id: 'order-internal-1',
        });
        mockPrisma.order.updateMany.mockResolvedValue({ count: 1 });
        return fn(mockPrisma);
      });

      await expect(service.processOrder('ORD-20260101-001', 'user-db-2')).resolves.toMatchObject({ status: 'IN_DELIVERY' });
      expect(mockPrisma.order.updateMany).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({
          processedAt: expect.any(Date),
          deliveryDeadlineAt: expect.any(Date),
        }),
      }));
    });
  });

  // ─── updateShipping ────────────────────────────────────────────────────────

  describe('updateShipping', () => {
    const shippingDto = { trackingNumber: 'JNE1234567', courierName: 'JNE' };

    it('should throw NotFoundException when order does not exist', async () => {
      mockPrisma.order.findUnique.mockResolvedValue(null);

      await expect(
        service.updateShipping('ORD-NOTFOUND', 'user-db-2', shippingDto),
      ).rejects.toThrow(NotFoundException);
    });

    it('should throw ForbiddenException when user is not the seller', async () => {
      mockPrisma.order.findUnique.mockResolvedValue({ ...mockOrder, status: OrderStatus.PROCESSING, sellerId: 'user-db-2' });

      await expect(
        service.updateShipping('ORD-20260101-001', 'user-db-999', shippingDto),
      ).rejects.toThrow(ForbiddenException);
    });

    it('should throw BadRequestException for invalid order status', async () => {
      mockPrisma.order.findUnique.mockResolvedValue({
        ...mockOrder,
        status: OrderStatus.COMPLETED,
        sellerId: 'user-db-2',
      });

      await expect(
        service.updateShipping('ORD-20260101-001', 'user-db-2', shippingDto),
      ).rejects.toThrow(BadRequestException);
    });

    it('should update shipping info successfully for PROCESSING order', async () => {
      mockPrisma.order.findUnique.mockResolvedValue({ ...mockOrder, status: OrderStatus.PROCESSING, sellerId: 'user-db-2', id: 'order-internal-1' });
      mockPrisma.order.update.mockResolvedValue({});

      const result = await service.updateShipping('ORD-20260101-001', 'user-db-2', shippingDto);

      expect(result.trackingNumber).toBe('JNE1234567');
      expect(result.courierName).toBe('JNE');
      expect(mockPrisma.order.updateMany).toHaveBeenCalled();
    });

        it('should update shipping info successfully for IN_DELIVERY order', async () => {
      mockPrisma.order.findUnique.mockResolvedValue({ ...mockOrder, status: OrderStatus.IN_DELIVERY, sellerId: 'user-db-2', id: 'order-internal-1' });
      mockPrisma.order.update.mockResolvedValue({});
      const result = await service.updateShipping('ORD-20260101-001', 'user-db-2', shippingDto);
      expect(result).toHaveProperty('orderId');
    });
    it('should allow non-physical orders to save notes without tracking fields and record an audit event', async () => {
      mockPrisma.order.findUnique.mockResolvedValue({
        ...mockOrder,
        orderType: OrderType.SERVICE,
        status: OrderStatus.PROCESSING,
        sellerId: 'user-db-2',
        trackingNumber: null,
        courierName: null,
        id: 'order-internal-1',
      });
      const result = await service.updateShipping('ORD-20260101-001', 'user-db-2', { trackingNotes: 'Layanan sudah siap ditinjau.' });
      expect(result).toMatchObject({ orderId: 'ORD-20260101-001', trackingNumber: null, courierName: null });
      expect(mockPrisma.orderStatusHistory.create).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({ fromStatus: OrderStatus.PROCESSING, toStatus: OrderStatus.PROCESSING, reason: 'SHIPPING_DETAILS_UPDATED' }),
      }));
    });
  });

  // ─── getOrderHistory ───────────────────────────────────────────────────────

  describe('getOrderHistory', () => {
    it('should throw NotFoundException when order does not exist', async () => {
      mockPrisma.order.findUnique.mockResolvedValue(null);

      await expect(
        service.getOrderHistory('ORD-NOTFOUND', 'user-db-1'),
      ).rejects.toThrow(NotFoundException);
    });

    it('should throw ForbiddenException when user is not a participant', async () => {
      mockPrisma.order.findUnique.mockResolvedValue(mockOrder);

      await expect(
        service.getOrderHistory('ORD-20260101-001', 'user-db-999'),
      ).rejects.toThrow(ForbiddenException);
    });

    it('should return paginated history for buyer', async () => {
      mockPrisma.order.findUnique.mockResolvedValue(mockOrder);
      mockPrisma.orderStatusHistory.findMany.mockResolvedValue([
        {
          id: 'hist-1',
          orderId: 'order-internal-1',
          fromStatus: OrderStatus.WAITING_CONFIRMATION,
          toStatus: OrderStatus.WAITING_PAYMENT,
          changedBy: 'user-db-2',
          changedByType: 'SELLER',
          createdAt: new Date(),
        },
      ]);
      mockPrisma.orderStatusHistory.count.mockResolvedValue(1);

      const result = await service.getOrderHistory('ORD-20260101-001', 'user-db-1');

      expect(result).toHaveProperty('data');
      expect(result).toHaveProperty('total', 1);
      expect(result).toHaveProperty('page', 1);
      expect(result).toHaveProperty('totalPages', 1);
    });

    it('should strip internal database id from history records', async () => {
      mockPrisma.order.findUnique.mockResolvedValue(mockOrder);
      mockPrisma.orderStatusHistory.findMany.mockResolvedValue([
        {
          id: 'internal-id-should-be-stripped',
          orderId: 'order-internal-1',
          fromStatus: OrderStatus.WAITING_CONFIRMATION,
          toStatus: OrderStatus.WAITING_PAYMENT,
          changedBy: 'user-db-2',
          changedByType: 'SELLER',
          createdAt: new Date(),
        },
      ]);
      mockPrisma.orderStatusHistory.count.mockResolvedValue(1);

      const result = await service.getOrderHistory('ORD-20260101-001', 'user-db-1');
      const record = result.data[0] as Record<string, unknown>;

      expect(record).not.toHaveProperty('id');
    });

    it('should cap limit at 100', async () => {
      mockPrisma.order.findUnique.mockResolvedValue(mockOrder);
      mockPrisma.orderStatusHistory.findMany.mockResolvedValue([]);
      mockPrisma.orderStatusHistory.count.mockResolvedValue(0);

      const result = await service.getOrderHistory('ORD-20260101-001', 'user-db-1', 1, 999);

      expect(result.limit).toBe(100);
    });
  });
});
