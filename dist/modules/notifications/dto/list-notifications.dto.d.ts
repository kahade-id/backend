import { PaginationDto } from '../../../common/dto/pagination.dto';
export declare class ListNotificationsDto extends PaginationDto {
    isRead?: string;
    category?: string;
}
