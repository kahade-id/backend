import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { BullModule } from '@nestjs/bull';
import { WalletController } from './wallet.controller';
import { WalletService } from './wallet.service';
import { WalletTxSerialService } from '../../common/services/wallet-tx-serial.service';
import { MidtransService } from '../payment/midtrans.service';
import { OtpService } from '../auth/otp.service';
import { WalletExportService } from './export.service';
import { RedisModule } from '../../redis/redis.module';
import { AuditLogModule } from '../../common/services/audit-log.module';
import { EMAIL_QUEUE } from '../queue/processors/email.processor';

@Module({
  imports: [
    ConfigModule,
    RedisModule,
    // and WITHDRAW_REQUESTED audit events for financial compliance trail.
    AuditLogModule,
    BullModule.registerQueue({
      name: EMAIL_QUEUE,
      settings: { stalledInterval: 30_000, maxStalledCount: 1 },
      defaultJobOptions: {
        attempts: 3,
        timeout: 120_000,
        backoff: { type: 'exponential', delay: 5_000 },
        removeOnComplete: 100,
        removeOnFail: 50,
      },
    }),
  ],
  controllers: [WalletController],
  providers: [WalletService, WalletTxSerialService, MidtransService, OtpService, WalletExportService],
  exports: [WalletService, WalletTxSerialService, WalletExportService],
})
export class WalletModule {}
