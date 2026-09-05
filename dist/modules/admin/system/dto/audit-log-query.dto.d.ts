import { PaginationDto } from '../../../../common/dto/pagination.dto';
export declare class AuditLogQueryDto extends PaginationDto {
    action?: string;
    adminId?: string;
    targetType?: string;
    startDate?: string;
    endDate?: string;
}
export declare class WebhookLogQueryDto extends PaginationDto {
    source?: string;
    isProcessed?: string;
    deadLettered?: string;
    search?: string;
    startDate?: string;
    endDate?: string;
}
