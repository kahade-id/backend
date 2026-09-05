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
exports.BankAccountsController = void 0;
const common_1 = require("@nestjs/common");
const parse_id_pipe_1 = require("../../common/pipes/parse-id.pipe");
const swagger_1 = require("@nestjs/swagger");
const throttler_1 = require("@nestjs/throttler");
const bank_accounts_service_1 = require("./bank-accounts.service");
const add_bank_account_dto_1 = require("./dto/add-bank-account.dto");
const jwt_auth_guard_1 = require("../../common/guards/jwt-auth.guard");
const phone_verified_guard_1 = require("../../common/guards/phone-verified.guard");
const current_user_decorator_1 = require("../../common/decorators/current-user.decorator");
const user_throttle_guard_1 = require("../../common/guards/user-throttle.guard");
const idempotency_decorator_1 = require("../../common/decorators/idempotency.decorator");
let BankAccountsController = class BankAccountsController {
    constructor(service) {
        this.service = service;
    }
    list(user) {
        return this.service.listBankAccounts(user.sub);
    }
    add(user, dto) {
        return this.service.addBankAccount(user.sub, dto.bankCode, dto.bankName, dto.accountNumber, dto.accountName);
    }
    setPrimary(user, id) {
        return this.service.setPrimaryBankAccount(user.sub, id);
    }
    delete(user, id) {
        return this.service.deleteBankAccount(user.sub, id);
    }
};
exports.BankAccountsController = BankAccountsController;
__decorate([
    (0, throttler_1.Throttle)({ default: { ttl: 60000, limit: 30 } }),
    (0, common_1.Get)(),
    __param(0, (0, current_user_decorator_1.CurrentUser)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", Promise)
], BankAccountsController.prototype, "list", null);
__decorate([
    (0, throttler_1.Throttle)({ default: { ttl: 3600000, limit: 10 } }),
    (0, common_1.UseGuards)(user_throttle_guard_1.UserThrottleGuard),
    (0, idempotency_decorator_1.Idempotency)(),
    (0, common_1.Post)(),
    __param(0, (0, current_user_decorator_1.CurrentUser)()),
    __param(1, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, add_bank_account_dto_1.AddBankAccountDto]),
    __metadata("design:returntype", Promise)
], BankAccountsController.prototype, "add", null);
__decorate([
    (0, throttler_1.Throttle)({ default: { ttl: 60000, limit: 10 } }),
    (0, common_1.UseGuards)(user_throttle_guard_1.UserThrottleGuard),
    (0, idempotency_decorator_1.Idempotency)(),
    (0, common_1.Post)(':id/set-primary'),
    (0, common_1.HttpCode)(200),
    __param(0, (0, current_user_decorator_1.CurrentUser)()),
    __param(1, (0, common_1.Param)('id', parse_id_pipe_1.ParseIdPipe)),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String]),
    __metadata("design:returntype", Promise)
], BankAccountsController.prototype, "setPrimary", null);
__decorate([
    (0, throttler_1.Throttle)({ default: { ttl: 60000, limit: 5 } }),
    (0, common_1.UseGuards)(user_throttle_guard_1.UserThrottleGuard),
    (0, idempotency_decorator_1.Idempotency)(),
    (0, common_1.Delete)(':id'),
    __param(0, (0, current_user_decorator_1.CurrentUser)()),
    __param(1, (0, common_1.Param)('id', parse_id_pipe_1.ParseIdPipe)),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String]),
    __metadata("design:returntype", Promise)
], BankAccountsController.prototype, "delete", null);
exports.BankAccountsController = BankAccountsController = __decorate([
    (0, swagger_1.ApiTags)('bank-accounts'),
    (0, swagger_1.ApiBearerAuth)('access-token'),
    (0, common_1.UseGuards)(jwt_auth_guard_1.JwtAuthGuard, phone_verified_guard_1.PhoneVerifiedGuard),
    (0, common_1.Controller)('bank-accounts'),
    __metadata("design:paramtypes", [bank_accounts_service_1.BankAccountsService])
], BankAccountsController);
