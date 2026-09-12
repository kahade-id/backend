import { Module } from '@nestjs/common';
import { AdminBusinessVerificationController } from './admin-business-verification.controller';
import { AdminBusinessVerificationService } from './admin-business-verification.service';
import { AuditLogModule } from '../../../common/services/audit-log.module';
import { UploadModule } from '../../upload/upload.module';
import { QueueModule } from '../../queue/queue.module';
import { VerificationBadgeModule } from '../../users/verification-badge.module';

@Module({
  imports: [AuditLogModule, UploadModule, QueueModule, VerificationBadgeModule],
  controllers: [AdminBusinessVerificationController],
  providers: [AdminBusinessVerificationService],
})
export class AdminBusinessVerificationModule {}
