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
var OrderExtensionsService_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.OrderExtensionsService = void 0;
const common_1 = require("@nestjs/common");
const crypto_1 = require("crypto");
const prisma_service_1 = require("../../prisma/prisma.service");
const redis_service_1 = require("../../redis/redis.service");
const client_1 = require("@prisma/client");
const date_util_1 = require("../../common/utils/date.util");
const notification_queue_service_1 = require("../queue/notification-queue.service");
const ErrorCodes = __importStar(require("../../common/constants/error-codes"));
const redis_keys_1 = require("../../common/constants/redis-keys");
const EXTENSION_RATE_LIMIT_SECONDS = 3600;
let OrderExtensionsService = OrderExtensionsService_1 = class OrderExtensionsService {
    constructor(prisma, redis, notificationQueue) {
        this.prisma = prisma;
        this.redis = redis;
        this.notificationQueue = notificationQueue;
        this.logger = new common_1.Logger(OrderExtensionsService_1.name);
    }
    isRetryableDbError(err) {
        if (err instanceof client_1.Prisma.PrismaClientKnownRequestError && err.code === 'P2034')
            return true;
        if (err instanceof client_1.Prisma.PrismaClientUnknownRequestError) {
            const msg = err.message.toLowerCase();
            if (msg.includes('40001') || msg.includes('serialization') || msg.includes('40p01') || msg.includes('deadlock'))
                return true;
        }
        return false;
    }
    async withSerializableRetry(fn, label) {
        const MAX_RETRIES = 3;
        for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
            try {
                return await fn();
            }
            catch (err) {
                if (!this.isRetryableDbError(err))
                    throw err;
                if (attempt === MAX_RETRIES) {
                    this.logger.error(`${label} gave up after ${MAX_RETRIES} attempts`, err instanceof Error ? err.stack : String(err));
                    throw err;
                }
                this.logger.warn(`${label} retrying attempt=${attempt}/${MAX_RETRIES}`);
                await new Promise((resolve) => setTimeout(resolve, 100 * Math.pow(2, attempt - 1) + (0, crypto_1.randomInt)(0, 50)));
            }
        }
        throw new Error(`${label}: unreachable`);
    }
    async requestExtension(orderId, requesterId, dto) {
        const normalizedReason = dto.reason.trim();
        if (!Number.isInteger(dto.extensionDays) || dto.extensionDays < 1 || dto.extensionDays > 14) {
            throw new common_1.BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Extension days must be an integer between 1 and 14' });
        }
        if (normalizedReason.length < 10 || normalizedReason.length > 1000) {
            throw new common_1.BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Extension reason must be between 10 and 1000 characters' });
        }
        const order = await this.prisma.order.findUnique({ where: { orderId } });
        if (!order)
            throw new common_1.NotFoundException({ code: ErrorCodes.ORDER_NOT_FOUND, message: 'Order not found' });
        if (order.sellerId !== requesterId)
            throw new common_1.ForbiddenException({ code: ErrorCodes.FORBIDDEN, message: 'Only the seller can request a delivery extension' });
        const rateLimitKey = `extension_rate:${order.id}`;
        const rateLimited = await this.redis.get(rateLimitKey);
        if (rateLimited) {
            throw new common_1.BadRequestException({
                code: ErrorCodes.EXTENSION_RATE_LIMITED,
                message: 'Please wait before requesting another extension for this order',
            });
        }
        const lockKey = (0, redis_keys_1.EXTENSION_REQUEST_LOCK)(order.id);
        const lockValue = `${requesterId}:${Date.now()}`;
        const acquired = await this.redis.setNx(lockKey, lockValue, 10);
        if (!acquired) {
            throw new common_1.ConflictException({
                code: ErrorCodes.EXTENSION_REQUEST_ALREADY_PENDING,
                message: 'Another extension request is being processed, please retry',
            });
        }
        try {
            const extension = await this.withSerializableRetry(() => this.prisma.$transaction(async (tx) => {
                const freshOrder = await tx.order.findUnique({ where: { id: order.id } });
                if (!freshOrder || freshOrder.status !== client_1.OrderStatus.IN_DELIVERY) {
                    throw new common_1.BadRequestException({
                        code: ErrorCodes.INVALID_ORDER_STATUS,
                        message: 'Extension can only be requested for orders that are in delivery',
                    });
                }
                if (freshOrder.deliveryDeadlineAt && new Date() >= freshOrder.deliveryDeadlineAt) {
                    throw new common_1.BadRequestException({
                        code: ErrorCodes.INVALID_ORDER_STATUS,
                        message: 'Cannot request extension after the delivery deadline has passed',
                    });
                }
                const existingPending = await tx.orderExtensionRequest.findFirst({
                    where: { orderId: order.id, status: client_1.DeadlineExtensionStatus.PENDING },
                });
                if (existingPending) {
                    throw new common_1.ConflictException({
                        code: ErrorCodes.EXTENSION_REQUEST_ALREADY_PENDING,
                        message: 'There is already a pending extension request for this order',
                    });
                }
                const approvedCount = await tx.orderExtensionRequest.count({
                    where: { orderId: order.id, status: client_1.DeadlineExtensionStatus.APPROVED },
                });
                if (approvedCount >= 3) {
                    throw new common_1.BadRequestException({
                        code: ErrorCodes.EXTENSION_LIMIT_REACHED,
                        message: 'Maximum 3 extensions allowed per order',
                    });
                }
                return tx.orderExtensionRequest.create({
                    data: {
                        orderId: order.id,
                        requestedBy: requesterId,
                        requestedByRole: client_1.UserRole.SELLER,
                        extensionDays: dto.extensionDays,
                        reason: normalizedReason,
                        status: client_1.DeadlineExtensionStatus.PENDING,
                    },
                });
            }, { isolationLevel: client_1.Prisma.TransactionIsolationLevel.Serializable }), 'REQUEST_EXTENSION_TX');
            void (async () => {
                try {
                    const notifOrder = await this.prisma.order.findUnique({ where: { orderId }, select: { buyerId: true, title: true } });
                    if (notifOrder) {
                        await this.notificationQueue.enqueue({
                            userId: notifOrder.buyerId,
                            type: client_1.NotificationType.ORDER_EXTENSION_REQUESTED,
                            title: 'Extension Request',
                            body: `Seller requested a ${dto.extensionDays}-day extension for order "${notifOrder.title}". Please approve or reject.`,
                            pushData: { type: 'ORDER_EXTENSION_REQUESTED', orderId },
                        });
                    }
                }
                catch (error) {
                    this.logger.warn(`REQUEST_EXTENSION notification failed: ${error instanceof Error ? error.message : String(error)}`);
                }
            })();
            await this.redis.set(rateLimitKey, '1', EXTENSION_RATE_LIMIT_SECONDS).catch((err) => this.logger.warn(`silent-catch: ${err instanceof Error ? err.message : String(err)}`));
            return { extensionId: extension.id, requestedDays: dto.extensionDays, status: 'PENDING' };
        }
        finally {
            try {
                await this.redis.releaseLock(lockKey, lockValue);
            }
            catch (error) {
                this.logger.warn(`REQUEST_EXTENSION lock release failed: ${error instanceof Error ? error.message : String(error)}`);
            }
        }
    }
    async respondExtension(extensionId, responderId, dto, orderId) {
        if (dto.action !== 'APPROVE' && dto.action !== 'REJECT') {
            throw new common_1.BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Extension action must be APPROVE or REJECT' });
        }
        const normalizedNote = typeof dto.note === 'string' ? dto.note.trim() : undefined;
        if (normalizedNote && normalizedNote.length > 500) {
            throw new common_1.BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Extension response note must be at most 500 characters' });
        }
        const extension = await this.prisma.orderExtensionRequest.findUnique({ where: { id: extensionId }, include: { order: true } });
        if (!extension)
            throw new common_1.NotFoundException({ code: ErrorCodes.NOT_FOUND, message: 'Extension request not found' });
        const order = extension.order;
        if (orderId && order.orderId !== orderId)
            throw new common_1.NotFoundException({ code: ErrorCodes.NOT_FOUND, message: 'Extension request not found for this order' });
        if (order.buyerId !== responderId)
            throw new common_1.ForbiddenException({ code: ErrorCodes.FORBIDDEN, message: 'Only the buyer can approve or reject an extension request' });
        if (extension.status !== client_1.DeadlineExtensionStatus.PENDING) {
            throw new common_1.BadRequestException({
                code: ErrorCodes.INVALID_ORDER_STATUS,
                message: 'This extension request has already been processed',
            });
        }
        if (dto.action === 'APPROVE' && !order.deliveryDeadlineAt) {
            throw new common_1.BadRequestException({
                code: ErrorCodes.INVALID_ORDER_STATUS,
                message: 'Cannot approve extension: order has no delivery deadline set',
            });
        }
        const newStatus = dto.action === 'APPROVE' ? client_1.DeadlineExtensionStatus.APPROVED : client_1.DeadlineExtensionStatus.REJECTED;
        await this.withSerializableRetry(() => this.prisma.$transaction(async (tx) => {
            const updated = await tx.orderExtensionRequest.updateMany({
                where: { id: extensionId, status: client_1.DeadlineExtensionStatus.PENDING },
                data: {
                    status: newStatus,
                    respondedBy: responderId,
                    respondedAt: new Date(),
                    rejectionNote: dto.action === 'REJECT' ? normalizedNote : undefined,
                },
            });
            if (updated.count === 0) {
                throw new common_1.ConflictException({
                    code: ErrorCodes.OPTIMISTIC_LOCK_CONFLICT,
                    message: 'Extension request status has already changed, please retry',
                });
            }
            await tx.$queryRaw `SELECT id FROM orders WHERE id = ${order.id} FOR UPDATE`;
            const freshOrderState = await tx.order.findUnique({ where: { id: order.id }, select: { status: true, buyerId: true } });
            if (!freshOrderState || freshOrderState.buyerId !== responderId || freshOrderState.status !== client_1.OrderStatus.IN_DELIVERY) {
                throw new common_1.BadRequestException({ code: ErrorCodes.INVALID_ORDER_STATUS, message: 'Extension can only be processed while the order is still in delivery' });
            }
            if (dto.action === 'APPROVE') {
                await tx.$queryRaw `SELECT id FROM orders WHERE id = ${order.id} FOR UPDATE`;
                const freshOrder = await tx.order.findUnique({
                    where: { id: order.id },
                    select: { status: true, deliveryDeadlineAt: true },
                });
                if (!freshOrder || freshOrder.status !== client_1.OrderStatus.IN_DELIVERY) {
                    throw new common_1.BadRequestException({
                        code: ErrorCodes.INVALID_ORDER_STATUS,
                        message: 'Cannot approve extension unless the order is still in delivery',
                    });
                }
                if (!freshOrder.deliveryDeadlineAt) {
                    throw new common_1.BadRequestException({
                        code: ErrorCodes.INVALID_ORDER_STATUS,
                        message: 'Cannot approve extension: order has no delivery deadline set',
                    });
                }
                if (freshOrder.deliveryDeadlineAt <= new Date()) {
                    throw new common_1.BadRequestException({
                        code: ErrorCodes.INVALID_ORDER_STATUS,
                        message: 'Cannot approve extension after the delivery deadline has passed',
                    });
                }
                await tx.order.update({
                    where: { id: order.id },
                    data: { deliveryDeadlineAt: (0, date_util_1.addDays)(freshOrder.deliveryDeadlineAt, extension.extensionDays) },
                });
            }
        }, { isolationLevel: client_1.Prisma.TransactionIsolationLevel.Serializable }), 'RESPOND_EXTENSION_TX');
        void (async () => {
            try {
                const notifOrder2 = await this.prisma.order.findUnique({ where: { id: extension.order.id }, select: { orderId: true, sellerId: true, title: true } });
                if (notifOrder2) {
                    const notifType = dto.action === 'APPROVE' ? client_1.NotificationType.ORDER_EXTENSION_APPROVED : client_1.NotificationType.ORDER_EXTENSION_REJECTED;
                    const notifTitle = dto.action === 'APPROVE' ? 'Extension Approved' : 'Extension Rejected';
                    const notifBody = dto.action === 'APPROVE'
                        ? `${extension.extensionDays}-day extension for order "${notifOrder2.title}" has been approved.`
                        : `Extension for order "${notifOrder2.title}" has been rejected.${normalizedNote ? ` Note: ${normalizedNote}` : ''}`;
                    await this.notificationQueue.enqueue({
                        userId: notifOrder2.sellerId,
                        type: notifType,
                        title: notifTitle,
                        body: notifBody,
                        pushData: { type: notifType, orderId: notifOrder2.orderId },
                    });
                }
            }
            catch (error) {
                this.logger.warn(`RESPOND_EXTENSION notification failed: ${error instanceof Error ? error.message : String(error)}`);
            }
        })();
        return { extensionId, status: newStatus };
    }
    async getExtensions(orderId, userId, page = 1, limit = 20) {
        const safePage = Math.max(1, Math.trunc(Number.isFinite(page) ? page : 1));
        const safeLimit = Math.min(100, Math.max(1, Math.trunc(Number.isFinite(limit) ? limit : 20)));
        const skip = (safePage - 1) * safeLimit;
        const order = await this.prisma.order.findUnique({ where: { orderId } });
        if (!order)
            throw new common_1.NotFoundException({ code: ErrorCodes.ORDER_NOT_FOUND, message: 'Order not found' });
        if (order.buyerId !== userId && order.sellerId !== userId)
            throw new common_1.ForbiddenException({ code: ErrorCodes.NOT_ORDER_PARTICIPANT, message: 'Not authorized' });
        const [extensions, total] = await Promise.all([
            this.prisma.orderExtensionRequest.findMany({
                where: { orderId: order.id },
                orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
                skip,
                take: safeLimit,
                include: {
                    requester: {
                        select: { username: true, fullName: true },
                    },
                },
            }),
            this.prisma.orderExtensionRequest.count({ where: { orderId: order.id } }),
        ]);
        return {
            data: extensions.map((ext) => ({
                id: ext.id,
                orderId: ext.orderId,
                requestedBy: ext.requestedBy,
                requestedByRole: ext.requestedByRole,
                extensionDays: ext.extensionDays,
                reason: ext.reason,
                status: ext.status,
                respondedBy: ext.respondedBy,
                respondedAt: ext.respondedAt,
                rejectionNote: ext.rejectionNote,
                createdAt: ext.createdAt,
                updatedAt: ext.updatedAt,
                requestedByUser: ext.requester
                    ? { username: ext.requester.username ?? '', fullName: ext.requester.fullName }
                    : undefined,
            })),
            total,
            page: safePage,
            limit: safeLimit,
            totalPages: Math.ceil(total / safeLimit),
        };
    }
};
exports.OrderExtensionsService = OrderExtensionsService;
exports.OrderExtensionsService = OrderExtensionsService = OrderExtensionsService_1 = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [prisma_service_1.PrismaService,
        redis_service_1.RedisService,
        notification_queue_service_1.NotificationQueueService])
], OrderExtensionsService);
