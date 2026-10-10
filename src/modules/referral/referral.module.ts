import { Module } from '@nestjs/common';
import { ReferralController } from './referral.controller';
import { ReferralService } from './referral.service';
import { WalletModule } from '../wallet/wallet.module';
// M4 no-wallet: payout referral via disbursement DANA bila wallet mati.
import { NoWalletModule } from '../no-wallet/no-wallet.module';
import { WalletModeModule } from '../wallet-mode/wallet-mode.module';
// Audit referral 2026-10-10 (B13): notifikasi REFERRAL_REWARD_RECEIVED.
import { QueueModule } from '../queue/queue.module';

@Module({
  imports: [WalletModule, NoWalletModule, WalletModeModule, QueueModule],
  controllers: [ReferralController],
  providers: [ReferralService],
  exports: [ReferralService],
})
export class ReferralModule {}
