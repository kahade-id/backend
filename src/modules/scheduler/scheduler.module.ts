import { Module, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { PrismaModule } from '../../prisma/prisma.module';
import { RedisModule } from '../../redis/redis.module';
import { ReferralModule } from '../referral/referral.module';
import { OrdersModule } from '../orders/orders.module';
import { WalletTxSerialService } from '../../common/services/wallet-tx-serial.service';
import {
  WalletDailyResetService,
  DataCleanupService,
  PendingWithdrawCleanupService,
  PendingTopupCleanupService,
  AutoCompleteDeliveredOrdersService,
  AutoEscalateDisputesService,
  SubscriptionExpiryService,
  RedisHashCleanupService,
  WeeklyReconciliationService,
  WithdrawalReconciliationService,
  ExpireUnpaidOrdersService,
  ExpireUnconfirmedOrdersService,
  ExpireDisputeCallsService,
  NotificationArchivalService,
  OrphanedUploadCleanupService,
  ProcessScheduledWithdrawalsService,
  DlqMonitorService,
  TopupCounterCorrectionService,
  FraudChallengeEscalationService,
  DeadlineReminderService,
  ProofExpiryService,
  WebhookRetryService,
} from './services';
import { AdminFinanceModule } from '../admin/finance/admin-finance.module';
import { WithdrawalsModule } from '../withdrawals/withdrawals.module';
import { MidtransService } from '../payment/midtrans.service';
import { PaymentModule } from '../payment/payment.module';
import { WalletModule } from '../wallet/wallet.module';
import { OnApplicationBootstrap } from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import {
  getCronRuntimeSnapshots,
  markCronCompleted,
  markCronFailed,
  markCronStarted,
  registerCronRuntime,
} from '../../common/utils/cron-runtime.registry';
import { QueueModule } from '../queue/queue.module';
import { RedisService } from '../../redis/redis.service';
import { safeErrorMessage } from '../../common/utils/background-reliability.util';

@Module({
  imports: [PrismaModule, RedisModule, ReferralModule, ConfigModule, AdminFinanceModule, OrdersModule, WithdrawalsModule, QueueModule, PaymentModule, WalletModule],
  providers: [
    WalletDailyResetService,
    DataCleanupService,
    PendingWithdrawCleanupService,
    PendingTopupCleanupService,
    AutoCompleteDeliveredOrdersService,
    AutoEscalateDisputesService,
    SubscriptionExpiryService,
    RedisHashCleanupService,
    WeeklyReconciliationService,
    WithdrawalReconciliationService,
    ExpireUnpaidOrdersService,
    ExpireUnconfirmedOrdersService,
    ExpireDisputeCallsService,
    NotificationArchivalService,
    OrphanedUploadCleanupService,
    ProcessScheduledWithdrawalsService,
    DlqMonitorService,
    TopupCounterCorrectionService,
    FraudChallengeEscalationService,
    DeadlineReminderService,
    ProofExpiryService,
    WebhookRetryService,
    WalletTxSerialService,
    MidtransService,
  ],
})
export class SchedulerModule implements OnModuleDestroy, OnApplicationBootstrap {
  private readonly logger = new Logger(SchedulerModule.name);
  private instrumentationTimer?: ReturnType<typeof setImmediate>;

  constructor(
    private schedulerRegistry: SchedulerRegistry,
    private configService: ConfigService,
    private redis: RedisService,
  ) {}

  onApplicationBootstrap(): void {
    // ScheduleExplorer registers decorators during application bootstrap. Run
    // once now and once in the next turn so every cron is instrumented without
    // changing the decorated business methods.
    this.instrumentCronJobs();
    this.instrumentationTimer = setImmediate(() => this.instrumentCronJobs());
    this.instrumentationTimer.unref?.();
  }

  private instrumentCronJobs(): void {
    for (const [name, job] of this.schedulerRegistry.getCronJobs()) {
      const instrumentable = job as unknown as {
        waitForCompletion: boolean;
        fireOnTick: () => Promise<void>;
        errorHandler?: (error: unknown) => void;
        __kahadeInstrumented?: boolean;
      };
      if (instrumentable.__kahadeInstrumented) continue;
      instrumentable.__kahadeInstrumented = true;
      instrumentable.waitForCompletion = true;
      const previousErrorHandler = instrumentable.errorHandler;
      instrumentable.errorHandler = (error: unknown): void => {
        markCronFailed(name, error);
        void this.writeCronHeartbeat(name, 'failed', error);
        previousErrorHandler?.(error);
      };
      registerCronRuntime(name);
      const originalFireOnTick = instrumentable.fireOnTick.bind(job);
      instrumentable.fireOnTick = async (): Promise<void> => {
        markCronStarted(name);
        void this.writeCronHeartbeat(name, 'started');
        try {
          await originalFireOnTick();
          markCronCompleted(name);
          void this.writeCronHeartbeat(name, 'completed');
        } catch (error) {
          markCronFailed(name, error);
          void this.writeCronHeartbeat(name, 'failed', error);
          throw error;
        }
      };
    }
  }

  private async writeCronHeartbeat(name: string, state: 'started' | 'completed' | 'failed', error?: unknown): Promise<void> {
    await this.redis.setex(`cron_heartbeat:${name}`, 86400, JSON.stringify({
      cron: name,
      state,
      ranAt: new Date().toISOString(),
      ...(error ? { error: safeErrorMessage(error) } : {}),
    })).catch((heartbeatError: unknown) => {
      this.logger.warn(`Failed to write heartbeat for cron ${name}: ${safeErrorMessage(heartbeatError)}`);
    });
  }

  // SCH-025: Graceful shutdown — stop all cron jobs and wait for in-flight ticks.
  async onModuleDestroy(): Promise<void> {
    if (this.instrumentationTimer) clearImmediate(this.instrumentationTimer);
    this.logger.log('Scheduler shutting down — stopping all cron jobs...');
    const cronJobs = this.schedulerRegistry.getCronJobs();
    const stops = Array.from(cronJobs.entries()).map(async ([name, job]) => {
      try {
        await job.stop();
        this.logger.log(`Stopped cron job: ${name}`);
      } catch (error) {
        this.logger.error(`Failed to stop cron job ${name}: ${error instanceof Error ? error.message : String(error)}`);
      }
    });
    const configuredTimeout = this.configService.get<number>('app.shutdownTimeoutMs') ?? 30000;
    const waitTimeout = Math.min(5000, Math.max(1000, configuredTimeout - 250));
    await Promise.race([
      Promise.all(stops),
      new Promise<void>(resolve => setTimeout(resolve, waitTimeout)),
    ]);
    const running = getCronRuntimeSnapshots().filter(snapshot => snapshot.running).map(snapshot => snapshot.name);
    if (running.length > 0) {
      this.logger.warn(`Scheduler shutdown deadline reached with running cron jobs: ${running.join(', ')}`);
    }
    this.logger.log('Scheduler shutdown complete.');
  }
}
