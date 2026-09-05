import { VoucherApplicability } from '@prisma/client';
import { PaginationDto } from '../../../common/dto/pagination.dto';
export declare class ListVouchersDto extends PaginationDto {
    applicableTo?: VoucherApplicability;
}
