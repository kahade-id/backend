import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { WithdrawalsController } from './withdrawals.controller';
import { ScheduledWithdrawalService } from './scheduled-withdrawal.service';
import { WalletTxSerialService } from '../../common/services/wallet-tx-serial.service';

@Module({
  imports: [ConfigModule],
  controllers: [WithdrawalsController],
  providers: [ScheduledWithdrawalService, WalletTxSerialService],
  exports: [ScheduledWithdrawalService],
})
export class WithdrawalsModule {}
