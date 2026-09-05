import { Module } from '@nestjs/common';
import { AdminBadgesController } from './admin-badges.controller';
import { AdminBadgesService } from './admin-badges.service';
import { AuditLogModule } from '../../../common/services/audit-log.module';
import { QueueModule } from '../../queue/queue.module';

@Module({
  imports: [AuditLogModule, QueueModule],
  controllers: [AdminBadgesController],
  providers: [AdminBadgesService],
})
export class AdminBadgesModule {}
