import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service';
import { RedisService } from '../../redis/redis.service';
export declare class PublicService {
    private prisma;
    private redis;
    private configService;
    constructor(prisma: PrismaService, redis: RedisService, configService: ConfigService);
    private readonly PUBLIC_CONFIGS_CACHE_KEY;
    private readonly PUBLIC_CONFIGS_TTL_SECONDS;
    getPublicConfigs(): Promise<{
        configs: Array<{
            key: string;
            value: string;
            description: string | null;
            dataType: string;
            updatedAt: Date;
        }>;
    }>;
    getFeeSchedule(): Record<string, unknown>;
    getBanks(): {
        banks: Array<{
            code: string;
            name: string;
        }>;
    };
    getExchangeRates(): Promise<Record<string, unknown>>;
    getAppVersion(): Record<string, unknown>;
    getSubscriptionPlans(): Promise<Record<string, unknown>>;
}
