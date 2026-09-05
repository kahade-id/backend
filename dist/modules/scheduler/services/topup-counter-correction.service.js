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
var TopupCounterCorrectionService_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.TopupCounterCorrectionService = void 0;
const common_1 = require("@nestjs/common");
const schedule_1 = require("@nestjs/schedule");
const crypto_1 = require("crypto");
const prisma_service_1 = require("../../../prisma/prisma.service");
const redis_service_1 = require("../../../redis/redis.service");
const client_1 = require("@prisma/client");
const redis_health_util_1 = require("../../../common/utils/redis-health.util");
const date_util_1 = require("../../../common/utils/date.util");
let TopupCounterCorrectionService = TopupCounterCorrectionService_1 = class TopupCounterCorrectionService {
    constructor(prisma, redis) {
        this.prisma = prisma;
        this.redis = redis;
        this.logger = new common_1.Logger(TopupCounterCorrectionService_1.name);
    }
    async processCorrections() {
        if (!(await (0, redis_health_util_1.ensureRedisAvailable)(this.redis, 'topup-counter-correction')))
            return;
        const lockKey = 'cron_lock:topup_counter_correction';
        const lockToken = (0, crypto_1.randomUUID)();
        const acquired = await this.redis.setNx(lockKey, lockToken, 300);
        if (!acquired)
            return;
        try {
            const client = this.redis.getClient();
            const listKey = this.redis.getPrefix() + 'topup_counter_corrections';
            let processed = 0;
            const maxItems = 50;
            for (let i = 0; i < maxItems; i++) {
                const raw = await client.lpop(listKey);
                if (!raw)
                    break;
                let correction;
                try {
                    correction = JSON.parse(raw);
                }
                catch (err) {
                    this.logger.error(`Discarding malformed topup counter correction: ${raw}`, err instanceof Error ? err.stack : String(err));
                    continue;
                }
                try {
                    await this.correctUserCounter(correction.userId);
                    processed++;
                    this.logger.log(`Corrected topup counter for user=${correction.userId} paymentTx=${correction.paymentTxId}`);
                }
                catch (err) {
                    try {
                        await client.lpush(listKey, raw);
                        this.logger.warn(`Requeued topup counter correction after processing failure for user=${correction.userId}`);
                    }
                    catch (requeueErr) {
                        this.logger.error(`Failed to requeue topup counter correction: ${raw}`, requeueErr instanceof Error ? requeueErr.stack : String(requeueErr));
                    }
                    this.logger.error(`Failed to process topup counter correction: ${raw}`, err instanceof Error ? err.stack : String(err));
                    break;
                }
            }
            if (processed > 0) {
                this.logger.log(`Topup counter correction completed: ${processed} correction(s) processed`);
            }
        }
        finally {
            await this.redis
                .releaseLock(lockKey, lockToken)
                .catch(err => this.logger.warn(`silent-catch: ${err instanceof Error ? err.message : String(err)}`));
        }
    }
    async correctUserCounter(userId) {
        const todayStartWib = (0, date_util_1.startOfDayWIB)();
        const wallet = await this.prisma.wallet.findUnique({
            where: { userId },
            select: { id: true, todayTopupAmount: true, version: true },
        });
        if (!wallet)
            return;
        const activeTopups = await this.prisma.walletTransaction.aggregate({
            where: {
                wallet: { userId },
                type: client_1.WalletTransactionType.TOP_UP,
                status: { in: [client_1.WalletTransactionStatus.SUCCESS, client_1.WalletTransactionStatus.PENDING] },
                createdAt: { gte: todayStartWib },
            },
            _sum: { amount: true },
        });
        const actualTotal = activeTopups._sum.amount ?? BigInt(0);
        if (actualTotal === wallet.todayTopupAmount)
            return;
        const updated = await this.prisma.wallet.updateMany({
            where: { id: wallet.id, version: wallet.version },
            data: {
                todayTopupAmount: actualTotal,
                version: { increment: 1 },
            },
        });
        if (updated.count > 0) {
            this.logger.log(`COUNTER_CORRECTED user=${userId} old=${wallet.todayTopupAmount} new=${actualTotal} delta=${Number(wallet.todayTopupAmount) - Number(actualTotal)} sen`);
        }
    }
};
exports.TopupCounterCorrectionService = TopupCounterCorrectionService;
__decorate([
    (0, schedule_1.Cron)('*/15 * * * *', { name: 'topup-counter-correction', timeZone: 'Asia/Jakarta' }),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", Promise)
], TopupCounterCorrectionService.prototype, "processCorrections", null);
exports.TopupCounterCorrectionService = TopupCounterCorrectionService = TopupCounterCorrectionService_1 = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [prisma_service_1.PrismaService,
        redis_service_1.RedisService])
], TopupCounterCorrectionService);
