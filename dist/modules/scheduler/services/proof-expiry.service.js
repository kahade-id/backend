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
var ProofExpiryService_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.ProofExpiryService = void 0;
const common_1 = require("@nestjs/common");
const schedule_1 = require("@nestjs/schedule");
const client_1 = require("@prisma/client");
const crypto_1 = require("crypto");
const notification_category_map_1 = require("../../notifications/notification-category.map");
const prisma_service_1 = require("../../../prisma/prisma.service");
const redis_service_1 = require("../../../redis/redis.service");
const cron_jitter_util_1 = require("../../../common/utils/cron-jitter.util");
const id_generator_util_1 = require("../../../common/utils/id-generator.util");
const redis_health_util_1 = require("../../../common/utils/redis-health.util");
let ProofExpiryService = ProofExpiryService_1 = class ProofExpiryService {
    constructor(prisma, redis) {
        this.prisma = prisma;
        this.redis = redis;
        this.logger = new common_1.Logger(ProofExpiryService_1.name);
    }
    runRealtimeBestEffort(task, label) {
        try {
            task();
        }
        catch (error) {
            this.logger.warn(`${label} realtime side effect failed: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    async expireUnreviewedProofs() {
        await (0, cron_jitter_util_1.cronJitter)(15_000);
        if (!(await (0, redis_health_util_1.ensureRedisAvailable)(this.redis, 'proof-expiry')))
            return;
        const lockKey = 'cron_lock:proof_expiry';
        const lockToken = (0, crypto_1.randomUUID)();
        const acquired = await this.redis.setNx(lockKey, lockToken, 600);
        if (!acquired)
            return;
        let lockLost = false;
        const lockRenewalInterval = setInterval(async () => {
            const renewed = await this.redis.renewLock(lockKey, lockToken, 600);
            if (!renewed) {
                lockLost = true;
                clearInterval(lockRenewalInterval);
                this.logger.warn('Proof expiry lock ownership was lost; stopping after the current batch.');
            }
        }, 60_000);
        const now = new Date();
        try {
            let hasMore = true;
            while (hasMore) {
                if (lockLost || await this.redis.get(lockKey) !== lockToken) {
                    this.logger.warn('Proof expiry lock ownership was lost; aborting before the next batch.');
                    return;
                }
                const expiredProofs = await this.prisma.deliveryProof.findMany({
                    where: {
                        status: 'SUBMITTED',
                        reviewWindowEnd: { lt: now },
                    },
                    select: {
                        id: true,
                        orderId: true,
                        order: {
                            select: { orderId: true, title: true, buyerId: true, sellerId: true, status: true },
                        },
                    },
                    take: 100,
                });
                if (expiredProofs.length === 0)
                    break;
                hasMore = expiredProofs.length === 100;
                this.logger.log(`Found ${expiredProofs.length} expired unreviewed delivery proofs — auto-rejecting`);
                for (const proof of expiredProofs) {
                    try {
                        const updated = await this.prisma.deliveryProof.updateMany({
                            where: { id: proof.id, status: 'SUBMITTED', reviewWindowEnd: { lt: now }, order: { status: 'IN_DELIVERY' } },
                            data: {
                                status: 'REJECTED',
                                reviewedAt: new Date(),
                                rejectionNote: 'Auto-expired: buyer did not review within the review window',
                            },
                        });
                        if (updated.count === 0)
                            continue;
                        this.prisma.notification.create({
                            data: {
                                notifId: (0, id_generator_util_1.generateNotifId)(),
                                userId: proof.order.sellerId,
                                type: client_1.NotificationType.ORDER_DELIVERED,
                                category: (0, notification_category_map_1.getCategoryForType)(client_1.NotificationType.ORDER_DELIVERED),
                                title: 'Bukti Pengiriman Kedaluwarsa',
                                body: `Bukti pengiriman untuk order "${proof.order.title}" sudah melewati batas waktu review. Silakan kirim bukti pengiriman baru.`,
                                isRead: false,
                            },
                        }).catch((notificationError) => this.logger.warn(`silent-catch: proof expiry notification failed: ${notificationError instanceof Error ? notificationError.message : String(notificationError)}`));
                        this.runRealtimeBestEffort(() => this.prisma.emitNotificationCreated({
                            userId: proof.order.sellerId,
                            title: 'Bukti Pengiriman Kedaluwarsa',
                            body: `Bukti pengiriman untuk order "${proof.order.title}" kedaluwarsa. Kirim ulang bukti baru.`,
                            data: { type: 'ORDER_DELIVERED', orderId: proof.order.orderId },
                        }), `PROOF_EXPIRY_NOTIFICATION orderId=${proof.order.orderId}`);
                        this.logger.log(`Auto-expired proof ${proof.id} for order ${proof.order.orderId}`);
                    }
                    catch (err) {
                        this.logger.error(`Failed to expire proof ${proof.id}: ${err instanceof Error ? err.message : String(err)}`);
                    }
                }
            }
        }
        catch (error) {
            this.logger.error('ProofExpiryService FAILED', error);
        }
        finally {
            clearInterval(lockRenewalInterval);
            await this.redis.releaseLock(lockKey, lockToken).catch((err) => this.logger.warn(`silent-catch: ${err instanceof Error ? err.message : String(err)}`));
        }
    }
};
exports.ProofExpiryService = ProofExpiryService;
__decorate([
    (0, schedule_1.Cron)('*/15 * * * *', { name: 'proof-expiry' }),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", Promise)
], ProofExpiryService.prototype, "expireUnreviewedProofs", null);
exports.ProofExpiryService = ProofExpiryService = ProofExpiryService_1 = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [prisma_service_1.PrismaService,
        redis_service_1.RedisService])
], ProofExpiryService);
