import { Module } from '@nestjs/common';
import { NotificationsController } from './notifications.controller';
import { NotificationsService } from './notifications.service';
import { NotificationCopyService } from './notification-copy.service';

@Module({
  controllers: [NotificationsController],
  providers: [NotificationsService, NotificationCopyService],
  exports: [NotificationsService, NotificationCopyService],
})
export class NotificationsModule {}

