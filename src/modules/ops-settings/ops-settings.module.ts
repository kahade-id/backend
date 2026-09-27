import { Global, Module } from '@nestjs/common';
import { AdminOpsSettingsController } from './admin-ops-settings.controller';
import { OpsSettingsCoreModule } from './ops-settings-core.module';

/**
 * OPS — modul global untuk setting operasional. Global agar consumer
 * (auth, observability, dsb.) bisa inject tanpa import eksplisit,
 * mirip ConfigModule.
 *
 * Provider OpsSettingsService didaftarkan di OpsSettingsCoreModule
 * (tanpa controller) supaya graph yang hanya butuh service-nya —
 * mis. ObservabilityModule di dalam ReadOnlySmokeModule — tidak ikut
 * menyeret controller admin + guard JWT. Perilaku produksi tidak berubah:
 * modul inti tetap terdaftar tepat satu kali (Nest mendedupe modul
 * berdasarkan tipe).
 */
@Global()
@Module({
  imports: [OpsSettingsCoreModule],
  controllers: [AdminOpsSettingsController],
})
export class OpsSettingsModule {}
