import { Module } from '@nestjs/common';
import { AdminManagementController } from './admin-management.controller';
import { AdminManagementService } from './admin-management.service';
import { AuditLogModule } from '../../../common/services/audit-log.module';

@Module({
  imports: [AuditLogModule],
  controllers: [AdminManagementController],
  providers: [AdminManagementService],
})
export class AdminManagementModule {}
