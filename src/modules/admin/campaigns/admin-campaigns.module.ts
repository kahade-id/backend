import { Module } from '@nestjs/common';
import { AdminCampaignsController } from './admin-campaigns.controller';
import { CampaignService } from '../campaign.service';
import { AuditLogModule } from '../../../common/services/audit-log.module';
import { QueueModule } from '../../queue/queue.module';

@Module({
  imports: [AuditLogModule, QueueModule],
  controllers: [AdminCampaignsController],
  providers: [CampaignService],
})
export class AdminCampaignsModule {}
