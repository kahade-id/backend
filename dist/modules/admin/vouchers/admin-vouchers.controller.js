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
exports.AdminVouchersController = void 0;
const public_decorator_1 = require("../../../common/decorators/public.decorator");
const common_1 = require("@nestjs/common");
const parse_id_pipe_1 = require("../../../common/pipes/parse-id.pipe");
const swagger_1 = require("@nestjs/swagger");
const admin_vouchers_service_1 = require("./admin-vouchers.service");
const create_voucher_dto_1 = require("./dto/create-voucher.dto");
const voucher_list_query_dto_1 = require("./dto/voucher-list-query.dto");
const jwt_admin_guard_1 = require("../../../common/guards/jwt-admin.guard");
const admin_roles_guard_1 = require("../../../common/guards/admin-roles.guard");
const admin_roles_decorator_1 = require("../../../common/decorators/admin-roles.decorator");
const current_admin_decorator_1 = require("../../../common/decorators/current-admin.decorator");
const user_throttle_guard_1 = require("../../../common/guards/user-throttle.guard");
let AdminVouchersController = class AdminVouchersController {
    constructor(service) {
        this.service = service;
    }
    listVouchers(query) {
        return this.service.listVouchers(query.page, query.limit, query.isActive);
    }
    getVoucherDetail(voucherId) {
        return this.service.getVoucherDetail(voucherId);
    }
    createVoucher(dto, adminId, req) {
        return this.service.createVoucher(adminId, dto, req.ip ?? 'unknown');
    }
    deactivateVoucher(voucherId, adminId, req) {
        return this.service.deactivateVoucher(voucherId, adminId, req.ip ?? 'unknown');
    }
};
exports.AdminVouchersController = AdminVouchersController;
__decorate([
    (0, common_1.Get)(),
    (0, swagger_1.ApiOperation)({ summary: 'List all vouchers' }),
    (0, swagger_1.ApiResponse)({ status: 200, description: 'Vouchers list returned.' }),
    __param(0, (0, common_1.Query)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [voucher_list_query_dto_1.VoucherListQueryDto]),
    __metadata("design:returntype", Promise)
], AdminVouchersController.prototype, "listVouchers", null);
__decorate([
    (0, common_1.Get)(':voucherId'),
    (0, swagger_1.ApiOperation)({ summary: 'Get voucher detail with usage stats' }),
    (0, swagger_1.ApiResponse)({ status: 200, description: 'Voucher detail returned.' }),
    (0, swagger_1.ApiResponse)({ status: 404, description: 'Voucher not found.' }),
    __param(0, (0, common_1.Param)('voucherId', parse_id_pipe_1.ParseIdPipe)),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", Promise)
], AdminVouchersController.prototype, "getVoucherDetail", null);
__decorate([
    (0, common_1.Post)(),
    (0, common_1.UseGuards)(user_throttle_guard_1.UserThrottleGuard),
    (0, swagger_1.ApiOperation)({ summary: 'Create new voucher' }),
    (0, swagger_1.ApiResponse)({ status: 201, description: 'Voucher created.' }),
    __param(0, (0, common_1.Body)()),
    __param(1, (0, current_admin_decorator_1.CurrentAdmin)('sub')),
    __param(2, (0, common_1.Req)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [create_voucher_dto_1.CreateVoucherDto, String, Object]),
    __metadata("design:returntype", Promise)
], AdminVouchersController.prototype, "createVoucher", null);
__decorate([
    (0, common_1.Post)(':voucherId/deactivate'),
    (0, common_1.UseGuards)(user_throttle_guard_1.UserThrottleGuard),
    (0, common_1.HttpCode)(200),
    (0, swagger_1.ApiOperation)({ summary: 'Deactivate voucher' }),
    (0, swagger_1.ApiResponse)({ status: 200, description: 'Voucher deactivated.' }),
    (0, swagger_1.ApiResponse)({ status: 404, description: 'Voucher not found.' }),
    __param(0, (0, common_1.Param)('voucherId', parse_id_pipe_1.ParseIdPipe)),
    __param(1, (0, current_admin_decorator_1.CurrentAdmin)('sub')),
    __param(2, (0, common_1.Req)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String, Object]),
    __metadata("design:returntype", Promise)
], AdminVouchersController.prototype, "deactivateVoucher", null);
exports.AdminVouchersController = AdminVouchersController = __decorate([
    (0, swagger_1.ApiTags)('admin-vouchers'),
    (0, swagger_1.ApiBearerAuth)('access-token'),
    (0, common_1.UseGuards)(jwt_admin_guard_1.JwtAdminGuard, admin_roles_guard_1.AdminRolesGuard),
    (0, admin_roles_decorator_1.AdminRoles)('SUPER_ADMIN', 'FINANCE_ADMIN'),
    (0, public_decorator_1.AdminRoute)(),
    (0, common_1.Controller)('admin/vouchers'),
    __metadata("design:paramtypes", [admin_vouchers_service_1.AdminVouchersService])
], AdminVouchersController);
