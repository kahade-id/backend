import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { UsersController } from "./users.controller";
import { UsersService } from "./users.service";
import { UserSearchService } from "./user-search.service";
import { UserStatsService } from "./user-stats.service";
import { UserAnalyticsService } from "./user-analytics.service";
import { ProfileQAService } from "./profile-qa.service";
import { OgMetadataService } from "./og-metadata.service";
import { VerificationBadgeModule } from "./verification-badge.module";
import { ShowcaseModule } from "../showcase/showcase.module";
import { KycRequiredGuard } from "../../common/guards/kyc-required.guard";
import { AuditLogModule } from "../../common/services/audit-log.module";
import { ReportFlagService } from "../../common/services/report-flag.service";

@Module({
  imports: [ConfigModule, AuditLogModule, VerificationBadgeModule, ShowcaseModule],
  controllers: [UsersController],
  providers: [UsersService, UserSearchService, UserStatsService, UserAnalyticsService, ProfileQAService, OgMetadataService, KycRequiredGuard, ReportFlagService],
  exports: [UsersService, UserSearchService, UserStatsService, UserAnalyticsService, ProfileQAService, OgMetadataService],
})
export class UsersModule {}
