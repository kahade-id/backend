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
exports.AdminSystemController = void 0;
const public_decorator_1 = require("../../../common/decorators/public.decorator");
const common_1 = require("@nestjs/common");
const swagger_1 = require("@nestjs/swagger");
const admin_system_service_1 = require("./admin-system.service");
const update_config_dto_1 = require("./dto/update-config.dto");
const broadcast_dto_1 = require("./dto/broadcast.dto");
const audit_log_query_dto_1 = require("./dto/audit-log-query.dto");
const webhook_dead_letter_dto_1 = require("./dto/webhook-dead-letter.dto");
const idempotency_decorator_1 = require("../../../common/decorators/idempotency.decorator");
const throttler_1 = require("@nestjs/throttler");
const jwt_admin_guard_1 = require("../../../common/guards/jwt-admin.guard");
const admin_roles_guard_1 = require("../../../common/guards/admin-roles.guard");
const admin_roles_decorator_1 = require("../../../common/decorators/admin-roles.decorator");
const current_admin_decorator_1 = require("../../../common/decorators/current-admin.decorator");
const parse_id_pipe_1 = require("../../../common/pipes/parse-id.pipe");
const user_throttle_guard_1 = require("../../../common/guards/user-throttle.guard");
let AdminSystemController = class AdminSystemController {
    constructor(service) {
        this.service = service;
    }
    listConfigs() {
        return this.service.listConfigs();
    }
    updateConfig(key, dto, adminId, req) {
        return this.service.updateConfig(key, dto, adminId, req.ip ?? '');
    }
    listPendingConfigChanges() {
        return this.service.listPendingConfigChanges();
    }
    approveConfigChange(key, adminId, req) {
        return this.service.approveConfigChange(key, adminId, req.ip ?? '');
    }
    rejectConfigChange(key, adminId, req) {
        return this.service.rejectConfigChange(key, adminId, req.ip ?? '');
    }
    listAuditLogs(query) {
        return this.service.listAuditLogs(query);
    }
    listWebhookLogs(query) {
        return this.service.listWebhookLogs(query);
    }
    retryDeadLetterWebhook(id, adminId, req) {
        return this.service.retryDeadLetterWebhook(id, adminId, req.ip ?? '');
    }
    resolveDeadLetterWebhook(id, dto, adminId, req) {
        return this.service.resolveDeadLetterWebhook(id, adminId, req.ip ?? '', dto.resolution);
    }
    sendBroadcast(dto, adminId, req) {
        return this.service.sendBroadcast(dto, adminId, req.ip ?? '');
    }
};
exports.AdminSystemController = AdminSystemController;
__decorate([
    (0, common_1.Get)('configs'),
    (0, swagger_1.ApiOperation)({ summary: 'List system configs' }),
    (0, swagger_1.ApiResponse)({ status: 200, description: 'System configs list returned.' }),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", Promise)
], AdminSystemController.prototype, "listConfigs", null);
__decorate([
    (0, common_1.Put)('configs/:key'),
    (0, common_1.UseGuards)(user_throttle_guard_1.UserThrottleGuard),
    (0, idempotency_decorator_1.Idempotency)(),
    (0, swagger_1.ApiOperation)({ summary: 'Update system config value', description: 'For financial configs (fee/commission related), the change is stored as pending and requires approval from a different admin.' }),
    (0, swagger_1.ApiResponse)({ status: 200, description: 'System config updated or pending approval.' }),
    (0, swagger_1.ApiResponse)({ status: 404, description: 'Config key not found.' }),
    __param(0, (0, common_1.Param)('key')),
    __param(1, (0, common_1.Body)()),
    __param(2, (0, current_admin_decorator_1.CurrentAdmin)('sub')),
    __param(3, (0, common_1.Req)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, update_config_dto_1.UpdateConfigDto, String, Object]),
    __metadata("design:returntype", Promise)
], AdminSystemController.prototype, "updateConfig", null);
__decorate([
    (0, common_1.Get)('configs/pending'),
    (0, swagger_1.ApiOperation)({ summary: 'List pending financial config changes awaiting approval' }),
    (0, swagger_1.ApiResponse)({ status: 200, description: 'Pending config changes list returned.' }),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", Promise)
], AdminSystemController.prototype, "listPendingConfigChanges", null);
__decorate([
    (0, common_1.Post)('configs/:key/approve'),
    (0, common_1.UseGuards)(user_throttle_guard_1.UserThrottleGuard),
    (0, idempotency_decorator_1.Idempotency)(),
    (0, swagger_1.ApiOperation)({ summary: 'Approve a pending financial config change', description: 'Must be a different admin than the one who proposed the change.' }),
    (0, swagger_1.ApiResponse)({ status: 200, description: 'Config change approved and applied.' }),
    (0, swagger_1.ApiResponse)({ status: 403, description: 'Cannot approve own change.' }),
    (0, swagger_1.ApiResponse)({ status: 404, description: 'No pending change found.' }),
    __param(0, (0, common_1.Param)('key')),
    __param(1, (0, current_admin_decorator_1.CurrentAdmin)('sub')),
    __param(2, (0, common_1.Req)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String, Object]),
    __metadata("design:returntype", Promise)
], AdminSystemController.prototype, "approveConfigChange", null);
__decorate([
    (0, common_1.Post)('configs/:key/reject'),
    (0, common_1.UseGuards)(user_throttle_guard_1.UserThrottleGuard),
    (0, idempotency_decorator_1.Idempotency)(),
    (0, swagger_1.ApiOperation)({ summary: 'Reject a pending financial config change' }),
    (0, swagger_1.ApiResponse)({ status: 200, description: 'Config change rejected.' }),
    (0, swagger_1.ApiResponse)({ status: 404, description: 'No pending change found.' }),
    __param(0, (0, common_1.Param)('key')),
    __param(1, (0, current_admin_decorator_1.CurrentAdmin)('sub')),
    __param(2, (0, common_1.Req)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String, Object]),
    __metadata("design:returntype", Promise)
], AdminSystemController.prototype, "rejectConfigChange", null);
__decorate([
    (0, common_1.Get)('audit-logs'),
    (0, swagger_1.ApiOperation)({ summary: 'List admin audit logs' }),
    (0, swagger_1.ApiResponse)({ status: 200, description: 'Audit logs list returned.' }),
    __param(0, (0, common_1.Query)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [audit_log_query_dto_1.AuditLogQueryDto]),
    __metadata("design:returntype", Promise)
], AdminSystemController.prototype, "listAuditLogs", null);
__decorate([
    (0, common_1.Get)('webhook-logs'),
    (0, swagger_1.ApiOperation)({ summary: 'List webhook logs' }),
    (0, swagger_1.ApiResponse)({ status: 200, description: 'Webhook logs list returned.' }),
    __param(0, (0, common_1.Query)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [audit_log_query_dto_1.WebhookLogQueryDto]),
    __metadata("design:returntype", Promise)
], AdminSystemController.prototype, "listWebhookLogs", null);
__decorate([
    (0, common_1.Post)('webhook-logs/:id/retry'),
    (0, common_1.UseGuards)(user_throttle_guard_1.UserThrottleGuard),
    (0, idempotency_decorator_1.Idempotency)(),
    (0, throttler_1.Throttle)({ default: { ttl: 60000, limit: 5 } }),
    (0, admin_roles_decorator_1.AdminRoles)('SUPER_ADMIN'),
    (0, swagger_1.ApiOperation)({ summary: 'Requeue dead-letter webhook', description: 'Resets a failed webhook to retryable state. Requires Idempotency-Key.' }),
    __param(0, (0, common_1.Param)('id', parse_id_pipe_1.ParseIdPipe)),
    __param(1, (0, current_admin_decorator_1.CurrentAdmin)('sub')),
    __param(2, (0, common_1.Req)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String, Object]),
    __metadata("design:returntype", Promise)
], AdminSystemController.prototype, "retryDeadLetterWebhook", null);
__decorate([
    (0, common_1.Post)('webhook-logs/:id/resolve'),
    (0, common_1.UseGuards)(user_throttle_guard_1.UserThrottleGuard),
    (0, idempotency_decorator_1.Idempotency)(),
    (0, throttler_1.Throttle)({ default: { ttl: 60000, limit: 5 } }),
    (0, admin_roles_decorator_1.AdminRoles)('SUPER_ADMIN'),
    (0, swagger_1.ApiOperation)({ summary: 'Resolve dead-letter webhook', description: 'Marks a dead-letter webhook as manually resolved and prevents automatic retry.' }),
    __param(0, (0, common_1.Param)('id', parse_id_pipe_1.ParseIdPipe)),
    __param(1, (0, common_1.Body)()),
    __param(2, (0, current_admin_decorator_1.CurrentAdmin)('sub')),
    __param(3, (0, common_1.Req)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, webhook_dead_letter_dto_1.WebhookDeadLetterResolutionDto, String, Object]),
    __metadata("design:returntype", Promise)
], AdminSystemController.prototype, "resolveDeadLetterWebhook", null);
__decorate([
    (0, common_1.Post)('broadcast'),
    (0, common_1.UseGuards)(user_throttle_guard_1.UserThrottleGuard),
    (0, idempotency_decorator_1.Idempotency)(),
    (0, swagger_1.ApiOperation)({ summary: 'Send broadcast notification', description: 'Sends a broadcast notification to users based on target audience filter.' }),
    (0, swagger_1.ApiResponse)({ status: 201, description: 'Broadcast sent successfully.' }),
    __param(0, (0, common_1.Body)()),
    __param(1, (0, current_admin_decorator_1.CurrentAdmin)('sub')),
    __param(2, (0, common_1.Req)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [broadcast_dto_1.BroadcastDto, String, Object]),
    __metadata("design:returntype", Promise)
], AdminSystemController.prototype, "sendBroadcast", null);
exports.AdminSystemController = AdminSystemController = __decorate([
    (0, swagger_1.ApiTags)('admin-system'),
    (0, swagger_1.ApiBearerAuth)('access-token'),
    (0, common_1.UseGuards)(jwt_admin_guard_1.JwtAdminGuard, admin_roles_guard_1.AdminRolesGuard),
    (0, admin_roles_decorator_1.AdminRoles)('SUPER_ADMIN'),
    (0, public_decorator_1.AdminRoute)(),
    (0, common_1.Controller)('admin/system'),
    __metadata("design:paramtypes", [admin_system_service_1.AdminSystemService])
], AdminSystemController);
