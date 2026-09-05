"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
var ReconciliationService_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.ReconciliationService = void 0;
const common_1 = require("@nestjs/common");
const prisma_service_1 = require("../../../prisma/prisma.service");
const client_1 = require("@prisma/client");
const currency_util_1 = require("../../../common/utils/currency.util");
const date_util_1 = require("../../../common/utils/date.util");
let ReconciliationService = ReconciliationService_1 = class ReconciliationService {
    constructor(prisma) {
        this.prisma = prisma;
        this.logger = new common_1.Logger(ReconciliationService_1.name);
    }
    async reconcileWalletBalance(userId) {
        const wallet = await this.prisma.wallet.findUnique({
            where: { userId },
            select: {
                id: true,
                userId: true,
                availableBalance: true,
                escrowBalance: true,
                totalBalance: true,
            },
        });
        if (!wallet) {
            throw new common_1.NotFoundException({ code: 'NOT_FOUND', message: 'Wallet not found for user' });
        }
        return this.reconcileWallet(wallet);
    }
    async reconcileAllWallets() {
        const BATCH_SIZE = 500;
        const discrepancies = [];
        let totalChecked = 0;
        let lastId = null;
        for (;;) {
            const wallets = await this.prisma.wallet.findMany({
                ...(lastId ? { cursor: { id: lastId }, skip: 1 } : {}),
                take: BATCH_SIZE,
                orderBy: { id: 'asc' },
                select: {
                    id: true,
                    userId: true,
                    availableBalance: true,
                    escrowBalance: true,
                    totalBalance: true,
                },
            });
            if (wallets.length === 0)
                break;
            for (const wallet of wallets) {
                const result = await this.reconcileWallet(wallet);
                if (result) {
                    discrepancies.push(result);
                }
            }
            totalChecked += wallets.length;
            lastId = wallets[wallets.length - 1].id;
            if (wallets.length < BATCH_SIZE)
                break;
        }
        return {
            reconciledAt: new Date().toISOString(),
            walletsChecked: totalChecked,
            discrepancies,
            clean: discrepancies.length === 0,
        };
    }
    async getFinancialAuditTrail(userId, from, to) {
        const wallet = await this.prisma.wallet.findUnique({
            where: { userId },
            select: { id: true },
        });
        if (!wallet) {
            throw new common_1.NotFoundException({ code: 'NOT_FOUND', message: 'Wallet not found for user' });
        }
        const fromDate = (0, date_util_1.parseDateBoundaryWIB)(from, 'start');
        const toDate = (0, date_util_1.parseDateBoundaryWIB)(to, 'end');
        if (!fromDate || !toDate) {
            throw new common_1.BadRequestException({
                code: 'INVALID_DATE_FORMAT',
                message: 'from and to must be valid ISO date strings',
            });
        }
        if (fromDate.getTime() > toDate.getTime()) {
            throw new common_1.BadRequestException({
                code: 'INVALID_DATE_RANGE',
                message: 'from must be before or equal to to',
            });
        }
        const diffDays = Math.ceil((toDate.getTime() - fromDate.getTime()) / (1000 * 60 * 60 * 24));
        if (diffDays > 365) {
            throw new common_1.BadRequestException({
                code: 'DATE_RANGE_TOO_LARGE',
                message: 'Audit trail date range cannot exceed 365 days',
            });
        }
        const PRIOR_BATCH_SIZE = 5000;
        let openingTotalBalance = BigInt(0);
        let priorLastId;
        let priorLastCreatedAt;
        for (;;) {
            const priorBatch = await this.prisma.walletTransaction.findMany({
                where: {
                    walletId: wallet.id,
                    status: client_1.WalletTransactionStatus.SUCCESS,
                    createdAt: { lt: fromDate },
                    ...(priorLastCreatedAt
                        ? {
                            OR: [
                                { createdAt: { gt: priorLastCreatedAt, lt: fromDate } },
                                { createdAt: priorLastCreatedAt, id: { gt: priorLastId } },
                            ],
                        }
                        : {}),
                },
                take: PRIOR_BATCH_SIZE,
                orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
                select: { id: true, type: true, balanceBefore: true, balanceAfter: true, createdAt: true },
            });
            if (priorBatch.length === 0)
                break;
            for (const tx of priorBatch) {
                openingTotalBalance += this.computeTotalBalanceDelta(tx.type, tx.balanceBefore, tx.balanceAfter);
            }
            priorLastId = priorBatch[priorBatch.length - 1].id;
            priorLastCreatedAt = priorBatch[priorBatch.length - 1].createdAt;
            if (priorBatch.length < PRIOR_BATCH_SIZE)
                break;
        }
        const RANGE_BATCH_SIZE = 5000;
        const rows = [];
        let runningTotalBalance = openingTotalBalance;
        let rangeLastId;
        let rangeLastCreatedAt;
        for (;;) {
            const batch = await this.prisma.walletTransaction.findMany({
                where: {
                    walletId: wallet.id,
                    status: client_1.WalletTransactionStatus.SUCCESS,
                    createdAt: { gte: fromDate, lte: toDate },
                    ...(rangeLastCreatedAt
                        ? {
                            OR: [
                                { createdAt: { gt: rangeLastCreatedAt } },
                                { createdAt: rangeLastCreatedAt, id: { gt: rangeLastId } },
                            ],
                        }
                        : {}),
                },
                take: RANGE_BATCH_SIZE,
                orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
                select: {
                    id: true,
                    txId: true,
                    type: true,
                    status: true,
                    amount: true,
                    balanceBefore: true,
                    balanceAfter: true,
                    description: true,
                    createdAt: true,
                },
            });
            if (batch.length === 0)
                break;
            for (const tx of batch) {
                const delta = this.computeTotalBalanceDelta(tx.type, tx.balanceBefore, tx.balanceAfter);
                runningTotalBalance += delta;
                rows.push({
                    txId: tx.txId,
                    type: tx.type,
                    status: tx.status,
                    amount: (0, currency_util_1.toIdr)(tx.amount),
                    balanceBefore: (0, currency_util_1.toIdr)(tx.balanceBefore),
                    balanceAfter: (0, currency_util_1.toIdr)(tx.balanceAfter),
                    totalBalanceDelta: (0, currency_util_1.toIdr)(delta),
                    runningTotalBalance: (0, currency_util_1.toIdr)(runningTotalBalance),
                    description: tx.description,
                    createdAt: tx.createdAt,
                });
            }
            rangeLastId = batch[batch.length - 1].id;
            rangeLastCreatedAt = batch[batch.length - 1].createdAt;
            if (batch.length < RANGE_BATCH_SIZE)
                break;
        }
        return {
            userId,
            from,
            to,
            openingTotalBalance: (0, currency_util_1.toIdr)(openingTotalBalance),
            closingTotalBalance: (0, currency_util_1.toIdr)(runningTotalBalance),
            transactions: rows,
        };
    }
    computeTotalBalanceDelta(type, balanceBefore, balanceAfter) {
        if (type === client_1.WalletTransactionType.ORDER_LOCK) {
            return BigInt(0);
        }
        return balanceAfter - balanceBefore;
    }
    async reconcileWallet(wallet) {
        const BATCH_SIZE = 5000;
        let expectedTotal = BigInt(0);
        let lastId;
        for (;;) {
            const transactions = await this.prisma.walletTransaction.findMany({
                where: {
                    walletId: wallet.id,
                    OR: [
                        { status: client_1.WalletTransactionStatus.SUCCESS },
                        {
                            type: client_1.WalletTransactionType.WITHDRAW,
                            withdrawStatus: {
                                in: [
                                    client_1.WithdrawStatus.PENDING_OTP,
                                    client_1.WithdrawStatus.PENDING_PROCESS,
                                    client_1.WithdrawStatus.PROCESSING,
                                ],
                            },
                        },
                    ],
                },
                ...(lastId ? { cursor: { id: lastId }, skip: 1 } : {}),
                take: BATCH_SIZE,
                orderBy: { id: 'asc' },
                select: { id: true, type: true, balanceBefore: true, balanceAfter: true },
            });
            if (transactions.length === 0)
                break;
            for (const tx of transactions) {
                expectedTotal += this.computeTotalBalanceDelta(tx.type, tx.balanceBefore, tx.balanceAfter);
            }
            lastId = transactions[transactions.length - 1].id;
            if (transactions.length < BATCH_SIZE)
                break;
        }
        const invariantViolation = wallet.availableBalance + wallet.escrowBalance !== wallet.totalBalance;
        const balanceMismatch = wallet.totalBalance !== expectedTotal;
        if (!balanceMismatch && !invariantViolation) {
            return null;
        }
        return {
            walletId: wallet.id,
            userId: wallet.userId,
            actualAvailable: (0, currency_util_1.toIdr)(wallet.availableBalance),
            actualEscrow: (0, currency_util_1.toIdr)(wallet.escrowBalance),
            actualTotal: (0, currency_util_1.toIdr)(wallet.totalBalance),
            expectedTotal: (0, currency_util_1.toIdr)(expectedTotal),
            discrepancy: (0, currency_util_1.toIdr)(wallet.totalBalance - expectedTotal),
            invariantViolation,
        };
    }
};
exports.ReconciliationService = ReconciliationService;
exports.ReconciliationService = ReconciliationService = ReconciliationService_1 = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [prisma_service_1.PrismaService])
], ReconciliationService);
