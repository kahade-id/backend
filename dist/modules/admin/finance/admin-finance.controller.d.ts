import { Request } from 'express';
import { Queue } from 'bull';
import { AdminFinanceService } from './admin-finance.service';
import { ReconciliationService } from './reconciliation.service';
import { ReconciliationJobData } from './reconciliation.processor';
import { FinanceTransactionQueryDto } from './dto/finance-query.dto';
import { WithdrawalApproveDto, WithdrawalRejectDto } from './dto/withdrawal-action.dto';
import { PaginationDto } from '../../../common/dto/pagination.dto';
export declare class AdminFinanceController {
    private readonly service;
    private readonly reconciliationService;
    private readonly reconciliationQueue;
    constructor(service: AdminFinanceService, reconciliationService: ReconciliationService, reconciliationQueue: Queue<ReconciliationJobData>);
    listTransactions(query: FinanceTransactionQueryDto): Promise<object>;
    getTransactionDetail(txId: string, adminId: string, req: Request): Promise<object>;
    getFinancialSummary(): Promise<object>;
    listPendingWithdrawals(query: PaginationDto, adminId: string, req: Request): Promise<object>;
    approveWithdrawal(txId: string, dto: WithdrawalApproveDto, adminId: string, req: Request): Promise<object>;
    rejectWithdrawal(txId: string, dto: WithdrawalRejectDto, adminId: string, req: Request): Promise<object>;
    getEscrowSummary(): Promise<{
        totalEscrowBalance: number;
        walletsWithEscrow: number;
        activeEscrowOrders: number;
    }>;
    getRevenue(): Promise<object>;
    reconcileUser(userId: string, adminId: string, req: Request): Promise<object>;
    reconcileAll(adminId: string): Promise<object>;
    getReconcileJobStatus(jobId: string): Promise<object>;
    getAuditTrail(userId: string, from: string, to: string): Promise<object>;
}
