"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
var MutualResolutionService_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.MutualResolutionService = void 0;
const common_1 = require("@nestjs/common");
const crypto_1 = require("crypto");
const client_1 = require("@prisma/client");
const prisma_service_1 = require("../../prisma/prisma.service");
const wallet_tx_serial_service_1 = require("../../common/services/wallet-tx-serial.service");
const fee_calculator_service_1 = require("../orders/fee-calculator.service");
const id_generator_util_1 = require("../../common/utils/id-generator.util");
const notification_category_map_1 = require("../notifications/notification-category.map");
const ErrorCodes = __importStar(require("../../common/constants/error-codes"));
const MAX_RETRIES = 3;
let MutualResolutionService = MutualResolutionService_1 = class MutualResolutionService {
    constructor(prisma, walletTxSerialService, feeCalculator) {
        this.prisma = prisma;
        this.walletTxSerialService = walletTxSerialService;
        this.feeCalculator = feeCalculator;
        this.logger = new common_1.Logger(MutualResolutionService_1.name);
    }
    async propose(disputeId, userId, dto) {
        if (!Number.isInteger(dto.buyerPercent) || !Number.isInteger(dto.sellerPercent)
            || dto.buyerPercent < 0 || dto.sellerPercent < 0
            || dto.buyerPercent > 100 || dto.sellerPercent > 100
            || dto.buyerPercent + dto.sellerPercent !== 100) {
            throw new common_1.BadRequestException({ code: 'VALIDATION_ERROR', message: 'Percentages must be integers from 0 to 100 and total 100' });
        }
        const normalizedReason = typeof dto.reason === 'string' ? dto.reason.trim() : '';
        if (normalizedReason.length < 10 || normalizedReason.length > 2000) {
            throw new common_1.BadRequestException({ code: 'VALIDATION_ERROR', message: 'Reason must contain 10–2000 non-whitespace characters' });
        }
        const dispute = await this.prisma.dispute.findFirst({
            where: { OR: [{ id: disputeId }, { disputeId }] },
            include: { order: { select: { buyerId: true, sellerId: true, orderId: true, title: true, status: true } } },
        });
        if (!dispute)
            throw new common_1.NotFoundException({ code: ErrorCodes.DISPUTE_NOT_FOUND, message: 'Dispute not found' });
        const isBuyer = dispute.order.buyerId === userId;
        const isSeller = dispute.order.sellerId === userId;
        if (!isBuyer && !isSeller) {
            throw new common_1.ForbiddenException({ code: ErrorCodes.NOT_DISPUTE_PARTICIPANT, message: 'You are not a participant in this dispute' });
        }
        const openStatuses = [client_1.DisputeStatus.OPEN, client_1.DisputeStatus.WAITING_RESPONSE, client_1.DisputeStatus.ASSIGNED, client_1.DisputeStatus.UNDER_REVIEW];
        if (!openStatuses.includes(dispute.status)) {
            throw new common_1.BadRequestException({ code: 'DISPUTE_NOT_OPEN', message: 'Mutual resolution can only be proposed while the dispute is active' });
        }
        const MAX_PROPOSALS_PER_USER = 5;
        const proposal = await this.withSerializableRetry(() => this.prisma.$transaction(async (tx) => {
            await tx.$queryRaw `SELECT id FROM disputes WHERE id = ${dispute.id} FOR UPDATE`;
            const freshDispute = await tx.dispute.findUnique({
                where: { id: dispute.id },
                select: { status: true, order: { select: { status: true } } },
            });
            const openStatuses = [client_1.DisputeStatus.OPEN, client_1.DisputeStatus.WAITING_RESPONSE, client_1.DisputeStatus.ASSIGNED, client_1.DisputeStatus.UNDER_REVIEW];
            if (!freshDispute || !openStatuses.includes(freshDispute.status) || freshDispute.order.status !== client_1.OrderStatus.DISPUTED) {
                throw new common_1.ConflictException({ code: 'DISPUTE_STATE_CHANGED', message: 'Dispute or order state changed before proposal creation' });
            }
            const existingPending = await tx.mutualResolutionProposal.findFirst({
                where: { disputeId: dispute.id, status: 'PENDING' },
            });
            if (existingPending) {
                throw new common_1.BadRequestException({ code: 'PROPOSAL_ALREADY_PENDING', message: 'There is already a pending proposal. Please wait for a response or withdraw it first.' });
            }
            const activeProposalCount = await tx.mutualResolutionProposal.count({
                where: { disputeId: dispute.id, proposedBy: userId, status: { in: ['PENDING', 'ACCEPTED'] } },
            });
            if (activeProposalCount >= MAX_PROPOSALS_PER_USER) {
                throw new common_1.BadRequestException({ code: 'MAX_PROPOSALS_REACHED', message: `Maximum ${MAX_PROPOSALS_PER_USER} active proposals per user per dispute` });
            }
            return tx.mutualResolutionProposal.create({
                data: {
                    disputeId: dispute.id,
                    proposedBy: userId,
                    proposerRole: isBuyer ? client_1.ActorType.BUYER : client_1.ActorType.SELLER,
                    buyerPercent: dto.buyerPercent,
                    sellerPercent: dto.sellerPercent,
                    reason: normalizedReason,
                },
            });
        }), 'PROPOSE_MUTUAL_RESOLUTION');
        const counterpartId = isBuyer ? dispute.order.sellerId : dispute.order.buyerId;
        const proposerLabel = isBuyer ? 'Buyer' : 'Seller';
        this.runPostCommitBestEffort(() => this.prisma.notification.create({
            data: {
                notifId: (0, id_generator_util_1.generateNotifId)(),
                userId: counterpartId,
                type: client_1.NotificationType.DISPUTE_SUBMITTED,
                category: (0, notification_category_map_1.getCategoryForType)(client_1.NotificationType.DISPUTE_SUBMITTED),
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
    async respond(disputeId, proposalId, userId, action, responseNote) {
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
        if (!dispute)
            throw new common_1.NotFoundException({ code: ErrorCodes.DISPUTE_NOT_FOUND, message: 'Dispute not found' });
        const isBuyer = dispute.order.buyerId === userId;
        const isSeller = dispute.order.sellerId === userId;
        if (!isBuyer && !isSeller) {
            throw new common_1.ForbiddenException({ code: ErrorCodes.NOT_DISPUTE_PARTICIPANT, message: 'You are not a participant' });
        }
        const proposal = await this.prisma.mutualResolutionProposal.findFirst({
            where: { id: proposalId, disputeId: dispute.id, status: 'PENDING' },
        });
        if (!proposal)
            throw new common_1.NotFoundException({ code: 'PROPOSAL_NOT_FOUND', message: 'Pending proposal not found' });
        if (proposal.proposedBy === userId) {
            throw new common_1.BadRequestException({ code: 'CANNOT_RESPOND_OWN', message: 'You cannot accept/reject your own proposal' });
        }
        const openStatuses = ['OPEN', 'WAITING_RESPONSE', 'ASSIGNED', 'UNDER_REVIEW'];
        if (!openStatuses.includes(dispute.status)) {
            throw new common_1.BadRequestException({ code: 'DISPUTE_NOT_ACTIVE', message: 'Dispute is no longer active for mutual resolution' });
        }
        if (dispute.order.status !== 'DISPUTED') {
            throw new common_1.BadRequestException({ code: 'ORDER_NOT_DISPUTED', message: 'Order is no longer in DISPUTED status' });
        }
        if (action === 'REJECT') {
            const rejected = await this.prisma.$transaction(async (tx) => {
                await tx.$queryRaw `SELECT id FROM disputes WHERE id = ${dispute.id} FOR UPDATE`;
                const freshDispute = await tx.dispute.findUnique({
                    where: { id: dispute.id },
                    select: { status: true, order: { select: { status: true } } },
                });
                const activeStatuses = [client_1.DisputeStatus.OPEN, client_1.DisputeStatus.WAITING_RESPONSE, client_1.DisputeStatus.ASSIGNED, client_1.DisputeStatus.UNDER_REVIEW];
                if (!freshDispute || !activeStatuses.includes(freshDispute.status) || freshDispute.order.status !== client_1.OrderStatus.DISPUTED) {
                    throw new common_1.ConflictException({ code: 'DISPUTE_STATE_CHANGED', message: 'Dispute or order state changed before rejection' });
                }
                return tx.mutualResolutionProposal.updateMany({
                    where: { id: proposalId, disputeId: dispute.id, status: 'PENDING' },
                    data: { status: 'REJECTED', respondedAt: new Date(), responseNote: responseNote?.trim() || null },
                });
            });
            if (rejected.count === 0) {
                throw new common_1.ConflictException({
                    code: 'PROPOSAL_ALREADY_RESPONDED',
                    message: 'Proposal has already been responded to',
                });
            }
            this.prisma.notification
                .create({
                data: {
                    notifId: (0, id_generator_util_1.generateNotifId)(),
                    userId: proposal.proposedBy,
                    type: client_1.NotificationType.DISPUTE_SUBMITTED,
                    category: (0, notification_category_map_1.getCategoryForType)(client_1.NotificationType.DISPUTE_SUBMITTED),
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
        const buyerTxSerial = buyerAmount > BigInt(0) ? await this.walletTxSerialService.getNext() : null;
        const sellerTxSerial = sellerAmount > BigInt(0) ? await this.walletTxSerialService.getNext() : null;
        const feeTxSerial = platformFee > BigInt(0) ? await this.walletTxSerialService.getNext() : null;
        let lastError = null;
        for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
            try {
                await this.prisma.$transaction(async (tx) => {
                    const freshProposal = await tx.mutualResolutionProposal.findFirst({
                        where: { id: proposalId, status: 'PENDING' },
                    });
                    if (!freshProposal)
                        throw new common_1.ConflictException({ code: 'PROPOSAL_ALREADY_RESPONDED', message: 'Proposal has already been responded to' });
                    const freshDispute = await tx.dispute.findUnique({ where: { id: dispute.id }, select: { status: true } });
                    const freshOrder = await tx.order.findUnique({ where: { id: dispute.orderId }, select: { status: true, completedAt: true } });
                    const activeDisputeStatuses = ['OPEN', 'WAITING_RESPONSE', 'ASSIGNED', 'UNDER_REVIEW'];
                    if (!freshDispute || !activeDisputeStatuses.includes(freshDispute.status)) {
                        throw new common_1.ConflictException({ code: 'DISPUTE_STATE_CHANGED', message: 'Dispute state changed during processing' });
                    }
                    if (!freshOrder || freshOrder.status !== client_1.OrderStatus.DISPUTED) {
                        throw new common_1.ConflictException({ code: 'ORDER_STATE_CHANGED', message: 'Order state changed during processing' });
                    }
                    await tx.mutualResolutionProposal.update({
                        where: { id: proposalId },
                        data: { status: 'ACCEPTED', respondedAt: new Date(), responseNote: responseNote?.trim() || null },
                    });
                    await tx.dispute.update({
                        where: { id: dispute.id },
                        data: { status: client_1.DisputeStatus.RESOLVED, resolvedAt: new Date() },
                    });
                    await tx.order.update({
                        where: { id: dispute.orderId },
                        data: {
                            status: client_1.OrderStatus.COMPLETED,
                            ...(freshOrder.completedAt ? {} : { completedAt: new Date() }),
                        },
                    });
                    await tx.orderStatusHistory.create({
                        data: {
                            orderId: dispute.orderId,
                            fromStatus: client_1.OrderStatus.DISPUTED,
                            toStatus: client_1.OrderStatus.COMPLETED,
                            changedBy: userId,
                            changedByType: isBuyer ? client_1.ActorType.BUYER : client_1.ActorType.SELLER,
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
                        throw new common_1.BadRequestException({ code: ErrorCodes.NOT_FOUND, message: 'Buyer wallet not found. Cannot proceed with fund release.' });
                    }
                    if (!sellerWallet) {
                        this.logger.error(`Mutual resolution: seller wallet missing for dispute ${disputeId}`);
                        throw new common_1.BadRequestException({ code: ErrorCodes.NOT_FOUND, message: 'Seller wallet not found. Cannot proceed with fund release.' });
                    }
                    if (buyerWallet.isLocked) {
                        this.logger.error(`Mutual resolution: buyer wallet ${buyerWallet.id} is locked for dispute ${disputeId}`);
                        throw new common_1.BadRequestException({ code: 'WALLET_LOCKED', message: 'Buyer wallet is locked. Cannot proceed with fund release.' });
                    }
                    if (sellerWallet.isLocked) {
                        this.logger.error(`Mutual resolution: seller wallet ${sellerWallet.id} is locked for dispute ${disputeId}`);
                        throw new common_1.BadRequestException({ code: 'WALLET_LOCKED', message: 'Seller wallet is locked. Cannot proceed with fund release.' });
                    }
                    const escrowSourceWallet = isPostCompletionDispute ? sellerWallet : buyerWallet;
                    const totalEscrowNeeded = buyerAmount + sellerAmount + platformFee;
                    if (escrowSourceWallet.escrowBalance < totalEscrowNeeded) {
                        const party = isPostCompletionDispute ? 'Seller' : 'Buyer';
                        throw new common_1.BadRequestException({
                            code: ErrorCodes.ESCROW_BALANCE_MISMATCH || 'ESCROW_BALANCE_MISMATCH',
                            message: `${party} escrow balance (${escrowSourceWallet.escrowBalance}) is less than expected amount (${totalEscrowNeeded}). Manual investigation required.`,
                        });
                    }
                    const [firstId, secondId] = [buyerWallet.id, sellerWallet.id].sort();
                    await tx.$queryRaw `SELECT id FROM wallets WHERE id IN (${firstId}, ${secondId}) ORDER BY id FOR UPDATE`;
                    if (isPostCompletionDispute) {
                        if (buyerAmount > BigInt(0)) {
                            const freshSellerForBuyer = await tx.wallet.findUnique({ where: { id: sellerWallet.id } });
                            if (!freshSellerForBuyer)
                                throw new common_1.ConflictException({ code: ErrorCodes.NOT_FOUND, message: 'Seller wallet disappeared during resolution' });
                            const sellerDebit = await tx.wallet.updateMany({
                                where: { id: sellerWallet.id, version: freshSellerForBuyer.version, escrowBalance: { gte: buyerAmount } },
                                data: { escrowBalance: { decrement: buyerAmount }, totalBalance: { decrement: buyerAmount }, version: { increment: 1 } },
                            });
                            if (sellerDebit.count === 0)
                                throw new common_1.ConflictException({ code: ErrorCodes.OPTIMISTIC_LOCK_CONFLICT, message: 'Concurrent wallet update during post-completion resolution' });
                            const freshBuyerForRefund = await tx.wallet.findUnique({ where: { id: buyerWallet.id } });
                            if (!freshBuyerForRefund)
                                throw new common_1.ConflictException({ code: ErrorCodes.NOT_FOUND, message: 'Buyer wallet disappeared during resolution' });
                            const buyerCredit = await tx.wallet.updateMany({
                                where: { id: buyerWallet.id, version: freshBuyerForRefund.version },
                                data: { availableBalance: { increment: buyerAmount }, totalBalance: { increment: buyerAmount }, version: { increment: 1 } },
                            });
                            if (buyerCredit.count === 0)
                                throw new common_1.ConflictException({ code: ErrorCodes.OPTIMISTIC_LOCK_CONFLICT, message: 'Concurrent buyer wallet update during post-completion refund' });
                            await tx.walletTransaction.create({
                                data: {
                                    txId: (0, id_generator_util_1.generateWalletTxId)(buyerTxSerial),
                                    walletId: buyerWallet.id,
                                    type: client_1.WalletTransactionType.ORDER_REFUND,
                                    status: client_1.WalletTransactionStatus.SUCCESS,
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
                            if (!freshSellerForRelease)
                                throw new common_1.ConflictException({ code: ErrorCodes.NOT_FOUND, message: 'Seller wallet disappeared during resolution' });
                            const sellerRelease = await tx.wallet.updateMany({
                                where: { id: sellerWallet.id, version: freshSellerForRelease.version, escrowBalance: { gte: sellerAmount } },
                                data: { escrowBalance: { decrement: sellerAmount }, availableBalance: { increment: sellerAmount }, version: { increment: 1 } },
                            });
                            if (sellerRelease.count === 0)
                                throw new common_1.ConflictException({ code: ErrorCodes.OPTIMISTIC_LOCK_CONFLICT, message: 'Concurrent wallet update during post-completion seller release' });
                            await tx.walletTransaction.create({
                                data: {
                                    txId: (0, id_generator_util_1.generateWalletTxId)(sellerTxSerial),
                                    walletId: sellerWallet.id,
                                    type: client_1.WalletTransactionType.ORDER_RELEASE,
                                    status: client_1.WalletTransactionStatus.SUCCESS,
                                    amount: sellerAmount,
                                    balanceBefore: freshSellerForRelease.availableBalance,
                                    balanceAfter: freshSellerForRelease.availableBalance + sellerAmount,
                                    orderId: dispute.orderId,
                                    description: `Mutual resolution: post-completion release to seller (${proposal.sellerPercent}%)`,
                                },
                            });
                        }
                    }
                    else {
                        if (buyerAmount > BigInt(0)) {
                            const freshBuyer = await tx.wallet.findUnique({ where: { id: buyerWallet.id } });
                            if (!freshBuyer)
                                throw new common_1.ConflictException({ code: ErrorCodes.NOT_FOUND, message: 'Buyer wallet not found' });
                            const r = await tx.wallet.updateMany({
                                where: { id: buyerWallet.id, version: freshBuyer.version, escrowBalance: { gte: buyerAmount } },
                                data: { escrowBalance: { decrement: buyerAmount }, availableBalance: { increment: buyerAmount }, version: { increment: 1 } },
                            });
                            if (r.count === 0)
                                throw new common_1.ConflictException({ code: ErrorCodes.OPTIMISTIC_LOCK_CONFLICT, message: 'Concurrent wallet update' });
                            await tx.walletTransaction.create({
                                data: {
                                    txId: (0, id_generator_util_1.generateWalletTxId)(buyerTxSerial),
                                    walletId: buyerWallet.id,
                                    type: client_1.WalletTransactionType.ORDER_REFUND,
                                    status: client_1.WalletTransactionStatus.SUCCESS,
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
                            if (!freshBuyerForSeller)
                                throw new common_1.ConflictException({ code: ErrorCodes.NOT_FOUND, message: 'Buyer wallet not found' });
                            const r2 = await tx.wallet.updateMany({
                                where: { id: buyerWallet.id, version: freshBuyerForSeller.version, escrowBalance: { gte: sellerAmount } },
                                data: { escrowBalance: { decrement: sellerAmount }, totalBalance: { decrement: sellerAmount }, version: { increment: 1 } },
                            });
                            if (r2.count === 0)
                                throw new common_1.ConflictException({ code: ErrorCodes.OPTIMISTIC_LOCK_CONFLICT, message: 'Concurrent wallet update' });
                            const freshSeller = await tx.wallet.findUnique({ where: { id: sellerWallet.id } });
                            if (!freshSeller)
                                throw new common_1.ConflictException({ code: ErrorCodes.NOT_FOUND, message: 'Seller wallet not found' });
                            const r3 = await tx.wallet.updateMany({
                                where: { id: freshSeller.id, version: freshSeller.version },
                                data: { availableBalance: { increment: sellerAmount }, totalBalance: { increment: sellerAmount }, version: { increment: 1 } },
                            });
                            if (r3.count === 0)
                                throw new common_1.ConflictException({ code: ErrorCodes.OPTIMISTIC_LOCK_CONFLICT, message: 'Concurrent wallet update' });
                            await tx.walletTransaction.create({
                                data: {
                                    txId: (0, id_generator_util_1.generateWalletTxId)(sellerTxSerial),
                                    walletId: sellerWallet.id,
                                    type: client_1.WalletTransactionType.ORDER_RELEASE,
                                    status: client_1.WalletTransactionStatus.SUCCESS,
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
                            if (!freshBuyerForFee)
                                throw new common_1.ConflictException({ code: ErrorCodes.NOT_FOUND, message: 'Buyer wallet not found for fee deduction' });
                            const feeDeduct = await tx.wallet.updateMany({
                                where: { id: buyerWallet.id, version: freshBuyerForFee.version, escrowBalance: { gte: platformFee } },
                                data: { escrowBalance: { decrement: platformFee }, totalBalance: { decrement: platformFee }, version: { increment: 1 } },
                            });
                            if (feeDeduct.count === 0)
                                throw new common_1.ConflictException({ code: ErrorCodes.OPTIMISTIC_LOCK_CONFLICT, message: 'Concurrent wallet update during fee deduction' });
                            await tx.walletTransaction.create({
                                data: {
                                    txId: (0, id_generator_util_1.generateWalletTxId)(feeTxSerial),
                                    walletId: buyerWallet.id,
                                    type: client_1.WalletTransactionType.FEE_DEDUCT,
                                    status: client_1.WalletTransactionStatus.SUCCESS,
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
                                status: { in: [client_1.SubscriptionStatus.ACTIVE, client_1.SubscriptionStatus.CANCELLED] },
                                currentPeriodEnd: { gt: new Date() },
                            },
                            select: { id: true, feeSavingsUsed: true, feeSavingsLimit: true },
                        });
                        if (activeSub && activeSub.feeSavingsUsed < activeSub.feeSavingsLimit) {
                            const feeConfig = await this.feeCalculator.getFeeConfig();
                            const savings = this.feeCalculator.getPlusSavingsSen(dispute.order.orderValue, feeConfig);
                            if (savings > BigInt(0)) {
                                await tx.$executeRaw `
              UPDATE "subscriptions"
              SET "feeSavingsUsed" = LEAST("feeSavingsUsed" + ${savings}::bigint, "feeSavingsLimit")
              WHERE "id" = ${activeSub.id}
                AND "feeSavingsUsed" < "feeSavingsLimit"
            `;
                            }
                        }
                    }
                }, { isolationLevel: client_1.Prisma.TransactionIsolationLevel.Serializable });
                lastError = null;
                break;
            }
            catch (err) {
                lastError = err;
                if (!this.isRetryableDbError(err) || attempt === MAX_RETRIES) {
                    this.logger.error(`MUTUAL_RESOLUTION_TX_FAILED disputeId=${disputeId} attempt=${attempt}/${MAX_RETRIES}`, err instanceof Error ? err.stack : String(err));
                    break;
                }
                this.logger.warn(`MUTUAL_RESOLUTION_TX_RETRY disputeId=${disputeId} attempt=${attempt}/${MAX_RETRIES}`);
                const jitter = (0, crypto_1.randomInt)(0, 50);
                await new Promise(resolve => setTimeout(resolve, 100 * Math.pow(2, attempt - 1) + jitter));
            }
        }
        if (lastError)
            throw lastError;
        for (const recipientId of [dispute.order.buyerId, dispute.order.sellerId]) {
            this.runPostCommitBestEffort(() => this.prisma.notification.create({
                data: {
                    notifId: (0, id_generator_util_1.generateNotifId)(),
                    userId: recipientId,
                    type: client_1.NotificationType.ORDER_COMPLETED,
                    category: (0, notification_category_map_1.getCategoryForType)(client_1.NotificationType.ORDER_COMPLETED),
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
    runPostCommitBestEffort(task, label) {
        void Promise.resolve().then(task).catch((error) => {
            this.logger.warn(`${label} post-commit side effect failed: ${error instanceof Error ? error.message : String(error)}`);
        });
    }
    runRealtimeBestEffort(task, label) {
        try {
            task();
        }
        catch (error) {
            this.logger.warn(`${label} realtime side effect failed: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    async withSerializableRetry(operation, label) {
        for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
            try {
                return await operation();
            }
            catch (error) {
                if (!this.isRetryableDbError(error) || attempt === MAX_RETRIES)
                    throw error;
                this.logger.warn(`${label}_RETRY attempt=${attempt}/${MAX_RETRIES}`);
                await new Promise(resolve => setTimeout(resolve, 100 * attempt + (0, crypto_1.randomInt)(0, 50)));
            }
        }
        throw new Error(`${label} exhausted retry loop`);
    }
    isRetryableDbError(err) {
        if (err instanceof client_1.Prisma.PrismaClientKnownRequestError && err.code === 'P2034')
            return true;
        if (err instanceof client_1.Prisma.PrismaClientUnknownRequestError) {
            const msg = err.message.toLowerCase();
            if (msg.includes('40001') || msg.includes('serialization') || msg.includes('40p01') || msg.includes('deadlock'))
                return true;
        }
        return false;
    }
    async getProposals(disputeId, userId, page = 1, limit = 20) {
        const dispute = await this.prisma.dispute.findFirst({
            where: { OR: [{ id: disputeId }, { disputeId }] },
            include: { order: { select: { buyerId: true, sellerId: true } } },
        });
        if (!dispute)
            throw new common_1.NotFoundException({ code: ErrorCodes.DISPUTE_NOT_FOUND, message: 'Dispute not found' });
        if (dispute.order.buyerId !== userId && dispute.order.sellerId !== userId) {
            throw new common_1.ForbiddenException({ code: ErrorCodes.NOT_DISPUTE_PARTICIPANT, message: 'Not a participant' });
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
    async withdraw(disputeId, proposalId, userId) {
        const dispute = await this.prisma.dispute.findFirst({
            where: { OR: [{ id: disputeId }, { disputeId }] },
            include: { order: { select: { status: true } } },
        });
        if (!dispute)
            throw new common_1.NotFoundException({ code: ErrorCodes.DISPUTE_NOT_FOUND, message: 'Dispute not found' });
        const terminalStatuses = ['RESOLVED', 'CANCELLED'];
        if (terminalStatuses.includes(dispute.status) || dispute.order.status !== client_1.OrderStatus.DISPUTED) {
            throw new common_1.BadRequestException({ code: 'DISPUTE_NOT_ACTIVE', message: 'Cannot withdraw proposals unless the dispute and linked order remain active' });
        }
        const proposal = await this.prisma.mutualResolutionProposal.findFirst({
            where: { id: proposalId, disputeId: dispute.id, status: 'PENDING', proposedBy: userId },
        });
        if (!proposal)
            throw new common_1.NotFoundException({ code: 'PROPOSAL_NOT_FOUND', message: 'Pending proposal not found or you are not the proposer' });
        const withdrawn = await this.prisma.$transaction(async (tx) => {
            await tx.$queryRaw `SELECT id FROM disputes WHERE id = ${dispute.id} FOR UPDATE`;
            const freshDispute = await tx.dispute.findUnique({
                where: { id: dispute.id },
                select: { status: true, order: { select: { status: true } } },
            });
            if (!freshDispute || terminalStatuses.includes(freshDispute.status) || freshDispute.order.status !== client_1.OrderStatus.DISPUTED) {
                throw new common_1.ConflictException({ code: 'DISPUTE_STATE_CHANGED', message: 'Dispute or order state changed before withdrawal' });
            }
            return tx.mutualResolutionProposal.updateMany({
                where: { id: proposalId, disputeId: dispute.id, proposedBy: userId, status: 'PENDING' },
                data: { status: 'EXPIRED', respondedAt: new Date(), responseNote: 'Withdrawn by proposer' },
            });
        });
        if (withdrawn.count === 0) {
            throw new common_1.ConflictException({
                code: 'PROPOSAL_ALREADY_RESPONDED',
                message: 'Proposal has already been responded to',
            });
        }
        return { status: 'WITHDRAWN' };
    }
};
exports.MutualResolutionService = MutualResolutionService;
exports.MutualResolutionService = MutualResolutionService = MutualResolutionService_1 = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [prisma_service_1.PrismaService,
        wallet_tx_serial_service_1.WalletTxSerialService,
        fee_calculator_service_1.FeeCalculatorService])
], MutualResolutionService);
