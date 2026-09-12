import { Module } from '@nestjs/common';
import { SettingsController } from './settings.controller';
import { SettingsService } from './settings.service';
import { AuditLogModule } from '../../common/services/audit-log.module';
import { UploadModule } from '../upload/upload.module';
import { QueueModule } from '../queue/queue.module';
import { ReportFlagService } from '../../common/services/report-flag.service';

@Module({
  imports: [AuditLogModule, UploadModule, QueueModule],
  controllers: [SettingsController],
  providers: [SettingsService, ReportFlagService],
})
export class SettingsModule {}
