import { Module } from '@nestjs/common';
import { AdminManagementController } from './admin-management.controller';
import { AdminActivityLogController } from './admin-activity-log.controller';
import { AdminOpsAliasController } from './admin-ops-alias.controller';
import { AdminManagementService } from './admin-management.service';
import { AuditLogModule } from '../../../common/services/audit-log.module';

@Module({
  imports: [AuditLogModule],
  controllers: [AdminManagementController, AdminActivityLogController, AdminOpsAliasController],
  providers: [AdminManagementService],
})
export class AdminManagementModule {}
