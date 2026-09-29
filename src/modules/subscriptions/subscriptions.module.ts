import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { SubscriptionsController } from './subscriptions.controller';
import { SubscriptionsService } from './subscriptions.service';
import { WalletModule } from '../wallet/wallet.module';
import { AuditLogModule } from '../../common/services/audit-log.module';
import { VerificationBadgeModule } from '../users/verification-badge.module';
import { PaymentModule } from '../payment/payment.module';
import { NoWalletModule } from '../no-wallet/no-wallet.module';
import { WalletModeModule } from '../wallet-mode/wallet-mode.module';

@Module({
  imports: [PrismaModule, WalletModule, AuditLogModule, VerificationBadgeModule, PaymentModule, NoWalletModule, WalletModeModule],
  controllers: [SubscriptionsController],
  providers: [SubscriptionsService],
  exports: [SubscriptionsService],
})
export class SubscriptionsModule {}
