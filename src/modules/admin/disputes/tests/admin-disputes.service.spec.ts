import { BadRequestException, NotFoundException } from '@nestjs/common';
import { WalletModeService } from '../../../wallet-mode/wallet-mode.service';
import { DisputeDanaSettlementService } from '../../../no-wallet/dispute-dana-settlement.service';
import { Test } from '@nestjs/testing';
import { AdminDisputesService } from '../admin-disputes.service';
import { PrismaService } from '../../../../prisma/prisma.service';
import { WalletTxSerialService } from '../../../../common/services/wallet-tx-serial.service';
import { AuditLogService } from '../../../../common/services/audit-log.service';
import { UploadService } from '../../../upload/upload.service';
import { RealtimeService } from '../../../realtime/realtime.service';
import { ChatService } from '../../../chat/chat.service';
import { DashboardService } from '../../dashboard/dashboard.service';
import { ApprovalsService } from '../../approvals/approvals.service';

describe('AdminDisputesService round-two boundaries', () => {
  const prisma: any = {
    dispute: { findMany: jest.fn(), count: jest.fn(), findFirst: jest.fn(), updateMany: jest.fn(), findUniqueOrThrow: jest.fn() },
    adminUser: { findUnique: jest.fn(), findFirst: jest.fn() },
  };
  const auditLog = { logAdminAction: jest.fn() };
  let service: AdminDisputesService;

  beforeEach(async () => {
    jest.resetAllMocks();
    const module = await Test.createTestingModule({
      providers: [
        AdminDisputesService,
        { provide: PrismaService, useValue: prisma },
        { provide: WalletTxSerialService, useValue: {} },
        { provide: AuditLogService, useValue: auditLog },
        { provide: UploadService, useValue: {} },
        { provide: RealtimeService, useValue: {} },
        { provide: ChatService, useValue: {} },
        // AW-018: mock helper invalidasi cache dashboard terpusat.
        { provide: DashboardService, useValue: { invalidateSummaryCache: jest.fn() } },
        // M3 no-wallet: wallet aktif di test ini → jalur wallet lama.
        { provide: WalletModeService, useValue: { isWalletEnabled: () => true } },
        { provide: DisputeDanaSettlementService, useValue: {} },
        // SEC-501: dual control — executor registry (mock).
        { provide: ApprovalsService, useValue: { registerExecutor: jest.fn(), propose: jest.fn() } },
      ],
    }).compile();
    service = module.get(AdminDisputesService);
  });

  it('uses the trimmed order ID search value for every OR branch', async () => {
    prisma.dispute.findMany.mockResolvedValue([]);
    prisma.dispute.count.mockResolvedValue(0);
    await service.listDisputes(1, 20, undefined, '  ORD-123  ');
    const where = prisma.dispute.findMany.mock.calls[0][0].where;
    expect(where.OR[0].disputeId.contains).toBe('ORD-123');
    expect(where.OR[1].order.orderId.contains).toBe('ORD-123');
  });

  it('AW-001: unassigned=true memfilter assignedAdminId IS NULL di SQL (tanpa filter client-side)', async () => {
    prisma.dispute.findMany.mockResolvedValue([]);
    prisma.dispute.count.mockResolvedValue(0);
    await service.listDisputes(1, 20, undefined, undefined, undefined, true);
    const findManyWhere = prisma.dispute.findMany.mock.calls[0][0].where;
    const countWhere = prisma.dispute.count.mock.calls[0][0].where;
    expect(findManyWhere.assignedAdminId).toBeNull();
    expect(countWhere.assignedAdminId).toBeNull();
  });

  it('AW-001: tanpa unassigned, filter assignedAdminId TIDAK ditambahkan', async () => {
    prisma.dispute.findMany.mockResolvedValue([]);
    prisma.dispute.count.mockResolvedValue(0);
    await service.listDisputes(1, 20, undefined, undefined, undefined, false);
    const where = prisma.dispute.findMany.mock.calls[0][0].where;
    expect(where).not.toHaveProperty('assignedAdminId');
  });

  it('rejects an inactive or otherwise ineligible target admin before writing assignment', async () => {
    prisma.dispute.findFirst.mockResolvedValue({ id: 'disp-1', disputeId: 'D-1', status: 'OPEN' });
    prisma.adminUser.findUnique.mockResolvedValue({ role: 'SUPER_ADMIN' });
    prisma.adminUser.findFirst.mockResolvedValue(null);
    await expect(service.assignAdmin('disp-1', 'super-1', 'inactive-1')).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.dispute.updateMany).not.toHaveBeenCalled();
  });

  it('issues an apology voucher to the non-fault winner chosen by the decision helper', async () => {
    const recipients = (service as any).disputeApologyRecipients(
      'FULL_BUYER',
      { buyerId: 'buyer-1', sellerId: 'seller-1' },
      BigInt(100_000),
      BigInt(0),
    );
    expect(recipients).toEqual(['buyer-1']);

    const tx = {
      voucher: {
        create: jest.fn().mockImplementation(async ({ data }) => ({ code: data.code })),
      },
    };
    const issued = await (service as any).issueDisputeApologyVouchers(tx, recipients, 'DSP-20260913-001');

    expect(issued).toHaveLength(1);
    expect(tx.voucher.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        assignedToUserId: 'buyer-1',
        createdBy: 'SYSTEM_DISPUTE_APOLOGY',
        voucherType: 'FEE_DISCOUNT_FLAT',
        discountAmount: BigInt(1_000_000),
      }),
    }));
  });

  it('requires an active dispute-capable role on the assignee lookup', async () => {
    prisma.dispute.findFirst.mockResolvedValue({ id: 'disp-1', disputeId: 'D-1', status: 'OPEN' });
    prisma.adminUser.findUnique.mockResolvedValue({ role: 'SUPER_ADMIN' });
    prisma.adminUser.findFirst.mockResolvedValue({ id: 'admin-2' });
    prisma.dispute.updateMany.mockResolvedValue({ count: 1 });
    prisma.dispute.findUniqueOrThrow.mockResolvedValue({ disputeId: 'D-1', status: 'ASSIGNED', assignedAdminId: 'admin-2', assignedAt: new Date() });
    await service.assignAdmin('disp-1', 'super-1', 'admin-2');
    expect(prisma.adminUser.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ isActive: true, deletedAt: null, role: { in: ['SUPER_ADMIN', 'DISPUTE_ADMIN'] } }),
    }));
  });

  describe('P1-1: computeDisbursementAmounts FULL_BUYER menghormati feeResponsibility', () => {
    // Nilai dalam sen (IDR x 100). orderValue Rp100.000, fee 2,5% = Rp2.500.
    const compute = (order: {
      buyerPayAmount: bigint; sellerReceiveAmount: bigint; buyerFeeAmount: bigint; completedAt: Date | null;
    }) =>
      (service as any).computeDisbursementAmounts(order, 'FULL_BUYER', undefined, undefined);

    it('feeResponsibility=BUYER: buyer refund = buyerPayAmount - buyerFeeAmount', () => {
      const r = compute({
        buyerPayAmount: BigInt(10_250_000),
        sellerReceiveAmount: BigInt(10_000_000),
        buyerFeeAmount: BigInt(250_000),
        completedAt: null,
      });
      expect(r.buyerAmount).toBe(BigInt(10_000_000));
      expect(r.sellerAmount).toBe(BigInt(0));
      expect(r.platformRetainAmount).toBe(BigInt(250_000));
      expect(r.totalDisbursement).toBe(r.escrowedAmount);
    });

    it('feeResponsibility=SELLER: buyer dapat refund PENUH sebesar yang dibayar', () => {
      const r = compute({
        buyerPayAmount: BigInt(10_000_000),
        sellerReceiveAmount: BigInt(9_750_000),
        buyerFeeAmount: BigInt(0),
        completedAt: null,
      });
      // Sebelum fix: buyer hanya dapat 9_750_000 (sellerReceiveAmount) — kurang Rp2.500.
      expect(r.buyerAmount).toBe(BigInt(10_000_000));
      expect(r.sellerAmount).toBe(BigInt(0));
      expect(r.platformRetainAmount).toBe(BigInt(0));
      expect(r.totalDisbursement).toBe(r.escrowedAmount);
    });

    it('feeResponsibility=SPLIT: buyer refund = buyerPayAmount - porsi fee buyer', () => {
      const r = compute({
        buyerPayAmount: BigInt(10_125_000),
        sellerReceiveAmount: BigInt(9_875_000),
        buyerFeeAmount: BigInt(125_000),
        completedAt: null,
      });
      expect(r.buyerAmount).toBe(BigInt(10_000_000));
      expect(r.sellerAmount).toBe(BigInt(0));
      expect(r.platformRetainAmount).toBe(BigInt(125_000));
      expect(r.totalDisbursement).toBe(r.escrowedAmount);
    });

    it('pasca-completion: refund dibatasi escrowedAmount (= sellerReceiveAmount)', () => {
      const r = compute({
        buyerPayAmount: BigInt(10_000_000),
        sellerReceiveAmount: BigInt(9_750_000),
        buyerFeeAmount: BigInt(0),
        completedAt: new Date(),
      });
      expect(r.escrowedAmount).toBe(BigInt(9_750_000));
      expect(r.buyerAmount).toBe(BigInt(9_750_000));
      expect(r.platformRetainAmount).toBe(BigInt(0));
      expect(r.isPostCompletionDispute).toBe(true);
    });
  });

  void BadRequestException;
});
