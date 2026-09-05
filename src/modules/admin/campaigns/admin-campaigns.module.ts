import { Module } from '@nestjs/common';
import { AdminCampaignsController } from './admin-campaigns.controller';
import { CampaignService } from '../campaign.service';
import { AuditLogModule } from '../../../common/services/audit-log.module';

@Module({
  imports: [AuditLogModule],
  controllers: [AdminCampaignsController],
  providers: [CampaignService],
})
export class AdminCampaignsModule {}
