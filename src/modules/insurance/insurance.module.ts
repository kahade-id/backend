import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { SubscriptionsModule } from '../subscriptions/subscriptions.module';
import { InsuranceService } from './insurance.service';

/**
 * SYS-D-002 (2026-10-03): endpoint user-facing /v1/insurance/* dihapus —
 * tidak ada pemanggil di FE (klaster mati). InsuranceService dipertahankan
 * sebagai domain service (diekspor untuk dipakai modul lain; dilindungi spec
 * SYS-D-004) sampai tim produk membangun UI klaim Kahade+.
 */
@Module({
  imports: [PrismaModule, SubscriptionsModule],
  providers: [InsuranceService],
  exports: [InsuranceService],
})
export class InsuranceModule {}
