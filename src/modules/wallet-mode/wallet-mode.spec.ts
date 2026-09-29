import { ForbiddenException } from '@nestjs/common';
import { WalletModeService } from './wallet-mode.service';
import { WalletKillSwitchGuard } from './wallet-kill-switch.guard';

/**
 * Misi tanpa-wallet (BI-safe): kill-switch WALLET_ENABLED.
 * Default false (fail-closed) — wallet hanya hidup via opt-in eksplisit.
 */
describe('WalletModeService', () => {
  const build = (envValue: boolean | undefined, opsValue: string | undefined) => {
    const config = { get: jest.fn((key: string) => (key === 'app.walletEnabled' ? envValue : undefined)) };
    const opsSettings = { get: jest.fn(() => opsValue) };
    return new WalletModeService(config as never, opsSettings as never);
  };

  it('default: wallet NONAKTIF bila env & ops-setting kosong', () => {
    expect(build(undefined, undefined).isWalletEnabled()).toBe(false);
  });

  it('default: wallet NONAKTIF bila env false', () => {
    expect(build(false, undefined).isWalletEnabled()).toBe(false);
  });

  it('aktif bila env WALLET_ENABLED=true', () => {
    expect(build(true, undefined).isWalletEnabled()).toBe(true);
  });

  it('aktif bila ops-setting WALLET_ENABLED=true (tanpa restart)', () => {
    expect(build(false, 'true').isWalletEnabled()).toBe(true);
  });

  it('tetap nonaktif untuk nilai ops-setting selain "true"', () => {
    expect(build(false, '1').isWalletEnabled()).toBe(false);
    expect(build(false, 'TRUEE').isWalletEnabled()).toBe(false);
    expect(build(false, '').isWalletEnabled()).toBe(false);
  });

  it('fail-closed bila ops-settings melempar', () => {
    const config = { get: jest.fn(() => false) };
    const opsSettings = {
      get: jest.fn(() => {
        throw new Error('DB down');
      }),
    };
    const svc = new WalletModeService(config as never, opsSettings as never);
    expect(svc.isWalletEnabled()).toBe(false);
  });
});

describe('WalletKillSwitchGuard', () => {
  const buildGuard = (enabled: boolean) => {
    const mode = { isWalletEnabled: jest.fn(() => enabled) };
    return new WalletKillSwitchGuard(mode as never);
  };

  it('melewatkan request bila wallet aktif', () => {
    expect(buildGuard(true).canActivate({} as never)).toBe(true);
  });

  it('fail-closed 403 WALLET_DISABLED bila wallet nonaktif', () => {
    expect(() => buildGuard(false).canActivate({} as never)).toThrow(ForbiddenException);
    try {
      buildGuard(false).canActivate({} as never);
      fail('harus melempar');
    } catch (e) {
      const res = (e as ForbiddenException).getResponse() as { code?: string };
      expect(res.code).toBe('WALLET_DISABLED');
    }
  });
});
