import { Module } from '@nestjs/common';
import { VerificationBadgeService } from './verification-badge.service';

/**
 * Section 1 — Verified Badge System.
 *
 * PrismaModule dan RedisModule sudah @Global, jadi tidak perlu di-import di sini.
 * Module ini di-import oleh UsersModule (profil publik), SubscriptionsModule +
 * SchedulerModule (invalidate saat Kahade+ expire), KycModule/AdminKycModule
 * (invalidate saat KYC revoke), dan BusinessVerificationModule.
 */
@Module({
  providers: [VerificationBadgeService],
  exports: [VerificationBadgeService],
})
export class VerificationBadgeModule {}
