import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { SubscriptionsController } from './subscriptions.controller';
import { SubscriptionsService } from './subscriptions.service';
import { WalletModule } from '../wallet/wallet.module';
import { AuditLogModule } from '../../common/services/audit-log.module';

@Module({
  imports: [PrismaModule, WalletModule, AuditLogModule],
  controllers: [SubscriptionsController],
  providers: [SubscriptionsService],
  exports: [SubscriptionsService],
})
export class SubscriptionsModule {}
