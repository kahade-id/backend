import { Module } from '@nestjs/common';
import { WalletModeService } from './wallet-mode.service';
import { WalletKillSwitchGuard } from './wallet-kill-switch.guard';

/**
 * Modul kecil tanpa dependensi ke modul wallet (menghindari circular dep):
 * hanya ConfigService + OpsSettingsService (keduanya global).
 */
@Module({
  providers: [WalletModeService, WalletKillSwitchGuard],
  exports: [WalletModeService, WalletKillSwitchGuard],
})
export class WalletModeModule {}
