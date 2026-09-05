import { ConfigService } from '@nestjs/config';
import { RedisService } from '../../../redis/redis.service';
export declare class OrphanedUploadCleanupService {
    private redis;
    private configService;
    private readonly logger;
    private _s3Client;
    constructor(redis: RedisService, configService: ConfigService);
    private getS3Client;
    cleanupOrphanedUploads(): Promise<void>;
    private cleanupBucket;
}
