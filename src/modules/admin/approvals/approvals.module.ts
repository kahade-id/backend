import { Global, Module } from '@nestjs/common';
import { ApprovalsService } from './approvals.service';
import { ApprovalsController } from './approvals.controller';
import { AuditLogModule } from '../../../common/services/audit-log.module';

/**
 * SEC-501/502/601/602 + BAD-001 (audit 2026-10-03): dual control
 * (maker-checker) untuk aksi admin sensitif.
 *
 * @Global agar:
 * - StepUpGuard/ApprovalsController selalu bisa resolve tanpa wiring,
 * - registry executor TUNGGAL dipakai semua modul domain (modul domain
 *   mendaftarkan executor-nya via ApprovalsService.registerExecutor,
 *   sehingga tidak ada import cycle approvals <-> domain).
 */
@Global()
@Module({
  imports: [AuditLogModule],
  controllers: [ApprovalsController],
  providers: [ApprovalsService],
  exports: [ApprovalsService],
})
export class ApprovalsModule {}
