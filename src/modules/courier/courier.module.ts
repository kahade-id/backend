/**
 * courier.module.ts — modul logistik terpisah (G226–G250).
 *
 * Tidak mengubah perilaku order/wallet existing. Webhook controller memakai
 * rawBody (diaktifkan di main.ts via NestFactory.create(..., { rawBody: true })).
 */
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { CourierController } from './courier.controller';
import { CourierWebhookController } from './courier-webhook.controller';
import { CourierAdminController } from './courier-admin.controller';
import { CourierService } from './courier.service';
import { CourierConfigService } from './courier.config';
import { CourierRegistry } from './providers/courier-registry';
import { MockCourierProvider } from './providers/mock-courier.provider';
import { UploadModule } from '../upload/upload.module';
import { QueueModule } from '../queue/queue.module';

@Module({
  imports: [ConfigModule, UploadModule, QueueModule],
  controllers: [CourierController, CourierWebhookController, CourierAdminController],
  providers: [CourierService, CourierConfigService, CourierRegistry, MockCourierProvider],
  exports: [CourierService, CourierRegistry],
})
export class CourierModule {}
