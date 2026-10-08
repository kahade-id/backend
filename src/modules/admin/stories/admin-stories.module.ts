import { Module } from '@nestjs/common';
import { AuditLogModule } from '../../../common/services/audit-log.module';
import { StoriesModule } from '../../stories/stories.module';
import { UploadModule } from '../../upload/upload.module';
import { AdminStoriesController } from './admin-stories.controller';
import { AdminStoriesService } from './admin-stories.service';

@Module({
  imports: [AuditLogModule, StoriesModule, UploadModule],
  controllers: [AdminStoriesController],
  providers: [AdminStoriesService],
  exports: [AdminStoriesService],
})
export class AdminStoriesModule {}
