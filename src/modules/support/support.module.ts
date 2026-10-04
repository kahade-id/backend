import { Module } from '@nestjs/common';
import { SupportController } from './support.controller';
import { SupportService } from './support.service';
import { SupportChatService } from './support-chat.service';
import { PrismaModule } from '../../prisma/prisma.module';
import { UploadModule } from '../upload/upload.module';
import { AuditLogModule } from '../../common/services/audit-log.module';
import { SubscriptionsModule } from '../subscriptions/subscriptions.module';

@Module({
  imports: [PrismaModule, UploadModule, AuditLogModule, SubscriptionsModule],
  controllers: [SupportController],
  // RealtimeService dipakai SupportChatService — disediakan modul global
  // RealtimeModule (@Global), jadi tidak perlu di-import di sini.
  providers: [SupportService, SupportChatService],
  exports: [SupportChatService],
})
export class SupportModule {}
