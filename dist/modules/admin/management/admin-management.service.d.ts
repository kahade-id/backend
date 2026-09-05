import { PrismaService } from '../../../prisma/prisma.service';
import { AuditLogService } from '../../../common/services/audit-log.service';
import { RedisService } from '../../../redis/redis.service';
import { CreateAdminDto } from './dto/create-admin.dto';
import { UpdateAdminDto } from './dto/update-admin.dto';
export declare class AdminManagementService {
    private prisma;
    private auditLog;
    private redis;
    constructor(prisma: PrismaService, auditLog: AuditLogService, redis: RedisService);
    listAdmins(page: number, limit: number, search?: string): Promise<object>;
    getAdmin(adminId: string): Promise<object>;
    createAdmin(dto: CreateAdminDto, creatorId: string, ipAddress: string): Promise<object>;
    updateAdmin(targetId: string, dto: UpdateAdminDto, updaterId: string, ipAddress: string): Promise<object>;
    resetAdmin2fa(targetId: string, updaterId: string, ipAddress: string): Promise<{
        message: string;
    }>;
    unlockAdmin(targetId: string, updaterId: string, ipAddress: string): Promise<{
        message: string;
    }>;
    deleteAdmin(targetId: string, deleterId: string, ipAddress: string): Promise<{
        message: string;
    }>;
}
