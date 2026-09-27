import { Global, Module } from '@nestjs/common';
import { OpsSettingsService } from './ops-settings.service';

/**
 * OPS — inti setting operasional (tanpa controller).
 *
 * Dipisah dari OpsSettingsModule agar graph yang hanya butuh
 * OpsSettingsService (mis. ObservabilityModule di dalam
 * ReadOnlySmokeModule) tidak ikut menyeret AdminOpsSettingsController
 * beserta guard JWT-nya — guard tersebut butuh JwtModule yang memang
 * tidak ada (dan tidak diperlukan) di graph smoke read-only.
 *
 * Global seperti modul induknya: consumer (auth, observability, dsb.)
 * bisa inject tanpa import eksplisit, mirip ConfigModule.
 */
@Global()
@Module({
  providers: [OpsSettingsService],
  exports: [OpsSettingsService],
})
export class OpsSettingsCoreModule {}
