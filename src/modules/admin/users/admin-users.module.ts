import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { BullModule } from '@nestjs/bull';
import { AdminUsersController } from './admin-users.controller';
import { AdminUsersService } from './admin-users.service';
import { RedisModule } from '../../../redis/redis.module';
import { AuditLogModule } from '../../../common/services/audit-log.module';
import { WalletTxSerialService } from '../../../common/services/wallet-tx-serial.service';
import { AuthModule } from '../../auth/auth.module';
import { EMAIL_QUEUE } from '../../queue/processors/email.processor';

@Module({
  imports: [
    RedisModule,
    ConfigModule,
    AuditLogModule,
    AuthModule,
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
  controllers: [AdminUsersController],
  providers: [AdminUsersService, WalletTxSerialService],
})
export class AdminUsersModule {}
