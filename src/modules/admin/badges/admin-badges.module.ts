import { Module } from '@nestjs/common';
import { AdminBadgesController } from './admin-badges.controller';
import { AdminBadgesService } from './admin-badges.service';
import { AuditLogModule } from '../../../common/services/audit-log.module';
import { QueueModule } from '../../queue/queue.module';
import { VerificationBadgeModule } from '../../users/verification-badge.module';

@Module({
  imports: [AuditLogModule, QueueModule, VerificationBadgeModule],
  controllers: [AdminBadgesController],
  providers: [AdminBadgesService],
})
export class AdminBadgesModule {}
