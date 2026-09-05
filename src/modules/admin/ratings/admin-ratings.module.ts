import { Module } from '@nestjs/common';
import { AdminRatingsController } from './admin-ratings.controller';
import { AdminRatingsService } from './admin-ratings.service';
import { AuditLogModule } from '../../../common/services/audit-log.module';

@Module({
  imports: [AuditLogModule],
  controllers: [AdminRatingsController],
  providers: [AdminRatingsService],
})
export class AdminRatingsModule {}
