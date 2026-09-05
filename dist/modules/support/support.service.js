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
Object.defineProperty(exports, "__esModule", { value: true });
exports.SupportService = void 0;
const common_1 = require("@nestjs/common");
const prisma_service_1 = require("../../prisma/prisma.service");
const ErrorCodes = __importStar(require("../../common/constants/error-codes"));
const presigned_url_dto_1 = require("../upload/dto/presigned-url.dto");
const upload_service_1 = require("../upload/upload.service");
const client_1 = require("@prisma/client");
const audit_log_service_1 = require("../../common/services/audit-log.service");
const TERMINAL_TICKET_STATUSES = ['CLOSED', 'RESOLVED'];
let SupportService = class SupportService {
    constructor(prisma, uploadService, auditLog) {
        this.prisma = prisma;
        this.uploadService = uploadService;
        this.auditLog = auditLog;
    }
    async createTicket(userId, dto) {
        const attachments = dto.attachments ?? [];
        await this.uploadService.verifyUserFileKeys(userId, attachments, presigned_url_dto_1.UploadPurpose.CHAT_ATTACHMENT);
        return this.prisma.supportTicket.create({
            data: {
                userId,
                subject: dto.subject.trim(),
                message: dto.message.trim(),
                category: dto.category || 'GENERAL',
                orderId: dto.orderId || null,
                attachments,
                status: 'OPEN',
            },
        });
    }
    async getTickets(userId, page = 1, limit = 20) {
        const safeLimit = Math.min(Math.max(1, Math.floor(limit)), 50);
        const safePage = Math.max(1, Math.floor(page));
        const skip = (safePage - 1) * safeLimit;
        const [tickets, total] = await Promise.all([
            this.prisma.supportTicket.findMany({
                where: { userId },
                orderBy: { createdAt: 'desc' },
                skip,
                take: safeLimit,
                include: { replies: { orderBy: { createdAt: 'desc' }, take: 1 } },
            }),
            this.prisma.supportTicket.count({ where: { userId } }),
        ]);
        const mapped = tickets.map((ticket) => ({
            ...ticket,
            replies: (ticket.replies || []).map((reply) => ({ ...reply, isStaff: reply.senderType === 'ADMIN' || reply.senderType === 'SYSTEM' })),
        }));
        return { data: mapped, total, page: safePage, limit: safeLimit };
    }
    async getTicketDetail(userId, ticketId) {
        const ticket = await this.prisma.supportTicket.findUnique({
            where: { id: ticketId },
            include: { replies: { orderBy: { createdAt: 'asc' } } },
        });
        if (!ticket)
            throw new common_1.NotFoundException({ code: ErrorCodes.NOT_FOUND, message: 'Ticket not found' });
        if (ticket.userId !== userId)
            throw new common_1.ForbiddenException({ code: ErrorCodes.FORBIDDEN, message: 'Not authorized' });
        return {
            ...ticket,
            replies: (ticket.replies || []).map((reply) => ({ ...reply, isStaff: reply.senderType === 'ADMIN' || reply.senderType === 'SYSTEM' })),
        };
    }
    async replyToTicket(userId, ticketId, dto) {
        const reply = await this.prisma.$transaction(async (tx) => {
            const ticket = await tx.supportTicket.findUnique({ where: { id: ticketId } });
            if (!ticket)
                throw new common_1.NotFoundException({ code: ErrorCodes.NOT_FOUND, message: 'Ticket not found' });
            if (ticket.userId !== userId)
                throw new common_1.ForbiddenException({ code: ErrorCodes.FORBIDDEN, message: 'Not authorized' });
            if (TERMINAL_TICKET_STATUSES.includes(ticket.status)) {
                throw new common_1.BadRequestException({ code: ErrorCodes.INVALID_STATUS, message: 'Cannot reply to a closed or resolved ticket' });
            }
            const created = await tx.supportTicketReply.create({
                data: { ticketId, senderId: userId, senderType: 'USER', message: dto.message.trim() },
            });
            await tx.supportTicket.update({ where: { id: ticketId }, data: { updatedAt: new Date() } });
            return created;
        });
        return reply;
    }
    assertStatusCanChange(current, next) {
        if (TERMINAL_TICKET_STATUSES.includes(current)) {
            throw new common_1.BadRequestException({ code: ErrorCodes.INVALID_STATUS, message: 'A resolved or closed ticket cannot be reopened' });
        }
        if (current === next) {
            throw new common_1.BadRequestException({ code: ErrorCodes.INVALID_STATUS, message: 'Ticket is already in this status' });
        }
    }
    async updateStatus(ticketId, status, adminId, ipAddress) {
        const updated = await this.prisma.$transaction(async (tx) => {
            const ticket = await tx.supportTicket.findUnique({ where: { id: ticketId } });
            if (!ticket)
                throw new common_1.NotFoundException({ code: ErrorCodes.NOT_FOUND, message: 'Ticket not found' });
            this.assertStatusCanChange(ticket.status, status);
            return tx.supportTicket.update({ where: { id: ticketId }, data: { status: status } });
        });
        this.auditLog.logAdminAction({
            adminId,
            action: client_1.AuditAction.ADMIN_ACTION,
            targetType: 'SupportTicket',
            targetId: ticketId,
            description: `Changed support ticket ${ticketId} status to ${status}`,
            ipAddress,
        });
        return { message: 'Ticket status updated', ticketId: updated.id, status: updated.status };
    }
};
exports.SupportService = SupportService;
exports.SupportService = SupportService = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [prisma_service_1.PrismaService,
        upload_service_1.UploadService,
        audit_log_service_1.AuditLogService])
], SupportService);
