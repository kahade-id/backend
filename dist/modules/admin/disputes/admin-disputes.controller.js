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
exports.AdminDisputesController = void 0;
const public_decorator_1 = require("../../../common/decorators/public.decorator");
const idempotency_decorator_1 = require("../../../common/decorators/idempotency.decorator");
const common_1 = require("@nestjs/common");
const parse_id_pipe_1 = require("../../../common/pipes/parse-id.pipe");
const parse_query_string_pipe_1 = require("../../../common/pipes/parse-query-string.pipe");
const clamp_limit_pipe_1 = require("../../../common/pipes/clamp-limit.pipe");
const swagger_1 = require("@nestjs/swagger");
const admin_disputes_service_1 = require("./admin-disputes.service");
const dispute_decision_dto_1 = require("./dispute-decision.dto");
const dispute_list_query_dto_1 = require("./dto/dispute-list-query.dto");
const assign_dispute_dto_1 = require("./dto/assign-dispute.dto");
const send_dispute_message_dto_1 = require("./dto/send-dispute-message.dto");
const jwt_admin_guard_1 = require("../../../common/guards/jwt-admin.guard");
const admin_roles_guard_1 = require("../../../common/guards/admin-roles.guard");
const admin_roles_decorator_1 = require("../../../common/decorators/admin-roles.decorator");
const current_admin_decorator_1 = require("../../../common/decorators/current-admin.decorator");
const user_throttle_guard_1 = require("../../../common/guards/user-throttle.guard");
let AdminDisputesController = class AdminDisputesController {
    constructor(service) {
        this.service = service;
    }
    listDisputes(query) {
        return this.service.listDisputes(query.page, query.limit, query.status, query.search);
    }
    getDetail(disputeId, admin, req) {
        return this.service.getDisputeDetail(disputeId, admin.sub, req.ip || 'unknown');
    }
    getDisputeMessages(disputeId, admin, cursor, limit) {
        return this.service.getDisputeMessages(disputeId, admin.sub, cursor, limit ?? 50);
    }
    sendDisputeMessage(disputeId, admin, dto, req) {
        return this.service.sendDisputeMessage(disputeId, admin.sub, dto.content, req.ip || 'unknown');
    }
    assignAdmin(disputeId, admin, dto, req) {
        return this.service.assignAdmin(disputeId, admin.sub, dto.adminId, req.ip || 'unknown');
    }
    markUnderReview(disputeId, admin, req) {
        return this.service.markUnderReview(disputeId, admin.sub, req.ip || 'unknown');
    }
    resolve(disputeId, dto, admin, req) {
        return this.service.resolveDispute(disputeId, admin.sub, dto, req.ip || 'unknown');
    }
};
exports.AdminDisputesController = AdminDisputesController;
__decorate([
    (0, common_1.Get)(),
    (0, swagger_1.ApiOperation)({ summary: 'List disputes', description: 'Paginated list of all disputes with optional status filter.' }),
    (0, swagger_1.ApiResponse)({ status: 200, description: 'Disputes list returned.' }),
    __param(0, (0, common_1.Query)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [dispute_list_query_dto_1.DisputeListQueryDto]),
    __metadata("design:returntype", Promise)
], AdminDisputesController.prototype, "listDisputes", null);
__decorate([
    (0, common_1.Get)(':disputeId'),
    (0, swagger_1.ApiOperation)({ summary: 'Get dispute detail', description: 'Returns full dispute detail including order, evidence, and decision.' }),
    (0, swagger_1.ApiResponse)({ status: 200, description: 'Dispute detail returned.' }),
    (0, swagger_1.ApiResponse)({ status: 404, description: 'Dispute not found.' }),
    __param(0, (0, common_1.Param)('disputeId', parse_id_pipe_1.ParseIdPipe)),
    __param(1, (0, current_admin_decorator_1.CurrentAdmin)()),
    __param(2, (0, common_1.Req)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object, Object]),
    __metadata("design:returntype", Promise)
], AdminDisputesController.prototype, "getDetail", null);
__decorate([
    (0, common_1.Get)(':disputeId/messages'),
    (0, admin_roles_decorator_1.AdminRoles)('SUPER_ADMIN', 'DISPUTE_ADMIN'),
    (0, swagger_1.ApiOperation)({ summary: 'Get order chat messages for a dispute', description: 'Returns paginated chat messages from the order linked to the dispute. Only the assigned admin or SUPER_ADMIN can access.' }),
    (0, swagger_1.ApiResponse)({ status: 200, description: 'Messages returned.' }),
    (0, swagger_1.ApiResponse)({ status: 403, description: 'Not the assigned admin.' }),
    (0, swagger_1.ApiResponse)({ status: 404, description: 'Dispute not found.' }),
    __param(0, (0, common_1.Param)('disputeId', parse_id_pipe_1.ParseIdPipe)),
    __param(1, (0, current_admin_decorator_1.CurrentAdmin)()),
    __param(2, (0, common_1.Query)('cursor', new parse_query_string_pipe_1.ParseQueryStringPipe('cursor', 50))),
    __param(3, (0, common_1.Query)('limit', new common_1.DefaultValuePipe(50), new clamp_limit_pipe_1.ClampLimitPipe(100))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object, String, Number]),
    __metadata("design:returntype", Promise)
], AdminDisputesController.prototype, "getDisputeMessages", null);
__decorate([
    (0, common_1.Post)(':disputeId/messages'),
    (0, idempotency_decorator_1.Idempotency)(),
    (0, common_1.UseGuards)(user_throttle_guard_1.UserThrottleGuard),
    (0, admin_roles_decorator_1.AdminRoles)('SUPER_ADMIN', 'DISPUTE_ADMIN'),
    (0, swagger_1.ApiOperation)({ summary: 'Send a message to the dispute order chat', description: 'Allows the assigned admin or SUPER_ADMIN to send a message into the dispute order chat as a SYSTEM message.' }),
    (0, swagger_1.ApiResponse)({ status: 201, description: 'Message sent.' }),
    (0, swagger_1.ApiResponse)({ status: 403, description: 'Not the assigned admin.' }),
    (0, swagger_1.ApiResponse)({ status: 404, description: 'Dispute not found.' }),
    __param(0, (0, common_1.Param)('disputeId', parse_id_pipe_1.ParseIdPipe)),
    __param(1, (0, current_admin_decorator_1.CurrentAdmin)()),
    __param(2, (0, common_1.Body)()),
    __param(3, (0, common_1.Req)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object, send_dispute_message_dto_1.SendDisputeMessageDto, Object]),
    __metadata("design:returntype", Promise)
], AdminDisputesController.prototype, "sendDisputeMessage", null);
__decorate([
    (0, common_1.Post)(':disputeId/assign'),
    (0, idempotency_decorator_1.Idempotency)(),
    (0, common_1.UseGuards)(user_throttle_guard_1.UserThrottleGuard),
    (0, admin_roles_decorator_1.AdminRoles)('SUPER_ADMIN', 'DISPUTE_ADMIN'),
    (0, swagger_1.ApiOperation)({ summary: 'Assign admin to dispute', description: 'Assigns an admin to a dispute. DISPUTE_ADMIN role: self-assignment only. SUPER_ADMIN role: can assign any admin by providing adminId in the body. Requires Idempotency-Key.' }),
    (0, swagger_1.ApiResponse)({ status: 200, description: 'Admin assigned, dispute status set to ASSIGNED.' }),
    (0, swagger_1.ApiResponse)({ status: 404, description: 'Dispute not found.' }),
    __param(0, (0, common_1.Param)('disputeId', parse_id_pipe_1.ParseIdPipe)),
    __param(1, (0, current_admin_decorator_1.CurrentAdmin)()),
    __param(2, (0, common_1.Body)()),
    __param(3, (0, common_1.Req)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object, assign_dispute_dto_1.AssignDisputeDto, Object]),
    __metadata("design:returntype", Promise)
], AdminDisputesController.prototype, "assignAdmin", null);
__decorate([
    (0, common_1.Post)(':disputeId/under-review'),
    (0, idempotency_decorator_1.Idempotency)(),
    (0, common_1.UseGuards)(user_throttle_guard_1.UserThrottleGuard),
    (0, admin_roles_decorator_1.AdminRoles)('SUPER_ADMIN', 'DISPUTE_ADMIN'),
    (0, swagger_1.ApiOperation)({ summary: 'Begin active review', description: 'Transitions dispute from ASSIGNED to UNDER_REVIEW. Required before resolving.' }),
    (0, swagger_1.ApiResponse)({ status: 201, description: 'Dispute status set to UNDER_REVIEW.' }),
    (0, swagger_1.ApiResponse)({ status: 400, description: 'Dispute is not in ASSIGNED status or admin is not the assigned admin.' }),
    (0, swagger_1.ApiResponse)({ status: 404, description: 'Dispute not found.' }),
    __param(0, (0, common_1.Param)('disputeId', parse_id_pipe_1.ParseIdPipe)),
    __param(1, (0, current_admin_decorator_1.CurrentAdmin)()),
    __param(2, (0, common_1.Req)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object, Object]),
    __metadata("design:returntype", Promise)
], AdminDisputesController.prototype, "markUnderReview", null);
__decorate([
    (0, common_1.Post)(':disputeId/resolve'),
    (0, idempotency_decorator_1.Idempotency)(),
    (0, common_1.UseGuards)(user_throttle_guard_1.UserThrottleGuard),
    (0, admin_roles_decorator_1.AdminRoles)('SUPER_ADMIN', 'DISPUTE_ADMIN'),
    (0, swagger_1.ApiOperation)({ summary: 'Resolve dispute', description: 'Creates a DisputeDecision record with FULL_BUYER, FULL_SELLER, or SPLIT decision type. Dispute must be in UNDER_REVIEW or ESCALATED status. Requires Idempotency-Key.' }),
    (0, swagger_1.ApiResponse)({ status: 201, description: 'Dispute resolved — DecisionRecord created and order status updated to COMPLETED.' }),
    (0, swagger_1.ApiResponse)({ status: 400, description: 'Invalid status or split percentages do not sum to 100.' }),
    (0, swagger_1.ApiResponse)({ status: 404, description: 'Dispute not found.' }),
    __param(0, (0, common_1.Param)('disputeId', parse_id_pipe_1.ParseIdPipe)),
    __param(1, (0, common_1.Body)()),
    __param(2, (0, current_admin_decorator_1.CurrentAdmin)()),
    __param(3, (0, common_1.Req)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, dispute_decision_dto_1.DisputeDecisionDto, Object, Object]),
    __metadata("design:returntype", Promise)
], AdminDisputesController.prototype, "resolve", null);
exports.AdminDisputesController = AdminDisputesController = __decorate([
    (0, swagger_1.ApiTags)('admin-disputes'),
    (0, swagger_1.ApiBearerAuth)('access-token'),
    (0, common_1.UseGuards)(jwt_admin_guard_1.JwtAdminGuard, admin_roles_guard_1.AdminRolesGuard),
    (0, admin_roles_decorator_1.AdminRoles)('SUPER_ADMIN', 'DISPUTE_ADMIN'),
    (0, public_decorator_1.AdminRoute)(),
    (0, common_1.Controller)('admin/disputes'),
    __metadata("design:paramtypes", [admin_disputes_service_1.AdminDisputesService])
], AdminDisputesController);
