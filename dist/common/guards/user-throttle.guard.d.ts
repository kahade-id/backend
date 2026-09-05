import { CanActivate, ExecutionContext } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RedisService } from '../../redis/redis.service';
export declare class UserThrottleGuard implements CanActivate {
    private readonly redis;
    private readonly configService;
    private readonly logger;
    constructor(redis: RedisService, configService: ConfigService);
    canActivate(context: ExecutionContext): Promise<boolean>;
}
