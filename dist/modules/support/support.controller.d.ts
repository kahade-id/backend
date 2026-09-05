import { SupportService } from './support.service';
import { CreateTicketDto, ReplyTicketDto } from './dto/create-ticket.dto';
export declare class SupportController {
    private supportService;
    constructor(supportService: SupportService);
    getTickets(userId: string, page: number, limit: number): Promise<object>;
    createTicket(userId: string, dto: CreateTicketDto): Promise<object>;
    getTicketDetail(userId: string, ticketId: string): Promise<object>;
    replyToTicket(userId: string, ticketId: string, dto: ReplyTicketDto): Promise<object>;
}
