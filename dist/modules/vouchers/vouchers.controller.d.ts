import { VouchersService } from './vouchers.service';
import { ValidateVoucherDto } from './dto/validate-voucher.dto';
import { PaginationDto, PaginatedResponse } from '../../common/dto/pagination.dto';
import { ListVouchersDto } from './dto/list-vouchers.dto';
export declare class VouchersController {
    private vouchersService;
    constructor(vouchersService: VouchersService);
    getAvailableVouchers(userId: string, query: ListVouchersDto): Promise<PaginatedResponse<Record<string, unknown>>>;
    validateVoucher(userId: string, dto: ValidateVoucherDto): Promise<Record<string, unknown>>;
    getMyUsage(userId: string, pagination: PaginationDto): Promise<PaginatedResponse<Record<string, unknown>>>;
}
