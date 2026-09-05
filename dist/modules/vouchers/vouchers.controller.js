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
exports.VouchersController = void 0;
const common_1 = require("@nestjs/common");
const swagger_1 = require("@nestjs/swagger");
const throttler_1 = require("@nestjs/throttler");
const vouchers_service_1 = require("./vouchers.service");
const current_user_decorator_1 = require("../../common/decorators/current-user.decorator");
const allow_response_fields_decorator_1 = require("../../common/decorators/allow-response-fields.decorator");
const validate_voucher_dto_1 = require("./dto/validate-voucher.dto");
const pagination_dto_1 = require("../../common/dto/pagination.dto");
const list_vouchers_dto_1 = require("./dto/list-vouchers.dto");
const user_throttle_guard_1 = require("../../common/guards/user-throttle.guard");
let VouchersController = class VouchersController {
    constructor(vouchersService) {
        this.vouchersService = vouchersService;
    }
    async getAvailableVouchers(userId, query) {
        return this.vouchersService.getAvailableVouchers(userId, query.page, query.limit, query.applicableTo);
    }
    async validateVoucher(userId, dto) {
        return this.vouchersService.validateVoucher(userId, dto.code, dto.orderValue, dto.userRole);
    }
    async getMyUsage(userId, pagination) {
        return this.vouchersService.getMyUsageHistory(userId, pagination.page, pagination.limit);
    }
};
exports.VouchersController = VouchersController;
__decorate([
    (0, throttler_1.Throttle)({ default: { ttl: 60000, limit: 30 } }),
    (0, common_1.Get)('available'),
    (0, allow_response_fields_decorator_1.AllowResponseFields)('code'),
    __param(0, (0, current_user_decorator_1.CurrentUser)('sub')),
    __param(1, (0, common_1.Query)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, list_vouchers_dto_1.ListVouchersDto]),
    __metadata("design:returntype", Promise)
], VouchersController.prototype, "getAvailableVouchers", null);
__decorate([
    (0, common_1.UseGuards)(user_throttle_guard_1.UserThrottleGuard),
    (0, throttler_1.Throttle)({ default: { ttl: 60000, limit: 5 } }),
    (0, common_1.Post)('validate'),
    (0, common_1.HttpCode)(200),
    (0, allow_response_fields_decorator_1.AllowResponseFields)('code'),
    __param(0, (0, current_user_decorator_1.CurrentUser)('sub')),
    __param(1, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, validate_voucher_dto_1.ValidateVoucherDto]),
    __metadata("design:returntype", Promise)
], VouchersController.prototype, "validateVoucher", null);
__decorate([
    (0, throttler_1.Throttle)({ default: { ttl: 60000, limit: 30 } }),
    (0, common_1.Get)('my-usage'),
    (0, allow_response_fields_decorator_1.AllowResponseFields)('code'),
    __param(0, (0, current_user_decorator_1.CurrentUser)('sub')),
    __param(1, (0, common_1.Query)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, pagination_dto_1.PaginationDto]),
    __metadata("design:returntype", Promise)
], VouchersController.prototype, "getMyUsage", null);
exports.VouchersController = VouchersController = __decorate([
    (0, swagger_1.ApiTags)('vouchers'),
    (0, swagger_1.ApiBearerAuth)('access-token'),
    (0, common_1.Controller)('vouchers'),
    __metadata("design:paramtypes", [vouchers_service_1.VouchersService])
], VouchersController);
