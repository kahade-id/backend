/**
 * GAP-D retur — modul NestJS (G201–G225).
 *
 * Mendaftarkan controller (buyer/seller + admin) dan provider retur.
 * Terdaftar di app.module.ts (wiring integrasi).
 *
 * Dependensi: PrismaModule (global), UploadModule, AuditLogModule,
 * RedisModule (untuk UserThrottleGuard), ScheduleModule (sudah forRoot di
 * app.module — mengaktifkan @Cron di ReturnsSlaService).
 */
import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { RedisModule } from '../../redis/redis.module';
import { UploadModule } from '../upload/upload.module';
import { AuditLogModule } from '../../common/services/audit-log.module';
// INTEGRATION-FIX: WalletTxSerialService dipakai dari singleton WalletModule
// (di-export), bukan didaftarkan ulang.
import { WalletModule } from '../wallet/wallet.module';
import { ReturnsController } from './returns.controller';
import { AdminReturnsController } from './admin-returns.controller';
import { ReturnsService } from './returns.service';
import { ReturnsNotifyService } from './returns-notify.service';
import { ReturnsRefundService } from './returns-refund.service';
import { ReturnsSlaService } from './returns-sla.service';

@Module({
  imports: [PrismaModule, RedisModule, UploadModule, AuditLogModule, WalletModule],
  controllers: [ReturnsController, AdminReturnsController],
  providers: [
    ReturnsService,
    ReturnsNotifyService,
    ReturnsRefundService,
    ReturnsSlaService,
  ],
  exports: [ReturnsService, ReturnsRefundService],
})
export class ReturnsModule {}
