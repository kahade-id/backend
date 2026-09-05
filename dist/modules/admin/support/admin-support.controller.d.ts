import { AdminSupportService } from './admin-support.service';
import { AdminJwtPayload } from '../../../common/types/jwt-payload.types';
import { AdminTicketQueryDto, AdminTicketReplyDto, AdminTicketStatusDto } from './dto/admin-support.dto';
import { Request } from 'express';
export declare class AdminSupportController {
    private readonly service;
    constructor(service: AdminSupportService);
    listTickets(query: AdminTicketQueryDto): Promise<object>;
    getDetail(ticketId: string): Promise<object>;
    reply(ticketId: string, dto: AdminTicketReplyDto, admin: AdminJwtPayload, req: Request): Promise<object>;
    updateStatus(ticketId: string, dto: AdminTicketStatusDto, admin: AdminJwtPayload, req: Request): Promise<object>;
}
