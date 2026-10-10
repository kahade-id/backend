import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OrdersService } from '../orders.service';
import { orderTypeToCategory } from '../orders.service';
import { CreateOrderDto } from '../dto/create-order.dto';
import { PrismaService } from '../../../prisma/prisma.service';
import { RedisService } from '../../../redis/redis.service';
import { FeeCalculatorService } from '../fee-calculator.service';
import { RealtimeService } from '../../realtime/realtime.service';
import { NotificationQueueService } from '../../queue/notification-queue.service';
import { SubscriptionsService } from '../../subscriptions/subscriptions.service';
import { KycStatus, FeeResponsibility, OrderStatus, OrderType, OrderKind, FulfillmentType, ParticipantMode, OrderCategory } from '@prisma/client';

// TRX-009: pii.util di-mock agar decryptPiiSafe deterministik (ciphertext
// "enc(x)" -> "enc(x)" apa adanya; pola sama seperti admin-users.service.spec).
// CATATAN: jest.resetAllMocks() di beforeEach menghapus implementasi ini —
// dipasang ulang di beforeEach (lihat di bawah).
jest.mock('../../../common/utils/pii.util', () => ({
  decryptPiiSafe: jest.fn(async (value: string | null) => value ?? null),
  encryptPii: jest.fn(async (value: string) => value),
}));
// Catatan: jest.mock di-hoist, jadi import ini menerima versi mock (bukan
// implementasi asli) — dipakai untuk memasang ulang implementasi setelah
// jest.resetAllMocks() di beforeEach.
import { decryptPiiSafe, encryptPii } from '../../../common/utils/pii.util';

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

// TRX-009: alamat milik user-db-1 di buku alamat (kolom terenkripsi di DB).
const mockAddress = {
  id: 'addr-1',
  userId: 'user-db-1',
  label: 'RUMAH',
  customLabel: null,
  recipientName: 'enc(recipient)',
  phone: 'enc(phone)',
  addressLine: 'enc(line)',
  city: 'enc(city)',
  province: 'enc(province)',
  postalCode: 'enc(postal)',
  isDefault: true,
  deletedAt: null,
};

const mockFeeCalculation = {
  feeRate: 1.5,
  feeAmount: BigInt(150_000),
  buyerFeeAmount: BigInt(150_000),
  sellerFeeAmount: BigInt(0),
  buyerPayAmount: BigInt(10_150_000),
  sellerReceiveAmount: BigInt(10_000_000),
  voucherDiscount: BigInt(0),
  membershipRankDiscount: BigInt(0),
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
  // TRX-009: buku alamat untuk validasi alamat pengiriman order fisik.
  address: { findFirst: jest.fn() },
  voucher: { findFirst: jest.fn(), findUnique: jest.fn(), updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
  voucherUsage: { count: jest.fn(), create: jest.fn() },
  chatRoom: { create: jest.fn() },
  orderStatusHistory: { findMany: jest.fn(), count: jest.fn(), create: jest.fn().mockResolvedValue({}) },
  orderExtensionRequest: { count: jest.fn().mockResolvedValue(0) },
  rating: { findUnique: jest.fn().mockResolvedValue(null) },
  notificationPreference: { findUnique: jest.fn().mockResolvedValue(null) },
  subscription: { findFirst: jest.fn().mockResolvedValue(null) },
  campaign: { findUnique: jest.fn().mockResolvedValue({ status: 'ACTIVE' }), updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
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
  // TX-UNIFIED-V2 (2026-10-06): orderTypeToCategory mapping.
  describe('orderTypeToCategory', () => {
    it('maps PHYSICAL_GOODS to FISIK', () => {
      expect(orderTypeToCategory(OrderType.PHYSICAL_GOODS)).toBe(OrderCategory.FISIK);
    });
    it('maps DIGITAL_GOODS to DIGITAL', () => {
      expect(orderTypeToCategory(OrderType.DIGITAL_GOODS)).toBe(OrderCategory.DIGITAL);
    });
    it('maps SERVICE to JASA', () => {
      expect(orderTypeToCategory(OrderType.SERVICE)).toBe(OrderCategory.JASA);
    });
    it('maps OTHER to FISIK (safe default, no LAINNYA category)', () => {
      expect(orderTypeToCategory(OrderType.OTHER)).toBe(OrderCategory.FISIK);
    });
  });

  let service: OrdersService;
  let subscriptionsMock: {
    waiveFeeIfEligible: jest.Mock;
    estimateWaiverAmount: jest.Mock;
    isActive: jest.Mock;
    getMaxShowcaseImages: jest.Mock;
  };

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
        // Kahade+ (tim subscriptions): Benefit 1 (fee waiver) terintegrasi di
        // titik kalkulasi fee createOrder — mock pass-through (tanpa waiver)
        // agar ekspektasi fee lama tetap valid.
        {
          provide: SubscriptionsService,
          useValue: {
            isActive: jest.fn().mockResolvedValue(false),
            getMaxShowcaseImages: jest.fn().mockResolvedValue(8),
            waiveFeeIfEligible: jest.fn().mockImplementation(async (_userId: string, fee: bigint) => fee),
            estimateWaiverAmount: jest.fn().mockResolvedValue(BigInt(0)),
          },
        },
      ],
    }).compile();

    service = module.get<OrdersService>(OrdersService);
    jest.resetAllMocks();
    // resetAllMocks menghapus mockImplementation inline di atas — pasang ulang
    // default mock Kahade+ (pass-through tanpa waiver agar ekspektasi fee lama
    // tetap valid; test waiver spesifik meng-override per-test).
    // TRX-009: resetAllMocks juga menghapus implementasi mock pii.util di atas —
    // pasang ulang agar decryptPiiSafe deterministik (identity) di semua test.
    (decryptPiiSafe as unknown as jest.Mock).mockImplementation(
      async (value: string | null | undefined) => value ?? null,
    );
    (encryptPii as unknown as jest.Mock).mockImplementation(async (value: string) => value);
    const subscriptionsMockLocal = module.get(SubscriptionsService) as unknown as typeof subscriptionsMock;
    subscriptionsMock = subscriptionsMockLocal;
    subscriptionsMock.waiveFeeIfEligible.mockImplementation(async (_userId: string, fee: bigint) => fee);
    subscriptionsMock.estimateWaiverAmount.mockResolvedValue(BigInt(0));
    subscriptionsMock.isActive.mockResolvedValue(false);
    subscriptionsMock.getMaxShowcaseImages.mockResolvedValue(8);
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
    mockPrisma.campaign.findUnique.mockResolvedValue({ status: 'ACTIVE' });
    mockPrisma.campaign.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.voucher.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.$queryRaw.mockResolvedValue([]);
    // TRX-009: resetAllMocks juga menghapus implementasi mock pii.util di
    // atas — pasang ulang agar decryptPiiSafe deterministik per test.
    (decryptPiiSafe as unknown as jest.Mock).mockImplementation(async (value: string | null) => value ?? null);
    (encryptPii as unknown as jest.Mock).mockImplementation(async (value: string) => value);
    // TRX-009: default — alamat milik user-db-1 ditemukan di buku alamat.
    mockPrisma.address.findFirst.mockResolvedValue(mockAddress);
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
    // T3: diketik sebagai CreateOrderDto agar deliveryDeadlineAt opsional bisa dipakai.
    const dto: CreateOrderDto = {
      role: 'BUYER' as const,
      counterpartUsername: 'seller01',
      title: 'Test Order',
      description: 'Test description',
      orderType: OrderType.PHYSICAL_GOODS,
      orderValue: 100_000,
      deliveryDeadlineDays: 7,
      feeResponsibility: FeeResponsibility.BUYER,
      // TRX-009: order fisik wajib menyertakan alamat pengiriman.
      shippingAddressId: 'addr-1',
    };

    it('should throw NotFoundException when the requesting user does not exist', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(null);

      await expect(service.createOrder('nonexistent', dto)).rejects.toThrow(NotFoundException);
    });

    it('should throw ForbiddenException when user KYC is not APPROVED and orderValue > 2M', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({ ...mockUser, kycStatus: KycStatus.PENDING });
      const highValueDto = { ...dto, orderValue: 2_500_000 };

      await expect(service.createOrder('user-db-1', highValueDto)).rejects.toThrow(ForbiddenException);
    });

    it('should NOT require KYC when orderValue equals exactly 2M (policy: above 2M only)', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({ ...mockUser, kycStatus: KycStatus.PENDING });
      const boundaryDto = { ...dto, orderValue: 2_000_000 };

      // Gate KYC dilewati (sama-sama user, tapi itu justru bukti gate lolos —
      // gagal dengan CANNOT_ORDER_SELF, bukan KYC_REQUIRED).
      await expect(service.createOrder('user-db-1', boundaryDto)).rejects.toMatchObject({
        response: expect.objectContaining({ code: 'CANNOT_ORDER_SELF' }),
      });
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

    it('rejects an invalid deliveryDeadlineAt before hitting the transaction (T3 audit 2026-09-26)', async () => {
      await expect(service.createOrder('user-db-1', { ...dto, deliveryDeadlineAt: 'not-a-date' })).rejects.toThrow(BadRequestException);
      expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    });

    it('rejects a deliveryDeadlineAt in the past and beyond the 14-day cap (T3 audit 2026-09-26)', async () => {
      await expect(service.createOrder('user-db-1', { ...dto, deliveryDeadlineAt: new Date(Date.now() - 1000).toISOString() })).rejects.toThrow(BadRequestException);
      const farFuture = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
      await expect(service.createOrder('user-db-1', { ...dto, deliveryDeadlineAt: farFuture })).rejects.toThrow(BadRequestException);
      expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    });

    // TX-AUDIT2 (P2): toleransi "besok" — frontend mengirim tengah hari lokal.
    it('accepts deliveryDeadlineAt "tomorrow" sent as local noon (TX-AUDIT2 P2)', async () => {
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

      // "Besok" jam 12:00 siang waktu lokal — seperti yang dikirim DateField frontend.
      const tomorrowNoon = new Date();
      tomorrowNoon.setDate(tomorrowNoon.getDate() + 1);
      tomorrowNoon.setHours(12, 0, 0, 0);
      await service.createOrder('user-db-1', { ...dto, deliveryDeadlineAt: tomorrowNoon.toISOString() });

      expect(mockPrisma.$transaction).toHaveBeenCalled();
      const createCall = mockPrisma.order.create.mock.calls[0][0].data;
      expect(createCall.deliveryDeadlineAt).toEqual(tomorrowNoon);
    });

    // TX-AUDIT2 (P0-A): field kategori frontend tidak ditolak & tersimpan.
    it('stores category detail fields from frontend payload (TX-AUDIT2 P0-A)', async () => {
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

      const tomorrow = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      await service.createOrder('user-db-1', {
        ...dto,
        category: OrderCategory.JASA,
        fulfillment: FulfillmentType.BIASA,
        participantMode: ParticipantMode.SINGLE,
        scheduledDate: tomorrow,
        deliverables: 'Desain logo + brand guideline',
        serviceLocation: 'Jakarta Selatan',
        cancellationPolicy: 'H-3 full refund',
      });

      const createCall = mockPrisma.order.create.mock.calls[0][0].data;
      expect(createCall.category).toBe(OrderCategory.JASA);
      expect(createCall.scheduledDate).toBeInstanceOf(Date);
      expect(createCall.deliverables).toBe('Desain logo + brand guideline');
      expect(createCall.serviceLocation).toBe('Jakarta Selatan');
      expect(createCall.cancellationPolicy).toBe('H-3 full refund');
    });

    it('stores FISIK/condition and DIGITAL/delivery fields (TX-AUDIT2 P0-A)', async () => {
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

      await service.createOrder('user-db-1', {
        ...dto,
        category: OrderCategory.FISIK,
        itemCondition: 'bekas',
        conditionDescription: 'Lecet dikit di sudut',
      });
      let createCall = mockPrisma.order.create.mock.calls[0][0].data;
      expect(createCall.itemCondition).toBe('bekas');
      expect(createCall.conditionDescription).toBe('Lecet dikit di sudut');

      await expect(
        service.createOrder('user-db-1', { ...dto, itemCondition: 'rusak' }),
      ).rejects.toThrow(BadRequestException);
      await expect(
        service.createOrder('user-db-1', { ...dto, deliveryMethod: 'pos' }),
      ).rejects.toThrow(BadRequestException);
    });

    // TX-AUDIT2 (P0-B): derivasi dimensi dari orderKind legacy.
    it('derives dimensions from legacy orderKind when not explicit (TX-AUDIT2 P0-B)', async () => {
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

      // JASTIP tanpa fulfillment eksplisit → PREORDER (tidak kena SLA 2 hari).
      await service.createOrder('user-db-1', { ...dto, orderKind: OrderKind.JASTIP });
      let createCall = mockPrisma.order.create.mock.calls[0][0].data;
      expect(createCall.orderKind).toBe(OrderKind.JASTIP);
      expect(createCall.fulfillment).toBe(FulfillmentType.PREORDER);

      // PATUNGAN tanpa participantMode eksplisit → GROUP.
      await service.createOrder('user-db-1', { ...dto, orderKind: OrderKind.PATUNGAN });
      createCall = mockPrisma.order.create.mock.calls[1][0].data;
      expect(createCall.participantMode).toBe(ParticipantMode.GROUP);

      // SERVICE_BOOKING tanpa category eksplisit → JASA.
      await service.createOrder('user-db-1', {
        ...dto,
        orderType: OrderType.SERVICE,
        orderKind: OrderKind.SERVICE_BOOKING,
        shippingAddressId: undefined,
      });
      createCall = mockPrisma.order.create.mock.calls[2][0].data;
      expect(createCall.category).toBe(OrderCategory.JASA);

      // Dimensi eksplisit tidak ditimpa derivasi.
      await service.createOrder('user-db-1', {
        ...dto,
        orderKind: OrderKind.JASTIP,
        fulfillment: FulfillmentType.BIASA,
      });
      createCall = mockPrisma.order.create.mock.calls[3][0].data;
      expect(createCall.fulfillment).toBe(FulfillmentType.BIASA);
    });

    // TX-AUDIT2 (P1-E): GROUP via API publik ditolak.
    it('rejects participantMode GROUP via public API (TX-AUDIT2 P1-E)', async () => {
      await expect(
        service.createOrder('user-db-1', { ...dto, participantMode: ParticipantMode.GROUP }),
      ).rejects.toThrow(BadRequestException);
      expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    });

    it('allows GROUP derived from legacy PATUNGAN orderKind (TX-AUDIT2 P1-E)', async () => {
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

      // Jalur internal patungan: orderKind=PATUNGAN + participantMode=GROUP eksplisit.
      await service.createOrder('user-db-1', {
        ...dto,
        orderKind: OrderKind.PATUNGAN,
        participantMode: ParticipantMode.GROUP,
      });
      expect(mockPrisma.$transaction).toHaveBeenCalled();
    });

    it('stores an explicit calendar deliveryDeadlineAt on the order (T3 audit 2026-09-26)', async () => {
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

      // Tanggal kalender 9 hari dari sekarang (di dalam jendela 1–14 hari).
      const picked = new Date(Date.now() + 9 * 24 * 60 * 60 * 1000);
      const calendarDate = picked.toISOString().slice(0, 10);
      await service.createOrder('user-db-1', { ...dto, deliveryDeadlineAt: calendarDate });

      const createCall = mockPrisma.order.create.mock.calls[0][0].data;
      // Tanggal kalender diartikan sebagai akhir hari WIB (T3).
      expect(createCall.deliveryDeadlineAt).toEqual(new Date(`${calendarDate}T16:59:59.999Z`));
      // deliveryDeadlineDays tetap dikirim sebagai fallback kompatibilitas.
      expect(createCall.deliveryDeadlineDays).toBe(7);
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

    // ─── TRX-009: alamat pengiriman wajib untuk barang fisik ──────────────

    it('TRX-009: rejects PHYSICAL_GOODS order without shippingAddressId (fail closed)', async () => {
      mockPrisma.user.findUnique.mockImplementation(({ where }: { where: { id?: string; username?: string } }) => {
        if (where.username === 'seller01') return Promise.resolve(mockCounterpart);
        if (where.id === 'user-db-1') return Promise.resolve(mockUser);
        if (where.id === 'user-db-2') return Promise.resolve(mockCounterpart);
        return Promise.resolve(null);
      });
      mockPrisma.blockList.findFirst.mockResolvedValue(null);
      const { shippingAddressId: _drop, ...noAddressDto } = dto;

      await expect(service.createOrder('user-db-1', noAddressDto)).rejects.toMatchObject({
        response: expect.objectContaining({ code: 'SHIPPING_ADDRESS_REQUIRED' }),
      });
      expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    });

    it('TRX-009: rejects PHYSICAL_GOODS order when the address is not owned by the creator', async () => {
      mockPrisma.user.findUnique.mockImplementation(({ where }: { where: { id?: string; username?: string } }) => {
        if (where.username === 'seller01') return Promise.resolve(mockCounterpart);
        if (where.id === 'user-db-1') return Promise.resolve(mockUser);
        if (where.id === 'user-db-2') return Promise.resolve(mockCounterpart);
        return Promise.resolve(null);
      });
      mockPrisma.blockList.findFirst.mockResolvedValue(null);
      mockPrisma.address.findFirst.mockResolvedValue(null);

      await expect(service.createOrder('user-db-1', dto)).rejects.toMatchObject({
        response: expect.objectContaining({ code: 'SHIPPING_ADDRESS_REQUIRED' }),
      });
      expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    });

    it('TRX-009: snapshots the encrypted address fields onto the order', async () => {
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

      expect(mockPrisma.address.findFirst).toHaveBeenCalledWith({
        where: { id: 'addr-1', userId: 'user-db-1', deletedAt: null },
      });
      const createCall = mockPrisma.order.create.mock.calls[0][0].data;
      // Snapshot = ciphertext apa adanya (pola enkripsi AES-GCM model Address).
      expect(createCall.shippingAddressId).toBe('addr-1');
      expect(createCall.shippingRecipientName).toBe('enc(recipient)');
      expect(createCall.shippingPhone).toBe('enc(phone)');
      expect(createCall.shippingAddressLine).toBe('enc(line)');
      expect(createCall.shippingCity).toBe('enc(city)');
      expect(createCall.shippingProvince).toBe('enc(province)');
      expect(createCall.shippingPostalCode).toBe('enc(postal)');
    });

    it('TRX-009: non-physical orders do not require a shipping address', async () => {
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
      const { shippingAddressId: _drop, ...serviceDto } = { ...dto, orderType: OrderType.SERVICE };

      const result = await service.createOrder('user-db-1', serviceDto) as Record<string, unknown>;

      expect(result).toHaveProperty('orderId');
      expect(mockPrisma.address.findFirst).not.toHaveBeenCalled();
      const createCall = mockPrisma.order.create.mock.calls[0][0].data;
      expect(createCall.shippingAddressId).toBeNull();
    });

    it('B01 (audit alamat & kurir 2026-10-10): pembuat berperan SELLER tidak diminta alamat — tujuan milik pembeli', async () => {
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
      const { shippingAddressId: _drop, ...sellerDto } = { ...dto, role: 'SELLER' as const };

      const result = await service.createOrder('user-db-1', sellerDto) as Record<string, unknown>;

      expect(result).toHaveProperty('orderId');
      // Alamat penjual TIDAK boleh dibaca/disnapshot sebagai tujuan kirim.
      expect(mockPrisma.address.findFirst).not.toHaveBeenCalled();
      const createCall = mockPrisma.order.create.mock.calls[0][0].data;
      expect(createCall.shippingAddressId).toBeNull();
      expect(createCall.createdByBuyer).toBe(false);
    });

    it('buyerLocation: persists encrypted coordinates when the buyer grants location', async () => {
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
      const { shippingAddressId: _drop, ...serviceDto } = { ...dto, orderType: OrderType.SERVICE };
      const dtoWithLocation = {
        ...serviceDto,
        buyerLocation: { latitude: -6.2088, longitude: 106.8456, accuracy: 12.5, capturedAt: '2026-09-28T22:30:00+07:00' },
      };

      const result = await service.createOrder('user-db-1', dtoWithLocation) as Record<string, unknown>;

      expect(result).toHaveProperty('orderId');
      const createCall = mockPrisma.order.create.mock.calls[0][0].data;
      // encryptPii di-mock sebagai identity -> kolom menyimpan "ciphertext" apa adanya.
      expect(createCall.buyerLatitude).toBe('-6.2088');
      expect(createCall.buyerLongitude).toBe('106.8456');
      expect(createCall.buyerLocationAccuracy).toBe('12.5');
      expect(createCall.buyerLocationCapturedAt).toBeInstanceOf(Date);
      expect((createCall.buyerLocationCapturedAt as Date).toISOString()).toBe('2026-09-28T15:30:00.000Z');
    });

    it('buyerLocation: order is still created when the buyer denies location (fail-open)', async () => {
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
      const { shippingAddressId: _drop, ...serviceDto } = { ...dto, orderType: OrderType.SERVICE };

      const result = await service.createOrder('user-db-1', { ...serviceDto, buyerLocation: null }) as Record<string, unknown>;

      expect(result).toHaveProperty('orderId');
      const createCall = mockPrisma.order.create.mock.calls[0][0].data;
      expect(createCall.buyerLatitude).toBeNull();
      expect(createCall.buyerLongitude).toBeNull();
      expect(createCall.buyerLocationAccuracy).toBeNull();
      expect(createCall.buyerLocationCapturedAt).toBeNull();
    });

    it('buyerLocation: out-of-range coordinates are ignored without failing the order', async () => {
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
      const { shippingAddressId: _drop, ...serviceDto } = { ...dto, orderType: OrderType.SERVICE };

      const result = await service.createOrder('user-db-1', {
        ...serviceDto,
        buyerLocation: { latitude: 999, longitude: 106.8456 },
      }) as Record<string, unknown>;

      expect(result).toHaveProperty('orderId');
      const createCall = mockPrisma.order.create.mock.calls[0][0].data;
      expect(createCall.buyerLatitude).toBeNull();
      expect(createCall.buyerLongitude).toBeNull();
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
          voucherType: 'FEE_DISCOUNT_FLAT', discountPercent: null, discountAmount: BigInt(1000),
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
      // BD-008: tanpa COUNT — `total` dihapus, diganti hasNext/totalPages.
      expect(result).not.toHaveProperty('total');
      expect(result).toHaveProperty('hasNext', false);
      expect(result).toHaveProperty('totalPages', 1);
      expect(result).toHaveProperty('page', 1);
      expect(result).toHaveProperty('limit', 10);
      expect(mockPrisma.order.count).not.toHaveBeenCalled();
    });

    it('should excerpt long descriptions in the list (BD-007)', async () => {
      const longDescription = 'x'.repeat(500);
      const ordersWithRelations = [
        { ...mockOrder, description: longDescription, buyer: { username: 'buyer01', fullName: 'Buyer One', avatarUrl: null }, seller: { username: 'seller01', fullName: 'Seller One', avatarUrl: null } },
      ];
      mockPrisma.order.findMany.mockResolvedValue(ordersWithRelations);

      const result = await service.getOrders('user-db-1', 1, 10) as {
        orders: Array<{ description: string }>;
      };

      expect(result.orders[0].description).toHaveLength(200);
      expect(result.orders[0].description).toBe(longDescription.slice(0, 200));
    });

    it('should keep short descriptions intact in the list (BD-007)', async () => {
      const ordersWithRelations = [
        { ...mockOrder, description: 'Deskripsi pendek', buyer: { username: 'buyer01', fullName: 'Buyer One', avatarUrl: null }, seller: { username: 'seller01', fullName: 'Seller One', avatarUrl: null } },
      ];
      mockPrisma.order.findMany.mockResolvedValue(ordersWithRelations);

      const result = await service.getOrders('user-db-1', 1, 10) as {
        orders: Array<{ description: string }>;
      };

      expect(result.orders[0].description).toBe('Deskripsi pendek');
    });

    it('should set hasNext=true and slice the probe row when more pages exist (BD-008)', async () => {
      const ordersWithRelations = Array.from({ length: 11 }, (_, i) => ({
        ...mockOrder,
        id: `order-internal-${i}`,
        orderId: `ORD-20260101-${String(i).padStart(3, '0')}`,
        buyer: { username: 'buyer01', fullName: 'Buyer One', avatarUrl: null },
        seller: { username: 'seller01', fullName: 'Seller One', avatarUrl: null },
      }));
      mockPrisma.order.findMany.mockResolvedValue(ordersWithRelations);

      const result = await service.getOrders('user-db-1', 1, 10) as Record<string, unknown>;

      expect(result).toHaveProperty('hasNext', true);
      expect(result).toHaveProperty('totalPages', 2);
      expect((result.orders as unknown[])).toHaveLength(10);
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

    // POIN 2 (2026-10-04): filter jenis transaksi escrow.

    it('should filter by order kind when provided', async () => {
      mockPrisma.order.findMany.mockResolvedValue([]);
      mockPrisma.order.count.mockResolvedValue(0);

      await service.getOrders('user-db-1', 1, 10, undefined, undefined, undefined, undefined, undefined, undefined, undefined, OrderKind.JASTIP);

      const findManyCall = mockPrisma.order.findMany.mock.calls[0][0];
      expect(findManyCall.where.orderKind).toBe(OrderKind.JASTIP);
    });

    it('should include orderKind in each listed order', async () => {
      const ordersWithRelations = [
        { ...mockOrder, orderKind: OrderKind.PATUNGAN, buyer: { username: 'b', fullName: 'B', avatarUrl: null }, seller: { username: 's', fullName: 'S', avatarUrl: null } },
      ];
      mockPrisma.order.findMany.mockResolvedValue(ordersWithRelations);

      const result = await service.getOrders('user-db-1', 1, 10) as {
        orders: Array<{ orderKind: OrderKind }>;
      };

      expect(result.orders[0].orderKind).toBe(OrderKind.PATUNGAN);
    });

    it('rejects an invalid kind filter instead of returning unfiltered orders', async () => {
      await expect(
        service.getOrders('user-db-1', 1, 10, undefined, undefined, undefined, undefined, undefined, undefined, undefined, 'BOGUS' as OrderKind),
      ).rejects.toThrow(BadRequestException);
      expect(mockPrisma.order.findMany).not.toHaveBeenCalled();
    });

    // TX-UNIFIED-V2 (2026-10-06): filter 3 dimensi independen.

    it('should filter by fulfillment when provided', async () => {
      mockPrisma.order.findMany.mockResolvedValue([]);
      mockPrisma.order.count.mockResolvedValue(0);

      await service.getOrders('user-db-1', 1, 10, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, FulfillmentType.PREORDER);

      const findManyCall = mockPrisma.order.findMany.mock.calls[0][0];
      expect(findManyCall.where.fulfillment).toBe(FulfillmentType.PREORDER);
    });

    it('should filter by participantMode when provided', async () => {
      mockPrisma.order.findMany.mockResolvedValue([]);
      mockPrisma.order.count.mockResolvedValue(0);

      await service.getOrders('user-db-1', 1, 10, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, ParticipantMode.GROUP);

      const findManyCall = mockPrisma.order.findMany.mock.calls[0][0];
      expect(findManyCall.where.participantMode).toBe(ParticipantMode.GROUP);
    });

    it('should filter by category when provided', async () => {
      mockPrisma.order.findMany.mockResolvedValue([]);
      mockPrisma.order.count.mockResolvedValue(0);

      await service.getOrders('user-db-1', 1, 10, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, OrderCategory.JASA);

      const findManyCall = mockPrisma.order.findMany.mock.calls[0][0];
      expect(findManyCall.where.category).toBe(OrderCategory.JASA);
    });

    it('should include new dimensions in each listed order', async () => {
      const ordersWithRelations = [
        { ...mockOrder, fulfillment: FulfillmentType.PREORDER, participantMode: ParticipantMode.GROUP, category: OrderCategory.FISIK, buyer: { username: 'b', fullName: 'B', avatarUrl: null }, seller: { username: 's', fullName: 'S', avatarUrl: null } },
      ];
      mockPrisma.order.findMany.mockResolvedValue(ordersWithRelations);

      const result = await service.getOrders('user-db-1', 1, 10) as {
        orders: Array<{ fulfillment: FulfillmentType; participantMode: ParticipantMode; category: OrderCategory }>;
      };

      expect(result.orders[0].fulfillment).toBe(FulfillmentType.PREORDER);
      expect(result.orders[0].participantMode).toBe(ParticipantMode.GROUP);
      expect(result.orders[0].category).toBe(OrderCategory.FISIK);
    });

    it('rejects invalid new dimension filters', async () => {
      await expect(
        service.getOrders('user-db-1', 1, 10, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, 'BOGUS' as FulfillmentType),
      ).rejects.toThrow(BadRequestException);
      await expect(
        service.getOrders('user-db-1', 1, 10, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, 'BOGUS' as ParticipantMode),
      ).rejects.toThrow(BadRequestException);
      await expect(
        service.getOrders('user-db-1', 1, 10, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, 'BOGUS' as OrderCategory),
      ).rejects.toThrow(BadRequestException);
      expect(mockPrisma.order.findMany).not.toHaveBeenCalled();
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

    // ─── D1-005: getOrderStatus (status ringan untuk poll) ──────────────────

    describe('getOrderStatus', () => {
      it('mengembalikan status ringan tanpa include berat', async () => {
        mockPrisma.order.findFirst.mockResolvedValue({
          orderId: 'ORD-20260101-001',
          status: OrderStatus.PROCESSING,
          updatedAt: new Date('2026-09-29T10:00:00.000Z'),
          buyerId: 'user-db-1',
          sellerId: 'user-db-2',
        });

        const result = await service.getOrderStatus('user-db-1', 'ORD-20260101-001');

        expect(result).toMatchObject({ orderId: 'ORD-20260101-001', status: OrderStatus.PROCESSING });
        expect(result.updatedAt).toBeInstanceOf(Date);
        const args = mockPrisma.order.findFirst.mock.calls[0][0];
        expect(Object.keys(args.select).sort()).toEqual(
          ['buyerId', 'orderId', 'sellerId', 'status', 'updatedAt'].sort(),
        );
        expect(args.include).toBeUndefined();
      });

      it('NotFound untuk order tak dikenal', async () => {
        mockPrisma.order.findFirst.mockResolvedValue(null);
        await expect(service.getOrderStatus('user-db-1', 'ORD-INVALID')).rejects.toThrow(NotFoundException);
      });

      it('Forbidden untuk bukan partisipan', async () => {
        mockPrisma.order.findFirst.mockResolvedValue({
          orderId: 'ORD-20260101-001',
          status: OrderStatus.PROCESSING,
          updatedAt: new Date(),
          buyerId: 'user-db-1',
          sellerId: 'user-db-2',
        });
        await expect(service.getOrderStatus('user-db-999', 'ORD-20260101-001')).rejects.toThrow(ForbiddenException);
      });
    });

    it('TRX-009: exposes the decrypted shipping address snapshot to participants', async () => {
      mockPrisma.order.findFirst.mockResolvedValue({
        ...mockOrder,
        shippingAddressId: 'addr-1',
        shippingRecipientName: 'enc(recipient)',
        shippingPhone: 'enc(phone)',
        shippingAddressLine: 'enc(line)',
        shippingCity: 'enc(city)',
        shippingProvince: 'enc(province)',
        shippingPostalCode: 'enc(postal)',
      });

      const result = await service.getOrderDetail('user-db-2', 'ORD-20260101-001') as Record<string, unknown>;
      const order = result.order as Record<string, unknown>;

      expect(order.shippingAddress).toMatchObject({
        id: 'addr-1',
        recipientName: 'enc(recipient)',
        phone: 'enc(phone)',
        addressLine: 'enc(line)',
        city: 'enc(city)',
        province: 'enc(province)',
        postalCode: 'enc(postal)',
      });
    });

    it('TRX-009: shippingAddress is null for orders without a snapshot', async () => {
      mockPrisma.order.findFirst.mockResolvedValue(mockOrder);

      const result = await service.getOrderDetail('user-db-1', 'ORD-20260101-001') as Record<string, unknown>;

      expect((result.order as Record<string, unknown>).shippingAddress).toBeNull();
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

    it('should apply Kahade+ fee waiver estimate in calculateFee (WF-019)', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({ ...mockUser, isKahadePlus: true });
      mockPrisma.subscription.findFirst.mockResolvedValue({
        id: 'sub-1',
        feeSavingsUsed: BigInt(0),
        feeSavingsLimit: BigInt(500_000_000),
      });
      // Kuota mencukupi untuk membebaskan seluruh porsi fee buyer (150.000 sen).
      subscriptionsMock.estimateWaiverAmount.mockResolvedValue(BigInt(150_000));

      const result = await service.calculateFee(
        { orderValue: 100_000, feeResponsibility: FeeResponsibility.BUYER },
        'user-db-1',
      );

      // feeAmount & buyerPayAmount berkurang sebesar waiver; field baru terisi.
      expect(result).toHaveProperty('feeWaivedAmount', 1500);
      expect(result).toHaveProperty('feeAmount', 0);
      expect(result).toHaveProperty('buyerFeeAmount', 0);
      expect(result).toHaveProperty('buyerPayAmount', 100_000);
      expect(result).toHaveProperty('sellerReceiveAmount', 100_000);
      expect(subscriptionsMock.estimateWaiverAmount).toHaveBeenCalledWith('user-db-1', BigInt(150_000));
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

    it('should preview WALLET_CASHBACK from order value without reducing order fee', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(mockUser);
      mockPrisma.voucher.findFirst.mockResolvedValue({
        id: 'voucher-1',
        isActive: true,
        voucherType: 'WALLET_CASHBACK',
        discountPercent: 10,
        discountAmount: null,
        maxUsageTotal: null,
        currentUsage: 0,
        maxUsagePerUser: null,
        minOrderValue: null,
        maxDiscountAmount: null,
        applicableTo: 'ALL',
        assignedToUserId: null,
        campaignId: null,
      });
      mockPrisma.voucherUsage.count.mockResolvedValue(0);

      const result = await service.calculateFee(
        { orderValue: 100_000, feeResponsibility: FeeResponsibility.BUYER, voucherCode: 'CASH10', role: 'BUYER' },
        'user-db-1',
      );

      expect(result.voucherCashback).toBe(10_000);
      expect(mockFeeCalculator.calculateFee).toHaveBeenCalledWith(
        expect.objectContaining({ voucherDiscountSen: BigInt(0) }),
        expect.objectContaining({ kahadeFeeRateBps: expect.any(Number) }),
      );
    });

    // Audit voucher 2026-10-10 (B09): preview tidak lagi mengabaikan voucher
    // yang tidak ada / kedaluwarsa — kode error sama dengan create order.
    it('should throw NotFoundException when voucher not found during fee calculation (B09)', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(mockUser);
      mockPrisma.voucher.findFirst.mockResolvedValue(null);

      await expect(
        service.calculateFee(
          { orderValue: 100_000, feeResponsibility: FeeResponsibility.BUYER, voucherCode: 'NOTEXIST' },
          'user-db-1',
        ),
      ).rejects.toThrow(NotFoundException);
      expect(mockFeeCalculator.calculateFee).not.toHaveBeenCalled();
    });

    it('should throw VOUCHER_EXPIRED when voucher is inactive or expired during fee calculation (B09)', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(mockUser);
      mockPrisma.voucher.findFirst.mockResolvedValue({
        id: 'voucher-1',
        isActive: true,
        voucherType: 'FEE_DISCOUNT_PERCENT',
        discountPercent: 50,
        discountAmount: null,
        maxUsageTotal: null,
        currentUsage: 0,
        maxUsagePerUser: null,
        validFrom: new Date(0),
        validUntil: new Date(Date.now() - 1000),
      });

      await expect(
        service.calculateFee(
          { orderValue: 100_000, feeResponsibility: FeeResponsibility.BUYER, voucherCode: 'OLD' },
          'user-db-1',
        ),
      ).rejects.toMatchObject({ response: { code: 'VOUCHER_EXPIRED' } });
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
      mockPrisma.order.findFirst.mockResolvedValue(null);
      mockPrisma.order.findUnique.mockResolvedValue(null);

      await expect(
        service.updateShipping('ORD-NOTFOUND', 'user-db-2', shippingDto),
      ).rejects.toThrow(NotFoundException);
    });

    it('should throw ForbiddenException when user is not the seller', async () => {
      mockPrisma.order.findFirst.mockResolvedValue({ ...mockOrder, status: OrderStatus.PROCESSING, sellerId: 'user-db-2' });
      mockPrisma.order.findUnique.mockResolvedValue({ ...mockOrder, status: OrderStatus.PROCESSING, sellerId: 'user-db-2' });

      await expect(
        service.updateShipping('ORD-20260101-001', 'user-db-999', shippingDto),
      ).rejects.toThrow(ForbiddenException);
    });

    it('should throw BadRequestException for invalid order status', async () => {
      mockPrisma.order.findFirst.mockResolvedValue({
        ...mockOrder,
        status: OrderStatus.COMPLETED,
        sellerId: 'user-db-2',
      });
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
      mockPrisma.order.findFirst.mockResolvedValue({ ...mockOrder, status: OrderStatus.PROCESSING, sellerId: 'user-db-2', id: 'order-internal-1' });
      mockPrisma.order.findUnique.mockResolvedValue({ ...mockOrder, status: OrderStatus.PROCESSING, sellerId: 'user-db-2', id: 'order-internal-1' });
      mockPrisma.order.update.mockResolvedValue({});

      const result = await service.updateShipping('ORD-20260101-001', 'user-db-2', shippingDto);

      expect(result.trackingNumber).toBe('JNE1234567');
      expect(result.courierName).toBe('JNE');
      expect(mockPrisma.order.updateMany).toHaveBeenCalled();
    });

        it('should update shipping info successfully for IN_DELIVERY order', async () => {
      mockPrisma.order.findFirst.mockResolvedValue({ ...mockOrder, status: OrderStatus.IN_DELIVERY, sellerId: 'user-db-2', id: 'order-internal-1' });
      mockPrisma.order.findUnique.mockResolvedValue({ ...mockOrder, status: OrderStatus.IN_DELIVERY, sellerId: 'user-db-2', id: 'order-internal-1' });
      mockPrisma.order.update.mockResolvedValue({});
      const result = await service.updateShipping('ORD-20260101-001', 'user-db-2', shippingDto);
      expect(result).toHaveProperty('orderId');
    });
    it('should allow non-physical orders to save notes without tracking fields and record an audit event', async () => {
      mockPrisma.order.findFirst.mockResolvedValue({
        ...mockOrder,
        orderType: OrderType.SERVICE,
        status: OrderStatus.PROCESSING,
        sellerId: 'user-db-2',
        trackingNumber: null,
        courierName: null,
        id: 'order-internal-1',
      });
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

    it('excludes soft-deleted orders from the lookup (T1 audit 2026-09-26)', async () => {
      mockPrisma.order.findFirst.mockResolvedValue({ ...mockOrder, status: OrderStatus.PROCESSING, sellerId: 'user-db-2', id: 'order-internal-1' });
      mockPrisma.order.findUnique.mockResolvedValue({ ...mockOrder, status: OrderStatus.PROCESSING, sellerId: 'user-db-2', id: 'order-internal-1' });
      mockPrisma.order.update.mockResolvedValue({});

      await service.updateShipping('ORD-20260101-001', 'user-db-2', shippingDto);

      expect(mockPrisma.order.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ orderId: 'ORD-20260101-001', deletedAt: null }) }),
      );
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

  // ─── M1 (SEC-B ronde 2): voucher seller terikat ke seller ────────────────

  describe('M1: seller voucher binding saat redeem', () => {
    const dto: CreateOrderDto = {
      role: 'BUYER' as const,
      counterpartUsername: 'seller01',
      title: 'Test Order',
      description: 'Test description',
      orderType: OrderType.PHYSICAL_GOODS,
      orderValue: 100_000,
      deliveryDeadlineDays: 7,
      feeResponsibility: FeeResponsibility.BUYER,
      voucherCode: 'SELLER10',
      // TRX-009: order fisik wajib menyertakan alamat pengiriman.
      shippingAddressId: 'addr-1',
    };

    const sellerVoucherRow = (sellerId: string | null) => ({
      id: 'voucher-s1',
      code: 'SELLER10',
      isActive: true,
      voucherType: 'FEE_DISCOUNT_PERCENT',
      discountPercent: 10,
      discountAmount: null,
      maxUsageTotal: null,
      currentUsage: 0,
      maxUsagePerUser: null,
      campaignId: null,
      validFrom: new Date(0),
      validUntil: new Date(Date.now() + 86400000),
      applicableTo: 'ALL',
      assignedToUserId: null,
      sellerId,
      minOrderValue: null,
      maxDiscountAmount: null,
    });

    function mockVoucherFlow(sellerId: string | null) {
      mockPrisma.user.findUnique.mockImplementation(({ where }: { where: { id?: string; username?: string } }) => {
        if (where.username === 'seller01') return Promise.resolve(mockCounterpart);
        if (where.id === 'user-db-1') return Promise.resolve(mockUser);
        if (where.id === 'user-db-2') return Promise.resolve(mockCounterpart);
        return Promise.resolve(null);
      });
      mockPrisma.blockList.findFirst.mockResolvedValue(null);
      mockPrisma.$queryRaw.mockResolvedValue([sellerVoucherRow(sellerId)]);
      mockPrisma.$transaction.mockImplementation(async (fn: (tx: typeof mockPrisma) => Promise<unknown>) => {
        mockPrisma.order.create.mockResolvedValue(mockOrder);
        mockPrisma.chatRoom.create.mockResolvedValue({ id: 'chat-1' });
        return fn(mockPrisma);
      });
      mockPrisma.order.findFirst.mockResolvedValue(null);
    }

    it('menolak voucher seller S dipakai di order seller T', async () => {
      mockVoucherFlow('user-db-9'); // voucher milik seller lain
      await expect(service.createOrder('user-db-1', dto)).rejects.toThrow(
        'only valid for orders from the issuing seller',
      );
      expect(mockPrisma.order.create).not.toHaveBeenCalled();
    });

    it('mengizinkan voucher seller S di order seller S', async () => {
      mockVoucherFlow('user-db-2'); // voucher milik counterpart (seller order ini)
      const result = (await service.createOrder('user-db-1', dto)) as Record<string, unknown>;
      expect(result).toHaveProperty('orderId');
      expect(mockPrisma.order.create).toHaveBeenCalled();
    });

    it('voucher platform (sellerId null) tetap bisa dipakai di order mana pun', async () => {
      mockVoucherFlow(null);
      const result = (await service.createOrder('user-db-1', dto)) as Record<string, unknown>;
      expect(result).toHaveProperty('orderId');
    });
  });
});
