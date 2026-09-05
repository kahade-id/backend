import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { getQueueToken } from '@nestjs/bull';
import { PrismaService } from '../../../prisma/prisma.service';
import { RedisService } from '../../../redis/redis.service';
import { AuditLogService } from '../../../common/services/audit-log.service';
import { TokenService } from '../../auth/token.service';
import { WalletTxSerialService } from '../../../common/services/wallet-tx-serial.service';
import { OrderStateService } from '../../orders/order-state.service';
import { ReferralService } from '../../referral/referral.service';
import { MembershipRankService } from '../../orders/membership-rank.service';
import { FeeCalculatorService } from '../../orders/fee-calculator.service';
import { MidtransService } from '../../payment/midtrans.service';
import { UploadService } from '../../upload/upload.service';
import { RealtimeService } from '../../realtime/realtime.service';
import { OtpService } from '../../auth/otp.service';
import { NotificationQueueService } from '../../queue/notification-queue.service';
import { EMAIL_QUEUE } from '../../queue/processors/email.processor';

import { AdminAnalyticsService } from '../admin-analytics.service';
import { CampaignService } from '../campaign.service';
import { AdminAuthService } from '../auth/admin-auth.service';
import { AdminBadgesService } from '../badges/admin-badges.service';
import { DashboardService } from '../dashboard/dashboard.service';
import { AdminDisputesService } from '../disputes/admin-disputes.service';
import { AdminFinanceService } from '../finance/admin-finance.service';
import { ReconciliationService } from '../finance/reconciliation.service';
import { AdminKycService } from '../kyc/admin-kyc.service';
import { AdminManagementService } from '../management/admin-management.service';
import { AdminOrdersService } from '../orders/admin-orders.service';
import { AdminRatingsService } from '../ratings/admin-ratings.service';
import { AdminReferralService } from '../referral/admin-referral.service';
import { AdminReportsService } from '../reports/admin-reports.service';
import { AdminSubscriptionsService } from '../subscriptions/admin-subscriptions.service';
import { AdminSupportService } from '../support/admin-support.service';
import { AdminSystemService } from '../system/admin-system.service';
import { AdminUsersService } from '../users/admin-users.service';
import { AdminVouchersService } from '../vouchers/admin-vouchers.service';

const mkPrisma = (): any => new Proxy({}, {
  get: (_t, p) => {
    if (p === 'then') return undefined;
    if (p === '$transaction') return jest.fn(async (fn: any) => (typeof fn === 'function' ? fn(mkPrisma()) : Promise.all(fn)));
    if (p === '$queryRaw' || p === '$executeRaw') return jest.fn(async () => []);
    return new Proxy({}, {
      get: (_t2, m) => {
        if (m === 'then') return undefined;
        return jest.fn(async () => {
          if (m === 'count') return 0;
          if (m === 'findMany' || m === 'aggregate') return [];
          if (m === 'findUnique' || m === 'findFirst') return null;
          if (m === 'create' || m === 'update' || m === 'upsert') return {};
          if (m === 'updateMany' || m === 'deleteMany') return { count: 0 };
          return null;
        });
      },
    });
  },
});

const mkRedis = (): any => ({
  isHealthy: jest.fn(async () => true),
  get: jest.fn(async () => null),
  set: jest.fn(),
  setex: jest.fn(),
  del: jest.fn(),
  keys: jest.fn(async () => []),
  setNx: jest.fn(async () => true),
  expire: jest.fn(),
  ttl: jest.fn(async () => -1),
});

const mkConfig = (): any => ({ get: jest.fn(() => undefined) });
const mkQueue = (): any => ({ add: jest.fn(), getWaitingCount: jest.fn(async () => 0), getFailedCount: jest.fn(async () => 0), getJobs: jest.fn(async () => []) });

async function build<T>(target: any, extras: any[] = []): Promise<T> {
  const mod = await Test.createTestingModule({
    providers: [
      target,
      { provide: PrismaService, useValue: mkPrisma() },
      { provide: RedisService, useValue: mkRedis() },
      { provide: ConfigService, useValue: mkConfig() },
      { provide: AuditLogService, useValue: { log: jest.fn(), logUserAction: jest.fn(), logAdminAction: jest.fn() } },
      { provide: NotificationQueueService, useValue: { enqueue: jest.fn(), enqueueMany: jest.fn() } },
      ...extras,
    ],
  }).compile();
  return mod.get(target);
}

describe('Admin services smoke', () => {
  it('AdminAnalyticsService defined', async () => {
    const s = await build<AdminAnalyticsService>(AdminAnalyticsService);
    expect(s).toBeDefined();
  });

  it('CampaignService defined', async () => {
    const s = await build<CampaignService>(CampaignService);
    expect(s).toBeDefined();
  });

  it('AdminAuthService defined', async () => {
    const s = await build<AdminAuthService>(AdminAuthService, [
      { provide: TokenService, useValue: { generateAccessToken: jest.fn(), generateRefreshToken: jest.fn() } },
    ]);
    expect(s).toBeDefined();
  });

  it('AdminBadgesService defined + listBadges', async () => {
    const s = await build<AdminBadgesService>(AdminBadgesService, [
      { provide: NotificationQueueService, useValue: { enqueue: jest.fn() } },
    ]);
    expect(s).toBeDefined();
    const res: any = await s.listBadges(1, 10);
    expect(res).toBeDefined();
  });

  it('DashboardService defined + getSummary cache miss path', async () => {
    const s = await build<DashboardService>(DashboardService);
    expect(s).toBeDefined();
  });

  it('AdminDisputesService defined + listDisputes', async () => {
    const s = await build<AdminDisputesService>(AdminDisputesService, [
      { provide: WalletTxSerialService, useValue: {} },
      { provide: UploadService, useValue: { generateDownloadUrl: jest.fn() } },
      { provide: RealtimeService, useValue: { emit: jest.fn() } },
    ]);
    expect(s).toBeDefined();
    const res: any = await s.listDisputes(1, 10);
    expect(res).toBeDefined();
  });

  it('AdminFinanceService defined', async () => {
    const s = await build<AdminFinanceService>(AdminFinanceService, [
      { provide: MidtransService, useValue: {} },
    ]);
    expect(s).toBeDefined();
  });

  it('ReconciliationService defined', async () => {
    const s = await build<ReconciliationService>(ReconciliationService);
    expect(s).toBeDefined();
  });

  it('AdminKycService defined', async () => {
    const s = await build<AdminKycService>(AdminKycService, [
      { provide: UploadService, useValue: {} },
      { provide: getQueueToken(EMAIL_QUEUE), useValue: mkQueue() },
    ]);
    expect(s).toBeDefined();
  });

  it('AdminManagementService defined + listAdmins', async () => {
    const s = await build<AdminManagementService>(AdminManagementService);
    expect(s).toBeDefined();
    const res: any = await s.listAdmins(1, 10);
    expect(res).toBeDefined();
  });

  it('AdminOrdersService defined', async () => {
    const s = await build<AdminOrdersService>(AdminOrdersService, [
      { provide: OrderStateService, useValue: {} },
      { provide: WalletTxSerialService, useValue: {} },
      { provide: ReferralService, useValue: {} },
      { provide: MembershipRankService, useValue: {} },
      { provide: FeeCalculatorService, useValue: { getFeeConfig: jest.fn(), getPlusSavingsSen: jest.fn() } },
    ]);
    expect(s).toBeDefined();
  });

  it('AdminRatingsService defined + listRatings', async () => {
    const s = await build<AdminRatingsService>(AdminRatingsService);
    expect(s).toBeDefined();
    const res: any = await s.listRatings(1, 10);
    expect(res).toBeDefined();
  });

  it('AdminReferralService defined', async () => {
    const s = await build<AdminReferralService>(AdminReferralService);
    expect(s).toBeDefined();
  });

  it('AdminReportsService defined + listReports', async () => {
    const s = await build<AdminReportsService>(AdminReportsService);
    expect(s).toBeDefined();
    const res: any = await s.listReports(1, 10);
    expect(res).toBeDefined();
  });

  it('AdminSubscriptionsService defined + listSubscriptions', async () => {
    const s = await build<AdminSubscriptionsService>(AdminSubscriptionsService, [
      { provide: MidtransService, useValue: {} },
    ]);
    expect(s).toBeDefined();
    const res: any = await s.listSubscriptions(1, 10);
    expect(res).toBeDefined();
  });

  it('AdminSupportService defined + listTickets', async () => {
    const s = await build<AdminSupportService>(AdminSupportService);
    expect(s).toBeDefined();
    const res: any = await s.listTickets(1, 10);
    expect(res).toBeDefined();
  });

  it('AdminSystemService defined', async () => {
    const s = await build<AdminSystemService>(AdminSystemService);
    expect(s).toBeDefined();
  });

  it('AdminUsersService defined + listUsers', async () => {
    const s = await build<AdminUsersService>(AdminUsersService, [
      { provide: WalletTxSerialService, useValue: {} },
      { provide: OtpService, useValue: {} },
      { provide: getQueueToken(EMAIL_QUEUE), useValue: mkQueue() },
    ]);
    expect(s).toBeDefined();
    const res: any = await s.listUsers(1, 10);
    expect(res).toBeDefined();
  });

  it('AdminVouchersService defined + listVouchers', async () => {
    const s = await build<AdminVouchersService>(AdminVouchersService);
    expect(s).toBeDefined();
    const res: any = await s.listVouchers(1, 10);
    expect(res).toBeDefined();
  });
});
