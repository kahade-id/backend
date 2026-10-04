import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bull';
import { PrismaModule } from '../../prisma/prisma.module';
import { RedisModule } from '../../redis/redis.module';
import { MilestonesModule } from '../milestones/milestones.module';
import { OrdersModule } from '../orders/orders.module';

import { ProductCommerceService } from './services/product-commerce.service';
import { SearchTrendsService } from './services/search-trends.service';
import { SellerVouchersService } from './services/seller-vouchers.service';
import { InstallmentsService } from './services/installments.service';
import { ServiceBookingService } from './services/service-booking.service';
import { AgreementsService } from './services/agreements.service';
import { DigitalDeliveryService } from './services/digital-delivery.service';
import { JastipService } from './services/jastip.service';
import { PatunganService } from './services/patungan.service';
import { BannersService } from './services/banners.service';
import { CommerceSchedulerService } from './services/commerce-scheduler.service';
import { CommerceRefundService } from './services/commerce-refund.service';
import { CommerceRefundProcessor, COMMERCE_REFUND_QUEUE } from './processors/commerce-refund.processor';

import { ProductCommerceController } from './controllers/product-commerce.controller';
import { SearchTrendsController } from './controllers/search-trends.controller';
import { SellerVouchersController } from './controllers/seller-vouchers.controller';
import { InstallmentsController } from './controllers/installments.controller';
import { ServiceBookingController } from './controllers/service-booking.controller';
import { AgreementsController } from './controllers/agreements.controller';
import { DigitalDeliveryController } from './controllers/digital-delivery.controller';
import { JastipController } from './controllers/jastip.controller';
import { PatunganController } from './controllers/patungan.controller';
import { BannersController } from './controllers/banners.controller';
import { AdminBannersController } from './controllers/admin-banners.controller';
import { AdminGroupBuyingController } from './controllers/admin-group-buying.controller';
import { AdminJastipTripsController } from './controllers/admin-jastip-trips.controller';
import { AdminServiceBookingsController } from './controllers/admin-service-bookings.controller';
import { AdminSellerVouchersController } from './controllers/admin-seller-vouchers.controller';
import { AdminCommerceRefundsController } from './controllers/admin-commerce-refunds.controller';

/**
 * BE-COMMERCE (2026-10-01): modul commerce mega-batch.
 * - productType/harga coret/statistik/badge (item 1,5,7,8)
 * - trending keywords (6), voucher seller (9), cicilan via milestone (3),
 *   booking jasa (10), SPK ringan (11), digital delivery (12),
 *   jastip (13), patungan (14), banner (15)
 * - cron: scheduled publish etalase + deadline jastip/patungan (4)
 *
 * MilestonesModule & OrdersModule diimpor hanya untuk memakai service yang
 * SUDAH ADA (createMilestones, OrderStateService.cancelOrder) — tidak ada
 * logika uang/escrow baru di modul ini.
 */
@Module({
  imports: [
    PrismaModule,
    RedisModule,
    MilestonesModule,
    OrdersModule,
    // M2: antrean Bull untuk auto-refund REFUND_REQUIRED (repeatable tiap 5 menit).
    BullModule.registerQueue({
      name: COMMERCE_REFUND_QUEUE,
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 5000 },
        removeOnComplete: 20,
        removeOnFail: 20,
      },
    }),
  ],
  controllers: [
    ProductCommerceController,
    SearchTrendsController,
    SellerVouchersController,
    InstallmentsController,
    ServiceBookingController,
    AgreementsController,
    DigitalDeliveryController,
    JastipController,
    PatunganController,
    BannersController,
    AdminBannersController,
    AdminGroupBuyingController,
    AdminJastipTripsController,
    AdminServiceBookingsController,
    AdminSellerVouchersController,
    AdminCommerceRefundsController,
  ],
  providers: [
    ProductCommerceService,
    SearchTrendsService,
    SellerVouchersService,
    InstallmentsService,
    ServiceBookingService,
    AgreementsService,
    DigitalDeliveryService,
    JastipService,
    PatunganService,
    BannersService,
    CommerceSchedulerService,
    CommerceRefundService,
    CommerceRefundProcessor,
  ],
  exports: [ProductCommerceService, SearchTrendsService, BannersService],
})
export class CommerceModule {}
