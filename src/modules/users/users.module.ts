import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { BullModule } from "@nestjs/bull";
import { UsersController } from "./users.controller";
import { UsersService } from "./users.service";
import { AccountDeletionService } from "./account-deletion.service";
import { EMAIL_QUEUE } from "../queue/processors/email.processor";
import { UserSearchService } from "./user-search.service";
import { UserStatsService } from "./user-stats.service";
import { UserAnalyticsService } from "./user-analytics.service";
import { ProfileQAService } from "./profile-qa.service";
import { QaReportService } from "./qa-report.service";
import { OgMetadataService } from "./og-metadata.service";
import { VerificationBadgeModule } from "./verification-badge.module";
import { ShowcaseModule } from "../showcase/showcase.module";
import { KycRequiredGuard } from "../../common/guards/kyc-required.guard";
import { AuditLogModule } from "../../common/services/audit-log.module";
import { ReportFlagService } from "../../common/services/report-flag.service";
import { UploadModule } from "../upload/upload.module";

@Module({
  imports: [
    ConfigModule,
    AuditLogModule,
    VerificationBadgeModule,
    ShowcaseModule,
    UploadModule,
    BullModule.registerQueue({
      name: EMAIL_QUEUE,
      settings: { stalledInterval: 30_000, maxStalledCount: 1 },
      defaultJobOptions: {
        attempts: 3,
        timeout: 120_000,
        backoff: { type: 'exponential', delay: 5_000 },
        removeOnComplete: 100,
        removeOnFail: 50,
      },
    }),
  ],
  controllers: [UsersController],
  providers: [UsersService, AccountDeletionService, UserSearchService, UserStatsService, UserAnalyticsService, ProfileQAService, QaReportService, OgMetadataService, KycRequiredGuard, ReportFlagService],
  exports: [UsersService, AccountDeletionService, UserSearchService, UserStatsService, UserAnalyticsService, ProfileQAService, QaReportService, OgMetadataService],
})
export class UsersModule {}
