import { Module } from '@nestjs/common';
import { AdminShowcaseReportsController } from './admin-showcase-reports.controller';
import { AdminShowcaseReportsService } from './admin-showcase-reports.service';
import { AuditLogModule } from '../../../common/services/audit-log.module';

@Module({
  imports: [AuditLogModule],
  controllers: [AdminShowcaseReportsController],
  providers: [AdminShowcaseReportsService],
  exports: [AdminShowcaseReportsService],
})
export class AdminShowcaseReportsModule {}
