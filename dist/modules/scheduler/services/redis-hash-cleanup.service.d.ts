import { RedisService } from '../../../redis/redis.service';
export declare class RedisHashCleanupService {
    private redis;
    private readonly logger;
    private readonly RETENTION_MS;
    constructor(redis: RedisService);
    cleanupUnboundedHashes(): Promise<void>;
    private cleanupHash;
}
