import { PrismaService } from '../../prisma/prisma.service';
import { CreateTicketDto, ReplyTicketDto } from './dto/create-ticket.dto';
import { UploadService } from '../upload/upload.service';
import { AuditLogService } from '../../common/services/audit-log.service';
export declare class SupportService {
    private readonly prisma;
    private readonly uploadService;
    private readonly auditLog;
    constructor(prisma: PrismaService, uploadService: UploadService, auditLog: AuditLogService);
    createTicket(userId: string, dto: CreateTicketDto): Promise<object>;
    getTickets(userId: string, page?: number, limit?: number): Promise<{
        data: object[];
        total: number;
        page: number;
        limit: number;
    }>;
    getTicketDetail(userId: string, ticketId: string): Promise<object>;
    replyToTicket(userId: string, ticketId: string, dto: ReplyTicketDto): Promise<object>;
    private assertStatusCanChange;
    updateStatus(ticketId: string, status: string, adminId: string, ipAddress: string): Promise<object>;
}
