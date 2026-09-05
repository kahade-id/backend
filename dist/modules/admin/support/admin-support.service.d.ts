import { PrismaService } from '../../../prisma/prisma.service';
import { AuditLogService } from '../../../common/services/audit-log.service';
export declare class AdminSupportService {
    private readonly prisma;
    private readonly auditLog;
    constructor(prisma: PrismaService, auditLog: AuditLogService);
    listTickets(page: number, limit: number, status?: string, category?: string, search?: string): Promise<object>;
    getTicketDetail(ticketId: string): Promise<object>;
    replyToTicket(ticketId: string, adminId: string, message: string, ipAddress: string): Promise<object>;
    updateStatus(ticketId: string, status: string, adminId: string, ipAddress: string): Promise<object>;
}
