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
exports.AdminBadgesController = void 0;
const public_decorator_1 = require("../../../common/decorators/public.decorator");
const common_1 = require("@nestjs/common");
const parse_id_pipe_1 = require("../../../common/pipes/parse-id.pipe");
const swagger_1 = require("@nestjs/swagger");
const admin_badges_service_1 = require("./admin-badges.service");
const create_badge_dto_1 = require("./dto/create-badge.dto");
const jwt_admin_guard_1 = require("../../../common/guards/jwt-admin.guard");
const admin_roles_guard_1 = require("../../../common/guards/admin-roles.guard");
const admin_roles_decorator_1 = require("../../../common/decorators/admin-roles.decorator");
const current_admin_decorator_1 = require("../../../common/decorators/current-admin.decorator");
const pagination_dto_1 = require("../../../common/dto/pagination.dto");
const user_throttle_guard_1 = require("../../../common/guards/user-throttle.guard");
let AdminBadgesController = class AdminBadgesController {
    constructor(service) {
        this.service = service;
    }
    listBadges(pagination) {
        return this.service.listBadges(pagination.page ?? 1, pagination.limit ?? 20);
    }
    getBadgeDetail(badgeId) {
        return this.service.getBadgeDetail(badgeId);
    }
    createBadge(dto, adminId, req) {
        return this.service.createBadge(adminId, dto, req.ip ?? '');
    }
    updateBadge(badgeId, dto, adminId, req) {
        return this.service.updateBadge(badgeId, dto, adminId, req.ip ?? '');
    }
    deleteBadge(badgeId, adminId, req) {
        return this.service.deleteBadge(badgeId, adminId, req.ip ?? '');
    }
    awardBadge(badgeId, userId, adminId, req) {
        return this.service.awardBadge(badgeId, userId, adminId, req.ip ?? '');
    }
    revokeBadge(badgeId, userId, adminId, req) {
        return this.service.revokeBadge(badgeId, userId, adminId, req.ip ?? '');
    }
};
exports.AdminBadgesController = AdminBadgesController;
__decorate([
    (0, common_1.Get)(),
    (0, swagger_1.ApiOperation)({ summary: 'List all badges' }),
    (0, swagger_1.ApiResponse)({ status: 200, description: 'Badges list returned.' }),
    __param(0, (0, common_1.Query)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [pagination_dto_1.PaginationDto]),
    __metadata("design:returntype", Promise)
], AdminBadgesController.prototype, "listBadges", null);
__decorate([
    (0, common_1.Get)(':badgeId'),
    (0, swagger_1.ApiOperation)({ summary: 'Get badge detail with holders' }),
    (0, swagger_1.ApiResponse)({ status: 200, description: 'Badge detail returned.' }),
    (0, swagger_1.ApiResponse)({ status: 404, description: 'Badge not found.' }),
    __param(0, (0, common_1.Param)('badgeId', parse_id_pipe_1.ParseIdPipe)),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", Promise)
], AdminBadgesController.prototype, "getBadgeDetail", null);
__decorate([
    (0, common_1.UseGuards)(user_throttle_guard_1.UserThrottleGuard),
    (0, common_1.Post)(),
    (0, swagger_1.ApiOperation)({ summary: 'Create a new badge' }),
    (0, swagger_1.ApiResponse)({ status: 201, description: 'Badge created.' }),
    __param(0, (0, common_1.Body)()),
    __param(1, (0, current_admin_decorator_1.CurrentAdmin)('sub')),
    __param(2, (0, common_1.Req)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [create_badge_dto_1.CreateBadgeDto, String, Object]),
    __metadata("design:returntype", Promise)
], AdminBadgesController.prototype, "createBadge", null);
__decorate([
    (0, common_1.UseGuards)(user_throttle_guard_1.UserThrottleGuard),
    (0, common_1.Put)(':badgeId'),
    (0, swagger_1.ApiOperation)({ summary: 'Update badge' }),
    (0, swagger_1.ApiResponse)({ status: 200, description: 'Badge updated.' }),
    (0, swagger_1.ApiResponse)({ status: 404, description: 'Badge not found.' }),
    __param(0, (0, common_1.Param)('badgeId', parse_id_pipe_1.ParseIdPipe)),
    __param(1, (0, common_1.Body)()),
    __param(2, (0, current_admin_decorator_1.CurrentAdmin)('sub')),
    __param(3, (0, common_1.Req)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, create_badge_dto_1.UpdateBadgeDto, String, Object]),
    __metadata("design:returntype", Promise)
], AdminBadgesController.prototype, "updateBadge", null);
__decorate([
    (0, common_1.UseGuards)(user_throttle_guard_1.UserThrottleGuard),
    (0, common_1.Delete)(':badgeId'),
    (0, swagger_1.ApiOperation)({ summary: 'Delete badge' }),
    (0, swagger_1.ApiResponse)({ status: 200, description: 'Badge deleted.' }),
    (0, swagger_1.ApiResponse)({ status: 404, description: 'Badge not found.' }),
    __param(0, (0, common_1.Param)('badgeId', parse_id_pipe_1.ParseIdPipe)),
    __param(1, (0, current_admin_decorator_1.CurrentAdmin)('sub')),
    __param(2, (0, common_1.Req)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String, Object]),
    __metadata("design:returntype", Promise)
], AdminBadgesController.prototype, "deleteBadge", null);
__decorate([
    (0, common_1.UseGuards)(user_throttle_guard_1.UserThrottleGuard),
    (0, common_1.Post)(':badgeId/award/:userId'),
    (0, common_1.HttpCode)(200),
    (0, swagger_1.ApiOperation)({ summary: 'Award badge to user' }),
    (0, swagger_1.ApiResponse)({ status: 200, description: 'Badge awarded.' }),
    (0, swagger_1.ApiResponse)({ status: 404, description: 'Badge or user not found.' }),
    (0, swagger_1.ApiResponse)({ status: 409, description: 'User already has this badge.' }),
    __param(0, (0, common_1.Param)('badgeId', parse_id_pipe_1.ParseIdPipe)),
    __param(1, (0, common_1.Param)('userId', parse_id_pipe_1.ParseIdPipe)),
    __param(2, (0, current_admin_decorator_1.CurrentAdmin)('sub')),
    __param(3, (0, common_1.Req)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String, String, Object]),
    __metadata("design:returntype", Promise)
], AdminBadgesController.prototype, "awardBadge", null);
__decorate([
    (0, common_1.UseGuards)(user_throttle_guard_1.UserThrottleGuard),
    (0, common_1.Delete)(':badgeId/revoke/:userId'),
    (0, swagger_1.ApiOperation)({ summary: 'Revoke badge from user' }),
    (0, swagger_1.ApiResponse)({ status: 200, description: 'Badge revoked.' }),
    (0, swagger_1.ApiResponse)({ status: 404, description: 'User badge not found.' }),
    __param(0, (0, common_1.Param)('badgeId', parse_id_pipe_1.ParseIdPipe)),
    __param(1, (0, common_1.Param)('userId', parse_id_pipe_1.ParseIdPipe)),
    __param(2, (0, current_admin_decorator_1.CurrentAdmin)('sub')),
    __param(3, (0, common_1.Req)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String, String, Object]),
    __metadata("design:returntype", Promise)
], AdminBadgesController.prototype, "revokeBadge", null);
exports.AdminBadgesController = AdminBadgesController = __decorate([
    (0, swagger_1.ApiTags)('admin-badges'),
    (0, swagger_1.ApiBearerAuth)('access-token'),
    (0, common_1.UseGuards)(jwt_admin_guard_1.JwtAdminGuard, admin_roles_guard_1.AdminRolesGuard),
    (0, admin_roles_decorator_1.AdminRoles)('SUPER_ADMIN'),
    (0, public_decorator_1.AdminRoute)(),
    (0, common_1.Controller)('admin/badges'),
    __metadata("design:paramtypes", [admin_badges_service_1.AdminBadgesService])
], AdminBadgesController);
