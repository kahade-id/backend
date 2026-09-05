import { Module } from '@nestjs/common';
import { SettingsController } from './settings.controller';
import { SettingsService } from './settings.service';
import { AuditLogModule } from '../../common/services/audit-log.module';
import { UploadModule } from '../upload/upload.module';
import { QueueModule } from '../queue/queue.module';

@Module({
  imports: [AuditLogModule, UploadModule, QueueModule],
  controllers: [SettingsController],
  providers: [SettingsService],
})
export class SettingsModule {}
