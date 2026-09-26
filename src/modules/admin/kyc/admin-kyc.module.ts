import { Module } from '@nestjs/common';
import { AdminKycController } from './admin-kyc.controller';
import { AdminKycService } from './admin-kyc.service';
import { AuditLogModule } from '../../../common/services/audit-log.module';
import { UploadModule } from '../../upload/upload.module';
import { QueueModule } from '../../queue/queue.module';
import { RedisModule } from '../../../redis/redis.module';
import { VerificationBadgeModule } from '../../users/verification-badge.module';
import { DashboardModule } from '../dashboard/dashboard.module';

@Module({
  imports: [AuditLogModule, UploadModule, QueueModule, RedisModule, VerificationBadgeModule, DashboardModule],
  controllers: [AdminKycController],
  providers: [AdminKycService],
})
export class AdminKycModule {}
