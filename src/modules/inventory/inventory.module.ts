/**
 * inventory.module.ts — modul katalog & persediaan terpisah (G251–G275).
 *
 * TIDAK mengubah perilaku order/wallet/showcase existing. Hook dari alur
 * order memakai safe* wrapper yang tidak pernah throw (lihat inventory.service).
 *
 * WIRING KOORDINATOR: tambahkan InventoryModule ke imports AppModule.
 * OrdersModule & SchedulerModule mengimpor modul ini untuk hook G256/G257
 * (injeksi @Optional() — aman bila modul belum terdaftar).
 */
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { InventoryService } from './inventory.service';
import { InventoryNotifyService } from './inventory-notify.service';
import { ProductsController } from './products.controller';
import { InventoryController } from './inventory.controller';
import { InventoryAdminController } from './inventory-admin.controller';
import { QueueModule } from '../queue/queue.module';

@Module({
  imports: [ConfigModule, QueueModule],
  controllers: [ProductsController, InventoryController, InventoryAdminController],
  providers: [InventoryService, InventoryNotifyService],
  exports: [InventoryService],
})
export class InventoryModule {}
