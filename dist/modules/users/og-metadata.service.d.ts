import { PrismaService } from '../../prisma/prisma.service';
import { RedisService } from '../../redis/redis.service';
export declare class OgMetadataService {
    private prisma;
    private redis;
    constructor(prisma: PrismaService, redis: RedisService);
    getUserOgMetadata(username: string): Promise<object>;
    invalidateUserOgCache(username: string): Promise<void>;
    getOrderOgMetadata(orderId: string): Promise<object>;
}
