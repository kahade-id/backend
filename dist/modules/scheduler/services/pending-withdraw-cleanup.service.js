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
var PendingWithdrawCleanupService_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.PendingWithdrawCleanupService = void 0;
const common_1 = require("@nestjs/common");
const schedule_1 = require("@nestjs/schedule");
const crypto_1 = require("crypto");
const client_1 = require("@prisma/client");
const prisma_service_1 = require("../../../prisma/prisma.service");
const redis_service_1 = require("../../../redis/redis.service");
const cron_jitter_util_1 = require("../../../common/utils/cron-jitter.util");
const redis_health_util_1 = require("../../../common/utils/redis-health.util");
const date_util_1 = require("../../../common/utils/date.util");
let PendingWithdrawCleanupService = PendingWithdrawCleanupService_1 = class PendingWithdrawCleanupService {
    constructor(prisma, redis) {
        this.prisma = prisma;
        this.redis = redis;
        this.logger = new common_1.Logger(PendingWithdrawCleanupService_1.name);
    }
    async cleanupExpiredWithdrawals() {
        await (0, cron_jitter_util_1.cronJitter)(15_000);
        if (!(await (0, redis_health_util_1.ensureRedisAvailable)(this.redis, 'pending-withdraw-cleanup')))
            return;
        const lockKey = 'cron_lock:pending_withdraw_cleanup';
        const lockTtl = 300;
        const lockToken = (0, crypto_1.randomUUID)();
        const acquired = await this.redis.setNx(lockKey, lockToken, lockTtl);
        if (!acquired)
            return;
        const lockRenewal = setInterval(async () => {
            const renewed = await this.redis.renewLock(lockKey, lockToken, lockTtl);
            if (!renewed) {
                clearInterval(lockRenewal);
                this.logger.warn('Pending withdrawal cleanup lock ownership was lost; stopping after the current batch.');
            }
        }, Math.floor(lockTtl * 0.6) * 1000);
        const otpExpiryThreshold = new Date(Date.now() - 10 * 60 * 1000);
        const processExpiryThreshold = new Date(Date.now() - 24 * 60 * 60 * 1000);
        try {
            const [expiredOtp, expiredProcess] = await Promise.all([
                this.prisma.walletTransaction.findMany({
                    where: {
                        withdrawStatus: client_1.WithdrawStatus.PENDING_OTP,
                        updatedAt: { lt: otpExpiryThreshold },
                    },
                    take: 500,
                }),
                this.prisma.walletTransaction.findMany({
                    where: {
                        withdrawStatus: client_1.WithdrawStatus.PENDING_PROCESS,
                        updatedAt: { lt: processExpiryThreshold },
                    },
                    take: 500,
                }),
            ]);
            const allExpired = [...expiredOtp, ...expiredProcess];
            if (allExpired.length === 0)
                return;
            this.logger.log(`Expired withdrawals: ${expiredOtp.length} PENDING_OTP, ${expiredProcess.length} stale PENDING_PROCESS — refunding. PROCESSING remains owned by Iris reconciliation.`);
            const todayStart = (0, date_util_1.startOfDayWIB)();
            const processIdSet = new Set(expiredProcess.map(tx => tx.id));
            const walletGroups = new Map();
            for (const tx of allExpired) {
                const group = walletGroups.get(tx.walletId) ?? [];
                group.push(tx);
                walletGroups.set(tx.walletId, group);
            }
            const MAX_OCC_RETRIES = 3;
            for (const [walletId, txs] of walletGroups) {
                let succeeded = false;
                for (let attempt = 1; attempt <= MAX_OCC_RETRIES && !succeeded; attempt++) {
                    try {
                        await this.prisma.$transaction(async (client) => {
                            const wallet = await client.wallet.findUnique({ where: { id: walletId } });
                            if (!wallet) {
                                this.logger.warn(`PendingWithdrawCleanup: wallet ${walletId} not found, skipping refund`);
                                return;
                            }
                            let availableRefund = BigInt(0);
                            let totalRefund = BigInt(0);
                            let todayTotal = BigInt(0);
                            for (const tx of txs) {
                                const isProcess = processIdSet.has(tx.id);
                                const expectedStatus = isProcess ? client_1.WithdrawStatus.PENDING_PROCESS : client_1.WithdrawStatus.PENDING_OTP;
                                const description = isProcess ? 'Auto-failed: stuck in PENDING_PROCESS for over 24 hours' : undefined;
                                const updated = await client.walletTransaction.updateMany({
                                    where: { id: tx.id, withdrawStatus: expectedStatus },
                                    data: {
                                        withdrawStatus: client_1.WithdrawStatus.FAILED,
                                        status: client_1.WalletTransactionStatus.FAILED,
                                        ...(description ? { description } : {}),
                                    },
                                });
                                if (updated.count > 0) {
                                    availableRefund += tx.amount;
                                    totalRefund += tx.amount;
                                    if (tx.createdAt >= todayStart) {
                                        todayTotal += tx.amount;
                                    }
                                }
                            }
                            if (availableRefund === BigInt(0))
                                return;
                            const withdrawRollback = todayTotal > BigInt(0)
                                ? (wallet.todayWithdrawAmount >= todayTotal
                                    ? { decrement: todayTotal }
                                    : { set: BigInt(0) })
                                : undefined;
                            const walletUpdated = await client.wallet.updateMany({
                                where: { id: walletId, version: wallet.version },
                                data: {
                                    availableBalance: { increment: availableRefund },
                                    ...(totalRefund > BigInt(0) ? { totalBalance: { increment: totalRefund } } : {}),
                                    ...(withdrawRollback !== undefined ? { todayWithdrawAmount: withdrawRollback } : {}),
                                    version: { increment: 1 },
                                },
                            });
                            if (walletUpdated.count === 0) {
                                throw new Error(`PendingWithdrawCleanup OCC conflict for wallet ${walletId}`);
                            }
                        }, { isolationLevel: client_1.Prisma.TransactionIsolationLevel.Serializable });
                        succeeded = true;
                    }
                    catch (walletErr) {
                        if (attempt === MAX_OCC_RETRIES) {
                            this.logger.error(`PendingWithdrawCleanup: wallet ${walletId} refund failed after ${MAX_OCC_RETRIES} retries — will retry next tick: ${walletErr instanceof Error ? walletErr.message : String(walletErr)}`);
                        }
                        else {
                            this.logger.warn(`PendingWithdrawCleanup: wallet ${walletId} OCC conflict, retry ${attempt}/${MAX_OCC_RETRIES}`);
                            await new Promise(r => setTimeout(r, 150 * attempt));
                        }
                    }
                }
            }
        }
        catch (error) {
            this.logger.error('PendingWithdrawCleanup FAILED', error);
        }
        finally {
            clearInterval(lockRenewal);
            await this.redis.releaseLock(lockKey, lockToken).catch((err) => this.logger.warn(`silent-catch: ${err instanceof Error ? err.message : String(err)}`));
        }
    }
};
exports.PendingWithdrawCleanupService = PendingWithdrawCleanupService;
__decorate([
    (0, schedule_1.Cron)('*/5 * * * *', { name: 'pending-withdraw-cleanup' }),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", Promise)
], PendingWithdrawCleanupService.prototype, "cleanupExpiredWithdrawals", null);
exports.PendingWithdrawCleanupService = PendingWithdrawCleanupService = PendingWithdrawCleanupService_1 = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [prisma_service_1.PrismaService,
        redis_service_1.RedisService])
], PendingWithdrawCleanupService);
