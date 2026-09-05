"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.AdminModule = void 0;
const common_1 = require("@nestjs/common");
const admin_auth_module_1 = require("./auth/admin-auth.module");
const dashboard_module_1 = require("./dashboard/dashboard.module");
const admin_users_module_1 = require("./users/admin-users.module");
const admin_orders_module_1 = require("./orders/admin-orders.module");
const admin_kyc_module_1 = require("./kyc/admin-kyc.module");
const admin_disputes_module_1 = require("./disputes/admin-disputes.module");
const admin_finance_module_1 = require("./finance/admin-finance.module");
const admin_vouchers_module_1 = require("./vouchers/admin-vouchers.module");
const admin_system_module_1 = require("./system/admin-system.module");
const admin_reports_module_1 = require("./reports/admin-reports.module");
const admin_badges_module_1 = require("./badges/admin-badges.module");
const admin_subscriptions_module_1 = require("./subscriptions/admin-subscriptions.module");
const admin_ratings_module_1 = require("./ratings/admin-ratings.module");
const admin_referral_module_1 = require("./referral/admin-referral.module");
const admin_management_module_1 = require("./management/admin-management.module");
const admin_analytics_module_1 = require("./analytics/admin-analytics.module");
const admin_campaigns_module_1 = require("./campaigns/admin-campaigns.module");
const admin_support_module_1 = require("./support/admin-support.module");
let AdminModule = class AdminModule {
};
exports.AdminModule = AdminModule;
exports.AdminModule = AdminModule = __decorate([
    (0, common_1.Module)({
        imports: [
            admin_auth_module_1.AdminAuthModule,
            dashboard_module_1.DashboardModule,
            admin_users_module_1.AdminUsersModule,
            admin_orders_module_1.AdminOrdersModule,
            admin_kyc_module_1.AdminKycModule,
            admin_disputes_module_1.AdminDisputesModule,
            admin_finance_module_1.AdminFinanceModule,
            admin_vouchers_module_1.AdminVouchersModule,
            admin_system_module_1.AdminSystemModule,
            admin_reports_module_1.AdminReportsModule,
            admin_badges_module_1.AdminBadgesModule,
            admin_subscriptions_module_1.AdminSubscriptionsModule,
            admin_ratings_module_1.AdminRatingsModule,
            admin_referral_module_1.AdminReferralModule,
            admin_management_module_1.AdminManagementModule,
            admin_analytics_module_1.AdminAnalyticsModule,
            admin_campaigns_module_1.AdminCampaignsModule,
            admin_support_module_1.AdminSupportModule,
        ],
    })
], AdminModule);
