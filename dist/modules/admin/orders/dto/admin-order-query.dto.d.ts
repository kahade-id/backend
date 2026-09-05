import { OrderStatus } from '@prisma/client';
import { PaginationDto } from '../../../../common/dto/pagination.dto';
export declare class AdminOrderQueryDto extends PaginationDto {
    status?: OrderStatus;
    startDate?: string;
    endDate?: string;
    search?: string;
    hasEscrow?: boolean;
    sortBy?: string;
    sortOrder?: 'asc' | 'desc';
}
export declare class ForceActionDto {
    reason: string;
}
