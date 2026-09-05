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
var WalletDailyResetService_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.WalletDailyResetService = void 0;
const common_1 = require("@nestjs/common");
const schedule_1 = require("@nestjs/schedule");
const client_1 = require("@prisma/client");
const crypto_1 = require("crypto");
const prisma_service_1 = require("../../../prisma/prisma.service");
const redis_service_1 = require("../../../redis/redis.service");
const redis_health_util_1 = require("../../../common/utils/redis-health.util");
const date_util_1 = require("../../../common/utils/date.util");
let WalletDailyResetService = WalletDailyResetService_1 = class WalletDailyResetService {
    constructor(prisma, redis) {
        this.prisma = prisma;
        this.redis = redis;
        this.logger = new common_1.Logger(WalletDailyResetService_1.name);
    }
    async resetDailyLimits() {
        if (!(await (0, redis_health_util_1.ensureRedisAvailable)(this.redis, 'wallet-daily-reset')))
            return;
        const today = (0, date_util_1.formatWIBDate)();
        const lockKey = `cron_lock:wallet_daily_reset:${today}`;
        const lockToken = (0, crypto_1.randomUUID)();
        const acquired = await this.redis.setNx(lockKey, lockToken, 3600);
        if (!acquired) {
            this.logger.log('Daily wallet reset skipped — another instance already executing.');
            return;
        }
        const startedAt = new Date();
        this.logger.log('Starting daily wallet limit reset...');
        try {
            const BATCH_SIZE = 5000;
            let totalUpdated = 0;
            let lastId = null;
            let batchCount;
            do {
                const whereClause = {
                    OR: [
                        { todayTopupAmount: { gt: BigInt(0) } },
                        { todayWithdrawAmount: { gt: BigInt(0) } },
                    ],
                };
                if (lastId) {
                    whereClause.id = { gt: lastId };
                }
                const batch = await this.prisma.wallet.findMany({
                    where: whereClause,
                    select: { id: true, version: true },
                    take: BATCH_SIZE,
                    orderBy: { id: 'asc' },
                });
                batchCount = batch.length;
                if (batchCount > 0) {
                    lastId = batch[batchCount - 1].id;
                    const valuesList = client_1.Prisma.join(batch.map((w) => client_1.Prisma.sql `(${w.id}::text, ${w.version}::int)`));
                    const updatedCount = await this.prisma.$executeRaw(client_1.Prisma.sql `
            UPDATE "wallets" w
            SET
              "todayTopupAmount" = 0,
              "todayWithdrawAmount" = 0,
              "lastLimitResetAt" = NOW(),
              "version" = "version" + 1
            FROM (VALUES ${valuesList}) AS v(id, ver)
            WHERE w."id" = v.id AND w."version" = v.ver
          `);
                    totalUpdated += Number(updatedCount);
                    if (Number(updatedCount) === 0 && batchCount > 0) {
                        this.logger.warn(`wallet-daily-reset: 0 rows updated for batch of ${batchCount} candidates — possible OCC version drift`);
                    }
                }
            } while (batchCount === BATCH_SIZE);
            const result = { count: totalUpdated };
            const elapsedMs = Date.now() - startedAt.getTime();
            this.logger.log(`Daily wallet limit reset completed. Updated ${result.count} wallet(s) in ${elapsedMs}ms.`);
            const heartbeatData = JSON.stringify({
                ranAt: new Date().toISOString(),
                updatedCount: result.count,
                elapsedMs,
            });
            await Promise.all([
                this.redis.setex(`cron_heartbeat:wallet_daily_reset`, 86400, heartbeatData),
                this.redis.setex(`cron_heartbeat:wallet_daily_reset:${today}`, 86400, heartbeatData),
            ]).catch((err) => this.logger.warn(`silent-catch: ${err instanceof Error ? err.message : String(err)}`));
        }
        catch (error) {
            this.logger.error('Daily wallet limit reset FAILED', error);
            const failureKey = `cron_failure:wallet_daily_reset:${today}`;
            try {
                await this.redis.setex(failureKey, 86400, JSON.stringify({
                    failedAt: new Date().toISOString(),
                    error: error instanceof Error ? error.message : String(error),
                }));
            }
            catch {
                this.logger.error('Could not store reset failure state in Redis');
            }
        }
        finally {
            await this.redis.releaseLock(lockKey, lockToken).catch((err) => this.logger.warn(`silent-catch: ${err instanceof Error ? err.message : String(err)}`));
        }
    }
};
exports.WalletDailyResetService = WalletDailyResetService;
__decorate([
    (0, schedule_1.Cron)('0 17 * * *', { name: 'wallet-daily-reset', timeZone: 'UTC' }),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", Promise)
], WalletDailyResetService.prototype, "resetDailyLimits", null);
exports.WalletDailyResetService = WalletDailyResetService = WalletDailyResetService_1 = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [prisma_service_1.PrismaService,
        redis_service_1.RedisService])
], WalletDailyResetService);
