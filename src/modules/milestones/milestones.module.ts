// GAP-C (G176–G200): modul escrow bertahap (milestone).
// INTEGRATION-FIX: PrismaService TIDAK didaftarkan di sini — PrismaModule
// adalah @Global() sehingga PrismaService sudah tersedia; mendaftarkannya
// ulang akan membuat instance PrismaClient kedua (pool koneksi ganda).
import { Module } from '@nestjs/common';
import { MilestonesController } from './milestones.controller';
import { MilestonesService } from './milestones.service';
// INTEGRATION-FIX: WalletTxSerialService dipakai dari singleton WalletModule
// (di-export), bukan didaftarkan ulang — satu instance untuk seluruh aplikasi.
import { WalletModule } from '../wallet/wallet.module';

@Module({
  imports: [WalletModule],
  controllers: [MilestonesController],
  providers: [MilestonesService],
  exports: [MilestonesService],
})
export class MilestonesModule {}
