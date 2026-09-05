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
var WithdrawalReconciliationService_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.WithdrawalReconciliationService = void 0;
const common_1 = require("@nestjs/common");
const schedule_1 = require("@nestjs/schedule");
const client_1 = require("@prisma/client");
const crypto_1 = require("crypto");
const prisma_service_1 = require("../../../prisma/prisma.service");
const redis_service_1 = require("../../../redis/redis.service");
const cron_jitter_util_1 = require("../../../common/utils/cron-jitter.util");
const midtrans_service_1 = require("../../payment/midtrans.service");
const redis_health_util_1 = require("../../../common/utils/redis-health.util");
const date_util_1 = require("../../../common/utils/date.util");
const notification_queue_service_1 = require("../../queue/notification-queue.service");
const PROCESSING_TIMEOUT_MS = 30 * 60 * 1000;
let WithdrawalReconciliationService = WithdrawalReconciliationService_1 = class WithdrawalReconciliationService {
    runNotificationBestEffort(data, label) {
        void this.notificationQueue.enqueue(data).catch((error) => this.logger.warn(`${label} notification side effect failed: ${error instanceof Error ? error.message : String(error)}`));
    }
    constructor(prisma, redis, midtransService, notificationQueue) {
        this.prisma = prisma;
        this.redis = redis;
        this.midtransService = midtransService;
        this.notificationQueue = notificationQueue;
        this.logger = new common_1.Logger(WithdrawalReconciliationService_1.name);
    }
    async reconcileProcessingWithdrawals() {
        await (0, cron_jitter_util_1.cronJitter)(15_000);
        if (!(await (0, redis_health_util_1.ensureRedisAvailable)(this.redis, 'withdrawal-reconciliation')))
            return;
        const lockKey = 'cron_lock:withdrawal_reconciliation';
        const lockToken = (0, crypto_1.randomUUID)();
        const acquired = await this.redis.setNx(lockKey, lockToken, 300);
        if (!acquired)
            return;
        try {
            const processingWithdrawals = await this.prisma.walletTransaction.findMany({
                where: {
                    type: 'WITHDRAW',
                    withdrawStatus: 'PROCESSING',
                },
                include: { wallet: true },
                orderBy: { updatedAt: 'asc' },
                take: 50,
            });
            if (processingWithdrawals.length === 0)
                return;
            this.logger.log(`Found ${processingWithdrawals.length} PROCESSING withdrawals to reconcile`);
            let resolved = 0;
            let timedOut = 0;
            for (const tx of processingWithdrawals) {
                try {
                    const irisResult = await this.midtransService.getIrisPayoutStatus(tx.txId);
                    if (['completed', 'processed'].includes(irisResult.status)) {
                        const updated = await this.prisma.walletTransaction.updateMany({
                            where: { id: tx.id, withdrawStatus: 'PROCESSING' },
                            data: {
                                withdrawStatus: 'SUCCESS',
                                status: 'SUCCESS',
                                description: tx.description
                                    ? `${tx.description} — confirmed via reconciliation`
                                    : 'Payout confirmed via reconciliation',
                            },
                        });
                        if (updated.count > 0) {
                            resolved++;
                            this.runNotificationBestEffort({ userId: tx.wallet.userId, type: client_1.NotificationType.WALLET_WITHDRAW_SUCCESS, title: 'Penarikan berhasil', body: `Penarikan ${tx.txId} telah dikonfirmasi provider.`, actionUrl: `/wallet/transaction?id=${encodeURIComponent(tx.txId)}`, pushData: { transactionId: tx.txId } }, `WITHDRAWAL_SUCCESS ${tx.txId}`);
                        }
                        this.logger.log(`Withdrawal ${tx.txId} confirmed as ${irisResult.status}`);
                    }
                    else if (['failed', 'rejected'].includes(irisResult.status)) {
                        const refunded = await this.refundFailedWithdrawal(tx);
                        if (refunded) {
                            resolved++;
                            this.runNotificationBestEffort({ userId: tx.wallet.userId, type: client_1.NotificationType.WALLET_WITHDRAW_FAILED, title: 'Penarikan dikembalikan', body: `Penarikan ${tx.txId} gagal dan saldo telah dikembalikan.`, actionUrl: `/wallet/transaction?id=${encodeURIComponent(tx.txId)}`, pushData: { transactionId: tx.txId } }, `WITHDRAWAL_FAILED ${tx.txId}`);
                            this.logger.warn(`Withdrawal ${tx.txId} failed (${irisResult.status}), refunded`);
                        }
                        else {
                            this.logger.warn(`Withdrawal ${tx.txId} changed state before failed payout reconciliation; skipping refund side effects`);
                        }
                    }
                    else if (irisResult.status === 'not_found') {
                        const age = Date.now() - tx.updatedAt.getTime();
                        if (age > PROCESSING_TIMEOUT_MS) {
                            timedOut++;
                            await this.redis.setex(`alert:withdrawal_payout_unknown:${tx.id}`, 86400, JSON.stringify({
                                txId: tx.txId,
                                walletId: tx.walletId,
                                detectedAt: new Date().toISOString(),
                                ageMs: age,
                                providerStatus: irisResult.status,
                            })).catch((error) => this.logger.warn(`Failed to store payout reconciliation alert for ${tx.txId}: ${error instanceof Error ? error.message : String(error)}`));
                            this.logger.error(`Withdrawal ${tx.txId} remains PROCESSING because Iris returned not_found after ${Math.round(age / 60000)}min; manual reconciliation required`);
                        }
                    }
                    else {
                        const age = Date.now() - tx.updatedAt.getTime();
                        if (age > PROCESSING_TIMEOUT_MS) {
                            timedOut++;
                            await this.redis.setex(`alert:withdrawal_payout_unknown:${tx.id}`, 86400, JSON.stringify({
                                txId: tx.txId,
                                walletId: tx.walletId,
                                detectedAt: new Date().toISOString(),
                                ageMs: age,
                                providerStatus: irisResult.status,
                            })).catch((error) => this.logger.warn(`Failed to store payout reconciliation alert for ${tx.txId}: ${error instanceof Error ? error.message : String(error)}`));
                            this.logger.error(`Withdrawal ${tx.txId} remains PROCESSING after ${Math.round(age / 60000)}min with unknown Iris status=${irisResult.status}; manual reconciliation required`);
                        }
                    }
                }
                catch (err) {
                    this.logger.error(`Failed to reconcile withdrawal ${tx.txId}: ${err instanceof Error ? err.message : String(err)}`);
                }
            }
            this.logger.log(`Withdrawal reconciliation: ${resolved} resolved, ${timedOut} timed out`);
        }
        finally {
            await this.redis.releaseLock(lockKey, lockToken).catch((err) => this.logger.warn(`silent-catch: ${err instanceof Error ? err.message : String(err)}`));
        }
    }
    async refundFailedWithdrawal(tx) {
        return this.prisma.$transaction(async (ptx) => {
            const claimResult = await ptx.walletTransaction.updateMany({
                where: { id: tx.id, withdrawStatus: 'PROCESSING' },
                data: { withdrawStatus: 'FAILED', status: 'FAILED', description: 'Payout failed — auto-refunded via reconciliation' },
            });
            if (claimResult.count === 0) {
                this.logger.warn(`Withdrawal ${tx.txId} already transitioned from PROCESSING, skipping refund`);
                return false;
            }
            const currentWallet = await ptx.wallet.findUnique({ where: { id: tx.walletId } });
            if (!currentWallet) {
                throw new Error(`Wallet ${tx.walletId} not found while refunding withdrawal ${tx.txId}`);
            }
            if (currentWallet) {
                const todayStart = (0, date_util_1.startOfDayWIB)();
                const isToday = tx.createdAt >= todayStart;
                const withdrawRollback = isToday
                    ? (currentWallet.todayWithdrawAmount >= tx.amount
                        ? { decrement: tx.amount }
                        : { set: BigInt(0) })
                    : undefined;
                const walletUpdateResult = await ptx.wallet.updateMany({
                    where: { id: tx.walletId, version: currentWallet.version },
                    data: {
                        availableBalance: { increment: tx.amount },
                        totalBalance: { increment: tx.amount },
                        ...(withdrawRollback !== undefined ? { todayWithdrawAmount: withdrawRollback } : {}),
                        version: { increment: 1 },
                    },
                });
                if (walletUpdateResult.count === 0) {
                    throw new Error(`OCC conflict refunding withdrawal ${tx.txId} — will retry`);
                }
            }
            return true;
        }, { isolationLevel: client_1.Prisma.TransactionIsolationLevel.Serializable });
    }
};
exports.WithdrawalReconciliationService = WithdrawalReconciliationService;
__decorate([
    (0, schedule_1.Cron)('*/5 * * * *', { name: 'withdrawal-reconciliation', timeZone: 'Asia/Jakarta' }),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", Promise)
], WithdrawalReconciliationService.prototype, "reconcileProcessingWithdrawals", null);
exports.WithdrawalReconciliationService = WithdrawalReconciliationService = WithdrawalReconciliationService_1 = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [prisma_service_1.PrismaService,
        redis_service_1.RedisService,
        midtrans_service_1.MidtransService,
        notification_queue_service_1.NotificationQueueService])
], WithdrawalReconciliationService);
