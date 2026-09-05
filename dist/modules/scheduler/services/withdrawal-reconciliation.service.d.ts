import { PrismaService } from '../../../prisma/prisma.service';
import { RedisService } from '../../../redis/redis.service';
import { MidtransService } from '../../payment/midtrans.service';
import { NotificationQueueService } from '../../queue/notification-queue.service';
export declare class WithdrawalReconciliationService {
    private prisma;
    private redis;
    private midtransService;
    private notificationQueue;
    private readonly logger;
    private runNotificationBestEffort;
    constructor(prisma: PrismaService, redis: RedisService, midtransService: MidtransService, notificationQueue: NotificationQueueService);
    reconcileProcessingWithdrawals(): Promise<void>;
    private refundFailedWithdrawal;
}
