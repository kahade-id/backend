import { Module } from '@nestjs/common';
import { AdminFeedbackController } from './admin-feedback.controller';
import { AdminFeedbackService } from './admin-feedback.service';
import { NotificationsModule } from '../../notifications/notifications.module';

@Module({
  imports: [NotificationsModule],
  controllers: [AdminFeedbackController],
  providers: [AdminFeedbackService],
  exports: [AdminFeedbackService],
})
export class AdminFeedbackModule {}
