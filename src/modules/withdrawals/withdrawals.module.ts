import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduledWithdrawalsController } from './withdrawals.controller';
import { ScheduledWithdrawalService } from './scheduled-withdrawal.service';
import { WalletTxSerialService } from '../../common/services/wallet-tx-serial.service';
import { WalletModule } from '../wallet/wallet.module';
import { WalletModeModule } from '../wallet-mode/wallet-mode.module';

@Module({
  imports: [ConfigModule, WalletModule, WalletModeModule],
  controllers: [ScheduledWithdrawalsController],
  providers: [ScheduledWithdrawalService, WalletTxSerialService],
  exports: [ScheduledWithdrawalService],
})
export class WithdrawalsModule {}
