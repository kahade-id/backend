/**
 * GAP-D retur — unit test (G225).
 *
 * Mencakup: guard transisi state legal/ilegal, idempotensi approval refund
 * (G210: 2x createApproval → 1 record; claim eksekusi 2x → tepat 1 eksekusi
 * ledger), dan penolakan pengajuan ganda (G218). Prisma di-mock penuh —
 * tidak butuh database.
 */
import {
  BadRequestException,
  ConflictException,
} from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { WalletTxSerialService } from '../../../common/services/wallet-tx-serial.service';
import { UploadService } from '../../upload/upload.service';
import { AuditLogService } from '../../../common/services/audit-log.service';
import { ReturnsService, RETURN_DUPLICATE } from '../returns.service';
import { ReturnsNotifyService } from '../returns-notify.service';
import { ReturnsRefundService } from '../returns-refund.service';
import { WalletModeService } from '../../wallet-mode/wallet-mode.service';
import { DanaDirectRefundService } from '../../no-wallet/dana-direct-refund.service';
import {
  assertLegalReturnTransition,
  isLegalReturnTransition,
  RETURN_INVALID_TRANSITION,
  ACTIVE_RETURN_STATUSES,
} from '../returns-state';
import { TERMINAL_RETURN_STATUSES } from '../returns.types';
import type { ReturnRequestRow } from '../returns.types';

type MockFn = jest.Mock;

function makeDelegate() {
  return {
    findUnique: jest.fn(),
    findFirst: jest.fn(),
    findMany: jest.fn(),
    count: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    updateMany: jest.fn(),
  };
}
type Delegate = ReturnType<typeof makeDelegate>;

function baseReturn(overrides: Partial<ReturnRequestRow> = {}): ReturnRequestRow {
  return {
    id: 'ret-db-1',
    returnId: 'RTN-20260926-0001',
    orderId: 'order-db-1',
    itemRef: null,
    buyerId: 'buyer-1',
    sellerId: 'seller-1',
    status: 'REQUESTED',
    reasonCode: 'BARANG_RUSAK',
    reasonDetail: null,
    resolutionType: 'REFUND',
    refundAmount: null,
    sellerRespondBy: new Date(Date.now() + 72 * 3_600_000),
    rejectReasonCode: null,
    rejectNote: null,
    clarificationQuestion: null,
    returnInstructions: null,
    shipBy: null,
    returnTrackingNumber: null,
    returnCourier: null,
    receivedAt: null,
    receivedNote: null,
    disputeId: null,
    approvedAt: null,
    rejectedAt: null,
    resolvedAt: null,
    cancelledAt: null,
    expiredAt: null,
    escalatedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

describe('ReturnsService (GAP-D retur)', () => {
  let prisma: Record<string, unknown>;
  let delegates: Record<string, Delegate>;
  let orderDelegate: Delegate;
  let walletDelegate: Delegate;
  let serial: { getNextForPrefix: MockFn };
  let uploadService: { verifyEvidenceFileKeysBatch: MockFn; cleanupFileKeys: MockFn };
  let auditLog: { logUserAction: MockFn; logAdminAction: MockFn };
  let notify: { notifyStage: MockFn; notifyBoth: MockFn };
  let refundService: ReturnsRefundService;
  let walletMode: { isWalletEnabled: MockFn };
  let danaDirectRefundService: { refundAmount: MockFn };
  let stepUp: { consumeStepUpToken: MockFn };
  let service: ReturnsService;

  beforeEach(() => {
    delegates = {
      returnPolicy: makeDelegate(),
      returnRequest: makeDelegate(),
      returnAttachment: makeDelegate(),
      returnNote: makeDelegate(),
      returnTimeline: makeDelegate(),
      returnShipmentEvent: makeDelegate(),
      returnRefundApproval: makeDelegate(),
      adminUser: makeDelegate(),
      danaRefundAttempt: makeDelegate(),
      paymentTransaction: makeDelegate(),
    };
    orderDelegate = makeDelegate();
    walletDelegate = makeDelegate();
    prisma = {
      ...delegates,
      order: orderDelegate,
      dispute: makeDelegate(),
      wallet: walletDelegate,
      walletTransaction: makeDelegate(),
      notification: makeDelegate(),
      adminAuditLog: makeDelegate(),
      $transaction: jest.fn(),
      emitNotificationCreated: jest.fn(),
    };
    serial = { getNextForPrefix: jest.fn().mockResolvedValue(7) };
    uploadService = {
      verifyEvidenceFileKeysBatch: jest.fn(),
      cleanupFileKeys: jest.fn().mockResolvedValue({ deleted: 1, errors: [] }),
    };
    auditLog = { logUserAction: jest.fn(), logAdminAction: jest.fn() };
    notify = {
      notifyStage: jest.fn().mockResolvedValue(undefined),
      notifyBoth: jest.fn().mockResolvedValue(undefined),
    };
    refundService = new ReturnsRefundService(
      prisma as unknown as PrismaService,
      serial as unknown as WalletTxSerialService,
    );
    // HEAD (7d3075c) menambah walletMode + danaDirectRefundService ke konstruktor.
    // Default wallet ENABLED agar test jalur ledger wallet lama tetap valid.
    walletMode = { isWalletEnabled: jest.fn().mockReturnValue(true) };
    danaDirectRefundService = { refundAmount: jest.fn() };
    stepUp = { consumeStepUpToken: jest.fn().mockResolvedValue(undefined) };
    service = new ReturnsService(
      prisma as unknown as PrismaService,
      serial as unknown as WalletTxSerialService,
      uploadService as unknown as UploadService,
      auditLog as unknown as AuditLogService,
      notify as unknown as ReturnsNotifyService,
      refundService,
      walletMode as unknown as WalletModeService,
      danaDirectRefundService as unknown as DanaDirectRefundService,
      // Audit 2026-10-10: aksi uang admin wajib step-up — mock menerima token apa pun.
      stepUp as never,
    );
    jest.clearAllMocks();
    stepUp.consumeStepUpToken.mockResolvedValue(undefined);
    // jest.clearAllMocks menghapus implementasi mockResolvedValue di atas —
    // setel ulang default yang dibutuhkan semua test.
    serial.getNextForPrefix.mockResolvedValue(7);
    notify.notifyStage.mockResolvedValue(undefined);
    notify.notifyBoth.mockResolvedValue(undefined);
    uploadService.cleanupFileKeys.mockResolvedValue({ deleted: 1, errors: [] });
    delegates.returnTimeline.create.mockResolvedValue({});
    // BAI-083: guard aksi-uang di adminAct membaca role admin — default SUPER_ADMIN.
    delegates.adminUser.findUnique.mockResolvedValue({ role: 'SUPER_ADMIN' });
  });

  // ---------------------------------------------------------- state machine
  describe('state machine (G202)', () => {
    it('mengizinkan transisi legal REQUESTED → SELLER_REVIEW', () => {
      expect(isLegalReturnTransition('REQUESTED', 'SELLER_REVIEW')).toBe(true);
    });

    it('menolak transisi ilegal REQUESTED → RECEIVED', () => {
      expect(isLegalReturnTransition('REQUESTED', 'RECEIVED')).toBe(false);
    });

    it('assertLegalReturnTransition melempar dengan kode RETURN_INVALID_TRANSITION', () => {
      try {
        assertLegalReturnTransition('APPROVED', 'REQUESTED');
        fail('seharusnya melempar');
      } catch (err) {
        expect(err).toBeInstanceOf(BadRequestException);
        const res = (err as BadRequestException).getResponse() as Record<string, unknown>;
        expect((res.details as Record<string, unknown>).transitionCode).toBe(RETURN_INVALID_TRANSITION);
      }
    });

    it('status terminal tidak punya transisi keluar', () => {
      for (const s of TERMINAL_RETURN_STATUSES) {
        expect(isLegalReturnTransition(s, 'ESCALATED')).toBe(false);
        expect(isLegalReturnTransition(s, 'REQUESTED')).toBe(false);
      }
    });

    it('REJECTED hanya bisa ke ESCALATED', () => {
      expect(isLegalReturnTransition('REJECTED', 'ESCALATED')).toBe(true);
      expect(isLegalReturnTransition('REJECTED', 'APPROVED')).toBe(false);
      expect(isLegalReturnTransition('REJECTED', 'CANCELLED')).toBe(false);
    });

    it('ACTIVE_RETURN_STATUSES mencakup status berjalan, bukan terminal', () => {
      expect(ACTIVE_RETURN_STATUSES.has('REQUESTED')).toBe(true);
      expect(ACTIVE_RETURN_STATUSES.has('RECEIVED')).toBe(true);
      expect(ACTIVE_RETURN_STATUSES.has('CANCELLED')).toBe(false);
      expect(ACTIVE_RETURN_STATUSES.has('RESOLVED_REFUND')).toBe(false);
      expect(ACTIVE_RETURN_STATUSES.has('ESCALATED')).toBe(false);
    });
  });

  // ------------------------------------------------------- guard di service
  describe('guard transisi di service', () => {
    it('sellerStartReview: REQUESTED → SELLER_REVIEW (legal)', async () => {
      delegates.returnRequest.findUnique.mockResolvedValue(baseReturn({ status: 'REQUESTED' }));
      delegates.returnRequest.updateMany.mockResolvedValue({ count: 1 });
      // mustFind kedua (setelah update) mengembalikan status baru
      delegates.returnRequest.findUnique.mockResolvedValueOnce(baseReturn({ status: 'REQUESTED' }))
        .mockResolvedValueOnce(baseReturn({ status: 'SELLER_REVIEW' }));

      const out = await service.sellerStartReview('ret-db-1', 'seller-1');
      expect(out.status).toBe('SELLER_REVIEW');
      expect(delegates.returnRequest.updateMany).toHaveBeenCalledTimes(1);
    });

    it('sellerStartReview pada status RECEIVED ditolak (ilegal)', async () => {
      delegates.returnRequest.findUnique.mockResolvedValue(baseReturn({ status: 'RECEIVED' }));

      await expect(service.sellerStartReview('ret-db-1', 'seller-1'))
        .rejects.toBeInstanceOf(BadRequestException);
      expect(delegates.returnRequest.updateMany).not.toHaveBeenCalled();
    });

    it('transisi konkuren (updateMany count=0) melempar konflik', async () => {
      delegates.returnRequest.findUnique.mockResolvedValue(baseReturn({ status: 'REQUESTED' }));
      delegates.returnRequest.updateMany.mockResolvedValue({ count: 0 });

      await expect(service.sellerStartReview('ret-db-1', 'seller-1'))
        .rejects.toBeInstanceOf(ConflictException);
    });
  });

  // ------------------------------------------- idempotensi approval (G210)
  describe('idempotensi approval refund (G210)', () => {
    const approvalInput = (ret: ReturnRequestRow) => ({
      returnRequest: ret,
      amountSen: BigInt(150000),
      approvedBy: 'seller-1',
      approvedByRole: 'SELLER' as const,
      maxRefundSen: BigInt(200000),
    });

    it('2x createApproval → 1 record (panggilan kedua mengembalikan existing)', async () => {
      const created = {
        id: 'appr-1', returnRequestId: 'ret-db-1', idempotencyKey: 'RTN-APPR-RTN-20260926-0001',
        amount: BigInt(150000), status: 'PENDING', approvedBy: 'seller-1',
        approvedByRole: 'SELLER', approvedAt: new Date(), executedAt: null,
        failureReason: null, walletTxIds: [],
      };
      delegates.returnRefundApproval.findUnique
        .mockResolvedValueOnce(null)      // panggilan 1: belum ada
        .mockResolvedValueOnce(created);  // panggilan 2: sudah ada
      delegates.returnRefundApproval.create.mockResolvedValue(created);

      const ret = baseReturn();
      const first = await refundService.createApproval(approvalInput(ret));
      const second = await refundService.createApproval(approvalInput(ret));

      expect(first.id).toBe('appr-1');
      expect(second.id).toBe('appr-1');
      expect(delegates.returnRefundApproval.create).toHaveBeenCalledTimes(1);
    });

    it('nominal nol / negatif ditolak', async () => {
      await expect(refundService.createApproval({
        ...approvalInput(baseReturn()),
        amountSen: BigInt(0),
      })).rejects.toBeInstanceOf(BadRequestException);
    });

    it('nominal melebihi pagu ditolak', async () => {
      await expect(refundService.createApproval({
        ...approvalInput(baseReturn()),
        amountSen: BigInt(999999),
      })).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  // ------------------------------------------- idempotensi eksekusi (G211)
  describe('idempotensi eksekusi refund (G211): 2x resolve → 1 eksekusi ledger', () => {
    const received = () => baseReturn({
      status: 'RECEIVED',
      resolutionType: 'REFUND',
      refundAmount: BigInt(150000),
    });
    const pendingApproval = () => ({
      id: 'appr-1', returnRequestId: 'ret-db-1', idempotencyKey: 'RTN-APPR-RTN-20260926-0001',
      amount: BigInt(150000), status: 'PENDING', approvedBy: 'seller-1',
      approvedByRole: 'SELLER', approvedAt: new Date(), executedAt: null,
      failureReason: null, walletTxIds: [],
    });
    const executedApproval = () => ({ ...pendingApproval(), status: 'EXECUTED', executedAt: new Date() });

    function mockLedgerSuccess() {
      walletDelegate.findFirst
        .mockResolvedValueOnce({ id: 'wallet-seller' })
        .mockResolvedValueOnce({ id: 'wallet-buyer' });
      const tx = {
        $queryRaw: jest.fn().mockResolvedValue([]),
        wallet: {
          findUnique: jest.fn().mockImplementation(({ where }: { where: { id: string } }) => Promise.resolve({
            id: where.id, version: 3, isLocked: false, availableBalance: BigInt(500000),
          })),
          updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        },
        walletTransaction: { create: jest.fn().mockResolvedValue({}) },
      };
      (prisma.$transaction as MockFn).mockImplementation(async (cb: (t: unknown) => Promise<unknown>) => cb(tx));
      delegates.returnRefundApproval.update.mockResolvedValue({});
    }

    it('resolveReturn 2x: eksekusi ledger tepat 1x', async () => {
      delegates.returnRequest.findUnique.mockResolvedValue(received());
      delegates.returnPolicy.findFirst.mockResolvedValue(null); // default policy
      // panggilan 1: approval PENDING → klaim sukses → eksekusi
      // panggilan 2: approval sudah EXECUTED → lewati eksekusi
      delegates.returnRefundApproval.findUnique
        .mockResolvedValueOnce(pendingApproval())
        .mockResolvedValue(executedApproval());
      delegates.returnRefundApproval.updateMany.mockResolvedValue({ count: 1 });
      delegates.returnRequest.updateMany.mockResolvedValue({ count: 1 });
      mockLedgerSuccess();
      const executeSpy = jest.spyOn(refundService, 'executeLedgerRefund');

      await service.resolveReturn('ret-db-1', 'seller-1', 'SELLER', 'REFUND');
      await service.resolveReturn('ret-db-1', 'seller-1', 'SELLER', 'REFUND');

      expect(executeSpy).toHaveBeenCalledTimes(1);
      expect(delegates.returnRefundApproval.updateMany).toHaveBeenCalledTimes(1); // klaim atomik 1x
      executeSpy.mockRestore();
    });

    it('claimExecution: klaim kedua gagal (false) — tidak ada eksekusi ganda', async () => {
      delegates.returnRefundApproval.updateMany
        .mockResolvedValueOnce({ count: 1 })
        .mockResolvedValueOnce({ count: 0 });

      expect(await refundService.claimExecution('appr-1')).toBe(true);
      expect(await refundService.claimExecution('appr-1')).toBe(false);
    });
  });

  // ------------------------------------------------- pengajuan ganda (G218)
  describe('cegah pengajuan ganda (G218)', () => {
    const eligibleOk = {
      eligible: true, reason: null, submitDeadline: new Date(Date.now() + 86_400_000),
      returnWindowDays: 7, orderPublicId: 'ORD-20260926-0001',
    };

    it('pengajuan kedua saat case aktif → ConflictException RETURN_DUPLICATE', async () => {
      jest.spyOn(service, 'getEligibility').mockResolvedValue(eligibleOk);
      orderDelegate.findFirst.mockResolvedValue({
        id: 'order-db-1', orderId: 'ORD-20260926-0001', buyerId: 'buyer-1',
        sellerId: 'seller-1', status: 'COMPLETED', orderType: 'PHYSICAL_GOODS',
        completedAt: new Date(), buyerPayAmount: BigInt(200000),
      });
      delegates.returnPolicy.findFirst.mockResolvedValue(null);
      // cek duplikat di createReturn menemukan case aktif
      delegates.returnRequest.findFirst.mockResolvedValue(baseReturn({ status: 'SELLER_REVIEW' }));

      try {
        await service.createReturn('buyer-1', {
          orderId: 'ORD-20260926-0001',
          reasonCode: 'BARANG_RUSAK',
        } as never);
        fail('seharusnya melempar ConflictException');
      } catch (err) {
        expect(err).toBeInstanceOf(ConflictException);
        const res = (err as ConflictException).getResponse() as Record<string, unknown>;
        expect(res.code).toBe(RETURN_DUPLICATE);
      }
      expect(delegates.returnRequest.create).not.toHaveBeenCalled();
    });

    it('race konkuren (unique violation P2002) → ConflictException RETURN_DUPLICATE', async () => {
      jest.spyOn(service, 'getEligibility').mockResolvedValue(eligibleOk);
      orderDelegate.findFirst.mockResolvedValue({
        id: 'order-db-1', orderId: 'ORD-20260926-0001', buyerId: 'buyer-1',
        sellerId: 'seller-1', status: 'COMPLETED', orderType: 'PHYSICAL_GOODS',
        completedAt: new Date(), buyerPayAmount: BigInt(200000),
      });
      delegates.returnPolicy.findFirst.mockResolvedValue(null);
      delegates.returnRequest.findFirst.mockResolvedValue(null); // lolos cek aplikasi
      const p2002 = Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });
      delegates.returnRequest.create.mockRejectedValue(p2002); // backstop DB menang

      try {
        await service.createReturn('buyer-1', {
          orderId: 'ORD-20260926-0001',
          reasonCode: 'BARANG_RUSAK',
        } as never);
        fail('seharusnya melempar ConflictException');
      } catch (err) {
        expect(err).toBeInstanceOf(ConflictException);
        const res = (err as ConflictException).getResponse() as Record<string, unknown>;
        expect(res.code).toBe(RETURN_DUPLICATE);
      }
    });
  });

  // --------------------------------- ADM-114: EXTEND_DEADLINE (+24 jam, fail-closed)
  describe('adminAct EXTEND_DEADLINE (ADM-114)', () => {
    const base = new Date('2026-09-27T10:00:00Z');

    beforeEach(() => {
      delegates.returnRequest.findUnique.mockResolvedValue(
        baseReturn({ status: 'REQUESTED', sellerRespondBy: base }),
      );
      delegates.returnTimeline.count.mockResolvedValue(0);
      delegates.returnRequest.update.mockImplementation(async (args: { data: Record<string, unknown> }) =>
        baseReturn({ status: 'REQUESTED', sellerRespondBy: args.data.sellerRespondBy as Date }),
      );
    });

    it('menambah tepat 24 jam ke sellerRespondBy + mencatat timeline + notifikasi', async () => {
      const out = await service.adminAct('ret-db-1', 'admin-1', { action: 'EXTEND_DEADLINE' });
      const expected = new Date(base.getTime() + 24 * 3_600_000);
      expect(delegates.returnRequest.update).toHaveBeenCalledWith({
        where: { id: 'ret-db-1' },
        data: { sellerRespondBy: expected },
      });
      expect(out.sellerRespondBy).toEqual(expected);
      expect(delegates.returnTimeline.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            event: 'ADMIN_EXTENDED_DEADLINE',
            actorId: 'admin-1',
            actorRole: 'ADMIN',
          }),
        }),
      );
      expect(notify.notifyBoth).toHaveBeenCalledWith(
        'buyer-1', 'seller-1', 'RETURN_DEADLINE_EXTENDED',
        expect.any(String), expect.any(String), expect.any(String), expect.any(String),
        'ret-db-1', 'RTN-20260926-0001',
      );
    });

    it('audit 2026-10-10: aksi uang mengonsumsi step-up token terikat return.money-action + id retur', async () => {
      await service.adminAct('ret-db-1', 'admin-1', { action: 'EXTEND_DEADLINE' }, 'tok-123');
      expect(stepUp.consumeStepUpToken).toHaveBeenCalledWith('tok-123', {
        adminId: 'admin-1',
        action: 'return.money-action',
        targetId: 'ret-db-1',
      });
    });

    it('audit 2026-10-10: step-up ditolak → aksi uang tidak dieksekusi (fail-closed)', async () => {
      stepUp.consumeStepUpToken.mockRejectedValueOnce(new Error('STEP_UP_REQUIRED'));
      await expect(service.adminAct('ret-db-1', 'admin-1', { action: 'EXTEND_DEADLINE' })).rejects.toThrow('STEP_UP_REQUIRED');
      expect(delegates.returnRequest.updateMany).not.toHaveBeenCalled();
    });

    it('audit 2026-10-10: aksi non-uang (REJECT/ESCALATE) tidak butuh step-up', async () => {
      delegates.returnRequest.findUnique.mockResolvedValue(baseReturn({ status: 'REQUESTED' }));
      (prisma.dispute as Delegate).findFirst.mockResolvedValue(null);
      delegates.returnRequest.updateMany.mockResolvedValue({ count: 1 });
      await service.adminAct('ret-db-1', 'admin-1', { action: 'ESCALATE' }).catch(() => undefined);
      expect(stepUp.consumeStepUpToken).not.toHaveBeenCalled();
    });

    it('menolak bila status terminal (INVALID_STATUS) — fail closed', async () => {
      delegates.returnRequest.findUnique.mockResolvedValue(
        baseReturn({ status: 'RESOLVED_REFUND', sellerRespondBy: base }),
      );
      await expect(
        service.adminAct('ret-db-1', 'admin-1', { action: 'EXTEND_DEADLINE' }),
      ).rejects.toMatchObject({ response: expect.objectContaining({ code: 'INVALID_STATUS' }) });
      expect(delegates.returnRequest.update).not.toHaveBeenCalled();
    });

    it('menolak bila sellerRespondBy null — fail closed', async () => {
      delegates.returnRequest.findUnique.mockResolvedValue(
        baseReturn({ status: 'REQUESTED', sellerRespondBy: null }),
      );
      await expect(
        service.adminAct('ret-db-1', 'admin-1', { action: 'EXTEND_DEADLINE' }),
      ).rejects.toMatchObject({ response: expect.objectContaining({ code: 'INVALID_STATUS' }) });
      expect(delegates.returnRequest.update).not.toHaveBeenCalled();
    });

    it('menolak perpanjangan ke-4 (EXTENSION_LIMIT_REACHED) — cap 3x', async () => {
      delegates.returnTimeline.count.mockResolvedValue(3);
      await expect(
        service.adminAct('ret-db-1', 'admin-1', { action: 'EXTEND_DEADLINE' }),
      ).rejects.toMatchObject({ response: expect.objectContaining({ code: 'EXTENSION_LIMIT_REACHED' }) });
      expect(delegates.returnRequest.update).not.toHaveBeenCalled();
    });
  });

  // ----------------- ADM-113: getDetail menyertakan buyerPayAmount (string)
  describe('getDetail menyertakan buyerPayAmount (ADM-113)', () => {
    it('order.buyerPayAmount dikembalikan sebagai string untuk dialog nominal', async () => {
      delegates.returnRequest.findUnique.mockResolvedValue(
        baseReturn({ status: 'SELLER_REVIEW', sellerRespondBy: new Date() }),
      );
      orderDelegate.findUnique.mockResolvedValue({
        orderId: 'ORD-20260926-0001', orderType: 'PHYSICAL_GOODS', status: 'COMPLETED',
        completedAt: new Date(), buyerPayAmount: BigInt(200000),
      });
      delegates.returnAttachment.findMany.mockResolvedValue([]);
      delegates.returnNote.findMany.mockResolvedValue([]);
      delegates.returnTimeline.findMany.mockResolvedValue([]);
      delegates.returnShipmentEvent.findMany.mockResolvedValue([]);
      delegates.returnRefundApproval.findFirst.mockResolvedValue(null);

      const detail = await service.getDetail('ret-db-1', 'admin-1', { isAdmin: true });
      expect(detail.order).not.toBeNull();
      expect((detail.order as { buyerPayAmount: string }).buyerPayAmount).toBe('200000');
    });

    it('order null bila order tidak ditemukan — tidak throw', async () => {
      delegates.returnRequest.findUnique.mockResolvedValue(
        baseReturn({ status: 'REQUESTED', sellerRespondBy: new Date() }),
      );
      orderDelegate.findUnique.mockResolvedValue(null);
      delegates.returnAttachment.findMany.mockResolvedValue([]);
      delegates.returnNote.findMany.mockResolvedValue([]);
      delegates.returnTimeline.findMany.mockResolvedValue([]);
      delegates.returnShipmentEvent.findMany.mockResolvedValue([]);
      delegates.returnRefundApproval.findFirst.mockResolvedValue(null);

      const detail = await service.getDetail('ret-db-1', 'admin-1', { isAdmin: true });
      expect(detail.order).toBeNull();
    });
  });

  // K4 (audit transaksi 2026-10-10): konversi retur → sengketa harus memindahkan
  // order ke DISPUTED di tx yang sama, kalau tidak resolve admin 409 selamanya.
  describe('convertReturnToDispute memindahkan order ke DISPUTED (K4)', () => {
    function mockTx(orderStatus: string) {
      const tx = {
        $queryRaw: jest.fn().mockResolvedValue([]),
        order: {
          findFirst: jest.fn().mockResolvedValue({ id: 'order-db-1', orderId: 'ORD-1', status: orderStatus, sellerId: 'seller-1', sellerReceiveAmount: BigInt(97_500_00) }),
          updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        },
        dispute: {
          findUnique: jest.fn().mockResolvedValue(null),
          create: jest.fn().mockResolvedValue({ id: 'disp-db-1', disputeId: 'DSP-20261010-0007' }),
        },
        orderStatusHistory: { create: jest.fn().mockResolvedValue({}) },
        wallet: { findUnique: jest.fn(), updateMany: jest.fn() },
        walletTransaction: { create: jest.fn() },
      };
      (prisma.$transaction as MockFn).mockImplementation(async (cb: (t: unknown) => Promise<unknown>) => cb(tx));
      return tx;
    }

    beforeEach(() => {
      delegates.returnRequest.findUnique.mockResolvedValue(baseReturn({ status: 'ESCALATED', disputeId: null }));
      delegates.returnRequest.update.mockResolvedValue({});
      (prisma.dispute as Delegate).findFirst.mockResolvedValue(null);
      notify.notifyBoth.mockResolvedValue(undefined);
    });

    it('no-wallet: buat sengketa OPEN + order COMPLETED → DISPUTED + history, tanpa menyentuh wallet', async () => {
      walletMode.isWalletEnabled.mockReturnValue(false);
      const tx = mockTx('COMPLETED');

      const res = await service.convertReturnToDispute('ret-db-1', 'admin-1');

      expect(res).toMatchObject({ disputeId: 'DSP-20261010-0007', created: true, linked: true });
      expect(tx.order.updateMany).toHaveBeenCalledWith(expect.objectContaining({
        where: expect.objectContaining({ id: 'order-db-1', status: { in: expect.arrayContaining(['COMPLETED']) } }),
        data: expect.objectContaining({ status: 'DISPUTED' }),
      }));
      expect(tx.orderStatusHistory.create).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({ fromStatus: 'COMPLETED', toStatus: 'DISPUTED', changedByType: 'ADMIN' }),
      }));
      expect(tx.wallet.updateMany).not.toHaveBeenCalled();
      expect(delegates.returnRequest.update).toHaveBeenCalledWith(expect.objectContaining({ data: { disputeId: 'disp-db-1' } }));
    });

    it('mode wallet: bekukan dana seller (ORDER_LOCK) agar putusan pasca-completion bisa dieksekusi', async () => {
      walletMode.isWalletEnabled.mockReturnValue(true);
      (serial as unknown as { getNext: MockFn }).getNext = jest.fn().mockResolvedValue(42);
      const tx = mockTx('COMPLETED');
      tx.wallet.findUnique
        .mockResolvedValueOnce({ id: 'sw-1' })
        .mockResolvedValueOnce({ id: 'sw-1', isLocked: false, availableBalance: BigInt(200_000_00), version: 3 });
      tx.wallet.updateMany.mockResolvedValue({ count: 1 });

      await service.convertReturnToDispute('ret-db-1', 'admin-1');

      expect(tx.wallet.updateMany).toHaveBeenCalledWith(expect.objectContaining({
        where: expect.objectContaining({ id: 'sw-1', version: 3 }),
        data: expect.objectContaining({ availableBalance: { decrement: BigInt(97_500_00) }, escrowBalance: { increment: BigInt(97_500_00) } }),
      }));
      expect(tx.walletTransaction.create).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({ type: 'ORDER_LOCK', amount: BigInt(97_500_00), orderId: 'order-db-1' }),
      }));
    });

    it('order sudah berstatus lain (updateMany 0) → INVALID_ORDER_STATUS, tx dibatalkan', async () => {
      walletMode.isWalletEnabled.mockReturnValue(false);
      const tx = mockTx('CANCELLED');
      tx.order.updateMany.mockResolvedValue({ count: 0 });

      await expect(service.convertReturnToDispute('ret-db-1', 'admin-1')).rejects.toMatchObject({
        response: { code: 'INVALID_ORDER_STATUS' },
      });
      expect(delegates.returnRequest.update).not.toHaveBeenCalled();
    });
  });
});
