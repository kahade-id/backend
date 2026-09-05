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
exports.AdminSubscriptionsController = void 0;
const public_decorator_1 = require("../../../common/decorators/public.decorator");
const common_1 = require("@nestjs/common");
const parse_id_pipe_1 = require("../../../common/pipes/parse-id.pipe");
const swagger_1 = require("@nestjs/swagger");
const admin_subscriptions_service_1 = require("./admin-subscriptions.service");
const subscription_list_query_dto_1 = require("./dto/subscription-list-query.dto");
const jwt_admin_guard_1 = require("../../../common/guards/jwt-admin.guard");
const admin_roles_guard_1 = require("../../../common/guards/admin-roles.guard");
const admin_roles_decorator_1 = require("../../../common/decorators/admin-roles.decorator");
const current_admin_decorator_1 = require("../../../common/decorators/current-admin.decorator");
const user_throttle_guard_1 = require("../../../common/guards/user-throttle.guard");
let AdminSubscriptionsController = class AdminSubscriptionsController {
    constructor(service) {
        this.service = service;
    }
    listSubscriptions(query) {
        return this.service.listSubscriptions(query.page, query.limit, query.status, query.plan);
    }
    getSubscriptionDetail(subId) {
        return this.service.getSubscriptionDetail(subId);
    }
    forceCancelSubscription(subId, adminId, req) {
        return this.service.forceCancelSubscription(subId, adminId, req.ip ?? '');
    }
};
exports.AdminSubscriptionsController = AdminSubscriptionsController;
__decorate([
    (0, common_1.Get)(),
    (0, swagger_1.ApiOperation)({ summary: 'List all subscriptions' }),
    (0, swagger_1.ApiResponse)({ status: 200, description: 'Subscriptions list returned.' }),
    __param(0, (0, common_1.Query)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [subscription_list_query_dto_1.SubscriptionListQueryDto]),
    __metadata("design:returntype", Promise)
], AdminSubscriptionsController.prototype, "listSubscriptions", null);
__decorate([
    (0, common_1.Get)(':subId'),
    (0, swagger_1.ApiOperation)({ summary: 'Get subscription detail' }),
    (0, swagger_1.ApiResponse)({ status: 200, description: 'Subscription detail returned.' }),
    (0, swagger_1.ApiResponse)({ status: 404, description: 'Subscription not found.' }),
    __param(0, (0, common_1.Param)('subId', parse_id_pipe_1.ParseIdPipe)),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", Promise)
], AdminSubscriptionsController.prototype, "getSubscriptionDetail", null);
__decorate([
    (0, common_1.Post)(':subId/cancel'),
    (0, common_1.UseGuards)(user_throttle_guard_1.UserThrottleGuard),
    (0, swagger_1.ApiOperation)({ summary: 'Force cancel subscription' }),
    (0, swagger_1.ApiResponse)({ status: 200, description: 'Subscription cancelled.' }),
    (0, swagger_1.ApiResponse)({ status: 404, description: 'Subscription not found.' }),
    __param(0, (0, common_1.Param)('subId', parse_id_pipe_1.ParseIdPipe)),
    __param(1, (0, current_admin_decorator_1.CurrentAdmin)('sub')),
    __param(2, (0, common_1.Req)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String, Object]),
    __metadata("design:returntype", Promise)
], AdminSubscriptionsController.prototype, "forceCancelSubscription", null);
exports.AdminSubscriptionsController = AdminSubscriptionsController = __decorate([
    (0, swagger_1.ApiTags)('admin-subscriptions'),
    (0, swagger_1.ApiBearerAuth)('access-token'),
    (0, common_1.UseGuards)(jwt_admin_guard_1.JwtAdminGuard, admin_roles_guard_1.AdminRolesGuard),
    (0, admin_roles_decorator_1.AdminRoles)('SUPER_ADMIN', 'FINANCE_ADMIN'),
    (0, public_decorator_1.AdminRoute)(),
    (0, common_1.Controller)('admin/subscriptions'),
    __metadata("design:paramtypes", [admin_subscriptions_service_1.AdminSubscriptionsService])
], AdminSubscriptionsController);
