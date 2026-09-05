import { PrismaService } from '../../../prisma/prisma.service';
import { RedisService } from '../../../redis/redis.service';
import { AuditLogService } from '../../../common/services/audit-log.service';
import { CreateVoucherDto } from './dto/create-voucher.dto';
export declare class AdminVouchersService {
    private prisma;
    private redis;
    private auditLog;
    constructor(prisma: PrismaService, redis: RedisService, auditLog: AuditLogService);
    listVouchers(page: number, limit: number, isActive?: string): Promise<object>;
    getVoucherDetail(voucherId: string): Promise<object>;
    createVoucher(adminId: string, dto: CreateVoucherDto, ipAddress: string): Promise<object>;
    deactivateVoucher(voucherId: string, adminId: string, ipAddress: string): Promise<object>;
    private invalidateVoucherListCache;
}
