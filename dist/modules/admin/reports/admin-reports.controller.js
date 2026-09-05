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
exports.AdminReportsController = void 0;
const public_decorator_1 = require("../../../common/decorators/public.decorator");
const common_1 = require("@nestjs/common");
const parse_id_pipe_1 = require("../../../common/pipes/parse-id.pipe");
const swagger_1 = require("@nestjs/swagger");
const admin_reports_service_1 = require("./admin-reports.service");
const jwt_admin_guard_1 = require("../../../common/guards/jwt-admin.guard");
const admin_roles_guard_1 = require("../../../common/guards/admin-roles.guard");
const admin_roles_decorator_1 = require("../../../common/decorators/admin-roles.decorator");
const client_1 = require("@prisma/client");
const current_admin_decorator_1 = require("../../../common/decorators/current-admin.decorator");
const report_query_dto_1 = require("./dto/report-query.dto");
const resolve_report_dto_1 = require("./dto/resolve-report.dto");
const user_throttle_guard_1 = require("../../../common/guards/user-throttle.guard");
const idempotency_decorator_1 = require("../../../common/decorators/idempotency.decorator");
let AdminReportsController = class AdminReportsController {
    constructor(service) {
        this.service = service;
    }
    listReports(query) {
        return this.service.listReports(query.page ?? 1, query.limit ?? 20, query.status, query.category);
    }
    getReportDetail(reportId) {
        return this.service.getReportDetail(reportId);
    }
    resolveReport(reportId, dto, admin, req) {
        return this.service.resolveReport(reportId, dto.resolution, admin.sub, req.ip ?? '', dto.resolveStatus);
    }
    dismissReport(reportId, admin, req) {
        return this.service.dismissReport(reportId, admin.sub, req.ip ?? '');
    }
};
exports.AdminReportsController = AdminReportsController;
__decorate([
    (0, common_1.Get)(),
    (0, swagger_1.ApiOperation)({ summary: 'List all user reports', description: 'Paginated list of user reports with optional status and category filters.' }),
    (0, swagger_1.ApiResponse)({ status: 200, description: 'Reports list returned.' }),
    __param(0, (0, common_1.Query)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [report_query_dto_1.ReportQueryDto]),
    __metadata("design:returntype", Promise)
], AdminReportsController.prototype, "listReports", null);
__decorate([
    (0, common_1.Get)(':reportId'),
    (0, swagger_1.ApiOperation)({ summary: 'Get report detail', description: 'Returns full report detail including reporter and target user info.' }),
    (0, swagger_1.ApiResponse)({ status: 200, description: 'Report detail returned.' }),
    (0, swagger_1.ApiResponse)({ status: 404, description: 'Report not found.' }),
    __param(0, (0, common_1.Param)('reportId', parse_id_pipe_1.ParseIdPipe)),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", Promise)
], AdminReportsController.prototype, "getReportDetail", null);
__decorate([
    (0, common_1.UseGuards)(user_throttle_guard_1.UserThrottleGuard),
    (0, idempotency_decorator_1.Idempotency)(),
    (0, common_1.Post)(':reportId/resolve'),
    (0, swagger_1.ApiOperation)({ summary: 'Resolve report', description: 'Resolve a user report with action taken.' }),
    (0, swagger_1.ApiResponse)({ status: 200, description: 'Report resolved.' }),
    (0, swagger_1.ApiResponse)({ status: 404, description: 'Report not found.' }),
    (0, swagger_1.ApiResponse)({ status: 400, description: 'Report already resolved or dismissed.' }),
    __param(0, (0, common_1.Param)('reportId', parse_id_pipe_1.ParseIdPipe)),
    __param(1, (0, common_1.Body)()),
    __param(2, (0, current_admin_decorator_1.CurrentAdmin)()),
    __param(3, (0, common_1.Req)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, resolve_report_dto_1.ResolveReportDto, Object, Object]),
    __metadata("design:returntype", Promise)
], AdminReportsController.prototype, "resolveReport", null);
__decorate([
    (0, common_1.UseGuards)(user_throttle_guard_1.UserThrottleGuard),
    (0, idempotency_decorator_1.Idempotency)(),
    (0, common_1.Post)(':reportId/dismiss'),
    (0, swagger_1.ApiOperation)({ summary: 'Dismiss report', description: 'Dismiss a user report without action.' }),
    (0, swagger_1.ApiResponse)({ status: 200, description: 'Report dismissed.' }),
    (0, swagger_1.ApiResponse)({ status: 404, description: 'Report not found.' }),
    (0, swagger_1.ApiResponse)({ status: 400, description: 'Report already resolved or dismissed.' }),
    __param(0, (0, common_1.Param)('reportId', parse_id_pipe_1.ParseIdPipe)),
    __param(1, (0, current_admin_decorator_1.CurrentAdmin)()),
    __param(2, (0, common_1.Req)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object, Object]),
    __metadata("design:returntype", Promise)
], AdminReportsController.prototype, "dismissReport", null);
exports.AdminReportsController = AdminReportsController = __decorate([
    (0, swagger_1.ApiTags)('admin-reports'),
    (0, swagger_1.ApiBearerAuth)('access-token'),
    (0, common_1.UseGuards)(jwt_admin_guard_1.JwtAdminGuard, admin_roles_guard_1.AdminRolesGuard),
    (0, admin_roles_decorator_1.AdminRoles)(client_1.AdminRole.SUPER_ADMIN, client_1.AdminRole.CUSTOMER_SUPPORT),
    (0, public_decorator_1.AdminRoute)(),
    (0, common_1.Controller)('admin/reports'),
    __metadata("design:paramtypes", [admin_reports_service_1.AdminReportsService])
], AdminReportsController);
