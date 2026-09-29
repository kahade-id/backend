import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { WalletModeService } from './wallet-mode.service';

/**
 * Kill-switch wallet internal (BI-safe).
 *
 * Dipasang di controller endpoint wallet yang user-facing. Saat
 * `WALLET_ENABLED` false (default), request ditolak fail-closed:
 *   403 WALLET_DISABLED
 *
 * KODE WALLET TIDAK DIHAPUS — hanya dinonaktifkan lewat guard terpusat ini.
 */
@Injectable()
export class WalletKillSwitchGuard implements CanActivate {
  constructor(private readonly walletMode: WalletModeService) {}

  canActivate(_context: ExecutionContext): boolean {
    if (!this.walletMode.isWalletEnabled()) {
      throw new ForbiddenException({
        code: 'WALLET_DISABLED',
        message:
          'Wallet internal sedang nonaktif (mode BI-safe). ' +
          'Pembayaran berjalan langsung via DANA tanpa saldo wallet.',
      });
    }
    return true;
  }
}
