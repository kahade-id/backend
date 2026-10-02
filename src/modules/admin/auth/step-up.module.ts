import { Global, Module } from '@nestjs/common';
import { AdminStepUpService } from './step-up.service';
import { AdminPasswordService } from './admin-password.service';
import { AuditLogModule } from '../../../common/services/audit-log.module';

/**
 * SEC-503: modul global untuk step-up re-auth server-side + verifikasi
 * password admin bersama (pola AUT-013).
 * @Global agar StepUpGuard (dipakai banyak modul admin) selalu bisa
 * resolve servicenya tanpa wiring import di tiap modul.
 */
@Global()
@Module({
  imports: [AuditLogModule],
  providers: [AdminStepUpService, AdminPasswordService],
  exports: [AdminStepUpService, AdminPasswordService],
})
export class StepUpModule {}
