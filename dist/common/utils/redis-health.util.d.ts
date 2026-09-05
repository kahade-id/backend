import { RedisService } from '../../redis/redis.service';
export declare function ensureRedisAvailable(redis: RedisService, jobName: string): Promise<boolean>;
