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
exports.AdminSupportService = void 0;
const common_1 = require("@nestjs/common");
const prisma_service_1 = require("../../../prisma/prisma.service");
const audit_log_service_1 = require("../../../common/services/audit-log.service");
const pagination_dto_1 = require("../../../common/dto/pagination.dto");
const client_1 = require("@prisma/client");
const ErrorCodes = __importStar(require("../../../common/constants/error-codes"));
const TERMINAL_TICKET_STATUSES = [client_1.SupportTicketStatus.RESOLVED, client_1.SupportTicketStatus.CLOSED];
let AdminSupportService = class AdminSupportService {
    constructor(prisma, auditLog) {
        this.prisma = prisma;
        this.auditLog = auditLog;
    }
    async listTickets(page, limit, status, category, search) {
        const safeLimit = Math.min(Math.max(1, Math.floor(limit)), 100);
        const safePage = Math.max(1, Math.floor(page));
        const skip = (safePage - 1) * safeLimit;
        const where = {};
        if (status)
            where.status = status;
        if (category)
            where.category = category;
        const normalizedSearch = search?.trim();
        if (normalizedSearch) {
            where.OR = [
                { subject: { contains: normalizedSearch, mode: 'insensitive' } },
                { message: { contains: normalizedSearch, mode: 'insensitive' } },
                { user: { is: { email: { contains: normalizedSearch, mode: 'insensitive' } } } },
                { user: { is: { username: { contains: normalizedSearch, mode: 'insensitive' } } } },
                { user: { is: { fullName: { contains: normalizedSearch, mode: 'insensitive' } } } },
            ];
        }
        const [tickets, total] = await Promise.all([
            this.prisma.supportTicket.findMany({
                where,
                skip,
                take: safeLimit,
                orderBy: { createdAt: 'desc' },
                include: {
                    user: { select: { id: true, userId: true, username: true, fullName: true, email: true, avatarUrl: true } },
                    _count: { select: { replies: true } },
                },
            }),
            this.prisma.supportTicket.count({ where }),
        ]);
        const data = tickets.map((ticket) => {
            const { _count, attachments, ...rest } = ticket;
            const attachmentCount = Array.isArray(attachments) ? attachments.length : 0;
            return { ...rest, replyCount: _count.replies, attachmentCount };
        });
        return (0, pagination_dto_1.createPaginatedResponse)(data, total, safePage, safeLimit);
    }
    async getTicketDetail(ticketId) {
        const ticket = await this.prisma.supportTicket.findUnique({
            where: { id: ticketId },
            include: {
                user: { select: { id: true, userId: true, username: true, fullName: true, avatarUrl: true, email: true } },
                replies: { orderBy: { createdAt: 'asc' } },
            },
        });
        if (!ticket)
            throw new common_1.NotFoundException({ code: ErrorCodes.NOT_FOUND, message: 'Ticket not found' });
        return {
            ...ticket,
            replies: (ticket.replies || []).map((reply) => ({ ...reply, isStaff: reply.senderType === client_1.SupportTicketSenderType.ADMIN || reply.senderType === client_1.SupportTicketSenderType.SYSTEM })),
        };
    }
    async replyToTicket(ticketId, adminId, message, ipAddress) {
        const reply = await this.prisma.$transaction(async (tx) => {
            const ticket = await tx.supportTicket.findUnique({ where: { id: ticketId } });
            if (!ticket)
                throw new common_1.NotFoundException({ code: ErrorCodes.NOT_FOUND, message: 'Ticket not found' });
            if (TERMINAL_TICKET_STATUSES.includes(ticket.status)) {
                throw new common_1.BadRequestException({ code: ErrorCodes.INVALID_STATUS, message: 'Cannot reply to a closed or resolved ticket' });
            }
            const created = await tx.supportTicketReply.create({
                data: { ticketId, senderId: adminId, senderType: client_1.SupportTicketSenderType.ADMIN, message: message.trim() },
            });
            await tx.supportTicket.update({
                where: { id: ticketId },
                data: { status: ticket.status === client_1.SupportTicketStatus.OPEN ? client_1.SupportTicketStatus.IN_PROGRESS : ticket.status, updatedAt: new Date() },
            });
            return created;
        });
        this.auditLog.logAdminAction({
            adminId,
            action: client_1.AuditAction.ADMIN_ACTION,
            targetType: 'SupportTicket',
            targetId: ticketId,
            description: `Replied to support ticket ${ticketId}`,
            ipAddress,
        });
        return { ...reply, isStaff: true };
    }
    async updateStatus(ticketId, status, adminId, ipAddress) {
        const result = await this.prisma.$transaction(async (tx) => {
            const ticket = await tx.supportTicket.findUnique({ where: { id: ticketId } });
            if (!ticket)
                throw new common_1.NotFoundException({ code: ErrorCodes.NOT_FOUND, message: 'Ticket not found' });
            if (TERMINAL_TICKET_STATUSES.includes(ticket.status)) {
                throw new common_1.BadRequestException({ code: ErrorCodes.INVALID_STATUS, message: 'A resolved or closed ticket cannot be reopened' });
            }
            if (ticket.status === status) {
                throw new common_1.BadRequestException({ code: ErrorCodes.INVALID_STATUS, message: 'Ticket is already in this status' });
            }
            const updated = await tx.supportTicket.update({ where: { id: ticketId }, data: { status: status, updatedAt: new Date() } });
            return { previousStatus: ticket.status, updated };
        });
        this.auditLog.logAdminAction({
            adminId,
            action: client_1.AuditAction.ADMIN_ACTION,
            targetType: 'SupportTicket',
            targetId: ticketId,
            description: `Changed support ticket ${ticketId} status from ${result.previousStatus} to ${status}`,
            ipAddress,
        });
        return { message: 'Ticket status updated', ticketId: result.updated.id, status: result.updated.status };
    }
};
exports.AdminSupportService = AdminSupportService;
exports.AdminSupportService = AdminSupportService = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [prisma_service_1.PrismaService,
        audit_log_service_1.AuditLogService])
], AdminSupportService);
