import { AdminRoute } from '../../../common/decorators/public.decorator';
import { Idempotency } from '../../../common/decorators/idempotency.decorator';
import { Controller, Get, Post, Param, Query, Body, UseGuards, Req, BadRequestException, HttpCode } from '@nestjs/common';
import { ParseIdPipe } from '../../../common/pipes/parse-id.pipe';
import { ParseDateQueryPipe } from '../../../common/pipes/parse-query-string.pipe';
import { parseDateBoundaryWIB } from '../../../common/utils/date.util';
import { Throttle } from '@nestjs/throttler';
import { Request } from 'express';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { InjectQueue } from '@nestjs/bull';
import { Queue } from 'bull';
import { AdminFinanceService } from './admin-finance.service';
import { ReconciliationService } from './reconciliation.service';
import { RECONCILIATION_QUEUE, ReconciliationJobData } from './reconciliation.processor';
import { FinanceTransactionQueryDto } from './dto/finance-query.dto';
import { WithdrawalApproveDto, WithdrawalRejectDto } from './dto/withdrawal-action.dto';
import { JwtAdminGuard } from '../../../common/guards/jwt-admin.guard';
import { AdminRolesGuard } from '../../../common/guards/admin-roles.guard';
import { AdminRoles } from '../../../common/decorators/admin-roles.decorator';
import { CurrentAdmin } from '../../../common/decorators/current-admin.decorator';
import { PaginationDto } from '../../../common/dto/pagination.dto';
import { UserThrottleGuard } from '../../../common/guards/user-throttle.guard';

@ApiTags('admin-finance')
@ApiBearerAuth('access-token')
@UseGuards(JwtAdminGuard, AdminRolesGuard)
@AdminRoles('FINANCE_ADMIN', 'SUPER_ADMIN')
@AdminRoute()
@Controller('admin/finance')
export class AdminFinanceController {
  constructor(
    private readonly service: AdminFinanceService,
    private readonly reconciliationService: ReconciliationService,
    @InjectQueue(RECONCILIATION_QUEUE) private readonly reconciliationQueue: Queue<ReconciliationJobData>,
  ) {}

  @Get('transactions')
  @ApiOperation({ summary: 'List all wallet transactions', description: 'Paginated list of all wallet transactions with optional filters.' })
  @ApiResponse({ status: 200, description: 'Transactions list returned.' })
  listTransactions(@Query() query: FinanceTransactionQueryDto): Promise<object> {
    return this.service.listTransactions(query);
  }

  @Get('transactions/:txId')
  @ApiOperation({ summary: 'Get transaction detail', description: 'Returns full transaction detail including wallet owner and related entities.' })
  @ApiResponse({ status: 200, description: 'Transaction detail returned.' })
  @ApiResponse({ status: 404, description: 'Transaction not found.' })
  getTransactionDetail(@Param('txId', ParseIdPipe) txId: string, @CurrentAdmin('sub') adminId: string, @Req() req: Request): Promise<object> {
    return this.service.getTransactionDetail(txId, adminId, req.ip || 'unknown');
  }

  @Get('summary')
  @ApiOperation({ summary: 'Financial summary', description: 'Aggregated financial summary: total topup, withdrawal, fees, escrow balance.' })
  @ApiResponse({ status: 200, description: 'Financial summary returned.' })
  getFinancialSummary(): Promise<object> {
    return this.service.getFinancialSummary();
  }

  @Get('withdrawals/pending')
  @ApiOperation({ summary: 'List pending withdrawals', description: 'Paginated list of all withdrawals with pending status.' })
  @ApiResponse({ status: 200, description: 'Pending withdrawals list returned.' })
  listPendingWithdrawals(@Query() query: PaginationDto, @CurrentAdmin('sub') adminId: string, @Req() req: Request): Promise<object> {
    return this.service.listPendingWithdrawals(query.page, query.limit, adminId, req.ip || 'unknown');
  }

  // B-02 (audit-fix): Withdrawal approve/reject MUST be idempotent — a
  // network-retry / double-tap on "Approve" must not produce two Iris payouts.
  @Post('withdrawals/:txId/approve')
  @UseGuards(UserThrottleGuard)
  @Idempotency()
  @Throttle({ default: { ttl: 60000, limit: 10 } })
  @ApiOperation({ summary: 'Approve pending withdrawal', description: 'Approve a pending withdrawal transaction and mark it as successful. Requires Idempotency-Key.' })
  @ApiResponse({ status: 200, description: 'Withdrawal approved.' })
  @ApiResponse({ status: 404, description: 'Transaction not found.' })
  approveWithdrawal(@Param('txId', ParseIdPipe) txId: string, @Body() dto: WithdrawalApproveDto, @CurrentAdmin('sub') adminId: string, @Req() req: Request): Promise<object> {
    return this.service.approveWithdrawal(txId, dto, adminId, req.ip || 'unknown');
  }

  @Post('withdrawals/:txId/reject')
  @UseGuards(UserThrottleGuard)
  @Idempotency()
  @Throttle({ default: { ttl: 60000, limit: 10 } })
  @ApiOperation({ summary: 'Reject pending withdrawal', description: 'Reject a pending withdrawal transaction and refund the balance. Requires Idempotency-Key.' })
  @ApiResponse({ status: 200, description: 'Withdrawal rejected.' })
  @ApiResponse({ status: 404, description: 'Transaction not found.' })
  rejectWithdrawal(@Param('txId', ParseIdPipe) txId: string, @Body() dto: WithdrawalRejectDto, @CurrentAdmin('sub') adminId: string, @Req() req: Request): Promise<object> {
    return this.service.rejectWithdrawal(txId, dto, adminId, req.ip || 'unknown');
  }

  @Get('escrow-summary')
  @ApiOperation({ summary: 'Active escrow totals', description: 'Returns aggregated escrow balance totals across all wallets.' })
  @ApiResponse({ status: 200, description: 'Escrow summary returned.' })
  getEscrowSummary(): Promise<{ totalEscrowBalance: number; walletsWithEscrow: number; activeEscrowOrders: number }> {
    return this.service.getEscrowSummary();
  }

  @Get('revenue')
  @ApiOperation({ summary: 'Platform revenue breakdown', description: 'Returns platform revenue breakdown from fees earned.' })
  @ApiResponse({ status: 200, description: 'Revenue data returned.' })
  getRevenue(): Promise<object> {
    return this.service.getRevenue();
  }

  @Throttle({ default: { ttl: 60000, limit: 5 } })
  @UseGuards(UserThrottleGuard)
  @Post('reconcile/user/:userId')
  @AdminRoles('SUPER_ADMIN')
  @ApiOperation({ summary: 'Reconcile single wallet', description: 'Recalculates expected balance from transactions and compares with actual balance.' })
  @ApiResponse({ status: 200, description: 'Reconciliation result returned.' })
  @ApiResponse({ status: 404, description: 'Wallet not found.' })
  async reconcileUser(@Param('userId', ParseIdPipe) userId: string, @CurrentAdmin('sub') adminId: string, @Req() req: Request): Promise<object> {
    const discrepancy = await this.reconciliationService.reconcileWalletBalance(userId);
    const result = {
      userId,
      reconciledAt: new Date().toISOString(),
      clean: discrepancy === null,
      discrepancy: discrepancy ?? undefined,
    };

    this.service.logReconciliation(adminId, userId, result.clean, req.ip || 'unknown');

    return result;
  }

  @Post('reconcile/all')
  @UseGuards(UserThrottleGuard)
  @Throttle({ default: { ttl: 3600000, limit: 1 } })
  @AdminRoles('SUPER_ADMIN')
  @ApiOperation({ summary: 'Reconcile all wallets (async)', description: 'Enqueues reconciliation for all wallets via background job. Returns job ID for status polling.' })
  @HttpCode(202)
  @ApiResponse({ status: 202, description: 'Reconciliation job enqueued.' })
  async reconcileAll(@CurrentAdmin('sub') adminId: string): Promise<object> {
    const job = await this.reconciliationQueue.add('reconcile-all', {
      requestedBy: adminId,
      requestedAt: new Date().toISOString(),
    });
    return {
      jobId: job.id,
      status: 'queued',
      message: 'Reconciliation job enqueued. Poll GET /admin/finance/reconcile/status/:jobId for results.',
    };
  }

  @Get('reconcile/status/:jobId')
  @AdminRoles('SUPER_ADMIN')
  @ApiOperation({ summary: 'Get reconciliation job status', description: 'Returns the status and result of an async reconciliation job.' })
  @ApiResponse({ status: 200, description: 'Job status returned.' })
  async getReconcileJobStatus(@Param('jobId') jobId: string): Promise<object> {
    const job = await this.reconciliationQueue.getJob(jobId);
    if (!job) {
      throw new BadRequestException({ code: 'NOT_FOUND', message: 'Reconciliation job not found' });
    }

    const state = await job.getState();
    const result = job.returnvalue;

    return {
      jobId: job.id,
      status: state,
      requestedBy: job.data.requestedBy,
      requestedAt: job.data.requestedAt,
      ...(state === 'completed' && result ? { result } : {}),
      ...(state === 'failed' ? { error: job.failedReason } : {}),
    };
  }

  @Get('audit-trail/:userId')
  @AdminRoles('SUPER_ADMIN')
  @ApiOperation({ summary: 'Financial audit trail', description: 'Returns all transactions in date range with running balance per row.' })
  @ApiResponse({ status: 200, description: 'Audit trail returned.' })
  @ApiResponse({ status: 404, description: 'Wallet not found.' })
  getAuditTrail(
    @Param('userId', ParseIdPipe) userId: string,
    @Query('from', new ParseDateQueryPipe('from')) from: string,
    @Query('to', new ParseDateQueryPipe('to')) to: string,
  ): Promise<object> {
    if (!from || !to) {
      throw new BadRequestException({ code: 'INVALID_DATE_RANGE', message: 'from and to query parameters are required' });
    }
    const fromDate = parseDateBoundaryWIB(from, 'start');
    const toDate = parseDateBoundaryWIB(to, 'end');
    if (!fromDate || !toDate) {
      throw new BadRequestException({ code: 'INVALID_DATE_FORMAT', message: 'from and to must be valid ISO date strings' });
    }
    if (fromDate > toDate) {
      throw new BadRequestException({ code: 'INVALID_DATE_RANGE', message: 'from must be before or equal to to' });
    }
    return this.reconciliationService.getFinancialAuditTrail(userId, from, to);
  }
}
