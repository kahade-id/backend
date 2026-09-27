import { Module } from '@nestjs/common';
import { AdminAuthModule } from './auth/admin-auth.module';
import { DashboardModule } from './dashboard/dashboard.module';
import { AdminUsersModule } from './users/admin-users.module';
import { AdminOrdersModule } from './orders/admin-orders.module';
import { AdminKycModule } from './kyc/admin-kyc.module';
import { AdminBusinessVerificationModule } from './business-verification/admin-business-verification.module';
import { AdminDisputesModule } from './disputes/admin-disputes.module';
import { AdminFinanceModule } from './finance/admin-finance.module';
import { AdminVouchersModule } from './vouchers/admin-vouchers.module';
import { AdminSystemModule } from './system/admin-system.module';
import { AdminReportsModule } from './reports/admin-reports.module';
import { AdminShowcaseReportsModule } from './showcase-reports/admin-showcase-reports.module';
import { AdminQaModerationModule } from './qa-moderation/admin-qa-moderation.module';
import { AdminBadgesModule } from './badges/admin-badges.module';
import { AdminSubscriptionsModule } from './subscriptions/admin-subscriptions.module';
import { AdminInsuranceClaimsModule } from './insurance-claims/admin-insurance-claims.module';
import { AdminRatingsModule } from './ratings/admin-ratings.module';
import { AdminReferralModule } from './referral/admin-referral.module';
import { AdminManagementModule } from './management/admin-management.module';
import { AdminAnalyticsModule } from './analytics/admin-analytics.module';
import { AdminCampaignsModule } from './campaigns/admin-campaigns.module';
import { AdminSupportModule } from './support/admin-support.module';
import { AdminChatModule } from './chat/admin-chat.module';
import { AdminFeedbackModule } from './feedback/admin-feedback.module';
// GAP-C (G196–G199): admin milestone.
import { AdminMilestonesModule } from './milestones/admin-milestones.module';
import { AdminActionLocationsModule } from './action-locations/admin-action-locations.module';

@Module({
  imports: [
    AdminAuthModule,
    DashboardModule,
    AdminUsersModule,
    AdminOrdersModule,
    AdminKycModule,
    AdminBusinessVerificationModule,
    AdminDisputesModule,
    AdminFinanceModule,
    AdminVouchersModule,
    AdminSystemModule,
    AdminReportsModule,
    AdminShowcaseReportsModule,
    AdminQaModerationModule,
    AdminBadgesModule,
    AdminSubscriptionsModule,
    AdminInsuranceClaimsModule,
    AdminRatingsModule,
    AdminReferralModule,
    AdminManagementModule,
    AdminAnalyticsModule,
    AdminCampaignsModule,
    AdminSupportModule,
    AdminChatModule,
    AdminFeedbackModule,
    AdminMilestonesModule, // GAP-C (G196–G199)
    AdminActionLocationsModule,
  ],
})
export class AdminModule {}
