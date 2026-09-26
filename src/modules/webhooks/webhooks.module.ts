import { Module } from '@nestjs/common';
import { FlashWebhookController } from './flash-webhook.controller';
import { SubscriptionsModule } from '../subscriptions/subscriptions.module';

@Module({
  imports: [SubscriptionsModule],
  controllers: [FlashWebhookController],
})
export class WebhooksModule {}
