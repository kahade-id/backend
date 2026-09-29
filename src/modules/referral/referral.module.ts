import { Module } from '@nestjs/common';
import { ReferralController } from './referral.controller';
import { ReferralService } from './referral.service';
import { WalletModule } from '../wallet/wallet.module';
// M4 no-wallet: payout referral via disbursement DANA bila wallet mati.
import { NoWalletModule } from '../no-wallet/no-wallet.module';
import { WalletModeModule } from '../wallet-mode/wallet-mode.module';

@Module({
  imports: [WalletModule, NoWalletModule, WalletModeModule],
  controllers: [ReferralController],
  providers: [ReferralService],
  exports: [ReferralService],
})
export class ReferralModule {}
