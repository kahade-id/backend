// GAP-F (G452-G475): Public Partner API & outbound webhooks module.
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { BullModule } from '@nestjs/bull';
import { RedisModule } from '../../redis/redis.module';
import { PARTNER_WEBHOOK_QUEUE } from './partner.constants';
import { PartnerClientService } from './partner-client.service';
import { PartnerApiService } from './partner-api.service';
import { PartnerUsageService } from './partner-usage.service';
import { PartnerWebhookService } from './partner-webhook.service';
import { PartnerWebhookProcessor } from './partner-webhook.processor';
import { PartnerApiKeyGuard } from './partner-api-key.guard';
import { PartnerScopeGuard } from './partner-scope.guard';
import { PartnerRateLimitGuard } from './partner-rate-limit.guard';
import { PartnerUsageInterceptor } from './partner-usage.interceptor';
import { PartnerController } from './partner.controller';
import { PartnerSandboxController } from './partner-sandbox.controller';
import { AdminPartnerController } from './admin-partner.controller';

@Module({
  imports: [
    ConfigModule,
    RedisModule,
    BullModule.registerQueue({
      name: PARTNER_WEBHOOK_QUEUE,
      settings: { stalledInterval: 30_000, maxStalledCount: 1 },
      // Retries are scheduled manually (exact 1m/5m/15m/1h/6h schedule), so Bull
      // itself does a single attempt per job.
      defaultJobOptions: {
        attempts: 1,
        timeout: 60_000,
        removeOnComplete: 100,
        removeOnFail: 50,
      },
    }),
  ],
  controllers: [PartnerController, PartnerSandboxController, AdminPartnerController],
  providers: [
    PartnerClientService,
    PartnerApiService,
    PartnerUsageService,
    PartnerWebhookService,
    PartnerWebhookProcessor,
    PartnerApiKeyGuard,
    PartnerScopeGuard,
    PartnerRateLimitGuard,
    PartnerUsageInterceptor,
  ],
  exports: [PartnerWebhookService],
})
export class PartnerModule {}
