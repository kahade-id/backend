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
var ExpireDisputeCallsService_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.ExpireDisputeCallsService = void 0;
const common_1 = require("@nestjs/common");
const schedule_1 = require("@nestjs/schedule");
const client_1 = require("@prisma/client");
const crypto_1 = require("crypto");
const prisma_service_1 = require("../../../prisma/prisma.service");
const redis_service_1 = require("../../../redis/redis.service");
const redis_health_util_1 = require("../../../common/utils/redis-health.util");
const app_constants_1 = require("../../../common/constants/app.constants");
let ExpireDisputeCallsService = ExpireDisputeCallsService_1 = class ExpireDisputeCallsService {
    constructor(prisma, redis) {
        this.prisma = prisma;
        this.redis = redis;
        this.logger = new common_1.Logger(ExpireDisputeCallsService_1.name);
        this.CALL_REQUEST_EXPIRY_SECONDS = app_constants_1.DISPUTE_CALL_REQUEST_EXPIRY_SECONDS;
    }
    async expireDisputeCalls() {
        if (!(await (0, redis_health_util_1.ensureRedisAvailable)(this.redis, 'expire-dispute-calls')))
            return;
        const lockKey = 'cron_lock:expire_dispute_calls';
        const lockToken = (0, crypto_1.randomUUID)();
        const acquired = await this.redis.setNx(lockKey, lockToken, 120);
        if (!acquired)
            return;
        try {
            const hasTable = await this.prisma.$queryRaw `
        SELECT EXISTS (
          SELECT 1 FROM information_schema.tables
          WHERE table_schema = 'public' AND table_name = 'dispute_calls'
        ) AS exists
      `;
            if (!hasTable[0]?.exists) {
                return;
            }
            const expiryThreshold = new Date(Date.now() - this.CALL_REQUEST_EXPIRY_SECONDS * 1000);
            const requestResult = await this.prisma.disputeCall.updateMany({
                where: {
                    status: client_1.DisputeCallStatus.REQUESTED,
                    requestedAt: { lt: expiryThreshold },
                },
                data: {
                    status: client_1.DisputeCallStatus.EXPIRED,
                    endedAt: new Date(),
                },
            });
            const acceptedResult = await this.prisma.disputeCall.updateMany({
                where: {
                    status: client_1.DisputeCallStatus.ACCEPTED,
                    acceptedAt: { lt: expiryThreshold },
                    startedAt: null,
                },
                data: {
                    status: client_1.DisputeCallStatus.EXPIRED,
                    endedAt: new Date(),
                },
            });
            const inProgressCount = await this.prisma.$executeRaw `
        UPDATE "dispute_calls"
        SET "status" = 'ENDED'::"DisputeCallStatus",
            "endedAt" = NOW(),
            "durationSeconds" = LEAST(
              "maxDurationSeconds",
              GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (NOW() - "startedAt")))::int)
            ),
            "updatedAt" = NOW()
        WHERE "status" = 'IN_PROGRESS'::"DisputeCallStatus"
          AND "startedAt" IS NOT NULL
          AND "startedAt" < NOW() - ("maxDurationSeconds" * INTERVAL '1 second')
      `;
            const totalExpired = requestResult.count + acceptedResult.count + inProgressCount;
            if (totalExpired > 0) {
                this.logger.log(`Expired ${requestResult.count} requested, ${acceptedResult.count} unjoined accepted, and ended ${inProgressCount} over-duration dispute call(s)`);
            }
        }
        catch (error) {
            const msg = error.message ?? '';
            if (msg.includes('P2021') || msg.includes('does not exist')) {
                this.logger.warn('dispute_calls table missing — run prisma migrate deploy');
                return;
            }
            this.logger.error('ExpireDisputeCalls FAILED', error);
        }
        finally {
            await this.redis.releaseLock(lockKey, lockToken).catch((err) => this.logger.warn(`silent-catch: ${err instanceof Error ? err.message : String(err)}`));
        }
    }
};
exports.ExpireDisputeCallsService = ExpireDisputeCallsService;
__decorate([
    (0, schedule_1.Cron)('* * * * *', { name: 'expire-dispute-calls' }),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", Promise)
], ExpireDisputeCallsService.prototype, "expireDisputeCalls", null);
exports.ExpireDisputeCallsService = ExpireDisputeCallsService = ExpireDisputeCallsService_1 = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [prisma_service_1.PrismaService,
        redis_service_1.RedisService])
], ExpireDisputeCallsService);
