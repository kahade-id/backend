import { Module } from '@nestjs/common';
import { AdminOrdersController } from './admin-orders.controller';
import { AdminOrdersService } from './admin-orders.service';
import { AuditLogModule } from '../../../common/services/audit-log.module';
import { OrdersModule } from '../../orders/orders.module';
import { WalletModule } from '../../wallet/wallet.module';
import { ReferralModule } from '../../referral/referral.module';

@Module({
  imports: [AuditLogModule, OrdersModule, WalletModule, ReferralModule],
  controllers: [AdminOrdersController],
  providers: [AdminOrdersService],
})
export class AdminOrdersModule {}
