import { PrismaService } from '../../../prisma/prisma.service';
import { AuditLogService } from '../../../common/services/audit-log.service';
import { MidtransService } from '../../payment/midtrans.service';
export declare class AdminSubscriptionsService {
    private prisma;
    private auditLog;
    private midtransService;
    private readonly logger;
    constructor(prisma: PrismaService, auditLog: AuditLogService, midtransService: MidtransService);
    listSubscriptions(page: number, limit: number, status?: string, plan?: string): Promise<object>;
    getSubscriptionDetail(subId: string): Promise<object>;
    forceCancelSubscription(subId: string, adminId: string, ipAddress: string): Promise<{
        message: string;
        subscriptionId: string;
        status: string;
    }>;
}
