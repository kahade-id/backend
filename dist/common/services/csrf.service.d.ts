import { ConfigService } from '@nestjs/config';
import { RedisService } from '../../redis/redis.service';
export declare class CsrfService {
    private redis;
    private configService;
    private readonly ttlSeconds;
    constructor(redis: RedisService, configService: ConfigService);
    private getTokenKey;
    generateToken(userId: string, jti: string): Promise<string>;
    private static readonly HEX_PATTERN;
    validateToken(userId: string, jti: string, csrfToken: string): Promise<boolean>;
}
