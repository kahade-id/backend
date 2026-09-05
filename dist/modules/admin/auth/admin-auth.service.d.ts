import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../../prisma/prisma.service';
import { RedisService } from '../../../redis/redis.service';
import { AuditLogService } from '../../../common/services/audit-log.service';
import { TokenService } from '../../auth/token.service';
export declare class AdminAuthService {
    private prisma;
    private redis;
    private configService;
    private auditLogService;
    private tokenService;
    private readonly logger;
    constructor(prisma: PrismaService, redis: RedisService, configService: ConfigService, auditLogService: AuditLogService, tokenService: TokenService);
    login(email: string, password: string, totpToken?: string, ipAddress?: string): Promise<{
        requiresMfa: true;
        tempToken: string;
    } | {
        accessToken: string;
        refreshToken: string;
        admin: {
            id: string;
            adminId: string;
            fullName: string;
            email: string;
            role: string;
            isActive: boolean;
            isMfaEnabled: boolean;
            lastLoginAt: string | null;
        };
    }>;
    verifyAdmin2fa(tempToken: string, totpToken: string, ipAddress?: string): Promise<{
        accessToken: string;
        refreshToken: string;
        admin: {
            id: string;
            adminId: string;
            fullName: string;
            email: string;
            role: string;
            isActive: boolean;
            isMfaEnabled: boolean;
            lastLoginAt: string | null;
        };
    }>;
    refreshAdminToken(refreshToken: string): Promise<{
        accessToken: string;
        refreshToken: string;
    }>;
    private claimTotpCode;
    logout(adminId: string, accessTokenJti: string, ipAddress: string, refreshToken?: string): Promise<{
        message: string;
    }>;
    getProfile(adminId: string): Promise<{
        id: string;
        adminId: string;
        fullName: string;
        email: string;
        role: string;
        isActive: boolean;
        isMfaEnabled: boolean;
        lastLoginAt: Date | null;
        lastLoginIp: string | null;
    }>;
    private getAdminAccessTokenTtlSeconds;
    private getAdminRefreshTokenTtlSeconds;
    private isAdminMfaRequired;
}
