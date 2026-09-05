import { PrismaService } from '../../../prisma/prisma.service';
import { RedisService } from '../../../redis/redis.service';
import { ScheduledWithdrawalService } from '../../withdrawals/scheduled-withdrawal.service';
export declare class ProcessScheduledWithdrawalsService {
    private prisma;
    private redis;
    private scheduledWithdrawalService;
    private readonly logger;
    constructor(prisma: PrismaService, redis: RedisService, scheduledWithdrawalService: ScheduledWithdrawalService);
    processAll(): Promise<void>;
}
