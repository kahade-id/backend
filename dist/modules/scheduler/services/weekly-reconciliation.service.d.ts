import { PrismaService } from '../../../prisma/prisma.service';
import { RedisService } from '../../../redis/redis.service';
import { ReconciliationService } from '../../admin/finance/reconciliation.service';
export declare class WeeklyReconciliationService {
    private redis;
    private prisma;
    private reconciliationService;
    private readonly logger;
    constructor(redis: RedisService, prisma: PrismaService, reconciliationService: ReconciliationService);
    runDailyReconciliation(): Promise<void>;
    private reconcileEscrowBalances;
    private reconcileFeeWallet;
    private reconcileStaleProcessingWithdrawals;
    private alertAdminsOnMismatch;
    private getDayKey;
}
