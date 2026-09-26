/**
 * Batch 8 — FX-010: batas nominal dompet kanonis dari server.
 * `GET /v1/wallet/limits` harus mengembalikan constraint EFEKTIF yang
 * benar-benar mengikat (DTO statis ∩ guard env service), bukan salinan
 * yang bisa drift. Semua nilai integer IDR.
 */
import { WalletService } from '../wallet.service';

function makeService(env: Record<string, number> = {}) {
  const config = {
    get: jest.fn((key: string) => {
      if (key === 'app.walletPinPepper') return 'test-pepper-untuk-uji';
      const map: Record<string, string> = {
        'app.walletMinWithdraw': 'walletMinWithdraw',
        'app.walletMaxWithdrawPerTx': 'walletMaxWithdrawPerTx',
        'app.walletDailyTopupLimit': 'walletDailyTopupLimit',
      };
      const envKey = map[key];
      if (envKey && env[envKey] !== undefined) return env[envKey];
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

describe('Batch 8 — FX-010 getWalletLimits', () => {
  it('mengembalikan default saat env tidak di-override', () => {
    const service = makeService();
    expect(service.getWalletLimits()).toEqual({
      withdraw: { minimum: 50000, maximum: 25000000 },
      topup: { minimum: 10000, maximum: 50000000 },
      transfer: { minimum: 1000, maximum: 25000000 },
      currency: 'IDR',
    });
  });

  it('maksimum withdraw = min(batas DTO statis, guard env) — bukan salinan 50jt', () => {
    // Frontend statis mengira maksimum 50jt; server efektif 25jt (default).
    const service = makeService();
    const limits = service.getWalletLimits();
    expect(limits.withdraw.maximum).toBe(25000000);
    expect(limits.withdraw.maximum).toBeLessThan(50000000);
  });

  it('menghormati override env (lebih ketat)', () => {
    const service = makeService({ walletMinWithdraw: 100000, walletMaxWithdrawPerTx: 10000000 });
    const limits = service.getWalletLimits();
    expect(limits.withdraw).toEqual({ minimum: 100000, maximum: 10000000 });
  });

  it('semua nilai integer aman', () => {
    const service = makeService({ walletMinWithdraw: 75000 });
    const limits = service.getWalletLimits();
    const values = [
      limits.withdraw.minimum,
      limits.withdraw.maximum,
      limits.topup.minimum,
      limits.topup.maximum,
      limits.transfer.minimum,
      limits.transfer.maximum,
    ];
    for (const v of values) {
      expect(Number.isSafeInteger(v)).toBe(true);
      expect(v).toBeGreaterThan(0);
    }
    expect(limits.withdraw.minimum).toBeLessThanOrEqual(limits.withdraw.maximum);
  });
});
