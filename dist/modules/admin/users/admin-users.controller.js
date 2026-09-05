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
exports.AdminUsersController = void 0;
const public_decorator_1 = require("../../../common/decorators/public.decorator");
const common_1 = require("@nestjs/common");
const parse_id_pipe_1 = require("../../../common/pipes/parse-id.pipe");
const swagger_1 = require("@nestjs/swagger");
const admin_users_service_1 = require("./admin-users.service");
const user_list_query_dto_1 = require("./dto/user-list-query.dto");
const user_order_query_dto_1 = require("./dto/user-order-query.dto");
const ban_user_dto_1 = require("./dto/ban-user.dto");
const jwt_admin_guard_1 = require("../../../common/guards/jwt-admin.guard");
const admin_roles_guard_1 = require("../../../common/guards/admin-roles.guard");
const admin_roles_decorator_1 = require("../../../common/decorators/admin-roles.decorator");
const current_admin_decorator_1 = require("../../../common/decorators/current-admin.decorator");
const wallet_adjust_dto_1 = require("./dto/wallet-adjust.dto");
const pagination_dto_1 = require("../../../common/dto/pagination.dto");
const idempotency_decorator_1 = require("../../../common/decorators/idempotency.decorator");
const user_throttle_guard_1 = require("../../../common/guards/user-throttle.guard");
let AdminUsersController = class AdminUsersController {
    constructor(service) {
        this.service = service;
    }
    listUsers(query) {
        return this.service.listUsers(query.page, query.limit, query.search, query.status, query.sortBy, query.sortOrder);
    }
    getUserDetail(userId, admin, req) {
        return this.service.getUserDetail(userId, admin.sub, req.ip || 'unknown');
    }
    getUserOrders(userId, query, admin, req) {
        return this.service.getUserOrders(userId, query.page, query.limit, query.status, admin.sub, req.ip || 'unknown');
    }
    getUserWallet(userId, admin, req) {
        return this.service.getUserWallet(userId, admin.sub, req.ip || 'unknown');
    }
    getUserSessions(userId, pagination, admin, req) {
        return this.service.getUserSessions(userId, pagination.page, pagination.limit, admin.sub, req.ip || 'unknown');
    }
    adjustWallet(userId, dto, admin, req) {
        return this.service.adjustWallet(userId, dto, admin.sub, req.ip || 'unknown');
    }
    getUserAuditLog(userId, pagination, admin, req) {
        return this.service.getUserAuditLog(userId, pagination.page, pagination.limit, admin.sub, req.ip || 'unknown');
    }
    resetUserPassword(userId, admin, req) {
        return this.service.resetUserPassword(userId, admin.sub, req.ip || 'unknown');
    }
    forceLogout(userId, admin, req) {
        return this.service.forceLogout(userId, admin.sub, req.ip || 'unknown');
    }
    revokeUserSession(userId, sessionId, admin, req) {
        return this.service.revokeUserSession(userId, sessionId, admin.sub, req.ip || 'unknown');
    }
    banUser(userId, dto, admin, req) {
        return this.service.banUser(userId, dto.reason, admin.sub, req.ip || 'unknown');
    }
    unbanUser(userId, admin, req) {
        return this.service.unbanUser(userId, admin.sub, req.ip || 'unknown');
    }
};
exports.AdminUsersController = AdminUsersController;
__decorate([
    (0, common_1.Get)(),
    (0, swagger_1.ApiOperation)({ summary: 'List users', description: 'Paginated list of all users with optional search and status filter.' }),
    (0, swagger_1.ApiResponse)({ status: 200, description: 'User list returned.' }),
    __param(0, (0, common_1.Query)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [user_list_query_dto_1.UserListQueryDto]),
    __metadata("design:returntype", Promise)
], AdminUsersController.prototype, "listUsers", null);
__decorate([
    (0, common_1.Get)(':userId'),
    (0, swagger_1.ApiOperation)({ summary: 'Get user detail', description: 'Returns full user detail including wallet and KYC history.' }),
    (0, swagger_1.ApiResponse)({ status: 200, description: 'User detail returned.' }),
    (0, swagger_1.ApiResponse)({ status: 404, description: 'User not found.' }),
    __param(0, (0, common_1.Param)('userId', parse_id_pipe_1.ParseIdPipe)),
    __param(1, (0, current_admin_decorator_1.CurrentAdmin)()),
    __param(2, (0, common_1.Req)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object, Object]),
    __metadata("design:returntype", Promise)
], AdminUsersController.prototype, "getUserDetail", null);
__decorate([
    (0, common_1.Get)(':userId/orders'),
    (0, swagger_1.ApiOperation)({ summary: 'List user orders', description: 'Paginated list of orders for a specific user (as buyer or seller).' }),
    (0, swagger_1.ApiResponse)({ status: 200, description: 'User orders returned.' }),
    (0, swagger_1.ApiResponse)({ status: 404, description: 'User not found.' }),
    __param(0, (0, common_1.Param)('userId', parse_id_pipe_1.ParseIdPipe)),
    __param(1, (0, common_1.Query)()),
    __param(2, (0, current_admin_decorator_1.CurrentAdmin)()),
    __param(3, (0, common_1.Req)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, user_order_query_dto_1.UserOrderQueryDto, Object, Object]),
    __metadata("design:returntype", Promise)
], AdminUsersController.prototype, "getUserOrders", null);
__decorate([
    (0, common_1.Get)(':userId/wallet'),
    (0, swagger_1.ApiOperation)({ summary: 'Get user wallet', description: 'Returns wallet details and recent transactions for a specific user.' }),
    (0, swagger_1.ApiResponse)({ status: 200, description: 'User wallet returned.' }),
    (0, swagger_1.ApiResponse)({ status: 404, description: 'User not found.' }),
    __param(0, (0, common_1.Param)('userId', parse_id_pipe_1.ParseIdPipe)),
    __param(1, (0, current_admin_decorator_1.CurrentAdmin)()),
    __param(2, (0, common_1.Req)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object, Object]),
    __metadata("design:returntype", Promise)
], AdminUsersController.prototype, "getUserWallet", null);
__decorate([
    (0, common_1.Get)(':userId/sessions'),
    (0, swagger_1.ApiOperation)({ summary: 'List user sessions', description: 'Returns active sessions for a specific user.' }),
    (0, swagger_1.ApiResponse)({ status: 200, description: 'User sessions returned.' }),
    (0, swagger_1.ApiResponse)({ status: 404, description: 'User not found.' }),
    __param(0, (0, common_1.Param)('userId', parse_id_pipe_1.ParseIdPipe)),
    __param(1, (0, common_1.Query)()),
    __param(2, (0, current_admin_decorator_1.CurrentAdmin)()),
    __param(3, (0, common_1.Req)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, pagination_dto_1.PaginationDto, Object, Object]),
    __metadata("design:returntype", Promise)
], AdminUsersController.prototype, "getUserSessions", null);
__decorate([
    (0, common_1.Post)(':userId/wallet/adjust'),
    (0, common_1.UseGuards)(user_throttle_guard_1.UserThrottleGuard),
    (0, admin_roles_decorator_1.AdminRoles)('SUPER_ADMIN'),
    (0, idempotency_decorator_1.Idempotency)(),
    (0, swagger_1.ApiOperation)({ summary: 'Adjust user wallet', description: 'Manual wallet credit or debit. SUPER_ADMIN only.' }),
    (0, swagger_1.ApiResponse)({ status: 200, description: 'Wallet adjusted.' }),
    (0, swagger_1.ApiResponse)({ status: 403, description: 'Insufficient admin role.' }),
    (0, swagger_1.ApiResponse)({ status: 404, description: 'User or wallet not found.' }),
    __param(0, (0, common_1.Param)('userId', parse_id_pipe_1.ParseIdPipe)),
    __param(1, (0, common_1.Body)()),
    __param(2, (0, current_admin_decorator_1.CurrentAdmin)()),
    __param(3, (0, common_1.Req)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, wallet_adjust_dto_1.WalletAdjustDto, Object, Object]),
    __metadata("design:returntype", Promise)
], AdminUsersController.prototype, "adjustWallet", null);
__decorate([
    (0, common_1.Get)(':userId/audit-log'),
    (0, swagger_1.ApiOperation)({ summary: 'User audit log', description: 'Returns the activity audit trail for a specific user.' }),
    (0, swagger_1.ApiResponse)({ status: 200, description: 'User audit log returned.' }),
    (0, swagger_1.ApiResponse)({ status: 404, description: 'User not found.' }),
    __param(0, (0, common_1.Param)('userId', parse_id_pipe_1.ParseIdPipe)),
    __param(1, (0, common_1.Query)()),
    __param(2, (0, current_admin_decorator_1.CurrentAdmin)()),
    __param(3, (0, common_1.Req)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, pagination_dto_1.PaginationDto, Object, Object]),
    __metadata("design:returntype", Promise)
], AdminUsersController.prototype, "getUserAuditLog", null);
__decorate([
    (0, common_1.Post)(':userId/reset-password'),
    (0, common_1.UseGuards)(user_throttle_guard_1.UserThrottleGuard),
    (0, admin_roles_decorator_1.AdminRoles)('SUPER_ADMIN'),
    (0, swagger_1.ApiOperation)({ summary: 'Trigger password reset email for user', description: 'Generates a password reset OTP and emails it to the user.' }),
    (0, swagger_1.ApiResponse)({ status: 200, description: 'Password reset email sent.' }),
    (0, swagger_1.ApiResponse)({ status: 404, description: 'User not found.' }),
    __param(0, (0, common_1.Param)('userId', parse_id_pipe_1.ParseIdPipe)),
    __param(1, (0, current_admin_decorator_1.CurrentAdmin)()),
    __param(2, (0, common_1.Req)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object, Object]),
    __metadata("design:returntype", Promise)
], AdminUsersController.prototype, "resetUserPassword", null);
__decorate([
    (0, common_1.Post)(':userId/force-logout'),
    (0, common_1.UseGuards)(user_throttle_guard_1.UserThrottleGuard),
    (0, admin_roles_decorator_1.AdminRoles)('SUPER_ADMIN'),
    (0, swagger_1.ApiOperation)({ summary: 'Force logout user', description: 'Revokes all active sessions for a user, forcing logout.' }),
    (0, swagger_1.ApiResponse)({ status: 200, description: 'User sessions revoked.' }),
    (0, swagger_1.ApiResponse)({ status: 404, description: 'User not found.' }),
    __param(0, (0, common_1.Param)('userId', parse_id_pipe_1.ParseIdPipe)),
    __param(1, (0, current_admin_decorator_1.CurrentAdmin)()),
    __param(2, (0, common_1.Req)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object, Object]),
    __metadata("design:returntype", Promise)
], AdminUsersController.prototype, "forceLogout", null);
__decorate([
    (0, common_1.Delete)(':userId/sessions/:sessionId'),
    (0, common_1.UseGuards)(user_throttle_guard_1.UserThrottleGuard),
    (0, admin_roles_decorator_1.AdminRoles)('SUPER_ADMIN', 'CUSTOMER_SUPPORT'),
    (0, swagger_1.ApiOperation)({ summary: 'Revoke a specific user session', description: 'Revokes one session by ID without affecting other active sessions.' }),
    (0, swagger_1.ApiResponse)({ status: 200, description: 'Session revoked.' }),
    (0, swagger_1.ApiResponse)({ status: 404, description: 'User or session not found.' }),
    __param(0, (0, common_1.Param)('userId', parse_id_pipe_1.ParseIdPipe)),
    __param(1, (0, common_1.Param)('sessionId', parse_id_pipe_1.ParseIdPipe)),
    __param(2, (0, current_admin_decorator_1.CurrentAdmin)()),
    __param(3, (0, common_1.Req)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String, Object, Object]),
    __metadata("design:returntype", Promise)
], AdminUsersController.prototype, "revokeUserSession", null);
__decorate([
    (0, common_1.Post)(':userId/ban'),
    (0, common_1.UseGuards)(user_throttle_guard_1.UserThrottleGuard),
    (0, admin_roles_decorator_1.AdminRoles)('SUPER_ADMIN'),
    (0, swagger_1.ApiOperation)({ summary: 'Ban user', description: 'Bans a user with a required reason. ADMIN and SUPER_ADMIN only.' }),
    (0, swagger_1.ApiResponse)({ status: 200, description: 'User banned.' }),
    (0, swagger_1.ApiResponse)({ status: 403, description: 'Insufficient admin role or user already banned.' }),
    (0, swagger_1.ApiResponse)({ status: 404, description: 'User not found.' }),
    __param(0, (0, common_1.Param)('userId', parse_id_pipe_1.ParseIdPipe)),
    __param(1, (0, common_1.Body)()),
    __param(2, (0, current_admin_decorator_1.CurrentAdmin)()),
    __param(3, (0, common_1.Req)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, ban_user_dto_1.BanUserDto, Object, Object]),
    __metadata("design:returntype", Promise)
], AdminUsersController.prototype, "banUser", null);
__decorate([
    (0, common_1.Post)(':userId/unban'),
    (0, common_1.UseGuards)(user_throttle_guard_1.UserThrottleGuard),
    (0, admin_roles_decorator_1.AdminRoles)('SUPER_ADMIN'),
    (0, swagger_1.ApiOperation)({ summary: 'Unban user', description: 'Removes a ban from a user. ADMIN and SUPER_ADMIN only.' }),
    (0, swagger_1.ApiResponse)({ status: 200, description: 'User unbanned.' }),
    (0, swagger_1.ApiResponse)({ status: 403, description: 'Insufficient admin role.' }),
    (0, swagger_1.ApiResponse)({ status: 404, description: 'User not found.' }),
    __param(0, (0, common_1.Param)('userId', parse_id_pipe_1.ParseIdPipe)),
    __param(1, (0, current_admin_decorator_1.CurrentAdmin)()),
    __param(2, (0, common_1.Req)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object, Object]),
    __metadata("design:returntype", Promise)
], AdminUsersController.prototype, "unbanUser", null);
exports.AdminUsersController = AdminUsersController = __decorate([
    (0, swagger_1.ApiTags)('admin-users'),
    (0, swagger_1.ApiBearerAuth)('access-token'),
    (0, common_1.UseGuards)(jwt_admin_guard_1.JwtAdminGuard, admin_roles_guard_1.AdminRolesGuard),
    (0, admin_roles_decorator_1.AdminRoles)('SUPER_ADMIN', 'CUSTOMER_SUPPORT'),
    (0, public_decorator_1.AdminRoute)(),
    (0, common_1.Controller)('admin/users'),
    __metadata("design:paramtypes", [admin_users_service_1.AdminUsersService])
], AdminUsersController);
