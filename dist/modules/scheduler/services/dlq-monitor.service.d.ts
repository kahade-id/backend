import { Queue } from 'bull';
import { RedisService } from '../../../redis/redis.service';
export declare class DlqMonitorService {
    private readonly dlq;
    private readonly redis;
    private readonly logger;
    constructor(dlq: Queue, redis: RedisService);
    checkDlqDepth(): Promise<void>;
}
