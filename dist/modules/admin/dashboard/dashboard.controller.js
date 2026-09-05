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
exports.DashboardController = void 0;
const public_decorator_1 = require("../../../common/decorators/public.decorator");
const common_1 = require("@nestjs/common");
const swagger_1 = require("@nestjs/swagger");
const dashboard_service_1 = require("./dashboard.service");
const jwt_admin_guard_1 = require("../../../common/guards/jwt-admin.guard");
const admin_roles_guard_1 = require("../../../common/guards/admin-roles.guard");
const admin_roles_decorator_1 = require("../../../common/decorators/admin-roles.decorator");
const chart_query_dto_1 = require("./dto/chart-query.dto");
let DashboardController = class DashboardController {
    constructor(service) {
        this.service = service;
    }
    getSummary() {
        return this.service.getSummary();
    }
    getCharts(query) {
        return this.service.getCharts(query);
    }
    getRecentActivity() {
        return this.service.getRecentActivity();
    }
    getUserGrowth(query) {
        return this.service.getUserGrowth(query);
    }
    getOrderStats() {
        return this.service.getOrderStats();
    }
};
exports.DashboardController = DashboardController;
__decorate([
    (0, common_1.Get)('summary'),
    (0, swagger_1.ApiOperation)({ summary: 'Get dashboard summary', description: 'Returns aggregated stats: user counts, active/completed orders, open disputes, pending KYC, and total wallet balance.' }),
    (0, swagger_1.ApiResponse)({ status: 200, description: 'Dashboard summary returned.' }),
    (0, swagger_1.ApiResponse)({ status: 401, description: 'Invalid or expired admin token.' }),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", Promise)
], DashboardController.prototype, "getSummary", null);
__decorate([
    (0, common_1.Get)('charts'),
    (0, swagger_1.ApiOperation)({ summary: 'Get chart data', description: 'Returns time-series data for orders and revenue over the specified period.' }),
    (0, swagger_1.ApiResponse)({ status: 200, description: 'Chart data returned.' }),
    __param(0, (0, common_1.Query)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [chart_query_dto_1.ChartQueryDto]),
    __metadata("design:returntype", Promise)
], DashboardController.prototype, "getCharts", null);
__decorate([
    (0, common_1.Get)('recent-activity'),
    (0, swagger_1.ApiOperation)({ summary: 'Get recent admin activity', description: 'Returns the most recent admin audit log entries.' }),
    (0, swagger_1.ApiResponse)({ status: 200, description: 'Recent activity returned.' }),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", Promise)
], DashboardController.prototype, "getRecentActivity", null);
__decorate([
    (0, common_1.Get)('user-growth'),
    (0, swagger_1.ApiOperation)({ summary: 'Get user growth stats', description: 'Returns user registration statistics over the specified period.' }),
    (0, swagger_1.ApiResponse)({ status: 200, description: 'User growth data returned.' }),
    __param(0, (0, common_1.Query)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [chart_query_dto_1.ChartQueryDto]),
    __metadata("design:returntype", Promise)
], DashboardController.prototype, "getUserGrowth", null);
__decorate([
    (0, common_1.Get)('order-stats'),
    (0, swagger_1.ApiOperation)({ summary: 'Get order status distribution', description: 'Returns order counts grouped by status.' }),
    (0, swagger_1.ApiResponse)({ status: 200, description: 'Order stats returned.' }),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", Promise)
], DashboardController.prototype, "getOrderStats", null);
exports.DashboardController = DashboardController = __decorate([
    (0, swagger_1.ApiTags)('admin-dashboard'),
    (0, swagger_1.ApiBearerAuth)('access-token'),
    (0, common_1.UseGuards)(jwt_admin_guard_1.JwtAdminGuard, admin_roles_guard_1.AdminRolesGuard),
    (0, admin_roles_decorator_1.AdminRoles)('SUPER_ADMIN'),
    (0, public_decorator_1.AdminRoute)(),
    (0, common_1.Controller)('admin/dashboard'),
    __metadata("design:paramtypes", [dashboard_service_1.DashboardService])
], DashboardController);
