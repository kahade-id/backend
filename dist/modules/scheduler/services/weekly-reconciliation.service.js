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
var WeeklyReconciliationService_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.WeeklyReconciliationService = void 0;
const common_1 = require("@nestjs/common");
const schedule_1 = require("@nestjs/schedule");
const crypto_1 = require("crypto");
const client_1 = require("@prisma/client");
const prisma_service_1 = require("../../../prisma/prisma.service");
const redis_service_1 = require("../../../redis/redis.service");
const reconciliation_service_1 = require("../../admin/finance/reconciliation.service");
const redis_health_util_1 = require("../../../common/utils/redis-health.util");
const currency_util_1 = require("../../../common/utils/currency.util");
const date_util_1 = require("../../../common/utils/date.util");
let WeeklyReconciliationService = WeeklyReconciliationService_1 = class WeeklyReconciliationService {
    constructor(redis, prisma, reconciliationService) {
        this.redis = redis;
        this.prisma = prisma;
        this.reconciliationService = reconciliationService;
        this.logger = new common_1.Logger(WeeklyReconciliationService_1.name);
    }
    async runDailyReconciliation() {
        if (!(await (0, redis_health_util_1.ensureRedisAvailable)(this.redis, 'daily-reconciliation')))
            return;
        const dayKey = this.getDayKey();
        const lockKey = `cron_lock:daily_reconciliation:${dayKey}`;
        const lockToken = (0, crypto_1.randomUUID)();
        const acquired = await this.redis.setNx(lockKey, lockToken, 1800);
        if (!acquired) {
            this.logger.log('Daily reconciliation skipped — another instance already executing.');
            return;
        }
        const startedAt = Date.now();
        this.logger.log('Starting daily wallet reconciliation...');
        try {
            const result = await this.reconciliationService.reconcileAllWallets();
            const durationMs = Date.now() - startedAt;
            if (result.clean) {
                this.logger.log(`Daily reconciliation complete: ${result.walletsChecked} wallets checked, ` +
                    `0 discrepancies found (${durationMs}ms)`);
            }
            else {
                this.logger.warn(`Daily reconciliation ALERT: ${result.discrepancies.length} discrepancies found ` +
                    `out of ${result.walletsChecked} wallets (${durationMs}ms)`);
                for (const d of result.discrepancies) {
                    this.logger.warn(`DISCREPANCY: wallet=${d.walletId} user=${d.userId} ` +
                        `actual=${d.actualTotal} expected=${d.expectedTotal} ` +
                        `diff=${d.discrepancy} invariantViolation=${d.invariantViolation}`);
                }
                await this.alertAdminsOnMismatch(`Wallet Reconciliation Alert: ${result.discrepancies.length} discrepancies found`, `Daily reconciliation detected ${result.discrepancies.length} wallet balance discrepancies out of ${result.walletsChecked} checked. Immediate review required.`);
            }
            await this.reconcileEscrowBalances();
            await this.reconcileFeeWallet();
            await this.reconcileStaleProcessingWithdrawals();
            const totalDurationMs = Date.now() - startedAt;
            await this.redis
                .setex(`cron_heartbeat:daily_reconciliation`, 86400, JSON.stringify({
                ranAt: new Date().toISOString(),
                walletsChecked: result.walletsChecked,
                discrepancies: result.discrepancies.length,
                clean: result.clean,
                durationMs: totalDurationMs,
            }))
                .catch(err => this.logger.warn(`silent-catch: ${err instanceof Error ? err.message : String(err)}`));
            if (!result.clean) {
                await this.redis
                    .setex(`cron_alert:reconciliation_discrepancy`, 86400, JSON.stringify({
                    alertAt: new Date().toISOString(),
                    discrepancyCount: result.discrepancies.length,
                    discrepancies: result.discrepancies.slice(0, 10),
                }))
                    .catch(err => this.logger.warn(`silent-catch: ${err instanceof Error ? err.message : String(err)}`));
            }
        }
        catch (error) {
            this.logger.error(`Daily reconciliation failed: ${error instanceof Error ? error.message : String(error)}`, error instanceof Error ? error.stack : undefined);
        }
        finally {
            await this.redis
                .releaseLock(lockKey, lockToken)
                .catch(err => this.logger.warn(`silent-catch: ${err instanceof Error ? err.message : String(err)}`));
        }
    }
    async reconcileEscrowBalances() {
        try {
            const activeOrderStatuses = ['PROCESSING', 'IN_DELIVERY', 'DISPUTED'];
            const allRelevantUserIds = new Set();
            const BATCH_SIZE = 1000;
            let orderCursor;
            for (;;) {
                const orders = await this.prisma.order.findMany({
                    where: { status: { in: activeOrderStatuses } },
                    select: { id: true, buyerId: true },
                    orderBy: { id: 'asc' },
                    take: BATCH_SIZE,
                    ...(orderCursor ? { cursor: { id: orderCursor }, skip: 1 } : {}),
                });
                for (const order of orders)
                    allRelevantUserIds.add(order.buyerId);
                if (orders.length < BATCH_SIZE)
                    break;
                orderCursor = orders[orders.length - 1].id;
            }
            let walletCursor;
            for (;;) {
                const wallets = await this.prisma.wallet.findMany({
                    where: { escrowBalance: { gt: 0 } },
                    select: { id: true, userId: true },
                    orderBy: { id: 'asc' },
                    take: BATCH_SIZE,
                    ...(walletCursor ? { cursor: { id: walletCursor }, skip: 1 } : {}),
                });
                for (const wallet of wallets)
                    allRelevantUserIds.add(wallet.userId);
                if (wallets.length < BATCH_SIZE)
                    break;
                walletCursor = wallets[wallets.length - 1].id;
            }
            let escrowMismatches = 0;
            let walletsChecked = 0;
            for (const userId of allRelevantUserIds) {
                walletsChecked++;
                const wallet = await this.prisma.wallet.findFirst({
                    where: { userId },
                    select: { id: true, userId: true, escrowBalance: true },
                });
                if (!wallet)
                    continue;
                const lockedOrders = await this.prisma.order.findMany({
                    where: {
                        buyerId: userId,
                        status: { in: activeOrderStatuses },
                    },
                    select: { buyerPayAmount: true },
                });
                const expectedEscrow = lockedOrders.reduce((sum, o) => sum + o.buyerPayAmount, BigInt(0));
                if (wallet.escrowBalance !== expectedEscrow) {
                    escrowMismatches++;
                    this.logger.warn(`ESCROW MISMATCH: wallet=${wallet.id} user=${wallet.userId} ` +
                        `actual=${(0, currency_util_1.toIdr)(wallet.escrowBalance)} expected=${(0, currency_util_1.toIdr)(expectedEscrow)} ` +
                        `diff=${(0, currency_util_1.toIdr)(wallet.escrowBalance - expectedEscrow)}`);
                }
            }
            this.logger.log(`Escrow reconciliation: ${walletsChecked} wallets checked, ${escrowMismatches} mismatches`);
            if (escrowMismatches > 0) {
                await this.alertAdminsOnMismatch(`Escrow Reconciliation Alert: ${escrowMismatches} mismatches`, `Escrow reconciliation found ${escrowMismatches} wallet(s) where escrow balance does not match active order totals. Immediate investigation required.`);
            }
        }
        catch (err) {
            this.logger.error(`Escrow reconciliation failed: ${err instanceof Error ? err.message : String(err)}`);
        }
    }
    async reconcileFeeWallet() {
        try {
            const completedFeeResult = await this.prisma.order.aggregate({
                where: { status: 'COMPLETED' },
                _sum: { feeAmount: true },
                _count: true,
            });
            const feeDeductResult = await this.prisma.walletTransaction.aggregate({
                where: { type: 'FEE_DEDUCT', status: 'SUCCESS' },
                _sum: { amount: true },
                _count: true,
            });
            const expectedFees = completedFeeResult._sum.feeAmount ?? BigInt(0);
            const recordedFees = feeDeductResult._sum.amount ?? BigInt(0);
            if (expectedFees !== recordedFees) {
                const message = `FEE WALLET MISMATCH: expected total fees=${(0, currency_util_1.toIdr)(expectedFees)} ` +
                    `recorded FEE_DEDUCT total=${(0, currency_util_1.toIdr)(recordedFees)} ` +
                    `diff=${(0, currency_util_1.toIdr)(expectedFees - recordedFees)} ` +
                    `(orders=${completedFeeResult._count} feeDeducts=${feeDeductResult._count})`;
                this.logger.warn(message);
                await this.alertAdminsOnMismatch('Fee reconciliation mismatch', `${message}. Immediate financial review required.`);
            }
            else {
                this.logger.log(`Fee wallet reconciliation clean: ${(0, currency_util_1.toIdr)(expectedFees)} total fees across ${completedFeeResult._count} orders`);
            }
        }
        catch (err) {
            this.logger.error(`Fee wallet reconciliation failed: ${err instanceof Error ? err.message : String(err)}`);
        }
    }
    async reconcileStaleProcessingWithdrawals() {
        try {
            const staleThreshold = new Date(Date.now() - 2 * 60 * 60 * 1000);
            const staleWithdrawals = await this.prisma.walletTransaction.findMany({
                where: {
                    type: 'WITHDRAW',
                    withdrawStatus: 'PROCESSING',
                    updatedAt: { lt: staleThreshold },
                },
                select: {
                    id: true,
                    txId: true,
                    walletId: true,
                    amount: true,
                    createdAt: true,
                    updatedAt: true,
                },
                take: 1000,
            });
            if (staleWithdrawals.length === 0) {
                this.logger.log('Stale PROCESSING withdrawal reconciliation: 0 stale withdrawals found');
                return;
            }
            this.logger.warn(`STALE PROCESSING WITHDRAWALS: ${staleWithdrawals.length} withdrawal(s) stuck in PROCESSING for >2 hours. ` +
                `Manual verification with Iris required. TxIds: ${staleWithdrawals.map(w => w.txId).join(', ')}`);
        }
        catch (err) {
            this.logger.error(`Stale PROCESSING withdrawal reconciliation failed: ${err instanceof Error ? err.message : String(err)}`);
        }
    }
    async alertAdminsOnMismatch(title, body) {
        try {
            const admins = await this.prisma.adminUser.findMany({
                where: { isActive: true, deletedAt: null, role: 'SUPER_ADMIN' },
                select: { id: true },
                take: 5,
            });
            if (admins.length === 0) {
                const fallback = await this.prisma.adminUser.findFirst({
                    where: { isActive: true, deletedAt: null },
                    select: { id: true },
                });
                if (fallback)
                    admins.push(fallback);
            }
            for (const admin of admins) {
                await this.prisma.adminAuditLog
                    .create({
                    data: {
                        adminId: admin.id,
                        action: client_1.AuditAction.ADMIN_ACTION,
                        targetType: 'Reconciliation',
                        targetId: 'weekly-reconciliation',
                        description: `[SYSTEM ALERT] ${title}: ${body}`,
                        ipAddress: 'system',
                    },
                })
                    .catch(err => this.logger.warn(`silent-catch: ${err instanceof Error ? err.message : String(err)}`));
            }
            this.logger.error(`[ADMIN ALERT] ${title}: ${body}`);
        }
        catch (err) {
            this.logger.error(`Failed to send admin mismatch alert: ${err instanceof Error ? err.message : String(err)}`);
        }
    }
    getDayKey() {
        return (0, date_util_1.formatWIBDate)();
    }
};
exports.WeeklyReconciliationService = WeeklyReconciliationService;
__decorate([
    (0, schedule_1.Cron)('0 3 * * *', { name: 'daily-reconciliation', timeZone: 'Asia/Jakarta' }),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", Promise)
], WeeklyReconciliationService.prototype, "runDailyReconciliation", null);
exports.WeeklyReconciliationService = WeeklyReconciliationService = WeeklyReconciliationService_1 = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [redis_service_1.RedisService,
        prisma_service_1.PrismaService,
        reconciliation_service_1.ReconciliationService])
], WeeklyReconciliationService);
