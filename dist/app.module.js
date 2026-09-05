"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.AppModule = void 0;
const common_1 = require("@nestjs/common");
const config_1 = require("@nestjs/config");
const core_1 = require("@nestjs/core");
const throttler_1 = require("@nestjs/throttler");
const throttler_storage_redis_1 = require("@nest-lab/throttler-storage-redis");
const schedule_1 = require("@nestjs/schedule");
const bull_1 = require("@nestjs/bull");
const common_2 = require("@nestjs/common");
const config_2 = require("./config");
const env_validation_1 = require("./config/env.validation");
const crypto_util_1 = require("./common/utils/crypto.util");
const runtime_env_file_1 = require("./config/runtime-env-file");
const prisma_module_1 = require("./prisma/prisma.module");
const redis_module_1 = require("./redis/redis.module");
const csrf_module_1 = require("./common/services/csrf.module");
const auth_module_1 = require("./modules/auth/auth.module");
const users_module_1 = require("./modules/users/users.module");
const sessions_module_1 = require("./modules/sessions/sessions.module");
const kyc_module_1 = require("./modules/kyc/kyc.module");
const bank_accounts_module_1 = require("./modules/bank-accounts/bank-accounts.module");
const wallet_module_1 = require("./modules/wallet/wallet.module");
const orders_module_1 = require("./modules/orders/orders.module");
const chat_module_1 = require("./modules/chat/chat.module");
const disputes_module_1 = require("./modules/disputes/disputes.module");
const ratings_module_1 = require("./modules/ratings/ratings.module");
const notifications_module_1 = require("./modules/notifications/notifications.module");
const referral_module_1 = require("./modules/referral/referral.module");
const vouchers_module_1 = require("./modules/vouchers/vouchers.module");
const subscriptions_module_1 = require("./modules/subscriptions/subscriptions.module");
const settings_module_1 = require("./modules/settings/settings.module");
const upload_module_1 = require("./modules/upload/upload.module");
const public_module_1 = require("./modules/public/public.module");
const badges_module_1 = require("./modules/badges/badges.module");
const payment_module_1 = require("./modules/payment/payment.module");
const queue_module_1 = require("./modules/queue/queue.module");
const scheduler_module_1 = require("./modules/scheduler/scheduler.module");
const push_module_1 = require("./modules/push/push.module");
const realtime_module_1 = require("./modules/realtime/realtime.module");
const withdrawals_module_1 = require("./modules/withdrawals/withdrawals.module");
const help_center_module_1 = require("./modules/help-center/help-center.module");
const transaction_templates_module_1 = require("./modules/transaction-templates/transaction-templates.module");
const support_module_1 = require("./modules/support/support.module");
const config_api_module_1 = require("./modules/config/config-api.module");
const search_module_1 = require("./modules/search/search.module");
const admin_module_1 = require("./modules/admin/admin.module");
const health_module_1 = require("./modules/health/health.module");
const jwt_auth_guard_1 = require("./common/guards/jwt-auth.guard");
const global_throttle_guard_1 = require("./common/guards/global-throttle.guard");
const csrf_guard_1 = require("./common/guards/csrf.guard");
const jwt_1 = require("@nestjs/jwt");
const idempotency_interceptor_1 = require("./common/interceptors/idempotency.interceptor");
const pagination_clamp_interceptor_1 = require("./common/interceptors/pagination-clamp.interceptor");
const runtimeEnvFile = (0, runtime_env_file_1.getRuntimeEnvFile)();
let AppModule = class AppModule {
    constructor(configService) {
        this.configService = configService;
    }
    onModuleInit() {
        const aesKdfSalt = this.configService.get('crypto.aesKdfSalt');
        if (!aesKdfSalt) {
            throw new Error('STARTUP ABORTED: crypto.aesKdfSalt (AES_KDF_SALT) is not configured. Set it in your environment.');
        }
        (0, crypto_util_1.initializeCrypto)({
            aesSecretKey: this.configService.get('crypto.aesSecretKey') ?? '',
            aesKdfSalt,
            hmacSecretKey: this.configService.get('crypto.hmacSecretKey') ?? '',
            previousAesSecretKey: this.configService.get('crypto.previousAesSecretKey') || '',
            kycNikEncryptionKey: this.configService.get('crypto.kycNikEncryptionKey') || '',
            kycKtpEncryptionKey: this.configService.get('crypto.kycKtpEncryptionKey') || '',
            kycSelfieEncryptionKey: this.configService.get('crypto.kycSelfieEncryptionKey') || '',
            bcryptRounds: this.configService.get('crypto.bcryptRounds'),
        });
    }
};
exports.AppModule = AppModule;
exports.AppModule = AppModule = __decorate([
    (0, common_1.Module)({
        imports: [
            config_1.ConfigModule.forRoot({
                isGlobal: true,
                ...(runtimeEnvFile ? { envFilePath: runtimeEnvFile } : {}),
                load: [config_2.appConfig, config_2.databaseConfig, config_2.jwtConfig, config_2.cryptoConfig, config_2.redisConfig, config_2.midtransConfig, config_2.r2Config, config_2.smtpConfig, config_2.fcmConfig],
                validate: env_validation_1.validateEnv,
            }),
            throttler_1.ThrottlerModule.forRootAsync({
                inject: [config_1.ConfigService],
                useFactory: (config) => {
                    const ttl = config.get('app.throttleGlobalTtlMs') ?? 60000;
                    const limit = config.get('app.throttleGlobalLimit') ?? 100;
                    const redisUrl = config.get('redis.url');
                    const nodeEnv = process.env.NODE_ENV || 'development';
                    const log = new common_2.Logger('ThrottlerModule');
                    if (!redisUrl) {
                        if (['production', 'staging'].includes(nodeEnv)) {
                            throw new Error('STARTUP ABORTED: REDIS_URL must be set in production/staging — Throttler requires Redis storage for multi-replica correctness.');
                        }
                        log.warn('Throttler running with in-memory storage (REDIS_URL unset). Per-IP limits will be inaccurate under multiple replicas.');
                        return [{ ttl, limit }];
                    }
                    return {
                        throttlers: [{ ttl, limit }],
                        storage: new throttler_storage_redis_1.ThrottlerStorageRedisService(redisUrl),
                    };
                },
            }),
            schedule_1.ScheduleModule.forRoot(),
            bull_1.BullModule.forRootAsync({
                inject: [config_1.ConfigService],
                useFactory: (config) => {
                    const redisUrl = config.get('redis.bullRedisUrl');
                    if (!redisUrl) {
                        throw new Error('redis.bullRedisUrl is not configured — set BULL_REDIS_URL env var');
                    }
                    const prefix = config.get('redis.prefix') || 'kahade:';
                    const useTls = redisUrl.startsWith('rediss://');
                    return {
                        url: redisUrl,
                        prefix: `${prefix}bull:`,
                        ...(useTls ? { redis: { tls: { rejectUnauthorized: true } } } : {}),
                    };
                },
            }),
            prisma_module_1.PrismaModule,
            redis_module_1.RedisModule,
            csrf_module_1.CsrfModule,
            auth_module_1.AuthModule,
            users_module_1.UsersModule,
            sessions_module_1.SessionsModule,
            kyc_module_1.KycModule,
            bank_accounts_module_1.BankAccountsModule,
            wallet_module_1.WalletModule,
            orders_module_1.OrdersModule,
            chat_module_1.ChatModule,
            disputes_module_1.DisputesModule,
            ratings_module_1.RatingsModule,
            notifications_module_1.NotificationsModule,
            referral_module_1.ReferralModule,
            vouchers_module_1.VouchersModule,
            subscriptions_module_1.SubscriptionsModule,
            settings_module_1.SettingsModule,
            upload_module_1.UploadModule,
            public_module_1.PublicModule,
            badges_module_1.BadgesModule,
            payment_module_1.PaymentModule,
            queue_module_1.QueueModule,
            scheduler_module_1.SchedulerModule,
            push_module_1.PushModule,
            realtime_module_1.RealtimeModule,
            withdrawals_module_1.WithdrawalsModule,
            help_center_module_1.HelpCenterModule,
            transaction_templates_module_1.TransactionTemplatesModule,
            support_module_1.SupportModule,
            config_api_module_1.ConfigApiModule,
            search_module_1.SearchModule,
            admin_module_1.AdminModule,
            health_module_1.HealthModule,
        ],
        providers: [
            {
                provide: core_1.APP_GUARD,
                useClass: global_throttle_guard_1.GlobalThrottleGuard,
            },
            {
                provide: core_1.APP_GUARD,
                useClass: throttler_1.ThrottlerGuard,
            },
            {
                provide: jwt_auth_guard_1.ADMIN_JWT_SERVICE,
                useFactory: (configService) => {
                    const secret = configService.get('jwt.adminSecret');
                    return new jwt_1.JwtService({ secret });
                },
                inject: [config_1.ConfigService],
            },
            {
                provide: core_1.APP_GUARD,
                useClass: jwt_auth_guard_1.JwtAuthGuard,
            },
            {
                provide: core_1.APP_GUARD,
                useClass: csrf_guard_1.CsrfGuard,
            },
            {
                provide: core_1.APP_INTERCEPTOR,
                useClass: idempotency_interceptor_1.IdempotencyInterceptor,
            },
            {
                provide: core_1.APP_INTERCEPTOR,
                useValue: new pagination_clamp_interceptor_1.PaginationClampInterceptor(100),
            },
        ],
    }),
    __metadata("design:paramtypes", [config_1.ConfigService])
], AppModule);
