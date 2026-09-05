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
var AutoEscalateDisputesService_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.AutoEscalateDisputesService = void 0;
const common_1 = require("@nestjs/common");
const schedule_1 = require("@nestjs/schedule");
const crypto_1 = require("crypto");
const prisma_service_1 = require("../../../prisma/prisma.service");
const redis_service_1 = require("../../../redis/redis.service");
const client_1 = require("@prisma/client");
const redis_health_util_1 = require("../../../common/utils/redis-health.util");
let AutoEscalateDisputesService = AutoEscalateDisputesService_1 = class AutoEscalateDisputesService {
    constructor(prisma, redis) {
        this.prisma = prisma;
        this.redis = redis;
        this.logger = new common_1.Logger(AutoEscalateDisputesService_1.name);
    }
    async escalateBreachedDisputes() {
        if (!(await (0, redis_health_util_1.ensureRedisAvailable)(this.redis, 'auto-escalate-disputes')))
            return;
        const lockKey = 'cron_lock:auto_escalate_disputes';
        const lockToken = (0, crypto_1.randomUUID)();
        const acquired = await this.redis.setNx(lockKey, lockToken, 1800);
        if (!acquired)
            return;
        const now = new Date();
        try {
            const escalatableStatuses = [
                client_1.DisputeStatus.OPEN,
                client_1.DisputeStatus.ASSIGNED,
                client_1.DisputeStatus.UNDER_REVIEW,
                client_1.DisputeStatus.WAITING_RESPONSE,
            ];
            while (true) {
                const breached = await this.prisma.dispute.findMany({
                    where: {
                        status: { in: escalatableStatuses },
                        slaDeadlineAt: { lt: now },
                        isSlaBreached: false,
                    },
                    select: { id: true, disputeId: true, status: true },
                    take: 500,
                });
                if (breached.length === 0)
                    break;
                this.logger.log(`Auto-escalating ${breached.length} SLA-breached dispute(s).`);
                let escalatedInBatch = 0;
                for (const dispute of breached) {
                    try {
                        const updated = await this.prisma.dispute.updateMany({
                            where: {
                                id: dispute.id,
                                status: { in: escalatableStatuses },
                                slaDeadlineAt: { lt: now },
                                isSlaBreached: false,
                            },
                            data: {
                                status: client_1.DisputeStatus.ESCALATED,
                                isSlaBreached: true,
                            },
                        });
                        if (updated.count > 0) {
                            escalatedInBatch += updated.count;
                            this.logger.warn(`Dispute ${dispute.disputeId} escalated due to SLA breach.`);
                            const systemAdmin = await this.prisma.adminUser.findFirst({
                                where: { role: 'SUPER_ADMIN', isActive: true },
                                orderBy: { createdAt: 'asc' },
                                select: { id: true },
                            });
                            const targetAdmin = systemAdmin ?? await this.prisma.adminUser.findFirst({
                                where: { isActive: true },
                                orderBy: { createdAt: 'asc' },
                                select: { id: true },
                            });
                            if (targetAdmin) {
                                await this.prisma.adminAuditLog.create({
                                    data: {
                                        adminId: targetAdmin.id,
                                        action: client_1.AuditAction.DISPUTE_ESCALATED,
                                        targetType: 'Dispute',
                                        targetId: dispute.id,
                                        description: `[SYSTEM] Dispute ${dispute.disputeId} auto-escalated — SLA breached. Requires immediate attention.${!systemAdmin ? ' (No SUPER_ADMIN available)' : ''}`,
                                        ipAddress: 'system',
                                    },
                                }).catch((err) => {
                                    this.logger.error(`Failed to create audit log for escalated dispute ${dispute.disputeId}: ${err?.message || err}`);
                                });
                                this.logger.error(`[ADMIN ALERT] Dispute SLA Breached: ${dispute.disputeId} auto-escalated — requires immediate admin attention.`);
                            }
                            else {
                                this.logger.warn(`No active admin found for escalation of dispute ${dispute.disputeId}`);
                            }
                        }
                    }
                    catch (err) {
                        const msg = err instanceof Error ? err.message : String(err);
                        this.logger.error(`Failed to escalate dispute ${dispute.disputeId}: ${msg}`);
                    }
                }
                if (breached.length < 500 || escalatedInBatch === 0)
                    break;
            }
        }
        catch (error) {
            this.logger.error('AutoEscalateDisputes FAILED', error);
        }
        finally {
            await this.redis.releaseLock(lockKey, lockToken).catch((err) => this.logger.warn(`silent-catch: ${err instanceof Error ? err.message : String(err)}`));
        }
    }
};
exports.AutoEscalateDisputesService = AutoEscalateDisputesService;
__decorate([
    (0, schedule_1.Cron)('0 * * * *', { name: 'auto-escalate-disputes' }),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", Promise)
], AutoEscalateDisputesService.prototype, "escalateBreachedDisputes", null);
exports.AutoEscalateDisputesService = AutoEscalateDisputesService = AutoEscalateDisputesService_1 = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [prisma_service_1.PrismaService,
        redis_service_1.RedisService])
], AutoEscalateDisputesService);
