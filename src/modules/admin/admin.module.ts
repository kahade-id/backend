import { Module } from '@nestjs/common';
import { AdminAuthModule } from './auth/admin-auth.module';
import { DashboardModule } from './dashboard/dashboard.module';
import { AdminUsersModule } from './users/admin-users.module';
import { AdminOrdersModule } from './orders/admin-orders.module';
import { AdminKycModule } from './kyc/admin-kyc.module';
import { AdminDisputesModule } from './disputes/admin-disputes.module';
import { AdminFinanceModule } from './finance/admin-finance.module';
import { AdminVouchersModule } from './vouchers/admin-vouchers.module';
import { AdminSystemModule } from './system/admin-system.module';
import { AdminReportsModule } from './reports/admin-reports.module';
import { AdminBadgesModule } from './badges/admin-badges.module';
import { AdminSubscriptionsModule } from './subscriptions/admin-subscriptions.module';
import { AdminRatingsModule } from './ratings/admin-ratings.module';
import { AdminReferralModule } from './referral/admin-referral.module';
import { AdminManagementModule } from './management/admin-management.module';
import { AdminAnalyticsModule } from './analytics/admin-analytics.module';
import { AdminCampaignsModule } from './campaigns/admin-campaigns.module';
import { AdminSupportModule } from './support/admin-support.module';

@Module({
  imports: [
    AdminAuthModule,
    DashboardModule,
    AdminUsersModule,
    AdminOrdersModule,
    AdminKycModule,
    AdminDisputesModule,
    AdminFinanceModule,
    AdminVouchersModule,
    AdminSystemModule,
    AdminReportsModule,
    AdminBadgesModule,
    AdminSubscriptionsModule,
    AdminRatingsModule,
    AdminReferralModule,
    AdminManagementModule,
    AdminAnalyticsModule,
    AdminCampaignsModule,
    AdminSupportModule,
  ],
})
export class AdminModule {}
