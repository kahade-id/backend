import { Request } from 'express';
import { AdminVouchersService } from './admin-vouchers.service';
import { CreateVoucherDto } from './dto/create-voucher.dto';
import { VoucherListQueryDto } from './dto/voucher-list-query.dto';
export declare class AdminVouchersController {
    private readonly service;
    constructor(service: AdminVouchersService);
    listVouchers(query: VoucherListQueryDto): Promise<object>;
    getVoucherDetail(voucherId: string): Promise<object>;
    createVoucher(dto: CreateVoucherDto, adminId: string, req: Request): Promise<object>;
    deactivateVoucher(voucherId: string, adminId: string, req: Request): Promise<object>;
}
