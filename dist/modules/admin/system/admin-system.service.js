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
var AdminSystemService_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.AdminSystemService = void 0;
const common_1 = require("@nestjs/common");
const crypto_1 = require("crypto");
const prisma_service_1 = require("../../../prisma/prisma.service");
const redis_service_1 = require("../../../redis/redis.service");
const audit_log_service_1 = require("../../../common/services/audit-log.service");
const notification_queue_service_1 = require("../../queue/notification-queue.service");
const pagination_dto_1 = require("../../../common/dto/pagination.dto");
const client_1 = require("@prisma/client");
const sanitize_util_1 = require("../../../common/utils/sanitize.util");
const ErrorCodes = __importStar(require("../../../common/constants/error-codes"));
const redis_keys_1 = require("../../../common/constants/redis-keys");
const id_generator_util_1 = require("../../../common/utils/id-generator.util");
const date_util_1 = require("../../../common/utils/date.util");
const SYSTEM_CONFIG_TTL = 300;
const SYSTEM_CONFIG_LOCK_TTL = 10;
const PENDING_CONFIG_PREFIX = 'pending_config_change:';
const PENDING_CONFIG_TTL = 86400;
const MAX_ADMIN_PAGE = 100_000;
const FINANCIAL_CONFIG_KEYS = [
    'fee_percentage',
    'platform_fee',
    'commission_rate',
    'kahade_fee_rate',
    'kahade_plus_fee_rate',
    'withdrawal_fee',
    'payment_fee',
    'escrow_fee',
    'fee_savings_limit',
];
let AdminSystemService = AdminSystemService_1 = class AdminSystemService {
    constructor(prisma, redis, auditLogService, notificationQueue) {
        this.prisma = prisma;
        this.redis = redis;
        this.auditLogService = auditLogService;
        this.notificationQueue = notificationQueue;
        this.logger = new common_1.Logger(AdminSystemService_1.name);
    }
    async listConfigs() {
        const cached = await this.redis.get(redis_keys_1.ADMIN_SYSTEM_CONFIGS);
        if (cached) {
            try {
                return JSON.parse(cached);
            }
            catch (_) {
                await this.redis.del(redis_keys_1.ADMIN_SYSTEM_CONFIGS);
            }
        }
        const lockKey = `${redis_keys_1.ADMIN_SYSTEM_CONFIGS}:lock`;
        const lockToken = (0, crypto_1.randomBytes)(16).toString('hex');
        let lockAcquired = false;
        let redisDown = false;
        try {
            lockAcquired = await this.redis.setNx(lockKey, lockToken, SYSTEM_CONFIG_LOCK_TTL);
        }
        catch (_) {
            redisDown = true;
        }
        if (!lockAcquired) {
            if (!redisDown) {
                for (let i = 0; i < 5; i++) {
                    await new Promise((resolve) => setTimeout(resolve, 200));
                    const retry = await this.redis.get(redis_keys_1.ADMIN_SYSTEM_CONFIGS);
                    if (retry) {
                        try {
                            return JSON.parse(retry);
                        }
                        catch (_) {
                            break;
                        }
                    }
                }
            }
            return this.prisma.systemConfig.findMany({ orderBy: { key: 'asc' }, take: 100 });
        }
        try {
            const configs = await this.prisma.systemConfig.findMany({
                orderBy: { key: 'asc' },
                take: 100,
            });
            await this.redis.setex(redis_keys_1.ADMIN_SYSTEM_CONFIGS, SYSTEM_CONFIG_TTL, JSON.stringify(configs));
            return configs;
        }
        finally {
            await this.redis.releaseLock(lockKey, lockToken);
        }
    }
    isFinancialConfig(key) {
        const lowerKey = key.toLowerCase();
        return FINANCIAL_CONFIG_KEYS.some(fk => lowerKey.includes(fk));
    }
    validateConfigValue(key, value, dataType) {
        if (dataType === 'NUMBER') {
            const parsed = Number(value.trim());
            if (!Number.isFinite(parsed)) {
                throw new common_1.BadRequestException({
                    code: ErrorCodes.VALIDATION_ERROR,
                    message: `Value "${value}" is not a valid number for config key "${key}" (dataType: NUMBER)`,
                });
            }
            if (parsed < 0) {
                throw new common_1.BadRequestException({
                    code: ErrorCodes.VALIDATION_ERROR,
                    message: `Numeric config "${key}" cannot be negative`,
                });
            }
            if (parsed > 1_000_000_000) {
                throw new common_1.BadRequestException({
                    code: ErrorCodes.VALIDATION_ERROR,
                    message: `Numeric config "${key}" exceeds maximum allowed value (1,000,000,000)`,
                });
            }
        }
        else if (dataType === 'BOOLEAN') {
            if (!['true', 'false'].includes(value.toLowerCase())) {
                throw new common_1.BadRequestException({
                    code: ErrorCodes.VALIDATION_ERROR,
                    message: `Value "${value}" must be "true" or "false" for config key "${key}" (dataType: BOOLEAN)`,
                });
            }
        }
        else if (dataType === 'JSON') {
            try {
                JSON.parse(value);
            }
            catch {
                throw new common_1.BadRequestException({
                    code: ErrorCodes.VALIDATION_ERROR,
                    message: `Value for config key "${key}" is not valid JSON`,
                });
            }
        }
    }
    async updateConfig(key, dto, adminId, ipAddress) {
        const existing = await this.prisma.systemConfig.findUnique({
            where: { key },
        });
        if (!existing) {
            throw new common_1.NotFoundException({
                code: ErrorCodes.NOT_FOUND,
                message: `System config with key '${key}' not found`,
            });
        }
        this.validateConfigValue(key, dto.value, existing.dataType);
        if (this.isFinancialConfig(key)) {
            const pendingKey = `${PENDING_CONFIG_PREFIX}${key}`;
            const pendingChange = {
                key,
                proposedValue: dto.value,
                proposedDescription: dto.description,
                currentValue: existing.value,
                currentDescription: existing.description,
                proposedBy: adminId,
                proposedAt: new Date().toISOString(),
                ipAddress,
            };
            const claimed = await this.redis.setNx(pendingKey, JSON.stringify(pendingChange), PENDING_CONFIG_TTL, { throwOnError: true });
            if (!claimed) {
                throw new common_1.ConflictException({ code: 'CONFIG_CHANGE_PENDING', message: `A pending change already exists for config '${key}'` });
            }
            this.auditLogService.logAdminAction({
                adminId,
                action: client_1.AuditAction.SYSTEM_CONFIG_CHANGED,
                targetType: 'SystemConfig',
                targetId: existing.id,
                description: `Proposed financial config change for '${key}' (pending approval)`,
                before: { value: existing.value },
                after: { proposedValue: dto.value },
                ipAddress,
            });
            return {
                status: 'pending_approval',
                message: `Financial config '${key}' change requires approval from another admin`,
                proposedValue: dto.value,
                currentValue: existing.value,
            };
        }
        const before = { value: existing.value, description: existing.description };
        const updated = await this.prisma.systemConfig.update({
            where: { key },
            data: {
                value: dto.value,
                description: dto.description !== undefined ? dto.description : existing.description,
                updatedBy: adminId,
            },
        });
        await Promise.all([
            this.redis.del(redis_keys_1.ADMIN_SYSTEM_CONFIGS),
            this.redis.del(redis_keys_1.FEE_CONFIG_CACHE),
            this.redis.del(redis_keys_1.SUBSCRIPTION_PLANS_CACHE),
            this.redis.del(`${redis_keys_1.SUBSCRIPTION_PLANS_CACHE}:plans`),
            this.redis.del('public:system:configs'),
        ]);
        this.auditLogService.logAdminAction({
            adminId,
            action: client_1.AuditAction.SYSTEM_CONFIG_CHANGED,
            targetType: 'SystemConfig',
            targetId: existing.id,
            description: `Updated system config '${key}'`,
            before,
            after: { value: dto.value, description: updated.description },
            ipAddress,
        });
        return updated;
    }
    async getPendingConfigChange(key) {
        const pendingKey = `${PENDING_CONFIG_PREFIX}${key}`;
        const raw = await this.redis.get(pendingKey);
        if (!raw)
            return null;
        try {
            return JSON.parse(raw);
        }
        catch {
            return null;
        }
    }
    async listPendingConfigChanges() {
        const keys = await this.redis.scan(`${PENDING_CONFIG_PREFIX}*`);
        const results = [];
        const prefix = this.redis.getPrefix();
        for (const rawKey of keys) {
            const key = rawKey.startsWith(prefix) ? rawKey.slice(prefix.length) : rawKey;
            const raw = await this.redis.get(key);
            if (raw) {
                try {
                    results.push(JSON.parse(raw));
                }
                catch {
                    this.logger.warn(`Failed to parse pending config JSON for key: ${rawKey}`);
                }
            }
        }
        return results;
    }
    async approveConfigChange(key, approverId, ipAddress) {
        const lockKey = `${PENDING_CONFIG_PREFIX}${key}:lock`;
        const lockToken = (0, crypto_1.randomBytes)(16).toString('hex');
        if (!await this.redis.setNx(lockKey, lockToken, SYSTEM_CONFIG_LOCK_TTL, { throwOnError: true })) {
            throw new common_1.ConflictException({ code: 'CONFIG_CHANGE_IN_PROGRESS', message: 'This config change is already being processed' });
        }
        try {
            const pendingKey = `${PENDING_CONFIG_PREFIX}${key}`;
            const raw = await this.redis.get(pendingKey);
            if (!raw) {
                throw new common_1.NotFoundException({
                    code: ErrorCodes.NOT_FOUND,
                    message: `No pending config change found for key '${key}'`,
                });
            }
            const pending = JSON.parse(raw);
            if (pending.proposedBy === approverId) {
                throw new common_1.ForbiddenException({
                    code: ErrorCodes.FORBIDDEN,
                    message: 'Cannot approve your own config change. A different admin must approve.',
                });
            }
            const existing = await this.prisma.systemConfig.findUnique({ where: { key } });
            if (!existing) {
                throw new common_1.NotFoundException({
                    code: ErrorCodes.NOT_FOUND,
                    message: `System config with key '${key}' not found`,
                });
            }
            const updated = await this.prisma.systemConfig.update({
                where: { key },
                data: {
                    value: pending.proposedValue,
                    description: pending.proposedDescription !== undefined ? pending.proposedDescription : existing.description,
                    updatedBy: approverId,
                },
            });
            await Promise.all([
                this.redis.del(redis_keys_1.ADMIN_SYSTEM_CONFIGS),
                this.redis.del(redis_keys_1.FEE_CONFIG_CACHE),
                this.redis.del(redis_keys_1.SUBSCRIPTION_PLANS_CACHE),
                this.redis.del(`${redis_keys_1.SUBSCRIPTION_PLANS_CACHE}:plans`),
                this.redis.del('public:system:configs'),
                this.redis.del(pendingKey),
            ]);
            this.auditLogService.logAdminAction({
                adminId: approverId,
                action: client_1.AuditAction.SYSTEM_CONFIG_CHANGED,
                targetType: 'SystemConfig',
                targetId: existing.id,
                description: `Approved financial config change for '${key}' (proposed by ${pending.proposedBy})`,
                before: { value: pending.currentValue },
                after: { value: pending.proposedValue, approvedBy: approverId, proposedBy: pending.proposedBy },
                ipAddress,
            });
            return updated;
        }
        finally {
            await this.redis.releaseLock(lockKey, lockToken);
        }
    }
    async rejectConfigChange(key, rejecterId, ipAddress) {
        const lockKey = `${PENDING_CONFIG_PREFIX}${key}:lock`;
        const lockToken = (0, crypto_1.randomBytes)(16).toString('hex');
        if (!await this.redis.setNx(lockKey, lockToken, SYSTEM_CONFIG_LOCK_TTL, { throwOnError: true })) {
            throw new common_1.ConflictException({ code: 'CONFIG_CHANGE_IN_PROGRESS', message: 'This config change is already being processed' });
        }
        try {
            const pendingKey = `${PENDING_CONFIG_PREFIX}${key}`;
            const raw = await this.redis.get(pendingKey);
            if (!raw) {
                throw new common_1.NotFoundException({
                    code: ErrorCodes.NOT_FOUND,
                    message: `No pending config change found for key '${key}'`,
                });
            }
            const pending = JSON.parse(raw);
            await this.redis.del(pendingKey);
            const existing = await this.prisma.systemConfig.findUnique({ where: { key } });
            this.auditLogService.logAdminAction({
                adminId: rejecterId,
                action: client_1.AuditAction.SYSTEM_CONFIG_CHANGED,
                targetType: 'SystemConfig',
                targetId: existing?.id ?? key,
                description: `Rejected financial config change for '${key}' (proposed by ${pending.proposedBy})`,
                after: { rejectedValue: pending.proposedValue, rejectedBy: rejecterId },
                ipAddress,
            });
            return { message: `Pending config change for '${key}' has been rejected` };
        }
        finally {
            await this.redis.releaseLock(lockKey, lockToken);
        }
    }
    async listAuditLogs(query) {
        const { page = 1, limit = 20, action, adminId, targetType, startDate, endDate } = query;
        const safeLimit = Math.min(limit, 100);
        const safePage = Math.min(Math.max(page, 1), MAX_ADMIN_PAGE);
        const skip = (safePage - 1) * safeLimit;
        const where = {};
        if (action) {
            where.action = action;
        }
        if (adminId) {
            where.adminId = adminId;
        }
        if (targetType) {
            where.targetType = targetType;
        }
        if (startDate || endDate) {
            where.createdAt = {};
            if (startDate)
                where.createdAt.gte = (0, date_util_1.parseDateBoundaryWIB)(startDate, 'start');
            if (endDate)
                where.createdAt.lte = (0, date_util_1.parseDateBoundaryWIB)(endDate, 'end');
        }
        const [data, total] = await Promise.all([
            this.prisma.adminAuditLog.findMany({
                where,
                orderBy: { createdAt: 'desc' },
                skip,
                take: safeLimit,
                include: {
                    admin: {
                        select: { id: true, fullName: true, role: true },
                    },
                },
            }),
            this.prisma.adminAuditLog.count({ where }),
        ]);
        return (0, pagination_dto_1.createPaginatedResponse)(data, total, safePage, safeLimit);
    }
    async listWebhookLogs(query) {
        const { page = 1, limit = 20, source, isProcessed, deadLettered, search, startDate, endDate } = query;
        const safeLimit = Math.min(limit, 100);
        const safePage = Math.min(Math.max(page, 1), MAX_ADMIN_PAGE);
        const skip = (safePage - 1) * safeLimit;
        const where = {};
        if (source) {
            where.source = source;
        }
        if (isProcessed !== undefined) {
            where.isProcessed = isProcessed === 'true';
        }
        if (deadLettered !== undefined) {
            where.deadLetteredAt = deadLettered === 'true' ? { not: null } : null;
        }
        if (search) {
            where.OR = [
                { source: { contains: search, mode: 'insensitive' } },
                { event: { contains: search, mode: 'insensitive' } },
                { errorMessage: { contains: search, mode: 'insensitive' } },
            ];
        }
        if (startDate || endDate) {
            where.createdAt = {};
            if (startDate)
                where.createdAt.gte = (0, date_util_1.parseDateBoundaryWIB)(startDate, 'start');
            if (endDate)
                where.createdAt.lte = (0, date_util_1.parseDateBoundaryWIB)(endDate, 'end');
        }
        const [data, total] = await Promise.all([
            this.prisma.webhookLog.findMany({
                where,
                orderBy: { createdAt: 'desc' },
                skip,
                take: safeLimit,
            }),
            this.prisma.webhookLog.count({ where }),
        ]);
        return (0, pagination_dto_1.createPaginatedResponse)(data, total, safePage, safeLimit);
    }
    async retryDeadLetterWebhook(id, adminId, ipAddress) {
        const existing = await this.prisma.webhookLog.findUnique({ where: { id } });
        if (!existing) {
            throw new common_1.NotFoundException({ code: 'WEBHOOK_LOG_NOT_FOUND', message: 'Webhook log not found' });
        }
        if (existing.isProcessed) {
            throw new common_1.BadRequestException({ code: 'WEBHOOK_ALREADY_PROCESSED', message: 'Processed webhook cannot be retried' });
        }
        if (!existing.deadLetteredAt || String(existing.errorMessage ?? '').startsWith('MANUAL_RESOLUTION:')) {
            throw new common_1.BadRequestException({ code: 'WEBHOOK_NOT_DEAD_LETTERED', message: 'Only unresolved dead-letter webhooks can be retried' });
        }
        const updated = await this.prisma.webhookLog.updateMany({
            where: { id, isProcessed: false },
            data: {
                retryCount: 0,
                lastAttemptAt: null,
                nextRetryAt: new Date(),
                deadLetteredAt: null,
                errorMessage: null,
            },
        });
        if (updated.count === 0) {
            throw new common_1.BadRequestException({ code: 'WEBHOOK_RETRY_CONFLICT', message: 'Webhook state changed; reload and try again' });
        }
        this.auditLogService.logAdminAction({
            adminId,
            action: client_1.AuditAction.ADMIN_ACTION,
            targetType: 'WebhookLog',
            targetId: id,
            description: `Manually requeued dead-letter webhook ${id}`,
            before: { retryCount: existing.retryCount, deadLetteredAt: existing.deadLetteredAt, errorMessage: existing.errorMessage },
            after: { retryCount: 0, nextRetryAt: 'now', deadLetteredAt: null },
            ipAddress,
        });
        return { id, status: 'queued', message: 'Webhook queued for retry' };
    }
    async resolveDeadLetterWebhook(id, adminId, ipAddress, resolution) {
        const existing = await this.prisma.webhookLog.findUnique({ where: { id } });
        if (!existing) {
            throw new common_1.NotFoundException({ code: 'WEBHOOK_LOG_NOT_FOUND', message: 'Webhook log not found' });
        }
        if (existing.isProcessed) {
            throw new common_1.BadRequestException({ code: 'WEBHOOK_ALREADY_PROCESSED', message: 'Processed webhook needs no resolution' });
        }
        if (!existing.deadLetteredAt || String(existing.errorMessage ?? '').startsWith('MANUAL_RESOLUTION:')) {
            throw new common_1.BadRequestException({ code: 'WEBHOOK_NOT_DEAD_LETTERED', message: 'Only unresolved dead-letter webhooks can be resolved' });
        }
        const safeResolution = resolution.trim().slice(0, 500);
        if (!safeResolution) {
            throw new common_1.BadRequestException({ code: 'WEBHOOK_RESOLUTION_REQUIRED', message: 'Resolution is required' });
        }
        const updated = await this.prisma.webhookLog.updateMany({
            where: { id, isProcessed: false },
            data: {
                deadLetteredAt: new Date(),
                nextRetryAt: null,
                errorMessage: `MANUAL_RESOLUTION: ${safeResolution}`,
            },
        });
        if (updated.count === 0) {
            throw new common_1.BadRequestException({ code: 'WEBHOOK_RESOLVE_CONFLICT', message: 'Webhook state changed; reload and try again' });
        }
        this.auditLogService.logAdminAction({
            adminId,
            action: client_1.AuditAction.ADMIN_ACTION,
            targetType: 'WebhookLog',
            targetId: id,
            description: `Manually resolved dead-letter webhook ${id}`,
            before: { retryCount: existing.retryCount, deadLetteredAt: existing.deadLetteredAt, errorMessage: existing.errorMessage },
            after: { deadLetteredAt: 'now', resolution: safeResolution },
            ipAddress,
        });
        return { id, status: 'resolved', message: 'Webhook marked as manually resolved' };
    }
    async sendBroadcast(dto, adminId, ipAddress) {
        const where = { deletedAt: null };
        const pushRequested = dto.channels.includes('push');
        const inAppRequested = dto.channels.includes('in_app');
        switch (dto.targetAudience) {
            case 'active':
                where.lastLoginAt = { gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) };
                break;
            case 'kahade_plus':
                where.subscriptions = { some: { status: 'ACTIVE', currentPeriodEnd: { gt: new Date() } } };
                break;
            case 'verified':
                where.kycStatus = client_1.KycStatus.APPROVED;
                break;
        }
        const broadcastId = `broadcast-${(0, crypto_1.randomBytes)(12).toString('hex')}`;
        const FETCH_BATCH = 10_000;
        const STAGE_DELAY_MS = 2_000;
        let totalRecipients = 0;
        let queuedCount = 0;
        let cursor;
        let batchNumber = 0;
        const progressKey = `broadcast_progress:${broadcastId}`;
        while (true) {
            const batch = await this.prisma.user.findMany({
                where,
                select: { id: true },
                take: FETCH_BATCH,
                ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
                orderBy: { id: 'asc' },
            });
            if (batch.length === 0)
                break;
            cursor = batch[batch.length - 1].id;
            totalRecipients += batch.length;
            batchNumber++;
            if (batchNumber > 1) {
                await new Promise((resolve) => setTimeout(resolve, STAGE_DELAY_MS));
            }
            const safeTitle = (0, sanitize_util_1.escapeHtml)(dto.title ?? '');
            const safeBody = (0, sanitize_util_1.escapeHtml)(dto.body ?? '');
            if (pushRequested) {
                const QUEUE_BATCH = 500;
                const jobs = batch.map((user) => ({
                    userId: user.id,
                    type: client_1.NotificationType.SYSTEM_ANNOUNCEMENT,
                    title: safeTitle,
                    body: safeBody,
                    channel: client_1.NotificationChannel.PUSH_NOTIFICATION,
                    actionUrl: '/notifications',
                    pushData: {
                        notificationType: client_1.NotificationType.SYSTEM_ANNOUNCEMENT,
                        notificationCategory: client_1.NotificationCategory.INFORMASI,
                        broadcastId,
                    },
                }));
                for (let i = 0; i < jobs.length; i += QUEUE_BATCH) {
                    queuedCount += await this.notificationQueue.enqueueMany(jobs.slice(i, i + QUEUE_BATCH));
                }
            }
            else if (inAppRequested) {
                const notifications = batch.map((user) => ({
                    notifId: (0, id_generator_util_1.generateNotifId)(),
                    userId: user.id,
                    type: client_1.NotificationType.SYSTEM_ANNOUNCEMENT,
                    category: client_1.NotificationCategory.INFORMASI,
                    title: safeTitle,
                    body: safeBody,
                    channel: client_1.NotificationChannel.IN_APP,
                    isRead: false,
                }));
                const INSERT_BATCH = 500;
                for (let i = 0; i < notifications.length; i += INSERT_BATCH) {
                    await this.prisma.notification.createMany({
                        data: notifications.slice(i, i + INSERT_BATCH),
                    });
                }
            }
            this.logger.log(`Broadcast ${broadcastId}: batch ${batchNumber} processed (${batch.length} users, ${totalRecipients} total so far)`);
            await this.redis.set(progressKey, JSON.stringify({ cursor, totalRecipients, batchNumber, updatedAt: new Date().toISOString() }), 86400);
            if (batch.length < FETCH_BATCH)
                break;
        }
        if (totalRecipients === 0) {
            return { recipientCount: 0, queuedCount: 0, pushRequested };
        }
        this.auditLogService.logAdminAction({
            adminId,
            action: client_1.AuditAction.BROADCAST_SENT,
            targetType: 'Broadcast',
            targetId: broadcastId,
            description: `Broadcast sent to ${totalRecipients} users (audience: ${dto.targetAudience ?? 'all'})`,
            after: { title: dto.title, channels: dto.channels, targetAudience: dto.targetAudience, recipientCount: totalRecipients },
            ipAddress,
        });
        this.logger.log(`Admin ${adminId} sent broadcast to ${totalRecipients} users`);
        return { recipientCount: totalRecipients, queuedCount, pushRequested };
    }
};
exports.AdminSystemService = AdminSystemService;
exports.AdminSystemService = AdminSystemService = AdminSystemService_1 = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [prisma_service_1.PrismaService,
        redis_service_1.RedisService,
        audit_log_service_1.AuditLogService,
        notification_queue_service_1.NotificationQueueService])
], AdminSystemService);
