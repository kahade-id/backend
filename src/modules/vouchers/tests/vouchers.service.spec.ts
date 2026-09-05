import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { VouchersService } from '../vouchers.service';
import { PrismaService } from '../../../prisma/prisma.service';
import { RedisService } from '../../../redis/redis.service';
import { FeeCalculatorService } from '../../orders/fee-calculator.service';
import { VoucherType, VoucherApplicability } from '@prisma/client';

const makeVoucher = (overrides: Record<string, unknown> = {}) => ({
  id: 'voucher-internal-1',
  voucherId: 'VCH-001',
  code: 'SAVE10',
  name: 'Save 10%',
  description: null,
  voucherType: VoucherType.FEE_DISCOUNT_PERCENT,
  discountAmount: null,
  discountPercent: 10,
  maxDiscountAmount: null,
  minOrderValue: BigInt(50_000),
  maxUsagePerUser: null,
  maxUsageTotal: null,
  currentUsage: 0,
  isActive: true,
  applicableTo: VoucherApplicability.ALL,
  validFrom: new Date(Date.now() - 86_400_000),
  validUntil: new Date(Date.now() + 86_400_000),
  createdAt: new Date(),
  updatedAt: new Date(),
  ...overrides,
});

const mockPrisma = {
  voucher: {
    findUnique: jest.fn(),
    findMany: jest.fn(),
    count: jest.fn(),
  },
  voucherUsage: {
    count: jest.fn(),
    create: jest.fn(),
    findMany: jest.fn(),
  },
  user: {
    findUnique: jest.fn(),
  },
  subscription: {
    findFirst: jest.fn(),
  },
};

const mockRedis = {
  get: jest.fn(),
  setex: jest.fn(),
  del: jest.fn(),
  delPattern: jest.fn(),
};

const mockFeeCalculator = {
  getFeeConfig: jest.fn().mockResolvedValue({ kahadeFeeRateBps: 150, kahadePlusFeeRateBps: 50 }),
  getFeeRate: jest.fn().mockReturnValue(1.5),
  getStandardFeeSen: jest.fn().mockReturnValue(BigInt(500_000)),
};

describe('VouchersService', () => {
  let service: VouchersService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        VouchersService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: RedisService, useValue: mockRedis },
        { provide: FeeCalculatorService, useValue: mockFeeCalculator },
      ],
    }).compile();

    service = module.get<VouchersService>(VouchersService);
    jest.clearAllMocks();
    mockPrisma.user.findUnique.mockResolvedValue({ totalOrdersCompleted: 0 });
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('validateVoucher', () => {
    it('should throw NotFoundException when voucher code does not exist', async () => {
      mockPrisma.voucher.findUnique.mockResolvedValueOnce(null);

      await expect(service.validateVoucher('user-1', 'NONEXISTENT', 100_000)).rejects.toThrow(NotFoundException);
    });

    it('should throw BadRequestException when voucher is expired', async () => {
      mockPrisma.voucher.findUnique.mockResolvedValueOnce(
        makeVoucher({ validUntil: new Date(Date.now() - 1000) }),
      );

      await expect(service.validateVoucher('user-1', 'SAVE10', 100_000)).rejects.toThrow(BadRequestException);
    });

    it('should throw BadRequestException when voucher max total usage is reached', async () => {
      mockPrisma.voucher.findUnique.mockResolvedValueOnce(
        makeVoucher({ maxUsageTotal: 100, currentUsage: 100 }),
      );

      await expect(service.validateVoucher('user-1', 'SAVE10', 100_000)).rejects.toThrow(BadRequestException);
    });

    it('should throw BadRequestException when voucher max total usage is exceeded (currentUsage > maxUsageTotal)', async () => {
      mockPrisma.voucher.findUnique.mockResolvedValueOnce(
        makeVoucher({ maxUsageTotal: 50, currentUsage: 51 }),
      );

      await expect(service.validateVoucher('user-1', 'SAVE10', 100_000)).rejects.toThrow(BadRequestException);
    });

    it('should throw BadRequestException when user has exceeded their per-user usage limit', async () => {
      mockPrisma.voucher.findUnique.mockResolvedValueOnce(
        makeVoucher({ maxUsagePerUser: 2, maxUsageTotal: null, currentUsage: 5 }),
      );
      mockPrisma.voucherUsage.count.mockResolvedValueOnce(2);

      await expect(service.validateVoucher('user-1', 'SAVE10', 100_000)).rejects.toThrow(BadRequestException);
    });

    it('should return voucher details when valid and within usage limits', async () => {
      mockPrisma.voucher.findUnique.mockResolvedValueOnce(
        makeVoucher({ maxUsageTotal: 100, currentUsage: 50, maxUsagePerUser: 3 }),
      );
      mockPrisma.voucherUsage.count.mockResolvedValueOnce(1);

      const result = await service.validateVoucher('user-1', 'SAVE10', 100_000);

      expect(result).toBeDefined();
      expect(result).toHaveProperty('code', 'SAVE10');
    });

    it('should reject when concurrent requests push currentUsage to maxUsageTotal boundary', async () => {
      mockPrisma.voucher.findUnique.mockResolvedValueOnce(
        makeVoucher({ maxUsageTotal: 1, currentUsage: 1 }),
      );

      await expect(service.validateVoucher('user-1', 'SAVE10', 100_000)).rejects.toThrow(BadRequestException);
    });

    it('should reject all N concurrent callers when voucher is at max capacity', async () => {
      const N = 5;
      const results = await Promise.allSettled(
        Array.from({ length: N }, (_, i) => {
          mockPrisma.voucher.findUnique.mockResolvedValueOnce(
            makeVoucher({ maxUsageTotal: 10, currentUsage: 10 }),
          );
          return service.validateVoucher(`user-${i}`, 'SAVE10', 100_000);
        }),
      );

      const rejected = results.filter(r => r.status === 'rejected');
      expect(rejected.length).toBe(N);
      for (const r of rejected) {
        expect((r as PromiseRejectedResult).reason).toBeInstanceOf(BadRequestException);
      }
    });

    it('should reject NEW_USER voucher when user has completed orders', async () => {
      mockPrisma.voucher.findUnique.mockResolvedValueOnce(
        makeVoucher({ applicableTo: 'NEW_USER' }),
      );
      mockPrisma.voucherUsage.count.mockResolvedValueOnce(0);
      mockPrisma.user.findUnique.mockResolvedValueOnce({ totalOrdersCompleted: 5 });

      await expect(service.validateVoucher('user-1', 'SAVE10', 100_000)).rejects.toThrow(BadRequestException);
    });

    it('should allow NEW_USER voucher when user has no completed orders', async () => {
      mockPrisma.voucher.findUnique.mockResolvedValueOnce(
        makeVoucher({ applicableTo: 'NEW_USER' }),
      );
      mockPrisma.voucherUsage.count.mockResolvedValueOnce(0);
      mockPrisma.user.findUnique.mockResolvedValueOnce({ totalOrdersCompleted: 0, isKahadePlus: false });
      mockFeeCalculator.getFeeConfig.mockResolvedValueOnce({ kahadeFeeRateBps: 150, kahadePlusFeeRateBps: 50 });
      mockFeeCalculator.getFeeRate.mockReturnValueOnce(1.5);

      const result = await service.validateVoucher('user-1', 'SAVE10', 100_000);
      expect(result).toHaveProperty('valid', true);
    });

    it('should reject BUYER_ONLY voucher when userRole is not provided', async () => {
      mockPrisma.voucher.findUnique.mockResolvedValueOnce(
        makeVoucher({ applicableTo: 'BUYER_ONLY' }),
      );
      mockPrisma.voucherUsage.count.mockResolvedValueOnce(0);

      await expect(service.validateVoucher('user-1', 'SAVE10', 100_000)).rejects.toThrow(BadRequestException);
    });

    it('should reject BUYER_ONLY voucher when userRole is SELLER', async () => {
      mockPrisma.voucher.findUnique.mockResolvedValueOnce(
        makeVoucher({ applicableTo: 'BUYER_ONLY' }),
      );
      mockPrisma.voucherUsage.count.mockResolvedValueOnce(0);

      await expect(service.validateVoucher('user-1', 'SAVE10', 100_000, 'SELLER')).rejects.toThrow(BadRequestException);
    });

    it('should allow BUYER_ONLY voucher when userRole is BUYER', async () => {
      mockPrisma.voucher.findUnique.mockResolvedValueOnce(
        makeVoucher({ applicableTo: 'BUYER_ONLY', voucherType: VoucherType.FEE_DISCOUNT_FLAT, discountAmount: BigInt(10_000) }),
      );
      mockPrisma.voucherUsage.count.mockResolvedValueOnce(0);

      const result = await service.validateVoucher('user-1', 'SAVE10', 100_000, 'BUYER');
      expect(result).toHaveProperty('valid', true);
    });

    it('should reject SELLER_ONLY voucher when userRole is BUYER', async () => {
      mockPrisma.voucher.findUnique.mockResolvedValueOnce(
        makeVoucher({ applicableTo: 'SELLER_ONLY' }),
      );
      mockPrisma.voucherUsage.count.mockResolvedValueOnce(0);

      await expect(service.validateVoucher('user-1', 'SAVE10', 100_000, 'BUYER')).rejects.toThrow(BadRequestException);
    });

    it('should compute percentage discount based on fee not order value', async () => {
      mockPrisma.voucher.findUnique.mockResolvedValueOnce(
        makeVoucher({
          voucherType: VoucherType.FEE_DISCOUNT_PERCENT,
          discountPercent: 50,
          discountAmount: null,
        }),
      );
      mockPrisma.voucherUsage.count.mockResolvedValueOnce(0);
      mockPrisma.user.findUnique.mockResolvedValueOnce({ isKahadePlus: false });
      mockFeeCalculator.getFeeConfig.mockResolvedValueOnce({ kahadeFeeRateBps: 150, kahadePlusFeeRateBps: 50 });
      mockFeeCalculator.getFeeRate.mockReturnValueOnce(1.5);

      const result = await service.validateVoucher('user-1', 'SAVE10', 1_000_000);
      expect(result.discountAmount).toBeDefined();
      expect(result.discountAmount).toBeLessThan(1_000_000);
    });

    it('matches the clamped fee basis used by final order creation when previewing a percentage voucher', async () => {
      mockPrisma.voucher.findUnique.mockResolvedValueOnce(
        makeVoucher({ discountPercent: 10, minOrderValue: null }),
      );
      mockPrisma.voucherUsage.count.mockResolvedValueOnce(0);
      mockPrisma.user.findUnique.mockResolvedValueOnce({ isKahadePlus: false });

      const result = await service.validateVoucher('user-1', 'SAVE10', 100_000);

      expect(mockFeeCalculator.getStandardFeeSen).toHaveBeenCalled();
      expect(result.discountAmount).toBe(500);
    });

    it('should cap percentage discount at maxDiscountAmount', async () => {
      mockPrisma.voucher.findUnique.mockResolvedValueOnce(
        makeVoucher({
          voucherType: VoucherType.FEE_DISCOUNT_PERCENT,
          discountPercent: 100,
          discountAmount: null,
          maxDiscountAmount: BigInt(5_000),
        }),
      );
      mockPrisma.voucherUsage.count.mockResolvedValueOnce(0);
      mockPrisma.user.findUnique.mockResolvedValueOnce({ isKahadePlus: false });
      mockFeeCalculator.getFeeConfig.mockResolvedValueOnce({ kahadeFeeRateBps: 150, kahadePlusFeeRateBps: 50 });
      mockFeeCalculator.getFeeRate.mockReturnValueOnce(1.5);

      const result = await service.validateVoucher('user-1', 'SAVE10', 1_000_000);
      expect(result.discountAmount).toBeLessThanOrEqual(50);
    });
  });
});


describe('VouchersService regression coverage', () => {
  let service: VouchersService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        VouchersService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: RedisService, useValue: mockRedis },
        { provide: FeeCalculatorService, useValue: mockFeeCalculator },
      ],
    }).compile();
    service = module.get<VouchersService>(VouchersService);
    jest.clearAllMocks();
    mockPrisma.user.findUnique.mockResolvedValue({ totalOrdersCompleted: 0 });
  });

  it('rejects validation for a missing authenticated user', async () => {
    mockPrisma.voucher.findUnique.mockResolvedValueOnce(makeVoucher());
    mockPrisma.user.findUnique.mockResolvedValueOnce(null);
    await expect(service.validateVoucher('missing-user', 'SAVE10', 100_000)).rejects.toThrow(NotFoundException);
  });

  it('caps a flat preview at the canonical standard fee', async () => {
    mockPrisma.voucher.findUnique.mockResolvedValueOnce(makeVoucher({
      voucherType: VoucherType.FEE_DISCOUNT_FLAT,
      discountAmount: BigInt(2_000_000),
      discountPercent: null,
    }));
    const result = await service.validateVoucher('user-1', 'SAVE10', 100_000);
    expect(result.discountAmount).toBe(5_000);
  });

  it('excludes NEW_USER vouchers from returning users and separates the cache audience', async () => {
    mockPrisma.user.findUnique.mockResolvedValueOnce({ totalOrdersCompleted: 2 });
    mockPrisma.voucher.findMany.mockResolvedValueOnce([]);
    mockPrisma.voucher.count.mockResolvedValueOnce(0);
    await service.getAvailableVouchers('user-1', 1, 20);
    expect(mockPrisma.voucher.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ applicableTo: { not: VoucherApplicability.NEW_USER } }),
    }));
    expect(mockRedis.setex).toHaveBeenCalledWith(expect.stringContaining(':existing:'), expect.any(Number), expect.any(String));
  });

  it('uses a short cache TTL when the earliest voucher expires sooner than the normal TTL', async () => {
    const expiresSoon = new Date(Date.now() + 2_000);
    mockPrisma.voucher.findMany.mockResolvedValueOnce([makeVoucher({ validUntil: expiresSoon })]);
    mockPrisma.voucher.count.mockResolvedValueOnce(1);
    await service.getAvailableVouchers('user-1', 1, 20);
    expect(mockRedis.setex.mock.calls[0]?.[1]).toBeLessThanOrEqual(3);
  });

  it('normalizes direct-service page and limit values for usage history', async () => {
    mockPrisma.voucherUsage.findMany.mockResolvedValueOnce([]);
    mockPrisma.voucherUsage.count.mockResolvedValueOnce(0);
    const result = await service.getMyUsageHistory('user-1', Number.NaN, Number.POSITIVE_INFINITY);
    expect(result.page).toBe(1);
    expect(result.limit).toBe(20);
  });
});
