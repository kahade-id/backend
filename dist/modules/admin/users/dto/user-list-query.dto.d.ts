import { PaginationDto } from '../../../../common/dto/pagination.dto';
export declare class UserListQueryDto extends PaginationDto {
    search?: string;
    status?: string;
    sortBy?: string;
    sortOrder?: 'asc' | 'desc';
}
