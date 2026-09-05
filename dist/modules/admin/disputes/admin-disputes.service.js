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
var AdminDisputesService_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.AdminDisputesService = void 0;
const common_1 = require("@nestjs/common");
const library_1 = require("@prisma/client/runtime/library");
const crypto_1 = require("crypto");
const client_1 = require("@prisma/client");
const notification_category_map_1 = require("../../notifications/notification-category.map");
const prisma_service_1 = require("../../../prisma/prisma.service");
const wallet_tx_serial_service_1 = require("../../../common/services/wallet-tx-serial.service");
const id_generator_util_1 = require("../../../common/utils/id-generator.util");
const dispute_decision_dto_1 = require("./dispute-decision.dto");
const audit_log_service_1 = require("../../../common/services/audit-log.service");
const currency_util_1 = require("../../../common/utils/currency.util");
const ErrorCodes = __importStar(require("../../../common/constants/error-codes"));
const pagination_dto_1 = require("../../../common/dto/pagination.dto");
const sanitize_util_1 = require("../../../common/utils/sanitize.util");
const upload_service_1 = require("../../upload/upload.service");
const realtime_service_1 = require("../../realtime/realtime.service");
let AdminDisputesService = AdminDisputesService_1 = class AdminDisputesService {
    constructor(prisma, walletTxSerialService, auditLog, uploadService, realtime) {
        this.prisma = prisma;
        this.walletTxSerialService = walletTxSerialService;
        this.auditLog = auditLog;
        this.uploadService = uploadService;
        this.realtime = realtime;
        this.logger = new common_1.Logger(AdminDisputesService_1.name);
    }
    async withSerializableRetry(fn, label) {
        for (let attempt = 1; attempt <= 3; attempt++) {
            try {
                return await fn();
            }
            catch (error) {
                const retryable = error instanceof client_1.Prisma.PrismaClientKnownRequestError && error.code === 'P2034'
                    || error instanceof client_1.Prisma.PrismaClientUnknownRequestError && /40001|serialization|40p01|deadlock/i.test(error.message);
                if (!retryable || attempt === 3)
                    throw error;
                this.logger.warn(`${label} retrying attempt=${attempt}/3`);
                await new Promise(resolve => setTimeout(resolve, 100 * 2 ** (attempt - 1) + (0, crypto_1.randomInt)(0, 50)));
            }
        }
        throw new Error(`${label}: unreachable`);
    }
    async listDisputes(page = 1, limit = 20, status, search) {
        if (status !== undefined && !['OPEN', 'ASSIGNED', 'UNDER_REVIEW', 'WAITING_RESPONSE', 'ESCALATED', 'RESOLVED', 'CANCELLED'].includes(status)) {
            throw new common_1.BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Invalid dispute status' });
        }
        const safePage = Number.isFinite(page) ? Math.max(1, Math.floor(page)) : 1;
        const safeLimit = Number.isFinite(limit) ? Math.min(100, Math.max(1, Math.floor(limit))) : 20;
        const skip = (safePage - 1) * safeLimit;
        const where = {};
        if (status)
            where.status = status;
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
            order: { ...d.order, orderValue: (0, currency_util_1.toIdr)(d.order.orderValue) },
        }));
        return (0, pagination_dto_1.createPaginatedResponse)(serialized, total, safePage, safeLimit);
    }
    async getDisputeDetail(disputeId, adminId, ipAddress) {
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
        if (!dispute)
            throw new common_1.NotFoundException({ code: ErrorCodes.DISPUTE_NOT_FOUND, message: 'Dispute not found' });
        if (adminId) {
            this.auditLog.logAdminAction({
                adminId,
                action: client_1.AuditAction.ADMIN_ACTION,
                targetType: 'Dispute',
                targetId: dispute.disputeId,
                description: `Admin viewed dispute detail for ${dispute.disputeId}`,
                ipAddress: ipAddress ?? 'unknown',
            });
        }
        const evidenceWithDownloads = await Promise.all(dispute.evidences.map(async (evidence) => {
            const keys = Array.isArray(evidence.fileUrls) ? evidence.fileUrls.filter((key) => typeof key === 'string') : [];
            const downloads = await Promise.all(keys.map(async (key) => {
                try {
                    return await this.uploadService.generateDownloadUrl(key, 300);
                }
                catch {
                    return null;
                }
            }));
            return { ...evidence, fileUrls: [], fileDownloadUrls: downloads.filter((url) => Boolean(url)) };
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
                orderValue: (0, currency_util_1.toIdr)(dispute.order.orderValue),
                feeAmount: (0, currency_util_1.toIdr)(dispute.order.feeAmount),
                buyerFeeAmount: (0, currency_util_1.toIdr)(dispute.order.buyerFeeAmount),
                sellerFeeAmount: (0, currency_util_1.toIdr)(dispute.order.sellerFeeAmount),
                buyerPayAmount: (0, currency_util_1.toIdr)(dispute.order.buyerPayAmount),
                sellerReceiveAmount: (0, currency_util_1.toIdr)(dispute.order.sellerReceiveAmount),
                voucherDiscount: (0, currency_util_1.toIdr)(dispute.order.voucherDiscount),
            },
            ...(dispute.decision ? {
                decision: {
                    ...dispute.decision,
                    buyerAmount: (0, currency_util_1.toIdr)(dispute.decision.buyerAmount),
                    sellerAmount: (0, currency_util_1.toIdr)(dispute.decision.sellerAmount),
                },
            } : {}),
        };
    }
    async resolveDispute(disputeId, adminId, dto, ipAddress = 'internal') {
        (0, dispute_decision_dto_1.validateSplitPercents)(dto);
        const dispute = await this.prisma.dispute.findFirst({
            where: { OR: [{ id: disputeId }, { disputeId }] },
            include: { order: true },
        });
        if (!dispute)
            throw new common_1.NotFoundException({ code: ErrorCodes.DISPUTE_NOT_FOUND, message: 'Dispute not found' });
        const resolvableStatuses = ['UNDER_REVIEW', 'ESCALATED'];
        if (!resolvableStatuses.includes(dispute.status)) {
            throw new common_1.BadRequestException({ code: ErrorCodes.INVALID_STATUS, message: `Dispute must be in UNDER_REVIEW or ESCALATED status to resolve (current: ${dispute.status})` });
        }
        const actingAdmin = await this.prisma.adminUser.findUnique({ where: { id: adminId }, select: { role: true } });
        const isSuperAdmin = actingAdmin?.role === 'SUPER_ADMIN';
        if (dispute.assignedAdminId && dispute.assignedAdminId !== adminId && !isSuperAdmin) {
            throw new common_1.ForbiddenException({ code: ErrorCodes.NOT_ASSIGNED_ADMIN, message: 'Only the assigned admin or a SUPER_ADMIN can resolve this dispute' });
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
            throw new common_1.BadRequestException({ code: ErrorCodes.INVALID_STATUS, message: 'No escrowed funds available for dispute resolution' });
        }
        let buyerAmount;
        let sellerAmount;
        let platformRetainAmount;
        if (dto.decision === 'FULL_BUYER') {
            buyerAmount = sellerReceiveAmount;
            sellerAmount = BigInt(0);
            platformRetainAmount = platformFee;
        }
        else if (dto.decision === 'FULL_SELLER') {
            buyerAmount = BigInt(0);
            sellerAmount = sellerReceiveAmount;
            platformRetainAmount = platformFee;
        }
        else {
            buyerAmount = (sellerReceiveAmount * BigInt(dto.buyerPercent)) / BigInt(100);
            sellerAmount = sellerReceiveAmount - buyerAmount;
            platformRetainAmount = platformFee;
        }
        const totalDisbursement = buyerAmount + sellerAmount + platformRetainAmount;
        if (totalDisbursement > escrowedAmount) {
            throw new common_1.BadRequestException({
                code: ErrorCodes.DISPUTE_AMOUNT_EXCEEDS_ESCROW,
                message: `Total disbursement (${totalDisbursement}) exceeds escrowed amount (${escrowedAmount})`,
            });
        }
        const buyerTxSerial = buyerAmount > BigInt(0) ? await this.walletTxSerialService.getNext() : null;
        const sellerTxSerial = sellerAmount > BigInt(0) ? await this.walletTxSerialService.getNext() : null;
        const feeTxSerial = platformRetainAmount > BigInt(0) ? await this.walletTxSerialService.getNext() : null;
        const result = await this.withSerializableRetry(() => this.prisma.$transaction(async (tx) => {
            await tx.$queryRaw `SELECT id FROM disputes WHERE id = ${dispute.id} FOR UPDATE`;
            const freshDispute = await tx.dispute.findUnique({
                where: { id: dispute.id },
                select: { status: true, assignedAdminId: true },
            });
            if (!freshDispute || !resolvableStatuses.includes(freshDispute.status)) {
                throw new common_1.ConflictException({ code: ErrorCodes.INVALID_STATUS, message: 'Dispute state changed before resolution' });
            }
            if (freshDispute.assignedAdminId && freshDispute.assignedAdminId !== adminId && !isSuperAdmin) {
                throw new common_1.ForbiddenException({ code: ErrorCodes.NOT_ASSIGNED_ADMIN, message: 'Assignment changed before resolution; only the assigned admin or a SUPER_ADMIN can resolve' });
            }
            const order = await tx.order.findUnique({
                where: { id: dispute.orderId },
                include: {
                    buyer: { select: { wallet: { select: { id: true, isLocked: true, escrowBalance: true, availableBalance: true, totalBalance: true, version: true } } } },
                    seller: { select: { wallet: { select: { id: true, isLocked: true, escrowBalance: true, availableBalance: true, totalBalance: true, version: true } } } },
                },
            });
            if (!order || order.status !== client_1.OrderStatus.DISPUTED) {
                throw new common_1.ConflictException({ code: ErrorCodes.INVALID_STATUS, message: 'Order is no longer DISPUTED; dispute resolution was not applied' });
            }
            if ((order.completedAt !== null) !== isPostCompletionDispute) {
                throw new common_1.ConflictException({ code: ErrorCodes.INVALID_STATUS, message: 'Dispute settlement classification changed; please retry.' });
            }
            const freshIsPostCompletionDispute = order.completedAt !== null;
            const freshEscrowedAmount = freshIsPostCompletionDispute ? order.sellerReceiveAmount : order.buyerPayAmount;
            if (freshEscrowedAmount < totalDisbursement) {
                throw new common_1.ConflictException({ code: ErrorCodes.DISPUTE_AMOUNT_EXCEEDS_ESCROW, message: 'Fresh order escrow is lower than the proposed settlement' });
            }
            const buyerWallet = order.buyer?.wallet;
            const sellerWallet = order.seller?.wallet;
            if (!buyerWallet) {
                this.logger.error(`Dispute ${disputeId}: buyer wallet missing for order ${dispute.orderId}`);
                throw new common_1.BadRequestException({ code: ErrorCodes.NOT_FOUND, message: 'Buyer wallet not found. Cannot proceed with dispute fund release.' });
            }
            if (!sellerWallet) {
                this.logger.error(`Dispute ${disputeId}: seller wallet missing for order ${dispute.orderId}`);
                throw new common_1.BadRequestException({ code: ErrorCodes.NOT_FOUND, message: 'Seller wallet not found. Cannot proceed with dispute fund release.' });
            }
            if (buyerWallet.isLocked) {
                this.logger.error(`Dispute ${disputeId}: buyer wallet ${buyerWallet.id} is locked`);
                throw new common_1.BadRequestException({ code: 'WALLET_LOCKED', message: 'Buyer wallet is locked. Cannot proceed with dispute fund release.' });
            }
            if (sellerWallet.isLocked) {
                this.logger.error(`Dispute ${disputeId}: seller wallet ${sellerWallet.id} is locked`);
                throw new common_1.BadRequestException({ code: 'WALLET_LOCKED', message: 'Seller wallet is locked. Cannot proceed with dispute fund release.' });
            }
            const escrowSource = freshIsPostCompletionDispute ? sellerWallet : buyerWallet;
            if (escrowSource.escrowBalance < freshEscrowedAmount) {
                const party = freshIsPostCompletionDispute ? 'Seller' : 'Buyer';
                throw new common_1.BadRequestException({
                    code: ErrorCodes.ESCROW_BALANCE_MISMATCH,
                    message: `${party} escrow balance (${escrowSource.escrowBalance}) is less than expected escrowed amount (${freshEscrowedAmount}). Manual investigation required.`,
                });
            }
            const existingDecision = await tx.disputeDecision.findUnique({ where: { disputeId: dispute.id } });
            if (existingDecision) {
                throw new common_1.ConflictException({ code: ErrorCodes.DISPUTE_ALREADY_RESOLVED, message: 'This dispute has already been resolved' });
            }
            const [firstWalletId, secondWalletId] = [buyerWallet.id, sellerWallet.id].sort();
            await tx.$queryRaw `SELECT id FROM wallets WHERE id IN (${firstWalletId}, ${secondWalletId}) ORDER BY id FOR UPDATE`;
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
                    decisionType: dto.decision,
                    decisionNotes: [
                        dto.decisionNotes,
                        timeToFirstResponseMs != null ? `[timing] firstResponse=${timeToFirstResponseMs}ms` : null,
                        `[timing] totalResolution=${totalResolutionTimeMs}ms`,
                    ].filter(Boolean).join(' | '),
                    buyerAmount,
                    sellerAmount,
                    buyerPercent: dto.decision === 'SPLIT' ? new library_1.Decimal(dto.buyerPercent) : null,
                    sellerPercent: dto.decision === 'SPLIT' ? new library_1.Decimal(dto.sellerPercent) : null,
                },
            });
            if (order.status === client_1.OrderStatus.DISPUTED) {
                await tx.order.update({
                    where: { id: order.id },
                    data: {
                        status: client_1.OrderStatus.COMPLETED,
                        ...(order.completedAt ? {} : { completedAt: new Date() }),
                    },
                });
                await tx.orderStatusHistory.create({
                    data: {
                        orderId: order.id,
                        fromStatus: client_1.OrderStatus.DISPUTED,
                        toStatus: client_1.OrderStatus.COMPLETED,
                        changedBy: adminId,
                        changedByType: client_1.ActorType.ADMIN,
                        reason: `Dispute resolved: ${dto.decision}${dto.decisionNotes ? ` — ${dto.decisionNotes}` : ''}`,
                    },
                });
            }
            if (freshIsPostCompletionDispute) {
                if (buyerAmount > BigInt(0)) {
                    const freshSellerForBuyer = await tx.wallet.findUnique({ where: { id: sellerWallet.id } });
                    if (!freshSellerForBuyer)
                        throw new common_1.ConflictException({ code: ErrorCodes.NOT_FOUND, message: 'Seller wallet disappeared during dispute resolution' });
                    const sellerDebit = await tx.wallet.updateMany({
                        where: { id: sellerWallet.id, version: freshSellerForBuyer.version, escrowBalance: { gte: buyerAmount } },
                        data: { escrowBalance: { decrement: buyerAmount }, totalBalance: { decrement: buyerAmount }, version: { increment: 1 } },
                    });
                    if (sellerDebit.count === 0)
                        throw new common_1.ConflictException({ code: ErrorCodes.OPTIMISTIC_LOCK_CONFLICT, message: 'Concurrent wallet update during post-completion dispute resolution' });
                    const freshBuyerForRefund = await tx.wallet.findUnique({ where: { id: buyerWallet.id } });
                    if (!freshBuyerForRefund)
                        throw new common_1.ConflictException({ code: ErrorCodes.NOT_FOUND, message: 'Buyer wallet disappeared during dispute resolution' });
                    const buyerCredit = await tx.wallet.updateMany({
                        where: { id: buyerWallet.id, version: freshBuyerForRefund.version },
                        data: { availableBalance: { increment: buyerAmount }, totalBalance: { increment: buyerAmount }, version: { increment: 1 } },
                    });
                    if (buyerCredit.count === 0)
                        throw new common_1.ConflictException({ code: ErrorCodes.OPTIMISTIC_LOCK_CONFLICT, message: 'Concurrent buyer wallet update during post-completion dispute refund' });
                    const buyerTxId = (0, id_generator_util_1.generateWalletTxId)(buyerTxSerial);
                    await tx.walletTransaction.create({
                        data: {
                            txId: buyerTxId, walletId: buyerWallet.id,
                            type: client_1.WalletTransactionType.ORDER_REFUND, status: client_1.WalletTransactionStatus.SUCCESS,
                            amount: buyerAmount, balanceBefore: freshBuyerForRefund.availableBalance, balanceAfter: freshBuyerForRefund.availableBalance + buyerAmount,
                            orderId: dispute.orderId, description: `Post-completion dispute refund to buyer (order ${dispute.orderId})`,
                        },
                    });
                    this.logger.log(`Dispute ${disputeId}: post-completion refund ${buyerAmount} to buyer wallet ${buyerWallet.id}`);
                }
                if (sellerAmount > BigInt(0)) {
                    const freshSellerForRelease = await tx.wallet.findUnique({ where: { id: sellerWallet.id } });
                    if (!freshSellerForRelease)
                        throw new common_1.ConflictException({ code: ErrorCodes.NOT_FOUND, message: 'Seller wallet disappeared during dispute resolution' });
                    const sellerRelease = await tx.wallet.updateMany({
                        where: { id: sellerWallet.id, version: freshSellerForRelease.version, escrowBalance: { gte: sellerAmount } },
                        data: { escrowBalance: { decrement: sellerAmount }, availableBalance: { increment: sellerAmount }, version: { increment: 1 } },
                    });
                    if (sellerRelease.count === 0)
                        throw new common_1.ConflictException({ code: ErrorCodes.OPTIMISTIC_LOCK_CONFLICT, message: 'Concurrent seller wallet update during post-completion dispute release' });
                    const sellerTxId = (0, id_generator_util_1.generateWalletTxId)(sellerTxSerial);
                    await tx.walletTransaction.create({
                        data: {
                            txId: sellerTxId, walletId: sellerWallet.id,
                            type: client_1.WalletTransactionType.DISPUTE_RELEASE, status: client_1.WalletTransactionStatus.SUCCESS,
                            amount: sellerAmount, balanceBefore: freshSellerForRelease.availableBalance, balanceAfter: freshSellerForRelease.availableBalance + sellerAmount,
                            orderId: dispute.orderId, description: `Post-completion dispute: funds returned to seller (order ${dispute.orderId})`,
                        },
                    });
                    this.logger.log(`Dispute ${disputeId}: post-completion release ${sellerAmount} to seller wallet ${sellerWallet.id}`);
                }
            }
            else {
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
                        throw new common_1.ConflictException({ code: ErrorCodes.OPTIMISTIC_LOCK_CONFLICT, message: 'Concurrent wallet update during dispute resolution, please retry' });
                    }
                    const buyerTxId = (0, id_generator_util_1.generateWalletTxId)(buyerTxSerial);
                    await tx.walletTransaction.create({
                        data: {
                            txId: buyerTxId, walletId: buyerWallet.id,
                            type: client_1.WalletTransactionType.ORDER_REFUND, status: client_1.WalletTransactionStatus.SUCCESS,
                            amount: buyerAmount, balanceBefore: buyerWallet.availableBalance, balanceAfter: buyerWallet.availableBalance + buyerAmount,
                            orderId: dispute.orderId, description: `Dispute resolved: refund to buyer (order ${dispute.orderId})`,
                        },
                    });
                    this.logger.log(`Dispute ${disputeId}: refunded ${buyerAmount} to buyer wallet ${buyerWallet.id}`);
                }
                if (sellerAmount > BigInt(0)) {
                    const freshBuyerWalletForSeller = await tx.wallet.findUnique({ where: { id: buyerWallet.id } });
                    if (!freshBuyerWalletForSeller) {
                        throw new common_1.ConflictException({ code: ErrorCodes.NOT_FOUND, message: 'Buyer wallet disappeared during dispute resolution' });
                    }
                    const buyerResult2 = await tx.wallet.updateMany({
                        where: { id: buyerWallet.id, version: freshBuyerWalletForSeller.version },
                        data: { escrowBalance: { decrement: sellerAmount }, totalBalance: { decrement: sellerAmount }, version: { increment: 1 } },
                    });
                    if (buyerResult2.count === 0) {
                        throw new common_1.ConflictException({ code: ErrorCodes.OPTIMISTIC_LOCK_CONFLICT, message: 'Concurrent wallet update during dispute resolution (buyer escrow decrement), please retry' });
                    }
                    const freshSellerWallet = await tx.wallet.findUnique({ where: { id: sellerWallet.id } });
                    if (!freshSellerWallet) {
                        throw new common_1.ConflictException({ code: ErrorCodes.NOT_FOUND, message: 'Seller wallet disappeared during dispute resolution' });
                    }
                    const sellerResult = await tx.wallet.updateMany({
                        where: { id: freshSellerWallet.id, version: freshSellerWallet.version },
                        data: { availableBalance: { increment: sellerAmount }, totalBalance: { increment: sellerAmount }, version: { increment: 1 } },
                    });
                    if (sellerResult.count === 0) {
                        throw new common_1.ConflictException({ code: ErrorCodes.OPTIMISTIC_LOCK_CONFLICT, message: 'Concurrent wallet update during dispute resolution (seller credit), please retry' });
                    }
                    const sellerTxId = (0, id_generator_util_1.generateWalletTxId)(sellerTxSerial);
                    await tx.walletTransaction.create({
                        data: {
                            txId: sellerTxId, walletId: freshSellerWallet.id,
                            type: client_1.WalletTransactionType.DISPUTE_RELEASE, status: client_1.WalletTransactionStatus.SUCCESS,
                            amount: sellerAmount, balanceBefore: freshSellerWallet.availableBalance, balanceAfter: freshSellerWallet.availableBalance + sellerAmount,
                            orderId: dispute.orderId, description: `Dispute resolved: payment to seller (order ${dispute.orderId})`,
                        },
                    });
                    this.logger.log(`Dispute ${disputeId}: released ${sellerAmount} to seller wallet ${sellerWallet.id}`);
                }
                if (platformRetainAmount > BigInt(0)) {
                    const latestBuyerWallet = await tx.wallet.findUnique({ where: { id: buyerWallet.id } });
                    if (!latestBuyerWallet) {
                        throw new common_1.ConflictException({ code: ErrorCodes.NOT_FOUND, message: 'Buyer wallet disappeared during dispute fee deduction' });
                    }
                    const feeResult = await tx.wallet.updateMany({
                        where: { id: buyerWallet.id, version: latestBuyerWallet.version },
                        data: { escrowBalance: { decrement: platformRetainAmount }, totalBalance: { decrement: platformRetainAmount }, version: { increment: 1 } },
                    });
                    if (feeResult.count === 0) {
                        throw new common_1.ConflictException({ code: ErrorCodes.OPTIMISTIC_LOCK_CONFLICT, message: 'Concurrent wallet update during dispute fee deduction, please retry' });
                    }
                    const feeTxId = (0, id_generator_util_1.generateWalletTxId)(feeTxSerial);
                    await tx.walletTransaction.create({
                        data: {
                            txId: feeTxId, walletId: buyerWallet.id,
                            type: client_1.WalletTransactionType.FEE_DEDUCT, status: client_1.WalletTransactionStatus.SUCCESS,
                            amount: platformRetainAmount, balanceBefore: latestBuyerWallet.totalBalance, balanceAfter: latestBuyerWallet.totalBalance - platformRetainAmount,
                            orderId: dispute.orderId, description: `Platform fee retained from dispute (order ${dispute.orderId})`,
                        },
                    });
                    this.logger.log(`Dispute ${disputeId}: platform retained fee ${platformRetainAmount} from order ${dispute.orderId}`);
                }
            }
            const decisionLabel = dto.decision === 'FULL_BUYER' ? 'Full amount refunded to buyer'
                : dto.decision === 'FULL_SELLER' ? 'Full amount forwarded to seller'
                    : `Funds split ${dto.buyerPercent}% buyer / ${dto.sellerPercent}% seller`;
            const notifyUserIds = [order?.buyerId, order?.sellerId].filter((id) => !!id);
            const disputeNotifTitle = 'Dispute Decision Made';
            const sanitizedNotes = dto.decisionNotes ? (0, sanitize_util_1.escapeHtml)(dto.decisionNotes) : '';
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
            action: client_1.AuditAction.DISPUTE_DECIDED,
            targetType: 'Dispute',
            targetId: result.auditTargetId,
            description: result.auditDescription,
            after: result.auditAfter,
            ipAddress,
        });
        for (const uid of result.notifyUserIds) {
            this.prisma.notification.create({
                data: {
                    notifId: (0, id_generator_util_1.generateNotifId)(),
                    userId: uid,
                    type: client_1.NotificationType.DISPUTE_DECISION,
                    category: (0, notification_category_map_1.getCategoryForType)(client_1.NotificationType.DISPUTE_DECISION),
                    title: result.disputeNotifTitle,
                    body: result.disputeNotifBody,
                    isRead: false,
                },
            }).catch((err) => this.logger.warn(`silent-catch: dispute decision notification failed: ${err instanceof Error ? err.message : String(err)}`));
            this.prisma.emitNotificationCreated({ userId: uid, title: result.disputeNotifTitle, body: result.disputeNotifBody, data: { type: 'DISPUTE_RESOLVED', disputeId: result.resolvedDisputeId } });
        }
        return result.decision;
    }
    async assignAdmin(disputeId, requestingAdminId, targetAdminId, _ipAddress = 'internal') {
        const dispute = await this.prisma.dispute.findFirst({
            where: { OR: [{ id: disputeId }, { disputeId }] },
        });
        if (!dispute)
            throw new common_1.NotFoundException({ code: ErrorCodes.DISPUTE_NOT_FOUND, message: 'Dispute not found' });
        const requestingAdmin = await this.prisma.adminUser.findUnique({ where: { id: requestingAdminId }, select: { role: true } });
        const isSuperAdmin = requestingAdmin?.role === 'SUPER_ADMIN';
        const assignableStatuses = [client_1.DisputeStatus.OPEN, client_1.DisputeStatus.WAITING_RESPONSE];
        const reassignableStatuses = [client_1.DisputeStatus.ASSIGNED, client_1.DisputeStatus.UNDER_REVIEW];
        const isInitialAssign = assignableStatuses.includes(dispute.status);
        const isReassign = reassignableStatuses.includes(dispute.status);
        if (!isInitialAssign && !isReassign) {
            throw new common_1.BadRequestException({ code: ErrorCodes.INVALID_STATUS, message: `Dispute must be OPEN, WAITING_RESPONSE, ASSIGNED, or UNDER_REVIEW to assign (current: ${dispute.status})` });
        }
        if (isReassign && !isSuperAdmin) {
            throw new common_1.ForbiddenException({ code: 'FORBIDDEN', message: 'Only a SUPER_ADMIN can reassign an already-assigned dispute' });
        }
        let resolvedAssigneeId = requestingAdminId;
        if (targetAdminId && targetAdminId !== requestingAdminId) {
            if (!isSuperAdmin) {
                throw new common_1.ForbiddenException({ code: 'FORBIDDEN', message: 'Only a SUPER_ADMIN can assign disputes to another admin' });
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
            throw new common_1.NotFoundException({ code: 'ADMIN_NOT_ASSIGNABLE', message: 'Target admin is inactive, deleted, or not eligible for dispute assignment' });
        }
        const writeGuardStatuses = isSuperAdmin
            ? [...assignableStatuses, ...reassignableStatuses]
            : assignableStatuses;
        const result = await this.prisma.dispute.updateMany({
            where: { id: dispute.id, status: { in: writeGuardStatuses } },
            data: { assignedAdminId: resolvedAssigneeId, status: 'ASSIGNED', assignedAt: new Date() },
        });
        if (result.count === 0) {
            throw new common_1.ConflictException({ code: ErrorCodes.OPTIMISTIC_LOCK_CONFLICT, message: 'Dispute status changed concurrently, please retry' });
        }
        this.auditLog.logAdminAction({
            adminId: requestingAdminId,
            action: client_1.AuditAction.ADMIN_ACTION,
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
    async getDisputeMessages(disputeId, adminId, cursor, limit = 50) {
        const dispute = await this.prisma.dispute.findFirst({
            where: { OR: [{ id: disputeId }, { disputeId }] },
            include: { order: { select: { buyerId: true, sellerId: true } } },
        });
        if (!dispute)
            throw new common_1.NotFoundException({ code: ErrorCodes.DISPUTE_NOT_FOUND, message: 'Dispute not found' });
        const admin = await this.prisma.adminUser.findUnique({ where: { id: adminId }, select: { role: true } });
        if (admin?.role !== 'SUPER_ADMIN' && dispute.assignedAdminId !== adminId) {
            throw new common_1.ForbiddenException({ code: ErrorCodes.NOT_ASSIGNED_ADMIN, message: 'Only the assigned admin or a SUPER_ADMIN can view dispute messages' });
        }
        if (cursor && !/^c[a-z0-9]{24}$/.test(cursor)) {
            throw new common_1.BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Invalid message cursor' });
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
    async markUnderReview(disputeId, adminId, ipAddress = 'unknown') {
        const dispute = await this.prisma.dispute.findFirst({
            where: { OR: [{ id: disputeId }, { disputeId }] },
        });
        if (!dispute)
            throw new common_1.NotFoundException({ code: ErrorCodes.DISPUTE_NOT_FOUND, message: 'Dispute not found' });
        const allowedForReview = [client_1.DisputeStatus.ASSIGNED];
        if (!allowedForReview.includes(dispute.status)) {
            throw new common_1.BadRequestException({ code: ErrorCodes.INVALID_STATUS, message: `Dispute must be ASSIGNED before active review (current: ${dispute.status})` });
        }
        const resolverAdmin = await this.prisma.adminUser.findUnique({ where: { id: adminId }, select: { role: true } });
        if (!dispute.assignedAdminId) {
            throw new common_1.ForbiddenException({ code: ErrorCodes.NOT_ASSIGNED_ADMIN, message: 'Assign the dispute to an admin before beginning review' });
        }
        if (dispute.assignedAdminId !== adminId && resolverAdmin?.role !== 'SUPER_ADMIN') {
            throw new common_1.ForbiddenException({ code: ErrorCodes.NOT_ASSIGNED_ADMIN, message: 'Only the assigned admin or a SUPER_ADMIN can begin review' });
        }
        const result = await this.prisma.dispute.updateMany({
            where: resolverAdmin?.role === 'SUPER_ADMIN'
                ? { id: dispute.id, status: client_1.DisputeStatus.ASSIGNED }
                : { id: dispute.id, status: client_1.DisputeStatus.ASSIGNED, assignedAdminId: adminId },
            data: { status: client_1.DisputeStatus.UNDER_REVIEW },
        });
        if (result.count === 0) {
            throw new common_1.BadRequestException({ code: ErrorCodes.OPTIMISTIC_LOCK_CONFLICT, message: 'Dispute status changed concurrently, please retry' });
        }
        this.auditLog.logAdminAction({
            adminId,
            action: client_1.AuditAction.ADMIN_ACTION,
            targetType: 'Dispute',
            targetId: dispute.disputeId,
            description: `Admin marked dispute ${dispute.disputeId} as UNDER_REVIEW (was ${dispute.status})`,
            before: { status: dispute.status },
            after: { status: client_1.DisputeStatus.UNDER_REVIEW },
            ipAddress,
        });
        return this.prisma.dispute.findUnique({
            where: { id: dispute.id },
            select: { disputeId: true, status: true, assignedAdminId: true },
        });
    }
    async sendDisputeMessage(disputeId, adminId, content, ipAddress = 'unknown') {
        const dispute = await this.prisma.dispute.findFirst({
            where: { OR: [{ id: disputeId }, { disputeId }] },
            include: { order: { select: { buyerId: true, sellerId: true } } },
        });
        if (!dispute)
            throw new common_1.NotFoundException({ code: ErrorCodes.DISPUTE_NOT_FOUND, message: 'Dispute not found' });
        const admin = await this.prisma.adminUser.findUnique({ where: { id: adminId }, select: { role: true, fullName: true, adminId: true } });
        const isSuperAdmin = admin?.role === 'SUPER_ADMIN';
        if (!isSuperAdmin && dispute.assignedAdminId !== adminId) {
            throw new common_1.ForbiddenException({ code: ErrorCodes.NOT_ASSIGNED_ADMIN, message: 'Only the assigned admin or a SUPER_ADMIN can send dispute messages' });
        }
        const activeStatuses = [client_1.DisputeStatus.OPEN, client_1.DisputeStatus.ASSIGNED, client_1.DisputeStatus.UNDER_REVIEW, client_1.DisputeStatus.WAITING_RESPONSE, client_1.DisputeStatus.ESCALATED];
        if (!activeStatuses.includes(dispute.status)) {
            throw new common_1.BadRequestException({ code: ErrorCodes.INVALID_STATUS, message: 'Cannot send messages to a resolved or cancelled dispute' });
        }
        const normalizedContent = content.trim();
        if (!normalizedContent || normalizedContent.length > 2000) {
            throw new common_1.BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Message must contain 1–2000 non-whitespace characters' });
        }
        const safeContent = (0, sanitize_util_1.escapeHtml)(normalizedContent);
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
            }
            catch (error) {
                this.logger.warn(`dispute admin message realtime failed: ${error instanceof Error ? error.message : String(error)}`);
            }
        }
        this.auditLog.logAdminAction({
            adminId,
            action: client_1.AuditAction.ADMIN_ACTION,
            targetType: 'Dispute',
            targetId: dispute.disputeId,
            description: `Admin sent mediation message in dispute ${dispute.disputeId}`,
            after: { messageId: message.id },
            ipAddress,
        });
        return message;
    }
};
exports.AdminDisputesService = AdminDisputesService;
exports.AdminDisputesService = AdminDisputesService = AdminDisputesService_1 = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [prisma_service_1.PrismaService,
        wallet_tx_serial_service_1.WalletTxSerialService,
        audit_log_service_1.AuditLogService,
        upload_service_1.UploadService,
        realtime_service_1.RealtimeService])
], AdminDisputesService);
