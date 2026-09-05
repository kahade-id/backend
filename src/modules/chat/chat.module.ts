import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from '../../prisma/prisma.module';
import { UploadModule } from '../upload/upload.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { ChatController } from './chat.controller';
import { ChatService } from './chat.service';
import { PhoneVerifiedGuard } from '../../common/guards/phone-verified.guard';

@Module({
  imports: [PrismaModule, ConfigModule, UploadModule, NotificationsModule],
  controllers: [ChatController],
  providers: [ChatService, PhoneVerifiedGuard],
  exports: [ChatService],
})
export class ChatModule {}
