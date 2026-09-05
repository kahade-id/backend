import { Injectable, NotFoundException, BadRequestException, ConflictException, ForbiddenException, Logger } from '@nestjs/common';
import { Decimal } from '@prisma/client/runtime/library';
import { randomInt } from 'crypto';
import { Prisma, DisputeDecisionType, DisputeStatus, OrderStatus, ActorType, WalletTransactionType, WalletTransactionStatus, AuditAction, NotificationType } from '@prisma/client';
import { getCategoryForType } from '../../notifications/notification-category.map';
import { PrismaService } from '../../../prisma/prisma.service';
import { WalletTxSerialService } from '../../../common/services/wallet-tx-serial.service';
import { generateWalletTxId, generateNotifId } from '../../../common/utils/id-generator.util';
import { DisputeDecisionDto, validateSplitPercents } from './dispute-decision.dto';
import { AuditLogService } from '../../../common/services/audit-log.service';
import { toIdr } from '../../../common/utils/currency.util';
import * as ErrorCodes from '../../../common/constants/error-codes';
import { createPaginatedResponse } from '../../../common/dto/pagination.dto';
import { escapeHtml } from '../../../common/utils/sanitize.util';
import { UploadService } from '../../upload/upload.service';
import { RealtimeService } from '../../realtime/realtime.service';

@Injectable()
export class AdminDisputesService {
  private readonly logger = new Logger(AdminDisputesService.name);

  constructor(
    private prisma: PrismaService,
    private walletTxSerialService: WalletTxSerialService,
    private auditLog: AuditLogService,
    private uploadService: UploadService,
    private realtime: RealtimeService,
  ) {}

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

  async listDisputes(page = 1, limit = 20, status?: string, search?: string): Promise<object> {
    if (status !== undefined && !['OPEN', 'ASSIGNED', 'UNDER_REVIEW', 'WAITING_RESPONSE', 'ESCALATED', 'RESOLVED', 'CANCELLED'].includes(status)) {
      throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Invalid dispute status' });
    }
    const safePage = Number.isFinite(page) ? Math.max(1, Math.floor(page)) : 1;
    const safeLimit = Number.isFinite(limit) ? Math.min(100, Math.max(1, Math.floor(limit))) : 20;
    const skip = (safePage - 1) * safeLimit;
    const where: Prisma.DisputeWhereInput = {};
    if (status) where.status = status as Prisma.EnumDisputeStatusFilter;
    const normalizedSearch = search?.trim();
    if (normalizedSearch) {
      where.OR = [
        { disputeId: { contains: normalizedSearch, mode: 'insensitive' } },
        { order: { orderId: { contains: normalizedSearch, mode: 'insensitive' } } },
      ];
    }

    const [disputes, total] = await Promise.all([
      this.prisma.dispute.findMany({
        where,
        skip,
        take: safeLimit,
        orderBy: { createdAt: 'desc' },
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

  async resolveDispute(disputeId: string, adminId: string, dto: DisputeDecisionDto, ipAddress: string = 'internal'): Promise<object> {
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

    const isPostCompletionDispute = dispute.order.completedAt !== null;
    const sellerReceiveAmount = dispute.order.sellerReceiveAmount;

    const escrowedAmount = isPostCompletionDispute
      ? sellerReceiveAmount
      : dispute.order.buyerPayAmount;
    const platformFee = isPostCompletionDispute
      ? BigInt(0)
      : dispute.order.buyerPayAmount - sellerReceiveAmount;

    if (escrowedAmount <= BigInt(0)) {
      throw new BadRequestException({ code: ErrorCodes.INVALID_STATUS, message: 'No escrowed funds available for dispute resolution' });
    }

    let buyerAmount: bigint;
    let sellerAmount: bigint;
    let platformRetainAmount: bigint;

    if (dto.decision === 'FULL_BUYER') {
      buyerAmount = sellerReceiveAmount;
      sellerAmount = BigInt(0);
      platformRetainAmount = platformFee;
    } else if (dto.decision === 'FULL_SELLER') {
      buyerAmount = BigInt(0);
      sellerAmount = sellerReceiveAmount;
      platformRetainAmount = platformFee;
    } else {
      buyerAmount = (sellerReceiveAmount * BigInt(dto.buyerPercent!)) / BigInt(100);
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

    // Redis-backed wallet serials are not rolled back with PostgreSQL. Allocate
    // them before the transaction so a later retry/serialization recovery can
    // reuse the same ledger IDs instead of burning new IDs.
    const buyerTxSerial = buyerAmount > BigInt(0) ? await this.walletTxSerialService.getNext() : null;
    const sellerTxSerial = sellerAmount > BigInt(0) ? await this.walletTxSerialService.getNext() : null;
    const feeTxSerial = platformRetainAmount > BigInt(0) ? await this.walletTxSerialService.getNext() : null;

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
        await tx.order.update({
          where: { id: order.id },
          data: {
            status: OrderStatus.COMPLETED,
            ...(order.completedAt ? {} : { completedAt: new Date() }),
          },
        });
        await tx.orderStatusHistory.create({
          data: {
            orderId: order.id,
            fromStatus: OrderStatus.DISPUTED,
            toStatus: OrderStatus.COMPLETED,
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
          const freshBuyerWalletForSeller = await tx.wallet.findUnique({ where: { id: buyerWallet.id } });
          if (!freshBuyerWalletForSeller) {
            throw new ConflictException({ code: ErrorCodes.NOT_FOUND, message: 'Buyer wallet disappeared during dispute resolution' });
          }
          const buyerResult2 = await tx.wallet.updateMany({
            where: { id: buyerWallet.id, version: freshBuyerWalletForSeller.version },
            data: { escrowBalance: { decrement: sellerAmount }, totalBalance: { decrement: sellerAmount }, version: { increment: 1 } },
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
            data: { availableBalance: { increment: sellerAmount }, totalBalance: { increment: sellerAmount }, version: { increment: 1 } },
          });
          if (sellerResult.count === 0) {
            throw new ConflictException({ code: ErrorCodes.OPTIMISTIC_LOCK_CONFLICT, message: 'Concurrent wallet update during dispute resolution (seller credit), please retry' });
          }
          const sellerTxId = generateWalletTxId(sellerTxSerial!);
          await tx.walletTransaction.create({
            data: {
              txId: sellerTxId, walletId: freshSellerWallet.id,
              type: WalletTransactionType.DISPUTE_RELEASE, status: WalletTransactionStatus.SUCCESS,
              amount: sellerAmount, balanceBefore: freshSellerWallet.availableBalance, balanceAfter: freshSellerWallet.availableBalance + sellerAmount,
              orderId: dispute.orderId, description: `Dispute resolved: payment to seller (order ${dispute.orderId})`,
            },
          });
          this.logger.log(`Dispute ${disputeId}: released ${sellerAmount} to seller wallet ${sellerWallet.id}`);
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
        auditAfter: { decision: dto.decision, buyerPercent: dto.buyerPercent, sellerPercent: dto.sellerPercent },
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

    for (const uid of result.notifyUserIds) {
      this.prisma.notification.create({
        data: {
          notifId: generateNotifId(),
          userId: uid,
          type: NotificationType.DISPUTE_DECISION,
          category: getCategoryForType(NotificationType.DISPUTE_DECISION),
          title: result.disputeNotifTitle,
          body: result.disputeNotifBody,
          isRead: false,
        },
      }).catch((err: unknown) => this.logger.warn(`silent-catch: dispute decision notification failed: ${err instanceof Error ? err.message : String(err)}`));
      this.prisma.emitNotificationCreated({ userId: uid, title: result.disputeNotifTitle, body: result.disputeNotifBody, data: { type: 'DISPUTE_RESOLVED', disputeId: result.resolvedDisputeId } });
    }

    return result.decision;
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
      action: AuditAction.ADMIN_ACTION,
      targetType: 'Dispute',
      targetId: dispute.disputeId,
      description: isReassign
        ? `Reassigned dispute ${dispute.disputeId} to admin ${resolvedAssigneeId}`
        : `Assigned dispute ${dispute.disputeId} to admin ${resolvedAssigneeId}`,
      after: { assignedAdminId: resolvedAssigneeId, isReassign },
      ipAddress: _ipAddress,
    });

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
      action: AuditAction.ADMIN_ACTION,
      targetType: 'Dispute',
      targetId: dispute.disputeId,
      description: `Admin marked dispute ${dispute.disputeId} as UNDER_REVIEW (was ${dispute.status})`,
      before: { status: dispute.status },
      after: { status: DisputeStatus.UNDER_REVIEW },
      ipAddress,
    });

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
    this.auditLog.logAdminAction({
      adminId,
      action: AuditAction.ADMIN_ACTION,
      targetType: 'Dispute',
      targetId: dispute.disputeId,
      description: `Admin sent mediation message in dispute ${dispute.disputeId}`,
      after: { messageId: message.id },
      ipAddress,
    });
    return message;
  }
}
