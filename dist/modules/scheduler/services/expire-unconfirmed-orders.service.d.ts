import { PrismaService } from '../../../prisma/prisma.service';
import { RedisService } from '../../../redis/redis.service';
export declare class ExpireUnconfirmedOrdersService {
    private prisma;
    private redis;
    private readonly logger;
    constructor(prisma: PrismaService, redis: RedisService);
    private emitRealtimeBestEffort;
    expireUnconfirmedOrders(): Promise<void>;
}
