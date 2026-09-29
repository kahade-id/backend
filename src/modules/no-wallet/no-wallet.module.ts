import { Module, forwardRef } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { DanaModule } from '../payment/dana/dana.module';
import { WalletModeModule } from '../wallet-mode/wallet-mode.module';
import { WalletModule } from '../wallet/wallet.module';
import { QueueModule } from '../queue/queue.module';
import { DanaDirectPaymentService } from './dana-direct-payment.service';
import { DanaDirectRefundService } from './dana-direct-refund.service';
import { EscrowDisbursementService } from './escrow-disbursement.service';

/**
 * Misi "Mode Tanpa Wallet Internal (BI-safe)".
 *
 * Modul untuk alur uang yang TIDAK menyentuh wallet internal:
 * - DanaDirectPaymentService: checkout escrow langsung via DANA
 *   (QRIS / VA / DANA Balance — pilihan buyer, bukan hardcode).
 * - DanaDirectRefundService: refund ke metode bayar asal via DANA Refund API.
 * - EscrowDisbursementService: pencairan escrow ke rekening bank seller
 *   (DANA transfer, idempoten; HELD_NO_BANK bila seller belum punya rekening).
 * - (menyusul) LegacyPayoutService.
 *
 * forwardRef WalletModule: dipakai untuk WalletTxSerialService
 * (serial id pembayaran) — WalletModule TIDAK mengimpor modul ini
 * (guard kill-switch tinggal di WalletModeModule yang bebas siklus).
 */
@Module({
  imports: [ConfigModule, WalletModeModule, DanaModule, QueueModule, forwardRef(() => WalletModule)],
  providers: [DanaDirectPaymentService, DanaDirectRefundService, EscrowDisbursementService],
  exports: [DanaDirectPaymentService, DanaDirectRefundService, EscrowDisbursementService],
})
export class NoWalletModule {}
