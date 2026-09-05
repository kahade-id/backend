import { CanActivate, ExecutionContext } from '@nestjs/common';
import { RedisService } from '../../redis/redis.service';
export declare class GlobalThrottleGuard implements CanActivate {
    private readonly redis;
    private readonly logger;
    constructor(redis: RedisService);
    canActivate(context: ExecutionContext): Promise<boolean>;
}
