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
var AdminAnalyticsController_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.AdminAnalyticsController = void 0;
const common_1 = require("@nestjs/common");
const swagger_1 = require("@nestjs/swagger");
const admin_analytics_service_1 = require("../admin-analytics.service");
const jwt_admin_guard_1 = require("../../../common/guards/jwt-admin.guard");
const admin_roles_guard_1 = require("../../../common/guards/admin-roles.guard");
const admin_roles_decorator_1 = require("../../../common/decorators/admin-roles.decorator");
const public_decorator_1 = require("../../../common/decorators/public.decorator");
const parse_query_string_pipe_1 = require("../../../common/pipes/parse-query-string.pipe");
const clamp_limit_pipe_1 = require("../../../common/pipes/clamp-limit.pipe");
const current_admin_decorator_1 = require("../../../common/decorators/current-admin.decorator");
function parseOptionalDate(value, field) {
    if (!value)
        return undefined;
    const date = new Date(value);
    if (isNaN(date.getTime())) {
        throw new common_1.BadRequestException(`${field} is not a valid date`);
    }
    return date;
}
let AdminAnalyticsController = AdminAnalyticsController_1 = class AdminAnalyticsController {
    constructor(analyticsService) {
        this.analyticsService = analyticsService;
        this.logger = new common_1.Logger(AdminAnalyticsController_1.name);
    }
    logAdminAccess(adminId, endpoint, params, req) {
        this.logger.log(JSON.stringify({
            event: 'ADMIN_READ_ACCESS',
            adminId,
            endpoint,
            params,
            ip: req.ip,
            requestId: req.requestId ?? req.headers['x-request-id'] ?? '-',
        }));
    }
    async getOverview(startDate, endDate, adminId, req) {
        this.logAdminAccess(adminId ?? 'unknown', 'analytics/overview', { startDate, endDate }, req);
        return this.analyticsService.getOverview(parseOptionalDate(startDate, 'startDate'), parseOptionalDate(endDate, 'endDate'));
    }
    async getOrderStats(groupBy, startDate, endDate, adminId, req) {
        this.logAdminAccess(adminId ?? 'unknown', 'analytics/orders', { groupBy, startDate, endDate }, req);
        return this.analyticsService.getOrderStats(parseOptionalDate(startDate, 'startDate'), parseOptionalDate(endDate, 'endDate'), groupBy);
    }
    async getTopUsers(limit, metric, adminId, req) {
        this.logAdminAccess(adminId ?? 'unknown', 'analytics/top-users', { limit, metric }, req);
        return this.analyticsService.getTopUsers(limit, metric);
    }
    async getUserGrowth(startDate, endDate, adminId, req) {
        this.logAdminAccess(adminId ?? 'unknown', 'analytics/user-growth', { startDate, endDate }, req);
        return this.analyticsService.getUserGrowth(parseOptionalDate(startDate, 'startDate'), parseOptionalDate(endDate, 'endDate'));
    }
};
exports.AdminAnalyticsController = AdminAnalyticsController;
__decorate([
    (0, common_1.Get)('overview'),
    (0, swagger_1.ApiOperation)({ summary: 'Get platform overview stats' }),
    __param(0, (0, common_1.Query)('startDate', new parse_query_string_pipe_1.ParseDateQueryPipe('startDate'))),
    __param(1, (0, common_1.Query)('endDate', new parse_query_string_pipe_1.ParseDateQueryPipe('endDate'))),
    __param(2, (0, current_admin_decorator_1.CurrentAdmin)('sub')),
    __param(3, (0, common_1.Req)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String, String, Object]),
    __metadata("design:returntype", Promise)
], AdminAnalyticsController.prototype, "getOverview", null);
__decorate([
    (0, common_1.Get)('orders'),
    (0, swagger_1.ApiOperation)({ summary: 'Get order statistics over time' }),
    __param(0, (0, common_1.Query)('groupBy', new common_1.DefaultValuePipe('day'), new parse_query_string_pipe_1.ParseEnumQueryPipe('groupBy', ['day', 'week', 'month']))),
    __param(1, (0, common_1.Query)('startDate', new parse_query_string_pipe_1.ParseDateQueryPipe('startDate'))),
    __param(2, (0, common_1.Query)('endDate', new parse_query_string_pipe_1.ParseDateQueryPipe('endDate'))),
    __param(3, (0, current_admin_decorator_1.CurrentAdmin)('sub')),
    __param(4, (0, common_1.Req)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String, String, String, Object]),
    __metadata("design:returntype", Promise)
], AdminAnalyticsController.prototype, "getOrderStats", null);
__decorate([
    (0, common_1.Get)('top-users'),
    (0, swagger_1.ApiOperation)({ summary: 'Get top users by metric' }),
    __param(0, (0, common_1.Query)('limit', new common_1.DefaultValuePipe(10), common_1.ParseIntPipe, new clamp_limit_pipe_1.ClampLimitPipe(100))),
    __param(1, (0, common_1.Query)('metric', new common_1.DefaultValuePipe('orders'), new parse_query_string_pipe_1.ParseEnumQueryPipe('metric', ['orders', 'volume', 'rating']))),
    __param(2, (0, current_admin_decorator_1.CurrentAdmin)('sub')),
    __param(3, (0, common_1.Req)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Number, String, String, Object]),
    __metadata("design:returntype", Promise)
], AdminAnalyticsController.prototype, "getTopUsers", null);
__decorate([
    (0, common_1.Get)('user-growth'),
    (0, swagger_1.ApiOperation)({ summary: 'Get user growth over time' }),
    __param(0, (0, common_1.Query)('startDate', new parse_query_string_pipe_1.ParseDateQueryPipe('startDate'))),
    __param(1, (0, common_1.Query)('endDate', new parse_query_string_pipe_1.ParseDateQueryPipe('endDate'))),
    __param(2, (0, current_admin_decorator_1.CurrentAdmin)('sub')),
    __param(3, (0, common_1.Req)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String, String, Object]),
    __metadata("design:returntype", Promise)
], AdminAnalyticsController.prototype, "getUserGrowth", null);
exports.AdminAnalyticsController = AdminAnalyticsController = AdminAnalyticsController_1 = __decorate([
    (0, swagger_1.ApiTags)('admin/analytics'),
    (0, swagger_1.ApiBearerAuth)('admin-token'),
    (0, common_1.UseGuards)(jwt_admin_guard_1.JwtAdminGuard, admin_roles_guard_1.AdminRolesGuard),
    (0, admin_roles_decorator_1.AdminRoles)('SUPER_ADMIN'),
    (0, public_decorator_1.AdminRoute)(),
    (0, common_1.Controller)('admin/analytics'),
    __metadata("design:paramtypes", [admin_analytics_service_1.AdminAnalyticsService])
], AdminAnalyticsController);
