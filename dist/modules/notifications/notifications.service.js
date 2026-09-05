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
var NotificationsService_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.NotificationsService = void 0;
const common_1 = require("@nestjs/common");
const client_1 = require("@prisma/client");
const prisma_service_1 = require("../../prisma/prisma.service");
const pagination_dto_1 = require("../../common/dto/pagination.dto");
const ErrorCodes = __importStar(require("../../common/constants/error-codes"));
const nanoid_1 = require("nanoid");
const generateDeviceId = (0, nanoid_1.customAlphabet)('0123456789abcdefghijklmnopqrstuvwxyz', 16);
const NOTIFICATION_DEDUP_WINDOW_MS = 60_000;
const MAX_NOTIFICATION_PAGE = 10_000;
const IN_APP_PREFERENCE_TYPES = [
    ['orderInApp', [client_1.NotificationType.ORDER_NEW, client_1.NotificationType.ORDER_ACCEPTED, client_1.NotificationType.ORDER_REJECTED, client_1.NotificationType.ORDER_CANCELLED_TIMEOUT, client_1.NotificationType.ORDER_CANCELLED, client_1.NotificationType.ORDER_PAYMENT_RECEIVED, client_1.NotificationType.ORDER_SHIPPED, client_1.NotificationType.ORDER_DEADLINE_REMINDER, client_1.NotificationType.ORDER_EXTENSION_REQUESTED, client_1.NotificationType.ORDER_EXTENSION_APPROVED, client_1.NotificationType.ORDER_EXTENSION_REJECTED, client_1.NotificationType.ORDER_COMPLETED, client_1.NotificationType.ORDER_AUTOCOMPLETED, client_1.NotificationType.ORDER_DELIVERED]],
    ['walletInApp', [client_1.NotificationType.WALLET_TOPUP_SUCCESS, client_1.NotificationType.WALLET_TOPUP_FAILED, client_1.NotificationType.WALLET_WITHDRAW_SUCCESS, client_1.NotificationType.WALLET_WITHDRAW_FAILED, client_1.NotificationType.WALLET_FUNDS_RELEASED, client_1.NotificationType.WALLET_TRANSFER_SENT, client_1.NotificationType.WALLET_TRANSFER_RECEIVED]],
    ['chatInApp', [client_1.NotificationType.CHAT_NEW_MESSAGE]],
    ['disputeInApp', [client_1.NotificationType.DISPUTE_SUBMITTED, client_1.NotificationType.DISPUTE_ADMIN_JOINED, client_1.NotificationType.DISPUTE_DECISION]],
    ['rankingInApp', [client_1.NotificationType.RATING_NEW, client_1.NotificationType.BADGE_AWARDED, client_1.NotificationType.RANK_UPGRADED, client_1.NotificationType.SUBSCRIPTION_ACTIVATED, client_1.NotificationType.SUBSCRIPTION_EXPIRY_REMINDER, client_1.NotificationType.SUBSCRIPTION_EXPIRED, client_1.NotificationType.SUBSCRIPTION_RENEWED, client_1.NotificationType.REFERRAL_REWARD_RECEIVED]],
];
function criticalSecurityType(type) {
    return type.startsWith('SECURITY_');
}
const PUBLIC_NOTIFICATION_SELECT = {
    notifId: true,
    type: true,
    category: true,
    channel: true,
    title: true,
    body: true,
    actionUrl: true,
    isRead: true,
    readAt: true,
    createdAt: true,
    expiresAt: true,
    metadata: true,
};
function activeNotificationWhere(now = new Date()) {
    return { OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] };
}
let NotificationsService = NotificationsService_1 = class NotificationsService {
    constructor(prisma) {
        this.prisma = prisma;
        this.logger = new common_1.Logger(NotificationsService_1.name);
    }
    async isDuplicate(userId, type, body) {
        const since = new Date(Date.now() - NOTIFICATION_DEDUP_WINDOW_MS);
        const existing = await this.prisma.notification.findFirst({
            where: {
                userId,
                type,
                body,
                createdAt: { gte: since },
                deletedAt: null,
            },
            select: { id: true },
        });
        return !!existing;
    }
    async isDuplicateByRef(userId, type, refId) {
        const since = new Date(Date.now() - NOTIFICATION_DEDUP_WINDOW_MS);
        const existing = await this.prisma.notification.findFirst({
            where: {
                userId,
                type,
                refId,
                createdAt: { gte: since },
                deletedAt: null,
            },
            select: { id: true },
        });
        return !!existing;
    }
    async disabledInAppTypes(userId) {
        const prefs = await this.prisma.notificationPreference.findUnique({ where: { userId } });
        if (!prefs)
            return [];
        return IN_APP_PREFERENCE_TYPES
            .filter(([field]) => prefs[field] === false)
            .flatMap(([, types]) => types)
            .filter((type) => !criticalSecurityType(type));
    }
    async notificationVisibilityWhere(userId) {
        const disabledTypes = await this.disabledInAppTypes(userId);
        return {
            userId,
            deletedAt: null,
            AND: [
                activeNotificationWhere(),
                ...(disabledTypes.length > 0 ? [{ type: { notIn: disabledTypes } }] : []),
            ],
        };
    }
    async listNotifications(userId, page, limit, isRead, category) {
        const safePage = Math.min(MAX_NOTIFICATION_PAGE, Math.max(1, Math.trunc(page)));
        const safeLimit = Math.min(100, Math.max(1, Math.trunc(limit)));
        const where = await this.notificationVisibilityWhere(userId);
        if (isRead !== undefined) {
            where.isRead = isRead;
        }
        if (category) {
            where.category = category;
        }
        const [data, total] = await Promise.all([
            this.prisma.notification.findMany({
                where,
                orderBy: { createdAt: 'desc' },
                skip: (safePage - 1) * safeLimit,
                take: safeLimit,
                select: PUBLIC_NOTIFICATION_SELECT,
            }),
            this.prisma.notification.count({ where }),
        ]);
        return (0, pagination_dto_1.createPaginatedResponse)(data, total, safePage, safeLimit);
    }
    async getNotification(userId, notifId) {
        const notification = await this.prisma.notification.findFirst({
            where: { userId, notifId, deletedAt: null, AND: [activeNotificationWhere()] },
            select: PUBLIC_NOTIFICATION_SELECT,
        });
        if (!notification) {
            throw new common_1.NotFoundException({ code: ErrorCodes.NOTIFICATION_NOT_FOUND, message: 'Notification not found' });
        }
        return notification;
    }
    async getUnreadCount(userId, category) {
        if (category) {
            const visibility = await this.notificationVisibilityWhere(userId);
            const count = await this.prisma.notification.count({
                where: { ...visibility, isRead: false, category },
            });
            return { unreadCount: count };
        }
        const visibility = await this.notificationVisibilityWhere(userId);
        const counts = await this.prisma.notification.groupBy({
            by: ['category'],
            where: { ...visibility, isRead: false },
            _count: { _all: true },
        });
        const perCategory = {
            [client_1.NotificationCategory.INFORMASI]: 0,
            [client_1.NotificationCategory.PROMOSI]: 0,
            [client_1.NotificationCategory.TRANSAKSI]: 0,
        };
        let total = 0;
        for (const row of counts) {
            perCategory[row.category] = row._count._all;
            total += row._count._all;
        }
        return { unreadCount: total, perCategory };
    }
    async markAsRead(userId, notifId) {
        const notification = await this.prisma.notification.findUnique({
            where: { notifId },
        });
        if (!notification || notification.deletedAt || (notification.expiresAt && notification.expiresAt <= new Date())) {
            throw new common_1.NotFoundException({ code: ErrorCodes.NOTIFICATION_NOT_FOUND, message: 'Notification not found' });
        }
        if (notification.userId !== userId) {
            throw new common_1.ForbiddenException({ code: ErrorCodes.NOTIFICATION_NOT_OWNED, message: 'Notification does not belong to you' });
        }
        const updated = await this.prisma.notification.update({
            where: { notifId },
            data: { isRead: true, readAt: new Date() },
            select: PUBLIC_NOTIFICATION_SELECT,
        });
        return updated;
    }
    async markBatchAsRead(userId, notifIds) {
        const result = await this.prisma.notification.updateMany({
            where: {
                notifId: { in: notifIds },
                userId,
                isRead: false,
                deletedAt: null,
                AND: [activeNotificationWhere()],
            },
            data: { isRead: true, readAt: new Date() },
        });
        return { markedCount: result.count };
    }
    async deleteBatch(userId, notifIds) {
        const result = await this.prisma.notification.updateMany({
            where: {
                notifId: { in: notifIds },
                userId,
                deletedAt: null,
            },
            data: { deletedAt: new Date() },
        });
        return { deletedCount: result.count };
    }
    async deleteAllRead(userId) {
        const result = await this.prisma.notification.updateMany({
            where: { userId, isRead: true, deletedAt: null },
            data: { deletedAt: new Date() },
        });
        return { deletedCount: result.count };
    }
    async markAllAsRead(userId) {
        let totalMarked = 0;
        let batchCount;
        let lastId;
        do {
            const batch = await this.prisma.notification.findMany({
                where: { userId, isRead: false, deletedAt: null, AND: [activeNotificationWhere()] },
                select: { id: true },
                ...(lastId ? { cursor: { id: lastId }, skip: 1 } : {}),
                take: 1000,
                orderBy: { id: 'asc' },
            });
            batchCount = batch.length;
            if (batchCount > 0) {
                lastId = batch[batch.length - 1].id;
                const result = await this.prisma.notification.updateMany({
                    where: { id: { in: batch.map(n => n.id) }, isRead: false },
                    data: { isRead: true, readAt: new Date() },
                });
                totalMarked += result.count;
            }
        } while (batchCount === 1000);
        return { markedCount: totalMarked };
    }
    async getPreferences(userId) {
        return this.prisma.notificationPreference.upsert({
            where: { userId },
            create: { userId },
            update: {},
        });
    }
    async updatePreferences(userId, dto) {
        const updateData = { ...dto, securityInApp: true, securityPush: true, securityEmail: true };
        const prefs = await this.prisma.notificationPreference.upsert({
            where: { userId },
            create: { userId, ...updateData },
            update: updateData,
        });
        return prefs;
    }
    async deleteNotification(userId, notifId) {
        const notification = await this.prisma.notification.findUnique({
            where: { notifId },
        });
        if (!notification || notification.deletedAt) {
            throw new common_1.NotFoundException({ code: ErrorCodes.NOTIFICATION_NOT_FOUND, message: 'Notification not found' });
        }
        if (notification.userId !== userId) {
            throw new common_1.ForbiddenException({ code: ErrorCodes.NOTIFICATION_NOT_OWNED, message: 'Notification does not belong to you' });
        }
        await this.prisma.notification.update({
            where: { notifId },
            data: { deletedAt: new Date() },
        });
        return { message: 'Notification deleted successfully' };
    }
    async registerDevice(userId, token, platform, ipAddress, deviceId) {
        this.logger.log(`Push token registration: platform=${platform ?? 'unknown'}, tokenLength=${token?.length ?? 0}`);
        if (!token || token.length < 10 || token.length > 512 || !/^[a-zA-Z0-9:._/\-[\]]+$/.test(token)) {
            throw new common_1.BadRequestException({
                code: 'INVALID_PUSH_TOKEN',
                message: 'Invalid push token',
            });
        }
        await this.prisma.userDevice.updateMany({
            where: { pushToken: token, userId: { not: userId } },
            data: { pushToken: null },
        });
        if (deviceId) {
            const device = await this.prisma.userDevice.upsert({
                where: { userId_deviceId: { userId, deviceId } },
                create: {
                    userId,
                    deviceId,
                    pushToken: token,
                    deviceName: platform ?? 'push',
                    deviceType: platform ?? 'mobile',
                    ipAddress: ipAddress || 'unknown',
                },
                update: {
                    pushToken: token,
                    lastLoginAt: new Date(),
                    ipAddress: ipAddress || 'unknown',
                    deviceName: platform ?? 'push',
                    ...(platform ? { deviceType: platform } : {}),
                },
            });
            return { message: 'Device registered successfully', deviceId: device.id };
        }
        const existingByToken = await this.prisma.userDevice.findFirst({
            where: { userId, pushToken: token },
        });
        if (existingByToken) {
            await this.prisma.userDevice.update({
                where: { id: existingByToken.id },
                data: { lastLoginAt: new Date() },
            });
            return { message: 'Device token updated', deviceId: existingByToken.id };
        }
        if (platform) {
            const existingByPlatform = await this.prisma.userDevice.findFirst({
                where: { userId, deviceType: platform, pushToken: { not: null } },
                orderBy: { lastLoginAt: 'desc' },
            });
            if (existingByPlatform) {
                await this.prisma.userDevice.update({
                    where: { id: existingByPlatform.id },
                    data: { pushToken: token, lastLoginAt: new Date() },
                });
                return { message: 'Device token refreshed', deviceId: existingByPlatform.id };
            }
        }
        const device = await this.prisma.userDevice.create({
            data: {
                userId,
                deviceId: `push-${platform ?? 'mobile'}-${generateDeviceId()}`,
                pushToken: token,
                deviceName: platform ?? 'push',
                deviceType: platform ?? 'mobile',
                ipAddress: ipAddress || 'unknown',
            },
        });
        return { message: 'Device registered successfully', deviceId: device.id };
    }
    async unregisterDevice(userId, deviceId) {
        if (!deviceId || typeof deviceId !== 'string' || deviceId.length > 128 || !/^[a-zA-Z0-9:._-]+$/.test(deviceId)) {
            throw new common_1.BadRequestException({ code: 'INVALID_DEVICE_ID', message: 'Device ID is invalid' });
        }
        const result = await this.prisma.userDevice.updateMany({
            where: { userId, deviceId },
            data: { pushToken: null },
        });
        if (result.count === 0) {
            this.logger.warn('unregisterDevice matched no device');
        }
        return { message: 'Device unregistered successfully' };
    }
};
exports.NotificationsService = NotificationsService;
exports.NotificationsService = NotificationsService = NotificationsService_1 = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [prisma_service_1.PrismaService])
], NotificationsService);
