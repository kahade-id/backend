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
var DisputeCallService_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.DisputeCallService = void 0;
const common_1 = require("@nestjs/common");
const prisma_service_1 = require("../../prisma/prisma.service");
const client_1 = require("@prisma/client");
const ErrorCodes = __importStar(require("../../common/constants/error-codes"));
const app_constants_1 = require("../../common/constants/app.constants");
let DisputeCallService = DisputeCallService_1 = class DisputeCallService {
    constructor(prisma) {
        this.prisma = prisma;
        this.logger = new common_1.Logger(DisputeCallService_1.name);
        this.TERMINAL_STATUSES = ['RESOLVED', 'CANCELLED'];
    }
    async validateDisputeAccess(disputeId, userId, allowTerminal = false) {
        const dispute = await this.prisma.dispute.findFirst({
            where: { OR: [{ id: disputeId }, { disputeId }] },
            include: { order: { select: { buyerId: true, sellerId: true, status: true } } },
        });
        if (!dispute) {
            throw new common_1.NotFoundException({ code: ErrorCodes.DISPUTE_NOT_FOUND, message: 'Dispute not found' });
        }
        const { buyerId, sellerId } = dispute.order;
        if (userId !== buyerId && userId !== sellerId) {
            throw new common_1.ForbiddenException({ code: ErrorCodes.NOT_DISPUTE_PARTICIPANT, message: 'Not a participant of this dispute' });
        }
        if (!allowTerminal && this.TERMINAL_STATUSES.includes(dispute.status)) {
            throw new common_1.BadRequestException({ code: ErrorCodes.INVALID_STATUS, message: 'Cannot perform call actions on a resolved or cancelled dispute' });
        }
        if (!allowTerminal && dispute.order.status !== 'DISPUTED') {
            throw new common_1.BadRequestException({ code: ErrorCodes.INVALID_STATUS, message: 'Call actions require the linked order to remain in DISPUTED status' });
        }
        return dispute;
    }
    async requestCall(disputeId, userId) {
        const dispute = await this.validateDisputeAccess(disputeId, userId);
        const call = await this.prisma.$transaction(async (tx) => {
            await tx.$queryRaw `SELECT id FROM disputes WHERE id = ${dispute.id} FOR UPDATE`;
            const freshDispute = await tx.dispute.findFirst({ where: { id: dispute.id }, select: { status: true, order: { select: { status: true } } } });
            if (!freshDispute || this.TERMINAL_STATUSES.includes(freshDispute.status) || freshDispute.order.status !== 'DISPUTED') {
                throw new common_1.BadRequestException({ code: ErrorCodes.INVALID_STATUS, message: 'Cannot request a call for a resolved or cancelled dispute' });
            }
            const existing = await tx.disputeCall.findFirst({
                where: {
                    disputeId: dispute.id,
                    status: { in: [client_1.DisputeCallStatus.REQUESTED, client_1.DisputeCallStatus.ACCEPTED, client_1.DisputeCallStatus.IN_PROGRESS] },
                },
            });
            if (existing) {
                throw new common_1.BadRequestException({ code: ErrorCodes.DISPUTE_CALL_ALREADY_ACTIVE, message: 'There is already an active or pending call for this dispute' });
            }
            return tx.disputeCall.create({
                data: {
                    disputeId: dispute.id,
                    requestedById: userId,
                    status: client_1.DisputeCallStatus.REQUESTED,
                    maxDurationSeconds: app_constants_1.DISPUTE_CALL_MAX_DURATION_SECONDS,
                },
            });
        }, { isolationLevel: client_1.Prisma.TransactionIsolationLevel.Serializable });
        return { id: call.id, status: call.status, requestedAt: call.requestedAt };
    }
    async acceptCall(disputeId, userId, callId) {
        const dispute = await this.validateDisputeAccess(disputeId, userId);
        const result = await this.prisma.$transaction(async (tx) => {
            await tx.$queryRaw `SELECT id FROM disputes WHERE id = ${dispute.id} FOR UPDATE`;
            const freshDispute = await tx.dispute.findFirst({ where: { id: dispute.id }, select: { status: true, order: { select: { status: true } } } });
            if (!freshDispute || this.TERMINAL_STATUSES.includes(freshDispute.status) || freshDispute.order.status !== 'DISPUTED') {
                throw new common_1.BadRequestException({ code: ErrorCodes.INVALID_STATUS, message: 'Cannot accept a call for a resolved or cancelled dispute' });
            }
            const call = await tx.disputeCall.findFirst({
                where: { id: callId, disputeId: dispute.id, status: client_1.DisputeCallStatus.REQUESTED },
            });
            if (!call) {
                throw new common_1.NotFoundException({ code: ErrorCodes.DISPUTE_CALL_NOT_FOUND, message: 'No pending call request found' });
            }
            if (call.requestedById === userId) {
                throw new common_1.BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Cannot accept your own call request' });
            }
            const ageSeconds = (Date.now() - call.requestedAt.getTime()) / 1000;
            if (ageSeconds >= app_constants_1.DISPUTE_CALL_REQUEST_EXPIRY_SECONDS) {
                await tx.disputeCall.updateMany({
                    where: { id: callId, status: client_1.DisputeCallStatus.REQUESTED },
                    data: { status: client_1.DisputeCallStatus.EXPIRED, endedAt: new Date() },
                });
                throw new common_1.BadRequestException({ code: ErrorCodes.DISPUTE_CALL_INVALID_STATUS, message: 'Call request has expired' });
            }
            const startedAt = new Date();
            const accepted = await tx.disputeCall.updateMany({
                where: { id: callId, status: client_1.DisputeCallStatus.REQUESTED },
                data: { status: client_1.DisputeCallStatus.IN_PROGRESS, acceptedAt: startedAt, startedAt },
            });
            if (accepted.count === 0) {
                throw new common_1.BadRequestException({ code: ErrorCodes.DISPUTE_CALL_INVALID_STATUS, message: 'Call request is no longer pending' });
            }
            return { id: callId, status: client_1.DisputeCallStatus.IN_PROGRESS, acceptedAt: startedAt, startedAt };
        }, { isolationLevel: client_1.Prisma.TransactionIsolationLevel.Serializable });
        return result;
    }
    async rejectCall(disputeId, userId, callId) {
        const dispute = await this.validateDisputeAccess(disputeId, userId);
        const result = await this.prisma.$transaction(async (tx) => {
            await tx.$queryRaw `SELECT id FROM disputes WHERE id = ${dispute.id} FOR UPDATE`;
            const freshDispute = await tx.dispute.findFirst({ where: { id: dispute.id }, select: { status: true, order: { select: { status: true } } } });
            if (!freshDispute || this.TERMINAL_STATUSES.includes(freshDispute.status) || freshDispute.order.status !== 'DISPUTED') {
                throw new common_1.BadRequestException({ code: ErrorCodes.INVALID_STATUS, message: 'Cannot reject a call for a resolved or cancelled dispute' });
            }
            const call = await tx.disputeCall.findFirst({ where: { id: callId, disputeId: dispute.id, status: client_1.DisputeCallStatus.REQUESTED } });
            if (!call) {
                throw new common_1.NotFoundException({ code: ErrorCodes.DISPUTE_CALL_NOT_FOUND, message: 'No pending call request found' });
            }
            const updated = await tx.disputeCall.updateMany({
                where: { id: callId, disputeId: dispute.id, status: client_1.DisputeCallStatus.REQUESTED },
                data: { status: client_1.DisputeCallStatus.REJECTED, endedAt: new Date() },
            });
            if (updated.count === 0)
                throw new common_1.BadRequestException({ code: ErrorCodes.DISPUTE_CALL_INVALID_STATUS, message: 'Call request is no longer pending' });
            return { id: callId, status: client_1.DisputeCallStatus.REJECTED };
        }, { isolationLevel: client_1.Prisma.TransactionIsolationLevel.Serializable });
        return result;
    }
    async endCall(disputeId, userId, callId) {
        const dispute = await this.validateDisputeAccess(disputeId, userId);
        const result = await this.prisma.$transaction(async (tx) => {
            await tx.$queryRaw `SELECT id FROM disputes WHERE id = ${dispute.id} FOR UPDATE`;
            const freshDispute = await tx.dispute.findFirst({ where: { id: dispute.id }, select: { status: true, order: { select: { status: true } } } });
            if (!freshDispute || this.TERMINAL_STATUSES.includes(freshDispute.status) || freshDispute.order.status !== 'DISPUTED') {
                throw new common_1.BadRequestException({ code: ErrorCodes.INVALID_STATUS, message: 'Cannot end a call for a resolved or cancelled dispute' });
            }
            const call = await tx.disputeCall.findFirst({
                where: { id: callId, disputeId: dispute.id, status: { in: [client_1.DisputeCallStatus.ACCEPTED, client_1.DisputeCallStatus.IN_PROGRESS] } },
            });
            if (!call)
                throw new common_1.NotFoundException({ code: ErrorCodes.DISPUTE_CALL_NOT_FOUND, message: 'No active call found' });
            const endedAt = new Date();
            const durationSeconds = call.startedAt ? Math.floor((endedAt.getTime() - call.startedAt.getTime()) / 1000) : 0;
            const boundedDurationSeconds = Math.min(call.maxDurationSeconds ?? app_constants_1.DISPUTE_CALL_MAX_DURATION_SECONDS, Math.max(0, durationSeconds));
            const updated = await tx.disputeCall.updateMany({
                where: { id: callId, disputeId: dispute.id, status: { in: [client_1.DisputeCallStatus.ACCEPTED, client_1.DisputeCallStatus.IN_PROGRESS] } },
                data: { status: client_1.DisputeCallStatus.ENDED, endedAt, durationSeconds: boundedDurationSeconds },
            });
            if (updated.count === 0)
                throw new common_1.BadRequestException({ code: ErrorCodes.DISPUTE_CALL_INVALID_STATUS, message: 'Call is no longer active' });
            return { id: callId, status: client_1.DisputeCallStatus.ENDED, durationSeconds: boundedDurationSeconds };
        }, { isolationLevel: client_1.Prisma.TransactionIsolationLevel.Serializable });
        return result;
    }
    async getCallHistory(disputeId, userId, page = 1, limit = 20) {
        const dispute = await this.validateDisputeAccess(disputeId, userId, true);
        const safePage = Number.isFinite(page) && Number.isInteger(page) && page > 0 ? page : 1;
        const safeLimit = Number.isFinite(limit) && Number.isInteger(limit) && limit > 0 ? Math.min(limit, 50) : 20;
        const skip = (safePage - 1) * safeLimit;
        const calls = await this.prisma.disputeCall.findMany({
            where: { disputeId: dispute.id },
            orderBy: { createdAt: 'desc' },
            skip,
            take: safeLimit,
            select: {
                id: true,
                status: true,
                requestedById: true,
                requestedAt: true,
                acceptedAt: true,
                startedAt: true,
                endedAt: true,
                durationSeconds: true,
                createdAt: true,
            },
        });
        const total = await this.prisma.disputeCall.count({ where: { disputeId: dispute.id } });
        return { calls, total, page: safePage, limit: safeLimit, totalPages: Math.ceil(total / safeLimit), hasNext: safePage * safeLimit < total, hasPrev: safePage > 1 };
    }
};
exports.DisputeCallService = DisputeCallService;
exports.DisputeCallService = DisputeCallService = DisputeCallService_1 = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [prisma_service_1.PrismaService])
], DisputeCallService);
