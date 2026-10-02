/**
 * courier-refund-validation.spec.ts — SYS-B-501: unit test terpusat untuk
 * validateShippingRefundAmount. cap = costBase − refundedAmount; semua
 * nominal refund ongkir (request, decide-APPROVED, mark-paid, admin approve)
 * wajib lewat fungsi ini.
 */
import { BadRequestException } from '@nestjs/common';
import { validateShippingRefundAmount } from '../courier.service';

const ship = (costBase: bigint, refundedAmount: bigint) => ({ costBase, refundedAmount });

describe('validateShippingRefundAmount (SYS-B-501)', () => {
  it('nominal = 10x biaya → 400 BadRequestException', () => {
    expect(() => validateShippingRefundAmount(ship(10_000n, 0n), 100_000n)).toThrow(BadRequestException);
  });

  it('nominal tepat di batas sisa (cap) → lolos', () => {
    expect(() => validateShippingRefundAmount(ship(10_000n, 0n), 10_000n)).not.toThrow();
  });

  it('nominal di atas sisa sebagian yang sudah di-refund → 400', () => {
    // costBase 10.000, sudah di-refund 7.000 → sisa 3.000; ajukan 3.001.
    expect(() => validateShippingRefundAmount(ship(10_000n, 7_000n), 3_001n)).toThrow(BadRequestException);
    expect(() => validateShippingRefundAmount(ship(10_000n, 7_000n), 3_000n)).not.toThrow();
  });

  it('refundedAmount == costBase (sisa 0) → refund berapapun 400', () => {
    expect(() => validateShippingRefundAmount(ship(10_000n, 10_000n), 1n)).toThrow(BadRequestException);
  });

  it('amount 0 atau negatif → 400 (bukan 500)', () => {
    expect(() => validateShippingRefundAmount(ship(10_000n, 0n), 0n)).toThrow(BadRequestException);
    expect(() => validateShippingRefundAmount(ship(10_000n, 0n), -5n)).toThrow(BadRequestException);
  });

  it('anomali data refundedAmount > costBase (sisa negatif) → 400 fail-closed', () => {
    expect(() => validateShippingRefundAmount(ship(10_000n, 12_000n), 1n)).toThrow(BadRequestException);
  });

  it('batas 1 sen di atas cap → 400 (off-by-one guard)', () => {
    expect(() => validateShippingRefundAmount(ship(50_000n, 0n), 50_001n)).toThrow(BadRequestException);
  });
});
