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
Object.defineProperty(exports, "__esModule", { value: true });
exports.SettingsService = void 0;
const common_1 = require("@nestjs/common");
const bull_1 = require("@nestjs/bull");
const crypto_1 = require("crypto");
const config_1 = require("@nestjs/config");
const prisma_service_1 = require("../../prisma/prisma.service");
const audit_log_service_1 = require("../../common/services/audit-log.service");
const redis_service_1 = require("../../redis/redis.service");
const pagination_dto_1 = require("../../common/dto/pagination.dto");
const ErrorCodes = __importStar(require("../../common/constants/error-codes"));
const client_1 = require("@prisma/client");
const upload_service_1 = require("../upload/upload.service");
const notification_queue_service_1 = require("../queue/notification-queue.service");
const email_processor_1 = require("../queue/processors/email.processor");
const crypto_util_1 = require("../../common/utils/crypto.util");
const pii_util_1 = require("../../common/utils/pii.util");
let SettingsService = class SettingsService {
    constructor(prisma, auditLog, redis, configService, uploadService, notificationQueue, emailQueue) {
        this.prisma = prisma;
        this.auditLog = auditLog;
        this.redis = redis;
        this.configService = configService;
        this.uploadService = uploadService;
        this.notificationQueue = notificationQueue;
        this.emailQueue = emailQueue;
    }
    async listBlockedUsers(userId, page, limit) {
        const safePage = Math.max(1, page);
        const safeLimit = Math.min(limit, 100);
        const skip = (safePage - 1) * safeLimit;
        const [blocks, total] = await Promise.all([
            this.prisma.blockList.findMany({
                where: { blockerId: userId },
                skip,
                take: safeLimit,
                orderBy: { createdAt: 'desc' },
                include: {
                    blocked: {
                        select: {
                            id: true,
                            userId: true,
                            username: true,
                            fullName: true,
                            avatarUrl: true,
                        },
                    },
                },
            }),
            this.prisma.blockList.count({ where: { blockerId: userId } }),
        ]);
        return (0, pagination_dto_1.createPaginatedResponse)(blocks, total, safePage, safeLimit);
    }
    async blockUser(blockerId, blockedId) {
        if (blockerId === blockedId) {
            throw new common_1.BadRequestException({
                code: ErrorCodes.CANNOT_BLOCK_SELF,
                message: 'You cannot block yourself',
            });
        }
        const targetUser = await this.prisma.user.findUnique({
            where: { id: blockedId },
        });
        if (!targetUser) {
            throw new common_1.NotFoundException({
                code: ErrorCodes.USER_NOT_FOUND,
                message: 'User not found',
            });
        }
        let block;
        try {
            block = await this.prisma.$transaction(async (tx) => {
                const existing = await tx.blockList.findUnique({
                    where: { blockerId_blockedId: { blockerId, blockedId } },
                });
                if (existing) {
                    throw new common_1.ConflictException({
                        code: ErrorCodes.USER_ALREADY_BLOCKED,
                        message: 'User is already blocked',
                    });
                }
                const created = await tx.blockList.create({
                    data: { blockerId, blockedId },
                    select: { id: true },
                });
                await tx.follow.deleteMany({
                    where: {
                        OR: [
                            { followerId: blockerId, followingId: blockedId },
                            { followerId: blockedId, followingId: blockerId },
                        ],
                    },
                });
                await tx.userFavorite.deleteMany({
                    where: {
                        OR: [
                            { userId: blockerId, favoriteUserId: blockedId },
                            { userId: blockedId, favoriteUserId: blockerId },
                        ],
                    },
                });
                await tx.userSavedProfile.deleteMany({
                    where: {
                        OR: [
                            { userId: blockerId, savedUserId: blockedId },
                            { userId: blockedId, savedUserId: blockerId },
                        ],
                    },
                });
                return created;
            }, { isolationLevel: client_1.Prisma.TransactionIsolationLevel.Serializable });
        }
        catch (error) {
            if (error instanceof client_1.Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
                throw new common_1.ConflictException({ code: ErrorCodes.USER_ALREADY_BLOCKED, message: 'User is already blocked' });
            }
            throw error;
        }
        this.auditLog.logUserAction({
            userId: blockerId,
            action: client_1.UserAuditAction.USER_BLOCKED,
            entityType: 'BlockList',
            entityId: block.id,
            description: `Blocked user ${blockedId}`,
        });
        return { message: 'User blocked successfully' };
    }
    async unblockUser(blockerId, blockedId) {
        const existing = await this.prisma.blockList.findUnique({
            where: { blockerId_blockedId: { blockerId, blockedId } },
        });
        if (!existing) {
            throw new common_1.NotFoundException({
                code: ErrorCodes.USER_NOT_BLOCKED,
                message: 'User is not blocked',
            });
        }
        await this.prisma.blockList.delete({
            where: { blockerId_blockedId: { blockerId, blockedId } },
        });
        this.auditLog.logUserAction({
            userId: blockerId,
            action: client_1.UserAuditAction.USER_UNBLOCKED,
            entityType: 'BlockList',
            entityId: existing.id,
            description: `Unblocked user ${blockedId}`,
        });
        return { message: 'User unblocked successfully' };
    }
    async reportUser(reporterId, dto) {
        if (reporterId === dto.targetId) {
            throw new common_1.BadRequestException({
                code: ErrorCodes.CANNOT_REPORT_SELF,
                message: 'You cannot report yourself',
            });
        }
        const targetUser = await this.prisma.user.findUnique({
            where: { id: dto.targetId },
        });
        if (!targetUser) {
            throw new common_1.NotFoundException({
                code: ErrorCodes.USER_NOT_FOUND,
                message: 'User not found',
            });
        }
        if (dto.evidenceUrls?.length) {
            const trustedHostnames = [];
            const r2Endpoint = this.configService.get('r2.endpointUrl');
            if (r2Endpoint) {
                try {
                    trustedHostnames.push(new URL(r2Endpoint).hostname);
                }
                catch { }
            }
            const r2PublicUrl = this.configService.get('r2.publicUrl');
            if (r2PublicUrl) {
                try {
                    trustedHostnames.push(new URL(r2PublicUrl).hostname);
                }
                catch { }
            }
            if (trustedHostnames.length === 0) {
                throw new common_1.BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Storage not configured' });
            }
            for (const rawUrl of dto.evidenceUrls) {
                try {
                    const parsed = new URL(rawUrl);
                    if (parsed.protocol !== 'https:')
                        throw new Error('not https');
                    const isTrusted = trustedHostnames.some(h => parsed.hostname === h || parsed.hostname.endsWith(`.${h}`));
                    if (!isTrusted)
                        throw new Error('not allowed host');
                }
                catch {
                    throw new common_1.BadRequestException({
                        code: ErrorCodes.VALIDATION_ERROR,
                        message: 'Evidence URL must point to platform storage',
                    });
                }
            }
        }
        if (dto.relatedOrderId) {
            const relatedOrder = await this.prisma.order.findUnique({
                where: { id: dto.relatedOrderId },
                select: { buyerId: true, sellerId: true },
            });
            const participants = relatedOrder ? [relatedOrder.buyerId, relatedOrder.sellerId] : [];
            if (!relatedOrder || !participants.includes(reporterId) || !participants.includes(dto.targetId)) {
                throw new common_1.NotFoundException({ code: ErrorCodes.ORDER_NOT_FOUND, message: 'Related order not found' });
            }
        }
        const reportCooldownKey = `user-report:cooldown:${reporterId}:${dto.targetId}`;
        const reportLockValue = (0, crypto_1.randomUUID)();
        let reportLockAcquired = false;
        let redisAvailable = false;
        try {
            redisAvailable = true;
            reportLockAcquired = (await this.redis.setNx(reportCooldownKey, reportLockValue, 24 * 60 * 60)) === true;
        }
        catch {
        }
        let recentReport;
        try {
            recentReport = await this.prisma.userReport.findFirst({
                where: {
                    reporterId,
                    targetId: dto.targetId,
                    createdAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) },
                },
            });
        }
        catch (error) {
            if (reportLockAcquired)
                await this.redis.releaseLock(reportCooldownKey, reportLockValue).catch(() => undefined);
            throw error;
        }
        if (recentReport || (redisAvailable && !reportLockAcquired)) {
            if (reportLockAcquired)
                await this.redis.releaseLock(reportCooldownKey, reportLockValue).catch(() => undefined);
            throw new common_1.BadRequestException({
                code: ErrorCodes.RATE_LIMIT_EXCEEDED,
                message: 'You have already reported this user recently. Please wait before reporting again.',
            });
        }
        let report;
        try {
            report = await this.prisma.userReport.create({
                data: {
                    reporterId,
                    targetId: dto.targetId,
                    category: dto.category,
                    description: dto.description,
                    evidenceUrls: dto.evidenceUrls ?? [],
                    relatedOrderId: dto.relatedOrderId ?? null,
                    relatedMessageId: dto.relatedMessageId ?? null,
                },
                select: { id: true },
            });
        }
        catch (error) {
            if (reportLockAcquired)
                await this.redis.releaseLock(reportCooldownKey, reportLockValue).catch(() => undefined);
            throw error;
        }
        this.auditLog.logUserAction({
            userId: reporterId,
            action: client_1.UserAuditAction.USER_REPORTED,
            entityType: 'UserReport',
            entityId: report.id,
            description: `Reported user ${dto.targetId} for ${dto.category}`,
        });
        return { message: 'Report submitted successfully', reportId: report.id };
    }
    async listMyReports(userId, page, limit) {
        const safePage = Math.max(1, page);
        const safeLimit = Math.min(limit, 100);
        const skip = (safePage - 1) * safeLimit;
        const [reports, total] = await Promise.all([
            this.prisma.userReport.findMany({
                where: { reporterId: userId },
                skip,
                take: safeLimit,
                orderBy: { createdAt: 'desc' },
                select: {
                    id: true,
                    targetId: true,
                    category: true,
                    description: true,
                    status: true,
                    createdAt: true,
                    updatedAt: true,
                    target: {
                        select: {
                            userId: true,
                            username: true,
                            fullName: true,
                        },
                    },
                },
            }),
            this.prisma.userReport.count({ where: { reporterId: userId } }),
        ]);
        return (0, pagination_dto_1.createPaginatedResponse)(reports, total, safePage, safeLimit);
    }
    privacyKey(userId) {
        return `user_privacy:${userId}`;
    }
    languageKey(userId) {
        return `user_language:${userId}`;
    }
    async getPrivacySettings(userId) {
        const cached = await this.redis.get(this.privacyKey(userId));
        if (cached) {
            try {
                return JSON.parse(cached);
            }
            catch {
            }
        }
        const user = await this.prisma.user.findUnique({
            where: { id: userId },
            select: { id: true, profileVisible: true, showOnlineStatus: true },
        });
        if (!user) {
            throw new common_1.NotFoundException({ code: ErrorCodes.USER_NOT_FOUND, message: 'User not found' });
        }
        const settings = { profileVisible: user.profileVisible, showOnlineStatus: user.showOnlineStatus };
        await this.redis.set(this.privacyKey(userId), JSON.stringify(settings), 3600);
        return settings;
    }
    async updatePrivacySettings(userId, dto) {
        const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { id: true, profileVisible: true, showOnlineStatus: true } });
        if (!user) {
            throw new common_1.NotFoundException({ code: ErrorCodes.USER_NOT_FOUND, message: 'User not found' });
        }
        const updated = {
            profileVisible: dto.profileVisible ?? user.profileVisible,
            showOnlineStatus: dto.showOnlineStatus ?? user.showOnlineStatus,
        };
        await this.prisma.user.update({
            where: { id: userId },
            data: updated,
        });
        await this.redis.set(this.privacyKey(userId), JSON.stringify(updated), 3600);
        this.auditLog.logUserAction({
            userId,
            action: client_1.UserAuditAction.PROFILE_UPDATED,
            entityType: 'User',
            entityId: userId,
            description: 'Updated privacy settings',
        });
        return { ...updated, message: 'Privacy settings updated successfully' };
    }
    async getLanguage(userId) {
        const cached = await this.redis.get(this.languageKey(userId));
        if (cached === 'id' || cached === 'en')
            return { language: cached };
        const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { id: true, language: true } });
        if (!user) {
            throw new common_1.NotFoundException({ code: ErrorCodes.USER_NOT_FOUND, message: 'User not found' });
        }
        const language = user.language === 'en' ? 'en' : 'id';
        await this.redis.setex(this.languageKey(userId), 365 * 24 * 3600, language);
        return { language };
    }
    async updateLanguage(userId, language) {
        if (language !== 'id' && language !== 'en') {
            throw new common_1.BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Language must be id or en' });
        }
        const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { id: true } });
        if (!user) {
            throw new common_1.NotFoundException({ code: ErrorCodes.USER_NOT_FOUND, message: 'User not found' });
        }
        await this.prisma.user.update({ where: { id: userId }, data: { language } });
        await this.redis.setex(this.languageKey(userId), 365 * 24 * 3600, language);
        this.auditLog.logUserAction({
            userId,
            action: client_1.UserAuditAction.PROFILE_UPDATED,
            entityType: 'User',
            entityId: userId,
            description: `Updated language to ${language}`,
        });
        return { language, message: 'Language preference updated successfully' };
    }
    async requestDataExport(userId) {
        const user = await this.prisma.user.findUnique({
            where: { id: userId },
            select: {
                id: true,
                userId: true,
                username: true,
                email: true,
                fullName: true,
                bio: true,
                avatarUrl: true,
                headerUrl: true,
                accountType: true,
                phoneNumber: true,
                phoneVerified: true,
                dateOfBirth: true,
                gender: true,
                address: true,
                emailVerified: true,
                emailVerifiedAt: true,
                kycStatus: true,
                kycApprovedAt: true,
                isKahadePlus: true,
                subscriptionExpiresAt: true,
                profileVisible: true,
                showOnlineStatus: true,
                language: true,
                membershipRank: true,
                memberSince: true,
                createdAt: true,
                updatedAt: true,
            },
        });
        if (!user) {
            throw new common_1.NotFoundException({ code: ErrorCodes.USER_NOT_FOUND, message: 'User not found' });
        }
        const cooldownKey = `data-export:cooldown:${userId}`;
        const cooldownToken = (0, crypto_1.randomUUID)();
        const acquired = await this.redis.setNx(cooldownKey, cooldownToken, 86400);
        if (!acquired) {
            throw new common_1.BadRequestException({
                code: ErrorCodes.VALIDATION_ERROR,
                message: 'A data export was already requested recently. Please wait 24 hours between requests.',
            });
        }
        try {
            const [sessions, devices, bankAccounts, links, following, followers, favorites, badges, notificationPreference, blocksCount, reportsCount] = await Promise.all([
                this.prisma.userSession.findMany({
                    where: { userId },
                    orderBy: { lastActiveAt: 'desc' },
                    select: { id: true, deviceInfo: true, ipAddress: true, isRevoked: true, revokedAt: true, revokedReason: true, lastActiveAt: true, expiresAt: true, createdAt: true },
                }),
                this.prisma.userDevice.findMany({
                    where: { userId },
                    orderBy: { lastLoginAt: 'desc' },
                    select: { id: true, deviceName: true, deviceType: true, os: true, browser: true, ipAddress: true, isTrusted: true, trustedAt: true, lastLoginAt: true, loginCount: true, createdAt: true },
                }),
                this.prisma.bankAccount.findMany({
                    where: { userId, deletedAt: null },
                    orderBy: { createdAt: 'asc' },
                    select: { id: true, bankCode: true, bankName: true, accountNumber: true, accountName: true, isPrimary: true, isVerified: true, createdAt: true, updatedAt: true },
                }),
                this.prisma.userLink.findMany({ where: { userId }, orderBy: { displayOrder: 'asc' }, select: { platform: true, url: true, label: true, displayOrder: true, createdAt: true, updatedAt: true } }),
                this.prisma.follow.findMany({ where: { followerId: userId }, orderBy: { createdAt: 'desc' }, select: { followingId: true, createdAt: true, following: { select: { userId: true, username: true, fullName: true } } } }),
                this.prisma.follow.findMany({ where: { followingId: userId }, orderBy: { createdAt: 'desc' }, select: { followerId: true, createdAt: true, follower: { select: { userId: true, username: true, fullName: true } } } }),
                this.prisma.userFavorite.findMany({ where: { userId }, orderBy: { createdAt: 'desc' }, select: { favoriteUserId: true, createdAt: true, favoriteUser: { select: { userId: true, username: true, fullName: true } } } }),
                this.prisma.userBadge.findMany({ where: { userId }, orderBy: { earnedAt: 'desc' }, select: { earnedAt: true, badge: { select: { id: true, name: true, description: true } } } }),
                this.prisma.notificationPreference.findUnique({ where: { userId }, select: { orderInApp: true, orderPush: true, orderEmail: true, walletInApp: true, walletPush: true, walletEmail: true, securityInApp: true, securityPush: true, securityEmail: true, chatInApp: true, chatPush: true, disputeInApp: true, disputePush: true, disputeEmail: true, rankingInApp: true, rankingPush: true, marketingEmail: true } }),
                this.prisma.blockList.count({ where: { blockerId: userId } }),
                this.prisma.userReport.count({ where: { reporterId: userId } }),
            ]);
            const maskedBankAccounts = await Promise.all(bankAccounts.map(async (account) => {
                let maskedAccountNumber = '****';
                let accountName = account.accountName;
                try {
                    const plain = await (0, crypto_util_1.decryptAES)(account.accountNumber);
                    maskedAccountNumber = `****${plain.slice(-4)}`;
                }
                catch {
                }
                try {
                    accountName = await (0, crypto_util_1.decryptAES)(account.accountName);
                }
                catch { }
                return { id: account.id, bankCode: account.bankCode, bankName: account.bankName, accountName, maskedAccountNumber, isPrimary: account.isPrimary, isVerified: account.isVerified, createdAt: account.createdAt, updatedAt: account.updatedAt };
            }));
            const exportPayload = {
                exportVersion: 1,
                exportedAt: new Date().toISOString(),
                profile: { ...user, phoneNumber: await (0, pii_util_1.decryptPiiSafe)(user.phoneNumber) },
                security: { sessions: sessions.map((session) => ({ ...session, ipAddress: this.maskIpAddress(session.ipAddress) })), devices: devices.map((device) => ({ ...device, ipAddress: this.maskIpAddress(device.ipAddress) })) },
                bankAccounts: maskedBankAccounts,
                socialLinks: links,
                following,
                followers,
                favorites,
                badges,
                notificationPreferences: notificationPreference,
                blockedUsersCount: blocksCount,
                submittedReportsCount: reportsCount,
            };
            const json = JSON.stringify(exportPayload, (_, value) => typeof value === 'bigint' ? value.toString() : value, 2);
            const artifact = await this.uploadService.uploadPrivateAccountExport(userId, Buffer.from(json, 'utf8'));
            const expiresAt = artifact.expiresAt.toISOString();
            const message = 'Data akun Anda siap diunduh. Tautan ini berlaku terbatas dan dapat digunakan secara aman.';
            if (user.email) {
                await this.emailQueue.add('send', {
                    to: user.email,
                    subject: 'Data Akun Kahade Anda',
                    templateName: 'data-export',
                    templateContext: { name: user.fullName, downloadUrl: artifact.downloadUrl, expiresAt },
                });
            }
            await this.notificationQueue.enqueue({
                userId,
                type: client_1.NotificationType.DATA_EXPORT_READY,
                title: 'Data akun siap diunduh',
                body: message,
                actionUrl: artifact.downloadUrl,
                language: user.language === 'en' ? 'en' : 'id',
            });
            this.auditLog.logUserAction({
                userId,
                action: client_1.UserAuditAction.PROFILE_UPDATED,
                entityType: 'User',
                entityId: userId,
                description: 'Generated personal data export',
            });
            return { message, downloadUrl: artifact.downloadUrl, expiresAt: artifact.expiresAt };
        }
        catch (error) {
            await this.redis.releaseLock(cooldownKey, cooldownToken);
            throw error;
        }
    }
    maskIpAddress(value) {
        if (!value)
            return 'unknown';
        if (value.includes(':')) {
            const parts = value.split(':');
            return `${parts.slice(0, 3).join(':')}:xxxx`;
        }
        const parts = value.split('.');
        return parts.length === 4 ? `${parts[0]}.${parts[1]}.x.x` : 'masked';
    }
};
exports.SettingsService = SettingsService;
exports.SettingsService = SettingsService = __decorate([
    (0, common_1.Injectable)(),
    __param(6, (0, bull_1.InjectQueue)(email_processor_1.EMAIL_QUEUE)),
    __metadata("design:paramtypes", [prisma_service_1.PrismaService,
        audit_log_service_1.AuditLogService,
        redis_service_1.RedisService,
        config_1.ConfigService,
        upload_service_1.UploadService,
        notification_queue_service_1.NotificationQueueService, Object])
], SettingsService);
