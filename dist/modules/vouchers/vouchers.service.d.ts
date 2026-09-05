import { PrismaService } from '../../prisma/prisma.service';
import { RedisService } from '../../redis/redis.service';
import { FeeCalculatorService } from '../orders/fee-calculator.service';
import { PaginatedResponse } from '../../common/dto/pagination.dto';
import { VoucherApplicability } from '@prisma/client';
export declare class VouchersService {
    private prisma;
    private redis;
    private feeCalculator;
    constructor(prisma: PrismaService, redis: RedisService, feeCalculator: FeeCalculatorService);
    private static readonly VOUCHER_SELECT;
    private serializeVouchers;
    private buildActiveVoucherWhere;
    private fetchVoucherPage;
    getAvailableVouchers(userId: string, page: number, limit: number, applicableTo?: VoucherApplicability): Promise<PaginatedResponse<Record<string, unknown>>>;
    invalidateAvailableVouchersCache(): Promise<void>;
    validateVoucher(userId: string, code: string, orderValue?: number, userRole?: 'BUYER' | 'SELLER'): Promise<Record<string, unknown>>;
    getMyUsageHistory(userId: string, page: number, limit: number): Promise<PaginatedResponse<Record<string, unknown>>>;
}
