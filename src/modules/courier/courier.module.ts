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
import { UploadModule } from '../upload/upload.module';
import { QueueModule } from '../queue/queue.module';

@Module({
  imports: [ConfigModule, UploadModule, QueueModule],
  controllers: [CourierController, CourierWebhookController, CourierAdminController],
  // NOTE: MockCourierProvider TIDAK didaftarkan di sini — ia di-instantiate
  // manual oleh CourierRegistry via `new MockCourierProvider(code)` karena
  // constructor-nya butuh argumen `code` (bukan dependency injection).
  providers: [CourierService, CourierConfigService, CourierRegistry],
  exports: [CourierService, CourierRegistry],
})
export class CourierModule {}
