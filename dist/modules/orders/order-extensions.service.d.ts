import { PrismaService } from '../../prisma/prisma.service';
import { RedisService } from '../../redis/redis.service';
import { DeadlineExtensionStatus } from '@prisma/client';
import { NotificationQueueService } from '../queue/notification-queue.service';
export declare class OrderExtensionsService {
    private prisma;
    private redis;
    private notificationQueue;
    private readonly logger;
    constructor(prisma: PrismaService, redis: RedisService, notificationQueue: NotificationQueueService);
    private isRetryableDbError;
    private withSerializableRetry;
    requestExtension(orderId: string, requesterId: string, dto: {
        extensionDays: number;
        reason: string;
    }): Promise<{
        extensionId: string;
        requestedDays: number;
        status: string;
    }>;
    respondExtension(extensionId: string, responderId: string, dto: {
        action: 'APPROVE' | 'REJECT';
        note?: string;
    }, orderId?: string): Promise<{
        extensionId: string;
        status: DeadlineExtensionStatus;
    }>;
    getExtensions(orderId: string, userId: string, page?: number, limit?: number): Promise<{
        data: object[];
        total: number;
        page: number;
        limit: number;
        totalPages: number;
    }>;
}
