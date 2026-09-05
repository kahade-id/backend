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
exports.AdminOrdersController = void 0;
const public_decorator_1 = require("../../../common/decorators/public.decorator");
const common_1 = require("@nestjs/common");
const parse_id_pipe_1 = require("../../../common/pipes/parse-id.pipe");
const swagger_1 = require("@nestjs/swagger");
const admin_orders_service_1 = require("./admin-orders.service");
const admin_order_query_dto_1 = require("./dto/admin-order-query.dto");
const jwt_admin_guard_1 = require("../../../common/guards/jwt-admin.guard");
const admin_roles_guard_1 = require("../../../common/guards/admin-roles.guard");
const admin_roles_decorator_1 = require("../../../common/decorators/admin-roles.decorator");
const current_admin_decorator_1 = require("../../../common/decorators/current-admin.decorator");
const idempotency_decorator_1 = require("../../../common/decorators/idempotency.decorator");
const user_throttle_guard_1 = require("../../../common/guards/user-throttle.guard");
let AdminOrdersController = class AdminOrdersController {
    constructor(service) {
        this.service = service;
    }
    listOrders(query) {
        return this.service.listOrders(query);
    }
    getOrderDetail(orderId) {
        return this.service.getOrderDetail(orderId);
    }
    forceCancel(orderId, dto, adminId, req) {
        return this.service.forceCancel(orderId, adminId, dto, req.ip || 'unknown');
    }
    forceComplete(orderId, dto, adminId, req) {
        return this.service.forceComplete(orderId, adminId, dto, req.ip || 'unknown');
    }
};
exports.AdminOrdersController = AdminOrdersController;
__decorate([
    (0, common_1.Get)(),
    (0, swagger_1.ApiOperation)({ summary: 'List all orders', description: 'Paginated list of all orders with optional status and date range filters.' }),
    (0, swagger_1.ApiResponse)({ status: 200, description: 'Orders list returned.' }),
    __param(0, (0, common_1.Query)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [admin_order_query_dto_1.AdminOrderQueryDto]),
    __metadata("design:returntype", Promise)
], AdminOrdersController.prototype, "listOrders", null);
__decorate([
    (0, common_1.Get)(':orderId'),
    (0, swagger_1.ApiOperation)({ summary: 'Get order detail', description: 'Returns full order detail including participants, wallet transactions, and status history.' }),
    (0, swagger_1.ApiResponse)({ status: 200, description: 'Order detail returned.' }),
    (0, swagger_1.ApiResponse)({ status: 404, description: 'Order not found.' }),
    __param(0, (0, common_1.Param)('orderId', parse_id_pipe_1.ParseIdPipe)),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", Promise)
], AdminOrdersController.prototype, "getOrderDetail", null);
__decorate([
    (0, common_1.Post)(':orderId/force-cancel'),
    (0, idempotency_decorator_1.Idempotency)(),
    (0, common_1.UseGuards)(user_throttle_guard_1.UserThrottleGuard),
    (0, admin_roles_decorator_1.AdminRoles)('SUPER_ADMIN', 'DISPUTE_ADMIN'),
    (0, swagger_1.ApiOperation)({ summary: 'Force cancel order', description: 'Admin force-cancels an order with optional escrow refund.' }),
    (0, swagger_1.ApiResponse)({ status: 200, description: 'Order force-cancelled.' }),
    (0, swagger_1.ApiResponse)({ status: 400, description: 'Invalid order status for cancellation.' }),
    (0, swagger_1.ApiResponse)({ status: 404, description: 'Order not found.' }),
    __param(0, (0, common_1.Param)('orderId', parse_id_pipe_1.ParseIdPipe)),
    __param(1, (0, common_1.Body)()),
    __param(2, (0, current_admin_decorator_1.CurrentAdmin)('sub')),
    __param(3, (0, common_1.Req)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, admin_order_query_dto_1.ForceActionDto, String, Object]),
    __metadata("design:returntype", Promise)
], AdminOrdersController.prototype, "forceCancel", null);
__decorate([
    (0, common_1.Post)(':orderId/force-complete'),
    (0, idempotency_decorator_1.Idempotency)(),
    (0, common_1.UseGuards)(user_throttle_guard_1.UserThrottleGuard),
    (0, admin_roles_decorator_1.AdminRoles)('SUPER_ADMIN'),
    (0, swagger_1.ApiOperation)({ summary: 'Force complete order', description: 'Admin force-completes an order, releasing escrow to seller.' }),
    (0, swagger_1.ApiResponse)({ status: 200, description: 'Order force-completed.' }),
    (0, swagger_1.ApiResponse)({ status: 400, description: 'Invalid order status for completion.' }),
    (0, swagger_1.ApiResponse)({ status: 404, description: 'Order not found.' }),
    __param(0, (0, common_1.Param)('orderId', parse_id_pipe_1.ParseIdPipe)),
    __param(1, (0, common_1.Body)()),
    __param(2, (0, current_admin_decorator_1.CurrentAdmin)('sub')),
    __param(3, (0, common_1.Req)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, admin_order_query_dto_1.ForceActionDto, String, Object]),
    __metadata("design:returntype", Promise)
], AdminOrdersController.prototype, "forceComplete", null);
exports.AdminOrdersController = AdminOrdersController = __decorate([
    (0, swagger_1.ApiTags)('admin-orders'),
    (0, swagger_1.ApiBearerAuth)('access-token'),
    (0, common_1.UseGuards)(jwt_admin_guard_1.JwtAdminGuard, admin_roles_guard_1.AdminRolesGuard),
    (0, admin_roles_decorator_1.AdminRoles)('SUPER_ADMIN', 'DISPUTE_ADMIN'),
    (0, public_decorator_1.AdminRoute)(),
    (0, common_1.Controller)('admin/orders'),
    __metadata("design:paramtypes", [admin_orders_service_1.AdminOrdersService])
], AdminOrdersController);
