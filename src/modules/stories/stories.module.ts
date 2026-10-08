import { Module } from '@nestjs/common';
import { AuditLogModule } from '../../common/services/audit-log.module';
import { ChatModule } from '../chat/chat.module';
import { UploadModule } from '../upload/upload.module';
import { StoriesController } from './stories.controller';
import { StoriesRetentionService } from './stories-retention.service';
import { StoriesService } from './stories.service';
import { StoryMediaTooLargeInterceptor } from './story-media-too-large.interceptor';
import { StoryThrottleGuard } from './story-throttle.guard';

@Module({
  imports: [AuditLogModule, ChatModule, UploadModule],
  controllers: [StoriesController],
  providers: [
    StoriesService,
    StoriesRetentionService,
    StoryThrottleGuard,
    StoryMediaTooLargeInterceptor,
  ],
  exports: [StoriesService],
})
export class StoriesModule {}
