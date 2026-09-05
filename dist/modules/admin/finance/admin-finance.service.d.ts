import { PrismaService } from '../../../prisma/prisma.service';
import { FinanceTransactionQueryDto } from './dto/finance-query.dto';
import { WithdrawalApproveDto, WithdrawalRejectDto } from './dto/withdrawal-action.dto';
import { AuditLogService } from '../../../common/services/audit-log.service';
import { MidtransService } from '../../../modules/payment/midtrans.service';
export declare class AdminFinanceService {
    private readonly prisma;
    private readonly auditLog;
    private readonly midtransService;
    private readonly logger;
    private sanitizeAdminNote;
    constructor(prisma: PrismaService, auditLog: AuditLogService, midtransService: MidtransService);
    listTransactions(query: FinanceTransactionQueryDto): Promise<object>;
    getTransactionDetail(txId: string, adminId: string, ipAddress?: string): Promise<object>;
    getFinancialSummary(): Promise<object>;
    listPendingWithdrawals(page: number | undefined, limit: number | undefined, adminId: string, ipAddress?: string): Promise<object>;
    approveWithdrawal(txId: string, dto: WithdrawalApproveDto, adminId: string, ipAddress?: string): Promise<object>;
    rejectWithdrawal(txId: string, dto: WithdrawalRejectDto, adminId: string, ipAddress?: string): Promise<object>;
    logReconciliation(adminId: string, userId: string, clean: boolean, ipAddress: string): void;
    getEscrowSummary(): Promise<{
        totalEscrowBalance: number;
        walletsWithEscrow: number;
        activeEscrowOrders: number;
    }>;
    getRevenue(): Promise<object>;
}
