import { Test, TestingModule } from '@nestjs/testing';
import { FeeCalculatorService } from '../fee-calculator.service';
import { ConfigService } from '@nestjs/config';
import { RedisService } from '../../../redis/redis.service';

const mockConfig = {
  get: jest.fn((key: string) => {
    const config: Record<string, unknown> = {
      'app.kahadeFeeRateBps': 250,     // 2.50% standard fee
      'app.kahadePlusFeeRateBps': 50,  // 0.50% KahadePlus fee
      'app.kahadeFeeRate': 2.5,
      'app.kahadePlusFeeRate': 0.5,
    };
    return config[key];
  }),
};

const mockRedis = {
  get: jest.fn(),
  set: jest.fn(),
  setex: jest.fn(),
  del: jest.fn(),
};

describe('FeeCalculatorService', () => {
  let service: FeeCalculatorService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        FeeCalculatorService,
        { provide: ConfigService, useValue: mockConfig },
        { provide: RedisService, useValue: mockRedis },
      ],
    }).compile();
    service = module.get<FeeCalculatorService>(FeeCalculatorService);
    mockConfig.get.mockClear();
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('calculateFee', () => {
    it('should calculate correct fee for BUYER-responsibility order', () => {
      const result = service.calculateFee({
        orderValue: 1_000_000,
        feeResponsibility: 'BUYER',
        isKahadePlus: false,
      });
      expect(result).toBeDefined();
      // toSen(1_000_000) * 250bps / 10_000 = 100_000_000 * 250 / 10_000 = 2_500_000 sen (Rp 25.000)
      expect(result.feeAmount).toBe(BigInt(2_500_000));
    });

    it('should clamp standard fee to MIN Rp 5.000 for small orders', () => {
      // Rp 100.000 × 2.5% = Rp 2.500 → clamped UP to Rp 5.000
      const result = service.calculateFee({ orderValue: 100_000, feeResponsibility: 'BUYER', isKahadePlus: false });
      expect(result.feeAmount).toBe(BigInt(500_000)); // 500_000 sen = Rp 5.000
    });

    it('should clamp standard fee to MAX Rp 250.000 for huge orders', () => {
      // Rp 100.000.000 × 2.5% = Rp 2.500.000 → clamped DOWN to Rp 250.000
      const result = service.calculateFee({ orderValue: 100_000_000, feeResponsibility: 'BUYER', isKahadePlus: false });
      expect(result.feeAmount).toBe(BigInt(25_000_000)); // 25_000_000 sen = Rp 250.000
    });

    it('should allow Kahade Plus subscription to bring fee BELOW the Rp 5.000 floor', () => {
      // Rp 100.000 × 0.5% = Rp 500 (well below Rp 5.000 floor — allowed for Plus)
      const result = service.calculateFee({ orderValue: 100_000, feeResponsibility: 'BUYER', isKahadePlus: true });
      expect(result.feeAmount).toBe(BigInt(50_000)); // 50_000 sen = Rp 500
    });

    it('should never let Kahade Plus fee EXCEED clamped standard fee', () => {
      // Rp 100.000.000: standard clamped to Rp 250.000, Plus raw = Rp 500.000
      // Plus must not pay MORE than standard, so cap at Rp 250.000.
      const result = service.calculateFee({ orderValue: 100_000_000, feeResponsibility: 'BUYER', isKahadePlus: true });
      expect(result.feeAmount).toBe(BigInt(25_000_000));
    });

    it('should assign full fee to seller when responsibility is SELLER', () => {
      const result = service.calculateFee({
        orderValue: 1_000_000,
        feeResponsibility: 'SELLER',
        isKahadePlus: false,
      });
      expect(result.buyerFeeAmount).toBe(BigInt(0));
      expect(result.sellerFeeAmount).toBe(result.feeAmount);
    });

    it('should split fee 50/50 when responsibility is SPLIT', () => {
      const result = service.calculateFee({
        orderValue: 1_000_000,
        feeResponsibility: 'SPLIT',
        isKahadePlus: false,
      });
      expect(result.buyerFeeAmount + result.sellerFeeAmount).toBe(result.feeAmount);
    });

    it('should apply KahadePlus rate (0.50% vs 2.50%)', () => {
      const standard = service.calculateFee({ orderValue: 1_000_000, feeResponsibility: 'BUYER', isKahadePlus: false });
      const plus     = service.calculateFee({ orderValue: 1_000_000, feeResponsibility: 'BUYER', isKahadePlus: true  });
      expect(plus.feeAmount).toBeLessThan(standard.feeAmount);
      expect(standard.feeAmount).toBe(plus.feeAmount * BigInt(5)); // 250bps / 50bps = 5×
    });

    it('should satisfy buyerPayAmount = orderValue + buyerFee invariant', () => {
      const result = service.calculateFee({ orderValue: 1_000_000, feeResponsibility: 'BUYER', isKahadePlus: false });
      const orderSen = BigInt(1_000_000) * BigInt(100); // toSen
      expect(result.buyerPayAmount).toBe(orderSen + result.buyerFeeAmount);
    });

    it('should satisfy sellerReceiveAmount = orderValue - sellerFee invariant', () => {
      const result = service.calculateFee({ orderValue: 1_000_000, feeResponsibility: 'SELLER', isKahadePlus: false });
      const orderSen = BigInt(1_000_000) * BigInt(100);
      expect(result.sellerReceiveAmount).toBe(orderSen - result.sellerFeeAmount);
    });

    it('should reduce fee by voucher discount amount', () => {
      const noVoucher = service.calculateFee({ orderValue: 1_000_000, feeResponsibility: 'BUYER', isKahadePlus: false });
      const withVoucher = service.calculateFee({ orderValue: 1_000_000, feeResponsibility: 'BUYER', isKahadePlus: false, voucherDiscount: 5_000 });
      expect(withVoucher.feeAmount).toBeLessThan(noVoucher.feeAmount);
    });

    it('should floor fee at zero when voucher discount exceeds fee', () => {
      const result = service.calculateFee({ orderValue: 10_000, feeResponsibility: 'BUYER', isKahadePlus: false, voucherDiscount: 1_000_000 });
      expect(result.feeAmount).toBe(BigInt(0));
    });

    it('should handle zero-value order without throwing', () => {
      expect(() => service.calculateFee({ orderValue: 0, feeResponsibility: 'BUYER', isKahadePlus: false })).not.toThrow();
    });

    it('should handle large order amounts (100 juta)', () => {
      const result = service.calculateFee({ orderValue: 100_000_000, feeResponsibility: 'BUYER', isKahadePlus: false });
      expect(result.feeAmount).toBeGreaterThan(BigInt(0));
    });

    it('should clamp tiny orders (Rp 1) to MIN fee of Rp 5.000 for non-Plus', () => {
      const result = service.calculateFee({ orderValue: 1, feeResponsibility: 'BUYER', isKahadePlus: false });
      expect(result.feeAmount).toBe(BigInt(500_000)); // Rp 5.000
    });

    it('should keep feeAmount = 0 when zero-value order regardless of responsibility', () => {
      ['BUYER', 'SELLER', 'SPLIT'].forEach((r) => {
        const result = service.calculateFee({ orderValue: 0, feeResponsibility: r as 'BUYER' | 'SELLER' | 'SPLIT', isKahadePlus: false });
        expect(result.feeAmount).toBe(BigInt(0));
        expect(result.buyerPayAmount).toBe(BigInt(0));
        expect(result.sellerReceiveAmount).toBe(BigInt(0));
      });
    });

    it('should handle odd-sen SPLIT fee without losing or gaining sen', () => {
      // Rp 1 order → 100 sen, fee = 1n sen (odd). buyer gets 0n, seller absorbs 1n.
      const result = service.calculateFee({ orderValue: 1, feeResponsibility: 'SPLIT', isKahadePlus: false });
      expect(result.buyerFeeAmount + result.sellerFeeAmount).toBe(result.feeAmount);
    });

    it('should clamp very large order value to MAX fee of Rp 250.000', () => {
      const result = service.calculateFee({ orderValue: 1_000_000_000, feeResponsibility: 'BUYER', isKahadePlus: false });
      // 2.5% of 1B = Rp 25.000.000, clamped DOWN to Rp 250.000 = 25_000_000 sen
      expect(result.feeAmount).toBe(BigInt(25_000_000));
      expect(result.buyerPayAmount).toBe(BigInt(100_000_000_000) + BigInt(25_000_000));
    });

    it('should not allow voucher to create negative fee (floor at zero)', () => {
      const result = service.calculateFee({ orderValue: 1, feeResponsibility: 'BUYER', isKahadePlus: false, voucherDiscountSen: BigInt(999_999) });
      expect(result.feeAmount).toBe(BigInt(0));
      expect(result.buyerFeeAmount).toBe(BigInt(0));
    });

    it('should produce correct buyerPayAmount and sellerReceiveAmount for SPLIT', () => {
      const orderValue = 100_000;
      const result = service.calculateFee({ orderValue, feeResponsibility: 'SPLIT', isKahadePlus: false });
      const orderSen = BigInt(orderValue) * BigInt(100);
      expect(result.buyerPayAmount).toBe(orderSen + result.buyerFeeAmount);
      expect(result.sellerReceiveAmount).toBe(orderSen - result.sellerFeeAmount);
    });
  });

  describe('getFeeRate', () => {
    it('should return 2.5 for standard rate', () => {
      expect(service.getFeeRate(false)).toBe(2.5);
    });

    it('should return 0.5 for KahadePlus rate', () => {
      expect(service.getFeeRate(true)).toBe(0.5);
    });
  });
});
