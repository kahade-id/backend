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
var __param = (this && this.__param) || function (paramIndex, decorator) {
    return function (target, key) { decorator(target, key, paramIndex); }
};
var AdminKycService_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.AdminKycService = void 0;
const client_1 = require("@prisma/client");
const notification_category_map_1 = require("../../notifications/notification-category.map");
const common_1 = require("@nestjs/common");
const bull_1 = require("@nestjs/bull");
const prisma_service_1 = require("../../../prisma/prisma.service");
const redis_service_1 = require("../../../redis/redis.service");
const audit_log_service_1 = require("../../../common/services/audit-log.service");
const upload_service_1 = require("../../upload/upload.service");
const pagination_dto_1 = require("../../../common/dto/pagination.dto");
const crypto_util_1 = require("../../../common/utils/crypto.util");
const id_generator_util_1 = require("../../../common/utils/id-generator.util");
const sanitize_util_1 = require("../../../common/utils/sanitize.util");
const email_processor_1 = require("../../queue/processors/email.processor");
const ErrorCodes = __importStar(require("../../../common/constants/error-codes"));
let AdminKycService = AdminKycService_1 = class AdminKycService {
    constructor(prisma, redis, auditLog, uploadService, emailQueue) {
        this.prisma = prisma;
        this.redis = redis;
        this.auditLog = auditLog;
        this.uploadService = uploadService;
        this.emailQueue = emailQueue;
        this.logger = new common_1.Logger(AdminKycService_1.name);
    }
    async invalidateKycCache(userId) {
        try {
            await this.redis.del(`guard:kyc:${userId}`);
        }
        catch (err) {
            this.logger.warn(`Failed to invalidate KYC cache for user ${userId}`, err);
        }
    }
    normalizeOptionalText(value) {
        const normalized = value?.trim();
        return normalized ? normalized : null;
    }
    normalizeRequiredText(value, field) {
        const normalized = value.trim();
        if (!normalized) {
            throw new common_1.BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: `${field} must contain non-whitespace text` });
        }
        return normalized;
    }
    async getKycQueue(page = 1, limit = 20, status) {
        const safePage = Number.isFinite(page) ? Math.max(1, Math.floor(page)) : 1;
        const safeLimit = Number.isFinite(limit) ? Math.min(100, Math.max(1, Math.floor(limit))) : 20;
        const skip = (safePage - 1) * safeLimit;
        const validStatuses = ['PENDING', 'APPROVED', 'REJECTED', 'REVOKED'];
        if (status && !validStatuses.includes(status)) {
            throw new common_1.BadRequestException({
                code: ErrorCodes.INVALID_STATUS,
                message: `Invalid KYC status: ${status}. Valid values: ${validStatuses.join(', ')}`,
            });
        }
        const where = status ? { status: status } : {};
        const [requests, total] = await Promise.all([
            this.prisma.kycRequest.findMany({
                where,
                skip,
                take: safeLimit,
                orderBy: { createdAt: 'asc' },
                select: {
                    id: true,
                    kycId: true,
                    userId: true,
                    status: true,
                    rejectionReason: true,
                    attemptNumber: true,
                    createdAt: true,
                    reviewedAt: true,
                    reviewedBy: true,
                    user: { select: { userId: true, email: true, fullName: true } },
                    reviewer: { select: { adminId: true, fullName: true } },
                },
            }),
            this.prisma.kycRequest.count({ where }),
        ]);
        return (0, pagination_dto_1.createPaginatedResponse)(requests, total, safePage, safeLimit);
    }
    async approveKyc(kycId, adminId, notes, ipAddress = 'internal') {
        const normalizedNotes = this.normalizeOptionalText(notes);
        const request = await this.prisma.kycRequest.findFirst({
            where: { OR: [{ id: kycId }, { kycId }] },
            include: { user: { select: { id: true, userId: true, email: true, fullName: true } } },
        });
        if (!request)
            throw new common_1.NotFoundException({ code: ErrorCodes.KYC_NOT_FOUND, message: 'KYC request not found' });
        if (request.status !== 'PENDING') {
            throw new common_1.BadRequestException({ code: ErrorCodes.INVALID_STATUS, message: `KYC is already ${request.status}` });
        }
        const updated = await this.prisma.$transaction(async (tx) => {
            const guard = await tx.kycRequest.updateMany({
                where: { id: request.id, status: 'PENDING' },
                data: {
                    status: 'APPROVED',
                    reviewedBy: adminId,
                    reviewedAt: new Date(),
                    adminNotes: normalizedNotes,
                },
            });
            if (guard.count === 0) {
                throw new common_1.BadRequestException({ code: ErrorCodes.INVALID_STATUS, message: 'KYC request was already processed by another admin' });
            }
            const result = await tx.kycRequest.findUniqueOrThrow({ where: { id: request.id } });
            await tx.user.update({
                where: { id: request.userId },
                data: {
                    kycStatus: 'APPROVED',
                    kycApprovedAt: new Date(),
                },
            });
            return result;
        }, { isolationLevel: client_1.Prisma.TransactionIsolationLevel.Serializable });
        await this.invalidateKycCache(request.userId);
        this.auditLog.logAdminAction({
            adminId,
            action: client_1.AuditAction.KYC_APPROVED,
            targetType: 'KYC_REQUEST',
            targetId: kycId,
            description: `KYC ${kycId} approved for user ${request.userId}${normalizedNotes ? ': ' + normalizedNotes : ''}`,
            ipAddress,
        });
        void this.prisma.notification.create({
            data: { notifId: (0, id_generator_util_1.generateNotifId)(), userId: request.userId, type: client_1.NotificationType.KYC_APPROVED, category: (0, notification_category_map_1.getCategoryForType)(client_1.NotificationType.KYC_APPROVED), title: 'KYC Verification Approved', body: 'Congratulations! Your identity has been successfully verified. You can now perform escrow transactions.', isRead: false },
        }).catch((error) => this.logger.warn(`KYC approval notification failed after commit: ${error instanceof Error ? error.message : String(error)}`));
        this.prisma.emitNotificationCreated({
            userId: request.userId,
            title: 'KYC Verification Approved',
            body: 'Congratulations! Your identity has been successfully verified. You can now perform escrow transactions.',
            data: { type: 'KYC_APPROVED' },
        });
        if (request.user?.email) {
            this.emailQueue.add('send', {
                to: request.user.email,
                subject: 'Kahade — Your KYC Verification Has Been Approved',
                templateName: 'kyc-approved',
                templateContext: { name: request.user.fullName ?? 'User' },
            }, { attempts: 3, backoff: { type: 'exponential', delay: 5000 } }).catch((err) => {
                this.logger.error(`Failed to queue KYC approval email for ${request.user?.email}`, err);
            });
        }
        return updated;
    }
    async rejectKyc(kycId, adminId, reason, notes, ipAddress = 'internal') {
        const normalizedReason = this.normalizeRequiredText(reason, 'Rejection reason');
        const normalizedNotes = this.normalizeOptionalText(notes);
        const request = await this.prisma.kycRequest.findFirst({
            where: { OR: [{ id: kycId }, { kycId }] },
            include: { user: { select: { id: true, userId: true, email: true, fullName: true } } },
        });
        if (!request)
            throw new common_1.NotFoundException({ code: ErrorCodes.KYC_NOT_FOUND, message: 'KYC request not found' });
        if (request.status !== 'PENDING') {
            throw new common_1.BadRequestException({ code: ErrorCodes.INVALID_STATUS, message: `KYC is already ${request.status}` });
        }
        const updated = await this.prisma.$transaction(async (tx) => {
            const guard = await tx.kycRequest.updateMany({
                where: { id: request.id, status: 'PENDING' },
                data: {
                    status: 'REJECTED',
                    reviewedBy: adminId,
                    reviewedAt: new Date(),
                    rejectionReason: normalizedReason,
                    adminNotes: normalizedNotes,
                },
            });
            if (guard.count === 0) {
                throw new common_1.BadRequestException({ code: ErrorCodes.INVALID_STATUS, message: 'KYC request was already processed by another admin' });
            }
            const result = await tx.kycRequest.findUniqueOrThrow({ where: { id: request.id } });
            await tx.user.update({
                where: { id: request.userId },
                data: {
                    kycStatus: 'REJECTED',
                    kycApprovedAt: null,
                },
            });
            return result;
        }, { isolationLevel: client_1.Prisma.TransactionIsolationLevel.Serializable });
        await this.invalidateKycCache(request.userId);
        this.auditLog.logAdminAction({
            adminId,
            action: client_1.AuditAction.KYC_REJECTED,
            targetType: 'KYC_REQUEST',
            targetId: kycId,
            description: `KYC ${kycId} rejected for user ${request.userId}: ${normalizedReason}`,
            ipAddress,
        });
        const safeReason = (0, sanitize_util_1.escapeHtml)(normalizedReason);
        void this.prisma.notification.create({
            data: { notifId: (0, id_generator_util_1.generateNotifId)(), userId: request.userId, type: client_1.NotificationType.KYC_REJECTED, category: (0, notification_category_map_1.getCategoryForType)(client_1.NotificationType.KYC_REJECTED), title: 'KYC Verification Rejected', body: `Your KYC application could not be approved. Reason: ${safeReason}. Please resubmit with the correct documents.`, isRead: false },
        }).catch((error) => this.logger.warn(`KYC rejection notification failed after commit: ${error instanceof Error ? error.message : String(error)}`));
        const safeReasonForPush = (0, sanitize_util_1.escapeHtml)(normalizedReason);
        this.prisma.emitNotificationCreated({
            userId: request.userId,
            title: 'KYC Verification Rejected',
            body: `Your KYC application could not be approved. Reason: ${safeReasonForPush}. Please resubmit with the correct documents.`,
            data: { type: 'KYC_REJECTED' },
        });
        if (request.user?.email) {
            const safeReasonForEmail = (0, sanitize_util_1.escapeHtml)(normalizedReason);
            const safeNotesForEmail = normalizedNotes ? (0, sanitize_util_1.escapeHtml)(normalizedNotes) : undefined;
            this.emailQueue.add('send', {
                to: request.user.email,
                subject: 'Kahade — Your KYC Verification Was Not Approved',
                templateName: 'kyc-rejected',
                templateContext: { name: request.user.fullName ?? 'User', reason: safeReasonForEmail, notes: safeNotesForEmail },
            }, { attempts: 3, backoff: { type: 'exponential', delay: 5000 } }).catch((err) => {
                this.logger.error(`Failed to queue KYC rejection email for ${request.user?.email}`, err);
            });
        }
        return updated;
    }
    async revokeKyc(kycId, adminId, reason, ipAddress = 'internal') {
        const normalizedReason = this.normalizeRequiredText(reason, 'Revocation reason');
        const request = await this.prisma.kycRequest.findFirst({
            where: { OR: [{ id: kycId }, { kycId }] },
            include: { user: { select: { id: true, userId: true, email: true, fullName: true } } },
        });
        if (!request)
            throw new common_1.NotFoundException({ code: ErrorCodes.KYC_NOT_FOUND, message: 'KYC request not found' });
        if (request.status !== 'APPROVED') {
            throw new common_1.BadRequestException({ code: ErrorCodes.INVALID_STATUS, message: `KYC can only be revoked from APPROVED status, current: ${request.status}` });
        }
        const updated = await this.prisma.$transaction(async (tx) => {
            const guard = await tx.kycRequest.updateMany({
                where: { id: request.id, status: 'APPROVED' },
                data: {
                    status: 'REVOKED',
                    reviewedBy: adminId,
                    reviewedAt: new Date(),
                    rejectionReason: normalizedReason,
                },
            });
            if (guard.count === 0) {
                throw new common_1.BadRequestException({ code: ErrorCodes.INVALID_STATUS, message: 'KYC request was already processed by another admin' });
            }
            const result = await tx.kycRequest.findUniqueOrThrow({ where: { id: request.id } });
            await tx.user.update({
                where: { id: request.userId },
                data: {
                    kycStatus: 'REVOKED',
                    kycApprovedAt: null,
                },
            });
            return result;
        }, { isolationLevel: client_1.Prisma.TransactionIsolationLevel.Serializable });
        await this.invalidateKycCache(request.userId);
        this.auditLog.logAdminAction({
            adminId,
            action: client_1.AuditAction.KYC_REVOKED,
            targetType: 'KYC_REQUEST',
            targetId: kycId,
            description: `KYC ${kycId} revoked for user ${request.userId}: ${normalizedReason}`,
            ipAddress,
        });
        const safeRevokeReason = (0, sanitize_util_1.escapeHtml)(normalizedReason);
        void this.prisma.notification.create({
            data: { notifId: (0, id_generator_util_1.generateNotifId)(), userId: request.userId, type: client_1.NotificationType.KYC_REVOKED, category: (0, notification_category_map_1.getCategoryForType)(client_1.NotificationType.KYC_REVOKED), title: 'KYC Verification Revoked', body: `Your KYC verification has been revoked. Reason: ${safeRevokeReason}. Please contact customer support for more information.`, isRead: false },
        }).catch((error) => this.logger.warn(`KYC revocation notification failed after commit: ${error instanceof Error ? error.message : String(error)}`));
        const safeRevokeReasonForPush = (0, sanitize_util_1.escapeHtml)(normalizedReason);
        this.prisma.emitNotificationCreated({
            userId: request.userId,
            title: 'KYC Verification Revoked',
            body: `Your KYC verification has been revoked. Reason: ${safeRevokeReasonForPush}. Please contact customer support for more information.`,
            data: { type: 'KYC_REVOKED' },
        });
        if (request.user?.email) {
            const safeReasonForEmail = (0, sanitize_util_1.escapeHtml)(normalizedReason);
            this.emailQueue.add('send', {
                to: request.user.email,
                subject: 'Kahade — Your KYC Verification Has Been Revoked',
                templateName: 'kyc-revoked',
                templateContext: { name: request.user.fullName ?? 'User', reason: safeReasonForEmail },
            }, { attempts: 3, backoff: { type: 'exponential', delay: 5000 } }).catch((err) => {
                this.logger.error(`Failed to queue KYC revocation email for ${request.user?.email}`, err);
            });
        }
        return updated;
    }
    async getKycDetail(kycId, adminId, ipAddress) {
        const request = await this.prisma.kycRequest.findFirst({
            where: { OR: [{ id: kycId }, { kycId }] },
            select: {
                id: true,
                kycId: true,
                userId: true,
                status: true,
                rejectionReason: true,
                adminNotes: true,
                attemptNumber: true,
                submittedIp: true,
                createdAt: true,
                reviewedAt: true,
                reviewedBy: true,
                user: { select: { userId: true, email: true, fullName: true } },
                reviewer: { select: { adminId: true, fullName: true } },
            },
        });
        if (!request)
            throw new common_1.NotFoundException({ code: ErrorCodes.KYC_NOT_FOUND, message: 'KYC request not found' });
        if (adminId) {
            await this.auditLog.logAdminAction({
                adminId,
                action: client_1.AuditAction.ADMIN_ACTION,
                targetType: 'KYC_REQUEST',
                targetId: kycId,
                description: `Admin viewed KYC detail for ${kycId} (user ${request.userId})`,
                ipAddress: ipAddress ?? 'unknown',
            });
        }
        return request;
    }
    async getDocumentUrls(kycId, adminId, ipAddress = 'unknown', adminPassword) {
        if (!adminPassword) {
            throw new common_1.UnauthorizedException({
                code: ErrorCodes.UNAUTHORIZED,
                message: 'Re-authentication required to access KYC documents. Provide your password.',
            });
        }
        const admin = await this.prisma.adminUser.findUnique({ where: { id: adminId } });
        if (!admin) {
            throw new common_1.UnauthorizedException({ code: ErrorCodes.UNAUTHORIZED, message: 'Admin not found' });
        }
        const isPasswordValid = await (0, crypto_util_1.bcryptCompare)(adminPassword, admin.password);
        if (!isPasswordValid) {
            await this.auditLog.logAdminAction({
                adminId,
                action: client_1.AuditAction.ADMIN_ACTION,
                targetType: 'KYC_REQUEST',
                targetId: kycId,
                description: `Failed re-authentication attempt for KYC document access (${kycId})`,
                ipAddress,
            });
            throw new common_1.UnauthorizedException({ code: ErrorCodes.INVALID_CREDENTIALS, message: 'Invalid password for re-authentication' });
        }
        const request = await this.prisma.kycRequest.findFirst({ where: { OR: [{ id: kycId }, { kycId }] } });
        if (!request)
            throw new common_1.NotFoundException({ code: ErrorCodes.KYC_NOT_FOUND, message: 'KYC request not found' });
        let ktpFileKey = null;
        let selfieFileKey = null;
        const decryptErrors = [];
        try {
            ktpFileKey = await (0, crypto_util_1.decryptAES)(request.ktpPhotoUrl);
        }
        catch (err) {
            decryptErrors.push('KTP photo is unavailable');
            this.logger.error(`[AdminKycService] KTP photo decryption failed for kycId=${kycId}`, err);
        }
        try {
            selfieFileKey = await (0, crypto_util_1.decryptAES)(request.selfiePhotoUrl);
        }
        catch (err) {
            decryptErrors.push('Selfie photo is unavailable');
            this.logger.error(`[AdminKycService] Selfie photo decryption failed for kycId=${kycId}`, err);
        }
        if (!ktpFileKey && !selfieFileKey) {
            throw new common_1.BadRequestException({ code: ErrorCodes.INTERNAL_SERVER_ERROR, message: 'Both document decryption failed. Data may be corrupted.' });
        }
        let ktpUrl = null;
        let selfieUrl = null;
        if (ktpFileKey) {
            try {
                ktpUrl = await this.uploadService.generateDownloadUrl(ktpFileKey, 300);
            }
            catch (err) {
                this.logger.error(`[AdminKycService] KTP signed URL generation failed for kycId=${kycId}`, err);
                decryptErrors.push('KTP download URL is unavailable');
            }
        }
        if (selfieFileKey) {
            try {
                selfieUrl = await this.uploadService.generateDownloadUrl(selfieFileKey, 300);
            }
            catch (err) {
                this.logger.error(`[AdminKycService] Selfie signed URL generation failed for kycId=${kycId}`, err);
                decryptErrors.push('Selfie download URL is unavailable');
            }
        }
        await this.auditLog.logAdminAction({
            adminId,
            action: client_1.AuditAction.KYC_DOCUMENTS_ACCESSED,
            targetType: 'KYC_REQUEST',
            targetId: kycId,
            description: `Admin accessed KYC documents for ${kycId} (user ${request.userId}) after re-authentication`,
            ipAddress,
        });
        return { ktpUrl, selfieUrl, ...(decryptErrors.length > 0 ? { partialErrors: decryptErrors } : {}) };
    }
};
exports.AdminKycService = AdminKycService;
exports.AdminKycService = AdminKycService = AdminKycService_1 = __decorate([
    (0, common_1.Injectable)(),
    __param(4, (0, bull_1.InjectQueue)(email_processor_1.EMAIL_QUEUE)),
    __metadata("design:paramtypes", [prisma_service_1.PrismaService,
        redis_service_1.RedisService,
        audit_log_service_1.AuditLogService,
        upload_service_1.UploadService, Object])
], AdminKycService);
