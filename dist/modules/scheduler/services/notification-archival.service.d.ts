import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../../prisma/prisma.service';
import { RedisService } from '../../../redis/redis.service';
export declare class NotificationArchivalService {
    private prisma;
    private redis;
    private configService;
    private readonly logger;
    private readonly retentionReadDays;
    private readonly retentionUnreadDays;
    constructor(prisma: PrismaService, redis: RedisService, configService: ConfigService);
    archiveOldNotifications(): Promise<void>;
}
