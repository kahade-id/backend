import { Global, Module } from '@nestjs/common';
import { ActionLocationService } from './action-location.service';

/**
 * ACTION-LOCATION — modul global untuk mencatat lokasi presisi pada aksi
 * sensitif non-auth (order, wallet, dispute, hapus akun). Global agar consumer
 * (orders, wallet, disputes, users) bisa inject tanpa import eksplisit,
 * mengikuti pola OpsSettingsModule. Lihat action-location.service.ts.
 */
@Global()
@Module({
  providers: [ActionLocationService],
  exports: [ActionLocationService],
})
export class ActionLocationModule {}
