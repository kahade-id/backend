import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../../prisma/prisma.service';
import { RedisService } from '../../../redis/redis.service';
import { PaymentService } from '../../payment/payment.service';
export declare class WebhookRetryService {
    private prisma;
    private redis;
    private paymentService;
    private configService;
    private readonly logger;
    private readonly batchSize;
    constructor(prisma: PrismaService, redis: RedisService, paymentService: PaymentService, configService: ConfigService);
    retryFailedWebhooks(): Promise<void>;
}
