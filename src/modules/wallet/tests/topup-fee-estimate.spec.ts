/**
 * Batch 8 (MONEY) — WF-008: estimasi fee/total top-up kanonis dari server.
 * Memastikan angka memakai logika yang SAMA dengan jalur charge (calculatePaymentFee),
 * sehingga client tidak perlu menghitung ulang total yang dibayar.
 */
import { BadRequestException } from '@nestjs/common';
import { WalletService } from '../wallet.service';

function makeService() {
  const config = {
    get: jest.fn((key: string) => {
      if (key === 'app.walletPinPepper') return 'test-pepper-untuk-uji';
      return undefined;
    }),
  };
  return new WalletService(
    {} as never,
    {} as never,
    config as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    undefined as never,
  );
}

describe('Batch 8 money — WF-008 estimateTopupFee', () => {
  it('mengembalikan fee + total kanonis untuk QRIS (0.7% default, ceiling)', () => {
    const service = makeService();
    // feeFromBps(100000, 70): 100000*70/10000 = 700 pas → fee 700
    const result = service.estimateTopupFee(100000, 'QRIS');
    expect(result).toEqual({
      amount: 100000,
      method: 'QRIS',
      fee: 700,
      total: 100700,
      currency: 'IDR',
    });
  });

  it('fee memakai ceiling division seperti jalur charge (tidak under-charge)', () => {
    const service = makeService();
    // 99999 * 70 / 10000 = 699.993 → ceiling 700
    const result = service.estimateTopupFee(99999, 'QRIS');
    expect(result.fee).toBe(700);
    expect(result.total).toBe(99999 + 700);
  });

  it('menolak payment method yang tidak dikenal', () => {
    const service = makeService();
    expect(() => service.estimateTopupFee(100000, 'TIDAK_ADA')).toThrow(BadRequestException);
  });

  it('menolak nominal di luar rentang metode', () => {
    const service = makeService();
    expect(() => service.estimateTopupFee(5000, 'QRIS')).toThrow(BadRequestException); // < min 10000
    expect(() => service.estimateTopupFee(20000000, 'QRIS')).toThrow(BadRequestException); // > max 10jt
  });

  it('menolak nominal non-integer / non-positif', () => {
    const service = makeService();
    expect(() => service.estimateTopupFee(100000.5, 'QRIS')).toThrow(BadRequestException);
    expect(() => service.estimateTopupFee(0, 'QRIS')).toThrow(BadRequestException);
    expect(() => service.estimateTopupFee(-1000, 'QRIS')).toThrow(BadRequestException);
  });
});
