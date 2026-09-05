import { Module, OnModuleInit } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { ThrottlerStorageRedisService } from '@nest-lab/throttler-storage-redis';
import { ScheduleModule } from '@nestjs/schedule';
import { BullModule } from '@nestjs/bull';
import { Logger as NestLogger } from '@nestjs/common';

// Config
import { appConfig, databaseConfig, jwtConfig, cryptoConfig, redisConfig, midtransConfig, r2Config, smtpConfig, fcmConfig } from './config';
import { validateEnv } from './config/env.validation';
import { initializeCrypto } from './common/utils/crypto.util';
import { getRuntimeEnvFile } from './config/runtime-env-file';

// Core modules
import { PrismaModule } from './prisma/prisma.module';
import { RedisModule } from './redis/redis.module';
import { CsrfModule } from './common/services/csrf.module';

// Feature modules
import { AuthModule } from './modules/auth/auth.module';
import { UsersModule } from './modules/users/users.module';
import { SessionsModule } from './modules/sessions/sessions.module';
import { KycModule } from './modules/kyc/kyc.module';
import { BankAccountsModule } from './modules/bank-accounts/bank-accounts.module';
import { WalletModule } from './modules/wallet/wallet.module';
import { OrdersModule } from './modules/orders/orders.module';
import { ChatModule } from './modules/chat/chat.module';
import { DisputesModule } from './modules/disputes/disputes.module';
import { RatingsModule } from './modules/ratings/ratings.module';
import { NotificationsModule } from './modules/notifications/notifications.module';
import { ReferralModule } from './modules/referral/referral.module';
import { VouchersModule } from './modules/vouchers/vouchers.module';
import { SubscriptionsModule } from './modules/subscriptions/subscriptions.module';
import { SettingsModule } from './modules/settings/settings.module';
import { UploadModule } from './modules/upload/upload.module';
import { PublicModule } from './modules/public/public.module';
import { BadgesModule } from './modules/badges/badges.module';
import { PaymentModule } from './modules/payment/payment.module';
import { QueueModule } from './modules/queue/queue.module';
import { SchedulerModule } from './modules/scheduler/scheduler.module';
import { PushModule } from './modules/push/push.module';
import { RealtimeModule } from './modules/realtime/realtime.module';
import { WithdrawalsModule } from './modules/withdrawals/withdrawals.module';
import { HelpCenterModule } from './modules/help-center/help-center.module';
import { TransactionTemplatesModule } from './modules/transaction-templates/transaction-templates.module';
import { SupportModule } from './modules/support/support.module';
import { ConfigApiModule } from './modules/config/config-api.module';
import { SearchModule } from './modules/search/search.module';

// Admin modules
import { AdminModule } from './modules/admin/admin.module';
import { HealthModule } from './modules/health/health.module';

// Guards
import { JwtAuthGuard, ADMIN_JWT_SERVICE } from './common/guards/jwt-auth.guard';
import { GlobalThrottleGuard } from './common/guards/global-throttle.guard';
import { CsrfGuard } from './common/guards/csrf.guard';
import { JwtService } from '@nestjs/jwt';

import { IdempotencyInterceptor } from './common/interceptors/idempotency.interceptor';
import { PaginationClampInterceptor } from './common/interceptors/pagination-clamp.interceptor';

const runtimeEnvFile = getRuntimeEnvFile();

@Module({
  imports: [
    // Config
    ConfigModule.forRoot({
      isGlobal: true,
      ...(runtimeEnvFile ? { envFilePath: runtimeEnvFile } : {}),
      load: [appConfig, databaseConfig, jwtConfig, cryptoConfig, redisConfig, midtransConfig, r2Config, smtpConfig, fcmConfig],
      validate: validateEnv,
    }),

    // B-01 (audit-fix): Throttler MUST be backed by Redis when running with
    // multiple replicas, otherwise every documented per-IP limit is multiplied
    // by replica count (in-memory storage is per-process). We fall back to the
    // in-memory store ONLY when REDIS_URL is unset (e.g. local unit tests),
    // and emit a startup warning so it cannot silently regress in staging/prod.
    ThrottlerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const ttl = config.get<number>('app.throttleGlobalTtlMs') ?? 60000;
        const limit = config.get<number>('app.throttleGlobalLimit') ?? 100;
        const redisUrl = config.get<string>('redis.url');
        const nodeEnv = process.env.NODE_ENV || 'development';
        const log = new NestLogger('ThrottlerModule');
        if (!redisUrl) {
          if (['production', 'staging'].includes(nodeEnv)) {
            throw new Error('STARTUP ABORTED: REDIS_URL must be set in production/staging — Throttler requires Redis storage for multi-replica correctness.');
          }
          log.warn('Throttler running with in-memory storage (REDIS_URL unset). Per-IP limits will be inaccurate under multiple replicas.');
          return [{ ttl, limit }];
        }
        return {
          throttlers: [{ ttl, limit }],
          storage: new ThrottlerStorageRedisService(redisUrl),
        };
      },
    }),

    // Scheduler
    ScheduleModule.forRoot(),

    BullModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const redisUrl = config.get<string>('redis.bullRedisUrl');
        if (!redisUrl) {
          throw new Error('redis.bullRedisUrl is not configured — set BULL_REDIS_URL env var');
        }
        const prefix = config.get<string>('redis.prefix') || 'kahade:';
        const useTls = redisUrl.startsWith('rediss://');
        return {
          url: redisUrl,
          prefix: `${prefix}bull:`,
          ...(useTls ? { redis: { tls: { rejectUnauthorized: true } } } : {}),
        };
      },
    }),

    // Core modules
    PrismaModule,
    RedisModule,
    CsrfModule,

    // Feature modules
    AuthModule,
    UsersModule,
    SessionsModule,
    KycModule,
    BankAccountsModule,
    WalletModule,
    OrdersModule,
    ChatModule,
    DisputesModule,
    RatingsModule,
    NotificationsModule,
    ReferralModule,
    VouchersModule,
    SubscriptionsModule,
    SettingsModule,
    UploadModule,
    PublicModule,
    BadgesModule,
    PaymentModule,
    QueueModule,
    SchedulerModule,
    PushModule,
    RealtimeModule,
    WithdrawalsModule,
    HelpCenterModule,
    TransactionTemplatesModule,
    SupportModule,
    ConfigApiModule,
    SearchModule,

    // Admin modules
    AdminModule,
    HealthModule,
  ],
  providers: [
    {
      provide: APP_GUARD,
      useClass: GlobalThrottleGuard,
    },
    {
      provide: APP_GUARD,
      useClass: ThrottlerGuard,
    },
    {
      provide: ADMIN_JWT_SERVICE,
      useFactory: (configService: ConfigService) => {
        const secret = configService.get<string>('jwt.adminSecret');
        return new JwtService({ secret });
      },
      inject: [ConfigService],
    },
    {
      provide: APP_GUARD,
      useClass: JwtAuthGuard,
    },
    {
      provide: APP_GUARD,
      useClass: CsrfGuard,
    },
    {
      provide: APP_INTERCEPTOR,
      useClass: IdempotencyInterceptor,
    },
    {
      provide: APP_INTERCEPTOR,
      useValue: new PaginationClampInterceptor(100),
    },
  ],
})
export class AppModule implements OnModuleInit {
  constructor(private configService: ConfigService) {}

  onModuleInit(): void {
    // This replaces the dual-source-of-truth where crypto.util read process.env directly
    // while cryptoConfig registered the same vars under the 'crypto' namespace.
    const aesKdfSalt = this.configService.get<string>('crypto.aesKdfSalt');
    if (!aesKdfSalt) {
      throw new Error('STARTUP ABORTED: crypto.aesKdfSalt (AES_KDF_SALT) is not configured. Set it in your environment.');
    }
    initializeCrypto({
      aesSecretKey: this.configService.get<string>('crypto.aesSecretKey') ?? '',
      aesKdfSalt,
      hmacSecretKey: this.configService.get<string>('crypto.hmacSecretKey') ?? '',
      previousAesSecretKey: this.configService.get<string>('crypto.previousAesSecretKey') || '',
      kycNikEncryptionKey: this.configService.get<string>('crypto.kycNikEncryptionKey') || '',
      kycKtpEncryptionKey: this.configService.get<string>('crypto.kycKtpEncryptionKey') || '',
      kycSelfieEncryptionKey: this.configService.get<string>('crypto.kycSelfieEncryptionKey') || '',
      bcryptRounds: this.configService.get<number>('crypto.bcryptRounds'),
    });
  }
}
