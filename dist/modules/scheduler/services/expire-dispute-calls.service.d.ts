import { PrismaService } from '../../../prisma/prisma.service';
import { RedisService } from '../../../redis/redis.service';
export declare class ExpireDisputeCallsService {
    private prisma;
    private redis;
    private readonly logger;
    private readonly CALL_REQUEST_EXPIRY_SECONDS;
    constructor(prisma: PrismaService, redis: RedisService);
    expireDisputeCalls(): Promise<void>;
}
