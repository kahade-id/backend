import { ConfigService } from '@nestjs/config';
import { Queue } from 'bull';
import { PrismaService } from '../../../prisma/prisma.service';
import { RedisService } from '../../../redis/redis.service';
import { AuditLogService } from '../../../common/services/audit-log.service';
import { WalletAdjustDto } from './dto/wallet-adjust.dto';
import { WalletTxSerialService } from '../../../common/services/wallet-tx-serial.service';
import { OtpService } from '../../auth/otp.service';
import { EmailJobData } from '../../queue/processors/email.processor';
export declare class AdminUsersService {
    private prisma;
    private redis;
    private configService;
    private auditLog;
    private walletTxSerial;
    private otpService;
    private readonly emailQueue;
    private readonly logger;
    private readonly accessTokenTtlSeconds;
    constructor(prisma: PrismaService, redis: RedisService, configService: ConfigService, auditLog: AuditLogService, walletTxSerial: WalletTxSerialService, otpService: OtpService, emailQueue: Queue<EmailJobData>);
    listUsers(page?: number, limit?: number, search?: string, status?: string, sortBy?: string, sortOrder?: 'asc' | 'desc'): Promise<object>;
    getUserDetail(userId: string, adminId?: string, ipAddress?: string): Promise<object>;
    banUser(userId: string, reason: string, adminId: string, ipAddress?: string): Promise<object>;
    unbanUser(userId: string, adminId: string, ipAddress?: string): Promise<object>;
    private resolveUserId;
    getUserOrders(userId: string, page?: number, limit?: number, status?: string, adminId?: string, ipAddress?: string): Promise<object>;
    getUserWallet(userId: string, adminId?: string, ipAddress?: string): Promise<object>;
    getUserSessions(userId: string, page?: number, limit?: number, adminId?: string, ipAddress?: string): Promise<object>;
    adjustWallet(userId: string, dto: WalletAdjustDto, adminId: string, ipAddress?: string): Promise<{
        txId: string;
        type: string;
        amount: number;
        reason: string;
        balanceAfter: number;
    }>;
    getUserAuditLog(userId: string, page?: number, limit?: number, adminId?: string, ipAddress?: string): Promise<object>;
    forceLogout(userId: string, adminId: string, ipAddress?: string): Promise<{
        message: string;
        revokedCount: number;
    }>;
    revokeUserSession(userId: string, sessionId: string, adminId: string, ipAddress?: string): Promise<{
        message: string;
    }>;
    resetUserPassword(userId: string, adminId: string, ipAddress?: string): Promise<{
        message: string;
    }>;
}
