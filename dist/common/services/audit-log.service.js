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
var __param = (this && this.__param) || function (paramIndex, decorator) {
    return function (target, key) { decorator(target, key, paramIndex); }
};
var AuditLogService_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.AuditLogService = exports.AUDIT_LOG_QUEUE = void 0;
const common_1 = require("@nestjs/common");
const bull_1 = require("@nestjs/bull");
const client_1 = require("@prisma/client");
const prisma_service_1 = require("../../prisma/prisma.service");
exports.AUDIT_LOG_QUEUE = 'audit-log';
let AuditLogService = AuditLogService_1 = class AuditLogService {
    constructor(prisma, auditQueue) {
        this.prisma = prisma;
        this.auditQueue = auditQueue;
        this.logger = new common_1.Logger(AuditLogService_1.name);
    }
    logUserAction(params) {
        if (this.auditQueue) {
            this.auditQueue.add('write', { type: 'user', params }, {
                attempts: 3,
                backoff: { type: 'exponential', delay: 1000 },
                removeOnComplete: 100,
                removeOnFail: false,
            }).catch((err) => {
                this.logger.error(`[AuditLog] Failed to enqueue user audit log (${params.action}): ${err.message}`);
                this.writeDirectFallback('user', params);
            });
        }
        else {
            this.writeDirectFallback('user', params);
        }
    }
    logAdminAction(params) {
        if (this.auditQueue) {
            this.auditQueue.add('write', { type: 'admin', params }, {
                attempts: 3,
                backoff: { type: 'exponential', delay: 1000 },
                removeOnComplete: 100,
                removeOnFail: false,
            }).catch((err) => {
                this.logger.error(`[AuditLog] Failed to enqueue admin audit log (${params.action}): ${err.message}`);
                this.writeDirectFallback('admin', params);
            });
        }
        else {
            this.writeDirectFallback('admin', params);
        }
    }
    async writeUserAction(params) {
        await this.prisma.auditLog.create({
            data: {
                userId: params.userId ?? null,
                action: params.action,
                entityType: params.entityType,
                entityId: params.entityId,
                description: params.description,
                before: (params.before ?? client_1.Prisma.DbNull),
                after: (params.after ?? client_1.Prisma.DbNull),
                ipAddress: params.ipAddress ?? null,
                userAgent: params.userAgent ?? null,
                requestId: params.requestId ?? null,
            },
        });
    }
    async writeAdminAction(params) {
        await this.prisma.adminAuditLog.create({
            data: {
                adminId: params.adminId,
                action: params.action,
                targetType: params.targetType ?? null,
                targetId: params.targetId ?? null,
                description: params.description,
                before: (params.before ?? client_1.Prisma.DbNull),
                after: (params.after ?? client_1.Prisma.DbNull),
                ipAddress: params.ipAddress,
                userAgent: params.userAgent ?? null,
            },
        });
    }
    writeDirectFallback(type, params, attempt = 1) {
        const label = type === 'user'
            ? `user audit log (${params.action})`
            : `admin audit log (${params.action})`;
        const fn = type === 'user'
            ? () => this.writeUserAction(params)
            : () => this.writeAdminAction(params);
        fn().catch((err) => {
            this.logger.error(`[AuditLog] Direct write failed for ${label} (attempt ${attempt}): ${err.message}`);
            if (attempt < 3) {
                const delay = attempt * 1000;
                setTimeout(() => this.writeDirectFallback(type, params, attempt + 1), delay);
            }
            else {
                this.logger.error(`[AuditLog] CRITICAL: Exhausted direct retries for ${label} — audit event lost`);
                if (this.auditQueue) {
                    this.auditQueue.add('dead-letter-fallback', {
                        type,
                        params,
                        _deadLetterReason: `Direct write exhausted after ${attempt} attempts`,
                    }, {
                        attempts: 1,
                        removeOnComplete: false,
                        removeOnFail: false,
                    }).catch(() => {
                        this.logger.error(`[AuditLog] CRITICAL: DLQ fallback also failed for ${label} — audit event permanently lost`);
                    });
                }
            }
        });
    }
};
exports.AuditLogService = AuditLogService;
exports.AuditLogService = AuditLogService = AuditLogService_1 = __decorate([
    (0, common_1.Injectable)(),
    __param(1, (0, common_1.Optional)()),
    __param(1, (0, bull_1.InjectQueue)(exports.AUDIT_LOG_QUEUE)),
    __metadata("design:paramtypes", [prisma_service_1.PrismaService, Object])
], AuditLogService);
