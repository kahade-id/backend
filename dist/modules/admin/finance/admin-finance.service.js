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
var AdminFinanceService_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.AdminFinanceService = void 0;
const common_1 = require("@nestjs/common");
const prisma_service_1 = require("../../../prisma/prisma.service");
const client_1 = require("@prisma/client");
const pagination_dto_1 = require("../../../common/dto/pagination.dto");
const ErrorCodes = __importStar(require("../../../common/constants/error-codes"));
const audit_log_service_1 = require("../../../common/services/audit-log.service");
const midtrans_service_1 = require("../../../modules/payment/midtrans.service");
const crypto_util_1 = require("../../../common/utils/crypto.util");
const currency_util_1 = require("../../../common/utils/currency.util");
const date_util_1 = require("../../../common/utils/date.util");
let AdminFinanceService = AdminFinanceService_1 = class AdminFinanceService {
    sanitizeAdminNote(note) {
        return (note ?? '')
            .replace(/[\u0000-\u001F\u007F]/g, ' ')
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, 1000);
    }
    constructor(prisma, auditLog, midtransService) {
        this.prisma = prisma;
        this.auditLog = auditLog;
        this.midtransService = midtransService;
        this.logger = new common_1.Logger(AdminFinanceService_1.name);
    }
    async listTransactions(query) {
        const { page = 1, limit = 20, type, status, startDate, endDate } = query;
        const safePage = Number.isInteger(page) && page > 0 ? page : 1;
        const safeLimit = Number.isInteger(limit) && limit > 0 ? Math.min(limit, 100) : 20;
        if (!startDate || !endDate) {
            throw new common_1.BadRequestException({
                code: ErrorCodes.INVALID_DATE_RANGE,
                message: 'startDate and endDate are mandatory for transaction listing',
            });
        }
        const start = (0, date_util_1.parseDateBoundaryWIB)(startDate, 'start');
        const end = (0, date_util_1.parseDateBoundaryWIB)(endDate, 'end');
        if (!start || !end) {
            throw new common_1.BadRequestException({
                code: ErrorCodes.INVALID_DATE_RANGE,
                message: 'startDate and endDate must be valid ISO date strings',
            });
        }
        if (start.getTime() > end.getTime()) {
            throw new common_1.BadRequestException({
                code: ErrorCodes.INVALID_DATE_RANGE,
                message: 'startDate must be before or equal to endDate',
            });
        }
        const diffDays = Math.ceil((end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24));
        if (diffDays > 90) {
            throw new common_1.BadRequestException({
                code: ErrorCodes.DATE_RANGE_TOO_LARGE,
                message: 'Date range cannot exceed 90 days',
            });
        }
        const where = {};
        if (type) {
            where.type = type;
        }
        if (status) {
            where.status = status;
        }
        if (startDate || endDate) {
            where.createdAt = {};
            if (startDate)
                where.createdAt.gte = start;
            if (endDate)
                where.createdAt.lte = end;
        }
        const [transactions, total] = await Promise.all([
            this.prisma.walletTransaction.findMany({
                where,
                orderBy: { createdAt: 'desc' },
                skip: (safePage - 1) * safeLimit,
                take: safeLimit,
                include: {
                    wallet: {
                        select: {
                            userId: true,
                            user: { select: { userId: true, fullName: true, email: true } },
                        },
                    },
                    order: { select: { id: true, orderId: true } },
                    bankAccount: { select: { id: true, bankCode: true } },
                },
            }),
            this.prisma.walletTransaction.count({ where }),
        ]);
        const serialized = transactions.map(tx => ({
            ...tx,
            amount: (0, currency_util_1.toIdr)(tx.amount),
            balanceBefore: (0, currency_util_1.toIdr)(tx.balanceBefore),
            balanceAfter: (0, currency_util_1.toIdr)(tx.balanceAfter),
        }));
        return (0, pagination_dto_1.createPaginatedResponse)(serialized, total, safePage, safeLimit);
    }
    async getTransactionDetail(txId, adminId, ipAddress = 'unknown') {
        const tx = await this.prisma.walletTransaction.findFirst({
            where: { txId },
            include: {
                wallet: {
                    select: {
                        userId: true,
                        user: { select: { userId: true, fullName: true, email: true } },
                    },
                },
                order: { select: { id: true, orderId: true, status: true } },
                bankAccount: {
                    select: { id: true, bankCode: true, accountName: true, accountNumber: true },
                },
                paymentTx: { select: { id: true, midtransOrderId: true, method: true, status: true } },
            },
        });
        if (!tx) {
            throw new common_1.NotFoundException({
                code: ErrorCodes.NOT_FOUND,
                message: 'Transaction not found',
            });
        }
        const result = {
            ...tx,
            amount: (0, currency_util_1.toIdr)(tx.amount),
            balanceBefore: (0, currency_util_1.toIdr)(tx.balanceBefore),
            balanceAfter: (0, currency_util_1.toIdr)(tx.balanceAfter),
        };
        if (result.bankAccount) {
            let maskedNumber = '****';
            try {
                const plain = await (0, crypto_util_1.decryptAES)(result.bankAccount.accountNumber);
                maskedNumber = `****${plain.slice(-4)}`;
                this.auditLog.logAdminAction({
                    adminId,
                    action: client_1.AuditAction.ADMIN_ACTION,
                    targetType: 'BankAccount',
                    targetId: result.bankAccount.id ?? 'unknown',
                    description: 'Bank account number decrypted for withdrawal detail view',
                    ipAddress,
                });
            }
            catch (decryptErr) {
                this.logger.warn(`Failed to decrypt bank account number for withdrawal detail: ${decryptErr.message}`);
            }
            let decryptedName = result.bankAccount.accountName;
            try {
                decryptedName = await (0, crypto_util_1.decryptAES)(result.bankAccount.accountName);
            }
            catch {
            }
            result.bankAccount = {
                ...result.bankAccount,
                accountNumber: maskedNumber,
                accountName: decryptedName,
            };
        }
        return result;
    }
    async getFinancialSummary() {
        const todayStart = (0, date_util_1.startOfDayWIB)();
        const monthStart = (0, date_util_1.toWIB)().startOf('month').toDate();
        const [topupResult, withdrawResult, feeResult, feeToday, feeThisMonth, withdrawToday, escrowResult, pendingWithdrawResult,] = await Promise.all([
            this.prisma.walletTransaction.aggregate({
                where: { type: 'TOP_UP', status: 'SUCCESS' },
                _sum: { amount: true },
                _count: true,
            }),
            this.prisma.walletTransaction.aggregate({
                where: { type: 'WITHDRAW', status: 'SUCCESS' },
                _sum: { amount: true },
                _count: true,
            }),
            this.prisma.order.aggregate({
                where: { status: 'COMPLETED' },
                _sum: { feeAmount: true },
                _count: true,
            }),
            this.prisma.order.aggregate({
                where: { status: 'COMPLETED', completedAt: { gte: todayStart } },
                _sum: { feeAmount: true },
            }),
            this.prisma.order.aggregate({
                where: { status: 'COMPLETED', completedAt: { gte: monthStart } },
                _sum: { feeAmount: true },
            }),
            this.prisma.walletTransaction.aggregate({
                where: { type: 'WITHDRAW', status: 'SUCCESS', createdAt: { gte: todayStart } },
                _sum: { amount: true },
            }),
            this.prisma.wallet.aggregate({
                _sum: { escrowBalance: true },
            }),
            this.prisma.walletTransaction.aggregate({
                where: {
                    type: 'WITHDRAW',
                    withdrawStatus: { in: ['PENDING_OTP', 'PENDING_PROCESS', 'PROCESSING'] },
                },
                _sum: { amount: true },
                _count: true,
            }),
        ]);
        return {
            totalTopup: (0, currency_util_1.toIdr)(topupResult._sum.amount ?? BigInt(0)),
            totalTopupCount: topupResult._count,
            totalWithdrawal: (0, currency_util_1.toIdr)(withdrawResult._sum.amount ?? BigInt(0)),
            totalWithdrawalCount: withdrawResult._count,
            totalFees: (0, currency_util_1.toIdr)(feeResult._sum.feeAmount ?? BigInt(0)),
            totalFeeCount: feeResult._count,
            totalPlatformFeeToday: (0, currency_util_1.toIdr)(feeToday._sum.feeAmount ?? BigInt(0)),
            totalPlatformFeeThisMonth: (0, currency_util_1.toIdr)(feeThisMonth._sum.feeAmount ?? BigInt(0)),
            totalWithdrawalsToday: (0, currency_util_1.toIdr)(withdrawToday._sum.amount ?? BigInt(0)),
            totalEscrowBalance: (0, currency_util_1.toIdr)(escrowResult._sum.escrowBalance ?? BigInt(0)),
            pendingWithdrawals: pendingWithdrawResult._count,
            pendingWithdrawalsAmount: (0, currency_util_1.toIdr)(pendingWithdrawResult._sum.amount ?? BigInt(0)),
        };
    }
    async listPendingWithdrawals(page = 1, limit = 20, adminId, ipAddress = 'unknown') {
        const safeLimit = Math.min(limit, 100);
        const where = {
            type: 'WITHDRAW',
            withdrawStatus: { in: ['PENDING_OTP', 'PENDING_PROCESS', 'PROCESSING'] },
        };
        const [withdrawals, total] = await Promise.all([
            this.prisma.walletTransaction.findMany({
                where,
                orderBy: { createdAt: 'asc' },
                skip: (page - 1) * safeLimit,
                take: safeLimit,
                include: {
                    wallet: {
                        select: {
                            userId: true,
                            user: { select: { userId: true, fullName: true, email: true } },
                        },
                    },
                    bankAccount: {
                        select: { id: true, bankCode: true, accountName: true, accountNumber: true },
                    },
                },
            }),
            this.prisma.walletTransaction.count({ where }),
        ]);
        const serialized = await Promise.all(withdrawals.map(async (tx) => {
            let maskedAccountNumber = null;
            if (tx.bankAccount) {
                try {
                    const plain = await (0, crypto_util_1.decryptAES)(tx.bankAccount.accountNumber);
                    maskedAccountNumber = `****${plain.slice(-4)}`;
                    this.auditLog.logAdminAction({
                        adminId,
                        action: client_1.AuditAction.ADMIN_ACTION,
                        targetType: 'BankAccount',
                        targetId: tx.bankAccount.id ?? 'unknown',
                        description: 'Bank account number decrypted for withdrawal list view',
                        ipAddress,
                    });
                }
                catch {
                    maskedAccountNumber = '****';
                }
            }
            let decryptedAccName = tx.bankAccount?.accountName ?? null;
            if (tx.bankAccount?.accountName) {
                try {
                    decryptedAccName = await (0, crypto_util_1.decryptAES)(tx.bankAccount.accountName);
                }
                catch {
                }
            }
            return {
                ...tx,
                amount: (0, currency_util_1.toIdr)(tx.amount),
                balanceBefore: (0, currency_util_1.toIdr)(tx.balanceBefore),
                balanceAfter: (0, currency_util_1.toIdr)(tx.balanceAfter),
                bankAccount: tx.bankAccount
                    ? {
                        ...tx.bankAccount,
                        accountNumber: maskedAccountNumber,
                        accountName: decryptedAccName,
                    }
                    : tx.bankAccount,
            };
        }));
        return (0, pagination_dto_1.createPaginatedResponse)(serialized, total, page, safeLimit);
    }
    async approveWithdrawal(txId, dto, adminId, ipAddress = 'internal') {
        const adminNote = this.sanitizeAdminNote(dto.adminNote);
        const tx = await this.prisma.walletTransaction.findFirst({
            where: { txId },
            include: { wallet: true, bankAccount: true },
        });
        if (!tx) {
            throw new common_1.NotFoundException({
                code: ErrorCodes.NOT_FOUND,
                message: 'Transaction not found',
            });
        }
        if (tx.type !== 'WITHDRAW' || tx.withdrawStatus !== 'PENDING_PROCESS') {
            throw new common_1.BadRequestException({
                code: ErrorCodes.INVALID_STATUS,
                message: 'Transaction is not a pending withdrawal',
            });
        }
        if (!tx.bankAccount) {
            throw new common_1.BadRequestException({
                code: ErrorCodes.INVALID_STATUS,
                message: 'Withdrawal has no attached bank account -- cannot approve. Ask user to re-submit with a valid bank account.',
            });
        }
        const txUpdate = await this.prisma.walletTransaction.updateMany({
            where: {
                id: tx.id,
                withdrawStatus: 'PENDING_PROCESS',
            },
            data: {
                withdrawStatus: 'PROCESSING',
                description: `Processing by admin ${adminId} at ${new Date().toISOString()}`,
            },
        });
        if (txUpdate.count === 0) {
            throw new common_1.ConflictException({
                code: ErrorCodes.OPTIMISTIC_LOCK_CONFLICT,
                message: 'Withdrawal was already processed by another admin, please refresh',
            });
        }
        try {
            const plainAccountNumber = await (0, crypto_util_1.decryptAES)(tx.bankAccount.accountNumber);
            this.auditLog.logAdminAction({
                adminId,
                action: client_1.AuditAction.ADMIN_ACTION,
                targetType: 'BankAccount',
                targetId: tx.bankAccount.id ?? 'unknown',
                description: `Bank account number decrypted for payout processing (tx: ${tx.txId})`,
                ipAddress,
            });
            let beneficiaryName = tx.bankAccount.accountName;
            try {
                beneficiaryName = await (0, crypto_util_1.decryptAES)(tx.bankAccount.accountName);
            }
            catch {
            }
            await this.midtransService.createIrisPayout({
                referenceNo: tx.txId,
                beneficiaryName,
                beneficiaryAccount: plainAccountNumber,
                beneficiaryBank: tx.bankAccount.bankCode,
                amount: (0, currency_util_1.toIdr)(tx.amount),
            });
            await this.prisma.walletTransaction.update({
                where: { id: tx.id },
                data: {
                    description: adminNote
                        ? `Approved by admin ${adminId}: ${adminNote} — awaiting Iris confirmation`
                        : `Approved by admin ${adminId} — awaiting Iris confirmation`,
                },
            });
        }
        catch (payoutError) {
            this.logger.error(`Payout failed for txId=${tx.txId ?? tx.id}: ${payoutError instanceof Error ? payoutError.message : String(payoutError)}`);
            await this.prisma.walletTransaction.updateMany({
                where: { id: tx.id, withdrawStatus: 'PROCESSING' },
                data: {
                    description: adminNote
                        ? `Approved by admin ${adminId}: ${adminNote} — payout submission outcome pending reconciliation`
                        : `Approved by admin ${adminId} — payout submission outcome pending reconciliation`,
                },
            });
            await this.auditLog.logAdminAction({
                adminId,
                action: client_1.AuditAction.ADMIN_ACTION,
                targetType: 'WalletTransaction',
                targetId: tx.id,
                description: `Withdrawal payout submission could not be confirmed for ${tx.txId ?? tx.id}; retained in PROCESSING for Iris reconciliation`,
                ipAddress,
            });
            throw new common_1.ServiceUnavailableException({
                code: ErrorCodes.PAYOUT_FAILED,
                message: 'Payout submission could not be confirmed. The withdrawal remains in processing while provider status is reconciled.',
            });
        }
        const updated = await this.prisma.walletTransaction.findUniqueOrThrow({ where: { id: tx.id } });
        await this.auditLog.logAdminAction({
            adminId,
            action: client_1.AuditAction.ADMIN_ACTION,
            targetType: 'WalletTransaction',
            targetId: tx.id,
            description: `Approved withdrawal payout ${tx.txId ?? tx.id}`,
            ipAddress,
        });
        return {
            ...updated,
            amount: (0, currency_util_1.toIdr)(updated.amount),
            balanceBefore: (0, currency_util_1.toIdr)(updated.balanceBefore),
            balanceAfter: (0, currency_util_1.toIdr)(updated.balanceAfter),
        };
    }
    async rejectWithdrawal(txId, dto, adminId, ipAddress = 'internal') {
        const adminNote = this.sanitizeAdminNote(dto.adminNote);
        const tx = await this.prisma.walletTransaction.findFirst({
            where: { txId },
            include: { wallet: true },
        });
        if (!tx) {
            throw new common_1.NotFoundException({
                code: ErrorCodes.NOT_FOUND,
                message: 'Transaction not found',
            });
        }
        if (tx.type !== 'WITHDRAW' || tx.withdrawStatus !== 'PENDING_PROCESS') {
            throw new common_1.BadRequestException({
                code: ErrorCodes.INVALID_STATUS,
                message: 'Transaction is not a pending withdrawal',
            });
        }
        const updated = await this.prisma.$transaction(async (ptx) => {
            const txClaim = await ptx.walletTransaction.updateMany({
                where: {
                    id: tx.id,
                    withdrawStatus: 'PENDING_PROCESS',
                },
                data: {
                    withdrawStatus: 'FAILED',
                    status: 'FAILED',
                    description: adminNote
                        ? `Rejected by admin ${adminId}: ${adminNote}`
                        : `Rejected by admin ${adminId}`,
                },
            });
            if (txClaim.count === 0) {
                throw new common_1.ConflictException({
                    code: ErrorCodes.OPTIMISTIC_LOCK_CONFLICT,
                    message: 'Withdrawal was already processed by another admin, please refresh',
                });
            }
            const freshWallet = await ptx.wallet.findUnique({ where: { id: tx.walletId } });
            if (!freshWallet) {
                throw new common_1.NotFoundException({ code: ErrorCodes.NOT_FOUND, message: 'Wallet not found' });
            }
            const todayStart = (0, date_util_1.startOfDayWIB)();
            const isToday = tx.createdAt >= todayStart;
            const withdrawRollback = isToday
                ? freshWallet.todayWithdrawAmount >= tx.amount
                    ? { decrement: tx.amount }
                    : { set: BigInt(0) }
                : undefined;
            const walletUpdate = await ptx.wallet.updateMany({
                where: { id: tx.walletId, version: freshWallet.version },
                data: {
                    availableBalance: { increment: tx.amount },
                    totalBalance: { increment: tx.amount },
                    ...(withdrawRollback !== undefined ? { todayWithdrawAmount: withdrawRollback } : {}),
                    version: { increment: 1 },
                },
            });
            if (walletUpdate.count === 0) {
                throw new common_1.ConflictException({
                    code: ErrorCodes.OPTIMISTIC_LOCK_CONFLICT,
                    message: 'Wallet was modified concurrently, please retry',
                });
            }
            return ptx.walletTransaction.findUniqueOrThrow({ where: { id: tx.id } });
        }, { isolationLevel: client_1.Prisma.TransactionIsolationLevel.Serializable });
        await this.auditLog.logAdminAction({
            adminId,
            action: client_1.AuditAction.ADMIN_ACTION,
            targetType: 'WalletTransaction',
            targetId: tx.id,
            description: `Rejected withdrawal ${tx.txId ?? tx.id} (refunded to user)${adminNote ? ': ' + adminNote : ''}`,
            ipAddress,
        });
        return {
            ...updated,
            amount: (0, currency_util_1.toIdr)(updated.amount),
            balanceBefore: (0, currency_util_1.toIdr)(updated.balanceBefore),
            balanceAfter: (0, currency_util_1.toIdr)(updated.balanceAfter),
        };
    }
    logReconciliation(adminId, userId, clean, ipAddress) {
        this.auditLog.logAdminAction({
            adminId,
            action: client_1.AuditAction.ADMIN_ACTION,
            targetType: 'Wallet',
            targetId: userId,
            description: `Admin reconciled wallet for user ${userId} — ${clean ? 'clean' : 'discrepancy found'}`,
            after: { clean },
            ipAddress,
        });
    }
    async getEscrowSummary() {
        const [escrowAgg, activeEscrowOrders] = await Promise.all([
            this.prisma.wallet.aggregate({
                where: { escrowBalance: { gt: 0 } },
                _sum: { escrowBalance: true },
                _count: true,
            }),
            this.prisma.order.count({
                where: { status: { in: ['PROCESSING', 'IN_DELIVERY', 'DISPUTED'] } },
            }),
        ]);
        return {
            totalEscrowBalance: (0, currency_util_1.toIdr)(escrowAgg._sum.escrowBalance ?? BigInt(0)),
            walletsWithEscrow: escrowAgg._count,
            activeEscrowOrders,
        };
    }
    async getRevenue() {
        const [feeResult, subscriptionResult, monthlyRevenue] = await Promise.all([
            this.prisma.order.aggregate({
                where: { status: 'COMPLETED' },
                _sum: { feeAmount: true },
                _count: true,
            }),
            this.prisma.walletTransaction.aggregate({
                where: { type: 'SUBSCRIPTION_PAYMENT', status: 'SUCCESS' },
                _sum: { amount: true },
                _count: true,
            }),
            this.prisma.$queryRaw `
        SELECT DATE_TRUNC('month', "completedAt") as month,
               COALESCE(SUM("feeAmount"), 0)::bigint as total,
               COUNT(*)::bigint as count,
               'fee'::text as source
        FROM orders
        WHERE status = 'COMPLETED'
          AND "completedAt" IS NOT NULL
        GROUP BY DATE_TRUNC('month', "completedAt")
        UNION ALL
        SELECT DATE_TRUNC('month', "createdAt") as month,
               COALESCE(SUM(amount), 0)::bigint as total,
               COUNT(*)::bigint as count,
               'subscription'::text as source
        FROM wallet_transactions
        WHERE type = 'SUBSCRIPTION_PAYMENT'
          AND status = 'SUCCESS'
        GROUP BY DATE_TRUNC('month', "createdAt")
        ORDER BY month DESC, source ASC
        LIMIT 48
      `,
        ]);
        const totalFeeRevenue = (0, currency_util_1.toIdr)(feeResult._sum.feeAmount ?? BigInt(0));
        const totalSubscriptionRevenue = (0, currency_util_1.toIdr)(subscriptionResult._sum.amount ?? BigInt(0));
        const totalRevenue = (0, currency_util_1.toIdr)((feeResult._sum.feeAmount ?? BigInt(0)) + (subscriptionResult._sum.amount ?? BigInt(0)));
        return {
            totalRevenue,
            breakdown: {
                transactionFees: {
                    total: totalFeeRevenue,
                    count: feeResult._count,
                },
                subscriptionPayments: {
                    total: totalSubscriptionRevenue,
                    count: subscriptionResult._count,
                },
            },
            monthlyRevenue: monthlyRevenue.map(row => ({
                month: row.month,
                total: (0, currency_util_1.toIdr)(row.total),
                count: Number(row.count),
                source: row.source,
            })),
        };
    }
};
exports.AdminFinanceService = AdminFinanceService;
exports.AdminFinanceService = AdminFinanceService = AdminFinanceService_1 = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [prisma_service_1.PrismaService,
        audit_log_service_1.AuditLogService,
        midtrans_service_1.MidtransService])
], AdminFinanceService);
