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
var PendingTopupCleanupService_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.PendingTopupCleanupService = void 0;
const common_1 = require("@nestjs/common");
const config_1 = require("@nestjs/config");
const schedule_1 = require("@nestjs/schedule");
const crypto_1 = require("crypto");
const client_1 = require("@prisma/client");
const prisma_service_1 = require("../../../prisma/prisma.service");
const redis_service_1 = require("../../../redis/redis.service");
const cron_jitter_util_1 = require("../../../common/utils/cron-jitter.util");
const redis_health_util_1 = require("../../../common/utils/redis-health.util");
const date_util_1 = require("../../../common/utils/date.util");
const midtrans_service_1 = require("../../payment/midtrans.service");
const wallet_service_1 = require("../../wallet/wallet.service");
let PendingTopupCleanupService = PendingTopupCleanupService_1 = class PendingTopupCleanupService {
    constructor(prisma, redis, configService, midtransService, walletService) {
        this.prisma = prisma;
        this.redis = redis;
        this.configService = configService;
        this.midtransService = midtransService;
        this.walletService = walletService;
        this.logger = new common_1.Logger(PendingTopupCleanupService_1.name);
        this.topupExpiryHours = Math.max(1, this.configService.get('app.topupExpiryHours') ?? 24);
    }
    async cleanupStaleTopups() {
        await (0, cron_jitter_util_1.cronJitter)(20_000);
        if (!(await (0, redis_health_util_1.ensureRedisAvailable)(this.redis, 'pending-topup-cleanup')))
            return;
        const lockKey = 'cron_lock:pending_topup_cleanup';
        const lockTtl = 600;
        const lockToken = (0, crypto_1.randomUUID)();
        const acquired = await this.redis.setNx(lockKey, lockToken, lockTtl);
        if (!acquired)
            return;
        let lockLost = false;
        const lockRenewal = setInterval(async () => {
            const renewed = await this.redis.renewLock(lockKey, lockToken, lockTtl);
            if (!renewed) {
                lockLost = true;
                clearInterval(lockRenewal);
                this.logger.warn('Pending top-up cleanup lock ownership was lost; stopping after the current batch.');
            }
        }, Math.floor(lockTtl * 0.6) * 1000);
        const bufferHours = Math.max(1, Math.ceil(this.topupExpiryHours * 0.25));
        const expiryMs = (this.topupExpiryHours + bufferHours) * 60 * 60 * 1000;
        const expiryThreshold = new Date(Date.now() - expiryMs);
        try {
            if (lockLost || await this.redis.get(lockKey) !== lockToken) {
                this.logger.warn('Pending top-up cleanup lock ownership was lost; aborting before candidate fetch.');
                return;
            }
            const staleTopups = await this.prisma.walletTransaction.findMany({
                where: {
                    type: client_1.WalletTransactionType.TOP_UP,
                    status: client_1.WalletTransactionStatus.PENDING,
                    createdAt: { lt: expiryThreshold },
                },
                include: {
                    paymentTx: true,
                },
                take: 500,
            });
            if (staleTopups.length === 0)
                return;
            this.logger.log(`Found ${staleTopups.length} stale PENDING topup transactions — reconciling before cleanup.`);
            const providerConfirmedFailures = [];
            const terminalFailureStatuses = new Set(['deny', 'expire', 'cancel', 'failure', 'refund', 'partial_refund', 'chargeback', 'partial_chargeback']);
            for (const tx of staleTopups) {
                if (lockLost)
                    break;
                if (!tx.paymentTx) {
                    providerConfirmedFailures.push(tx);
                    continue;
                }
                try {
                    const providerTx = await this.midtransService.getTransactionStatus(tx.paymentTx.midtransOrderId);
                    const providerStatus = typeof providerTx.transaction_status === 'string'
                        ? providerTx.transaction_status.toLowerCase()
                        : '';
                    if (providerStatus === 'settlement') {
                        const grossAmount = typeof providerTx.gross_amount === 'string' ? providerTx.gross_amount : undefined;
                        await this.walletService.handleTopupSuccess(tx.paymentTx.midtransOrderId, grossAmount);
                        this.logger.log(`Pending top-up ${tx.paymentTx.midtransOrderId} settled during provider reconciliation`);
                        continue;
                    }
                    if (providerStatus === 'capture') {
                        const fraudStatus = typeof providerTx.fraud_status === 'string'
                            ? providerTx.fraud_status.toLowerCase()
                            : '';
                        if (fraudStatus === 'accept') {
                            const grossAmount = typeof providerTx.gross_amount === 'string' ? providerTx.gross_amount : undefined;
                            await this.walletService.handleTopupSuccess(tx.paymentTx.midtransOrderId, grossAmount);
                            this.logger.log(`Pending top-up ${tx.paymentTx.midtransOrderId} capture+accept settled during provider reconciliation`);
                            continue;
                        }
                        if (fraudStatus === 'deny') {
                            providerConfirmedFailures.push(tx);
                            this.logger.log(`Pending top-up ${tx.paymentTx.midtransOrderId} capture+deny failed during provider reconciliation`);
                            continue;
                        }
                        const reviewSignal = fraudStatus === 'challenge'
                            ? 'challenge'
                            : `unknown:${fraudStatus.slice(0, 32) || 'missing'}`;
                        await this.prisma.paymentTransaction.updateMany({
                            where: { id: tx.paymentTx.id, status: client_1.PaymentStatus.PENDING },
                            data: { fraudStatus: reviewSignal, webhookReceivedAt: new Date() },
                        });
                        this.logger.error(`Pending top-up ${tx.paymentTx.midtransOrderId} capture+${fraudStatus || 'missing'} requires manual fraud review`);
                        continue;
                    }
                    if (terminalFailureStatuses.has(providerStatus)) {
                        providerConfirmedFailures.push(tx);
                        continue;
                    }
                    this.logger.warn(`Pending top-up ${tx.paymentTx.midtransOrderId} retained: provider status=${providerStatus || 'unknown'} is not terminal`);
                }
                catch (error) {
                    this.logger.warn(`Pending top-up ${tx.paymentTx.midtransOrderId} retained because provider status is unavailable: ` +
                        `${error instanceof Error ? error.message : String(error)}`);
                }
            }
            if (lockLost || await this.redis.get(lockKey) !== lockToken) {
                this.logger.warn('Pending top-up cleanup lock ownership was lost; aborting before wallet updates.');
                return;
            }
            if (providerConfirmedFailures.length === 0)
                return;
            const todayStart = (0, date_util_1.startOfDayWIB)();
            const walletGroups = new Map();
            for (const tx of providerConfirmedFailures) {
                const group = walletGroups.get(tx.walletId) ?? [];
                group.push(tx);
                walletGroups.set(tx.walletId, group);
            }
            const MAX_OCC_RETRIES = 3;
            for (const [walletId, txs] of walletGroups) {
                if (lockLost || await this.redis.get(lockKey) !== lockToken) {
                    this.logger.warn('Pending top-up cleanup lock ownership was lost; aborting before the next wallet.');
                    return;
                }
                let succeeded = false;
                for (let attempt = 1; attempt <= MAX_OCC_RETRIES && !succeeded; attempt++) {
                    try {
                        await this.prisma.$transaction(async (client) => {
                            const wallet = await client.wallet.findUnique({ where: { id: walletId } });
                            if (!wallet) {
                                this.logger.warn(`PendingTopupCleanup: wallet ${walletId} not found, skipping`);
                                return;
                            }
                            let todayTopupRollback = BigInt(0);
                            for (const tx of txs) {
                                const updated = await client.walletTransaction.updateMany({
                                    where: { id: tx.id, status: client_1.WalletTransactionStatus.PENDING },
                                    data: {
                                        status: client_1.WalletTransactionStatus.FAILED,
                                        description: 'Auto-failed: stale PENDING topup (no Midtrans charge completed)',
                                    },
                                });
                                if (updated.count > 0) {
                                    if (tx.paymentTx && tx.paymentTx.status === client_1.PaymentStatus.PENDING) {
                                        await client.paymentTransaction.updateMany({
                                            where: { id: tx.paymentTx.id, status: client_1.PaymentStatus.PENDING },
                                            data: { status: client_1.PaymentStatus.FAILED, failedAt: new Date() },
                                        });
                                    }
                                    if (tx.createdAt >= todayStart) {
                                        todayTopupRollback += tx.amount;
                                    }
                                }
                            }
                            if (todayTopupRollback > BigInt(0)) {
                                const rollbackData = wallet.todayTopupAmount >= todayTopupRollback
                                    ? { todayTopupAmount: { decrement: todayTopupRollback } }
                                    : { todayTopupAmount: { set: BigInt(0) } };
                                const walletUpdated = await client.wallet.updateMany({
                                    where: { id: walletId, version: wallet.version },
                                    data: {
                                        ...rollbackData,
                                        version: { increment: 1 },
                                    },
                                });
                                if (walletUpdated.count === 0) {
                                    throw new Error(`PendingTopupCleanup OCC conflict for wallet ${walletId}`);
                                }
                            }
                        }, { isolationLevel: client_1.Prisma.TransactionIsolationLevel.Serializable });
                        succeeded = true;
                    }
                    catch (err) {
                        if (attempt === MAX_OCC_RETRIES) {
                            this.logger.error(`PendingTopupCleanup: wallet ${walletId} cleanup failed after ${MAX_OCC_RETRIES} retries — will retry next tick: ${err instanceof Error ? err.message : String(err)}`);
                        }
                        else {
                            this.logger.warn(`PendingTopupCleanup: wallet ${walletId} OCC conflict, retry ${attempt}/${MAX_OCC_RETRIES}`);
                            await new Promise(r => setTimeout(r, 150 * attempt));
                        }
                    }
                }
            }
        }
        catch (error) {
            this.logger.error('PendingTopupCleanup FAILED', error);
        }
        finally {
            clearInterval(lockRenewal);
            await this.redis.releaseLock(lockKey, lockToken).catch((err) => this.logger.warn(`silent-catch: ${err instanceof Error ? err.message : String(err)}`));
        }
    }
};
exports.PendingTopupCleanupService = PendingTopupCleanupService;
__decorate([
    (0, schedule_1.Cron)('0 * * * *', { name: 'pending-topup-cleanup' }),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", Promise)
], PendingTopupCleanupService.prototype, "cleanupStaleTopups", null);
exports.PendingTopupCleanupService = PendingTopupCleanupService = PendingTopupCleanupService_1 = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [prisma_service_1.PrismaService,
        redis_service_1.RedisService,
        config_1.ConfigService,
        midtrans_service_1.MidtransService,
        wallet_service_1.WalletService])
], PendingTopupCleanupService);
