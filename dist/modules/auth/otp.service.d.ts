import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service';
import { RedisService } from '../../redis/redis.service';
import { OtpType, OtpMethod, Prisma } from '@prisma/client';
export declare class OtpService {
    private prisma;
    private redis;
    private configService;
    constructor(prisma: PrismaService, redis: RedisService, configService: ConfigService);
    generateOtp(email: string, type: OtpType, userId?: string, metadata?: Prisma.InputJsonValue, ipAddress?: string): Promise<string>;
    generatePhoneOtp(phone: string, type: OtpType, method: OtpMethod, userId?: string, metadata?: Prisma.InputJsonValue, ipAddress?: string): Promise<string>;
    verifyPhoneOtp(phone: string, type: OtpType, code: string): Promise<boolean>;
    verifyPhoneOtpWithMetadata(phone: string, type: OtpType, code: string, options?: {
        consume?: boolean;
    }): Promise<{
        valid: boolean;
        metadata?: Record<string, unknown>;
        otpId?: string;
    }>;
    invalidatePhoneOtps(phone: string, type: OtpType): Promise<void>;
    verifyOtpWithMetadata(email: string, type: OtpType, code: string, options?: {
        consume?: boolean;
    }): Promise<{
        valid: boolean;
        metadata?: Record<string, unknown>;
        otpId?: string;
    }>;
    consumeVerifiedOtp(otpId: string): Promise<boolean>;
    verifyOtp(email: string, type: OtpType, code: string): Promise<boolean>;
    invalidateOtps(email: string, type: OtpType): Promise<void>;
    getLatestOtp(email: string, type: OtpType): Promise<{
        id: string;
        email: string | null;
        code: string;
        type: OtpType;
        isUsed: boolean;
        attempts: number;
        expiresAt: Date;
        createdAt: Date;
        metadata: unknown;
    } | null>;
}
