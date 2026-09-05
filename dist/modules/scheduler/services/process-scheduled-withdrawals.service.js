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
var ProcessScheduledWithdrawalsService_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.ProcessScheduledWithdrawalsService = void 0;
const common_1 = require("@nestjs/common");
const schedule_1 = require("@nestjs/schedule");
const crypto_1 = require("crypto");
const prisma_service_1 = require("../../../prisma/prisma.service");
const redis_service_1 = require("../../../redis/redis.service");
const scheduled_withdrawal_service_1 = require("../../withdrawals/scheduled-withdrawal.service");
const redis_health_util_1 = require("../../../common/utils/redis-health.util");
const cron_jitter_util_1 = require("../../../common/utils/cron-jitter.util");
let ProcessScheduledWithdrawalsService = ProcessScheduledWithdrawalsService_1 = class ProcessScheduledWithdrawalsService {
    constructor(prisma, redis, scheduledWithdrawalService) {
        this.prisma = prisma;
        this.redis = redis;
        this.scheduledWithdrawalService = scheduledWithdrawalService;
        this.logger = new common_1.Logger(ProcessScheduledWithdrawalsService_1.name);
    }
    async processAll() {
        await (0, cron_jitter_util_1.cronJitter)(10_000);
        if (!(await (0, redis_health_util_1.ensureRedisAvailable)(this.redis, 'process-scheduled-withdrawals')))
            return;
        const lockKey = 'cron_lock:process_scheduled_withdrawals';
        const lockToken = (0, crypto_1.randomUUID)();
        const acquired = await this.redis.setNx(lockKey, lockToken, 3600);
        if (!acquired)
            return;
        let lockLost = false;
        const lockRenewalInterval = setInterval(async () => {
            const renewed = await this.redis.renewLock(lockKey, lockToken, 3600);
            if (!renewed) {
                lockLost = true;
                clearInterval(lockRenewalInterval);
                this.logger.warn('Scheduled withdrawal lock ownership was lost; stopping after the current schedule.');
            }
        }, 60_000);
        const startedAt = Date.now();
        try {
            const wibNow = new Date(Date.now() + 7 * 3600_000);
            const dayOfWeek = wibNow.getUTCDay();
            const schedules = await this.prisma.scheduledWithdrawal.findMany({
                where: { isActive: true, dayOfWeek },
            });
            this.logger.log(`Found ${schedules.length} active schedules for day ${dayOfWeek}`);
            let processed = 0;
            let skipped = 0;
            for (const schedule of schedules) {
                if (lockLost || await this.redis.get(lockKey) !== lockToken) {
                    this.logger.warn('Scheduled withdrawal lock ownership was lost; aborting before the next schedule.');
                    return;
                }
                try {
                    const result = await this.scheduledWithdrawalService.processScheduledWithdrawal(schedule.id);
                    if (result.skipped) {
                        skipped++;
                        this.logger.debug(`Skipped schedule ${schedule.id}: ${result.reason}`);
                    }
                    else {
                        processed++;
                        this.logger.log(`Processed schedule ${schedule.id} for user ${schedule.userId}`);
                    }
                }
                catch (error) {
                    this.logger.error(`Failed to process schedule ${schedule.id}: ${error instanceof Error ? error.message : error}`, error instanceof Error ? error.stack : undefined);
                }
            }
            const durationMs = Date.now() - startedAt;
            this.logger.log(`Scheduled withdrawals complete: ${processed} processed, ${skipped} skipped (${durationMs}ms)`);
            await this.redis.setex(`cron_heartbeat:process_scheduled_withdrawals`, 86400, JSON.stringify({
                ranAt: new Date().toISOString(),
                processed,
                skipped,
                durationMs,
            })).catch((err) => this.logger.warn(`silent-catch: ${err instanceof Error ? err.message : String(err)}`));
        }
        catch (error) {
            this.logger.error(`Failed to run scheduled withdrawals cron: ${error instanceof Error ? error.message : error}`, error instanceof Error ? error.stack : undefined);
        }
        finally {
            clearInterval(lockRenewalInterval);
            await this.redis.releaseLock(lockKey, lockToken).catch((err) => this.logger.warn(`silent-catch: ${err instanceof Error ? err.message : String(err)}`));
        }
    }
};
exports.ProcessScheduledWithdrawalsService = ProcessScheduledWithdrawalsService;
__decorate([
    (0, schedule_1.Cron)('0 6 * * *', { name: 'process-scheduled-withdrawals', timeZone: 'Asia/Jakarta' }),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", Promise)
], ProcessScheduledWithdrawalsService.prototype, "processAll", null);
exports.ProcessScheduledWithdrawalsService = ProcessScheduledWithdrawalsService = ProcessScheduledWithdrawalsService_1 = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [prisma_service_1.PrismaService,
        redis_service_1.RedisService,
        scheduled_withdrawal_service_1.ScheduledWithdrawalService])
], ProcessScheduledWithdrawalsService);
