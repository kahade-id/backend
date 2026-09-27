import { Global, Module } from '@nestjs/common';
import { OpsSettingsService } from './ops-settings.service';
import { AdminOpsSettingsController } from './admin-ops-settings.controller';

/**
 * OPS — modul global untuk setting operasional. Global agar consumer
 * (auth, observability, dsb.) bisa inject tanpa import eksplisit,
 * mirip ConfigModule.
 */
@Global()
@Module({
  controllers: [AdminOpsSettingsController],
  providers: [OpsSettingsService],
  exports: [OpsSettingsService],
})
export class OpsSettingsModule {}
