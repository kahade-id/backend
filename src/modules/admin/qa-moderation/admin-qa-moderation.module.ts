import { Module } from '@nestjs/common';
import { AdminQaModerationController } from './admin-qa-moderation.controller';
import { AdminQaModerationService } from './admin-qa-moderation.service';

@Module({
  controllers: [AdminQaModerationController],
  providers: [AdminQaModerationService],
  exports: [AdminQaModerationService],
})
export class AdminQaModerationModule {}
