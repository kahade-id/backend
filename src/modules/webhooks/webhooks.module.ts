import { Module } from '@nestjs/common';
import { FlashWebhookController } from './flash-webhook.controller';
import { DanaWebhookController } from './dana-webhook.controller';
import { DanaWebhookSettlementService } from './dana-webhook-settlement.service';
import { SubscriptionsModule } from '../subscriptions/subscriptions.module';
import { PaymentModule } from '../payment/payment.module';
import { WalletModule } from '../wallet/wallet.module';

@Module({
  imports: [SubscriptionsModule, PaymentModule, WalletModule],
  controllers: [FlashWebhookController, DanaWebhookController],
  providers: [DanaWebhookSettlementService],
})
export class WebhooksModule {}
