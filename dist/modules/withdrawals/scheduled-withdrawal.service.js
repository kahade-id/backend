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
var ScheduledWithdrawalService_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.ScheduledWithdrawalService = void 0;
const common_1 = require("@nestjs/common");
const config_1 = require("@nestjs/config");
const client_1 = require("@prisma/client");
const prisma_service_1 = require("../../prisma/prisma.service");
const ErrorCodes = __importStar(require("../../common/constants/error-codes"));
const currency_util_1 = require("../../common/utils/currency.util");
const date_util_1 = require("../../common/utils/date.util");
const id_generator_util_1 = require("../../common/utils/id-generator.util");
const wallet_tx_serial_service_1 = require("../../common/services/wallet-tx-serial.service");
const crypto_util_1 = require("../../common/utils/crypto.util");
const app_constants_1 = require("../../common/constants/app.constants");
const SKIP_PREFIX = 'SKIP_ROLLBACK:';
const MAX_SCHEDULE_MIN_AMOUNT = 100_000_000;
let ScheduledWithdrawalService = ScheduledWithdrawalService_1 = class ScheduledWithdrawalService {
    constructor(prisma, walletTxSerialService, configService) {
        this.prisma = prisma;
        this.walletTxSerialService = walletTxSerialService;
        this.configService = configService;
        this.logger = new common_1.Logger(ScheduledWithdrawalService_1.name);
        this.minWithdraw =
            this.configService.get('app.walletMinWithdraw') ?? app_constants_1.WALLET_MIN_WITHDRAW;
        this.maxWithdrawPerTx =
            this.configService.get('app.walletMaxWithdrawPerTx') ?? app_constants_1.WALLET_MAX_WITHDRAW_PER_TX;
        this.dailyWithdrawLimit =
            this.configService.get('app.walletDailyWithdrawLimit') ?? app_constants_1.WALLET_DAILY_WITHDRAW_LIMIT;
    }
    async getHeldEscrowReleaseAmount(tx, userId) {
        const holdCutoff = new Date(Date.now() - app_constants_1.ESCROW_RELEASE_HOLD_HOURS * 60 * 60 * 1000);
        const recentCompletedOrders = await tx.order.findMany({
            where: {
                sellerId: userId,
                status: 'COMPLETED',
                completedAt: { gt: holdCutoff },
            },
            select: { sellerReceiveAmount: true },
        });
        return recentCompletedOrders.reduce((sum, o) => sum + o.sellerReceiveAmount, BigInt(0));
    }
    async processScheduledWithdrawal(scheduleId) {
        const schedule = await this.prisma.scheduledWithdrawal.findUnique({
            where: { id: scheduleId },
            include: {
                bankAccount: true,
                user: {
                    select: { id: true, isActive: true, isBanned: true, deletedAt: true, kycStatus: true },
                },
            },
        });
        if (!schedule)
            return { skipped: true, reason: 'Schedule not found' };
        if (!schedule.isActive)
            return { skipped: true, reason: 'Schedule is inactive' };
        if (!schedule.user.isActive || schedule.user.isBanned || schedule.user.deletedAt != null)
            return { skipped: true, reason: 'User account is not active' };
        if (!schedule.bankAccount.isVerified)
            return { skipped: true, reason: 'Bank account is not verified' };
        const now = new Date();
        const todayStart = (0, date_util_1.startOfDayWIB)();
        if (schedule.lastExecutedAt && schedule.lastExecutedAt >= todayStart) {
            return { skipped: true, reason: 'Already processed for the current period' };
        }
        const wallet = await this.prisma.wallet.findUnique({ where: { userId: schedule.userId } });
        if (!wallet) {
            this.logger.warn(`No wallet found for scheduled withdrawal ${scheduleId}, user ${schedule.userId}`);
            return { skipped: true, reason: 'Wallet not found' };
        }
        if (wallet.isLocked)
            return { skipped: true, reason: 'Wallet is locked' };
        if (schedule.minAmount > 0n && wallet.availableBalance < schedule.minAmount) {
            return { skipped: true, reason: 'Balance below minimum amount' };
        }
        if (wallet.availableBalance <= 0n)
            return { skipped: true, reason: 'No balance to withdraw' };
        let walletTxId;
        let accountLastFour = '****';
        try {
            const plain = await (0, crypto_util_1.decryptAES)(schedule.bankAccount.accountNumber);
            accountLastFour = plain.slice(-4);
        }
        catch (err) {
            this.logger.warn(`Failed to decrypt bank account for schedule ${scheduleId}: ${err instanceof Error ? err.message : String(err)}`);
        }
        const sanitizedBankName = (schedule.bankAccount.bankName ?? '')
            .replace(/[^\w\s\-&.]/g, '')
            .slice(0, 50);
        const created = await this.prisma
            .$transaction(async (tx) => {
            const lockResult = await tx.$executeRaw `
        UPDATE scheduled_withdrawals
        SET "lastExecutedAt" = ${now}
        WHERE id = ${scheduleId}
          AND "isActive" = true
          AND ("lastExecutedAt" IS NULL OR "lastExecutedAt" < ${todayStart})
      `;
            if (lockResult === 0)
                return false;
            await tx.$queryRaw `SELECT id FROM wallets WHERE id = ${wallet.id} FOR UPDATE`;
            const lockedWallet = await tx.wallet.findUnique({ where: { id: wallet.id } });
            if (!lockedWallet || lockedWallet.isLocked || lockedWallet.availableBalance <= 0n) {
                throw new Error(`${SKIP_PREFIX}Wallet unavailable or empty`);
            }
            const verifiedBankAccount = await tx.bankAccount.findFirst({
                where: {
                    id: schedule.bankAccountId,
                    userId: schedule.userId,
                    deletedAt: null,
                    isVerified: true,
                },
            });
            if (!verifiedBankAccount) {
                throw new Error(`${SKIP_PREFIX}Bank account no longer exists or does not belong to the user`);
            }
            const heldAmount = await this.getHeldEscrowReleaseAmount(tx, schedule.userId);
            const withdrawableBalance = lockedWallet.availableBalance - heldAmount;
            if (withdrawableBalance <= 0n) {
                throw new Error(`${SKIP_PREFIX}All funds are within the escrow holding period`);
            }
            const needsLazyReset = Boolean(lockedWallet.lastLimitResetAt && lockedWallet.lastLimitResetAt < todayStart);
            const effectiveWithdraw = needsLazyReset ? 0n : lockedWallet.todayWithdrawAmount;
            const dailyRemaining = (0, currency_util_1.toSen)(this.dailyWithdrawLimit) - effectiveWithdraw;
            if (dailyRemaining <= 0n) {
                throw new Error(`${SKIP_PREFIX}Daily withdrawal limit already reached`);
            }
            const kycCeiling = schedule.user.kycStatus === client_1.KycStatus.APPROVED ? null : (0, currency_util_1.toSen)(app_constants_1.WALLET_KYC_FREE_LIMIT);
            const ceilings = [
                withdrawableBalance,
                dailyRemaining,
                (0, currency_util_1.toSen)(this.maxWithdrawPerTx),
                ...(kycCeiling === null ? [] : [kycCeiling]),
            ];
            const amount = ceilings.reduce((min, c) => (c < min ? c : min));
            if (schedule.minAmount > 0n && withdrawableBalance < schedule.minAmount) {
                throw new Error(`${SKIP_PREFIX}Balance below the schedule minimum`);
            }
            if (amount < (0, currency_util_1.toSen)(this.minWithdraw)) {
                throw new Error(`${SKIP_PREFIX}Withdrawable amount is below the minimum withdrawal`);
            }
            if (amount <= 0n)
                throw new Error(`${SKIP_PREFIX}Nothing withdrawable`);
            walletTxId = (0, id_generator_util_1.generateWalletTxId)(await this.walletTxSerialService.getNext());
            const updateResult = await tx.wallet.updateMany({
                where: {
                    id: wallet.id,
                    version: lockedWallet.version,
                    availableBalance: { gte: amount },
                },
                data: needsLazyReset
                    ? {
                        availableBalance: { decrement: amount },
                        totalBalance: { decrement: amount },
                        todayTopupAmount: 0n,
                        todayWithdrawAmount: amount,
                        lastLimitResetAt: new Date(),
                        version: { increment: 1 },
                    }
                    : {
                        availableBalance: { decrement: amount },
                        totalBalance: { decrement: amount },
                        todayWithdrawAmount: { increment: amount },
                        version: { increment: 1 },
                    },
            });
            if (updateResult.count === 0)
                throw new Error(`${SKIP_PREFIX}Concurrent wallet update`);
            await tx.walletTransaction.create({
                data: {
                    txId: walletTxId,
                    walletId: wallet.id,
                    type: client_1.WalletTransactionType.WITHDRAW,
                    status: client_1.WalletTransactionStatus.PENDING,
                    amount,
                    balanceBefore: lockedWallet.totalBalance,
                    balanceAfter: lockedWallet.totalBalance - amount,
                    bankAccountId: schedule.bankAccountId,
                    withdrawStatus: client_1.WithdrawStatus.PENDING_PROCESS,
                    description: `Scheduled withdrawal to ${sanitizedBankName} ****${accountLastFour}`,
                    metadata: { scheduledWithdrawalId: scheduleId, automated: true },
                },
            });
            return { ok: true, amount };
        }, { isolationLevel: client_1.Prisma.TransactionIsolationLevel.Serializable })
            .catch((err) => {
            if (err instanceof Error && err.message.startsWith(SKIP_PREFIX)) {
                return { ok: false, reason: err.message.slice(SKIP_PREFIX.length) };
            }
            throw err;
        });
        if (created === false) {
            return { skipped: true, reason: 'Already processed for the current period' };
        }
        if (!created.ok) {
            return { skipped: true, reason: created.reason };
        }
        this.logger.log(`SCHEDULED_WITHDRAW_CREATED schedule=${scheduleId} user=${schedule.userId} txId=${walletTxId} amountSen=${created.amount}`);
        return { skipped: false };
    }
    async createSchedule(userId, dto) {
        if (!Number.isInteger(dto.dayOfWeek) || dto.dayOfWeek < 0 || dto.dayOfWeek > 6) {
            throw new common_1.BadRequestException({
                code: ErrorCodes.INVALID_SCHEDULE,
                message: 'dayOfWeek must be 0 (Sunday) to 6 (Saturday)',
            });
        }
        this.validateScheduleMinimum(dto.minAmount);
        const bankAccount = await this.prisma.bankAccount.findFirst({
            where: { id: dto.bankAccountId, userId, deletedAt: null },
        });
        if (!bankAccount) {
            throw new common_1.NotFoundException({
                code: ErrorCodes.SCHEDULE_NOT_FOUND,
                message: 'Bank account not found or not active',
            });
        }
        if (!bankAccount.isVerified) {
            throw new common_1.BadRequestException({
                code: ErrorCodes.BANK_ACCOUNT_NOT_VERIFIED,
                message: 'Bank account must be verified before scheduling withdrawals',
            });
        }
        const existing = await this.prisma.scheduledWithdrawal.findUnique({
            where: { userId_dayOfWeek: { userId, dayOfWeek: dto.dayOfWeek } },
        });
        if (existing) {
            throw new common_1.BadRequestException({
                code: ErrorCodes.SCHEDULE_ALREADY_EXISTS,
                message: 'Schedule already exists for this day',
            });
        }
        const schedule = await this.prisma.scheduledWithdrawal.create({
            data: {
                userId,
                bankAccountId: dto.bankAccountId,
                dayOfWeek: dto.dayOfWeek,
                minAmount: dto.minAmount === undefined ? 0n : (0, currency_util_1.toSen)(dto.minAmount),
            },
        });
        return this.formatSchedule(schedule);
    }
    async getSchedules(userId) {
        const schedules = await this.prisma.scheduledWithdrawal.findMany({
            where: { userId, isActive: true },
            orderBy: { dayOfWeek: 'asc' },
        });
        return schedules.map(s => this.formatSchedule(s));
    }
    async updateSchedule(userId, scheduleId, dto) {
        const schedule = await this.prisma.scheduledWithdrawal.findUnique({
            where: { id: scheduleId },
        });
        if (!schedule)
            throw new common_1.NotFoundException({
                code: ErrorCodes.SCHEDULE_NOT_FOUND,
                message: 'Schedule not found',
            });
        if (schedule.userId !== userId)
            throw new common_1.ForbiddenException({ code: ErrorCodes.FORBIDDEN, message: 'Not your schedule' });
        const data = {};
        if (dto.dayOfWeek !== undefined) {
            if (!Number.isInteger(dto.dayOfWeek) || dto.dayOfWeek < 0 || dto.dayOfWeek > 6) {
                throw new common_1.BadRequestException({
                    code: ErrorCodes.INVALID_SCHEDULE,
                    message: 'dayOfWeek must be 0 (Sunday) to 6 (Saturday)',
                });
            }
            if (dto.dayOfWeek !== schedule.dayOfWeek) {
                const existing = await this.prisma.scheduledWithdrawal.findUnique({
                    where: { userId_dayOfWeek: { userId, dayOfWeek: dto.dayOfWeek } },
                    select: { id: true },
                });
                if (existing && existing.id !== schedule.id) {
                    throw new common_1.BadRequestException({
                        code: ErrorCodes.SCHEDULE_ALREADY_EXISTS,
                        message: 'Schedule already exists for this day',
                    });
                }
            }
            data.dayOfWeek = dto.dayOfWeek;
        }
        if (dto.minAmount !== undefined) {
            this.validateScheduleMinimum(dto.minAmount);
            data.minAmount = (0, currency_util_1.toSen)(dto.minAmount);
        }
        if (dto.isActive !== undefined)
            data.isActive = dto.isActive;
        if (dto.bankAccountId !== undefined) {
            const bankAccount = await this.prisma.bankAccount.findFirst({
                where: { id: dto.bankAccountId, userId, deletedAt: null },
            });
            if (!bankAccount) {
                throw new common_1.NotFoundException({
                    code: ErrorCodes.SCHEDULE_NOT_FOUND,
                    message: 'Bank account not found or not active',
                });
            }
            if (!bankAccount.isVerified) {
                throw new common_1.BadRequestException({
                    code: ErrorCodes.BANK_ACCOUNT_NOT_VERIFIED,
                    message: 'Bank account must be verified before scheduling withdrawals',
                });
            }
            data.bankAccountId = dto.bankAccountId;
        }
        const updated = await this.prisma.scheduledWithdrawal.update({
            where: { id: scheduleId },
            data,
        });
        return this.formatSchedule(updated);
    }
    async deleteSchedule(userId, scheduleId) {
        const schedule = await this.prisma.scheduledWithdrawal.findUnique({
            where: { id: scheduleId },
        });
        if (!schedule)
            throw new common_1.NotFoundException({
                code: ErrorCodes.SCHEDULE_NOT_FOUND,
                message: 'Schedule not found',
            });
        if (schedule.userId !== userId)
            throw new common_1.ForbiddenException({ code: ErrorCodes.FORBIDDEN, message: 'Not your schedule' });
        await this.prisma.scheduledWithdrawal.update({
            where: { id: scheduleId },
            data: { isActive: false },
        });
        return { message: 'Schedule deactivated' };
    }
    formatSchedule(s) {
        const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
        return {
            id: s.id,
            dayOfWeek: s.dayOfWeek,
            dayName: dayNames[s.dayOfWeek],
            minAmount: (0, currency_util_1.toIdr)(s.minAmount),
            isActive: s.isActive,
            bankAccountId: s.bankAccountId,
            lastExecutedAt: s.lastExecutedAt,
            createdAt: s.createdAt,
        };
    }
    validateScheduleMinimum(minAmount) {
        if (minAmount === undefined)
            return;
        if (!Number.isInteger(minAmount) || minAmount < 1 || minAmount > MAX_SCHEDULE_MIN_AMOUNT) {
            throw new common_1.BadRequestException({
                code: ErrorCodes.INVALID_SCHEDULE,
                message: `minAmount must be an integer from 1 to ${MAX_SCHEDULE_MIN_AMOUNT.toLocaleString('id-ID')}`,
            });
        }
    }
};
exports.ScheduledWithdrawalService = ScheduledWithdrawalService;
exports.ScheduledWithdrawalService = ScheduledWithdrawalService = ScheduledWithdrawalService_1 = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [prisma_service_1.PrismaService,
        wallet_tx_serial_service_1.WalletTxSerialService,
        config_1.ConfigService])
], ScheduledWithdrawalService);
