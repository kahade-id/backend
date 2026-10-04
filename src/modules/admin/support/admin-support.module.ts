import { Module } from '@nestjs/common';
import { AdminSupportController } from './admin-support.controller';
import { AdminSupportChatController } from './admin-support-chat.controller';
import { AdminSupportService } from './admin-support.service';
import { AuditLogModule } from '../../../common/services/audit-log.module';
import { UploadModule } from '../../upload/upload.module';
// POIN 5: controller livechat admin memakai SupportChatService.
import { SupportModule } from '../../support/support.module';

@Module({
  imports: [AuditLogModule, UploadModule, SupportModule],
  controllers: [AdminSupportController, AdminSupportChatController],
  providers: [AdminSupportService],
})
export class AdminSupportModule {}
