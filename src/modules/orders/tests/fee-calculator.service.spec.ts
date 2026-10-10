import { Test, TestingModule } from '@nestjs/testing';
import { FeeCalculatorService } from '../fee-calculator.service';
import { ConfigService } from '@nestjs/config';
import { RedisService } from '../../../redis/redis.service';
import { MembershipRank } from '@prisma/client';

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

    it('should clamp standard fee to MIN Rp 2.500 for small orders', () => {
      // Rp 50.000 × 2.5% = Rp 1.250 → clamped UP to Rp 2.500
      const result = service.calculateFee({ orderValue: 50_000, feeResponsibility: 'BUYER', isKahadePlus: false });
      expect(result.feeAmount).toBe(BigInt(250_000)); // 250_000 sen = Rp 2.500
    });

    it('should clamp standard fee to MAX Rp 250.000 for huge orders', () => {
      // Rp 100.000.000 × 2.5% = Rp 2.500.000 → clamped DOWN to Rp 250.000
      const result = service.calculateFee({ orderValue: 100_000_000, feeResponsibility: 'BUYER', isKahadePlus: false });
      expect(result.feeAmount).toBe(BigInt(25_000_000)); // 25_000_000 sen = Rp 250.000
    });

    it('should allow Kahade Plus subscription to bring fee BELOW the Rp 2.500 floor', () => {
      // Rp 100.000 × 0.5% = Rp 500 (well below Rp 2.500 floor — allowed for Plus)
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

    it('should clamp tiny orders (Rp 1) to MIN fee of Rp 2.500 for non-Plus', () => {
      const result = service.calculateFee({ orderValue: 1, feeResponsibility: 'BUYER', isKahadePlus: false });
      expect(result.feeAmount).toBe(BigInt(250_000)); // Rp 2.500
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

    // K5 (audit transaksi 2026-10-10): fee persen atas orderValue sembarang
    // menghasilkan sen pecahan rupiah → sellerReceiveAmount SELLER/SPLIT tidak
    // bisa dicairkan DANA (INVALID_AMOUNT_SEN). Semua nominal wajib rupiah utuh.
    describe('K5 whole-rupiah rounding', () => {
      const isWholeRupiah = (sen: bigint) => sen % BigInt(100) === BigInt(0);

      it('rounds a fractional-rupiah standard fee (Rp100.001 × 2,5%) to whole rupiah', () => {
        const result = service.calculateFee({ orderValue: 100_001, feeResponsibility: 'SELLER', isKahadePlus: false });
        // 100_001 × 2,5% = 2500,025 → Rp2.500 → 250_000 sen
        expect(result.feeAmount).toBe(BigInt(250_000));
        expect(isWholeRupiah(result.sellerReceiveAmount)).toBe(true);
        expect(result.sellerReceiveAmount).toBe(BigInt(100_001) * BigInt(100) - BigInt(250_000));
      });

      it('keeps buyerPayAmount and sellerReceiveAmount whole rupiah for SPLIT with an odd-rupiah fee', () => {
        // 100_020 × 2,5% = 2500,5 → Rp2.501 (half-up) → split 1250 / 1251
        const result = service.calculateFee({ orderValue: 100_020, feeResponsibility: 'SPLIT', isKahadePlus: false });
        expect(result.feeAmount).toBe(BigInt(250_100));
        expect(result.buyerFeeAmount).toBe(BigInt(125_000));
        expect(result.sellerFeeAmount).toBe(BigInt(125_100));
        expect(isWholeRupiah(result.buyerPayAmount)).toBe(true);
        expect(isWholeRupiah(result.sellerReceiveAmount)).toBe(true);
      });

      it('rounds Kahade Plus fee and membership-rank discount to whole rupiah', () => {
        // 123_457 × 0,5% = 617,285 → Rp617; GOLD 5% of 617 = 30,85 → Rp31
        const result = service.calculateFee({
          orderValue: 123_457,
          feeResponsibility: 'SELLER',
          isKahadePlus: true,
          membershipRank: MembershipRank.GOLD,
        });
        expect(result.membershipRankDiscount).toBe(BigInt(3_100));
        expect(result.feeAmount).toBe(BigInt(61_700) - BigInt(3_100));
        expect(isWholeRupiah(result.sellerReceiveAmount)).toBe(true);
      });

      it('never produces fractional-rupiah seller amounts across a sweep of order values', () => {
        for (let v = 1; v < 5_000; v += 7) {
          for (const resp of ['BUYER', 'SELLER', 'SPLIT'] as const) {
            const r = service.calculateFee({ orderValue: v, feeResponsibility: resp, isKahadePlus: v % 2 === 0 });
            expect(isWholeRupiah(r.sellerReceiveAmount)).toBe(true);
            expect(isWholeRupiah(r.buyerPayAmount)).toBe(true);
            expect(r.buyerFeeAmount + r.sellerFeeAmount).toBe(r.feeAmount);
          }
        }
      });
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

    it('should apply GOLD membership discount as a separate layer after standard fee', () => {
      const result = service.calculateFee({
        orderValue: 1_000_000,
        feeResponsibility: 'BUYER',
        isKahadePlus: false,
        membershipRank: MembershipRank.GOLD,
      });

      expect(result.membershipRankDiscount).toBe(BigInt(125_000)); // 5% of Rp 25.000 fee, in sen
      expect(result.feeAmount).toBe(BigInt(2_375_000));
    });

    it('should cap DIAMOND rank discount against the fee remaining after voucher discount', () => {
      const result = service.calculateFee({
        orderValue: 1_000_000,
        feeResponsibility: 'BUYER',
        isKahadePlus: false,
        voucherDiscount: 20_000,
        membershipRank: MembershipRank.DIAMOND,
      });

      expect(result.voucherDiscount).toBe(BigInt(2_000_000));
      expect(result.membershipRankDiscount).toBe(BigInt(75_000)); // 15% of remaining Rp 5.000, in sen
      expect(result.feeAmount).toBe(BigInt(425_000));
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
