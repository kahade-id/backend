import { Module } from '@nestjs/common';
import { AdminShowcaseReportsController } from './admin-showcase-reports.controller';
import { AdminShowcaseReportsService } from './admin-showcase-reports.service';
import { AuditLogModule } from '../../../common/services/audit-log.module';
import { UploadModule } from '../../upload/upload.module';

@Module({
  imports: [AuditLogModule, UploadModule],
  controllers: [AdminShowcaseReportsController],
  providers: [AdminShowcaseReportsService],
  exports: [AdminShowcaseReportsService],
})
export class AdminShowcaseReportsModule {}
