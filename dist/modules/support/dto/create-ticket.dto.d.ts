export declare enum TicketCategory {
    GENERAL = "GENERAL",
    ORDER = "ORDER",
    PAYMENT = "PAYMENT",
    ACCOUNT = "ACCOUNT",
    KYC = "KYC",
    TECHNICAL = "TECHNICAL",
    OTHER = "OTHER"
}
export declare class CreateTicketDto {
    subject: string;
    message: string;
    category?: TicketCategory;
    orderId?: string;
    attachments?: string[];
}
export declare class ReplyTicketDto {
    message: string;
}
