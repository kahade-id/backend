import { AdminRoute } from '../../../common/decorators/public.decorator';
import { Idempotency } from '../../../common/decorators/idempotency.decorator';
import { Controller, Get, Post, Param, Query, Body, UseGuards, Req, Res, BadRequestException, HttpCode } from '@nestjs/common';
import { Response } from 'express';
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
import { ReconciliationFindingsService } from './reconciliation-findings.service';
import { LedgerCorrectionService } from './ledger-corrections.service';
import { RECONCILIATION_QUEUE, ReconciliationJobData } from './reconciliation.processor';
import { FinanceTransactionQueryDto } from './dto/finance-query.dto';
import { FindingsQueryDto, AcknowledgeFindingDto, BatchDiscrepanciesQueryDto } from './dto/finance-findings.dto';
import { RequestCorrectionDto, DecideCorrectionDto, CorrectionsQueryDto } from './dto/ledger-correction.dto';
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
    private readonly findingsService: ReconciliationFindingsService,
    private readonly correctionsService: LedgerCorrectionService,
    @InjectQueue(RECONCILIATION_QUEUE) private readonly reconciliationQueue: Queue<ReconciliationJobData>,
  ) {}

  @Get('transactions')
  @ApiOperation({ summary: 'List all wallet transactions', description: 'Paginated list of all wallet transactions with optional filters.' })
  @ApiResponse({ status: 200, description: 'Transactions list returned.' })
  listTransactions(@Query() query: FinanceTransactionQueryDto): Promise<object> {
    return this.service.listTransactions(query);
  }

  // AW-002 (perf-fix): agregat server-side untuk halaman Keuangan — DIDAFTARKAN
  // SEBELUM 'transactions/:txId' agar 'summary' tidak ditangkap sebagai :txId.
  @Get('transactions/summary')
  @ApiOperation({
    summary: 'Transaction aggregate (masuk/keluar)',
    description: 'AW-002: server-side SUM of wallet transaction amounts grouped by flow direction (masuk/keluar), using the SAME filters as the list endpoint (type, status, date range, search). No row fetching, no limit clamp — the numbers are exact. Fail-closed: errors are thrown, never silently wrong numbers.',
  })
  @ApiResponse({ status: 200, description: 'Aggregate returned: { masuk, keluar, bersih, count }.' })
  getTransactionsSummary(@Query() query: FinanceTransactionQueryDto): Promise<object> {
    return this.service.getTransactionsAggregate(query);
  }

  @Get('transactions/:txId')
  @ApiOperation({ summary: 'Get transaction detail', description: 'Returns full transaction detail including wallet owner and related entities.' })
  @ApiResponse({ status: 200, description: 'Transaction detail returned.' })
  @ApiResponse({ status: 404, description: 'Transaction not found.' })
  getTransactionDetail(@Param('txId', ParseIdPipe) txId: string, @CurrentAdmin('sub') adminId: string, @Req() req: Request): Promise<object> {
    return this.service.getTransactionDetail(txId, adminId, req.ip || 'unknown');
  }

  @Get('transactions/:txId/timeline')
  @ApiOperation({ summary: 'Transaction timeline', description: 'Combined ledger + webhook events for a transaction, sorted chronologically. Secrets in payloads are masked.' })
  @ApiResponse({ status: 200, description: 'Timeline returned.' })
  @ApiResponse({ status: 404, description: 'Transaction not found.' })
  getTransactionTimeline(@Param('txId', ParseIdPipe) txId: string, @CurrentAdmin('sub') adminId: string, @Req() req: Request): Promise<object> {
    return this.service.getTransactionTimeline(txId, adminId, req.ip || 'unknown');
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
  @ApiOperation({ summary: 'Approve pending withdrawal (dual control)', description: 'ADM-205: records this admin\'s approval. The Iris payout is executed ONLY after the required quorum of DIFFERENT admins approve (default: 2 for all amounts — fail-closed; configurable via SystemConfig withdrawal.dual_approval_threshold_idr). First approval returns AWAITING_SECOND_APPROVAL without touching the payout. Requires Idempotency-Key.' })
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

  // ADM-213: recheck manual — query status provider, BUKAN retry payout.
  // network-retry / double-tap must not re-query-spam the provider nor mutate twice.
  @Post('withdrawals/:txId/recheck')
  @UseGuards(UserThrottleGuard)
  @Idempotency()
  @Throttle({ default: { ttl: 60000, limit: 10 } })
  @ApiOperation({ summary: 'Recheck PROCESSING withdrawal against payout provider', description: 'ADM-213: queries Midtrans Iris payout status for ONE stuck PROCESSING withdrawal and applies the same safe transitions as the automated reconciler (completed/processed -> SUCCESS, failed/rejected -> FAILED + refund; otherwise stays PROCESSING, no money mutation). NEVER submits a new payout. Requires Idempotency-Key.' })
  @ApiResponse({ status: 200, description: 'Recheck result (providerStatus + outcome).' })
  @ApiResponse({ status: 404, description: 'Transaction not found.' })
  @ApiResponse({ status: 409, description: 'Withdrawal is not PROCESSING.' })
  recheckWithdrawal(@Param('txId', ParseIdPipe) txId: string, @CurrentAdmin('sub') adminId: string, @Req() req: Request): Promise<object> {
    return this.service.recheckWithdrawal(txId, adminId, req.ip || 'unknown');
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
    // E3: selisih disimpan sebagai ReconciliationFinding (dedup otomatis).
    const findings = await this.findingsService.recordFromDiscrepancies(
      discrepancy ? [discrepancy] : [],
      null,
      adminId,
    );
    const result = {
      userId,
      reconciledAt: new Date().toISOString(),
      clean: discrepancy === null,
      discrepancy: discrepancy ?? undefined,
      findingId: findings[0]?.id ?? null,
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

  @Get('export/csv')
  @AdminRoles('SUPER_ADMIN', 'FINANCE_ADMIN')
  @ApiOperation({ summary: 'Export finance summary CSV (19.4)' })
  async exportCsv(
    @Query('from') from?: string,
    @Query('to') to?: string,
    @CurrentAdmin('sub') adminId?: string,
    @Res() res?: Response,
  ): Promise<void> {
    // CW-022: dukung rentang tanggal (default 30 hari terakhir, maks 365 hari).
    const toDate = to ? parseDateBoundaryWIB(to, 'end') : new Date();
    const fromDate = from ? parseDateBoundaryWIB(from, 'start') : new Date((toDate ?? new Date()).getTime() - 30 * 24 * 60 * 60 * 1000);
    if (!fromDate || !toDate) {
      throw new BadRequestException({ code: 'INVALID_DATE_FORMAT', message: 'from and to must be valid ISO date strings' });
    }
    if (fromDate > toDate) {
      throw new BadRequestException({ code: 'INVALID_DATE_RANGE', message: 'from must be before or equal to to' });
    }
    const diffDays = Math.ceil((toDate.getTime() - fromDate.getTime()) / (1000 * 60 * 60 * 24));
    if (diffDays > 365) {
      throw new BadRequestException({ code: 'DATE_RANGE_TOO_LARGE', message: 'Export date range cannot exceed 365 days' });
    }
    const csv = await this.service.buildFinanceCsvExport(fromDate, toDate, adminId ?? 'unknown');
    res!.setHeader('Content-Type', 'text/csv');
    res!.setHeader('Content-Disposition', 'attachment; filename="finance-export.csv"');
    res!.send(csv);
  }

  // ============================================================
  // E3 (G326-G350): temuan rekonsiliasi
  // ============================================================

  @Get('findings')
  @ApiOperation({ summary: 'List reconciliation findings', description: 'Paginated findings with filters: status, minDifferenceIdr, maxAgeDays, invariant, urgentOnly.' })
  @ApiResponse({ status: 200, description: 'Findings returned.' })
  listFindings(@Query() query: FindingsQueryDto): Promise<object> {
    return this.findingsService.listFindings(query);
  }

  @Post('findings/:id/acknowledge')
  @AdminRoles('FINANCE_ADMIN', 'SUPER_ADMIN')
  @UseGuards(UserThrottleGuard)
  @Throttle({ default: { ttl: 60000, limit: 10 } })
  @ApiOperation({ summary: 'Acknowledge finding', description: 'Transition a finding to INVESTIGATING/RESOLVED/ACCEPTED with notes. Audited.' })
  @ApiResponse({ status: 200, description: 'Finding acknowledged.' })
  @ApiResponse({ status: 404, description: 'Finding not found.' })
  @ApiResponse({ status: 409, description: 'Invalid status transition.' })
  acknowledgeFinding(
    @Param('id', ParseIdPipe) id: string,
    @Body() dto: AcknowledgeFindingDto,
    @CurrentAdmin('sub') adminId: string,
    @Req() req: Request,
  ): Promise<object> {
    return this.findingsService.acknowledgeFinding(id, adminId, dto, req.ip || 'unknown');
  }

  // ============================================================
  // E3 (G326-G350): koreksi ledger manual — dual approval
  // ============================================================

  @Post('corrections')
  @AdminRoles('FINANCE_ADMIN', 'SUPER_ADMIN')
  @UseGuards(UserThrottleGuard)
  @Idempotency()
  @Throttle({ default: { ttl: 60000, limit: 10 } })
  @ApiOperation({
    summary: 'Request ledger correction (step 1 of 2)',
    description: 'Creates a PENDING_APPROVAL correction request. NO balance mutation happens here. Requires Idempotency-Key header.',
  })
  @ApiResponse({ status: 200, description: 'Correction request created (or replayed idempotently).' })
  requestCorrection(
    @Body() dto: RequestCorrectionDto,
    @CurrentAdmin('sub') adminId: string,
    @Req() req: Request,
  ): Promise<object> {
    return this.correctionsService.requestCorrection(adminId, dto, req.ip || 'unknown');
  }

  @Get('corrections')
  @AdminRoles('FINANCE_ADMIN', 'SUPER_ADMIN')
  @ApiOperation({ summary: 'List correction requests', description: 'Correction requests with their approval status. Filter by status.' })
  @ApiResponse({ status: 200, description: 'Corrections returned.' })
  listCorrections(@Query() query: CorrectionsQueryDto): Promise<object> {
    return this.correctionsService.listCorrections(query);
  }

  @Get('corrections/:id')
  @AdminRoles('FINANCE_ADMIN', 'SUPER_ADMIN')
  @ApiOperation({ summary: 'Get correction request', description: 'Single correction request with its decision (if any).' })
  @ApiResponse({ status: 200, description: 'Correction returned.' })
  @ApiResponse({ status: 404, description: 'Correction request not found.' })
  getCorrection(@Param('id', ParseIdPipe) id: string): Promise<object> {
    return this.correctionsService.getCorrection(id);
  }

  @Post('corrections/:id/approve')
  @AdminRoles('FINANCE_ADMIN', 'SUPER_ADMIN')
  @UseGuards(UserThrottleGuard)
  @Idempotency()
  @Throttle({ default: { ttl: 60000, limit: 10 } })
  @ApiOperation({
    summary: 'Decide correction (step 2 of 2)',
    description: 'APPROVE executes the ledger mutation (must be a DIFFERENT admin than the requester); REJECT cancels. Requires Idempotency-Key header.',
  })
  @ApiResponse({ status: 200, description: 'Decision recorded.' })
  @ApiResponse({ status: 403, description: 'Self-approval is forbidden.' })
  @ApiResponse({ status: 404, description: 'Correction request not found.' })
  @ApiResponse({ status: 409, description: 'Already decided.' })
  decideCorrection(
    @Param('id', ParseIdPipe) id: string,
    @Body() dto: DecideCorrectionDto,
    @CurrentAdmin('sub') adminId: string,
    @Req() req: Request,
  ): Promise<object> {
    return this.correctionsService.decideCorrection(id, adminId, dto, req.ip || 'unknown');
  }

  // ============================================================
  // E3 (G326-G350): batch rekonsiliasi terjadwal
  // ============================================================

  @Get('reconcile/batches')
  @ApiOperation({ summary: 'List reconciliation batch snapshots', description: 'Immutable summaries of past reconcile-all runs (newest first).' })
  @ApiResponse({ status: 200, description: 'Batch snapshots returned.' })
  listReconcileBatches(): Promise<object> {
    return this.reconciliationService.listBatchSnapshots().then((batches) => ({ batches }));
  }

  @Get('reconcile/batches/:batchId/discrepancies')
  @ApiOperation({ summary: 'Batch discrepancies drill-down', description: 'Paginated findings recorded for a specific batch.' })
  @ApiResponse({ status: 200, description: 'Batch discrepancies returned.' })
  getBatchDiscrepancies(
    @Param('batchId') batchId: string,
    @Query() query: BatchDiscrepanciesQueryDto,
  ): Promise<object> {
    return this.findingsService.listByBatch(batchId, query.page ?? 1, query.limit ?? 20);
  }

  @Get('reconcile/findings/export/csv')
  @ApiOperation({ summary: 'Export reconciliation findings CSV (tanpa PII)', description: 'Findings report with user identities reduced to initials — no userId, email, or phone numbers.' })
  @ApiResponse({ status: 200, description: 'CSV exported.' })
  async exportFindingsCsv(
    @CurrentAdmin('sub') adminId: string,
    @Req() req: Request,
    @Res() res?: Response,
  ): Promise<void> {
    const csv = await this.service.buildFindingsCsvExport(adminId);
    this.service.logReconciliation(adminId, 'findings-export', true, req.ip || 'unknown');
    res!.setHeader('Content-Type', 'text/csv');
    res!.setHeader('Content-Disposition', 'attachment; filename="reconciliation-findings.csv"');
    res!.send(csv);
  }
}
