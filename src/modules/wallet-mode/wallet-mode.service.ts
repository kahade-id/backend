import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OpsSettingsService } from '../ops-settings/ops-settings.service';

/**
 * Misi "Mode Tanpa Wallet Internal (BI-safe)" — kill-switch terpusat.
 *
 * Kahade BELUM punya izin BI sebagai penerbit uang elektronik, jadi wallet
 * internal (saldo user, top-up, tarik ke wallet) TIDAK BOLEH beroperasi saat
 * pengajuan ke DANA. Uang hanya numpang lewat:
 *   buyer → DANA → escrow → rekening bank seller.
 *
 * `isWalletEnabled()` = false KECUALI di-opt-in eksplisit via:
 *   1. env `WALLET_ENABLED=true`, ATAU
 *   2. ops-setting `WALLET_ENABLED=true` (admin panel, SUPER_ADMIN, beraudit)
 *
 * Default false (fail-closed / BI-safe). Guard `WalletKillSwitchGuard`
 * memakai layanan ini untuk mematikan endpoint wallet yang user-facing.
 */
@Injectable()
export class WalletModeService {
  private readonly logger = new Logger(WalletModeService.name);

  constructor(
    private readonly config: ConfigService,
    private readonly opsSettings: OpsSettingsService,
  ) {}

  /** true bila wallet internal diizinkan beroperasi. Default: false. */
  isWalletEnabled(): boolean {
    const fromEnv = this.config.get<boolean>('app.walletEnabled');
    if (fromEnv === true) return true;
    try {
      const fromOps = this.opsSettings.get('WALLET_ENABLED');
      if (typeof fromOps === 'string' && fromOps.trim().toLowerCase() === 'true') {
        return true;
      }
    } catch (e) {
      // Fail-closed: bila ops-settings tidak bisa dibaca, anggap wallet MATI.
      this.logger.warn(
        `Gagal membaca ops-setting WALLET_ENABLED — fail-closed (wallet dianggap nonaktif): ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
    }
    return false;
  }
}
