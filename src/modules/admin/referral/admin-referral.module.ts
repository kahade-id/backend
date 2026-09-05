import { Module } from '@nestjs/common';
import { AdminReferralController } from './admin-referral.controller';
import { AdminReferralService } from './admin-referral.service';

@Module({
  controllers: [AdminReferralController],
  providers: [AdminReferralService],
})
export class AdminReferralModule {}
