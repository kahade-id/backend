import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { getQueueToken } from '@nestjs/bull';
import { PrismaService } from '../../../prisma/prisma.service';
import { RedisService } from '../../../redis/redis.service';
import { WalletTxSerialService } from '../../../common/services/wallet-tx-serial.service';
import { ReferralService } from '../../referral/referral.service';
import { MembershipRankService } from '../../orders/membership-rank.service';
import { FeeCalculatorService } from '../../orders/fee-calculator.service';
import { ScheduledWithdrawalService } from '../../withdrawals/scheduled-withdrawal.service';
import { ReconciliationService } from '../../admin/finance/reconciliation.service';
import { MidtransService } from '../../payment/midtrans.service';
import { WalletService } from '../../wallet/wallet.service';
import { DEAD_LETTER_QUEUE } from '../../queue/queue.constants';
import { NotificationQueueService } from '../../queue/notification-queue.service';

import { AutoCompleteDeliveredOrdersService } from '../services/auto-complete-orders.service';
import { AutoEscalateDisputesService } from '../services/auto-escalate-disputes.service';
import { DataCleanupService } from '../services/data-cleanup.service';
import { DeadlineReminderService } from '../services/deadline-reminder.service';
import { DlqMonitorService } from '../services/dlq-monitor.service';
import { ExpireDisputeCallsService } from '../services/expire-dispute-calls.service';
import { ExpireUnconfirmedOrdersService } from '../services/expire-unconfirmed-orders.service';
import { ExpireUnpaidOrdersService } from '../services/expire-unpaid-orders.service';
import { FraudChallengeEscalationService } from '../services/fraud-challenge-escalation.service';
import { NotificationArchivalService } from '../services/notification-archival.service';
import { OrphanedUploadCleanupService } from '../services/orphaned-upload-cleanup.service';
import { PendingTopupCleanupService } from '../services/pending-topup-cleanup.service';
import { PendingWithdrawCleanupService } from '../services/pending-withdraw-cleanup.service';
import { ProcessScheduledWithdrawalsService } from '../services/process-scheduled-withdrawals.service';
import { ProofExpiryService } from '../services/proof-expiry.service';
import { RedisHashCleanupService } from '../services/redis-hash-cleanup.service';
import { SubscriptionExpiryService } from '../services/subscription-expiry.service';
import { TopupCounterCorrectionService } from '../services/topup-counter-correction.service';
import { WalletDailyResetService } from '../services/wallet-daily-reset.service';
import { WeeklyReconciliationService } from '../services/weekly-reconciliation.service';
import { WithdrawalReconciliationService } from '../services/withdrawal-reconciliation.service';

jest.mock('../../../common/utils/cron-jitter.util', () => ({
  cronJitter: jest.fn(async () => undefined),
}));

const mkPrisma = (): any => ({
  $queryRaw: jest.fn(async () => []),
  $executeRaw: jest.fn(async () => 0),
  $transaction: jest.fn(async (fn: any) => (typeof fn === 'function' ? fn(mkPrisma()) : Promise.all(fn))),
  user: { findMany: jest.fn(async () => []), updateMany: jest.fn(async () => ({ count: 0 })), update: jest.fn() },
  order: { findMany: jest.fn(async () => []), updateMany: jest.fn(async () => ({ count: 0 })), update: jest.fn() },
  dispute: { findMany: jest.fn(async () => []), updateMany: jest.fn(async () => ({ count: 0 })) },
  disputeCall: { updateMany: jest.fn(async () => ({ count: 0 })) },
  paymentTransaction: { findMany: jest.fn(async () => []), update: jest.fn() },
  notification: { deleteMany: jest.fn(async () => ({ count: 0 })), updateMany: jest.fn(async () => ({ count: 0 })) },
  walletTransaction: { create: jest.fn() },
  withdrawTransaction: { findMany: jest.fn(async () => []), update: jest.fn() },
  topUpTransaction: { findMany: jest.fn(async () => []), update: jest.fn() },
  scheduledWithdrawal: { findMany: jest.fn(async () => []) },
  subscription: { findMany: jest.fn(async () => []), update: jest.fn() },
  deliveryProof: { findMany: jest.fn(async () => []), updateMany: jest.fn(async () => ({ count: 0 })) },
  oneTimePassword: { deleteMany: jest.fn(async () => ({ count: 0 })) },
  webhookLog: { deleteMany: jest.fn(async () => ({ count: 0 })) },
  emailVerification: { deleteMany: jest.fn(async () => ({ count: 0 })) },
  walletDailyResetLog: { create: jest.fn() },
  fraudChallenge: { updateMany: jest.fn(async () => ({ count: 0 })) },
  topupAggregate: { upsert: jest.fn(), findMany: jest.fn(async () => []) },
  auditLog: { create: jest.fn() },
});

const mkRedis = (healthy = true): any => ({
  isHealthy: jest.fn(async () => healthy),
  setNx: jest.fn(async () => true),
  get: jest.fn(async () => null),
  set: jest.fn(),
  setex: jest.fn(),
  del: jest.fn(),
  expire: jest.fn(),
  scan: jest.fn(async () => ({ cursor: '0', keys: [] })),
  hgetall: jest.fn(async () => ({})),
  hdel: jest.fn(),
  ttl: jest.fn(async () => -1),
  keys: jest.fn(async () => []),
  hlen: jest.fn(async () => 0),
});

const mkConfig = (): any => ({ get: jest.fn(() => undefined) });
const mkQueue = (): any => ({ getWaitingCount: jest.fn(async () => 0), getFailedCount: jest.fn(async () => 0), getJobs: jest.fn(async () => []) });

async function build<T>(target: any, providers: any[] = []): Promise<T> {
  const mod = await Test.createTestingModule({
    providers: [
      target,
      { provide: PrismaService, useValue: mkPrisma() },
      { provide: RedisService, useValue: mkRedis(false) },
      { provide: ConfigService, useValue: mkConfig() },
      ...providers,
    ],
  }).compile();
  return mod.get(target);
}

describe('Scheduler services smoke', () => {
  it('AutoCompleteDeliveredOrdersService — defined + skips when redis unhealthy', async () => {
    const svc = await build<AutoCompleteDeliveredOrdersService>(AutoCompleteDeliveredOrdersService, [
      { provide: WalletTxSerialService, useValue: {} },
      { provide: ReferralService, useValue: {} },
      { provide: MembershipRankService, useValue: {} },
      { provide: FeeCalculatorService, useValue: {} },
    ]);
    expect(svc).toBeDefined();
    await expect(svc.autoComplete()).resolves.toBeUndefined();
  });

  it('AutoEscalateDisputesService — defined + skip', async () => {
    const svc = await build<AutoEscalateDisputesService>(AutoEscalateDisputesService);
    expect(svc).toBeDefined();
    await expect(svc.escalateBreachedDisputes()).resolves.toBeUndefined();
  });

  it('DataCleanupService — defined + skip', async () => {
    const svc = await build<DataCleanupService>(DataCleanupService);
    expect(svc).toBeDefined();
    await svc.onModuleInit();
    await expect(svc.cleanupExpiredData()).resolves.toBeUndefined();
  });

  it('DeadlineReminderService — defined + skip', async () => {
    const svc = await build<DeadlineReminderService>(DeadlineReminderService);
    expect(svc).toBeDefined();
    await expect(svc.sendDeadlineReminders()).resolves.toBeUndefined();
  });

  it('DlqMonitorService — defined + skip', async () => {
    const mod = await Test.createTestingModule({
      providers: [
        DlqMonitorService,
        { provide: RedisService, useValue: mkRedis(false) },
        { provide: getQueueToken(DEAD_LETTER_QUEUE), useValue: mkQueue() },
      ],
    }).compile();
    const svc = mod.get(DlqMonitorService);
    expect(svc).toBeDefined();
    await expect(svc.checkDlqDepth()).resolves.toBeUndefined();
  });

  it('ExpireDisputeCallsService — defined + skip', async () => {
    const svc = await build<ExpireDisputeCallsService>(ExpireDisputeCallsService);
    expect(svc).toBeDefined();
    await expect(svc.expireDisputeCalls()).resolves.toBeUndefined();
  });

  it('ExpireUnconfirmedOrdersService — defined + skip', async () => {
    const svc = await build<ExpireUnconfirmedOrdersService>(ExpireUnconfirmedOrdersService);
    expect(svc).toBeDefined();
    await expect(svc.expireUnconfirmedOrders()).resolves.toBeUndefined();
  });

  it('ExpireUnpaidOrdersService — defined + skip', async () => {
    const svc = await build<ExpireUnpaidOrdersService>(ExpireUnpaidOrdersService);
    expect(svc).toBeDefined();
    await expect(svc.expireUnpaidOrders()).resolves.toBeUndefined();
  });

  it('FraudChallengeEscalationService — defined + skip', async () => {
    const svc = await build<FraudChallengeEscalationService>(FraudChallengeEscalationService);
    expect(svc).toBeDefined();
    await expect(svc.escalateStaleChallenges()).resolves.toBeUndefined();
  });

  it('NotificationArchivalService — defined + skip', async () => {
    const svc = await build<NotificationArchivalService>(NotificationArchivalService);
    expect(svc).toBeDefined();
    await expect(svc.archiveOldNotifications()).resolves.toBeUndefined();
  });

  it('OrphanedUploadCleanupService — defined + skip', async () => {
    const mod = await Test.createTestingModule({
      providers: [
        OrphanedUploadCleanupService,
        { provide: RedisService, useValue: mkRedis(false) },
        { provide: ConfigService, useValue: mkConfig() },
      ],
    }).compile();
    const svc = mod.get(OrphanedUploadCleanupService);
    expect(svc).toBeDefined();
    await expect(svc.cleanupOrphanedUploads()).resolves.toBeUndefined();
  });

  it('PendingTopupCleanupService — defined + skip', async () => {
    const svc = await build<PendingTopupCleanupService>(PendingTopupCleanupService, [
      { provide: MidtransService, useValue: {} },
      { provide: WalletService, useValue: {} },
    ]);
    expect(svc).toBeDefined();
    await expect(svc.cleanupStaleTopups()).resolves.toBeUndefined();
  });

  it('PendingWithdrawCleanupService — defined + skip', async () => {
    const svc = await build<PendingWithdrawCleanupService>(PendingWithdrawCleanupService);
    expect(svc).toBeDefined();
    await expect(svc.cleanupExpiredWithdrawals()).resolves.toBeUndefined();
  });

  it('ProcessScheduledWithdrawalsService — defined + skip', async () => {
    const svc = await build<ProcessScheduledWithdrawalsService>(ProcessScheduledWithdrawalsService, [
      { provide: ScheduledWithdrawalService, useValue: { processDueScheduledWithdrawals: jest.fn() } },
    ]);
    expect(svc).toBeDefined();
    await expect(svc.processAll()).resolves.toBeUndefined();
  });

  it('ProofExpiryService — defined + skip', async () => {
    const svc = await build<ProofExpiryService>(ProofExpiryService);
    expect(svc).toBeDefined();
    await expect(svc.expireUnreviewedProofs()).resolves.toBeUndefined();
  });

  it('RedisHashCleanupService — defined + skip', async () => {
    const mod = await Test.createTestingModule({
      providers: [RedisHashCleanupService, { provide: RedisService, useValue: mkRedis(false) }],
    }).compile();
    const svc = mod.get(RedisHashCleanupService);
    expect(svc).toBeDefined();
    await expect(svc.cleanupUnboundedHashes()).resolves.toBeUndefined();
  });

  it('SubscriptionExpiryService — defined + skip', async () => {
    const svc = await build<SubscriptionExpiryService>(SubscriptionExpiryService, [
      { provide: WalletTxSerialService, useValue: {} },
    ]);
    expect(svc).toBeDefined();
    await expect(svc.handleExpiredSubscriptions()).resolves.toBeUndefined();
  });

  it('TopupCounterCorrectionService — defined + skip', async () => {
    const svc = await build<TopupCounterCorrectionService>(TopupCounterCorrectionService);
    expect(svc).toBeDefined();
    await expect(svc.processCorrections()).resolves.toBeUndefined();
  });

  it('WalletDailyResetService — defined + skip', async () => {
    const svc = await build<WalletDailyResetService>(WalletDailyResetService);
    expect(svc).toBeDefined();
    await expect(svc.resetDailyLimits()).resolves.toBeUndefined();
  });

  it('WeeklyReconciliationService — defined + skip', async () => {
    const svc = await build<WeeklyReconciliationService>(WeeklyReconciliationService, [
      { provide: ReconciliationService, useValue: { runReconciliation: jest.fn() } },
    ]);
    expect(svc).toBeDefined();
    await expect(svc.runDailyReconciliation()).resolves.toBeUndefined();
  });

  it('WithdrawalReconciliationService — defined + skip', async () => {
    const svc = await build<WithdrawalReconciliationService>(WithdrawalReconciliationService, [
      { provide: MidtransService, useValue: {} },
      { provide: NotificationQueueService, useValue: { enqueue: jest.fn() } },
    ]);
    expect(svc).toBeDefined();
    await expect(svc.reconcileProcessingWithdrawals()).resolves.toBeUndefined();
  });
});
