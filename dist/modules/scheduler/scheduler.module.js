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
var SchedulerModule_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.SchedulerModule = void 0;
const common_1 = require("@nestjs/common");
const config_1 = require("@nestjs/config");
const prisma_module_1 = require("../../prisma/prisma.module");
const redis_module_1 = require("../../redis/redis.module");
const referral_module_1 = require("../referral/referral.module");
const orders_module_1 = require("../orders/orders.module");
const wallet_tx_serial_service_1 = require("../../common/services/wallet-tx-serial.service");
const services_1 = require("./services");
const admin_finance_module_1 = require("../admin/finance/admin-finance.module");
const withdrawals_module_1 = require("../withdrawals/withdrawals.module");
const midtrans_service_1 = require("../payment/midtrans.service");
const payment_module_1 = require("../payment/payment.module");
const wallet_module_1 = require("../wallet/wallet.module");
const schedule_1 = require("@nestjs/schedule");
const cron_runtime_registry_1 = require("../../common/utils/cron-runtime.registry");
const queue_module_1 = require("../queue/queue.module");
const redis_service_1 = require("../../redis/redis.service");
const background_reliability_util_1 = require("../../common/utils/background-reliability.util");
let SchedulerModule = SchedulerModule_1 = class SchedulerModule {
    constructor(schedulerRegistry, configService, redis) {
        this.schedulerRegistry = schedulerRegistry;
        this.configService = configService;
        this.redis = redis;
        this.logger = new common_1.Logger(SchedulerModule_1.name);
    }
    onApplicationBootstrap() {
        this.instrumentCronJobs();
        this.instrumentationTimer = setImmediate(() => this.instrumentCronJobs());
        this.instrumentationTimer.unref?.();
    }
    instrumentCronJobs() {
        for (const [name, job] of this.schedulerRegistry.getCronJobs()) {
            const instrumentable = job;
            if (instrumentable.__kahadeInstrumented)
                continue;
            instrumentable.__kahadeInstrumented = true;
            instrumentable.waitForCompletion = true;
            const previousErrorHandler = instrumentable.errorHandler;
            instrumentable.errorHandler = (error) => {
                (0, cron_runtime_registry_1.markCronFailed)(name, error);
                void this.writeCronHeartbeat(name, 'failed', error);
                previousErrorHandler?.(error);
            };
            (0, cron_runtime_registry_1.registerCronRuntime)(name);
            const originalFireOnTick = instrumentable.fireOnTick.bind(job);
            instrumentable.fireOnTick = async () => {
                (0, cron_runtime_registry_1.markCronStarted)(name);
                void this.writeCronHeartbeat(name, 'started');
                try {
                    await originalFireOnTick();
                    (0, cron_runtime_registry_1.markCronCompleted)(name);
                    void this.writeCronHeartbeat(name, 'completed');
                }
                catch (error) {
                    (0, cron_runtime_registry_1.markCronFailed)(name, error);
                    void this.writeCronHeartbeat(name, 'failed', error);
                    throw error;
                }
            };
        }
    }
    async writeCronHeartbeat(name, state, error) {
        await this.redis.setex(`cron_heartbeat:${name}`, 86400, JSON.stringify({
            cron: name,
            state,
            ranAt: new Date().toISOString(),
            ...(error ? { error: (0, background_reliability_util_1.safeErrorMessage)(error) } : {}),
        })).catch((heartbeatError) => {
            this.logger.warn(`Failed to write heartbeat for cron ${name}: ${(0, background_reliability_util_1.safeErrorMessage)(heartbeatError)}`);
        });
    }
    async onModuleDestroy() {
        if (this.instrumentationTimer)
            clearImmediate(this.instrumentationTimer);
        this.logger.log('Scheduler shutting down — stopping all cron jobs...');
        const cronJobs = this.schedulerRegistry.getCronJobs();
        const stops = Array.from(cronJobs.entries()).map(async ([name, job]) => {
            try {
                await job.stop();
                this.logger.log(`Stopped cron job: ${name}`);
            }
            catch (error) {
                this.logger.error(`Failed to stop cron job ${name}: ${error instanceof Error ? error.message : String(error)}`);
            }
        });
        const configuredTimeout = this.configService.get('app.shutdownTimeoutMs') ?? 30000;
        const waitTimeout = Math.min(5000, Math.max(1000, configuredTimeout - 250));
        await Promise.race([
            Promise.all(stops),
            new Promise(resolve => setTimeout(resolve, waitTimeout)),
        ]);
        const running = (0, cron_runtime_registry_1.getCronRuntimeSnapshots)().filter(snapshot => snapshot.running).map(snapshot => snapshot.name);
        if (running.length > 0) {
            this.logger.warn(`Scheduler shutdown deadline reached with running cron jobs: ${running.join(', ')}`);
        }
        this.logger.log('Scheduler shutdown complete.');
    }
};
exports.SchedulerModule = SchedulerModule;
exports.SchedulerModule = SchedulerModule = SchedulerModule_1 = __decorate([
    (0, common_1.Module)({
        imports: [prisma_module_1.PrismaModule, redis_module_1.RedisModule, referral_module_1.ReferralModule, config_1.ConfigModule, admin_finance_module_1.AdminFinanceModule, orders_module_1.OrdersModule, withdrawals_module_1.WithdrawalsModule, queue_module_1.QueueModule, payment_module_1.PaymentModule, wallet_module_1.WalletModule],
        providers: [
            services_1.WalletDailyResetService,
            services_1.DataCleanupService,
            services_1.PendingWithdrawCleanupService,
            services_1.PendingTopupCleanupService,
            services_1.AutoCompleteDeliveredOrdersService,
            services_1.AutoEscalateDisputesService,
            services_1.SubscriptionExpiryService,
            services_1.RedisHashCleanupService,
            services_1.WeeklyReconciliationService,
            services_1.WithdrawalReconciliationService,
            services_1.ExpireUnpaidOrdersService,
            services_1.ExpireUnconfirmedOrdersService,
            services_1.ExpireDisputeCallsService,
            services_1.NotificationArchivalService,
            services_1.OrphanedUploadCleanupService,
            services_1.ProcessScheduledWithdrawalsService,
            services_1.DlqMonitorService,
            services_1.TopupCounterCorrectionService,
            services_1.FraudChallengeEscalationService,
            services_1.DeadlineReminderService,
            services_1.ProofExpiryService,
            services_1.WebhookRetryService,
            wallet_tx_serial_service_1.WalletTxSerialService,
            midtrans_service_1.MidtransService,
        ],
    }),
    __metadata("design:paramtypes", [schedule_1.SchedulerRegistry,
        config_1.ConfigService,
        redis_service_1.RedisService])
], SchedulerModule);
