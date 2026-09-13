import { Module } from '@nestjs/common';
import { AdminChatController } from './admin-chat.controller';
import { AdminChatService } from './admin-chat.service';
import { ChatModule } from '../../chat/chat.module';
import { AuditLogModule } from '../../../common/services/audit-log.module';

@Module({
  imports: [AuditLogModule, ChatModule],
  controllers: [AdminChatController],
  providers: [AdminChatService],
  exports: [AdminChatService],
})
export class AdminChatModule {}
