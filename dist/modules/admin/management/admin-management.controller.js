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
exports.AdminManagementController = void 0;
const public_decorator_1 = require("../../../common/decorators/public.decorator");
const common_1 = require("@nestjs/common");
const parse_id_pipe_1 = require("../../../common/pipes/parse-id.pipe");
const parse_query_string_pipe_1 = require("../../../common/pipes/parse-query-string.pipe");
const swagger_1 = require("@nestjs/swagger");
const admin_management_service_1 = require("./admin-management.service");
const create_admin_dto_1 = require("./dto/create-admin.dto");
const update_admin_dto_1 = require("./dto/update-admin.dto");
const jwt_admin_guard_1 = require("../../../common/guards/jwt-admin.guard");
const admin_roles_guard_1 = require("../../../common/guards/admin-roles.guard");
const admin_roles_decorator_1 = require("../../../common/decorators/admin-roles.decorator");
const current_admin_decorator_1 = require("../../../common/decorators/current-admin.decorator");
const pagination_dto_1 = require("../../../common/dto/pagination.dto");
const user_throttle_guard_1 = require("../../../common/guards/user-throttle.guard");
const idempotency_decorator_1 = require("../../../common/decorators/idempotency.decorator");
let AdminManagementController = class AdminManagementController {
    constructor(service) {
        this.service = service;
    }
    listAdmins(pagination, search) {
        return this.service.listAdmins(pagination.page, pagination.limit, search);
    }
    getAdmin(id) {
        return this.service.getAdmin(id);
    }
    createAdmin(dto, adminId, req) {
        return this.service.createAdmin(dto, adminId, req.ip ?? '');
    }
    updateAdmin(id, dto, adminId, req) {
        return this.service.updateAdmin(id, dto, adminId, req.ip ?? '');
    }
    resetAdmin2fa(id, adminId, req) {
        return this.service.resetAdmin2fa(id, adminId, req.ip ?? '');
    }
    unlockAdmin(id, adminId, req) {
        return this.service.unlockAdmin(id, adminId, req.ip ?? '');
    }
    deleteAdmin(id, adminId, req) {
        return this.service.deleteAdmin(id, adminId, req.ip ?? '');
    }
};
exports.AdminManagementController = AdminManagementController;
__decorate([
    (0, common_1.Get)(),
    (0, swagger_1.ApiOperation)({ summary: 'List all admin users' }),
    (0, swagger_1.ApiQuery)({ name: 'search', required: false, description: 'Search by name, email, or adminId' }),
    (0, swagger_1.ApiResponse)({ status: 200, description: 'Admin list returned.' }),
    __param(0, (0, common_1.Query)()),
    __param(1, (0, common_1.Query)('search', new parse_query_string_pipe_1.ParseQueryStringPipe('search', 100))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [pagination_dto_1.PaginationDto, String]),
    __metadata("design:returntype", Promise)
], AdminManagementController.prototype, "listAdmins", null);
__decorate([
    (0, common_1.Get)(':id'),
    (0, swagger_1.ApiOperation)({ summary: 'Get admin detail' }),
    (0, swagger_1.ApiResponse)({ status: 200, description: 'Admin detail returned.' }),
    (0, swagger_1.ApiResponse)({ status: 404, description: 'Admin not found.' }),
    __param(0, (0, common_1.Param)('id', parse_id_pipe_1.ParseIdPipe)),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", Promise)
], AdminManagementController.prototype, "getAdmin", null);
__decorate([
    (0, common_1.Post)(),
    (0, common_1.UseGuards)(user_throttle_guard_1.UserThrottleGuard),
    (0, idempotency_decorator_1.Idempotency)(),
    (0, swagger_1.ApiOperation)({ summary: 'Create a new admin user' }),
    (0, swagger_1.ApiResponse)({ status: 201, description: 'Admin created.' }),
    (0, swagger_1.ApiResponse)({ status: 409, description: 'Email already exists.' }),
    __param(0, (0, common_1.Body)()),
    __param(1, (0, current_admin_decorator_1.CurrentAdmin)('sub')),
    __param(2, (0, common_1.Req)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [create_admin_dto_1.CreateAdminDto, String, Object]),
    __metadata("design:returntype", Promise)
], AdminManagementController.prototype, "createAdmin", null);
__decorate([
    (0, common_1.Put)(':id'),
    (0, common_1.UseGuards)(user_throttle_guard_1.UserThrottleGuard),
    (0, idempotency_decorator_1.Idempotency)(),
    (0, swagger_1.ApiOperation)({ summary: 'Update admin user' }),
    (0, swagger_1.ApiResponse)({ status: 200, description: 'Admin updated.' }),
    (0, swagger_1.ApiResponse)({ status: 404, description: 'Admin not found.' }),
    __param(0, (0, common_1.Param)('id', parse_id_pipe_1.ParseIdPipe)),
    __param(1, (0, common_1.Body)()),
    __param(2, (0, current_admin_decorator_1.CurrentAdmin)('sub')),
    __param(3, (0, common_1.Req)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, update_admin_dto_1.UpdateAdminDto, String, Object]),
    __metadata("design:returntype", Promise)
], AdminManagementController.prototype, "updateAdmin", null);
__decorate([
    (0, common_1.Post)(':id/reset-2fa'),
    (0, common_1.UseGuards)(user_throttle_guard_1.UserThrottleGuard),
    (0, idempotency_decorator_1.Idempotency)(),
    (0, common_1.HttpCode)(common_1.HttpStatus.OK),
    (0, swagger_1.ApiOperation)({ summary: 'Reset admin 2FA' }),
    (0, swagger_1.ApiResponse)({ status: 200, description: '2FA reset successfully.' }),
    (0, swagger_1.ApiResponse)({ status: 404, description: 'Admin not found.' }),
    __param(0, (0, common_1.Param)('id', parse_id_pipe_1.ParseIdPipe)),
    __param(1, (0, current_admin_decorator_1.CurrentAdmin)('sub')),
    __param(2, (0, common_1.Req)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String, Object]),
    __metadata("design:returntype", Promise)
], AdminManagementController.prototype, "resetAdmin2fa", null);
__decorate([
    (0, common_1.Post)(':id/unlock'),
    (0, common_1.UseGuards)(user_throttle_guard_1.UserThrottleGuard),
    (0, idempotency_decorator_1.Idempotency)(),
    (0, common_1.HttpCode)(common_1.HttpStatus.OK),
    (0, swagger_1.ApiOperation)({ summary: 'Unlock locked admin account' }),
    (0, swagger_1.ApiResponse)({ status: 200, description: 'Admin unlocked.' }),
    (0, swagger_1.ApiResponse)({ status: 404, description: 'Admin not found.' }),
    __param(0, (0, common_1.Param)('id', parse_id_pipe_1.ParseIdPipe)),
    __param(1, (0, current_admin_decorator_1.CurrentAdmin)('sub')),
    __param(2, (0, common_1.Req)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String, Object]),
    __metadata("design:returntype", Promise)
], AdminManagementController.prototype, "unlockAdmin", null);
__decorate([
    (0, common_1.Delete)(':id'),
    (0, common_1.UseGuards)(user_throttle_guard_1.UserThrottleGuard),
    (0, idempotency_decorator_1.Idempotency)(),
    (0, swagger_1.ApiOperation)({ summary: 'Soft-delete admin user' }),
    (0, swagger_1.ApiResponse)({ status: 200, description: 'Admin deleted.' }),
    (0, swagger_1.ApiResponse)({ status: 404, description: 'Admin not found.' }),
    __param(0, (0, common_1.Param)('id', parse_id_pipe_1.ParseIdPipe)),
    __param(1, (0, current_admin_decorator_1.CurrentAdmin)('sub')),
    __param(2, (0, common_1.Req)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String, Object]),
    __metadata("design:returntype", Promise)
], AdminManagementController.prototype, "deleteAdmin", null);
exports.AdminManagementController = AdminManagementController = __decorate([
    (0, swagger_1.ApiTags)('admin-management'),
    (0, swagger_1.ApiBearerAuth)('access-token'),
    (0, common_1.UseGuards)(jwt_admin_guard_1.JwtAdminGuard, admin_roles_guard_1.AdminRolesGuard),
    (0, admin_roles_decorator_1.AdminRoles)('SUPER_ADMIN'),
    (0, public_decorator_1.AdminRoute)(),
    (0, common_1.Controller)('admin/management'),
    __metadata("design:paramtypes", [admin_management_service_1.AdminManagementService])
], AdminManagementController);
