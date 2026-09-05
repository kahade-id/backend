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
var AdminUsersService_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.AdminUsersService = void 0;
const common_1 = require("@nestjs/common");
const config_1 = require("@nestjs/config");
const common_2 = require("@nestjs/common");
const bull_1 = require("@nestjs/bull");
const client_1 = require("@prisma/client");
const notification_category_map_1 = require("../../notifications/notification-category.map");
const prisma_service_1 = require("../../../prisma/prisma.service");
const redis_service_1 = require("../../../redis/redis.service");
const redis_keys_1 = require("../../../common/constants/redis-keys");
const audit_log_service_1 = require("../../../common/services/audit-log.service");
const wallet_adjust_dto_1 = require("./dto/wallet-adjust.dto");
const wallet_tx_serial_service_1 = require("../../../common/services/wallet-tx-serial.service");
const currency_util_1 = require("../../../common/utils/currency.util");
const pagination_dto_1 = require("../../../common/dto/pagination.dto");
const ErrorCodes = __importStar(require("../../../common/constants/error-codes"));
const otp_service_1 = require("../../auth/otp.service");
const email_processor_1 = require("../../queue/processors/email.processor");
const id_generator_util_1 = require("../../../common/utils/id-generator.util");
const jwt_util_1 = require("../../../common/utils/jwt.util");
const pii_util_1 = require("../../../common/utils/pii.util");
let AdminUsersService = AdminUsersService_1 = class AdminUsersService {
    constructor(prisma, redis, configService, auditLog, walletTxSerial, otpService, emailQueue) {
        this.prisma = prisma;
        this.redis = redis;
        this.configService = configService;
        this.auditLog = auditLog;
        this.walletTxSerial = walletTxSerial;
        this.otpService = otpService;
        this.emailQueue = emailQueue;
        this.logger = new common_2.Logger(AdminUsersService_1.name);
        this.accessTokenTtlSeconds = (0, jwt_util_1.parseJwtTtl)(this.configService.get('jwt.expiresIn') ?? '15m');
    }
    async listUsers(page = 1, limit = 20, search, status, sortBy, sortOrder) {
        const safeLimit = Math.min(limit, 100);
        const skip = (page - 1) * safeLimit;
        const where = { deletedAt: null };
        if (search) {
            const orClauses = [
                { email: { contains: search, mode: 'insensitive' } },
                { fullName: { contains: search, mode: 'insensitive' } },
                { userId: { contains: search, mode: 'insensitive' } },
                { username: { contains: search, mode: 'insensitive' } },
            ];
            const digitsOnly = search.replace(/\D/g, '');
            if (digitsOnly.length >= 8) {
                try {
                    const normalized = (0, pii_util_1.normalizePhoneNumber)(search);
                    orClauses.push({ phoneNumberHash: (0, pii_util_1.hashPhoneNumber)(normalized) });
                }
                catch {
                }
            }
            where.OR = orClauses;
        }
        if (status === 'banned')
            where.isBanned = true;
        if (status === 'active')
            where.isBanned = false;
        if (status === 'kyc_approved')
            where.kycStatus = 'APPROVED';
        if (status === 'kyc_pending')
            where.kycStatus = 'PENDING';
        const allowedSortFields = ['createdAt', 'lastLoginAt', 'email', 'fullName'];
        const orderField = sortBy && allowedSortFields.includes(sortBy) ? sortBy : 'createdAt';
        const orderDir = sortOrder === 'asc' ? 'asc' : 'desc';
        const [users, total] = await Promise.all([
            this.prisma.user.findMany({
                where,
                skip,
                take: safeLimit,
                orderBy: { [orderField]: orderDir },
                select: {
                    id: true, userId: true, email: true, fullName: true,
                    kycStatus: true, isBanned: true, banReason: true,
                    emailVerified: true, isActive: true, isKahadePlus: true,
                    membershipRank: true, averageRating: true,
                    totalOrdersAsBuyer: true, totalOrdersAsSeller: true, totalOrdersCompleted: true,
                    createdAt: true, lastLoginAt: true,
                    wallet: { select: { totalBalance: true, availableBalance: true } },
                },
            }),
            this.prisma.user.count({ where }),
        ]);
        const serialized = users.map((u) => ({
            ...u,
            wallet: u.wallet ? {
                totalBalance: (0, currency_util_1.toIdr)(u.wallet.totalBalance),
                availableBalance: (0, currency_util_1.toIdr)(u.wallet.availableBalance),
            } : null,
        }));
        return (0, pagination_dto_1.createPaginatedResponse)(serialized, total, page, safeLimit);
    }
    async getUserDetail(userId, adminId, ipAddress) {
        const user = await this.prisma.user.findFirst({
            where: { OR: [{ id: userId }, { userId }], deletedAt: null },
            select: {
                id: true, userId: true, email: true, fullName: true, username: true,
                avatarUrl: true, accountType: true,
                phoneNumber: true, phoneVerified: true,
                kycStatus: true, isBanned: true, banReason: true,
                emailVerified: true, isActive: true, isKahadePlus: true, membershipRank: true,
                averageRating: true,
                totalOrdersAsBuyer: true, totalOrdersAsSeller: true,
                totalOrdersCompleted: true, totalOrdersDisputed: true,
                createdAt: true, updatedAt: true, lastLoginAt: true, lastLoginIp: true,
                bio: true, headerUrl: true, usernameChangedAt: true,
                contactEmail: true, contactPhone: true,
                showContactEmail: true, showContactPhone: true,
                wallet: { select: { totalBalance: true, availableBalance: true, escrowBalance: true } },
                kycRequests: {
                    orderBy: { createdAt: 'desc' },
                    take: 1,
                    select: { kycId: true, status: true, createdAt: true, reviewedAt: true, rejectionReason: true },
                },
                links: {
                    orderBy: { displayOrder: 'asc' },
                    select: { id: true, platform: true, url: true, label: true, displayOrder: true },
                },
                _count: {
                    select: {
                        followers: true,
                        following: true,
                        blockedUsers: true,
                        reportsReceived: true,
                    },
                },
            },
        });
        if (!user)
            throw new common_1.NotFoundException({ code: ErrorCodes.USER_NOT_FOUND, message: 'User not found' });
        if (adminId) {
            this.auditLog.logAdminAction({
                adminId,
                action: client_1.AuditAction.ADMIN_ACTION,
                targetType: 'User',
                targetId: user.id,
                description: `Admin viewed user detail for ${user.userId} (${user.email})`,
                ipAddress: ipAddress ?? 'unknown',
            });
        }
        const { _count, phoneNumber, ...userData } = user;
        const decryptedPhone = await (0, pii_util_1.decryptPiiSafe)(phoneNumber);
        return {
            ...userData,
            phoneNumber: decryptedPhone,
            followersCount: _count.followers,
            followingCount: _count.following,
            blockedUsersCount: _count.blockedUsers,
            reportsReceivedCount: _count.reportsReceived,
            wallet: userData.wallet ? {
                totalBalance: (0, currency_util_1.toIdr)(userData.wallet.totalBalance),
                availableBalance: (0, currency_util_1.toIdr)(userData.wallet.availableBalance),
                escrowBalance: (0, currency_util_1.toIdr)(userData.wallet.escrowBalance),
            } : null,
        };
    }
    async banUser(userId, reason, adminId, ipAddress = 'internal') {
        const user = await this.prisma.user.findFirst({
            where: { OR: [{ id: userId }, { userId }], deletedAt: null },
        });
        if (!user)
            throw new common_1.NotFoundException({ code: ErrorCodes.USER_NOT_FOUND, message: 'User not found' });
        if (user.isBanned)
            throw new common_1.ForbiddenException({ code: ErrorCodes.USER_ALREADY_BANNED, message: 'User is already banned' });
        const now = new Date();
        const updated = await this.prisma.user.update({
            where: { id: user.id },
            data: {
                isBanned: true,
                banReason: reason,
                bannedAt: now,
                bannedBy: adminId,
            },
            select: { userId: true, isBanned: true, banReason: true, bannedAt: true, bannedBy: true },
        });
        const activeSessions = await this.prisma.userSession.findMany({
            where: { userId: user.id, isRevoked: false },
            select: { id: true },
        });
        if (activeSessions.length > 0) {
            await this.prisma.userSession.updateMany({
                where: { userId: user.id, isRevoked: false },
                data: { isRevoked: true, revokedAt: now, revokedReason: 'user_banned' },
            });
            await Promise.all(activeSessions.map((s) => this.redis.setex((0, redis_keys_1.SESSION_REVOKED_KEY)(s.id), this.accessTokenTtlSeconds, 'revoked')));
        }
        this.auditLog.logAdminAction({
            adminId,
            action: client_1.AuditAction.USER_BANNED,
            targetType: 'User',
            targetId: user.id,
            description: `Admin banned user ${user.id}. Reason: ${reason}`,
            before: { isBanned: false },
            after: { isBanned: true, banReason: reason },
            ipAddress,
        });
        return updated;
    }
    async unbanUser(userId, adminId, ipAddress = 'internal') {
        const user = await this.prisma.user.findFirst({
            where: { OR: [{ id: userId }, { userId }], deletedAt: null },
        });
        if (!user)
            throw new common_1.NotFoundException({ code: ErrorCodes.USER_NOT_FOUND, message: 'User not found' });
        if (!user.isBanned)
            throw new common_1.BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'User is not currently banned' });
        const result = await this.prisma.user.update({
            where: { id: user.id },
            data: { isBanned: false, banReason: null, bannedAt: null, bannedBy: null },
            select: { userId: true, isBanned: true },
        });
        this.auditLog.logAdminAction({
            adminId,
            action: client_1.AuditAction.USER_RESTORED,
            targetType: 'User',
            targetId: user.id,
            description: `Admin unbanned user ${user.id}`,
            before: { isBanned: true },
            after: { isBanned: false },
            ipAddress,
        });
        return result;
    }
    async resolveUserId(userId) {
        const user = await this.prisma.user.findFirst({
            where: { OR: [{ id: userId }, { userId }], deletedAt: null },
            select: { id: true },
        });
        if (!user)
            throw new common_1.NotFoundException({ code: ErrorCodes.USER_NOT_FOUND, message: 'User not found' });
        return user.id;
    }
    async getUserOrders(userId, page = 1, limit = 20, status, adminId, ipAddress) {
        const id = await this.resolveUserId(userId);
        if (adminId) {
            this.auditLog.logAdminAction({ adminId, action: client_1.AuditAction.ADMIN_ACTION, targetType: 'User', targetId: id, description: `Viewed user orders (page=${page})`, ipAddress: ipAddress || 'unknown' });
        }
        const safeLimit = Math.min(limit, 100);
        const skip = (page - 1) * safeLimit;
        const where = {
            OR: [{ buyerId: id }, { sellerId: id }],
        };
        if (status) {
            where.status = status;
        }
        const [orders, total] = await Promise.all([
            this.prisma.order.findMany({
                where,
                skip,
                take: safeLimit,
                orderBy: { createdAt: 'desc' },
                select: {
                    id: true, orderId: true, title: true, orderType: true,
                    status: true, orderValue: true, feeAmount: true,
                    buyerId: true, sellerId: true,
                    createdAt: true, completedAt: true, cancelledAt: true,
                },
            }),
            this.prisma.order.count({ where }),
        ]);
        const serializedOrders = orders.map((o) => ({
            ...o,
            orderValue: (0, currency_util_1.toIdr)(o.orderValue),
            feeAmount: (0, currency_util_1.toIdr)(o.feeAmount),
        }));
        return (0, pagination_dto_1.createPaginatedResponse)(serializedOrders, total, page, safeLimit);
    }
    async getUserWallet(userId, adminId, ipAddress) {
        const id = await this.resolveUserId(userId);
        if (adminId) {
            this.auditLog.logAdminAction({ adminId, action: client_1.AuditAction.ADMIN_ACTION, targetType: 'Wallet', targetId: id, description: 'Viewed user wallet details', ipAddress: ipAddress || 'unknown' });
        }
        const wallet = await this.prisma.wallet.findUnique({
            where: { userId: id },
            select: {
                id: true, availableBalance: true, escrowBalance: true, totalBalance: true,
                todayTopupAmount: true, todayWithdrawAmount: true,
                isLocked: true, lockedAt: true, lockReason: true,
                createdAt: true, updatedAt: true,
                transactions: {
                    take: 10,
                    orderBy: { createdAt: 'desc' },
                    select: {
                        id: true, txId: true, type: true, status: true,
                        amount: true, balanceBefore: true, balanceAfter: true,
                        description: true, createdAt: true,
                    },
                },
            },
        });
        if (!wallet)
            throw new common_1.NotFoundException({ code: ErrorCodes.WALLET_NOT_FOUND, message: 'User wallet not found' });
        return {
            ...wallet,
            availableBalance: (0, currency_util_1.toIdr)(wallet.availableBalance),
            escrowBalance: (0, currency_util_1.toIdr)(wallet.escrowBalance),
            totalBalance: (0, currency_util_1.toIdr)(wallet.totalBalance),
            todayTopupAmount: (0, currency_util_1.toIdr)(wallet.todayTopupAmount),
            todayWithdrawAmount: (0, currency_util_1.toIdr)(wallet.todayWithdrawAmount),
            transactions: wallet.transactions.map((tx) => ({
                ...tx,
                amount: (0, currency_util_1.toIdr)(tx.amount),
                balanceBefore: (0, currency_util_1.toIdr)(tx.balanceBefore),
                balanceAfter: (0, currency_util_1.toIdr)(tx.balanceAfter),
            })),
        };
    }
    async getUserSessions(userId, page = 1, limit = 20, adminId, ipAddress) {
        const id = await this.resolveUserId(userId);
        if (adminId) {
            this.auditLog.logAdminAction({ adminId, action: client_1.AuditAction.ADMIN_ACTION, targetType: 'UserSession', targetId: id, description: `Viewed user sessions (page=${page})`, ipAddress: ipAddress || 'unknown' });
        }
        const safeLimit = Math.min(limit, 100);
        const skip = (page - 1) * safeLimit;
        const where = { userId: id, isRevoked: false };
        const [sessions, total] = await Promise.all([
            this.prisma.userSession.findMany({
                where,
                orderBy: { lastActiveAt: 'desc' },
                skip,
                take: safeLimit,
                select: {
                    id: true, deviceInfo: true, ipAddress: true,
                    lastActiveAt: true, expiresAt: true, createdAt: true,
                },
            }),
            this.prisma.userSession.count({ where }),
        ]);
        return (0, pagination_dto_1.createPaginatedResponse)(sessions, total, page, safeLimit);
    }
    async adjustWallet(userId, dto, adminId, ipAddress = 'internal') {
        const id = await this.resolveUserId(userId);
        const amountInSen = (0, currency_util_1.toSen)(dto.amount);
        const isCredit = dto.type === wallet_adjust_dto_1.WalletAdjustType.CREDIT;
        const txType = isCredit ? client_1.WalletTransactionType.ADMIN_CREDIT : client_1.WalletTransactionType.ADMIN_DEBIT;
        const serial = await this.walletTxSerial.getNext();
        const txId = (0, id_generator_util_1.generateWalletTxId)(serial);
        let balanceBefore;
        let balanceAfter;
        let walletId;
        await this.prisma.$transaction(async (tx) => {
            const wallet = await tx.wallet.findUnique({ where: { userId: id } });
            if (!wallet)
                throw new common_1.NotFoundException({ code: ErrorCodes.WALLET_NOT_FOUND, message: 'User wallet not found' });
            if (wallet.isLocked) {
                throw new common_1.BadRequestException({ code: ErrorCodes.WALLET_LOCKED, message: `Wallet is locked${wallet.lockReason ? `: ${wallet.lockReason}` : ''}. Unlock the wallet before adjusting.` });
            }
            if (!isCredit && wallet.availableBalance < amountInSen) {
                throw new common_1.BadRequestException({ code: ErrorCodes.INSUFFICIENT_BALANCE, message: 'Insufficient available balance for debit' });
            }
            balanceBefore = wallet.availableBalance;
            balanceAfter = isCredit ? wallet.availableBalance + amountInSen : wallet.availableBalance - amountInSen;
            walletId = wallet.id;
            const updated = await tx.wallet.updateMany({
                where: { id: wallet.id, version: wallet.version },
                data: {
                    availableBalance: balanceAfter,
                    totalBalance: isCredit ? wallet.totalBalance + amountInSen : wallet.totalBalance - amountInSen,
                    version: { increment: 1 },
                },
            });
            if (updated.count === 0) {
                throw new common_1.ConflictException({ code: ErrorCodes.OPTIMISTIC_LOCK_CONFLICT, message: 'Concurrent wallet update detected, please retry' });
            }
            await tx.walletTransaction.create({
                data: {
                    txId,
                    walletId: wallet.id,
                    type: txType,
                    status: client_1.WalletTransactionStatus.SUCCESS,
                    amount: amountInSen,
                    balanceBefore,
                    balanceAfter,
                    description: `Admin ${dto.type.toLowerCase()}: ${dto.reason}`,
                    completedAt: new Date(),
                },
            });
            const notifType = isCredit ? client_1.NotificationType.WALLET_TOPUP_SUCCESS : client_1.NotificationType.WALLET_WITHDRAW_SUCCESS;
            await tx.notification.create({
                data: {
                    notifId: (0, id_generator_util_1.generateNotifId)(),
                    userId: id,
                    type: notifType,
                    category: (0, notification_category_map_1.getCategoryForType)(notifType),
                    title: isCredit ? 'Balance Credited by Admin' : 'Balance Debited by Admin',
                    body: isCredit
                        ? `Rp ${dto.amount.toLocaleString('id-ID')} has been added to your wallet balance. Reason: ${dto.reason}`
                        : `Rp ${dto.amount.toLocaleString('id-ID')} has been deducted from your wallet balance. Reason: ${dto.reason}`,
                    isRead: false,
                },
            });
        }, { isolationLevel: client_1.Prisma.TransactionIsolationLevel.Serializable });
        const notifTitle = isCredit ? 'Balance Credited by Admin' : 'Balance Debited by Admin';
        const notifBody = isCredit
            ? `Rp ${dto.amount.toLocaleString('id-ID')} has been added to your wallet balance. Reason: ${dto.reason}`
            : `Rp ${dto.amount.toLocaleString('id-ID')} has been deducted from your wallet balance. Reason: ${dto.reason}`;
        this.prisma.emitNotificationCreated({ userId: id, title: notifTitle, body: notifBody, data: { type: 'WALLET_ADJUSTED' } });
        const auditAction = isCredit ? client_1.AuditAction.WALLET_CREDIT : client_1.AuditAction.WALLET_DEBIT;
        this.auditLog.logAdminAction({
            adminId,
            action: auditAction,
            targetType: 'Wallet',
            targetId: walletId,
            description: `Admin ${dto.type.toLowerCase()} ${dto.amount} IDR to user ${id}. Reason: ${dto.reason}`,
            before: { availableBalance: balanceBefore.toString() },
            after: { availableBalance: balanceAfter.toString() },
            ipAddress,
        });
        return { txId, type: dto.type, amount: dto.amount, reason: dto.reason, balanceAfter: (0, currency_util_1.toIdr)(balanceAfter) };
    }
    async getUserAuditLog(userId, page = 1, limit = 20, adminId, ipAddress) {
        const id = await this.resolveUserId(userId);
        if (adminId) {
            this.auditLog.logAdminAction({ adminId, action: client_1.AuditAction.ADMIN_ACTION, targetType: 'AuditLog', targetId: id, description: `Viewed user audit log (page=${page})`, ipAddress: ipAddress || 'unknown' });
        }
        const safeLimit = Math.min(limit, 100);
        const skip = (page - 1) * safeLimit;
        const [logs, total] = await Promise.all([
            this.prisma.auditLog.findMany({
                where: { userId: id },
                skip,
                take: safeLimit,
                orderBy: { createdAt: 'desc' },
                select: {
                    id: true, action: true, entityType: true, entityId: true,
                    description: true, ipAddress: true, createdAt: true,
                },
            }),
            this.prisma.auditLog.count({ where: { userId: id } }),
        ]);
        return (0, pagination_dto_1.createPaginatedResponse)(logs, total, page, safeLimit);
    }
    async forceLogout(userId, adminId, ipAddress = 'internal') {
        const id = await this.resolveUserId(userId);
        const now = new Date();
        const activeSessions = await this.prisma.userSession.findMany({
            where: { userId: id, isRevoked: false },
            select: { id: true },
        });
        if (activeSessions.length === 0) {
            return { message: 'No active sessions found', revokedCount: 0 };
        }
        await this.prisma.userSession.updateMany({
            where: { userId: id, isRevoked: false },
            data: { isRevoked: true, revokedAt: now, revokedReason: 'admin_force_logout' },
        });
        await Promise.all(activeSessions.map((s) => this.redis.setex((0, redis_keys_1.SESSION_REVOKED_KEY)(s.id), this.accessTokenTtlSeconds, 'revoked').catch((error) => {
            this.logger.warn(`Admin force logout Redis propagation failed for session ${s.id}: ${error instanceof Error ? error.message : String(error)}`);
        })));
        this.auditLog.logAdminAction({
            adminId,
            action: client_1.AuditAction.ADMIN_ACTION,
            targetType: 'User',
            targetId: id,
            description: `Admin force-logged out user ${id}. ${activeSessions.length} session(s) revoked.`,
            ipAddress,
        });
        return { message: 'All sessions revoked', revokedCount: activeSessions.length };
    }
    async revokeUserSession(userId, sessionId, adminId, ipAddress = 'internal') {
        const id = await this.resolveUserId(userId);
        const session = await this.prisma.userSession.findFirst({
            where: { id: sessionId, userId: id, isRevoked: false },
        });
        if (!session) {
            throw new common_1.NotFoundException({ code: ErrorCodes.SESSION_NOT_FOUND, message: 'Active session not found for this user' });
        }
        await this.prisma.userSession.update({
            where: { id: sessionId },
            data: { isRevoked: true, revokedAt: new Date(), revokedReason: 'admin_revoke_session' },
        });
        await this.redis.setex((0, redis_keys_1.SESSION_REVOKED_KEY)(sessionId), this.accessTokenTtlSeconds, 'revoked').catch((error) => {
            this.logger.warn(`Admin session Redis propagation failed for ${sessionId}: ${error instanceof Error ? error.message : String(error)}`);
        });
        this.auditLog.logAdminAction({
            adminId,
            action: client_1.AuditAction.ADMIN_ACTION,
            targetType: 'UserSession',
            targetId: sessionId,
            description: `Admin revoked session ${sessionId} for user ${id}`,
            ipAddress,
        });
        return { message: 'Session revoked' };
    }
    async resetUserPassword(userId, adminId, ipAddress = 'internal') {
        const id = await this.resolveUserId(userId);
        const user = await this.prisma.user.findUnique({
            where: { id },
            select: { id: true, email: true, isActive: true, isBanned: true },
        });
        if (!user) {
            throw new common_1.NotFoundException({ code: ErrorCodes.USER_NOT_FOUND, message: 'User not found' });
        }
        if (!user.isActive || user.isBanned) {
            throw new common_1.BadRequestException({ code: ErrorCodes.ACCOUNT_INACTIVE, message: 'Cannot reset password for inactive or banned account' });
        }
        if (!user.email) {
            throw new common_1.BadRequestException({
                code: 'EMAIL_NOT_CONFIGURED',
                message: 'User has no email address on file — cannot send password reset.',
            });
        }
        await this.otpService.invalidateOtps(user.email, client_1.OtpType.PASSWORD_RESET);
        const otp = await this.otpService.generateOtp(user.email, client_1.OtpType.PASSWORD_RESET, user.id);
        await this.emailQueue.add('send', {
            to: user.email,
            subject: 'Kahade - Reset Password (Admin Request)',
            templateName: 'admin-password-reset',
            templateContext: { otp },
        }, { attempts: 3, backoff: { type: 'exponential', delay: 5000 } });
        this.auditLog.logAdminAction({
            adminId,
            action: client_1.AuditAction.ADMIN_ACTION,
            targetType: 'User',
            targetId: id,
            description: `Admin triggered password reset OTP for user ${id}`,
            ipAddress,
        });
        return { message: 'Password reset email sent to user' };
    }
};
exports.AdminUsersService = AdminUsersService;
exports.AdminUsersService = AdminUsersService = AdminUsersService_1 = __decorate([
    (0, common_1.Injectable)(),
    __param(6, (0, bull_1.InjectQueue)(email_processor_1.EMAIL_QUEUE)),
    __metadata("design:paramtypes", [prisma_service_1.PrismaService,
        redis_service_1.RedisService,
        config_1.ConfigService,
        audit_log_service_1.AuditLogService,
        wallet_tx_serial_service_1.WalletTxSerialService,
        otp_service_1.OtpService, Object])
], AdminUsersService);
