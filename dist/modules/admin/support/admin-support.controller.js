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
exports.AdminSupportController = void 0;
const public_decorator_1 = require("../../../common/decorators/public.decorator");
const common_1 = require("@nestjs/common");
const parse_id_pipe_1 = require("../../../common/pipes/parse-id.pipe");
const swagger_1 = require("@nestjs/swagger");
const admin_support_service_1 = require("./admin-support.service");
const jwt_admin_guard_1 = require("../../../common/guards/jwt-admin.guard");
const admin_roles_guard_1 = require("../../../common/guards/admin-roles.guard");
const admin_roles_decorator_1 = require("../../../common/decorators/admin-roles.decorator");
const client_1 = require("@prisma/client");
const current_admin_decorator_1 = require("../../../common/decorators/current-admin.decorator");
const admin_support_dto_1 = require("./dto/admin-support.dto");
const user_throttle_guard_1 = require("../../../common/guards/user-throttle.guard");
let AdminSupportController = class AdminSupportController {
    constructor(service) {
        this.service = service;
    }
    listTickets(query) {
        return this.service.listTickets(query.page ?? 1, query.limit ?? 20, query.status, query.category, query.search);
    }
    getDetail(ticketId) {
        return this.service.getTicketDetail(ticketId);
    }
    reply(ticketId, dto, admin, req) {
        return this.service.replyToTicket(ticketId, admin.sub, dto.message, req.ip ?? '');
    }
    updateStatus(ticketId, dto, admin, req) {
        return this.service.updateStatus(ticketId, dto.status, admin.sub, req.ip ?? '');
    }
};
exports.AdminSupportController = AdminSupportController;
__decorate([
    (0, common_1.Get)(),
    (0, swagger_1.ApiOperation)({ summary: 'List support tickets / feedback', description: 'Paginated list of all support tickets with optional status & category filters.' }),
    (0, swagger_1.ApiResponse)({ status: 200, description: 'Tickets list returned.' }),
    __param(0, (0, common_1.Query)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [admin_support_dto_1.AdminTicketQueryDto]),
    __metadata("design:returntype", Promise)
], AdminSupportController.prototype, "listTickets", null);
__decorate([
    (0, common_1.Get)(':ticketId'),
    (0, swagger_1.ApiOperation)({ summary: 'Get ticket detail with replies' }),
    (0, swagger_1.ApiResponse)({ status: 200, description: 'Ticket detail returned.' }),
    (0, swagger_1.ApiResponse)({ status: 404, description: 'Ticket not found.' }),
    __param(0, (0, common_1.Param)('ticketId', parse_id_pipe_1.ParseIdPipe)),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", Promise)
], AdminSupportController.prototype, "getDetail", null);
__decorate([
    (0, common_1.UseGuards)(user_throttle_guard_1.UserThrottleGuard),
    (0, common_1.Post)(':ticketId/reply'),
    (0, swagger_1.ApiOperation)({ summary: 'Reply to a ticket as admin' }),
    (0, swagger_1.ApiResponse)({ status: 201, description: 'Reply added.' }),
    (0, swagger_1.ApiResponse)({ status: 404, description: 'Ticket not found.' }),
    (0, swagger_1.ApiResponse)({ status: 400, description: 'Ticket already closed.' }),
    __param(0, (0, common_1.Param)('ticketId', parse_id_pipe_1.ParseIdPipe)),
    __param(1, (0, common_1.Body)()),
    __param(2, (0, current_admin_decorator_1.CurrentAdmin)()),
    __param(3, (0, common_1.Req)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, admin_support_dto_1.AdminTicketReplyDto, Object, Object]),
    __metadata("design:returntype", Promise)
], AdminSupportController.prototype, "reply", null);
__decorate([
    (0, common_1.UseGuards)(user_throttle_guard_1.UserThrottleGuard),
    (0, common_1.Patch)(':ticketId/status'),
    (0, swagger_1.ApiOperation)({ summary: 'Update ticket status' }),
    (0, swagger_1.ApiResponse)({ status: 200, description: 'Ticket status updated.' }),
    (0, swagger_1.ApiResponse)({ status: 404, description: 'Ticket not found.' }),
    __param(0, (0, common_1.Param)('ticketId', parse_id_pipe_1.ParseIdPipe)),
    __param(1, (0, common_1.Body)()),
    __param(2, (0, current_admin_decorator_1.CurrentAdmin)()),
    __param(3, (0, common_1.Req)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, admin_support_dto_1.AdminTicketStatusDto, Object, Object]),
    __metadata("design:returntype", Promise)
], AdminSupportController.prototype, "updateStatus", null);
exports.AdminSupportController = AdminSupportController = __decorate([
    (0, swagger_1.ApiTags)('admin-support'),
    (0, swagger_1.ApiBearerAuth)('access-token'),
    (0, common_1.UseGuards)(jwt_admin_guard_1.JwtAdminGuard, admin_roles_guard_1.AdminRolesGuard),
    (0, admin_roles_decorator_1.AdminRoles)(client_1.AdminRole.SUPER_ADMIN, client_1.AdminRole.CUSTOMER_SUPPORT),
    (0, public_decorator_1.AdminRoute)(),
    (0, common_1.Controller)('admin/support/tickets'),
    __metadata("design:paramtypes", [admin_support_service_1.AdminSupportService])
], AdminSupportController);
