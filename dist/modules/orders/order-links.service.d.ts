import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service';
import { RedisService } from '../../redis/redis.service';
import { FeeCalculatorService } from './fee-calculator.service';
import { CreateOrderLinkDto } from './dto/create-order-link.dto';
import { NotificationQueueService } from '../queue/notification-queue.service';
export declare class OrderLinksService {
    private prisma;
    private redis;
    private feeCalculator;
    private notificationQueue;
    private configService?;
    private readonly logger;
    constructor(prisma: PrismaService, redis: RedisService, feeCalculator: FeeCalculatorService, notificationQueue: NotificationQueueService, configService?: ConfigService | undefined);
    private isRetryableDbError;
    private getShareUrl;
    private getNextLinkSerial;
    private getNextOrderSerial;
    createLink(userId: string, dto: CreateOrderLinkDto): Promise<object>;
    getLinkByToken(token: string): Promise<object>;
    acceptLink(token: string, userId: string): Promise<object>;
    getMyLinks(userId: string, page: number, limit: number): Promise<object>;
    cancelLink(token: string, userId: string): Promise<{
        message: string;
    }>;
}
