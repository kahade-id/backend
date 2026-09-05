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
var DeliveryProofService_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.DeliveryProofService = void 0;
const common_1 = require("@nestjs/common");
const crypto_1 = require("crypto");
const config_1 = require("@nestjs/config");
const client_1 = require("@prisma/client");
const prisma_service_1 = require("../../prisma/prisma.service");
const upload_service_1 = require("../upload/upload.service");
const audit_log_service_1 = require("../../common/services/audit-log.service");
const order_state_service_1 = require("./order-state.service");
const notification_queue_service_1 = require("../queue/notification-queue.service");
const wallet_tx_serial_service_1 = require("../../common/services/wallet-tx-serial.service");
const id_generator_util_1 = require("../../common/utils/id-generator.util");
const ErrorCodes = __importStar(require("../../common/constants/error-codes"));
const app_constants_1 = require("../../common/constants/app.constants");
const DELIVERY_PROOF_KEY_PREFIX = 'uploads/delivery-proof/';
let DeliveryProofService = DeliveryProofService_1 = class DeliveryProofService {
    constructor(prisma, configService, uploadService, auditLog, orderStateService, notificationQueue, serialService) {
        this.prisma = prisma;
        this.configService = configService;
        this.uploadService = uploadService;
        this.auditLog = auditLog;
        this.orderStateService = orderStateService;
        this.notificationQueue = notificationQueue;
        this.serialService = serialService;
        this.logger = new common_1.Logger(DeliveryProofService_1.name);
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
    runPostCommitBestEffort(task, label) {
        void Promise.resolve().then(task).catch((error) => {
            this.logger.warn(`${label} post-commit side effect failed: ${error instanceof Error ? error.message : String(error)}`);
        });
    }
    validateFileKeys(keys, userId) {
        if (!Array.isArray(keys) || keys.length > 10) {
            throw new common_1.BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'A maximum of 10 delivery proof files is allowed' });
        }
        const seen = new Set();
        for (const key of keys) {
            if (typeof key !== 'string' || seen.has(key) || !key.startsWith(DELIVERY_PROOF_KEY_PREFIX)) {
                throw new common_1.BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'File key must be a unique delivery proof upload key' });
            }
            seen.add(key);
            const segments = key.split('/');
            const objectName = segments[3] ?? '';
            if (segments.length !== 4 || segments[2] !== userId || !objectName || objectName === '.' || objectName === '..' || /[\\\u0000-\u001F\u007F]/.test(objectName)) {
                throw new common_1.BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Invalid file key or file does not belong to user' });
            }
        }
    }
    async submitProof(orderId, userId, dto) {
        const description = typeof dto.description === 'string' ? dto.description.trim() : '';
        if (description.length < 10 || description.length > 2000) {
            throw new common_1.BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Delivery proof description must be between 10 and 2000 characters' });
        }
        const fileUrls = Array.isArray(dto.fileUrls) ? dto.fileUrls : [];
        this.validateFileKeys(fileUrls, userId);
        const linkUrls = Array.isArray(dto.linkUrls) ? dto.linkUrls : [];
        if (linkUrls.length > 5 || linkUrls.some((url) => typeof url !== 'string' || url.length > 1000 || !/^https?:\/\//i.test(url))) {
            throw new common_1.BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Delivery proof links must be HTTP(S) URLs and no more than 5 links' });
        }
        const reviewWindowEnd = new Date();
        reviewWindowEnd.setDate(reviewWindowEnd.getDate() + app_constants_1.DELIVERY_REVIEW_WINDOW_DAYS);
        const result = await this.withSerializableRetry(() => this.prisma.$transaction(async (tx) => {
            const order = await tx.order.findFirst({ where: { orderId } });
            if (!order)
                throw new common_1.NotFoundException({ code: ErrorCodes.ORDER_NOT_FOUND, message: 'Order not found' });
            await tx.$queryRaw `SELECT id FROM orders WHERE id = ${order.id} FOR UPDATE`;
            const lockedOrder = await tx.order.findUnique({ where: { id: order.id } });
            if (!lockedOrder)
                throw new common_1.NotFoundException({ code: ErrorCodes.ORDER_NOT_FOUND, message: 'Order not found' });
            if (lockedOrder.sellerId !== userId)
                throw new common_1.ForbiddenException({ code: ErrorCodes.NOT_ORDER_PARTICIPANT, message: 'Only seller can submit delivery proof' });
            if (lockedOrder.status !== client_1.OrderStatus.PROCESSING && lockedOrder.status !== client_1.OrderStatus.IN_DELIVERY) {
                throw new common_1.BadRequestException({ code: ErrorCodes.INVALID_ORDER_STATUS, message: 'Order must be in PROCESSING or IN_DELIVERY status' });
            }
            if (lockedOrder.orderType === client_1.OrderType.PHYSICAL_GOODS && (!lockedOrder.trackingNumber || !lockedOrder.courierName)) {
                throw new common_1.BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Tracking number and courier are required before submitting physical delivery proof' });
            }
            const existing = await tx.deliveryProof.findFirst({
                where: { orderId: lockedOrder.id, status: 'SUBMITTED' },
            });
            if (existing)
                throw new common_1.BadRequestException({ code: ErrorCodes.DELIVERY_PROOF_ALREADY_EXISTS, message: 'Delivery proof already submitted and pending review' });
            const p = await tx.deliveryProof.create({
                data: {
                    orderId: lockedOrder.id,
                    submittedBy: userId,
                    description,
                    fileUrls,
                    linkUrls,
                    reviewWindowEnd,
                },
            });
            if (lockedOrder.status === client_1.OrderStatus.PROCESSING) {
                const orderUpdated = await tx.order.updateMany({
                    where: { id: lockedOrder.id, status: client_1.OrderStatus.PROCESSING },
                    data: { status: client_1.OrderStatus.IN_DELIVERY, shippedAt: new Date() },
                });
                if (orderUpdated.count === 0) {
                    throw new common_1.BadRequestException({ code: ErrorCodes.INVALID_ORDER_STATUS, message: 'Order status has already changed' });
                }
                await tx.orderStatusHistory.create({
                    data: { orderId: lockedOrder.id, fromStatus: client_1.OrderStatus.PROCESSING, toStatus: client_1.OrderStatus.IN_DELIVERY, changedBy: userId, changedByType: 'SELLER', reason: 'Delivery proof submitted' },
                });
            }
            return { proof: p, buyerId: lockedOrder.buyerId, orderTitle: lockedOrder.title, orderPublicId: lockedOrder.orderId };
        }, { isolationLevel: client_1.Prisma.TransactionIsolationLevel.Serializable }), 'SUBMIT_PROOF_TX');
        this.runPostCommitBestEffort(() => this.notificationQueue.enqueue({
            userId: result.buyerId,
            type: client_1.NotificationType.ORDER_DELIVERED,
            title: 'Delivery Proof Submitted',
            body: `Seller has submitted delivery proof for order "${result.orderTitle || result.orderPublicId}". Please review within ${app_constants_1.DELIVERY_REVIEW_WINDOW_DAYS} days.`,
            pushData: { type: 'ORDER_DELIVERED', orderId: result.orderPublicId },
        }), 'SUBMIT_PROOF_NOTIFICATION');
        return {
            proofId: result.proof.id,
            status: result.proof.status,
            reviewWindowEnd: result.proof.reviewWindowEnd,
        };
    }
    async getProofs(orderId, userId) {
        const order = await this.prisma.order.findFirst({ where: { orderId } });
        if (!order)
            throw new common_1.NotFoundException({ code: ErrorCodes.ORDER_NOT_FOUND, message: 'Order not found' });
        if (order.buyerId !== userId && order.sellerId !== userId) {
            throw new common_1.ForbiddenException({ code: ErrorCodes.NOT_ORDER_PARTICIPANT, message: 'Not a participant' });
        }
        const proofs = await this.prisma.deliveryProof.findMany({
            where: { orderId: order.id },
            orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        });
        const results = await Promise.all(proofs.map(async (p) => {
            let resolvedFileUrls = [];
            if (p.fileUrls && p.fileUrls.length > 0) {
                const signed = await Promise.all(p.fileUrls.map(key => key.startsWith('uploads/')
                    ? this.uploadService.generateDownloadUrl(key, 3600).catch((err) => {
                        this.logger.warn(`Failed to sign delivery proof key ${key}: ${err instanceof Error ? err.message : String(err)}`);
                        return null;
                    })
                    : Promise.resolve(key)));
                resolvedFileUrls = signed.filter((url) => url !== null);
            }
            return {
                id: p.id,
                description: p.description,
                fileUrls: resolvedFileUrls,
                linkUrls: p.linkUrls,
                status: p.status,
                reviewWindowEnd: p.reviewWindowEnd,
                rejectionNote: p.rejectionNote,
                createdAt: p.createdAt,
            };
        }));
        return results;
    }
    async confirmDelivery(orderId, userId, proofId) {
        const order = await this.prisma.order.findFirst({ where: { orderId } });
        if (!order)
            throw new common_1.NotFoundException({ code: ErrorCodes.ORDER_NOT_FOUND, message: 'Order not found' });
        if (order.buyerId !== userId)
            throw new common_1.ForbiddenException({ code: ErrorCodes.NOT_ORDER_PARTICIPANT, message: 'Only buyer can confirm delivery' });
        if (order.status !== client_1.OrderStatus.IN_DELIVERY) {
            throw new common_1.BadRequestException({ code: ErrorCodes.INVALID_ORDER_STATUS, message: 'Order is not in delivery' });
        }
        const proof = await this.prisma.deliveryProof.findFirst({
            where: proofId ? { id: proofId, orderId: order.id, status: 'SUBMITTED' } : { orderId: order.id, status: 'SUBMITTED' },
        });
        if (!proof)
            throw new common_1.NotFoundException({ code: ErrorCodes.DELIVERY_PROOF_NOT_FOUND, message: 'No pending delivery proof found' });
        await this.orderStateService.completeOrder(orderId, userId, proof.id);
        const completedOrder = await this.prisma.order.findUnique({
            where: { orderId },
            select: { buyerId: true, sellerId: true, title: true },
        });
        if (completedOrder) {
            this.runPostCommitBestEffort(async () => {
                await this.notificationQueue.enqueue({
                    userId: completedOrder.sellerId,
                    type: client_1.NotificationType.ORDER_COMPLETED,
                    title: 'Order Completed',
                    body: `Order "${completedOrder.title}" has been completed. Funds have been credited to your wallet.`,
                    pushData: { type: 'ORDER_COMPLETED', orderId },
                });
                await this.notificationQueue.enqueue({
                    userId: completedOrder.buyerId,
                    type: client_1.NotificationType.WALLET_FUNDS_RELEASED,
                    title: 'Escrow Released',
                    body: `Escrow funds for order "${completedOrder.title}" have been released to the seller.`,
                    pushData: { type: 'WALLET_FUNDS_RELEASED', orderId },
                });
            }, 'CONFIRM_DELIVERY_NOTIFICATION');
        }
        return { message: 'Delivery confirmed and order completed. Escrow funds have been released.' };
    }
    async rejectDelivery(orderId, userId, note, proofId) {
        const normalizedNote = typeof note === 'string' ? note.trim() : '';
        if (normalizedNote.length < 10 || normalizedNote.length > 1000) {
            throw new common_1.BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Rejection note must be between 10 and 1000 characters' });
        }
        const order = await this.prisma.order.findFirst({ where: { orderId } });
        if (!order)
            throw new common_1.NotFoundException({ code: ErrorCodes.ORDER_NOT_FOUND, message: 'Order not found' });
        if (order.buyerId !== userId)
            throw new common_1.ForbiddenException({ code: ErrorCodes.NOT_ORDER_PARTICIPANT, message: 'Only buyer can reject delivery' });
        if (order.status !== client_1.OrderStatus.IN_DELIVERY) {
            throw new common_1.BadRequestException({ code: ErrorCodes.INVALID_ORDER_STATUS, message: 'Order is not in delivery' });
        }
        const proof = await this.prisma.deliveryProof.findFirst({
            where: proofId ? { id: proofId, orderId: order.id, status: 'SUBMITTED' } : { orderId: order.id, status: 'SUBMITTED' },
        });
        if (!proof)
            throw new common_1.NotFoundException({ code: ErrorCodes.DELIVERY_PROOF_NOT_FOUND, message: 'No pending delivery proof found' });
        let newRejectionTotal = 0;
        let shouldEscalate = false;
        let escalationDisputeId = null;
        const nextDisputeId = async () => {
            if (escalationDisputeId === null) {
                escalationDisputeId = (0, id_generator_util_1.generateDisputeId)(await this.serialService.getNextForPrefix('dispute_serial'));
            }
            return escalationDisputeId;
        };
        await this.withSerializableRetry(() => this.prisma.$transaction(async (tx) => {
            await tx.$queryRaw `SELECT id FROM orders WHERE id = ${order.id} FOR UPDATE`;
            const lockedOrder = await tx.order.findUnique({ where: { id: order.id } });
            if (!lockedOrder || lockedOrder.status !== client_1.OrderStatus.IN_DELIVERY || lockedOrder.buyerId !== userId) {
                throw new common_1.BadRequestException({ code: ErrorCodes.INVALID_ORDER_STATUS, message: 'Order is no longer in delivery and cannot be rejected' });
            }
            const lockedProof = await tx.deliveryProof.findUnique({ where: { id: proof.id } });
            if (!lockedProof || lockedProof.status !== 'SUBMITTED') {
                throw new common_1.BadRequestException({ code: ErrorCodes.DELIVERY_PROOF_NOT_FOUND, message: 'Delivery proof has already been reviewed' });
            }
            const proofUpdated = await tx.deliveryProof.updateMany({
                where: { id: proof.id, status: 'SUBMITTED' },
                data: { status: 'REJECTED', reviewedAt: new Date(), rejectionNote: normalizedNote },
            });
            if (proofUpdated.count === 0) {
                throw new common_1.BadRequestException({ code: ErrorCodes.DELIVERY_PROOF_NOT_FOUND, message: 'Delivery proof has already been reviewed' });
            }
            newRejectionTotal = await tx.deliveryProof.count({ where: { orderId: order.id, status: 'REJECTED' } });
            shouldEscalate = newRejectionTotal >= DeliveryProofService_1.MAX_REJECTION_COUNT;
            if (shouldEscalate) {
                const existingDispute = await tx.dispute.findUnique({ where: { orderId: order.id } });
                if (!existingDispute) {
                    const disputeId = await nextDisputeId();
                    const now = new Date();
                    const slaDeadlineAt = new Date(now.getTime() + app_constants_1.DISPUTE_SLA_HOURS * 60 * 60 * 1000);
                    await tx.dispute.create({
                        data: {
                            disputeId,
                            orderId: order.id,
                            initiatorUserId: userId,
                            initiatedBy: client_1.DisputeInitiator.BUYER,
                            buyerClaim: `Auto-escalated: delivery proof rejected ${newRejectionTotal} times. Last rejection: ${normalizedNote}`,
                            buyerClaimedAt: now,
                            status: client_1.DisputeStatus.OPEN,
                            slaHours: app_constants_1.DISPUTE_SLA_HOURS,
                            slaDeadlineAt,
                        },
                    });
                    const orderUpdated = await tx.order.updateMany({
                        where: { id: order.id, status: client_1.OrderStatus.IN_DELIVERY },
                        data: { status: client_1.OrderStatus.DISPUTED, disputedAt: now },
                    });
                    if (orderUpdated.count === 0) {
                        throw new common_1.BadRequestException({ code: ErrorCodes.INVALID_ORDER_STATUS, message: 'Order status has already changed' });
                    }
                    await tx.orderStatusHistory.create({
                        data: {
                            orderId: order.id,
                            fromStatus: client_1.OrderStatus.IN_DELIVERY,
                            toStatus: client_1.OrderStatus.DISPUTED,
                            changedBy: userId,
                            changedByType: client_1.ActorType.BUYER,
                            reason: `Auto-escalated to dispute after ${newRejectionTotal} delivery proof rejections`,
                        },
                    });
                    await tx.user.update({
                        where: { id: userId },
                        data: { totalOrdersDisputed: { increment: 1 } },
                    });
                }
            }
        }, { isolationLevel: client_1.Prisma.TransactionIsolationLevel.Serializable }), 'REJECT_DELIVERY_TX');
        this.auditLog.logUserAction({
            userId,
            action: client_1.UserAuditAction.ORDER_DELIVERED,
            entityType: 'DeliveryProof',
            entityId: proof.id,
            description: `Buyer rejected delivery proof for order ${orderId} (rejection ${newRejectionTotal}/${DeliveryProofService_1.MAX_REJECTION_COUNT}). Reason: ${note}`,
        });
        if (shouldEscalate) {
            this.logger.log(`Order ${orderId} auto-escalated to dispute after ${newRejectionTotal} delivery proof rejections`);
            this.runPostCommitBestEffort(() => this.notificationQueue.enqueue({
                userId: order.sellerId,
                type: client_1.NotificationType.DISPUTE_SUBMITTED,
                title: 'Dispute Auto-Escalated',
                body: `Order "${order.title || order.orderId}" has been automatically escalated to a dispute after ${newRejectionTotal} delivery proof rejections.`,
                pushData: { type: 'DISPUTE_SUBMITTED', orderId: order.orderId },
            }), 'REJECT_DELIVERY_ESCALATION_NOTIFICATION');
            return {
                message: `Delivery rejected. Maximum rejections (${DeliveryProofService_1.MAX_REJECTION_COUNT}) reached — order has been automatically escalated to a dispute.`,
                escalatedToDispute: true,
            };
        }
        this.runPostCommitBestEffort(() => this.notificationQueue.enqueue({
            userId: order.sellerId,
            type: client_1.NotificationType.ORDER_DELIVERED,
            title: 'Delivery Proof Rejected',
            body: `Buyer rejected delivery proof for order "${order.title || order.orderId}" (${newRejectionTotal}/${DeliveryProofService_1.MAX_REJECTION_COUNT}). Reason: ${note}`,
            pushData: { type: 'ORDER_DELIVERED', orderId: order.orderId },
        }), 'REJECT_DELIVERY_NOTIFICATION');
        return { message: 'Delivery rejected' };
    }
};
exports.DeliveryProofService = DeliveryProofService;
DeliveryProofService.MAX_REJECTION_COUNT = 5;
exports.DeliveryProofService = DeliveryProofService = DeliveryProofService_1 = __decorate([
    (0, common_1.Injectable)(),
    __param(4, (0, common_1.Inject)((0, common_1.forwardRef)(() => order_state_service_1.OrderStateService))),
    __metadata("design:paramtypes", [prisma_service_1.PrismaService,
        config_1.ConfigService,
        upload_service_1.UploadService,
        audit_log_service_1.AuditLogService,
        order_state_service_1.OrderStateService,
        notification_queue_service_1.NotificationQueueService,
        wallet_tx_serial_service_1.WalletTxSerialService])
], DeliveryProofService);
