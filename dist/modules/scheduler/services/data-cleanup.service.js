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
var DataCleanupService_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.DataCleanupService = void 0;
const common_1 = require("@nestjs/common");
const config_1 = require("@nestjs/config");
const schedule_1 = require("@nestjs/schedule");
const crypto_1 = require("crypto");
const bcrypt = __importStar(require("bcrypt"));
const client_1 = require("@prisma/client");
const prisma_service_1 = require("../../../prisma/prisma.service");
const redis_service_1 = require("../../../redis/redis.service");
const redis_health_util_1 = require("../../../common/utils/redis-health.util");
const date_util_1 = require("../../../common/utils/date.util");
let DataCleanupService = DataCleanupService_1 = class DataCleanupService {
    constructor(prisma, redis, configService) {
        this.prisma = prisma;
        this.redis = redis;
        this.configService = configService;
        this.logger = new common_1.Logger(DataCleanupService_1.name);
        this.retentionExpiredOtpDays = this.configService.get('app.retentionExpiredOtpDays') ?? 90;
        this.retentionWebhookLogDays = this.configService.get('app.retentionWebhookLogDays') ?? 90;
        this.retentionAnonymizeDays = this.configService.get('app.retentionAnonymizeDays') ?? 30;
    }
    async onModuleInit() {
        this.anonymizedPasswordHash = await bcrypt.hash((0, crypto_1.randomBytes)(32).toString('hex'), 12);
    }
    async cleanupExpiredData() {
        if (!(await (0, redis_health_util_1.ensureRedisAvailable)(this.redis, 'data-cleanup')))
            return;
        const today = (0, date_util_1.formatWIBDate)();
        const lockKey = `cron_lock:data_cleanup:${today}`;
        const lockToken = (0, crypto_1.randomUUID)();
        const acquired = await this.redis.setNx(lockKey, lockToken, 1800);
        if (!acquired) {
            this.logger.log('Data cleanup skipped — another instance already executing.');
            return;
        }
        const startedAt = Date.now();
        this.logger.log('Starting expired data cleanup...');
        const now = new Date();
        const anonymizeThreshold = new Date(now.getTime() - this.retentionAnonymizeDays * 24 * 60 * 60 * 1000);
        try {
            const otpRetentionMs = this.retentionExpiredOtpDays * 24 * 60 * 60 * 1000;
            const webhookRetentionMs = this.retentionWebhookLogDays * 24 * 60 * 60 * 1000;
            const deleteOperations = [
                { name: 'OTP', fn: () => {
                        const otpCutoff = new Date(now.getTime() - otpRetentionMs);
                        return this.prisma.otpCode.deleteMany({ where: { expiresAt: { lt: otpCutoff } } });
                    } },
                { name: 'Sessions', fn: () => this.prisma.userSession.deleteMany({ where: { expiresAt: { lt: now } } }) },
                { name: 'IdempotencyRecords', fn: () => this.prisma.idempotencyRecord.deleteMany({ where: { expiresAt: { lt: now } } }) },
                { name: 'WebhookLogs', fn: () => {
                        const webhookCutoff = new Date(now.getTime() - webhookRetentionMs);
                        return this.prisma.webhookLog.deleteMany({
                            where: {
                                createdAt: { lt: webhookCutoff },
                                OR: [
                                    { isProcessed: true },
                                    { deadLetteredAt: { not: null } },
                                ],
                            },
                        });
                    } },
            ];
            const results = {};
            for (const op of deleteOperations) {
                try {
                    const result = await op.fn();
                    results[op.name] = result.count;
                }
                catch (err) {
                    this.logger.error(`Data cleanup sub-task "${op.name}" failed: ${err instanceof Error ? err.message : String(err)}`);
                    results[op.name] = -1;
                }
            }
            if (Object.values(results).some(count => count < 0)) {
                throw new Error('One or more data cleanup subtasks failed; heartbeat will not report success');
            }
            const anonymizedCount = await this.anonymizeDeletedUsers(anonymizeThreshold);
            results['AnonymizedUsers'] = anonymizedCount;
            const durationMs = Date.now() - startedAt;
            this.logger.log(`Data cleanup completed (${durationMs}ms): ` +
                Object.entries(results).map(([k, v]) => `${k}=${v}`).join(', '));
            await this.redis.setex(`cron_heartbeat:data_cleanup`, 86400, JSON.stringify({
                ranAt: new Date().toISOString(),
                results,
                durationMs,
            })).catch((err) => this.logger.warn(`silent-catch: ${err instanceof Error ? err.message : String(err)}`));
        }
        catch (error) {
            this.logger.error('Data cleanup FAILED', error);
            throw error;
        }
        finally {
            await this.redis.releaseLock(lockKey, lockToken).catch((err) => this.logger.warn(`silent-catch: ${err instanceof Error ? err.message : String(err)}`));
        }
    }
    async anonymizeDeletedUsers(deletedBefore) {
        const usersToAnonymize = await this.prisma.user.findMany({
            where: {
                deletedAt: { lt: deletedBefore, not: null },
                email: { not: { endsWith: '@kahade.invalid' } },
            },
            select: { id: true },
            take: 500,
        });
        if (usersToAnonymize.length === 0)
            return 0;
        const userIds = usersToAnonymize.map(u => u.id);
        const BATCH_SIZE = 50;
        for (let i = 0; i < userIds.length; i += BATCH_SIZE) {
            const batch = userIds.slice(i, i + BATCH_SIZE);
            await this.prisma.$transaction(async (tx) => {
                await Promise.all([
                    tx.otpCode.deleteMany({ where: { userId: { in: batch } } }),
                    tx.twoFactorAuth.deleteMany({ where: { userId: { in: batch } } }),
                    tx.userDevice.updateMany({
                        where: { userId: { in: batch } },
                        data: { pushToken: null, ipAddress: '0.0.0.0' },
                    }),
                ]);
                for (const id of batch) {
                    await tx.user.update({
                        where: { id },
                        data: {
                            email: `deleted-${id}@kahade.invalid`,
                            fullName: 'Deleted User',
                            password: this.anonymizedPasswordHash,
                            username: null,
                            bio: null,
                            avatarUrl: null,
                            headerUrl: null,
                            phoneNumber: 'DELETED',
                            dateOfBirth: null,
                            gender: null,
                            contactEmail: null,
                            contactPhone: null,
                            usernameChangedAt: null,
                            lastLoginIp: null,
                            banReason: null,
                        },
                    });
                }
            }, { isolationLevel: client_1.Prisma.TransactionIsolationLevel.Serializable });
        }
        return userIds.length;
    }
};
exports.DataCleanupService = DataCleanupService;
__decorate([
    (0, schedule_1.Cron)('0 20 * * *', { name: 'data-cleanup', timeZone: 'UTC' }),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", Promise)
], DataCleanupService.prototype, "cleanupExpiredData", null);
exports.DataCleanupService = DataCleanupService = DataCleanupService_1 = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [prisma_service_1.PrismaService,
        redis_service_1.RedisService,
        config_1.ConfigService])
], DataCleanupService);
