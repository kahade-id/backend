"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
var __param = (this && this.__param) || function (paramIndex, decorator) {
    return function (target, key) { decorator(target, key, paramIndex); }
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.AdminFinanceController = void 0;
const public_decorator_1 = require("../../../common/decorators/public.decorator");
const idempotency_decorator_1 = require("../../../common/decorators/idempotency.decorator");
const common_1 = require("@nestjs/common");
const parse_id_pipe_1 = require("../../../common/pipes/parse-id.pipe");
const parse_query_string_pipe_1 = require("../../../common/pipes/parse-query-string.pipe");
const date_util_1 = require("../../../common/utils/date.util");
const throttler_1 = require("@nestjs/throttler");
const swagger_1 = require("@nestjs/swagger");
const bull_1 = require("@nestjs/bull");
const admin_finance_service_1 = require("./admin-finance.service");
const reconciliation_service_1 = require("./reconciliation.service");
const reconciliation_processor_1 = require("./reconciliation.processor");
const finance_query_dto_1 = require("./dto/finance-query.dto");
const withdrawal_action_dto_1 = require("./dto/withdrawal-action.dto");
const jwt_admin_guard_1 = require("../../../common/guards/jwt-admin.guard");
const admin_roles_guard_1 = require("../../../common/guards/admin-roles.guard");
const admin_roles_decorator_1 = require("../../../common/decorators/admin-roles.decorator");
const current_admin_decorator_1 = require("../../../common/decorators/current-admin.decorator");
const pagination_dto_1 = require("../../../common/dto/pagination.dto");
const user_throttle_guard_1 = require("../../../common/guards/user-throttle.guard");
let AdminFinanceController = class AdminFinanceController {
    constructor(service, reconciliationService, reconciliationQueue) {
        this.service = service;
        this.reconciliationService = reconciliationService;
        this.reconciliationQueue = reconciliationQueue;
    }
    listTransactions(query) {
        return this.service.listTransactions(query);
    }
    getTransactionDetail(txId, adminId, req) {
        return this.service.getTransactionDetail(txId, adminId, req.ip || 'unknown');
    }
    getFinancialSummary() {
        return this.service.getFinancialSummary();
    }
    listPendingWithdrawals(query, adminId, req) {
        return this.service.listPendingWithdrawals(query.page, query.limit, adminId, req.ip || 'unknown');
    }
    approveWithdrawal(txId, dto, adminId, req) {
        return this.service.approveWithdrawal(txId, dto, adminId, req.ip || 'unknown');
    }
    rejectWithdrawal(txId, dto, adminId, req) {
        return this.service.rejectWithdrawal(txId, dto, adminId, req.ip || 'unknown');
    }
    getEscrowSummary() {
        return this.service.getEscrowSummary();
    }
    getRevenue() {
        return this.service.getRevenue();
    }
    async reconcileUser(userId, adminId, req) {
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
    async reconcileAll(adminId) {
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
    async getReconcileJobStatus(jobId) {
        const job = await this.reconciliationQueue.getJob(jobId);
        if (!job) {
            throw new common_1.BadRequestException({ code: 'NOT_FOUND', message: 'Reconciliation job not found' });
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
    getAuditTrail(userId, from, to) {
        if (!from || !to) {
            throw new common_1.BadRequestException({ code: 'INVALID_DATE_RANGE', message: 'from and to query parameters are required' });
        }
        const fromDate = (0, date_util_1.parseDateBoundaryWIB)(from, 'start');
        const toDate = (0, date_util_1.parseDateBoundaryWIB)(to, 'end');
        if (!fromDate || !toDate) {
            throw new common_1.BadRequestException({ code: 'INVALID_DATE_FORMAT', message: 'from and to must be valid ISO date strings' });
        }
        if (fromDate > toDate) {
            throw new common_1.BadRequestException({ code: 'INVALID_DATE_RANGE', message: 'from must be before or equal to to' });
        }
        return this.reconciliationService.getFinancialAuditTrail(userId, from, to);
    }
};
exports.AdminFinanceController = AdminFinanceController;
__decorate([
    (0, common_1.Get)('transactions'),
    (0, swagger_1.ApiOperation)({ summary: 'List all wallet transactions', description: 'Paginated list of all wallet transactions with optional filters.' }),
    (0, swagger_1.ApiResponse)({ status: 200, description: 'Transactions list returned.' }),
    __param(0, (0, common_1.Query)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [finance_query_dto_1.FinanceTransactionQueryDto]),
    __metadata("design:returntype", Promise)
], AdminFinanceController.prototype, "listTransactions", null);
__decorate([
    (0, common_1.Get)('transactions/:txId'),
    (0, swagger_1.ApiOperation)({ summary: 'Get transaction detail', description: 'Returns full transaction detail including wallet owner and related entities.' }),
    (0, swagger_1.ApiResponse)({ status: 200, description: 'Transaction detail returned.' }),
    (0, swagger_1.ApiResponse)({ status: 404, description: 'Transaction not found.' }),
    __param(0, (0, common_1.Param)('txId', parse_id_pipe_1.ParseIdPipe)),
    __param(1, (0, current_admin_decorator_1.CurrentAdmin)('sub')),
    __param(2, (0, common_1.Req)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String, Object]),
    __metadata("design:returntype", Promise)
], AdminFinanceController.prototype, "getTransactionDetail", null);
__decorate([
    (0, common_1.Get)('summary'),
    (0, swagger_1.ApiOperation)({ summary: 'Financial summary', description: 'Aggregated financial summary: total topup, withdrawal, fees, escrow balance.' }),
    (0, swagger_1.ApiResponse)({ status: 200, description: 'Financial summary returned.' }),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", Promise)
], AdminFinanceController.prototype, "getFinancialSummary", null);
__decorate([
    (0, common_1.Get)('withdrawals/pending'),
    (0, swagger_1.ApiOperation)({ summary: 'List pending withdrawals', description: 'Paginated list of all withdrawals with pending status.' }),
    (0, swagger_1.ApiResponse)({ status: 200, description: 'Pending withdrawals list returned.' }),
    __param(0, (0, common_1.Query)()),
    __param(1, (0, current_admin_decorator_1.CurrentAdmin)('sub')),
    __param(2, (0, common_1.Req)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [pagination_dto_1.PaginationDto, String, Object]),
    __metadata("design:returntype", Promise)
], AdminFinanceController.prototype, "listPendingWithdrawals", null);
__decorate([
    (0, common_1.Post)('withdrawals/:txId/approve'),
    (0, common_1.UseGuards)(user_throttle_guard_1.UserThrottleGuard),
    (0, idempotency_decorator_1.Idempotency)(),
    (0, throttler_1.Throttle)({ default: { ttl: 60000, limit: 10 } }),
    (0, swagger_1.ApiOperation)({ summary: 'Approve pending withdrawal', description: 'Approve a pending withdrawal transaction and mark it as successful. Requires Idempotency-Key.' }),
    (0, swagger_1.ApiResponse)({ status: 200, description: 'Withdrawal approved.' }),
    (0, swagger_1.ApiResponse)({ status: 404, description: 'Transaction not found.' }),
    __param(0, (0, common_1.Param)('txId', parse_id_pipe_1.ParseIdPipe)),
    __param(1, (0, common_1.Body)()),
    __param(2, (0, current_admin_decorator_1.CurrentAdmin)('sub')),
    __param(3, (0, common_1.Req)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, withdrawal_action_dto_1.WithdrawalApproveDto, String, Object]),
    __metadata("design:returntype", Promise)
], AdminFinanceController.prototype, "approveWithdrawal", null);
__decorate([
    (0, common_1.Post)('withdrawals/:txId/reject'),
    (0, common_1.UseGuards)(user_throttle_guard_1.UserThrottleGuard),
    (0, idempotency_decorator_1.Idempotency)(),
    (0, throttler_1.Throttle)({ default: { ttl: 60000, limit: 10 } }),
    (0, swagger_1.ApiOperation)({ summary: 'Reject pending withdrawal', description: 'Reject a pending withdrawal transaction and refund the balance. Requires Idempotency-Key.' }),
    (0, swagger_1.ApiResponse)({ status: 200, description: 'Withdrawal rejected.' }),
    (0, swagger_1.ApiResponse)({ status: 404, description: 'Transaction not found.' }),
    __param(0, (0, common_1.Param)('txId', parse_id_pipe_1.ParseIdPipe)),
    __param(1, (0, common_1.Body)()),
    __param(2, (0, current_admin_decorator_1.CurrentAdmin)('sub')),
    __param(3, (0, common_1.Req)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, withdrawal_action_dto_1.WithdrawalRejectDto, String, Object]),
    __metadata("design:returntype", Promise)
], AdminFinanceController.prototype, "rejectWithdrawal", null);
__decorate([
    (0, common_1.Get)('escrow-summary'),
    (0, swagger_1.ApiOperation)({ summary: 'Active escrow totals', description: 'Returns aggregated escrow balance totals across all wallets.' }),
    (0, swagger_1.ApiResponse)({ status: 200, description: 'Escrow summary returned.' }),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", Promise)
], AdminFinanceController.prototype, "getEscrowSummary", null);
__decorate([
    (0, common_1.Get)('revenue'),
    (0, swagger_1.ApiOperation)({ summary: 'Platform revenue breakdown', description: 'Returns platform revenue breakdown from fees earned.' }),
    (0, swagger_1.ApiResponse)({ status: 200, description: 'Revenue data returned.' }),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", Promise)
], AdminFinanceController.prototype, "getRevenue", null);
__decorate([
    (0, throttler_1.Throttle)({ default: { ttl: 60000, limit: 5 } }),
    (0, common_1.UseGuards)(user_throttle_guard_1.UserThrottleGuard),
    (0, common_1.Post)('reconcile/user/:userId'),
    (0, admin_roles_decorator_1.AdminRoles)('SUPER_ADMIN'),
    (0, swagger_1.ApiOperation)({ summary: 'Reconcile single wallet', description: 'Recalculates expected balance from transactions and compares with actual balance.' }),
    (0, swagger_1.ApiResponse)({ status: 200, description: 'Reconciliation result returned.' }),
    (0, swagger_1.ApiResponse)({ status: 404, description: 'Wallet not found.' }),
    __param(0, (0, common_1.Param)('userId', parse_id_pipe_1.ParseIdPipe)),
    __param(1, (0, current_admin_decorator_1.CurrentAdmin)('sub')),
    __param(2, (0, common_1.Req)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String, Object]),
    __metadata("design:returntype", Promise)
], AdminFinanceController.prototype, "reconcileUser", null);
__decorate([
    (0, common_1.Post)('reconcile/all'),
    (0, common_1.UseGuards)(user_throttle_guard_1.UserThrottleGuard),
    (0, throttler_1.Throttle)({ default: { ttl: 3600000, limit: 1 } }),
    (0, admin_roles_decorator_1.AdminRoles)('SUPER_ADMIN'),
    (0, swagger_1.ApiOperation)({ summary: 'Reconcile all wallets (async)', description: 'Enqueues reconciliation for all wallets via background job. Returns job ID for status polling.' }),
    (0, common_1.HttpCode)(202),
    (0, swagger_1.ApiResponse)({ status: 202, description: 'Reconciliation job enqueued.' }),
    __param(0, (0, current_admin_decorator_1.CurrentAdmin)('sub')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", Promise)
], AdminFinanceController.prototype, "reconcileAll", null);
__decorate([
    (0, common_1.Get)('reconcile/status/:jobId'),
    (0, admin_roles_decorator_1.AdminRoles)('SUPER_ADMIN'),
    (0, swagger_1.ApiOperation)({ summary: 'Get reconciliation job status', description: 'Returns the status and result of an async reconciliation job.' }),
    (0, swagger_1.ApiResponse)({ status: 200, description: 'Job status returned.' }),
    __param(0, (0, common_1.Param)('jobId')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", Promise)
], AdminFinanceController.prototype, "getReconcileJobStatus", null);
__decorate([
    (0, common_1.Get)('audit-trail/:userId'),
    (0, admin_roles_decorator_1.AdminRoles)('SUPER_ADMIN'),
    (0, swagger_1.ApiOperation)({ summary: 'Financial audit trail', description: 'Returns all transactions in date range with running balance per row.' }),
    (0, swagger_1.ApiResponse)({ status: 200, description: 'Audit trail returned.' }),
    (0, swagger_1.ApiResponse)({ status: 404, description: 'Wallet not found.' }),
    __param(0, (0, common_1.Param)('userId', parse_id_pipe_1.ParseIdPipe)),
    __param(1, (0, common_1.Query)('from', new parse_query_string_pipe_1.ParseDateQueryPipe('from'))),
    __param(2, (0, common_1.Query)('to', new parse_query_string_pipe_1.ParseDateQueryPipe('to'))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String, String]),
    __metadata("design:returntype", Promise)
], AdminFinanceController.prototype, "getAuditTrail", null);
exports.AdminFinanceController = AdminFinanceController = __decorate([
    (0, swagger_1.ApiTags)('admin-finance'),
    (0, swagger_1.ApiBearerAuth)('access-token'),
    (0, common_1.UseGuards)(jwt_admin_guard_1.JwtAdminGuard, admin_roles_guard_1.AdminRolesGuard),
    (0, admin_roles_decorator_1.AdminRoles)('FINANCE_ADMIN', 'SUPER_ADMIN'),
    (0, public_decorator_1.AdminRoute)(),
    (0, common_1.Controller)('admin/finance'),
    __param(2, (0, bull_1.InjectQueue)(reconciliation_processor_1.RECONCILIATION_QUEUE)),
    __metadata("design:paramtypes", [admin_finance_service_1.AdminFinanceService,
        reconciliation_service_1.ReconciliationService, Object])
], AdminFinanceController);
