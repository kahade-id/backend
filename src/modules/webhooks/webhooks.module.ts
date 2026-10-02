import { Module } from '@nestjs/common';
import { FlashWebhookController } from './flash-webhook.controller';
import { DanaWebhookController } from './dana-webhook.controller';
import { DanaWebhookSettlementService } from './dana-webhook-settlement.service';
import { DanaWebhookDisbursementService } from './dana-webhook-disbursement.service';
import { SubscriptionsModule } from '../subscriptions/subscriptions.module';
import { PaymentModule } from '../payment/payment.module';
import { WalletModule } from '../wallet/wallet.module';
import { NoWalletModule } from '../no-wallet/no-wallet.module';
import { WalletModeModule } from '../wallet-mode/wallet-mode.module';
import { RedisModule } from '../../redis/redis.module';

@Module({
  imports: [SubscriptionsModule, PaymentModule, WalletModule, NoWalletModule, WalletModeModule, RedisModule],
  controllers: [FlashWebhookController, DanaWebhookController],
  providers: [DanaWebhookSettlementService, DanaWebhookDisbursementService],
})
export class WebhooksModule {}
