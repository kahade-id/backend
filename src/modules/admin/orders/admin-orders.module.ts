import { Module } from '@nestjs/common';
import { AdminOrdersController } from './admin-orders.controller';
import { AdminOrdersService } from './admin-orders.service';
import { AuditLogModule } from '../../../common/services/audit-log.module';
import { RedisModule } from '../../../redis/redis.module';
import { OrdersModule } from '../../orders/orders.module';
import { WalletModule } from '../../wallet/wallet.module';
import { ReferralModule } from '../../referral/referral.module';
import { DashboardModule } from '../dashboard/dashboard.module';
// M4 no-wallet: payout cashback via disbursement DANA bila wallet mati.
import { NoWalletModule } from '../../no-wallet/no-wallet.module';
import { WalletModeModule } from '../../wallet-mode/wallet-mode.module';

@Module({
  imports: [AuditLogModule, RedisModule, OrdersModule, WalletModule, ReferralModule, DashboardModule, NoWalletModule, WalletModeModule],
  controllers: [AdminOrdersController],
  providers: [AdminOrdersService],
})
export class AdminOrdersModule {}
