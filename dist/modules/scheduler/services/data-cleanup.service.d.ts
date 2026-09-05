import { OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../../prisma/prisma.service';
import { RedisService } from '../../../redis/redis.service';
export declare class DataCleanupService implements OnModuleInit {
    private prisma;
    private redis;
    private configService;
    private readonly logger;
    private readonly retentionExpiredOtpDays;
    private readonly retentionWebhookLogDays;
    private readonly retentionAnonymizeDays;
    constructor(prisma: PrismaService, redis: RedisService, configService: ConfigService);
    private anonymizedPasswordHash;
    onModuleInit(): Promise<void>;
    cleanupExpiredData(): Promise<void>;
    private anonymizeDeletedUsers;
}
