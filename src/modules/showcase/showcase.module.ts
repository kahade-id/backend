import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from '../../prisma/prisma.module';
import { RedisModule } from '../../redis/redis.module';
import { UploadModule } from '../upload/upload.module';
import { AuditLogModule } from '../../common/services/audit-log.module';
import { VerificationBadgeModule } from '../users/verification-badge.module';
import { ShowcaseController } from './showcase.controller';
import { ShowcaseService } from './showcase.service';
import { HighlightsController } from './highlights/highlights.controller';
import { HighlightsService } from './highlights/highlights.service';
import { SubscriptionsModule } from '../subscriptions/subscriptions.module';
import { AdminShowcaseReportsModule } from '../admin/showcase-reports/admin-showcase-reports.module';

/**
 * Section 3 — Showcase sebagai konten sosial + feed discover.
 *
 * UploadModule diimpor karena gambar showcase memakai alur presigned upload
 * (purpose SHOWCASE_IMAGE) dan validasinya terpusat di UploadService.
 * `ShowcaseService` di-export supaya UsersController (CRUD owner di
 * /users/me/showcase*) dan DeepLinksController (halaman share) bisa memakainya
 * tanpa memindahkan route lama.
 *
 * AdminShowcaseReportsModule diimpor agar service moderasi
 * (AdminShowcaseReportsService) tersedia bila dibutuhkan modul ini; tidak ada
 * siklus dependensi (modul admin hanya bergantung pada AuditLogModule).
 *
 * SYS-D-002 (2026-10-03): endpoint banding user-facing
 * (POST|GET /v1/showcase/:id/appeals, ShowcaseAppealsController) dihapus —
 * tidak ada pemanggil di FE. Logika banding (fileAppeal/listOwnAppeals) tetap
 * hidup di AdminShowcaseReportsService untuk jalur admin.
 */
@Module({
  imports: [ConfigModule, PrismaModule, RedisModule, UploadModule, AuditLogModule, VerificationBadgeModule, SubscriptionsModule, AdminShowcaseReportsModule],
  controllers: [ShowcaseController, HighlightsController],
  providers: [ShowcaseService, HighlightsService],
  exports: [ShowcaseService, HighlightsService],
})
export class ShowcaseModule {}
