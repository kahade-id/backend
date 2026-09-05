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
var FraudChallengeEscalationService_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.FraudChallengeEscalationService = void 0;
const common_1 = require("@nestjs/common");
const schedule_1 = require("@nestjs/schedule");
const crypto_1 = require("crypto");
const prisma_service_1 = require("../../../prisma/prisma.service");
const redis_service_1 = require("../../../redis/redis.service");
const redis_health_util_1 = require("../../../common/utils/redis-health.util");
let FraudChallengeEscalationService = FraudChallengeEscalationService_1 = class FraudChallengeEscalationService {
    constructor(prisma, redis) {
        this.prisma = prisma;
        this.redis = redis;
        this.logger = new common_1.Logger(FraudChallengeEscalationService_1.name);
    }
    async escalateStaleChallenges() {
        if (!(await (0, redis_health_util_1.ensureRedisAvailable)(this.redis, 'fraud-challenge-escalation')))
            return;
        const lockKey = 'cron_lock:fraud_challenge_escalation';
        const lockToken = (0, crypto_1.randomUUID)();
        const acquired = await this.redis.setNx(lockKey, lockToken, 1800);
        if (!acquired)
            return;
        try {
            const threshold = new Date(Date.now() - FraudChallengeEscalationService_1.ESCALATION_THRESHOLD_HOURS * 60 * 60 * 1000);
            const stalePayments = await this.prisma.paymentTransaction.findMany({
                where: {
                    status: 'PENDING',
                    createdAt: { lt: threshold },
                    OR: [
                        { fraudStatus: 'challenge' },
                        { fraudStatus: { startsWith: 'unknown:' } },
                    ],
                },
                select: { id: true, midtransOrderId: true, userId: true, amount: true, fraudStatus: true, createdAt: true },
                take: 100,
            });
            if (stalePayments.length === 0)
                return;
            this.logger.error(`FRAUD_ESCALATION: Found ${stalePayments.length} payment(s) flagged for review for >${FraudChallengeEscalationService_1.ESCALATION_THRESHOLD_HOURS}h — Sentry/ops alerting required`);
            for (const payment of stalePayments) {
                const escalationKey = `alert:fraud_escalation:${payment.midtransOrderId}`;
                const alreadyEscalated = await this.redis.get(escalationKey);
                if (alreadyEscalated)
                    continue;
                this.logger.error(`URGENT_FRAUD_ESCALATED payment=${payment.midtransOrderId} user=${payment.userId} amount=${payment.amount} fraudStatus=${payment.fraudStatus} age=${Math.round((Date.now() - payment.createdAt.getTime()) / 3600000)}h`);
                await this.redis.setex(escalationKey, 86400, JSON.stringify({
                    orderId: payment.midtransOrderId,
                    userId: payment.userId,
                    amount: payment.amount.toString(),
                    fraudStatus: payment.fraudStatus,
                    escalatedAt: new Date().toISOString(),
                    severity: 'URGENT',
                })).catch((err) => this.logger.warn(`silent-catch: ${err instanceof Error ? err.message : String(err)}`));
            }
            await this.redis.setex('cron_heartbeat:fraud_challenge_escalation', 86400, JSON.stringify({
                ranAt: new Date().toISOString(),
                staleCount: stalePayments.length,
            })).catch((err) => this.logger.warn(`silent-catch: ${err instanceof Error ? err.message : String(err)}`));
        }
        catch (error) {
            this.logger.error('Fraud challenge escalation FAILED', error);
        }
        finally {
            await this.redis.releaseLock(lockKey, lockToken).catch((err) => this.logger.warn(`silent-catch: ${err instanceof Error ? err.message : String(err)}`));
        }
    }
};
exports.FraudChallengeEscalationService = FraudChallengeEscalationService;
FraudChallengeEscalationService.ESCALATION_THRESHOLD_HOURS = 24;
__decorate([
    (0, schedule_1.Cron)('0 */4 * * *', { name: 'fraud-challenge-escalation', timeZone: 'Asia/Jakarta' }),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", Promise)
], FraudChallengeEscalationService.prototype, "escalateStaleChallenges", null);
exports.FraudChallengeEscalationService = FraudChallengeEscalationService = FraudChallengeEscalationService_1 = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [prisma_service_1.PrismaService,
        redis_service_1.RedisService])
], FraudChallengeEscalationService);
