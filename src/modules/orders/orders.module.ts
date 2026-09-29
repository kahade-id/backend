import { Module, forwardRef } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { OrdersController } from './orders.controller';
import { OrdersService } from './orders.service';
import { FeeCalculatorService } from './fee-calculator.service';
import { OrderStateService } from './order-state.service';
import { OrderExtensionsService } from './order-extensions.service';
import { OrderLinksService } from './order-links.service';
import { DeliveryProofService } from './delivery-proof.service';
import { InvoiceService } from './invoice.service';
import { ReceiptService } from './receipt.service';
import { MembershipRankService } from './membership-rank.service';
import { UnshippedOrderCancelService } from './unshipped-order-cancel.service';
import { WalletModule } from '../wallet/wallet.module';
import { RedisModule } from '../../redis/redis.module';
import { WalletTxSerialService } from '../../common/services/wallet-tx-serial.service';
import { ReferralModule } from '../referral/referral.module';
import { DisputesModule } from '../disputes/disputes.module';
import { RealtimeModule } from '../realtime/realtime.module';
import { UploadModule } from '../upload/upload.module';
import { AuditLogModule } from '../../common/services/audit-log.module';
import { QueueModule } from '../queue/queue.module';
import { PaymentModule } from '../payment/payment.module';
import { SubscriptionsModule } from '../subscriptions/subscriptions.module';
// GAP-D (G256/G257): hook reservasi stok katalog — @Optional() di OrderStateService,
// aman bila modul belum ter-import; tidak mengubah perilaku order existing.
import { InventoryModule } from '../inventory/inventory.module';
import { NoWalletModule } from '../no-wallet/no-wallet.module';
import { WalletModeModule } from '../wallet-mode/wallet-mode.module';

@Module({
  imports: [ConfigModule, WalletModule, RedisModule, ReferralModule, forwardRef(() => DisputesModule), RealtimeModule, UploadModule, AuditLogModule, QueueModule, PaymentModule, SubscriptionsModule, InventoryModule, NoWalletModule, WalletModeModule],
  controllers: [OrdersController],
  providers: [OrdersService, FeeCalculatorService, OrderStateService, OrderExtensionsService, OrderLinksService, DeliveryProofService, InvoiceService, ReceiptService, MembershipRankService, WalletTxSerialService, UnshippedOrderCancelService],
  exports: [OrdersService, FeeCalculatorService, OrderStateService, OrderExtensionsService, OrderLinksService, DeliveryProofService, InvoiceService, ReceiptService, MembershipRankService, UnshippedOrderCancelService],
})
export class OrdersModule {}
