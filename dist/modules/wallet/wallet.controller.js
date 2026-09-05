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
exports.WalletController = void 0;
const common_1 = require("@nestjs/common");
const parse_id_pipe_1 = require("../../common/pipes/parse-id.pipe");
const clamp_limit_pipe_1 = require("../../common/pipes/clamp-limit.pipe");
const parse_query_string_pipe_1 = require("../../common/pipes/parse-query-string.pipe");
const swagger_1 = require("@nestjs/swagger");
const throttler_1 = require("@nestjs/throttler");
const wallet_service_1 = require("./wallet.service");
const export_service_1 = require("./export.service");
const current_user_decorator_1 = require("../../common/decorators/current-user.decorator");
const idempotency_decorator_1 = require("../../common/decorators/idempotency.decorator");
const public_decorator_1 = require("../../common/decorators/public.decorator");
const user_throttle_guard_1 = require("../../common/guards/user-throttle.guard");
const topup_dto_1 = require("./dto/topup.dto");
const withdraw_dto_1 = require("./dto/withdraw.dto");
const confirm_withdraw_otp_dto_1 = require("./dto/confirm-withdraw-otp.dto");
const resend_withdraw_otp_dto_1 = require("./dto/resend-withdraw-otp.dto");
const wallet_pin_dto_1 = require("./dto/wallet-pin.dto");
const export_csv_dto_1 = require("./dto/export-csv.dto");
const transfer_dto_1 = require("./dto/transfer.dto");
const date_util_1 = require("../../common/utils/date.util");
let WalletController = class WalletController {
    constructor(walletService, walletExportService) {
        this.walletService = walletService;
        this.walletExportService = walletExportService;
    }
    async getWallet(userId) {
        return this.walletService.getWallet(userId);
    }
    async getTransactions(userId, page, limit, type, from, to) {
        return this.walletService.getTransactions(userId, page, limit, type, from, to);
    }
    async getTransactionDetail(userId, txId) {
        return this.walletService.getTransactionDetail(userId, txId);
    }
    async topup(userId, dto) {
        return this.walletService.topup(userId, dto.amount, dto.method, dto.cardToken);
    }
    async withdraw(userId, dto, req) {
        return this.walletService.withdraw(userId, dto.amount, dto.bankAccountId, dto.pin, req.ip);
    }
    async transfer(userId, dto, req) {
        return this.walletService.transfer(userId, dto.recipientId, dto.amount, dto.pin, dto.note, req.ip);
    }
    async lookupTransferRecipient(userId, query) {
        if (!query || query.trim().length < 2) {
            return { user: null };
        }
        const user = await this.walletService.lookupTransferRecipient(query.trim(), userId);
        return { user };
    }
    async confirmWithdrawOtp(userId, dto) {
        return this.walletService.confirmWithdrawOtp(userId, dto.txId, dto.otp);
    }
    async resendWithdrawOtp(userId, dto, req) {
        return this.walletService.resendWithdrawOtp(userId, dto.txId, req.ip);
    }
    async cancelWithdraw(userId, txId) {
        return this.walletService.cancelPendingWithdrawal(userId, txId);
    }
    async getTopupStatus(userId, paymentTxId) {
        return this.walletService.getTopupStatus(userId, paymentTxId);
    }
    async getTopupHistory(userId, page, limit, from, to) {
        return this.walletService.getTransactions(userId, page, limit, 'TOP_UP', from, to);
    }
    async getWithdrawHistory(userId, page, limit, from, to) {
        return this.walletService.getTransactions(userId, page, limit, 'WITHDRAW', from, to);
    }
    async setPin(userId, dto, req) {
        return this.walletService.setPin(userId, dto.pin, dto.currentPin, dto.password, req.ip);
    }
    async verifyPin(userId, dto, req) {
        return this.walletService.verifyPin(userId, dto.pin, req.ip);
    }
    async getPaymentMethods() {
        return this.walletService.getPaymentMethods();
    }
    async exportTransactions(userId, query, res) {
        const format = query.format || 'csv';
        const dateStr = (0, date_util_1.formatWIBDate)();
        if (format === 'xlsx') {
            const buffer = await this.walletExportService.exportTransactionsXlsx(userId, query.from, query.to, query.types);
            const filename = `kahade_transactions_${dateStr}.xlsx`;
            res.set({
                'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
                'Content-Disposition': `attachment; filename="${filename}"`,
                'Content-Length': buffer.length.toString(),
            });
            res.send(buffer);
            return;
        }
        const filename = `kahade_transactions_${dateStr}.csv`;
        res.set({
            'Content-Type': 'text/csv; charset=utf-8',
            'Content-Disposition': `attachment; filename="${filename}"`,
            'Transfer-Encoding': 'chunked',
        });
        const found = await this.walletExportService.streamTransactionsCsv(userId, res, query.from, query.to, query.types);
        if (!found) {
            res.status(200);
        }
        res.end();
    }
    async exportCsv(userId, query) {
        const csv = await this.walletExportService.exportTransactionsCsv(userId, query.from, query.to, query.types);
        const filename = `kahade_transactions_${(0, date_util_1.formatWIBDate)()}.csv`;
        return { csv, filename };
    }
    async exportPdf(userId, query) {
        const html = await this.walletExportService.exportTransactionsHtml(userId, query.from, query.to);
        const filename = `kahade_report_${(0, date_util_1.formatWIBDate)()}.html`;
        return { html, filename };
    }
};
exports.WalletController = WalletController;
__decorate([
    (0, common_1.Get)(),
    __param(0, (0, current_user_decorator_1.CurrentUser)('sub')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", Promise)
], WalletController.prototype, "getWallet", null);
__decorate([
    (0, throttler_1.Throttle)({ default: { ttl: 60000, limit: 30 } }),
    (0, common_1.Get)('transactions'),
    __param(0, (0, current_user_decorator_1.CurrentUser)('sub')),
    __param(1, (0, common_1.Query)('page', new common_1.DefaultValuePipe(1), common_1.ParseIntPipe)),
    __param(2, (0, common_1.Query)('limit', new common_1.DefaultValuePipe(20), common_1.ParseIntPipe, new clamp_limit_pipe_1.ClampLimitPipe())),
    __param(3, (0, common_1.Query)('type', new parse_query_string_pipe_1.ParseQueryStringPipe('type', 50))),
    __param(4, (0, common_1.Query)('from', new parse_query_string_pipe_1.ParseDateQueryPipe('from'))),
    __param(5, (0, common_1.Query)('to', new parse_query_string_pipe_1.ParseDateQueryPipe('to'))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Number, Number, String, String, String]),
    __metadata("design:returntype", Promise)
], WalletController.prototype, "getTransactions", null);
__decorate([
    (0, common_1.Get)('transactions/:txId'),
    __param(0, (0, current_user_decorator_1.CurrentUser)('sub')),
    __param(1, (0, common_1.Param)('txId', parse_id_pipe_1.ParseIdPipe)),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String]),
    __metadata("design:returntype", Promise)
], WalletController.prototype, "getTransactionDetail", null);
__decorate([
    (0, common_1.Post)('topup'),
    (0, common_1.UseGuards)(user_throttle_guard_1.UserThrottleGuard),
    (0, throttler_1.Throttle)({ default: { ttl: 900000, limit: 10 } }),
    (0, idempotency_decorator_1.Idempotency)(),
    __param(0, (0, current_user_decorator_1.CurrentUser)('sub')),
    __param(1, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, topup_dto_1.TopupDto]),
    __metadata("design:returntype", Promise)
], WalletController.prototype, "topup", null);
__decorate([
    (0, common_1.Post)('withdraw'),
    (0, common_1.UseGuards)(user_throttle_guard_1.UserThrottleGuard),
    (0, throttler_1.Throttle)({ default: { ttl: 900000, limit: 5 } }),
    (0, idempotency_decorator_1.Idempotency)(),
    __param(0, (0, current_user_decorator_1.CurrentUser)('sub')),
    __param(1, (0, common_1.Body)()),
    __param(2, (0, common_1.Req)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, withdraw_dto_1.WithdrawDto, Object]),
    __metadata("design:returntype", Promise)
], WalletController.prototype, "withdraw", null);
__decorate([
    (0, common_1.Post)('transfer'),
    (0, common_1.UseGuards)(user_throttle_guard_1.UserThrottleGuard),
    (0, throttler_1.Throttle)({ default: { ttl: 900000, limit: 10 } }),
    (0, idempotency_decorator_1.Idempotency)(),
    (0, swagger_1.ApiOperation)({ summary: 'Transfer funds to another KYC-verified user' }),
    __param(0, (0, current_user_decorator_1.CurrentUser)('sub')),
    __param(1, (0, common_1.Body)()),
    __param(2, (0, common_1.Req)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, transfer_dto_1.TransferDto, Object]),
    __metadata("design:returntype", Promise)
], WalletController.prototype, "transfer", null);
__decorate([
    (0, common_1.Get)('transfer/lookup'),
    (0, swagger_1.ApiOperation)({ summary: 'Lookup a user for transfer by username or userId' }),
    (0, throttler_1.Throttle)({ default: { ttl: 60000, limit: 10 } }),
    __param(0, (0, current_user_decorator_1.CurrentUser)('sub')),
    __param(1, (0, common_1.Query)('q')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String]),
    __metadata("design:returntype", Promise)
], WalletController.prototype, "lookupTransferRecipient", null);
__decorate([
    (0, common_1.Post)('withdraw/confirm-otp'),
    (0, common_1.UseGuards)(user_throttle_guard_1.UserThrottleGuard),
    (0, throttler_1.Throttle)({ default: { ttl: 900000, limit: 5 } }),
    (0, idempotency_decorator_1.Idempotency)(),
    __param(0, (0, current_user_decorator_1.CurrentUser)('sub')),
    __param(1, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, confirm_withdraw_otp_dto_1.ConfirmWithdrawOtpDto]),
    __metadata("design:returntype", Promise)
], WalletController.prototype, "confirmWithdrawOtp", null);
__decorate([
    (0, common_1.Post)('withdraw/resend-otp'),
    (0, common_1.HttpCode)(200),
    (0, swagger_1.ApiOperation)({ summary: 'Resend OTP for pending withdrawal (60s cooldown)' }),
    (0, common_1.UseGuards)(user_throttle_guard_1.UserThrottleGuard),
    (0, throttler_1.Throttle)({ default: { ttl: 900000, limit: 5 } }),
    (0, idempotency_decorator_1.Idempotency)(),
    __param(0, (0, current_user_decorator_1.CurrentUser)('sub')),
    __param(1, (0, common_1.Body)()),
    __param(2, (0, common_1.Req)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, resend_withdraw_otp_dto_1.ResendWithdrawOtpDto, Object]),
    __metadata("design:returntype", Promise)
], WalletController.prototype, "resendWithdrawOtp", null);
__decorate([
    (0, common_1.Post)('withdraw/cancel'),
    (0, common_1.HttpCode)(200),
    (0, swagger_1.ApiOperation)({ summary: 'Cancel a pending withdrawal (PENDING_OTP only)' }),
    (0, common_1.UseGuards)(user_throttle_guard_1.UserThrottleGuard),
    (0, throttler_1.Throttle)({ default: { ttl: 900000, limit: 10 } }),
    (0, idempotency_decorator_1.Idempotency)(),
    __param(0, (0, current_user_decorator_1.CurrentUser)('sub')),
    __param(1, (0, common_1.Body)('txId', parse_id_pipe_1.ParseIdPipe)),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String]),
    __metadata("design:returntype", Promise)
], WalletController.prototype, "cancelWithdraw", null);
__decorate([
    (0, common_1.Get)('topup-status/:paymentTxId'),
    (0, swagger_1.ApiOperation)({ summary: 'Poll the status of a previously initiated top-up' }),
    (0, throttler_1.Throttle)({ default: { ttl: 60000, limit: 60 } }),
    __param(0, (0, current_user_decorator_1.CurrentUser)('sub')),
    __param(1, (0, common_1.Param)('paymentTxId', parse_id_pipe_1.ParseIdPipe)),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String]),
    __metadata("design:returntype", Promise)
], WalletController.prototype, "getTopupStatus", null);
__decorate([
    (0, common_1.Get)('topup-history'),
    (0, swagger_1.ApiOperation)({ summary: 'Get topup transaction history' }),
    __param(0, (0, current_user_decorator_1.CurrentUser)('sub')),
    __param(1, (0, common_1.Query)('page', new common_1.DefaultValuePipe(1), common_1.ParseIntPipe)),
    __param(2, (0, common_1.Query)('limit', new common_1.DefaultValuePipe(20), common_1.ParseIntPipe, new clamp_limit_pipe_1.ClampLimitPipe())),
    __param(3, (0, common_1.Query)('from', new parse_query_string_pipe_1.ParseDateQueryPipe('from'))),
    __param(4, (0, common_1.Query)('to', new parse_query_string_pipe_1.ParseDateQueryPipe('to'))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Number, Number, String, String]),
    __metadata("design:returntype", Promise)
], WalletController.prototype, "getTopupHistory", null);
__decorate([
    (0, common_1.Get)('withdraw-history'),
    (0, swagger_1.ApiOperation)({ summary: 'Get withdrawal transaction history' }),
    __param(0, (0, current_user_decorator_1.CurrentUser)('sub')),
    __param(1, (0, common_1.Query)('page', new common_1.DefaultValuePipe(1), common_1.ParseIntPipe)),
    __param(2, (0, common_1.Query)('limit', new common_1.DefaultValuePipe(20), common_1.ParseIntPipe, new clamp_limit_pipe_1.ClampLimitPipe())),
    __param(3, (0, common_1.Query)('from', new parse_query_string_pipe_1.ParseDateQueryPipe('from'))),
    __param(4, (0, common_1.Query)('to', new parse_query_string_pipe_1.ParseDateQueryPipe('to'))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Number, Number, String, String]),
    __metadata("design:returntype", Promise)
], WalletController.prototype, "getWithdrawHistory", null);
__decorate([
    (0, common_1.Post)('set-pin'),
    (0, common_1.HttpCode)(200),
    (0, swagger_1.ApiOperation)({ summary: 'Set or change wallet PIN' }),
    (0, common_1.UseGuards)(user_throttle_guard_1.UserThrottleGuard),
    (0, throttler_1.Throttle)({ default: { ttl: 900000, limit: 5 } }),
    __param(0, (0, current_user_decorator_1.CurrentUser)('sub')),
    __param(1, (0, common_1.Body)()),
    __param(2, (0, common_1.Req)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, wallet_pin_dto_1.SetPinDto, Object]),
    __metadata("design:returntype", Promise)
], WalletController.prototype, "setPin", null);
__decorate([
    (0, common_1.Post)('verify-pin'),
    (0, common_1.HttpCode)(200),
    (0, swagger_1.ApiOperation)({ summary: 'Verify wallet PIN' }),
    (0, common_1.UseGuards)(user_throttle_guard_1.UserThrottleGuard),
    (0, throttler_1.Throttle)({ default: { ttl: 900000, limit: 5 } }),
    __param(0, (0, current_user_decorator_1.CurrentUser)('sub')),
    __param(1, (0, common_1.Body)()),
    __param(2, (0, common_1.Req)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, wallet_pin_dto_1.VerifyPinDto, Object]),
    __metadata("design:returntype", Promise)
], WalletController.prototype, "verifyPin", null);
__decorate([
    (0, public_decorator_1.Public)(),
    (0, common_1.Get)('payment-methods'),
    (0, swagger_1.ApiOperation)({ summary: 'List available payment methods with fees' }),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", Promise)
], WalletController.prototype, "getPaymentMethods", null);
__decorate([
    (0, throttler_1.Throttle)({ default: { ttl: 60000, limit: 5 } }),
    (0, common_1.Get)('export'),
    (0, swagger_1.ApiOperation)({ summary: 'Export wallet transactions as CSV or XLSX' }),
    __param(0, (0, current_user_decorator_1.CurrentUser)('sub')),
    __param(1, (0, common_1.Query)()),
    __param(2, (0, common_1.Res)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, export_csv_dto_1.ExportCsvDto, Object]),
    __metadata("design:returntype", Promise)
], WalletController.prototype, "exportTransactions", null);
__decorate([
    (0, throttler_1.Throttle)({ default: { ttl: 60000, limit: 5 } }),
    (0, common_1.Get)('export/csv'),
    (0, swagger_1.ApiOperation)({ summary: 'Export wallet transactions as CSV' }),
    __param(0, (0, current_user_decorator_1.CurrentUser)('sub')),
    __param(1, (0, common_1.Query)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, export_csv_dto_1.ExportCsvDto]),
    __metadata("design:returntype", Promise)
], WalletController.prototype, "exportCsv", null);
__decorate([
    (0, throttler_1.Throttle)({ default: { ttl: 60000, limit: 5 } }),
    (0, common_1.Get)('export/pdf'),
    (0, swagger_1.ApiOperation)({ summary: 'Export wallet transactions as printable HTML report' }),
    __param(0, (0, current_user_decorator_1.CurrentUser)('sub')),
    __param(1, (0, common_1.Query)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, export_csv_dto_1.ExportCsvDto]),
    __metadata("design:returntype", Promise)
], WalletController.prototype, "exportPdf", null);
exports.WalletController = WalletController = __decorate([
    (0, swagger_1.ApiTags)('wallet'),
    (0, swagger_1.ApiBearerAuth)('access-token'),
    (0, common_1.Controller)('wallet'),
    __metadata("design:paramtypes", [wallet_service_1.WalletService,
        export_service_1.WalletExportService])
], WalletController);
