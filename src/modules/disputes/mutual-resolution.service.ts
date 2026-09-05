import { Injectable, NotFoundException, BadRequestException, ForbiddenException, ConflictException, Logger } from '@nestjs/common';
import { randomInt } from 'crypto';
import { Prisma, DisputeStatus, OrderStatus, ActorType, WalletTransactionType, WalletTransactionStatus, NotificationType, SubscriptionStatus } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { WalletTxSerialService } from '../../common/services/wallet-tx-serial.service';
import { FeeCalculatorService } from '../orders/fee-calculator.service';
import { generateWalletTxId, generateNotifId } from '../../common/utils/id-generator.util';
import { getCategoryForType } from '../notifications/notification-category.map';
import * as ErrorCodes from '../../common/constants/error-codes';

const MAX_RETRIES = 3;

@Injectable()
export class MutualResolutionService {
  private readonly logger = new Logger(MutualResolutionService.name);

  constructor(
    private prisma: PrismaService,
    private walletTxSerialService: WalletTxSerialService,
    private feeCalculator: FeeCalculatorService,
  ) {}

  async propose(
    disputeId: string,
    userId: string,
    dto: { buyerPercent: number; sellerPercent: number; reason: string },
  ): Promise<object> {
    if (!Number.isInteger(dto.buyerPercent) || !Number.isInteger(dto.sellerPercent)
      || dto.buyerPercent < 0 || dto.sellerPercent < 0
      || dto.buyerPercent > 100 || dto.sellerPercent > 100
      || dto.buyerPercent + dto.sellerPercent !== 100) {
      throw new BadRequestException({ code: 'VALIDATION_ERROR', message: 'Percentages must be integers from 0 to 100 and total 100' });
    }
    const normalizedReason = typeof dto.reason === 'string' ? dto.reason.trim() : '';
    if (normalizedReason.length < 10 || normalizedReason.length > 2000) {
      throw new BadRequestException({ code: 'VALIDATION_ERROR', message: 'Reason must contain 10–2000 non-whitespace characters' });
    }

    const dispute = await this.prisma.dispute.findFirst({
      where: { OR: [{ id: disputeId }, { disputeId }] },
      include: { order: { select: { buyerId: true, sellerId: true, orderId: true, title: true, status: true } } },
    });

    if (!dispute) throw new NotFoundException({ code: ErrorCodes.DISPUTE_NOT_FOUND, message: 'Dispute not found' });

    const isBuyer = dispute.order.buyerId === userId;
    const isSeller = dispute.order.sellerId === userId;
    if (!isBuyer && !isSeller) {
      throw new ForbiddenException({ code: ErrorCodes.NOT_DISPUTE_PARTICIPANT, message: 'You are not a participant in this dispute' });
    }

    const openStatuses: string[] = [DisputeStatus.OPEN, DisputeStatus.WAITING_RESPONSE, DisputeStatus.ASSIGNED, DisputeStatus.UNDER_REVIEW];
    if (!openStatuses.includes(dispute.status)) {
      throw new BadRequestException({ code: 'DISPUTE_NOT_OPEN', message: 'Mutual resolution can only be proposed while the dispute is active' });
    }

    const MAX_PROPOSALS_PER_USER = 5;

    const proposal = await this.withSerializableRetry(() => this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM disputes WHERE id = ${dispute.id} FOR UPDATE`;
      const freshDispute = await tx.dispute.findUnique({
        where: { id: dispute.id },
        select: { status: true, order: { select: { status: true } } },
      });
      const openStatuses: DisputeStatus[] = [DisputeStatus.OPEN, DisputeStatus.WAITING_RESPONSE, DisputeStatus.ASSIGNED, DisputeStatus.UNDER_REVIEW];
      if (!freshDispute || !openStatuses.includes(freshDispute.status) || freshDispute.order.status !== OrderStatus.DISPUTED) {
        throw new ConflictException({ code: 'DISPUTE_STATE_CHANGED', message: 'Dispute or order state changed before proposal creation' });
      }

      const existingPending = await tx.mutualResolutionProposal.findFirst({
        where: { disputeId: dispute.id, status: 'PENDING' },
      });
      if (existingPending) {
        throw new BadRequestException({ code: 'PROPOSAL_ALREADY_PENDING', message: 'There is already a pending proposal. Please wait for a response or withdraw it first.' });
      }

      const activeProposalCount = await tx.mutualResolutionProposal.count({
        where: { disputeId: dispute.id, proposedBy: userId, status: { in: ['PENDING', 'ACCEPTED'] } },
      });
      if (activeProposalCount >= MAX_PROPOSALS_PER_USER) {
        throw new BadRequestException({ code: 'MAX_PROPOSALS_REACHED', message: `Maximum ${MAX_PROPOSALS_PER_USER} active proposals per user per dispute` });
      }

      return tx.mutualResolutionProposal.create({
        data: {
          disputeId: dispute.id,
          proposedBy: userId,
          proposerRole: isBuyer ? ActorType.BUYER : ActorType.SELLER,
          buyerPercent: dto.buyerPercent,
          sellerPercent: dto.sellerPercent,
          reason: normalizedReason,
        },
      });
    }), 'PROPOSE_MUTUAL_RESOLUTION');

    const counterpartId = isBuyer ? dispute.order.sellerId : dispute.order.buyerId;
    const proposerLabel = isBuyer ? 'Buyer' : 'Seller';
    /*
     * C-20: post-commit side effect — the proposal row is already durable when this runs. As a
     * bare `await` a transient notification failure rethrew, so the proposer saw a 500 for a
     * proposal that HAD been created; their retry then hit the `existingPending` guard and came
     * back PROPOSAL_ALREADY_PENDING. Two contradictory errors, and the only way out was to
     * withdraw a proposal the UI had never confirmed. Same shape as C-19 in `disputes.service.ts`;
     * demoted to the codebase's `silent-catch` idiom — the notification is best-effort, the
     * proposal is not.
     */
    this.runPostCommitBestEffort(() => this.prisma.notification.create({
      data: {
        notifId: generateNotifId(),
        userId: counterpartId,
        type: NotificationType.DISPUTE_SUBMITTED,
        category: getCategoryForType(NotificationType.DISPUTE_SUBMITTED),
        title: 'Mutual Resolution Proposed',
        body: `${proposerLabel} proposed a mutual resolution for order "${dispute.order.title || dispute.order.orderId}": ${dto.buyerPercent}% buyer / ${dto.sellerPercent}% seller.`,
        isRead: false,
      },
    }), 'PROPOSE_MUTUAL_RESOLUTION_NOTIFICATION');
    this.runRealtimeBestEffort(() => this.prisma.emitNotificationCreated({
      userId: counterpartId,
      title: 'Mutual Resolution Proposed',
      body: `${proposerLabel} proposed: ${dto.buyerPercent}% buyer / ${dto.sellerPercent}% seller.`,
      data: { type: 'DISPUTE_RESOLUTION', disputeId: dispute.id },
    }), 'PROPOSE_MUTUAL_RESOLUTION_REALTIME');

    return {
      proposalId: proposal.id,
      buyerPercent: proposal.buyerPercent,
      sellerPercent: proposal.sellerPercent,
      status: proposal.status,
    };
  }

  async respond(
    disputeId: string,
    proposalId: string,
    userId: string,
    action: 'ACCEPT' | 'REJECT',
    responseNote?: string,
  ): Promise<object> {
    const dispute = await this.prisma.dispute.findFirst({
      where: { OR: [{ id: disputeId }, { disputeId }] },
      include: {
        order: {
          select: {
            id: true,
            orderId: true,
            title: true,
            status: true,
            buyerId: true,
            sellerId: true,
            buyerPayAmount: true,
            sellerReceiveAmount: true,
            feeAmount: true,
            orderValue: true,
            isKahadePlus: true,
            completedAt: true,
          },
        },
      },
    });

    if (!dispute) throw new NotFoundException({ code: ErrorCodes.DISPUTE_NOT_FOUND, message: 'Dispute not found' });

    const isBuyer = dispute.order.buyerId === userId;
    const isSeller = dispute.order.sellerId === userId;
    if (!isBuyer && !isSeller) {
      throw new ForbiddenException({ code: ErrorCodes.NOT_DISPUTE_PARTICIPANT, message: 'You are not a participant' });
    }

    const proposal = await this.prisma.mutualResolutionProposal.findFirst({
      where: { id: proposalId, disputeId: dispute.id, status: 'PENDING' },
    });
    if (!proposal) throw new NotFoundException({ code: 'PROPOSAL_NOT_FOUND', message: 'Pending proposal not found' });

    if (proposal.proposedBy === userId) {
      throw new BadRequestException({ code: 'CANNOT_RESPOND_OWN', message: 'You cannot accept/reject your own proposal' });
    }

    const openStatuses: string[] = ['OPEN', 'WAITING_RESPONSE', 'ASSIGNED', 'UNDER_REVIEW'];
    if (!openStatuses.includes(dispute.status)) {
      throw new BadRequestException({ code: 'DISPUTE_NOT_ACTIVE', message: 'Dispute is no longer active for mutual resolution' });
    }

    if (dispute.order.status !== 'DISPUTED') {
      throw new BadRequestException({ code: 'ORDER_NOT_DISPUTED', message: 'Order is no longer in DISPUTED status' });
    }

    if (action === 'REJECT') {
      /*
       * C-04: guarded on `status: 'PENDING'`, not a blind write. The ACCEPT branch below runs a
       * long Serializable transaction with up to MAX_RETRIES attempts and exponential backoff, so
       * a REJECT issued concurrently can arrive *after* that transaction committed. An unguarded
       * update then stamped REJECTED over the terminal ACCEPTED state of a proposal that had
       * already split the escrow, resolved the dispute and completed the order — leaving the
       * ledger correct but the audit trail claiming the split was refused.
       */
      const rejected = await this.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
        await tx.$queryRaw`SELECT id FROM disputes WHERE id = ${dispute.id} FOR UPDATE`;
        const freshDispute = await tx.dispute.findUnique({
          where: { id: dispute.id },
          select: { status: true, order: { select: { status: true } } },
        });
        const activeStatuses: DisputeStatus[] = [DisputeStatus.OPEN, DisputeStatus.WAITING_RESPONSE, DisputeStatus.ASSIGNED, DisputeStatus.UNDER_REVIEW];
        if (!freshDispute || !activeStatuses.includes(freshDispute.status) || freshDispute.order.status !== OrderStatus.DISPUTED) {
          throw new ConflictException({ code: 'DISPUTE_STATE_CHANGED', message: 'Dispute or order state changed before rejection' });
        }
        return tx.mutualResolutionProposal.updateMany({
          where: { id: proposalId, disputeId: dispute.id, status: 'PENDING' },
          data: { status: 'REJECTED', respondedAt: new Date(), responseNote: responseNote?.trim() || null },
        });
      });
      if (rejected.count === 0) {
        throw new ConflictException({
          code: 'PROPOSAL_ALREADY_RESPONDED',
          message: 'Proposal has already been responded to',
        });
      }

      // C-20: post-commit — the guarded `updateMany` above already committed REJECTED. A bare
      // `await` here turned a transient notification failure into a 500 for a rejection that had
      // taken effect; the retry then hit the `count === 0` guard and returned
      // PROPOSAL_ALREADY_RESPONDED (409), leaving the responder unable to tell whether their
      // rejection landed.
      this.prisma.notification
        .create({
          data: {
            notifId: generateNotifId(),
            userId: proposal.proposedBy,
            type: NotificationType.DISPUTE_SUBMITTED,
            category: getCategoryForType(NotificationType.DISPUTE_SUBMITTED),
            title: 'Proposal Rejected',
            body: `Your mutual resolution proposal was rejected.${responseNote ? ` Reason: ${responseNote}` : ''}`,
            isRead: false,
          },
        })
        .catch((err) => this.logger.warn(`silent-catch: ${err instanceof Error ? err.message : String(err)}`));
      this.runRealtimeBestEffort(() => this.prisma.emitNotificationCreated({
        userId: proposal.proposedBy,
        title: 'Proposal Rejected',
        body: `Your mutual resolution proposal was rejected.`,
        data: { type: 'DISPUTE_RESOLUTION', disputeId: dispute.id },
      }), 'REJECT_MUTUAL_RESOLUTION_REALTIME');

      return { proposalId, status: 'REJECTED' };
    }

    const isPostCompletionDispute = dispute.order.completedAt !== null;
    const sellerReceiveAmount = dispute.order.sellerReceiveAmount;
    const platformFee = isPostCompletionDispute
      ? BigInt(0)
      : dispute.order.buyerPayAmount - sellerReceiveAmount;

    const buyerAmount = (sellerReceiveAmount * BigInt(proposal.buyerPercent)) / BigInt(100);
    const sellerAmount = sellerReceiveAmount - buyerAmount;

    // Redis-backed serials are not rolled back with PostgreSQL. Allocate once
    // before the retry loop so a serialization retry reuses the same ledger IDs
    // instead of burning a new sequence number on every attempt.
    const buyerTxSerial = buyerAmount > BigInt(0) ? await this.walletTxSerialService.getNext() : null;
    const sellerTxSerial = sellerAmount > BigInt(0) ? await this.walletTxSerialService.getNext() : null;
    const feeTxSerial = platformFee > BigInt(0) ? await this.walletTxSerialService.getNext() : null;

    let lastError: unknown = null;
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {

    await this.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      const freshProposal = await tx.mutualResolutionProposal.findFirst({
        where: { id: proposalId, status: 'PENDING' },
      });
      if (!freshProposal) throw new ConflictException({ code: 'PROPOSAL_ALREADY_RESPONDED', message: 'Proposal has already been responded to' });

      const freshDispute = await tx.dispute.findUnique({ where: { id: dispute.id }, select: { status: true } });
      const freshOrder = await tx.order.findUnique({ where: { id: dispute.orderId }, select: { status: true, completedAt: true } });
      const activeDisputeStatuses = ['OPEN', 'WAITING_RESPONSE', 'ASSIGNED', 'UNDER_REVIEW'];
      if (!freshDispute || !activeDisputeStatuses.includes(freshDispute.status)) {
        throw new ConflictException({ code: 'DISPUTE_STATE_CHANGED', message: 'Dispute state changed during processing' });
      }
      if (!freshOrder || freshOrder.status !== OrderStatus.DISPUTED) {
        throw new ConflictException({ code: 'ORDER_STATE_CHANGED', message: 'Order state changed during processing' });
      }

      await tx.mutualResolutionProposal.update({
        where: { id: proposalId },
        data: { status: 'ACCEPTED', respondedAt: new Date(), responseNote: responseNote?.trim() || null },
      });

      await tx.dispute.update({
        where: { id: dispute.id },
        data: { status: DisputeStatus.RESOLVED, resolvedAt: new Date() },
      });

      await tx.order.update({
        where: { id: dispute.orderId },
        data: {
          status: OrderStatus.COMPLETED,
          ...(freshOrder.completedAt ? {} : { completedAt: new Date() }),
        },
      });

      await tx.orderStatusHistory.create({
        data: {
          orderId: dispute.orderId,
          fromStatus: OrderStatus.DISPUTED,
          toStatus: OrderStatus.COMPLETED,
          changedBy: userId,
          changedByType: isBuyer ? ActorType.BUYER : ActorType.SELLER,
          reason: `Mutual resolution accepted: ${proposal.buyerPercent}% buyer / ${proposal.sellerPercent}% seller`,
        },
      });

      const order = await tx.order.findUnique({
        where: { id: dispute.orderId },
        include: {
          buyer: { select: { wallet: { select: { id: true, isLocked: true, escrowBalance: true, availableBalance: true, totalBalance: true, version: true } } } },
          seller: { select: { wallet: { select: { id: true, isLocked: true, escrowBalance: true, availableBalance: true, totalBalance: true, version: true } } } },
        },
      });

      const buyerWallet = order?.buyer?.wallet;
      const sellerWallet = order?.seller?.wallet;
      if (!buyerWallet) {
        this.logger.error(`Mutual resolution: buyer wallet missing for dispute ${disputeId}`);
        throw new BadRequestException({ code: ErrorCodes.NOT_FOUND, message: 'Buyer wallet not found. Cannot proceed with fund release.' });
      }
      if (!sellerWallet) {
        this.logger.error(`Mutual resolution: seller wallet missing for dispute ${disputeId}`);
        throw new BadRequestException({ code: ErrorCodes.NOT_FOUND, message: 'Seller wallet not found. Cannot proceed with fund release.' });
      }
      if (buyerWallet.isLocked) {
        this.logger.error(`Mutual resolution: buyer wallet ${buyerWallet.id} is locked for dispute ${disputeId}`);
        throw new BadRequestException({ code: 'WALLET_LOCKED', message: 'Buyer wallet is locked. Cannot proceed with fund release.' });
      }
      if (sellerWallet.isLocked) {
        this.logger.error(`Mutual resolution: seller wallet ${sellerWallet.id} is locked for dispute ${disputeId}`);
        throw new BadRequestException({ code: 'WALLET_LOCKED', message: 'Seller wallet is locked. Cannot proceed with fund release.' });
      }

      const escrowSourceWallet = isPostCompletionDispute ? sellerWallet : buyerWallet;

      const totalEscrowNeeded = buyerAmount + sellerAmount + platformFee;
      if (escrowSourceWallet.escrowBalance < totalEscrowNeeded) {
        const party = isPostCompletionDispute ? 'Seller' : 'Buyer';
        throw new BadRequestException({
          code: ErrorCodes.ESCROW_BALANCE_MISMATCH || 'ESCROW_BALANCE_MISMATCH',
          message: `${party} escrow balance (${escrowSourceWallet.escrowBalance}) is less than expected amount (${totalEscrowNeeded}). Manual investigation required.`,
        });
      }

      const [firstId, secondId] = [buyerWallet.id, sellerWallet.id].sort();
      await tx.$queryRaw`SELECT id FROM wallets WHERE id IN (${firstId}, ${secondId}) ORDER BY id FOR UPDATE`;

      if (isPostCompletionDispute) {
        if (buyerAmount > BigInt(0)) {
          const freshSellerForBuyer = await tx.wallet.findUnique({ where: { id: sellerWallet.id } });
          if (!freshSellerForBuyer) throw new ConflictException({ code: ErrorCodes.NOT_FOUND, message: 'Seller wallet disappeared during resolution' });
          const sellerDebit = await tx.wallet.updateMany({
            where: { id: sellerWallet.id, version: freshSellerForBuyer.version, escrowBalance: { gte: buyerAmount } },
            data: { escrowBalance: { decrement: buyerAmount }, totalBalance: { decrement: buyerAmount }, version: { increment: 1 } },
          });
          if (sellerDebit.count === 0) throw new ConflictException({ code: ErrorCodes.OPTIMISTIC_LOCK_CONFLICT, message: 'Concurrent wallet update during post-completion resolution' });

          const freshBuyerForRefund = await tx.wallet.findUnique({ where: { id: buyerWallet.id } });
          if (!freshBuyerForRefund) throw new ConflictException({ code: ErrorCodes.NOT_FOUND, message: 'Buyer wallet disappeared during resolution' });
          const buyerCredit = await tx.wallet.updateMany({
            where: { id: buyerWallet.id, version: freshBuyerForRefund.version },
            data: { availableBalance: { increment: buyerAmount }, totalBalance: { increment: buyerAmount }, version: { increment: 1 } },
          });
          if (buyerCredit.count === 0) throw new ConflictException({ code: ErrorCodes.OPTIMISTIC_LOCK_CONFLICT, message: 'Concurrent buyer wallet update during post-completion refund' });

          await tx.walletTransaction.create({
            data: {
              txId: generateWalletTxId(buyerTxSerial!),
              walletId: buyerWallet.id,
              type: WalletTransactionType.ORDER_REFUND,
              status: WalletTransactionStatus.SUCCESS,
              amount: buyerAmount,
              balanceBefore: freshBuyerForRefund.availableBalance,
              balanceAfter: freshBuyerForRefund.availableBalance + buyerAmount,
              orderId: dispute.orderId,
              description: `Mutual resolution: post-completion refund to buyer (${proposal.buyerPercent}%)`,
            },
          });
        }

        if (sellerAmount > BigInt(0)) {
          const freshSellerForRelease = await tx.wallet.findUnique({ where: { id: sellerWallet.id } });
          if (!freshSellerForRelease) throw new ConflictException({ code: ErrorCodes.NOT_FOUND, message: 'Seller wallet disappeared during resolution' });
          const sellerRelease = await tx.wallet.updateMany({
            where: { id: sellerWallet.id, version: freshSellerForRelease.version, escrowBalance: { gte: sellerAmount } },
            data: { escrowBalance: { decrement: sellerAmount }, availableBalance: { increment: sellerAmount }, version: { increment: 1 } },
          });
          if (sellerRelease.count === 0) throw new ConflictException({ code: ErrorCodes.OPTIMISTIC_LOCK_CONFLICT, message: 'Concurrent wallet update during post-completion seller release' });

          await tx.walletTransaction.create({
            data: {
              txId: generateWalletTxId(sellerTxSerial!),
              walletId: sellerWallet.id,
              type: WalletTransactionType.ORDER_RELEASE,
              status: WalletTransactionStatus.SUCCESS,
              amount: sellerAmount,
              balanceBefore: freshSellerForRelease.availableBalance,
              balanceAfter: freshSellerForRelease.availableBalance + sellerAmount,
              orderId: dispute.orderId,
              description: `Mutual resolution: post-completion release to seller (${proposal.sellerPercent}%)`,
            },
          });
        }
      } else {
        if (buyerAmount > BigInt(0)) {
          const freshBuyer = await tx.wallet.findUnique({ where: { id: buyerWallet.id } });
          if (!freshBuyer) throw new ConflictException({ code: ErrorCodes.NOT_FOUND, message: 'Buyer wallet not found' });
          const r = await tx.wallet.updateMany({
            where: { id: buyerWallet.id, version: freshBuyer.version, escrowBalance: { gte: buyerAmount } },
            data: { escrowBalance: { decrement: buyerAmount }, availableBalance: { increment: buyerAmount }, version: { increment: 1 } },
          });
          if (r.count === 0) throw new ConflictException({ code: ErrorCodes.OPTIMISTIC_LOCK_CONFLICT, message: 'Concurrent wallet update' });

          await tx.walletTransaction.create({
            data: {
              txId: generateWalletTxId(buyerTxSerial!),
              walletId: buyerWallet.id,
              type: WalletTransactionType.ORDER_REFUND,
              status: WalletTransactionStatus.SUCCESS,
              amount: buyerAmount,
              balanceBefore: freshBuyer.availableBalance,
              balanceAfter: freshBuyer.availableBalance + buyerAmount,
              orderId: dispute.orderId,
              description: `Mutual resolution: refund to buyer (${proposal.buyerPercent}%)`,
            },
          });
        }

        if (sellerAmount > BigInt(0)) {
          const freshBuyerForSeller = await tx.wallet.findUnique({ where: { id: buyerWallet.id } });
          if (!freshBuyerForSeller) throw new ConflictException({ code: ErrorCodes.NOT_FOUND, message: 'Buyer wallet not found' });

          const r2 = await tx.wallet.updateMany({
            where: { id: buyerWallet.id, version: freshBuyerForSeller.version, escrowBalance: { gte: sellerAmount } },
            data: { escrowBalance: { decrement: sellerAmount }, totalBalance: { decrement: sellerAmount }, version: { increment: 1 } },
          });
          if (r2.count === 0) throw new ConflictException({ code: ErrorCodes.OPTIMISTIC_LOCK_CONFLICT, message: 'Concurrent wallet update' });

          const freshSeller = await tx.wallet.findUnique({ where: { id: sellerWallet.id } });
          if (!freshSeller) throw new ConflictException({ code: ErrorCodes.NOT_FOUND, message: 'Seller wallet not found' });

          const r3 = await tx.wallet.updateMany({
            where: { id: freshSeller.id, version: freshSeller.version },
            data: { availableBalance: { increment: sellerAmount }, totalBalance: { increment: sellerAmount }, version: { increment: 1 } },
          });
          if (r3.count === 0) throw new ConflictException({ code: ErrorCodes.OPTIMISTIC_LOCK_CONFLICT, message: 'Concurrent wallet update' });

          await tx.walletTransaction.create({
            data: {
              txId: generateWalletTxId(sellerTxSerial!),
              walletId: sellerWallet.id,
              type: WalletTransactionType.ORDER_RELEASE,
              status: WalletTransactionStatus.SUCCESS,
              amount: sellerAmount,
              balanceBefore: freshSeller.availableBalance,
              balanceAfter: freshSeller.availableBalance + sellerAmount,
              orderId: dispute.orderId,
              description: `Mutual resolution: payment to seller (${proposal.sellerPercent}%)`,
            },
          });
        }

        if (platformFee > BigInt(0) && feeTxSerial !== null) {
          const freshBuyerForFee = await tx.wallet.findUnique({ where: { id: buyerWallet.id } });
          if (!freshBuyerForFee) throw new ConflictException({ code: ErrorCodes.NOT_FOUND, message: 'Buyer wallet not found for fee deduction' });
          const feeDeduct = await tx.wallet.updateMany({
            where: { id: buyerWallet.id, version: freshBuyerForFee.version, escrowBalance: { gte: platformFee } },
            data: { escrowBalance: { decrement: platformFee }, totalBalance: { decrement: platformFee }, version: { increment: 1 } },
          });
          if (feeDeduct.count === 0) throw new ConflictException({ code: ErrorCodes.OPTIMISTIC_LOCK_CONFLICT, message: 'Concurrent wallet update during fee deduction' });

          await tx.walletTransaction.create({
            data: {
              txId: generateWalletTxId(feeTxSerial),
              walletId: buyerWallet.id,
              type: WalletTransactionType.FEE_DEDUCT,
              status: WalletTransactionStatus.SUCCESS,
              amount: platformFee,
              balanceBefore: freshBuyerForFee.escrowBalance,
              balanceAfter: freshBuyerForFee.escrowBalance - platformFee,
              orderId: dispute.orderId,
              description: `Platform fee retained from mutual resolution for order ${dispute.order.orderId}`,
            },
          });
        }
      }

      if (dispute.order.isKahadePlus && dispute.order.feeAmount > BigInt(0) && !isPostCompletionDispute) {
        const activeSub = await tx.subscription.findFirst({
          where: {
            userId: dispute.order.buyerId,
            status: { in: [SubscriptionStatus.ACTIVE, SubscriptionStatus.CANCELLED] },
            currentPeriodEnd: { gt: new Date() },
          },
          select: { id: true, feeSavingsUsed: true, feeSavingsLimit: true },
        });
        if (activeSub && activeSub.feeSavingsUsed < activeSub.feeSavingsLimit) {
          const feeConfig = await this.feeCalculator.getFeeConfig();
          // Use the canonical helper so the savings reflect the same clamp
          // semantics ([Rp 5.000, Rp 250.000]) the buyer was actually charged
          // under.  The previous raw-rate calculation over-attributed savings
          // for orders above the Rp 250.000 cap.
          const savings = this.feeCalculator.getPlusSavingsSen(dispute.order.orderValue, feeConfig);
          if (savings > BigInt(0)) {
            await tx.$executeRaw`
              UPDATE "subscriptions"
              SET "feeSavingsUsed" = LEAST("feeSavingsUsed" + ${savings}::bigint, "feeSavingsLimit")
              WHERE "id" = ${activeSub.id}
                AND "feeSavingsUsed" < "feeSavingsLimit"
            `;
          }
        }
      }

    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });

        lastError = null;
        break;
      } catch (err: unknown) {
        lastError = err;
        if (!this.isRetryableDbError(err) || attempt === MAX_RETRIES) {
          this.logger.error(`MUTUAL_RESOLUTION_TX_FAILED disputeId=${disputeId} attempt=${attempt}/${MAX_RETRIES}`, err instanceof Error ? err.stack : String(err));
          break;
        }
        this.logger.warn(`MUTUAL_RESOLUTION_TX_RETRY disputeId=${disputeId} attempt=${attempt}/${MAX_RETRIES}`);
        const jitter = randomInt(0, 50);
        await new Promise(resolve => setTimeout(resolve, 100 * Math.pow(2, attempt - 1) + jitter));
      }
    }
    if (lastError) throw lastError;

    for (const recipientId of [dispute.order.buyerId, dispute.order.sellerId]) {
      this.runPostCommitBestEffort(() => this.prisma.notification.create({
        data: {
          notifId: generateNotifId(),
          userId: recipientId,
          type: NotificationType.ORDER_COMPLETED,
          category: getCategoryForType(NotificationType.ORDER_COMPLETED),
          title: 'Dispute Resolved',
          body: `Dispute for order "${dispute.order.title || dispute.order.orderId}" has been resolved by mutual agreement (${proposal.buyerPercent}% buyer / ${proposal.sellerPercent}% seller).`,
          isRead: false,
        },
      }), 'ACCEPT_MUTUAL_RESOLUTION_NOTIFICATION');
      this.runRealtimeBestEffort(() => this.prisma.emitNotificationCreated({
        userId: recipientId,
        title: 'Dispute Resolved',
        body: `Mutual resolution accepted: ${proposal.buyerPercent}% buyer / ${proposal.sellerPercent}% seller.`,
        data: { type: 'DISPUTE_RESOLVED', disputeId: dispute.id },
      }), 'ACCEPT_MUTUAL_RESOLUTION_REALTIME');
    }

    return { proposalId, status: 'ACCEPTED', buyerPercent: proposal.buyerPercent, sellerPercent: proposal.sellerPercent };
  }

  private runPostCommitBestEffort(task: () => Promise<unknown> | void, label: string): void {
    void Promise.resolve().then(task).catch((error: unknown) => {
      this.logger.warn(`${label} post-commit side effect failed: ${error instanceof Error ? error.message : String(error)}`);
    });
  }

  private runRealtimeBestEffort(task: () => void, label: string): void {
    try {
      task();
    } catch (error: unknown) {
      this.logger.warn(`${label} realtime side effect failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async withSerializableRetry<T>(operation: () => Promise<T>, label: string): Promise<T> {
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        return await operation();
      } catch (error: unknown) {
        if (!this.isRetryableDbError(error) || attempt === MAX_RETRIES) throw error;
        this.logger.warn(`${label}_RETRY attempt=${attempt}/${MAX_RETRIES}`);
        await new Promise(resolve => setTimeout(resolve, 100 * attempt + randomInt(0, 50)));
      }
    }
    throw new Error(`${label} exhausted retry loop`);
  }

  private isRetryableDbError(err: unknown): boolean {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2034') return true;
    if (err instanceof Prisma.PrismaClientUnknownRequestError) {
      const msg = err.message.toLowerCase();
      if (msg.includes('40001') || msg.includes('serialization') || msg.includes('40p01') || msg.includes('deadlock')) return true;
    }
    return false;
  }

  async getProposals(disputeId: string, userId: string, page: number = 1, limit: number = 20): Promise<object> {
    const dispute = await this.prisma.dispute.findFirst({
      where: { OR: [{ id: disputeId }, { disputeId }] },
      include: { order: { select: { buyerId: true, sellerId: true } } },
    });

    if (!dispute) throw new NotFoundException({ code: ErrorCodes.DISPUTE_NOT_FOUND, message: 'Dispute not found' });

    if (dispute.order.buyerId !== userId && dispute.order.sellerId !== userId) {
      throw new ForbiddenException({ code: ErrorCodes.NOT_DISPUTE_PARTICIPANT, message: 'Not a participant' });
    }

    const safePage = Math.max(1, Math.trunc(Number.isFinite(page) ? page : 1));
    const safeLimit = Math.min(50, Math.max(1, Math.trunc(Number.isFinite(limit) ? limit : 20)));
    const skip = (safePage - 1) * safeLimit;

    const proposals = await this.prisma.mutualResolutionProposal.findMany({
      where: { disputeId: dispute.id },
      orderBy: { createdAt: 'desc' },
      skip,
      take: safeLimit,
      include: { proposer: { select: { userId: true, fullName: true, username: true } } },
    });

    const data = proposals.map((p) => ({
      id: p.id,
      proposedBy: p.proposer.userId,
      proposerName: p.proposer.fullName || p.proposer.username,
      proposerRole: p.proposerRole,
      buyerPercent: p.buyerPercent,
      sellerPercent: p.sellerPercent,
      reason: p.reason,
      status: p.status,
      responseNote: p.responseNote,
      respondedAt: p.respondedAt,
      createdAt: p.createdAt,
    }));
    const total = await this.prisma.mutualResolutionProposal.count({ where: { disputeId: dispute.id } });
    return { data, total, page: safePage, limit: safeLimit, totalPages: Math.ceil(total / safeLimit), hasNext: safePage * safeLimit < total, hasPrev: safePage > 1 };
  }

  async withdraw(disputeId: string, proposalId: string, userId: string): Promise<{ status: string }> {
    const dispute = await this.prisma.dispute.findFirst({
      where: { OR: [{ id: disputeId }, { disputeId }] },
      include: { order: { select: { status: true } } },
    });
    if (!dispute) throw new NotFoundException({ code: ErrorCodes.DISPUTE_NOT_FOUND, message: 'Dispute not found' });

    const terminalStatuses = ['RESOLVED', 'CANCELLED'];
    if (terminalStatuses.includes(dispute.status) || dispute.order.status !== OrderStatus.DISPUTED) {
      throw new BadRequestException({ code: 'DISPUTE_NOT_ACTIVE', message: 'Cannot withdraw proposals unless the dispute and linked order remain active' });
    }

    const proposal = await this.prisma.mutualResolutionProposal.findFirst({
      where: { id: proposalId, disputeId: dispute.id, status: 'PENDING', proposedBy: userId },
    });
    if (!proposal) throw new NotFoundException({ code: 'PROPOSAL_NOT_FOUND', message: 'Pending proposal not found or you are not the proposer' });

    /*
     * C-04: same issue as REJECT above. The withdrawer read `status: 'PENDING'` on :567, but
     * that was outside any transaction and minutes may have passed. A blind update stamping
     * EXPIRED/"Withdrawn by proposer" over the terminal ACCEPTED state of a proposal that
     * already split the escrow leaves the ledger correct but the audit trail wrong.
     */
    const withdrawn = await this.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      await tx.$queryRaw`SELECT id FROM disputes WHERE id = ${dispute.id} FOR UPDATE`;
      const freshDispute = await tx.dispute.findUnique({
        where: { id: dispute.id },
        select: { status: true, order: { select: { status: true } } },
      });
      if (!freshDispute || terminalStatuses.includes(freshDispute.status) || freshDispute.order.status !== OrderStatus.DISPUTED) {
        throw new ConflictException({ code: 'DISPUTE_STATE_CHANGED', message: 'Dispute or order state changed before withdrawal' });
      }
      return tx.mutualResolutionProposal.updateMany({
        where: { id: proposalId, disputeId: dispute.id, proposedBy: userId, status: 'PENDING' },
        data: { status: 'EXPIRED', respondedAt: new Date(), responseNote: 'Withdrawn by proposer' },
      });
    });
    if (withdrawn.count === 0) {
      throw new ConflictException({
        code: 'PROPOSAL_ALREADY_RESPONDED',
        message: 'Proposal has already been responded to',
      });
    }

    return { status: 'WITHDRAWN' };
  }
}
