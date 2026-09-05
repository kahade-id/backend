import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service';
import { RedisService } from '../../redis/redis.service';
export declare class SessionsService {
    private prisma;
    private redis;
    private configService;
    private readonly logger;
    private readonly accessTokenTtlSeconds;
    constructor(prisma: PrismaService, redis: RedisService, configService: ConfigService);
    getActiveSessions(userId: string, currentSessionId: string, page?: number, limit?: number): Promise<{
        sessions: Array<Record<string, unknown>>;
        total: number;
        page: number;
        limit: number;
    }>;
    private maskIpAddress;
    private expandIPv6;
    revokeSession(userId: string, sessionId: string): Promise<{
        message: string;
    }>;
    revokeAllOtherSessions(userId: string, currentSessionId: string): Promise<{
        count: number;
    }>;
}
