import { Test } from '@nestjs/testing';
import { WalletModeService } from '../../../wallet-mode/wallet-mode.service';
import { DisputeDanaSettlementService } from '../../../no-wallet/dispute-dana-settlement.service';
import { AdminDisputesService } from '../admin-disputes.service';
import { PrismaService } from '../../../../prisma/prisma.service';
import { WalletTxSerialService } from '../../../../common/services/wallet-tx-serial.service';
import { AuditLogService } from '../../../../common/services/audit-log.service';
import { UploadService } from '../../../upload/upload.service';
import { RealtimeService } from '../../../realtime/realtime.service';
import { ChatService } from '../../../chat/chat.service';
import { DashboardService } from '../../dashboard/dashboard.service';

/**
 * M6 follow-up (Wave 2): order patungan yang selesai lewat verdict sengketa
 * (DISPUTE_RELEASE ke host) juga mendapat pengurang overfunding — sama
 * seperti completeOrder.
 *
 * Angka konkret (sen):
 * - Order: buyerPayAmount Rp1.050.000, sellerReceiveAmount Rp1.000.000,
 *   fee Rp50.000. Verdict FULL_SELLER pra-completion → sellerAmount =
 *   Rp1.000.000, platformRetainAmount = Rp50.000.
 * - Grup patungan: target Rp1.000.000, 5 peserta PAID × Rp250.000 =
 *   Rp1.250.000 → overfunding Rp250.000 → rebate Rp50.000/orang.
 * - Ekspektasi: host terima Rp950.000 (bukan Rp1.000.000), buyer dapat
 *   rebate Rp50.000 ke availableBalance + baris ledger ORDER_REFUND.
 */
describe('AdminDisputesService M6 dispute rebate (Wave 2)', () => {
  const SEN = (rp: number) => BigInt(rp) * 100n;

  const buyerWallet = {
    id: 'w-buyer', isLocked: false,
    escrowBalance: SEN(1_050_000), availableBalance: SEN(10_000), totalBalance: SEN(1_060_000),
    version: 3,
  };
  const sellerWallet = {
    id: 'w-seller', isLocked: false,
    escrowBalance: 0n, availableBalance: SEN(20_000), totalBalance: SEN(20_000),
    version: 7,
  };
  const orderRow: any = {
    id: 'order-db-1', orderId: 'ORD-1', buyerId: 'buyer-1', sellerId: 'seller-1',
    buyerPayAmount: SEN(1_050_000), sellerReceiveAmount: SEN(1_000_000),
    status: 'DISPUTED', completedAt: null,
    buyer: { wallet: { ...buyerWallet } },
    seller: { wallet: { ...sellerWallet } },
  };

  const paidParticipants = Array.from({ length: 5 }, (_, i) => ({ amount: SEN(250_000), _i: i }));

  let service: AdminDisputesService;
  let mockTx: Record<string, any>;
  let prisma: Record<string, any>;
  let serial = 1000;

  const buildModule = async (txOverrides: Record<string, any> = {}) => {
    serial = 1000;
    mockTx = {
      $queryRaw: jest.fn().mockResolvedValue([]),
      dispute: {
        findUnique: jest.fn().mockResolvedValue({ status: 'UNDER_REVIEW', assignedAdminId: null }),
        update: jest.fn().mockResolvedValue({}),
      },
      disputeMessage: { findFirst: jest.fn().mockResolvedValue(null) },
      disputeDecision: {
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({ id: 'dd-1' }),
      },
      order: {
        findUnique: jest.fn().mockResolvedValue(orderRow),
        update: jest.fn().mockResolvedValue({}),
      },
      orderStatusHistory: { create: jest.fn().mockResolvedValue({}) },
      wallet: {
        findUnique: jest.fn().mockImplementation(async ({ where }: any) => {
          if (where.id === 'w-buyer') return { ...buyerWallet };
          if (where.id === 'w-seller') return { ...sellerWallet };
          return null;
        }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      walletTransaction: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockImplementation(async ({ data }: any) => ({ id: `wtx-${data.txId}`, ...data })),
      },
      patunganParticipant: {
        findUnique: jest.fn().mockResolvedValue({ id: 'pp-1', groupId: 'g-1', status: 'PAID' }),
        findMany: jest.fn().mockResolvedValue(paidParticipants),
      },
      patunganGroup: {
        findUnique: jest.fn().mockResolvedValue({ status: 'TARGET_REACHED', targetAmount: SEN(1_000_000) }),
      },
      voucherUsage: { findFirst: jest.fn().mockResolvedValue(null) },
      voucher: { create: jest.fn().mockImplementation(async ({ data }: any) => ({ code: data.code, assignedToUserId: 'seller-1' })) },
      ...txOverrides,
    };
    prisma = {
      dispute: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'disp-1', disputeId: 'DSP-1', orderId: 'order-db-1',
          status: 'UNDER_REVIEW', assignedAdminId: null, createdAt: new Date(),
          order: orderRow,
        }),
      },
      adminUser: { findUnique: jest.fn().mockResolvedValue({ role: 'SUPER_ADMIN' }) },
      notification: { create: jest.fn().mockResolvedValue({}) },
      emitNotificationCreated: jest.fn(),
      // M3 no-wallet: tidak ada payment DANA di test ini → jalur wallet lama.
      paymentTransaction: { findFirst: jest.fn().mockResolvedValue(null) },
      $transaction: jest.fn((fn: (tx: unknown) => Promise<unknown>) => fn(mockTx)),
    };
    const module = await Test.createTestingModule({
      providers: [
        AdminDisputesService,
        { provide: PrismaService, useValue: prisma },
        { provide: WalletTxSerialService, useValue: { getNext: jest.fn().mockImplementation(async () => ++serial) } },
        { provide: AuditLogService, useValue: { logAdminAction: jest.fn() } },
        { provide: UploadService, useValue: {} },
        { provide: RealtimeService, useValue: {} },
        { provide: ChatService, useValue: {} },
        { provide: DashboardService, useValue: { invalidateSummaryCache: jest.fn() } },
        // M3 no-wallet: wallet aktif di test ini → jalur wallet lama.
        { provide: WalletModeService, useValue: { isWalletEnabled: () => true } },
        { provide: DisputeDanaSettlementService, useValue: {} },
      ],
    }).compile();
    service = module.get(AdminDisputesService);
  };

  const walletUpdateFor = (walletId: string) =>
    mockTx.wallet.updateMany.mock.calls
      .map((c: any[]) => c[0])
      .filter((a: any) => a.where.id === walletId);

  const ledgerCreates = () => mockTx.walletTransaction.create.mock.calls.map((c: any[]) => c[0].data);

  it('FULL_SELLER pada order patungan overfunded: host terima bersih − rebate, buyer dapat rebate', async () => {
    await buildModule();
    await service.resolveDispute('disp-1', 'admin-1', { decision: 'FULL_SELLER' } as never);

    // 1. Host dikredit Rp950.000 (Rp1.000.000 − rebate Rp50.000).
    const sellerUpdates = walletUpdateFor('w-seller');
    expect(sellerUpdates).toHaveLength(1);
    expect(sellerUpdates[0].data.availableBalance).toEqual({ increment: SEN(950_000) });
    expect(sellerUpdates[0].data.totalBalance).toEqual({ increment: SEN(950_000) });

    // 2. Buyer: escrow keluar penuh Rp1.000.000 (sumber dana host), tapi
    //    availableBalance +Rp50.000 (rebate) → total hanya −Rp950.000.
    const buyerUpdates = walletUpdateFor('w-buyer');
    const releaseUpdate = buyerUpdates.find((a: any) => a.data.escrowBalance?.decrement === SEN(1_000_000));
    expect(releaseUpdate).toBeDefined();
    expect(releaseUpdate.data.availableBalance).toEqual({ increment: SEN(50_000) });
    expect(releaseUpdate.data.totalBalance).toEqual({ decrement: SEN(950_000) });

    // 3. Ledger: DISPUTE_RELEASE Rp950.000 ke host + ORDER_REFUND rebate Rp50.000 ke buyer.
    const ledgers = ledgerCreates();
    const releaseLedger = ledgers.find((d: any) => d.type === 'DISPUTE_RELEASE');
    expect(releaseLedger.amount).toBe(SEN(950_000));
    expect(releaseLedger.walletId).toBe('w-seller');
    const rebateLedger = ledgers.find(
      (d: any) => d.type === 'ORDER_REFUND' && String(d.description).startsWith('Patungan overfunding rebate'),
    );
    expect(rebateLedger).toBeDefined();
    expect(rebateLedger.amount).toBe(SEN(50_000));
    expect(rebateLedger.walletId).toBe('w-buyer');
    expect(rebateLedger.balanceBefore).toBe(SEN(10_000));
    expect(rebateLedger.balanceAfter).toBe(SEN(60_000));
  });

  it('order non-patungan: tidak ada rebate, host terima penuh', async () => {
    await buildModule({
      patunganParticipant: {
        findUnique: jest.fn().mockResolvedValue(null),
        findMany: jest.fn().mockResolvedValue([]),
      },
    });
    await service.resolveDispute('disp-1', 'admin-1', { decision: 'FULL_SELLER' } as never);

    const sellerUpdates = walletUpdateFor('w-seller');
    expect(sellerUpdates[0].data.availableBalance).toEqual({ increment: SEN(1_000_000) });
    const ledgers = ledgerCreates();
    expect(ledgers.some(
      (d: any) => d.type === 'ORDER_REFUND' && String(d.description).startsWith('Patungan overfunding rebate'),
    )).toBe(false);
  });

  it('idempoten: baris rebate sudah ada → tidak double-rebate', async () => {
    await buildModule();
    mockTx.walletTransaction.findFirst.mockResolvedValue({ id: 'wtx-rebate-lama' });
    await service.resolveDispute('disp-1', 'admin-1', { decision: 'FULL_SELLER' } as never);

    const sellerUpdates = walletUpdateFor('w-seller');
    expect(sellerUpdates[0].data.availableBalance).toEqual({ increment: SEN(1_000_000) });
    const ledgers = ledgerCreates();
    expect(ledgers.some(
      (d: any) => d.type === 'ORDER_REFUND' && String(d.description).startsWith('Patungan overfunding rebate'),
    )).toBe(false);
  });
});
