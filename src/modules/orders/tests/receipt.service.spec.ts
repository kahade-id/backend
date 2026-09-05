import { Test, TestingModule } from '@nestjs/testing';
import { ReceiptService } from '../receipt.service';
import { PrismaService } from '../../../prisma/prisma.service';

/*
 * C-10 regression: the receipt rendered the platform fee as
 * `(Number(order.feeRate) * 100).toFixed(1)`, but `Order.feeRate` already holds a
 * PERCENTAGE, not a fraction.
 *
 * `FeeCalculatorService.getFeeRate` returns `rateBps / 100` (`fee-calculator.service.ts:152`),
 * so a 150 bps config persists as `1.5`, and `fee-calculator.service.spec.ts:183` pins
 * `getFeeRate(false) === 2.5` for a 250 bps config. Every other consumer treats the stored
 * value as a ready-to-render percentage: `invoice.service.ts:53` passes it through unscaled,
 * and mobile prints it directly as `${apiResult.feeRate}%` (`app/fee-calculator.tsx:221`,
 * `app/subscription.tsx:467`). `vouchers.service.ts:215` round-trips it back to bps by
 * multiplying by 100, which only holds if the value is a percentage.
 *
 * The extra × 100 therefore printed "Platform Fee (150.0%)" on the one document a user is
 * most likely to save, print, or forward as proof of what they were charged — on an order
 * whose actual fee line, rendered two rows below from `feeAmount`, showed Rp 1.500 against a
 * Rp 100.000 order value. The percentage and the rupiah amount on the same receipt
 * contradicted each other by two orders of magnitude.
 */

const mockPrisma = { order: { findFirst: jest.fn() } };

const ORDER = {
  id: 'ord-1',
  orderId: 'ORD-2026-0100',
  buyerId: 'buyer',
  sellerId: 'seller',
  status: 'COMPLETED',
  title: 'Jasa desain logo',
  orderType: 'JASA',
  createdAt: new Date('2026-01-15T03:00:00Z'),
  completedAt: new Date('2026-01-20T03:00:00Z'),
  orderValue: BigInt(10_000_000), // Rp 100.000 in sen
  feeRate: 1.5, // 150 bps — stored as a percentage
  feeAmount: BigInt(150_000), // Rp 1.500 in sen
  buyerFeeAmount: BigInt(150_000),
  sellerFeeAmount: BigInt(0),
  buyerPayAmount: BigInt(10_150_000),
  sellerReceiveAmount: BigInt(10_000_000),
  voucherDiscount: BigInt(0),
  trackingNumber: null,
  courierName: null,
  buyer: { userId: 'U1', fullName: 'Budi', username: 'budi' },
  seller: { userId: 'U2', fullName: 'Sari', username: 'sari' },
  voucher: null,
  statusHistories: [],
};

describe('ReceiptService — platform fee percentage (C-10)', () => {
  let service: ReceiptService;

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [ReceiptService, { provide: PrismaService, useValue: mockPrisma }],
    }).compile();
    service = module.get<ReceiptService>(ReceiptService);
    mockPrisma.order.findFirst.mockResolvedValue(ORDER);
  });

  it('renders feeRate as the stored percentage, not scaled by 100', async () => {
    const html = await service.generateReceiptHtml('ORD-2026-0100', 'buyer');

    expect(html).toContain('Platform Fee (1.5%)');
    // Pre-fix this was "Platform Fee (150.0%)".
    expect(html).not.toContain('150.0%');
  });

  it('keeps the percentage consistent with the rupiah fee on the same receipt', async () => {
    const html = await service.generateReceiptHtml('ORD-2026-0100', 'buyer');

    // feeAmount / orderValue = 150_000 / 10_000_000 = 1.5%. The rendered percentage
    // must agree with the rendered amount, which is what a user cross-checks.
    const pct = /Platform Fee \(([\d.]+)%\)/.exec(html)?.[1];
    expect(pct).toBeDefined();
    const implied = (Number(ORDER.feeAmount) / Number(ORDER.orderValue)) * 100;
    expect(Number(pct)).toBeCloseTo(implied, 5);
  });

  it('renders a sub-1% Kahade Plus rate without rounding it away', async () => {
    mockPrisma.order.findFirst.mockResolvedValue({
      ...ORDER,
      feeRate: 0.5, // 50 bps
      feeAmount: BigInt(50_000),
      buyerFeeAmount: BigInt(50_000),
      buyerPayAmount: BigInt(10_050_000),
    });

    const html = await service.generateReceiptHtml('ORD-2026-0100', 'buyer');

    expect(html).toContain('Platform Fee (0.5%)');
    expect(html).not.toContain('Platform Fee (50.0%)');
  });

  // ── Controls: unchanged behaviour that must keep working ──────────────────

  it('still refuses a non-participant', async () => {
    await expect(service.generateReceiptHtml('ORD-2026-0100', 'attacker')).rejects.toThrow('Not a participant');
  });

  it('still refuses an order that is not COMPLETED or DISPUTED', async () => {
    mockPrisma.order.findFirst.mockResolvedValue({ ...ORDER, status: 'PROCESSING' });

    await expect(service.generateReceiptHtml('ORD-2026-0100', 'buyer')).rejects.toThrow(
      'Receipt only available for completed or disputed orders',
    );
  });

  it('still escapes HTML in the order title', async () => {
    mockPrisma.order.findFirst.mockResolvedValue({ ...ORDER, title: '<script>alert(1)</script>' });

    const html = await service.generateReceiptHtml('ORD-2026-0100', 'buyer');

    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });
});
