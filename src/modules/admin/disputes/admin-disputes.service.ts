import { Injectable, NotFoundException, BadRequestException, ConflictException, ForbiddenException, Logger, Optional, OnModuleInit } from '@nestjs/common';
import { Decimal } from '@prisma/client/runtime/library';
import { randomBytes, randomInt } from 'crypto';
import { Prisma, DisputeDecisionType, DisputeCategory, DisputeStatus, OrderStatus, ActorType, WalletTransactionType, WalletTransactionStatus, AuditAction, NotificationType, VoucherApplicability, VoucherType } from '@prisma/client';
import { getCategoryForType } from '../../notifications/notification-category.map';
import { DISPUTE_FULL_BUYER_REFUNDS_PLATFORM_FEE } from '../../../common/constants/app.constants';
import { PrismaService } from '../../../prisma/prisma.service';
import { WalletTxSerialService } from '../../../common/services/wallet-tx-serial.service';
import { WalletModeService } from '../../wallet-mode/wallet-mode.service';
import { DisputeDanaSettlementService } from '../../no-wallet/dispute-dana-settlement.service';
import { generateWalletTxId, generateNotifId } from '../../../common/utils/id-generator.util';
import { creditCashbackIfEligible, planDanaCashback, executeDanaCashback } from '../../../common/utils/cashback-credit.util';
import { EscrowDisbursementService } from '../../no-wallet/escrow-disbursement.service';
import { computePatunganRebateTx, createPatunganRebateLedgerTx } from '../../commerce/patungan-rebate';
import { DisputeDecisionDto, validateSplitPercents } from './dispute-decision.dto';
import { AuditLogService } from '../../../common/services/audit-log.service';
import { toIdr } from '../../../common/utils/currency.util';
import * as ErrorCodes from '../../../common/constants/error-codes';
import { createPaginatedResponse } from '../../../common/dto/pagination.dto';
import { escapeHtml } from '../../../common/utils/sanitize.util';
import { UploadService } from '../../upload/upload.service';
import { UploadPurpose } from '../../upload/dto/presigned-url.dto';
import { SubmitDisputeEvidenceAdminDto } from './dto/submit-dispute-evidence-admin.dto';
import { RealtimeService } from '../../realtime/realtime.service';
import { escapeLikePattern } from '../../../common/utils/search.util';
import { ChatService } from '../../chat/chat.service';
import { DashboardService } from '../dashboard/dashboard.service';
// SEC-501: dual control untuk resolve nominal besar.
import { ApprovalsService } from '../approvals/approvals.service';
import { DUAL_CONTROL_THRESHOLD_SEN } from '../approvals/dual-control.constants';

const DISPUTE_APOLOGY_VOUCHER_AMOUNT = BigInt(10_000 * 100);
const DISPUTE_APOLOGY_VALID_DAYS = 30;

@Injectable()
export class AdminDisputesService implements OnModuleInit {
  private readonly logger = new Logger(AdminDisputesService.name);

  constructor(
    private prisma: PrismaService,
    private walletTxSerialService: WalletTxSerialService,
    private walletMode: WalletModeService,
    private disputeDanaSettlement: DisputeDanaSettlementService,
    private auditLog: AuditLogService,
    private uploadService: UploadService,
    private realtime: RealtimeService,
    private chatService: ChatService,
    // AW-018: invalidasi cache summary dashboard (via helper terpusat).
    private readonly dashboard: DashboardService,
    // M4 no-wallet: payout cashback via disbursement DANA.
    @Optional() private escrowDisbursement: EscrowDisbursementService | null,
    // SEC-501: dual control — modul ini mengeksekusi DISPUTE_RESOLVE yang disetujui.
    private readonly approvals: ApprovalsService,
  ) {}

  onModuleInit(): void {
    this.approvals.registerExecutor('DISPUTE_RESOLVE', async (ctx) => {
      const dto = ctx.payload as unknown as DisputeDecisionDto;
      if (!ctx.targetId) {
        throw new BadRequestException({
          code: ErrorCodes.VALIDATION_ERROR,
          message: 'DISPUTE_RESOLVE membutuhkan targetId (disputeId)',
        });
      }
      return this.resolveDispute(ctx.targetId, ctx.decidedBy, dto, ctx.ipAddress, {
        viaDualControl: true,
      });
    });
  }

  private apologyVoucherCode(disputeId: string): string {
    const safeDispute = disputeId.replace(/[^A-Z0-9]/gi, '').slice(-8).toUpperCase();
    return `APOLOGY-${safeDispute}-${randomBytes(3).toString('hex').toUpperCase()}`.slice(0, 50);
  }

  private disputeApologyRecipients(decision: DisputeDecisionDto['decision'], order: { buyerId: string; sellerId: string }, buyerAmount: bigint, sellerAmount: bigint): string[] {
    if (decision === 'FULL_BUYER') return [order.buyerId];
    if (decision === 'FULL_SELLER') return [order.sellerId];
    if (buyerAmount > sellerAmount) return [order.buyerId];
    if (sellerAmount > buyerAmount) return [order.sellerId];
    return [order.buyerId, order.sellerId];
  }

  private async issueDisputeApologyVouchers(tx: Prisma.TransactionClient, recipients: string[], disputeId: string): Promise<Array<{ userId: string; code: string }>> {
    const issued: Array<{ userId: string; code: string }> = [];
    const validFrom = new Date();
    const validUntil = new Date(validFrom.getTime() + DISPUTE_APOLOGY_VALID_DAYS * 24 * 60 * 60 * 1000);
    for (const userId of recipients) {
      let code = this.apologyVoucherCode(disputeId);
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const voucher = await tx.voucher.create({
            data: {
              voucherId: `VCH-${code}`,
              code,
              name: 'Dispute Apology Voucher',
              description: 'Voucher permintaan maaf Kahade setelah sengketa selesai.',
              voucherType: VoucherType.FEE_DISCOUNT_FLAT,
              discountAmount: DISPUTE_APOLOGY_VOUCHER_AMOUNT,
              discountPercent: null,
              maxDiscountAmount: null,
              maxUsageTotal: 1,
              maxUsagePerUser: 1,
              currentUsage: 0,
              applicableTo: VoucherApplicability.ALL,
              isActive: true,
              validFrom,
              validUntil,
              createdBy: 'SYSTEM_DISPUTE_APOLOGY',
              assignedToUserId: userId,
            },
          });
          issued.push({ userId, code: voucher.code });
          break;
        } catch (error: unknown) {
          if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002' && attempt < 2) {
            code = this.apologyVoucherCode(disputeId);
            continue;
          }
          throw error;
        }
      }
    }
    return issued;
  }

  private async withSerializableRetry<T>(fn: () => Promise<T>, label: string): Promise<T> {
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        return await fn();
      } catch (error: unknown) {
        const retryable = error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2034'
          || error instanceof Prisma.PrismaClientUnknownRequestError && /40001|serialization|40p01|deadlock/i.test(error.message);
        if (!retryable || attempt === 3) throw error;
        this.logger.warn(`${label} retrying attempt=${attempt}/3`);
        await new Promise(resolve => setTimeout(resolve, 100 * 2 ** (attempt - 1) + randomInt(0, 50)));
      }
    }
    throw new Error(`${label}: unreachable`);
  }

  async listDisputes(page = 1, limit = 20, status?: string, search?: string, category?: string, unassigned?: boolean): Promise<object> {
    // DP-013: 'CANCELLED' bukan nilai enum DisputeStatus — jangan izinkan di filter.
    if (status !== undefined && !['OPEN', 'ASSIGNED', 'UNDER_REVIEW', 'WAITING_RESPONSE', 'ESCALATED', 'RESOLVED'].includes(status)) {
      throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Invalid dispute status' });
    }
    if (category !== undefined && !Object.values(DisputeCategory).includes(category as DisputeCategory)) {
      throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Invalid dispute category' });
    }
    const safePage = Number.isFinite(page) ? Math.max(1, Math.floor(page)) : 1;
    const safeLimit = Number.isFinite(limit) ? Math.min(100, Math.max(1, Math.floor(limit))) : 20;
    const skip = (safePage - 1) * safeLimit;
    const where: Prisma.DisputeWhereInput = {};
    if (status) where.status = status as Prisma.EnumDisputeStatusFilter;
    if (category) where.category = category as DisputeCategory;
    // AW-001 (perf-fix): filter server-side "belum ditugaskan" — dipakai admin
    // sebagai pengganti fetch-all + filter client-side.
    if (unassigned === true) where.assignedAdminId = null;
    const normalizedSearch = search?.trim();
    if (normalizedSearch) {
      where.OR = [
        { disputeId: { contains: escapeLikePattern(normalizedSearch), mode: 'insensitive' } },
        { order: { orderId: { contains: escapeLikePattern(normalizedSearch), mode: 'insensitive' } } },
      ];
    }

    const [disputes, total] = await Promise.all([
      this.prisma.dispute.findMany({
        where,
        skip,
        take: safeLimit,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], // R2-L: stable page ordering
        include: {
          order: { select: { orderId: true, title: true, orderValue: true } },
          initiator: { select: { userId: true, fullName: true } },
          assignedAdmin: { select: { adminId: true, fullName: true } },
        },
      }),
      this.prisma.dispute.count({ where }),
    ]);

    const serialized = disputes.map((d) => ({
      ...d,
      order: { ...d.order, orderValue: toIdr(d.order.orderValue) },
    }));
    return createPaginatedResponse(serialized, total, safePage, safeLimit);
  }

  async getDisputeDetail(disputeId: string, adminId?: string, ipAddress?: string): Promise<object> {
    const dispute = await this.prisma.dispute.findFirst({
      where: { OR: [{ id: disputeId }, { disputeId }] },
      include: {
        order: true,
        initiator: { select: { userId: true, fullName: true, email: true } },
        evidences: { orderBy: { createdAt: 'asc' } },
        calls: { orderBy: { createdAt: 'desc' }, take: 100 },
        mutualProposals: { orderBy: { createdAt: 'desc' }, take: 100, include: { proposer: { select: { userId: true, fullName: true, username: true } } } },
        decision: true,
        assignedAdmin: { select: { adminId: true, fullName: true } },
      },
    });
    if (!dispute) throw new NotFoundException({ code: ErrorCodes.DISPUTE_NOT_FOUND, message: 'Dispute not found' });

    if (adminId) {
      this.auditLog.logAdminAction({
        adminId,
        action: AuditAction.ADMIN_ACTION,
        targetType: 'Dispute',
        targetId: dispute.disputeId,
        description: `Admin viewed dispute detail for ${dispute.disputeId}`,
        ipAddress: ipAddress ?? 'unknown',
      });
    }

    const evidenceWithDownloads = await Promise.all(dispute.evidences.map(async (evidence) => {
      const keys = Array.isArray(evidence.fileUrls) ? evidence.fileUrls.filter((key): key is string => typeof key === 'string') : [];
      const downloads = await Promise.all(keys.map(async (key) => {
        try { return await this.uploadService.generateDownloadUrl(key, 300); }
        catch { return null; }
      }));
      // GAP-B3 (G149): jejak audit setiap kali moderator diberi tautan unduh
      // bukti. Yang dicatat: evidenceId + sengketa + jumlah berkas + IP —
      // TANPA menyimpan URL signed (capability kedaluwarsa, bukan data audit).
      if (adminId && keys.length > 0) {
        this.auditLog.logAdminAction({
          adminId,
          action: AuditAction.ADMIN_ACTION,
          targetType: 'DisputeEvidence',
          targetId: evidence.id,
          description: `Admin meminta tautan unduh bukti pada sengketa ${dispute.disputeId} (${keys.length} berkas)`,
          ipAddress: ipAddress ?? 'unknown',
        });
      }
      return { ...evidence, fileUrls: [], fileDownloadUrls: downloads.filter((url): url is string => Boolean(url)) };
    }));

    return {
      ...dispute,
      evidences: evidenceWithDownloads,
      calls: dispute.calls,
      mutualProposals: dispute.mutualProposals.map((proposal) => ({
        ...proposal,
        proposerName: proposal.proposer.fullName || proposal.proposer.username,
        proposer: undefined,
      })),
      order: {
        ...dispute.order,
        orderValue: toIdr(dispute.order.orderValue),
        feeAmount: toIdr(dispute.order.feeAmount),
        buyerFeeAmount: toIdr(dispute.order.buyerFeeAmount),
        sellerFeeAmount: toIdr(dispute.order.sellerFeeAmount),
        buyerPayAmount: toIdr(dispute.order.buyerPayAmount),
        sellerReceiveAmount: toIdr(dispute.order.sellerReceiveAmount),
        voucherDiscount: toIdr(dispute.order.voucherDiscount),
      },
      ...(dispute.decision ? {
        decision: {
          ...dispute.decision,
          buyerAmount: toIdr(dispute.decision.buyerAmount),
          sellerAmount: toIdr(dispute.decision.sellerAmount),
        },
      } : {}),
    };
  }

  /**
   * ADM-109 — SATU sumber kebenaran komputasi pembagian dana putusan sengketa.
   * Dipakai resolveDispute (eksekusi) dan previewResolveDispute (pratinjau).
   * Perilaku keuangan TIDAK berubah: logika disalin verbatim dari resolve.
   */
  private computeDisbursementAmounts(
    order: { buyerPayAmount: bigint; sellerReceiveAmount: bigint; completedAt: Date | null },
    decision: 'FULL_BUYER' | 'FULL_SELLER' | 'SPLIT',
    buyerPercent: number | undefined,
    sellerPercent: number | undefined,
  ): {
    buyerAmount: bigint;
    sellerAmount: bigint;
    platformRetainAmount: bigint;
    escrowedAmount: bigint;
    platformFee: bigint;
    totalDisbursement: bigint;
    isPostCompletionDispute: boolean;
  } {
    const isPostCompletionDispute = order.completedAt !== null;
    const sellerReceiveAmount = order.sellerReceiveAmount;

    const escrowedAmount = isPostCompletionDispute
      ? sellerReceiveAmount
      : order.buyerPayAmount;
    const platformFee = isPostCompletionDispute
      ? BigInt(0)
      : order.buyerPayAmount - sellerReceiveAmount;

    if (escrowedAmount <= BigInt(0)) {
      throw new BadRequestException({ code: ErrorCodes.INVALID_STATUS, message: 'No escrowed funds available for dispute resolution' });
    }

    let buyerAmount: bigint;
    let sellerAmount: bigint;
    let platformRetainAmount: bigint;

    // Kebijakan platform fee saat putusan FULL_BUYER (lihat
    // DISPUTE_FULL_BUYER_REFUNDS_PLATFORM_FEE di app.constants.ts):
    // - false (default, perilaku saat ini): platform menahan fee — pembeli
    //   menerima sellerReceiveAmount (nilai order), fee tidak ikut refund.
    // - true (rekomendasi, perlu keputusan produk): fee ikut refund — pembeli
    //   menerima buyerPayAmount penuh (escrowedAmount) saat transaksi batal
    //   total; platform tidak menahan fee untuk order ini.
    // Catatan: untuk sengketa pasca-completion, platformFee selalu 0 sehingga
    // kedua cabang identik.
    if (decision === 'FULL_BUYER') {
      if (DISPUTE_FULL_BUYER_REFUNDS_PLATFORM_FEE) {
        buyerAmount = escrowedAmount;
        sellerAmount = BigInt(0);
        platformRetainAmount = BigInt(0);
      } else {
        buyerAmount = sellerReceiveAmount;
        sellerAmount = BigInt(0);
        platformRetainAmount = platformFee;
      }
    } else if (decision === 'FULL_SELLER') {
      buyerAmount = BigInt(0);
      sellerAmount = sellerReceiveAmount;
      platformRetainAmount = platformFee;
    } else {
      buyerAmount = (sellerReceiveAmount * BigInt(buyerPercent!)) / BigInt(100);
      sellerAmount = sellerReceiveAmount - buyerAmount;
      platformRetainAmount = platformFee;
    }

    const totalDisbursement = buyerAmount + sellerAmount + platformRetainAmount;
    if (totalDisbursement > escrowedAmount) {
      throw new BadRequestException({
        code: ErrorCodes.DISPUTE_AMOUNT_EXCEEDS_ESCROW,
        message: `Total disbursement (${totalDisbursement}) exceeds escrowed amount (${escrowedAmount})`,
      });
    }

    return { buyerAmount, sellerAmount, platformRetainAmount, escrowedAmount, platformFee, totalDisbursement, isPostCompletionDispute };
  }

  /**
   * ADM-109 — pratinjau nominal SEBELUM eksekusi resolve. Read-only: tidak ada
   * mutasi, tidak ada alokasi serial wallet. Guard status sama dengan resolve
   * agar angka yang ditampilkan pasti bisa dieksekusi.
   */
  async previewResolveDispute(
    disputeId: string,
    query: { decision: 'FULL_BUYER' | 'FULL_SELLER' | 'SPLIT'; buyerPercent?: number; sellerPercent?: number },
  ): Promise<object> {
    validateSplitPercents(query as DisputeDecisionDto);

    const dispute = await this.prisma.dispute.findFirst({
      where: { OR: [{ id: disputeId }, { disputeId }] },
      include: { order: true },
    });
    if (!dispute) throw new NotFoundException({ code: ErrorCodes.DISPUTE_NOT_FOUND, message: 'Dispute not found' });

    const resolvableStatuses: string[] = ['UNDER_REVIEW', 'ESCALATED'];
    if (!resolvableStatuses.includes(dispute.status as string)) {
      throw new BadRequestException({ code: ErrorCodes.INVALID_STATUS, message: `Dispute must be in UNDER_REVIEW or ESCALATED status to resolve (current: ${dispute.status})` });
    }

    const amounts = this.computeDisbursementAmounts(dispute.order, query.decision, query.buyerPercent, query.sellerPercent);
    return {
      disputeId: dispute.disputeId,
      orderId: dispute.order.orderId,
      decision: query.decision,
      buyerPercent: query.buyerPercent ?? null,
      sellerPercent: query.sellerPercent ?? null,
      buyerAmount: toIdr(amounts.buyerAmount),
      sellerAmount: toIdr(amounts.sellerAmount),
      platformRetainAmount: toIdr(amounts.platformRetainAmount),
      escrowedAmount: toIdr(amounts.escrowedAmount),
      platformFee: toIdr(amounts.platformFee),
      buyerAmountSen: amounts.buyerAmount.toString(),
      sellerAmountSen: amounts.sellerAmount.toString(),
      platformRetainAmountSen: amounts.platformRetainAmount.toString(),
      isPostCompletionDispute: amounts.isPostCompletionDispute,
      feePolicy: { fullBuyerRefundsPlatformFee: DISPUTE_FULL_BUYER_REFUNDS_PLATFORM_FEE },
    };
  }

  async resolveDispute(
    disputeId: string,
    adminId: string,
    dto: DisputeDecisionDto,
    ipAddress: string = 'internal',
    opts: { viaDualControl?: boolean } = {},
  ): Promise<object> {
    validateSplitPercents(dto);

    const dispute = await this.prisma.dispute.findFirst({
      where: { OR: [{ id: disputeId }, { disputeId }] },
      include: { order: true },
    });

    if (!dispute) throw new NotFoundException({ code: ErrorCodes.DISPUTE_NOT_FOUND, message: 'Dispute not found' });

    const resolvableStatuses: string[] = ['UNDER_REVIEW', 'ESCALATED'];
    if (!resolvableStatuses.includes(dispute.status as string)) {
      throw new BadRequestException({ code: ErrorCodes.INVALID_STATUS, message: `Dispute must be in UNDER_REVIEW or ESCALATED status to resolve (current: ${dispute.status})` });
    }

    const actingAdmin = await this.prisma.adminUser.findUnique({ where: { id: adminId }, select: { role: true } });
    const isSuperAdmin = actingAdmin?.role === 'SUPER_ADMIN';
    if (dispute.assignedAdminId && dispute.assignedAdminId !== adminId && !isSuperAdmin) {
      throw new ForbiddenException({ code: ErrorCodes.NOT_ASSIGNED_ADMIN, message: 'Only the assigned admin or a SUPER_ADMIN can resolve this dispute' });
    }

    // ADM-109: komputasi pembagian dana — satu-satunya sumber kebenaran untuk
    // resolve & pratinjau. Jangan duplikasi logika ini di tempat lain.
    const amounts = this.computeDisbursementAmounts(
      dispute.order,
      dto.decision,
      dto.buyerPercent,
      dto.sellerPercent,
    );
    const {
      buyerAmount,
      sellerAmount,
      platformRetainAmount,
      escrowedAmount,
      totalDisbursement,
      isPostCompletionDispute,
    } = amounts;

    // SEC-501: nominal escrow di atas ambang → WAJIB dual control. Jalur
    // langsung (tanpa viaDualControl) ditolak fail-closed; klien mengusulkan
    // via POST /v1/admin/approvals/propose (actionType DISPUTE_RESOLVE).
    if (!opts.viaDualControl && escrowedAmount > DUAL_CONTROL_THRESHOLD_SEN) {
      throw new ForbiddenException({
        code: ErrorCodes.DUAL_CONTROL_REQUIRED,
        message:
          'Nominal escrow di atas Rp1.000.000 — resolve sengketa wajib dual control ' +
          '(usulkan via POST /v1/admin/approvals/propose dengan actionType DISPUTE_RESOLVE)',
      });
    }

    // M3 (no-wallet): order dibayar via DANA-direct (QRIS/VA/BALANCE). Putusan
    // sengketa dieksekusi TANPA wallet: refund DANA ke metode bayar asal
    // (buyer) + disbursement ke rekening bank seller. Kebijakan pembagian
    // (computeDisbursementAmounts) dan DP-014 tidak berubah.
    const danaPayment = await this.prisma.paymentTransaction.findFirst({
      where: {
        orderId: dispute.orderId,
        purpose: 'ORDER_ESCROW',
        provider: 'DANA',
        status: 'SUCCESS',
        danaPayKind: { not: null },
      },
      select: { id: true },
    });
    if (!this.walletMode.isWalletEnabled() && danaPayment) {
      return this.resolveDisputeNoWallet(dispute, adminId, dto, ipAddress, amounts);
    }

    // Redis-backed wallet serials are not rolled back with PostgreSQL. Allocate
    // them before the transaction so a later retry/serialization recovery can
    // reuse the same ledger IDs instead of burning new IDs.
    const buyerTxSerial = buyerAmount > BigInt(0) ? await this.walletTxSerialService.getNext() : null;
    const sellerTxSerial = sellerAmount > BigInt(0) ? await this.walletTxSerialService.getNext() : null;
    const feeTxSerial = platformRetainAmount > BigInt(0) ? await this.walletTxSerialService.getNext() : null;
    // M6 follow-up (Wave 2): serial ledger rebate overfunding patungan —
    // lazy agar tidak membakar nomor urut bila verdict tidak memicu rebate
    // (pola sama seperti serial cashback di completeOrder).
    let disputeRebateSerial: number | null = null;
    const nextDisputeRebateTxSerial = async (): Promise<number> => {
      if (disputeRebateSerial === null) disputeRebateSerial = await this.walletTxSerialService.getNext();
      return disputeRebateSerial;
    };

    const result = await this.withSerializableRetry(() => this.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      await tx.$queryRaw`SELECT id FROM disputes WHERE id = ${dispute.id} FOR UPDATE`;
      const freshDispute = await tx.dispute.findUnique({
        where: { id: dispute.id },
        select: { status: true, assignedAdminId: true },
      });
      if (!freshDispute || !resolvableStatuses.includes(freshDispute.status as string)) {
        throw new ConflictException({ code: ErrorCodes.INVALID_STATUS, message: 'Dispute state changed before resolution' });
      }
      if (freshDispute.assignedAdminId && freshDispute.assignedAdminId !== adminId && !isSuperAdmin) {
        throw new ForbiddenException({ code: ErrorCodes.NOT_ASSIGNED_ADMIN, message: 'Assignment changed before resolution; only the assigned admin or a SUPER_ADMIN can resolve' });
      }

      const order = await tx.order.findUnique({
        where: { id: dispute.orderId },
        include: {
          buyer: { select: { wallet: { select: { id: true, isLocked: true, escrowBalance: true, availableBalance: true, totalBalance: true, version: true } } } },
          seller: { select: { wallet: { select: { id: true, isLocked: true, escrowBalance: true, availableBalance: true, totalBalance: true, version: true } } } },
        },
      });

      if (!order || order.status !== OrderStatus.DISPUTED) {
        throw new ConflictException({ code: ErrorCodes.INVALID_STATUS, message: 'Order is no longer DISPUTED; dispute resolution was not applied' });
      }
      // The preflight relation is only an authorization snapshot. Do not let a stale
      // completedAt/status classification select the wrong payout branch.
      if ((order.completedAt !== null) !== isPostCompletionDispute) {
        throw new ConflictException({ code: ErrorCodes.INVALID_STATUS, message: 'Dispute settlement classification changed; please retry.' });
      }

      const freshIsPostCompletionDispute = order.completedAt !== null;
      const freshEscrowedAmount = freshIsPostCompletionDispute ? order.sellerReceiveAmount : order.buyerPayAmount;
      if (freshEscrowedAmount < totalDisbursement) {
        throw new ConflictException({ code: ErrorCodes.DISPUTE_AMOUNT_EXCEEDS_ESCROW, message: 'Fresh order escrow is lower than the proposed settlement' });
      }

      const buyerWallet = order.buyer?.wallet;
      const sellerWallet = order.seller?.wallet;

      if (!buyerWallet) {
        this.logger.error(`Dispute ${disputeId}: buyer wallet missing for order ${dispute.orderId}`);
        throw new BadRequestException({ code: ErrorCodes.NOT_FOUND, message: 'Buyer wallet not found. Cannot proceed with dispute fund release.' });
      }
      if (!sellerWallet) {
        this.logger.error(`Dispute ${disputeId}: seller wallet missing for order ${dispute.orderId}`);
        throw new BadRequestException({ code: ErrorCodes.NOT_FOUND, message: 'Seller wallet not found. Cannot proceed with dispute fund release.' });
      }
      if (buyerWallet.isLocked) {
        this.logger.error(`Dispute ${disputeId}: buyer wallet ${buyerWallet.id} is locked`);
        throw new BadRequestException({ code: 'WALLET_LOCKED', message: 'Buyer wallet is locked. Cannot proceed with dispute fund release.' });
      }
      if (sellerWallet.isLocked) {
        this.logger.error(`Dispute ${disputeId}: seller wallet ${sellerWallet.id} is locked`);
        throw new BadRequestException({ code: 'WALLET_LOCKED', message: 'Seller wallet is locked. Cannot proceed with dispute fund release.' });
      }

      const escrowSource = freshIsPostCompletionDispute ? sellerWallet : buyerWallet;
      if (escrowSource.escrowBalance < freshEscrowedAmount) {
        const party = freshIsPostCompletionDispute ? 'Seller' : 'Buyer';
        throw new BadRequestException({
          code: ErrorCodes.ESCROW_BALANCE_MISMATCH,
          message: `${party} escrow balance (${escrowSource.escrowBalance}) is less than expected escrowed amount (${freshEscrowedAmount}). Manual investigation required.`,
        });
      }

      const existingDecision = await tx.disputeDecision.findUnique({ where: { disputeId: dispute.id } });
      if (existingDecision) {
        throw new ConflictException({ code: ErrorCodes.DISPUTE_ALREADY_RESOLVED, message: 'This dispute has already been resolved' });
      }

      const [firstWalletId, secondWalletId] = [buyerWallet.id, sellerWallet.id].sort();
      await tx.$queryRaw`SELECT id FROM wallets WHERE id IN (${firstWalletId}, ${secondWalletId}) ORDER BY id FOR UPDATE`;

      await tx.dispute.update({
        where: { id: dispute.id },
        data: {
          status: 'RESOLVED',
          resolvedAt: new Date(),
          assignedAdminId: adminId,
        },
      });

      const now = new Date();
      const firstAdminMessage = await tx.disputeMessage.findFirst({
        where: { disputeId: dispute.id, adminId: { not: null } },
        orderBy: { createdAt: 'asc' },
        select: { createdAt: true },
      });
      const timeToFirstResponseMs = firstAdminMessage
        ? firstAdminMessage.createdAt.getTime() - dispute.createdAt.getTime()
        : null;
      const totalResolutionTimeMs = now.getTime() - dispute.createdAt.getTime();

      const decision = await tx.disputeDecision.create({
        data: {
          disputeId: dispute.id,
          decidedBy: adminId,
          decisionType: dto.decision as DisputeDecisionType,
          decisionNotes: [
            dto.decisionNotes,
            timeToFirstResponseMs != null ? `[timing] firstResponse=${timeToFirstResponseMs}ms` : null,
            `[timing] totalResolution=${totalResolutionTimeMs}ms`,
          ].filter(Boolean).join(' | '),
          buyerAmount,
          sellerAmount,
          buyerPercent: dto.decision === 'SPLIT' ? new Decimal(dto.buyerPercent!) : null,
          sellerPercent: dto.decision === 'SPLIT' ? new Decimal(dto.sellerPercent!) : null,
        },
      });

      if (order.status === OrderStatus.DISPUTED) {
        // DP-014: FULL_BUYER pra-completion = transaksi batal total (uang kembali ke
        // buyer) → CANCELLED, bukan COMPLETED. Untuk sengketa pasca-completion
        // (completedAt sudah terisi) transaksi memang pernah selesai — verdict adalah
        // penyesuaian pasca-jual → tetap COMPLETED. FULL_SELLER & SPLIT → COMPLETED.
        const isFullBuyerPreCompletion = dto.decision === 'FULL_BUYER' && !freshIsPostCompletionDispute;
        const resolvedOrderStatus = isFullBuyerPreCompletion ? OrderStatus.CANCELLED : OrderStatus.COMPLETED;
        await tx.order.update({
          where: { id: order.id },
          data: {
            status: resolvedOrderStatus,
            ...(order.completedAt ? {} : isFullBuyerPreCompletion ? {} : { completedAt: new Date() }),
            ...(isFullBuyerPreCompletion ? { cancelledAt: new Date() } : {}),
          },
        });
        await tx.orderStatusHistory.create({
          data: {
            orderId: order.id,
            fromStatus: OrderStatus.DISPUTED,
            toStatus: resolvedOrderStatus,
            changedBy: adminId,
            changedByType: ActorType.ADMIN,
            reason: `Dispute resolved: ${dto.decision}${dto.decisionNotes ? ` — ${dto.decisionNotes}` : ''}`,
          },
        });
      }

      if (freshIsPostCompletionDispute) {
        if (buyerAmount > BigInt(0)) {
          const freshSellerForBuyer = await tx.wallet.findUnique({ where: { id: sellerWallet.id } });
          if (!freshSellerForBuyer) throw new ConflictException({ code: ErrorCodes.NOT_FOUND, message: 'Seller wallet disappeared during dispute resolution' });
          const sellerDebit = await tx.wallet.updateMany({
            where: { id: sellerWallet.id, version: freshSellerForBuyer.version, escrowBalance: { gte: buyerAmount } },
            data: { escrowBalance: { decrement: buyerAmount }, totalBalance: { decrement: buyerAmount }, version: { increment: 1 } },
          });
          if (sellerDebit.count === 0) throw new ConflictException({ code: ErrorCodes.OPTIMISTIC_LOCK_CONFLICT, message: 'Concurrent wallet update during post-completion dispute resolution' });

          const freshBuyerForRefund = await tx.wallet.findUnique({ where: { id: buyerWallet.id } });
          if (!freshBuyerForRefund) throw new ConflictException({ code: ErrorCodes.NOT_FOUND, message: 'Buyer wallet disappeared during dispute resolution' });
          const buyerCredit = await tx.wallet.updateMany({
            where: { id: buyerWallet.id, version: freshBuyerForRefund.version },
            data: { availableBalance: { increment: buyerAmount }, totalBalance: { increment: buyerAmount }, version: { increment: 1 } },
          });
          if (buyerCredit.count === 0) throw new ConflictException({ code: ErrorCodes.OPTIMISTIC_LOCK_CONFLICT, message: 'Concurrent buyer wallet update during post-completion dispute refund' });

          const buyerTxId = generateWalletTxId(buyerTxSerial!);
          await tx.walletTransaction.create({
            data: {
              txId: buyerTxId, walletId: buyerWallet.id,
              type: WalletTransactionType.ORDER_REFUND, status: WalletTransactionStatus.SUCCESS,
              amount: buyerAmount, balanceBefore: freshBuyerForRefund.availableBalance, balanceAfter: freshBuyerForRefund.availableBalance + buyerAmount,
              orderId: dispute.orderId, description: `Post-completion dispute refund to buyer (order ${dispute.orderId})`,
            },
          });
          this.logger.log(`Dispute ${disputeId}: post-completion refund ${buyerAmount} to buyer wallet ${buyerWallet.id}`);
        }

        if (sellerAmount > BigInt(0)) {
          const freshSellerForRelease = await tx.wallet.findUnique({ where: { id: sellerWallet.id } });
          if (!freshSellerForRelease) throw new ConflictException({ code: ErrorCodes.NOT_FOUND, message: 'Seller wallet disappeared during dispute resolution' });
          const sellerRelease = await tx.wallet.updateMany({
            where: { id: sellerWallet.id, version: freshSellerForRelease.version, escrowBalance: { gte: sellerAmount } },
            data: { escrowBalance: { decrement: sellerAmount }, availableBalance: { increment: sellerAmount }, version: { increment: 1 } },
          });
          if (sellerRelease.count === 0) throw new ConflictException({ code: ErrorCodes.OPTIMISTIC_LOCK_CONFLICT, message: 'Concurrent seller wallet update during post-completion dispute release' });

          const sellerTxId = generateWalletTxId(sellerTxSerial!);
          await tx.walletTransaction.create({
            data: {
              txId: sellerTxId, walletId: sellerWallet.id,
              type: WalletTransactionType.DISPUTE_RELEASE, status: WalletTransactionStatus.SUCCESS,
              amount: sellerAmount, balanceBefore: freshSellerForRelease.availableBalance, balanceAfter: freshSellerForRelease.availableBalance + sellerAmount,
              orderId: dispute.orderId, description: `Post-completion dispute: funds returned to seller (order ${dispute.orderId})`,
            },
          });
          this.logger.log(`Dispute ${disputeId}: post-completion release ${sellerAmount} to seller wallet ${sellerWallet.id}`);
        }
      } else {
        if (buyerAmount > BigInt(0)) {
          const buyerResult1 = await tx.wallet.updateMany({
            where: { id: buyerWallet.id, version: buyerWallet.version },
            data: {
              escrowBalance: { decrement: buyerAmount },
              availableBalance: { increment: buyerAmount },
              version: { increment: 1 },
            },
          });
          if (buyerResult1.count === 0) {
            throw new ConflictException({ code: ErrorCodes.OPTIMISTIC_LOCK_CONFLICT, message: 'Concurrent wallet update during dispute resolution, please retry' });
          }
          const buyerTxId = generateWalletTxId(buyerTxSerial!);
          await tx.walletTransaction.create({
            data: {
              txId: buyerTxId, walletId: buyerWallet.id,
              type: WalletTransactionType.ORDER_REFUND, status: WalletTransactionStatus.SUCCESS,
              amount: buyerAmount, balanceBefore: buyerWallet.availableBalance, balanceAfter: buyerWallet.availableBalance + buyerAmount,
              orderId: dispute.orderId, description: `Dispute resolved: refund to buyer (order ${dispute.orderId})`,
            },
          });
          this.logger.log(`Dispute ${disputeId}: refunded ${buyerAmount} to buyer wallet ${buyerWallet.id}`);
        }

        if (sellerAmount > BigInt(0)) {
          // M6 follow-up (Wave 2): order patungan yang selesai lewat verdict
          // sengketa (dana diteruskan ke host) juga mendapat pengurang
          // overfunding — disamakan dengan completeOrder. Rebate mengurangi
          // penerimaan host dan dikredit ke availableBalance buyer.
          // - Fail-safe: rebate di-cap sellerAmount (penerimaan host tidak
          //   pernah negatif).
          // - Idempoten: guard baris ledger di computePatunganRebateTx.
          // - Sengketa PASCA-completion tidak kena rebate: sudah diterapkan
          //   saat completeOrder (cabang ini hanya untuk pra-completion).
          const patunganRebate = await computePatunganRebateTx(tx, dispute.orderId);
          let disputeRebate = patunganRebate?.rebateSen ?? 0n;
          if (disputeRebate > sellerAmount) disputeRebate = sellerAmount;
          const sellerNetAmount = sellerAmount - disputeRebate;
          const freshBuyerWalletForSeller = await tx.wallet.findUnique({ where: { id: buyerWallet.id } });
          if (!freshBuyerWalletForSeller) {
            throw new ConflictException({ code: ErrorCodes.NOT_FOUND, message: 'Buyer wallet disappeared during dispute resolution' });
          }
          const buyerResult2 = await tx.wallet.updateMany({
            where: { id: buyerWallet.id, version: freshBuyerWalletForSeller.version },
            data: {
              escrowBalance: { decrement: sellerAmount },
              totalBalance: { decrement: sellerNetAmount },
              ...(disputeRebate > 0n ? { availableBalance: { increment: disputeRebate } } : {}),
              version: { increment: 1 },
            },
          });
          if (buyerResult2.count === 0) {
            throw new ConflictException({ code: ErrorCodes.OPTIMISTIC_LOCK_CONFLICT, message: 'Concurrent wallet update during dispute resolution (buyer escrow decrement), please retry' });
          }
          const freshSellerWallet = await tx.wallet.findUnique({ where: { id: sellerWallet.id } });
          if (!freshSellerWallet) {
            throw new ConflictException({ code: ErrorCodes.NOT_FOUND, message: 'Seller wallet disappeared during dispute resolution' });
          }
          const sellerResult = await tx.wallet.updateMany({
            where: { id: freshSellerWallet.id, version: freshSellerWallet.version },
            data: { availableBalance: { increment: sellerNetAmount }, totalBalance: { increment: sellerNetAmount }, version: { increment: 1 } },
          });
          if (sellerResult.count === 0) {
            throw new ConflictException({ code: ErrorCodes.OPTIMISTIC_LOCK_CONFLICT, message: 'Concurrent wallet update during dispute resolution (seller credit), please retry' });
          }
          const sellerTxId = generateWalletTxId(sellerTxSerial!);
          await tx.walletTransaction.create({
            data: {
              txId: sellerTxId, walletId: freshSellerWallet.id,
              type: WalletTransactionType.DISPUTE_RELEASE, status: WalletTransactionStatus.SUCCESS,
              amount: sellerNetAmount, balanceBefore: freshSellerWallet.availableBalance, balanceAfter: freshSellerWallet.availableBalance + sellerNetAmount,
              orderId: dispute.orderId, description: `Dispute resolved: payment to seller (order ${dispute.orderId})`,
            },
          });
          this.logger.log(`Dispute ${disputeId}: released ${sellerNetAmount} to seller wallet ${sellerWallet.id}`);
          if (disputeRebate > 0n && patunganRebate) {
            const rebateTxId = generateWalletTxId(await nextDisputeRebateTxSerial());
            await createPatunganRebateLedgerTx(tx, {
              txId: rebateTxId,
              buyerWalletId: buyerWallet.id,
              orderDbId: dispute.orderId,
              orderPublicId: order.orderId,
              groupId: patunganRebate.groupId,
              rebateSen: disputeRebate,
              buyerAvailableBefore: freshBuyerWalletForSeller.availableBalance,
            });
            this.logger.log(`Dispute ${disputeId}: patungan overfunding rebate ${disputeRebate} to buyer wallet ${buyerWallet.id}`);
          }
        }

        if (platformRetainAmount > BigInt(0)) {
          const latestBuyerWallet = await tx.wallet.findUnique({ where: { id: buyerWallet.id } });
          if (!latestBuyerWallet) {
            throw new ConflictException({ code: ErrorCodes.NOT_FOUND, message: 'Buyer wallet disappeared during dispute fee deduction' });
          }
          const feeResult = await tx.wallet.updateMany({
            where: { id: buyerWallet.id, version: latestBuyerWallet.version },
            data: { escrowBalance: { decrement: platformRetainAmount }, totalBalance: { decrement: platformRetainAmount }, version: { increment: 1 } },
          });
          if (feeResult.count === 0) {
            throw new ConflictException({ code: ErrorCodes.OPTIMISTIC_LOCK_CONFLICT, message: 'Concurrent wallet update during dispute fee deduction, please retry' });
          }
          const feeTxId = generateWalletTxId(feeTxSerial!);
          await tx.walletTransaction.create({
            data: {
              txId: feeTxId, walletId: buyerWallet.id,
              type: WalletTransactionType.FEE_DEDUCT, status: WalletTransactionStatus.SUCCESS,
              amount: platformRetainAmount, balanceBefore: latestBuyerWallet.totalBalance, balanceAfter: latestBuyerWallet.totalBalance - platformRetainAmount,
              orderId: dispute.orderId, description: `Platform fee retained from dispute (order ${dispute.orderId})`,
            },
          });
          this.logger.log(`Dispute ${disputeId}: platform retained fee ${platformRetainAmount} from order ${dispute.orderId}`);
        }
      }

      // Batch 1-money (V-003): bila verdict meneruskan dana ke seller (order efektif
      // selesai), kreditkan cashback voucher. Untuk post-completion dispute, guard ledger
      // di helper membuat ini no-op (sudah dikredit saat complete). Refund penuh ke buyer
      // (sellerAmount == 0) tidak memicu cashback.
      if (sellerAmount > BigInt(0)) {
        await creditCashbackIfEligible(tx, () => this.walletTxSerialService.getNext(), {
          orderDbId: dispute.orderId,
          orderPublicId: order.orderId,
          source: 'dispute-verdict',
        });
      }

      const apologyVoucherRecipients = this.disputeApologyRecipients(dto.decision, order, buyerAmount, sellerAmount);
      const apologyVouchers = await this.issueDisputeApologyVouchers(tx, apologyVoucherRecipients, dispute.disputeId);

      // Notify both parties of the dispute decision.
      const decisionLabel =
        dto.decision === 'FULL_BUYER' ? 'Full amount refunded to buyer'
        : dto.decision === 'FULL_SELLER' ? 'Full amount forwarded to seller'
        : `Funds split ${dto.buyerPercent}% buyer / ${dto.sellerPercent}% seller`;

      const notifyUserIds = [order?.buyerId, order?.sellerId].filter((id): id is string => !!id);
      const disputeNotifTitle = 'Dispute Decision Made';
      const sanitizedNotes = dto.decisionNotes ? escapeHtml(dto.decisionNotes) : '';
      const disputeNotifBody = `The dispute for this order has been resolved by the Kahade team. Decision: ${decisionLabel}.${sanitizedNotes ? ' Notes: ' + sanitizedNotes : ''}`;
      return {
        decision,
        notifyUserIds,
        disputeNotifTitle,
        disputeNotifBody,
        resolvedDisputeId: dispute.id,
        auditTargetId: dispute.disputeId,
        auditDescription: `Admin resolved dispute ${dispute.disputeId} with decision ${dto.decision}`,
        auditAfter: { decision: dto.decision, buyerPercent: dto.buyerPercent, sellerPercent: dto.sellerPercent, platformFeeRefundedToBuyer: dto.decision === 'FULL_BUYER' && DISPUTE_FULL_BUYER_REFUNDS_PLATFORM_FEE },
        apologyVouchers,
      };
    }), 'ADMIN_DISPUTE_RESOLVE_TX');

    this.auditLog.logAdminAction({
      adminId,
      action: AuditAction.DISPUTE_DECIDED,
      targetType: 'Dispute',
      targetId: result.auditTargetId,
      description: result.auditDescription,
      after: result.auditAfter,
      ipAddress,
    });

    // BAI-098 + NCC-003: notifikasi putusan yang kegagalannya tercatat + status
    // kirim (lihat notifyDecisionOutcomeTracked — sudah mencakup actionUrl/ref
    // NCC-003 agar tap inbox membuka detail sengketa).
    const notificationDelivered = await this.notifyDecisionOutcomeTracked(result, adminId, ipAddress);

    // AW-018: openDisputes di summary dashboard berubah.
    await this.dashboard.invalidateSummaryCache();

    return { ...result.decision, notificationDelivered };
  }

  /**
   * M3 — resolve dispute TANPA menyentuh wallet internal (BI-safe).
   *
   * Perubahan state DB sama dengan jalur wallet (lock, guard, RESOLVED,
   * DisputeDecision, DP-014, history, voucher apology) minus semua pergerakan
   * wallet/ledger. Kebijakan pembagian (computeDisbursementAmounts) tidak
   * berubah — hanya rel uang yang diganti:
   * - porsi buyer  → DANA Refund API ke metode bayar asal (post-commit),
   * - porsi seller → DANA Disbursement ke rekening bank seller (post-commit),
   * - platform fee tertahan di akun merchant DANA.
   *
   * Sengketa pasca-completion → fail-closed SEBELUM DB ditulis: dana sudah
   * dicairkan ke seller; refund provider akan membayar dari kas platform
   * tanpa clawback — butuh keputusan operasional, jangan ditebak.
   *
   * Kegagalan eksekusi finansial post-commit dicatat keras dan dilaporkan di
   * return value; retry ditangani cron `dana-refund-retry` (attempt FAILED +
   * disbursement PENDING/FAILED) — idempoten per DISPUTE:<disputeId>:BUYER/:SELLER.
   */
  private async resolveDisputeNoWallet(
    dispute: Prisma.DisputeGetPayload<{ include: { order: true } }>,
    adminId: string,
    dto: DisputeDecisionDto,
    ipAddress: string,
    amounts: ReturnType<AdminDisputesService['computeDisbursementAmounts']>,
  ): Promise<object> {
    const { buyerAmount, sellerAmount, totalDisbursement } = amounts;

    if (amounts.isPostCompletionDispute) {
      throw new BadRequestException({
        code: 'DISPUTE_POST_COMPLETION_MANUAL_REVIEW',
        message: 'Post-completion dispute in no-wallet mode requires manual review — funds already disbursed to seller',
      });
    }

    const actingAdmin = await this.prisma.adminUser.findUnique({ where: { id: adminId }, select: { role: true } });
    const isSuperAdmin = actingAdmin?.role === 'SUPER_ADMIN';
    const resolvableStatuses: string[] = ['UNDER_REVIEW', 'ESCALATED'];

    const result = await this.withSerializableRetry(() => this.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      await tx.$queryRaw`SELECT id FROM disputes WHERE id = ${dispute.id} FOR UPDATE`;
      const freshDispute = await tx.dispute.findUnique({
        where: { id: dispute.id },
        select: { status: true, assignedAdminId: true },
      });
      if (!freshDispute || !resolvableStatuses.includes(freshDispute.status as string)) {
        throw new ConflictException({ code: ErrorCodes.INVALID_STATUS, message: 'Dispute state changed before resolution' });
      }
      if (freshDispute.assignedAdminId && freshDispute.assignedAdminId !== adminId && !isSuperAdmin) {
        throw new ForbiddenException({ code: ErrorCodes.NOT_ASSIGNED_ADMIN, message: 'Assignment changed before resolution; only the assigned admin or a SUPER_ADMIN can resolve' });
      }

      const order = await tx.order.findUnique({ where: { id: dispute.orderId } });
      if (!order || order.status !== OrderStatus.DISPUTED) {
        throw new ConflictException({ code: ErrorCodes.INVALID_STATUS, message: 'Order is no longer DISPUTED; dispute resolution was not applied' });
      }
      // Klasifikasi pra/pasca-completion tidak boleh berubah di tengah jalan.
      if (order.completedAt !== null) {
        throw new BadRequestException({
          code: 'DISPUTE_POST_COMPLETION_MANUAL_REVIEW',
          message: 'Order completed during review — manual review required (funds already disbursed)',
        });
      }
      const freshEscrowedAmount = order.buyerPayAmount;
      if (freshEscrowedAmount < totalDisbursement) {
        throw new ConflictException({ code: ErrorCodes.DISPUTE_AMOUNT_EXCEEDS_ESCROW, message: 'Fresh order escrow is lower than the proposed settlement' });
      }

      const existingDecision = await tx.disputeDecision.findUnique({ where: { disputeId: dispute.id } });
      if (existingDecision) {
        throw new ConflictException({ code: ErrorCodes.DISPUTE_ALREADY_RESOLVED, message: 'This dispute has already been resolved' });
      }

      await tx.dispute.update({
        where: { id: dispute.id },
        data: { status: 'RESOLVED', resolvedAt: new Date(), assignedAdminId: adminId },
      });

      const now = new Date();
      const firstAdminMessage = await tx.disputeMessage.findFirst({
        where: { disputeId: dispute.id, adminId: { not: null } },
        orderBy: { createdAt: 'asc' },
        select: { createdAt: true },
      });
      const timeToFirstResponseMs = firstAdminMessage
        ? firstAdminMessage.createdAt.getTime() - dispute.createdAt.getTime()
        : null;
      const totalResolutionTimeMs = now.getTime() - dispute.createdAt.getTime();

      const decision = await tx.disputeDecision.create({
        data: {
          disputeId: dispute.id,
          decidedBy: adminId,
          decisionType: dto.decision as DisputeDecisionType,
          decisionNotes: [
            dto.decisionNotes,
            timeToFirstResponseMs != null ? `[timing] firstResponse=${timeToFirstResponseMs}ms` : null,
            `[timing] totalResolution=${totalResolutionTimeMs}ms`,
          ].filter(Boolean).join(' | '),
          buyerAmount,
          sellerAmount,
          buyerPercent: dto.decision === 'SPLIT' ? new Decimal(dto.buyerPercent!) : null,
          sellerPercent: dto.decision === 'SPLIT' ? new Decimal(dto.sellerPercent!) : null,
        },
      });

      // DP-014: FULL_BUYER pra-completion = transaksi batal total → CANCELLED.
      // FULL_SELLER & SPLIT → COMPLETED.
      const isFullBuyerPreCompletion = dto.decision === 'FULL_BUYER';
      const resolvedOrderStatus = isFullBuyerPreCompletion ? OrderStatus.CANCELLED : OrderStatus.COMPLETED;
      await tx.order.update({
        where: { id: order.id },
        data: {
          status: resolvedOrderStatus,
          ...(isFullBuyerPreCompletion ? { cancelledAt: new Date() } : { completedAt: new Date() }),
        },
      });
      await tx.orderStatusHistory.create({
        data: {
          orderId: order.id,
          fromStatus: OrderStatus.DISPUTED,
          toStatus: resolvedOrderStatus,
          changedBy: adminId,
          changedByType: ActorType.ADMIN,
          reason: `Dispute resolved: ${dto.decision}${dto.decisionNotes ? ` — ${dto.decisionNotes}` : ''}`,
        },
      });

      const apologyVoucherRecipients = this.disputeApologyRecipients(dto.decision, order, buyerAmount, sellerAmount);
      const apologyVouchers = await this.issueDisputeApologyVouchers(tx, apologyVoucherRecipients, dispute.disputeId);

      // M4 no-wallet: cashback voucher (paritas jalur wallet: sellerAmount > 0) —
      // rencanakan payout DANA; dieksekusi post-commit bersama settlement.
      let danaCashback: {
        params: { orderDbId: string; orderPublicId: string; source: string };
        intent: { userId: string; amountSen: bigint; voucherCode: string | null; usageId: string };
      } | null = null;
      if (sellerAmount > BigInt(0)) {
        const cashbackParams = { orderDbId: order.id, orderPublicId: order.orderId, source: 'dispute-verdict' };
        const cashbackIntent = await planDanaCashback(tx, cashbackParams);
        danaCashback = cashbackIntent ? { params: cashbackParams, intent: cashbackIntent } : null;
      }

      const decisionLabel =
        dto.decision === 'FULL_BUYER' ? 'Full amount refunded to buyer'
        : dto.decision === 'FULL_SELLER' ? 'Full amount forwarded to seller'
        : `Funds split ${dto.buyerPercent}% buyer / ${dto.sellerPercent}% seller`;

      const notifyUserIds = [order?.buyerId, order?.sellerId].filter((id): id is string => !!id);
      const disputeNotifTitle = 'Dispute Decision Made';
      const sanitizedNotes = dto.decisionNotes ? escapeHtml(dto.decisionNotes) : '';
      const disputeNotifBody = `The dispute for this order has been resolved by the Kahade team. Decision: ${decisionLabel}.${sanitizedNotes ? ' Notes: ' + sanitizedNotes : ''}`;
      return {
        decision,
        notifyUserIds,
        disputeNotifTitle,
        disputeNotifBody,
        resolvedDisputeId: dispute.id,
        auditTargetId: dispute.disputeId,
        auditDescription: `Admin resolved dispute ${dispute.disputeId} with decision ${dto.decision} (no-wallet)`,
        auditAfter: { decision: dto.decision, buyerPercent: dto.buyerPercent, sellerPercent: dto.sellerPercent, noWallet: true },
        apologyVouchers,
        danaCashback,
      };
    }), 'ADMIN_DISPUTE_RESOLVE_NO_WALLET_TX');

    this.auditLog.logAdminAction({
      adminId,
      action: AuditAction.DISPUTE_DECIDED,
      targetType: 'Dispute',
      targetId: result.auditTargetId,
      description: result.auditDescription,
      after: result.auditAfter,
      ipAddress,
    });

    // BAI-098: notifikasi putusan yang kegagalannya tercatat + status kirim.
    const notificationDelivered = await this.notifyDecisionOutcomeTracked(result, adminId, ipAddress);

    await this.dashboard.invalidateSummaryCache();

    // M4 no-wallet: eksekusi payout cashback DANA post-commit (idempoten,
    // key CASHBACK:<orderDbId>). Scheduler retryDue() menangani PENDING/FAILED.
    if (result.danaCashback && this.escrowDisbursement) {
      const { params, intent } = result.danaCashback;
      await executeDanaCashback(this.escrowDisbursement, params, intent).catch((err: unknown) => {
        this.logger.warn(
          `DISPUTE_NO_WALLET_CASHBACK_FAILED dispute=${dispute.disputeId}: ${err instanceof Error ? err.message : String(err)} — retry via dana-refund-retry cron`,
        );
      });
    }

    // Eksekusi finansial post-commit (bukan bagian transaksi DB).
    const settlement = await this.disputeDanaSettlement.settleDisputeNoWallet({
      orderDbId: dispute.orderId,
      disputeDbId: dispute.id,
      decision: dto.decision,
      buyerAmountSen: buyerAmount,
      sellerAmountSen: sellerAmount,
      reason: `Dispute ${dispute.disputeId} resolved: ${dto.decision}`,
    }).catch((err: unknown) => {
      this.logger.error(
        `DISPUTE_NO_WALLET_SETTLEMENT_FAILED dispute=${dispute.disputeId}: ${err instanceof Error ? err.message : String(err)} — retry via dana-refund-retry cron`,
      );
      return null;
    });

    return { decision: result.decision, settlement, notificationDelivered };
  }

  /**
   * BAI-098 — notifikasi hasil putusan sengketa yang KEGAGALANNYA TERCATAT.
   *
   * Mengirim DISPUTE_DECISION ke kedua pihak + VOUCHER_ISSUED untuk apology
   * voucher, di-await berurutan (bukan fire-and-forget). Kegagalan persist
   * dicatat via logger.error + audit log (NOTIFICATION_FAILED) dan dilaporkan
   * lewat return value agar panel admin bisa menampilkan status kirim.
   * Mengembalikan true bila SEMUA notifikasi berhasil dipersist.
   */
  private async notifyDecisionOutcomeTracked(
    result: {
      notifyUserIds: string[];
      disputeNotifTitle: string;
      disputeNotifBody: string;
      resolvedDisputeId: string;
      auditTargetId: string;
      apologyVouchers: { userId: string; code: string }[];
    },
    adminId: string,
    ipAddress: string,
  ): Promise<boolean> {
    let delivered = true;
    const fail = (where: string, err: unknown): void => {
      delivered = false;
      this.logger.error(`notif putusan sengketa ${result.resolvedDisputeId} GAGAL (${where}): ${err instanceof Error ? err.message : String(err)}`);
    };
    for (const uid of result.notifyUserIds) {
      try {
        await this.prisma.notification.create({
          data: {
            notifId: generateNotifId(),
            userId: uid,
            type: NotificationType.DISPUTE_DECISION,
            category: getCategoryForType(NotificationType.DISPUTE_DECISION),
            title: result.disputeNotifTitle,
            body: result.disputeNotifBody,
            isRead: false,
            // NCC-003: actionUrl + ref agar tap inbox membuka detail sengketa.
            actionUrl: `/dispute/${encodeURIComponent(result.resolvedDisputeId)}`,
            refType: 'DISPUTE',
            refId: result.resolvedDisputeId,
          },
        });
        this.prisma.emitNotificationCreated({ userId: uid, title: result.disputeNotifTitle, body: result.disputeNotifBody, data: { type: 'DISPUTE_RESOLVED', disputeId: result.resolvedDisputeId } });
      } catch (err: unknown) { fail('DISPUTE_DECISION', err); }
    }
    for (const voucher of result.apologyVouchers) {
      try {
        await this.prisma.notification.create({
          data: {
            notifId: generateNotifId(),
            userId: voucher.userId,
            type: NotificationType.VOUCHER_ISSUED,
            category: getCategoryForType(NotificationType.VOUCHER_ISSUED),
            title: 'Voucher Apology dari Kahade',
            body: `Voucher ${voucher.code} telah ditambahkan sebagai permintaan maaf setelah sengketa selesai.`,
            metadata: { voucherCode: voucher.code, disputeId: result.resolvedDisputeId },
          },
        });
      } catch (err: unknown) { fail('VOUCHER_ISSUED', err); }
    }
    if (!delivered) {
      this.auditLog.logAdminAction({
        adminId,
        action: AuditAction.ADMIN_ACTION,
        targetType: 'Dispute',
        targetId: result.auditTargetId,
        description: `NOTIFICATION_FAILED: sebagian/seluruh notifikasi putusan sengketa ${result.resolvedDisputeId} tidak terkirim`,
        ipAddress,
      });
    }
    return delivered;
  }

  async assignAdmin(disputeId: string, requestingAdminId: string, targetAdminId?: string, _ipAddress: string = 'internal'): Promise<object> {
    const dispute = await this.prisma.dispute.findFirst({
      where: { OR: [{ id: disputeId }, { disputeId }] },
    });
    if (!dispute) throw new NotFoundException({ code: ErrorCodes.DISPUTE_NOT_FOUND, message: 'Dispute not found' });

    const requestingAdmin = await this.prisma.adminUser.findUnique({ where: { id: requestingAdminId }, select: { role: true } });
    const isSuperAdmin = requestingAdmin?.role === 'SUPER_ADMIN';

    const assignableStatuses: DisputeStatus[] = [DisputeStatus.OPEN, DisputeStatus.WAITING_RESPONSE];
    const reassignableStatuses: DisputeStatus[] = [DisputeStatus.ASSIGNED, DisputeStatus.UNDER_REVIEW];

    const isInitialAssign = assignableStatuses.includes(dispute.status as DisputeStatus);
    const isReassign = reassignableStatuses.includes(dispute.status as DisputeStatus);

    if (!isInitialAssign && !isReassign) {
      throw new BadRequestException({ code: ErrorCodes.INVALID_STATUS, message: `Dispute must be OPEN, WAITING_RESPONSE, ASSIGNED, or UNDER_REVIEW to assign (current: ${dispute.status})` });
    }

    if (isReassign && !isSuperAdmin) {
      throw new ForbiddenException({ code: 'FORBIDDEN', message: 'Only a SUPER_ADMIN can reassign an already-assigned dispute' });
    }

    let resolvedAssigneeId = requestingAdminId;
    if (targetAdminId && targetAdminId !== requestingAdminId) {
      if (!isSuperAdmin) {
        throw new ForbiddenException({ code: 'FORBIDDEN', message: 'Only a SUPER_ADMIN can assign disputes to another admin' });
      }
      resolvedAssigneeId = targetAdminId;
    }
    const targetAdmin = await this.prisma.adminUser.findFirst({
      where: {
        id: resolvedAssigneeId,
        isActive: true,
        deletedAt: null,
        role: { in: ['SUPER_ADMIN', 'DISPUTE_ADMIN'] },
      },
      select: { id: true },
    });
    if (!targetAdmin) {
      throw new NotFoundException({ code: 'ADMIN_NOT_ASSIGNABLE', message: 'Target admin is inactive, deleted, or not eligible for dispute assignment' });
    }

    const writeGuardStatuses: DisputeStatus[] = isSuperAdmin
      ? [...assignableStatuses, ...reassignableStatuses]
      : assignableStatuses;
    const result = await this.prisma.dispute.updateMany({
      where: { id: dispute.id, status: { in: writeGuardStatuses } },
      data: { assignedAdminId: resolvedAssigneeId, status: 'ASSIGNED', assignedAt: new Date() },
    });

    if (result.count === 0) {
      throw new ConflictException({ code: ErrorCodes.OPTIMISTIC_LOCK_CONFLICT, message: 'Dispute status changed concurrently, please retry' });
    }

    this.auditLog.logAdminAction({
      adminId: requestingAdminId,
      // BAI-090: pakai taksonomi DISPUTE_ASSIGNED (bukan ADMIN_ACTION generik)
      // agar filter audit action=DISPUTE_ASSIGNED menemukan jejak assign.
      action: AuditAction.DISPUTE_ASSIGNED,
      targetType: 'Dispute',
      targetId: dispute.disputeId,
      description: isReassign
        ? `Reassigned dispute ${dispute.disputeId} to admin ${resolvedAssigneeId}`
        : `Assigned dispute ${dispute.disputeId} to admin ${resolvedAssigneeId}`,
      after: { assignedAdminId: resolvedAssigneeId, isReassign },
      ipAddress: _ipAddress,
    });

    // AW-018: OPEN→ASSIGNED mengubah hitungan openDisputes di summary.
    await this.dashboard.invalidateSummaryCache();

    return this.prisma.dispute.findUniqueOrThrow({
      where: { id: dispute.id },
      select: { disputeId: true, status: true, assignedAdminId: true, assignedAt: true },
    });
  }

  async getDisputeMessages(disputeId: string, adminId: string, cursor?: string, limit: number = 50): Promise<object> {
    const dispute = await this.prisma.dispute.findFirst({
      where: { OR: [{ id: disputeId }, { disputeId }] },
      include: { order: { select: { buyerId: true, sellerId: true } } },
    });
    if (!dispute) throw new NotFoundException({ code: ErrorCodes.DISPUTE_NOT_FOUND, message: 'Dispute not found' });

    const admin = await this.prisma.adminUser.findUnique({ where: { id: adminId }, select: { role: true } });
    if (admin?.role !== 'SUPER_ADMIN' && dispute.assignedAdminId !== adminId) {
      throw new ForbiddenException({ code: ErrorCodes.NOT_ASSIGNED_ADMIN, message: 'Only the assigned admin or a SUPER_ADMIN can view dispute messages' });
    }
    if (cursor && !/^c[a-z0-9]{24}$/.test(cursor)) {
      throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Invalid message cursor' });
    }

    const safeLimit = Number.isFinite(limit) ? Math.min(100, Math.max(1, Math.floor(limit))) : 50;
    const messages = await this.prisma.disputeMessage.findMany({
      where: { disputeId: dispute.id },
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      take: safeLimit,
      orderBy: { createdAt: 'desc' },
      include: {
        sender: { select: { userId: true, fullName: true, username: true, avatarUrl: true } },
        admin: { select: { adminId: true, fullName: true } },
      },
    });
    const hasMore = messages.length === safeLimit;
    const nextCursor = hasMore ? messages[messages.length - 1].id : null;
    return { messages, nextCursor, hasMore };
  }

  /**
   * Percakapan order untuk keperluan resolver dispute, TERMASUK isi asli pesan
   * yang sudah dihapus lawan bicara.
   *
   * Mengapa endpoint ini ada: `deleteMessage()` dulu menghapus konten secara
   * permanen, sehingga pesan yang paling menentukan justru hilang tepat saat
   * dibutuhkan untuk memutus sengketa. Kini penghapusan dikunci selama
   * DISPUTED dan isi aslinya tetap tersimpan — endpoint ini yang
   * memperlihatkannya. Membuka percakapan user dicatat di audit log.
   */
  async getDisputeOrderChat(
    disputeId: string,
    adminId: string,
    cursor: string | undefined,
    limit: number = 50,
    includeDeleted: boolean = true,
    ipAddress: string = 'unknown',
  ): Promise<object> {
    const dispute = await this.prisma.dispute.findFirst({
      where: { OR: [{ id: disputeId }, { disputeId }] },
      include: { order: { select: { id: true, orderId: true, buyerId: true, sellerId: true } } },
    });
    if (!dispute) throw new NotFoundException({ code: ErrorCodes.DISPUTE_NOT_FOUND, message: 'Dispute not found' });

    const admin = await this.prisma.adminUser.findUnique({ where: { id: adminId }, select: { role: true, fullName: true } });
    if (admin?.role !== 'SUPER_ADMIN' && dispute.assignedAdminId !== adminId) {
      throw new ForbiddenException({ code: ErrorCodes.NOT_ASSIGNED_ADMIN, message: 'Only the assigned admin or a SUPER_ADMIN can view dispute messages' });
    }

    // BAI-088: mediator yang di-assign PERTAMA KALI memasuki room order →
    // beri tahu buyer & seller (DISPUTE_ADMIN_JOINED). Sekali per sengketa
    // (flag mediatorJoinedNotifiedAt + predikat updateMany agar idempoten di
    // bawah konkurensi). SUPER_ADMIN yang sekadar mengintip tidak memicu —
    // hanya mediator yang memegang kasus. Best-effort tercatat (BAI-098):
    // kegagalan tidak menggagalkan baca chat.
    if (dispute.assignedAdminId === adminId && !dispute.mediatorJoinedNotifiedAt) {
      const marked = await this.prisma.dispute.updateMany({
        where: { id: dispute.id, mediatorJoinedNotifiedAt: null },
        data: { mediatorJoinedNotifiedAt: new Date() },
      });
      if (marked.count > 0) {
        const joinedTitle = 'Mediator bergabung';
        const joinedBody = `Mediator ${admin?.fullName?.trim() || 'Kahade'} telah bergabung untuk menangani sengketa ${dispute.disputeId}.`;
        for (const partyId of [dispute.order.buyerId, dispute.order.sellerId]) {
          try {
            await this.prisma.notification.create({
              data: {
                notifId: generateNotifId(),
                userId: partyId,
                type: NotificationType.DISPUTE_ADMIN_JOINED,
                category: getCategoryForType(NotificationType.DISPUTE_ADMIN_JOINED),
                title: joinedTitle,
                body: joinedBody,
                isRead: false,
              },
            });
            this.prisma.emitNotificationCreated({
              userId: partyId,
              title: joinedTitle,
              body: joinedBody,
              data: { type: 'DISPUTE_ADMIN_JOINED', disputeId: dispute.disputeId },
            });
          } catch (err: unknown) {
            this.logger.error(`DISPUTE_ADMIN_JOINED gagal untuk sengketa ${dispute.disputeId}: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
        this.auditLog.logAdminAction({
          adminId,
          action: AuditAction.ADMIN_ACTION,
          targetType: 'Dispute',
          targetId: dispute.disputeId,
          description: `Mediator joined order chat for dispute ${dispute.disputeId} (DISPUTE_ADMIN_JOINED sent)`,
          ipAddress,
        });
      }
    }

    const room = await this.prisma.chatRoom.findUnique({
      where: { orderId: dispute.order.id },
      select: { id: true },
    });
    if (!room) {
      return { messages: [], nextCursor: null, hasMore: false };
    }

    const safeLimit = Number.isFinite(limit) ? Math.min(100, Math.max(1, Math.floor(limit))) : 50;
    const result = await this.chatService.getRoomMessagesForAdmin(room.id, {
      limit: safeLimit,
      cursor,
      includeDeleted,
    });

    this.auditLog.logAdminAction({
      adminId,
      action: AuditAction.ADMIN_ACTION,
      targetType: 'Dispute',
      targetId: dispute.disputeId,
      description: `Admin read order chat for dispute ${dispute.disputeId}`,
      after: { roomId: room.id, includeDeleted },
      ipAddress,
    });

    return result;
  }

  async markUnderReview(disputeId: string, adminId: string, ipAddress: string = 'unknown'): Promise<object> {
    const dispute = await this.prisma.dispute.findFirst({
      where: { OR: [{ id: disputeId }, { disputeId }] },
    });
    if (!dispute) throw new NotFoundException({ code: ErrorCodes.DISPUTE_NOT_FOUND, message: 'Dispute not found' });

    const allowedForReview: DisputeStatus[] = [DisputeStatus.ASSIGNED];
    if (!allowedForReview.includes(dispute.status)) {
      throw new BadRequestException({ code: ErrorCodes.INVALID_STATUS, message: `Dispute must be ASSIGNED before active review (current: ${dispute.status})` });
    }

    const resolverAdmin = await this.prisma.adminUser.findUnique({ where: { id: adminId }, select: { role: true } });
    if (!dispute.assignedAdminId) {
      throw new ForbiddenException({ code: ErrorCodes.NOT_ASSIGNED_ADMIN, message: 'Assign the dispute to an admin before beginning review' });
    }
    if (dispute.assignedAdminId !== adminId && resolverAdmin?.role !== 'SUPER_ADMIN') {
      throw new ForbiddenException({ code: ErrorCodes.NOT_ASSIGNED_ADMIN, message: 'Only the assigned admin or a SUPER_ADMIN can begin review' });
    }

    const result = await this.prisma.dispute.updateMany({
      where: resolverAdmin?.role === 'SUPER_ADMIN'
        ? { id: dispute.id, status: DisputeStatus.ASSIGNED }
        : { id: dispute.id, status: DisputeStatus.ASSIGNED, assignedAdminId: adminId },
      data: { status: DisputeStatus.UNDER_REVIEW },
    });

    if (result.count === 0) {
      throw new BadRequestException({ code: ErrorCodes.OPTIMISTIC_LOCK_CONFLICT, message: 'Dispute status changed concurrently, please retry' });
    }

    this.auditLog.logAdminAction({
      adminId,
      // BAI-090: mulai-review adalah bagian dari alur assignment — catat
      // sebagai DISPUTE_ASSIGNED agar jejak "siapa memegang sengketa kapan"
      // bisa difilter (sebelumnya tenggelam di ADMIN_ACTION generik).
      action: AuditAction.DISPUTE_ASSIGNED,
      targetType: 'Dispute',
      targetId: dispute.disputeId,
      description: `Admin marked dispute ${dispute.disputeId} as UNDER_REVIEW (was ${dispute.status})`,
      before: { status: dispute.status },
      after: { status: DisputeStatus.UNDER_REVIEW },
      ipAddress,
    });

    // AW-018: ASSIGNED→UNDER_REVIEW mengubah hitungan openDisputes di summary.
    await this.dashboard.invalidateSummaryCache();

    return this.prisma.dispute.findUnique({
      where: { id: dispute.id },
      select: { disputeId: true, status: true, assignedAdminId: true },
    }) as Promise<object>;
  }

  async sendDisputeMessage(disputeId: string, adminId: string, content: string, ipAddress: string = 'unknown'): Promise<object> {
    const dispute = await this.prisma.dispute.findFirst({
      where: { OR: [{ id: disputeId }, { disputeId }] },
      include: { order: { select: { buyerId: true, sellerId: true } } },
    });
    if (!dispute) throw new NotFoundException({ code: ErrorCodes.DISPUTE_NOT_FOUND, message: 'Dispute not found' });

    const admin = await this.prisma.adminUser.findUnique({ where: { id: adminId }, select: { role: true, fullName: true, adminId: true } });
    const isSuperAdmin = admin?.role === 'SUPER_ADMIN';
    if (!isSuperAdmin && dispute.assignedAdminId !== adminId) {
      throw new ForbiddenException({ code: ErrorCodes.NOT_ASSIGNED_ADMIN, message: 'Only the assigned admin or a SUPER_ADMIN can send dispute messages' });
    }
    const activeStatuses: DisputeStatus[] = [DisputeStatus.OPEN, DisputeStatus.ASSIGNED, DisputeStatus.UNDER_REVIEW, DisputeStatus.WAITING_RESPONSE, DisputeStatus.ESCALATED];
    if (!activeStatuses.includes(dispute.status)) {
      throw new BadRequestException({ code: ErrorCodes.INVALID_STATUS, message: 'Cannot send messages to a resolved or cancelled dispute' });
    }
    const normalizedContent = content.trim();
    if (!normalizedContent || normalizedContent.length > 2000) {
      throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Message must contain 1–2000 non-whitespace characters' });
    }
    const safeContent = escapeHtml(normalizedContent);
    const message = await this.prisma.disputeMessage.create({
      data: { disputeId: dispute.id, senderId: null, adminId, message: safeContent, attachments: [] },
      include: {
        sender: { select: { userId: true, fullName: true, username: true, avatarUrl: true } },
        admin: { select: { adminId: true, fullName: true } },
      },
    });
    const recipientIds = [dispute.order.buyerId, dispute.order.sellerId];
    for (const userId of recipientIds) {
      try {
        this.realtime.emitToUser(userId, 'dispute.new_message', { disputeId: dispute.disputeId, message });
      } catch (error: unknown) {
        this.logger.warn(`dispute admin message realtime failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    // DP-022: pesan mediasi admin tidak boleh hanya realtime — pihak yang offline
    // butuh notification row + push (pola dispute-message.service.ts DSP-OFFLINE-01).
    // Pakai safeContent (sudah escapeHtml) agar tidak ada HTML mentah di notifikasi.
    // BAI-098: kirim di-await berurutan; kegagalan tercatat (audit + logger) dan
    // dilaporkan via notificationDelivered — bukan silent-catch.
    const mediationTitle = 'Pesan baru dari mediator';
    const mediationPreview = safeContent.length > 120 ? safeContent.slice(0, 120) + '…' : safeContent;
    let notificationDelivered = true;
    for (const userId of recipientIds) {
      try {
        await this.prisma.notification.create({
          data: {
            notifId: generateNotifId(),
            userId,
            type: NotificationType.DISPUTE_MESSAGE_RECEIVED,
            category: getCategoryForType(NotificationType.DISPUTE_MESSAGE_RECEIVED),
            title: mediationTitle,
            body: mediationPreview || `Mediator mengirim pesan baru pada sengketa ${dispute.disputeId}.`,
            isRead: false,
            // NCC-003: actionUrl + ref agar tap inbox membuka detail sengketa.
            actionUrl: `/dispute/${encodeURIComponent(dispute.disputeId)}`,
            refType: 'DISPUTE', refId: dispute.disputeId,
          },
        });
        this.prisma.emitNotificationCreated({
          userId,
          title: mediationTitle,
          body: mediationPreview || `Mediator mengirim pesan baru pada sengketa ${dispute.disputeId}.`,
          data: { type: 'DISPUTE_MESSAGE_RECEIVED', disputeId: dispute.disputeId },
        });
      } catch (err: unknown) {
        notificationDelivered = false;
        this.logger.error(`notif pesan mediasi sengketa ${dispute.disputeId} GAGAL ke user ${userId}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (!notificationDelivered) {
      this.auditLog.logAdminAction({
        adminId,
        action: AuditAction.ADMIN_ACTION,
        targetType: 'Dispute',
        targetId: dispute.disputeId,
        description: `NOTIFICATION_FAILED: admin mediation message notification not delivered for dispute ${dispute.disputeId}`,
        after: { messageId: message.id },
        ipAddress,
      });
    }
    this.auditLog.logAdminAction({
      adminId,
      action: AuditAction.ADMIN_ACTION,
      targetType: 'Dispute',
      targetId: dispute.disputeId,
      description: `Admin sent mediation message in dispute ${dispute.disputeId}`,
      after: { messageId: message.id, notificationDelivered },
      ipAddress,
    });
    return { ...message, notificationDelivered };
  }

  /**
   * BAI-094 — admin melampirkan bukti "titipan" ke sengketa.
   *
   * Kontras dengan jalur user (UploadPurpose.USER → upload service): bukti
   * admin melewati UploadService.uploadDirect dengan tujuan DISPUTE_EVIDENCE
   * (prefix `uploads/dispute-evidence/<adminId>/`, pola sama dengan jalur
   * user — lihat verifikasi prefix di upload.service.ts).
   */
  async uploadEvidenceFileAsAdmin(
    disputeId: string,
    adminId: string,
    file: { originalname: string; mimetype: string; size: number; buffer: Buffer } | undefined,
    ipAddress: string = 'internal',
  ): Promise<object> {
    const dispute = await this.mustFindDisputeForAdmin(disputeId, adminId, 'upload evidence');
    if (!file || !file.buffer || file.size === 0) {
      throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'File bukti wajib dilampirkan.' });
    }
    const result = await this.uploadService.uploadDirect(
      adminId,
      UploadPurpose.DISPUTE_EVIDENCE,
      file.originalname,
      file.mimetype,
      file.buffer,
    );
    this.auditLog.logAdminAction({
      adminId,
      action: AuditAction.DISPUTE_EVIDENCE_SUBMITTED,
      targetType: 'Dispute',
      targetId: dispute.disputeId,
      description: `Admin uploaded dispute evidence file (pending submit) for dispute ${dispute.disputeId}`,
      after: { fileKey: result.fileKey },
      ipAddress,
    });
    return result;
  }

  /**
   * BAI-094 — admin meng-submit bukti "titipan" (file SUDAH di-upload via
   * uploadEvidenceFileAsAdmin, belum di-confirm) ke sengketa.
   *
   * Menyatakan bukti atas nama ADMIN (submittedByRole='ADMIN',
   * submittedByAdminId), fail-closed:
   * - hanya mediator yang di-assign / SUPER_ADMIN (NOT_ASSIGNED_ADMIN);
   * - hanya status terbuka untuk bukti (OPEN, ASSIGNED, UNDER_REVIEW —
   *   ditambah ESCALATED karena mediator paling butuh melampirkan titipan
   *   saat eskalasi berjalan);
   * - fileKeys wajib lolos verifikasi prefix/konfirmasi (anti-referensi
   *   file milik user lain);
   * - batas 10MB/file dan 50MB per submit (pola sama dengan jalur user).
   */
  async submitEvidenceAsAdmin(
    disputeId: string,
    adminId: string,
    dto: SubmitDisputeEvidenceAdminDto,
    ipAddress: string = 'internal',
  ): Promise<object> {
    const dispute = await this.mustFindDisputeForAdmin(disputeId, adminId, 'submit evidence');
    const openForEvidence: DisputeStatus[] = [DisputeStatus.OPEN, DisputeStatus.ASSIGNED, DisputeStatus.UNDER_REVIEW, DisputeStatus.ESCALATED];
    if (!openForEvidence.includes(dispute.status)) {
      throw new BadRequestException({ code: ErrorCodes.INVALID_STATUS, message: `Bukti tidak bisa ditambahkan pada sengketa berstatus ${dispute.status}.` });
    }
    if (!dto.fileUrls || dto.fileUrls.length === 0) {
      throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Minimal satu file bukti wajib dilampirkan.' });
    }
    if (dto.fileUrls.length !== dto.fileTypes.length) {
      throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'fileUrls dan fileTypes harus berpasangan.' });
    }

    // Verifikasi kunci (prefix admin-scoped + confirmed, anti-spoof).
    const fileResults = await this.uploadService.verifyEvidenceFileKeysBatch(adminId, dto.fileUrls, dto.fileTypes);
    const failed = fileResults.filter((r) => r.status !== 'ok');
    if (failed.length > 0) {
      throw new BadRequestException({
        code: ErrorCodes.VALIDATION_ERROR,
        message: `Bukti tidak valid: ${failed.map((f) => f.error ?? 'unknown').join('; ')}`,
      });
    }
    const validKeys = dto.fileUrls;
    const validTypes = fileResults.map((r) => r.fileType);
    // Verifikasi ukuran (pola sama dengan jalur user; verify batch tidak
    // mengembalikan size, jadi baca via getFileSize).
    const MAX_PER_FILE = 10 * 1024 * 1024;
    const MAX_TOTAL = 50 * 1024 * 1024;
    const fileSizes = await Promise.all(
      validKeys.map(async (key) => {
        try {
          return await this.uploadService.getFileSize(key);
        } catch {
          return -1;
        }
      }),
    );
    if (fileSizes.some((s) => s < 0)) {
      throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Ukuran salah satu file tidak bisa diverifikasi. Coba lagi.' });
    }
    const oversizedIdx = fileSizes.findIndex((s) => s > MAX_PER_FILE);
    if (oversizedIdx >= 0) {
      throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: `File ${validKeys[oversizedIdx]} melebihi batas 10MB.` });
    }
    const totalSize = fileSizes.reduce((sum, s) => sum + s, 0);
    if (totalSize > MAX_TOTAL) {
      throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Total ukuran bukti melebihi batas 50MB per submit.' });
    }

    // Model DisputeEvidence hanya menyimpan description (tanpa title/tags) —
    // judul dilipat ke baris pertama deskripsi, pola sama dengan jalur user.
    const description = `[${dto.title}] ${dto.description}\n\n— Evidence (titipan) admin untuk sengketa ${dispute.disputeId}`;
    const evidence = await this.prisma.disputeEvidence.create({
      data: {
        disputeId: dispute.id,
        description,
        fileUrls: validKeys,
        fileTypes: validTypes,
        submittedByRole: 'ADMIN',
        submittedByAdminId: adminId,
      },
    });

    this.auditLog.logAdminAction({
      adminId,
      action: AuditAction.DISPUTE_EVIDENCE_SUBMITTED,
      targetType: 'Dispute',
      targetId: dispute.disputeId,
      description: `Admin submitted evidence (titipan) for dispute ${dispute.disputeId}: ${dto.title}`,
      after: { evidenceDbId: evidence.id, fileCount: validKeys.length },
      ipAddress,
    });

    // Beri tahu kedua pihak (transparansi) — kegagalan tercatat (BAI-098).
    let notificationDelivered = true;
    const evTitle = 'Bukti baru pada sengketa';
    const evBody = `Mediator menambahkan bukti "${dto.title}" pada sengketa ${dispute.disputeId}.`;
    for (const partyId of [dispute.order.buyerId, dispute.order.sellerId]) {
      try {
        await this.prisma.notification.create({
          data: {
            notifId: generateNotifId(),
            userId: partyId,
            type: NotificationType.DISPUTE_EVIDENCE_SUBMITTED,
            category: getCategoryForType(NotificationType.DISPUTE_EVIDENCE_SUBMITTED),
            title: evTitle,
            body: evBody,
            isRead: false,
          },
        });
        this.prisma.emitNotificationCreated({
          userId: partyId,
          title: evTitle,
          body: evBody,
          data: { type: 'DISPUTE_EVIDENCE_SUBMITTED', disputeId: dispute.disputeId },
        });
      } catch (err: unknown) {
        notificationDelivered = false;
        this.logger.error(`notif bukti admin sengketa ${dispute.disputeId} GAGAL: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    return {
      evidence,
      fileResults,
      summary: { filesAttached: validKeys.length, totalSizeBytes: totalSize },
      notificationDelivered,
    };
  }

  /**
   * BAI-095 — baca catatan internal sengketa (kolaboratif antar admin).
   * Hanya mediator yang di-assign / SUPER_ADMIN (NOT_ASSIGNED_ADMIN).
   */
  async listInternalNotes(disputeId: string, adminId: string): Promise<object> {
    const dispute = await this.mustFindDisputeForAdmin(disputeId, adminId, 'read internal notes');
    const notes = await this.prisma.disputeInternalNote.findMany({
      where: { disputeId: dispute.id },
      orderBy: { createdAt: 'asc' },
      include: { admin: { select: { adminId: true, fullName: true } } },
    });
    return { disputeId: dispute.disputeId, notes };
  }

  /**
   * BAI-095 — tambah catatan internal sengketa (maks 2000 karakter).
   * Hanya mediator yang di-assign / SUPER_ADMIN (NOT_ASSIGNED_ADMIN).
   */
  async addInternalNote(
    disputeId: string,
    adminId: string,
    note: string,
    ipAddress: string = 'internal',
  ): Promise<object> {
    const dispute = await this.mustFindDisputeForAdmin(disputeId, adminId, 'add internal note');
    const trimmed = (note ?? '').trim();
    if (!trimmed || trimmed.length > 2000) {
      throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Catatan harus 1–2000 karakter.' });
    }
    const created = await this.prisma.disputeInternalNote.create({
      data: { disputeId: dispute.id, adminId, note: trimmed },
      include: { admin: { select: { adminId: true, fullName: true } } },
    });
    this.auditLog.logAdminAction({
      adminId,
      action: AuditAction.ADMIN_ACTION,
      targetType: 'Dispute',
      targetId: dispute.disputeId,
      description: `Admin added internal note to dispute ${dispute.disputeId}`,
      after: { noteId: created.id },
      ipAddress,
    });
    return created;
  }

  /**
   * Guard bersama untuk operasi admin atas sengketa (BAI-088/094/095):
   * sengketa harus ada dan admin harus mediator yang di-assign atau
   * SUPER_ADMIN — fail-closed dengan NOT_ASSIGNED_ADMIN.
   */
  private async mustFindDisputeForAdmin(
    disputeId: string,
    adminId: string,
    actionLabel: string,
  ): Promise<{ id: string; disputeId: string; status: DisputeStatus; assignedAdminId: string | null; order: { buyerId: string; sellerId: string } }> {
    const dispute = await this.prisma.dispute.findFirst({
      where: { OR: [{ id: disputeId }, { disputeId }] },
      include: { order: { select: { buyerId: true, sellerId: true } } },
    });
    if (!dispute) {
      throw new NotFoundException({ code: ErrorCodes.DISPUTE_NOT_FOUND, message: 'Dispute not found' });
    }
    const admin = await this.prisma.adminUser.findUnique({ where: { id: adminId }, select: { role: true } });
    if (admin?.role !== 'SUPER_ADMIN' && dispute.assignedAdminId !== adminId) {
      throw new ForbiddenException({ code: ErrorCodes.NOT_ASSIGNED_ADMIN, message: `Only the assigned mediator or a SUPER_ADMIN can ${actionLabel}` });
    }
    return dispute as { id: string; disputeId: string; status: DisputeStatus; assignedAdminId: string | null; order: { buyerId: string; sellerId: string } };
  }
}
