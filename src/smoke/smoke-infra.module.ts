import { Global, Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';

/**
 * Infra pelengkap KHUSUS graph smoke read-only.
 *
 * Guard admin (JwtAdminGuard) pada controller ObservabilityModule butuh
 * JwtService. Di produksi JwtService tersedia global via AuthModule
 * (@Global + exports JwtModule); graph smoke tidak mengimpor AuthModule
 * (terlalu berat: OTP, passkey, dsb.) sehingga guard gagal resolve.
 *
 * Modul ini meniru pola produksi secara minimal: JwtModule.register({})
 * (persis seperti di auth/admin-auth/realtime module) diekspor dari modul
 * global khusus smoke. JwtModule tidak membuka koneksi, tidak menjadwalkan
 * kerja, dan tidak memutasi state apa pun saat boot — aman untuk smoke.
 * Tidak ada perilaku produksi yang berubah (file ini hanya dipakai
 * ReadOnlySmokeModule).
 */
@Global()
@Module({
  imports: [JwtModule.register({})],
  exports: [JwtModule],
})
export class SmokeInfraModule {}
