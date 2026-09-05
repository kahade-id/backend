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
var BankAccountsService_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.BankAccountsService = void 0;
const client_1 = require("@prisma/client");
const common_1 = require("@nestjs/common");
const config_1 = require("@nestjs/config");
const prisma_service_1 = require("../../prisma/prisma.service");
const midtrans_service_1 = require("../payment/midtrans.service");
const crypto_util_1 = require("../../common/utils/crypto.util");
const ErrorCodes = __importStar(require("../../common/constants/error-codes"));
const app_constants_1 = require("../../common/constants/app.constants");
const BANK_ACCOUNT_LENGTH = {
    [client_1.BankCode.BCA]: { min: 10, max: 10 },
    [client_1.BankCode.BNI]: { min: 10, max: 10 },
    [client_1.BankCode.BRI]: { min: 10, max: 15 },
    [client_1.BankCode.MANDIRI]: { min: 10, max: 13 },
    [client_1.BankCode.CIMB]: { min: 10, max: 13 },
    [client_1.BankCode.BSI]: { min: 10, max: 12 },
    [client_1.BankCode.MAYBANK]: { min: 12, max: 12 },
};
function validateBankAccountLength(bankCode, accountNumber) {
    const rule = BANK_ACCOUNT_LENGTH[bankCode];
    if (!rule)
        return;
    const len = accountNumber.length;
    if (len < rule.min || len > rule.max) {
        const rangeDesc = rule.min === rule.max ? `${rule.min}` : `${rule.min}–${rule.max}`;
        throw new common_1.BadRequestException({
            code: 'BANK_ACCOUNT_NUMBER_LENGTH',
            message: `Account number for ${bankCode} must be ${rangeDesc} digits (received: ${len} digits)`,
        });
    }
}
const MAX_NAME_LENGTH_FOR_SIMILARITY = 100;
function nameSimilarity(a, b) {
    const na = a.toUpperCase().trim().replace(/\s+/g, ' ').slice(0, MAX_NAME_LENGTH_FOR_SIMILARITY);
    const nb = b.toUpperCase().trim().replace(/\s+/g, ' ').slice(0, MAX_NAME_LENGTH_FOR_SIMILARITY);
    if (na === nb)
        return 1;
    const maxLen = Math.max(na.length, nb.length);
    if (maxLen === 0)
        return 1;
    const matrix = [];
    for (let i = 0; i <= na.length; i++) {
        matrix[i] = [i];
        for (let j = 1; j <= nb.length; j++) {
            if (i === 0) {
                matrix[i][j] = j;
            }
            else {
                const cost = na[i - 1] === nb[j - 1] ? 0 : 1;
                matrix[i][j] = Math.min(matrix[i - 1][j] + 1, matrix[i][j - 1] + 1, matrix[i - 1][j - 1] + cost);
            }
        }
    }
    return 1 - matrix[na.length][nb.length] / maxLen;
}
const NAME_SIMILARITY_THRESHOLD = 0.8;
let BankAccountsService = BankAccountsService_1 = class BankAccountsService {
    constructor(prisma, midtransService, configService) {
        this.prisma = prisma;
        this.midtransService = midtransService;
        this.configService = configService;
        this.logger = new common_1.Logger(BankAccountsService_1.name);
    }
    async listBankAccounts(userId) {
        const accounts = await this.prisma.bankAccount.findMany({
            where: { userId, deletedAt: null },
            orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }],
            select: {
                id: true,
                bankCode: true,
                bankName: true,
                accountName: true,
                accountNumber: true,
                isPrimary: true,
                isVerified: true,
                createdAt: true,
            },
            take: app_constants_1.MAX_BANK_ACCOUNTS,
        });
        const result = await Promise.all(accounts.map(async (acc) => {
            let maskedAccountNumber = '****';
            let decryptedAccountName = 'Bank account';
            try {
                const plain = await (0, crypto_util_1.decryptAES)(acc.accountNumber);
                maskedAccountNumber = `****${plain.slice(-4)}`;
            }
            catch {
            }
            try {
                decryptedAccountName = await (0, crypto_util_1.decryptAES)(acc.accountName);
            }
            catch {
            }
            const { accountNumber: _omit, accountName: _omitName, ...rest } = acc;
            return { ...rest, accountName: decryptedAccountName, maskedAccountNumber };
        }));
        return { bankAccounts: result };
    }
    async addBankAccount(userId, bankCode, bankName, accountNumber, accountName) {
        const existingCount = await this.prisma.bankAccount.count({
            where: { userId, deletedAt: null },
        });
        if (existingCount >= app_constants_1.MAX_BANK_ACCOUNTS) {
            throw new common_1.BadRequestException({
                code: ErrorCodes.MAX_BANK_ACCOUNTS_REACHED,
                message: `Maximum of ${app_constants_1.MAX_BANK_ACCOUNTS} bank accounts allowed`,
            });
        }
        const normalizedAccountNumber = accountNumber.trim().replace(/\s+/g, '');
        validateBankAccountLength(bankCode, normalizedAccountNumber);
        const accountNumberHash = (0, crypto_util_1.hmacSHA256)(`${bankCode}:${normalizedAccountNumber}`);
        const duplicate = await this.prisma.bankAccount.findFirst({
            where: { accountNumberHash, deletedAt: null },
            select: { userId: true },
        });
        if (duplicate) {
            throw new common_1.BadRequestException({
                code: 'BANK_ACCOUNT_DUPLICATE',
                message: 'This bank account is already registered',
            });
        }
        let verifiedAccountName = accountName;
        let isVerified = false;
        const nodeEnv = this.configService.get('app.nodeEnv') ?? 'development';
        const skipVerification = nodeEnv !== 'production' &&
            (this.configService.get('app.skipBankVerification') ?? false);
        if (!skipVerification) {
            try {
                const inquiry = await this.midtransService.inquireBankAccount(bankCode, normalizedAccountNumber);
                const returnedAccountNumber = String(inquiry.accountNo ?? '')
                    .trim()
                    .replace(/\s+/g, '');
                if (!returnedAccountNumber || returnedAccountNumber !== normalizedAccountNumber) {
                    this.logger.error(`Bank inquiry account number mismatch for bank=${bankCode}; refusing verification`);
                    throw new common_1.BadRequestException({
                        code: 'BANK_ACCOUNT_NUMBER_MISMATCH',
                        message: 'Bank account verification response does not match the requested account.',
                    });
                }
                verifiedAccountName = inquiry.accountName;
                const similarity = nameSimilarity(accountName, verifiedAccountName);
                this.logger.log(`Bank account name similarity: ${(similarity * 100).toFixed(1)}% for bank=${bankCode}`);
                if (similarity < NAME_SIMILARITY_THRESHOLD) {
                    throw new common_1.BadRequestException({
                        code: 'BANK_ACCOUNT_NAME_MISMATCH',
                        message: 'Account name does not match bank records',
                    });
                }
                isVerified = true;
            }
            catch (err) {
                if (err instanceof common_1.BadRequestException) {
                    throw err;
                }
                this.logger.warn(`Bank verification unavailable, adding unverified account: ${err.message}`);
                isVerified = false;
            }
        }
        const encryptedAccountNumber = await (0, crypto_util_1.encryptAES)(normalizedAccountNumber);
        const encryptedAccountName = await (0, crypto_util_1.encryptAES)(verifiedAccountName);
        const SELECT_SHAPE = {
            id: true,
            bankCode: true,
            bankName: true,
            accountName: true,
            isPrimary: true,
            isVerified: true,
            createdAt: true,
        };
        const created = await this.prisma
            .$transaction(async (tx) => {
            const activeCount = await tx.bankAccount.count({ where: { userId, deletedAt: null } });
            if (activeCount >= app_constants_1.MAX_BANK_ACCOUNTS) {
                throw new common_1.BadRequestException({
                    code: ErrorCodes.MAX_BANK_ACCOUNTS_REACHED,
                    message: `Maximum of ${app_constants_1.MAX_BANK_ACCOUNTS} bank accounts allowed`,
                });
            }
            const existing = await tx.bankAccount.findFirst({
                where: { accountNumberHash },
                select: { id: true, userId: true, deletedAt: true },
            });
            if (existing && (existing.deletedAt === null || existing.userId !== userId)) {
                throw new common_1.BadRequestException({
                    code: 'BANK_ACCOUNT_DUPLICATE',
                    message: 'This bank account is already registered',
                });
            }
            const isFirstAccount = activeCount === 0;
            if (existing) {
                return tx.bankAccount.update({
                    where: { id: existing.id },
                    data: {
                        deletedAt: null,
                        bankCode: bankCode,
                        bankName,
                        accountNumber: encryptedAccountNumber,
                        accountName: encryptedAccountName,
                        isPrimary: isFirstAccount && isVerified,
                        isVerified,
                    },
                    select: SELECT_SHAPE,
                });
            }
            return tx.bankAccount.create({
                data: {
                    userId,
                    bankCode: bankCode,
                    bankName,
                    accountNumber: encryptedAccountNumber,
                    accountNumberHash,
                    accountName: encryptedAccountName,
                    isPrimary: isFirstAccount && isVerified,
                    isVerified,
                },
                select: SELECT_SHAPE,
            });
        }, { isolationLevel: client_1.Prisma.TransactionIsolationLevel.Serializable })
            .catch((err) => {
            if (err instanceof client_1.Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
                throw new common_1.BadRequestException({
                    code: 'BANK_ACCOUNT_DUPLICATE',
                    message: 'This bank account is already registered',
                });
            }
            throw err;
        });
        return { ...created, accountName: verifiedAccountName };
    }
    async deleteBankAccount(userId, bankAccountId) {
        await this.prisma.$transaction(async (tx) => {
            const locked = await tx.$queryRaw `
        SELECT id, "userId", "isPrimary", "deletedAt" FROM bank_accounts
        WHERE id = ${bankAccountId} FOR UPDATE
      `;
            const account = locked[0];
            if (!account || account.userId !== userId || account.deletedAt !== null) {
                throw new common_1.NotFoundException({
                    code: ErrorCodes.BANK_ACCOUNT_NOT_FOUND,
                    message: 'Bank account not found',
                });
            }
            if (account.isPrimary) {
                throw new common_1.BadRequestException({
                    code: ErrorCodes.CANNOT_DELETE_PRIMARY_BANK,
                    message: 'Cannot delete primary bank account. Set another account as primary first.',
                });
            }
            const pendingWithdrawal = await tx.walletTransaction.findFirst({
                where: {
                    bankAccountId,
                    type: client_1.WalletTransactionType.WITHDRAW,
                    status: { in: [client_1.WalletTransactionStatus.PENDING, client_1.WalletTransactionStatus.SUCCESS] },
                    withdrawStatus: {
                        in: [
                            client_1.WithdrawStatus.PENDING_OTP,
                            client_1.WithdrawStatus.PENDING_PROCESS,
                            client_1.WithdrawStatus.PROCESSING,
                        ],
                    },
                },
                select: { id: true },
            });
            if (pendingWithdrawal) {
                throw new common_1.BadRequestException({
                    code: ErrorCodes.BANK_ACCOUNT_HAS_PENDING_WITHDRAWAL,
                    message: 'Cannot delete bank account while a withdrawal is pending or being processed.',
                });
            }
            await tx.bankAccount.update({
                where: { id: bankAccountId },
                data: { deletedAt: new Date() },
            });
            await tx.scheduledWithdrawal.updateMany({
                where: { bankAccountId, isActive: true },
                data: { isActive: false },
            });
        }, { isolationLevel: client_1.Prisma.TransactionIsolationLevel.Serializable });
        return { message: 'Bank account deleted' };
    }
    async setPrimaryBankAccount(userId, bankAccountId) {
        return this.prisma.$transaction(async (tx) => {
            await tx.$queryRaw `
        SELECT id FROM bank_accounts
        WHERE "userId" = ${userId} AND "deletedAt" IS NULL
        ORDER BY id
        FOR UPDATE
      `;
            const account = await tx.bankAccount.findFirst({
                where: { id: bankAccountId, userId, deletedAt: null },
            });
            if (!account) {
                throw new common_1.NotFoundException({
                    code: ErrorCodes.BANK_ACCOUNT_NOT_FOUND,
                    message: 'Bank account not found',
                });
            }
            if (!account.isVerified) {
                throw new common_1.BadRequestException({
                    code: ErrorCodes.BANK_ACCOUNT_NOT_VERIFIED,
                    message: 'Bank account must be verified before it can be used as the primary payout account',
                });
            }
            await tx.bankAccount.updateMany({
                where: { userId, deletedAt: null },
                data: { isPrimary: false },
            });
            const updated = await tx.bankAccount.update({
                where: { id: bankAccountId },
                data: { isPrimary: true },
                select: { id: true, bankCode: true, bankName: true, accountName: true, isPrimary: true },
            });
            let decryptedName = updated.accountName;
            try {
                decryptedName = await (0, crypto_util_1.decryptAES)(updated.accountName);
            }
            catch {
            }
            return { ...updated, accountName: decryptedName };
        }, { isolationLevel: client_1.Prisma.TransactionIsolationLevel.Serializable });
    }
};
exports.BankAccountsService = BankAccountsService;
exports.BankAccountsService = BankAccountsService = BankAccountsService_1 = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [prisma_service_1.PrismaService,
        midtrans_service_1.MidtransService,
        config_1.ConfigService])
], BankAccountsService);
