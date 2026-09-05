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
exports.OrdersController = void 0;
const common_1 = require("@nestjs/common");
const parse_id_pipe_1 = require("../../common/pipes/parse-id.pipe");
const clamp_limit_pipe_1 = require("../../common/pipes/clamp-limit.pipe");
const parse_token_pipe_1 = require("../../common/pipes/parse-token.pipe");
const swagger_1 = require("@nestjs/swagger");
const throttler_1 = require("@nestjs/throttler");
const orders_service_1 = require("./orders.service");
const order_state_service_1 = require("./order-state.service");
const order_extensions_service_1 = require("./order-extensions.service");
const order_links_service_1 = require("./order-links.service");
const delivery_proof_service_1 = require("./delivery-proof.service");
const invoice_service_1 = require("./invoice.service");
const receipt_service_1 = require("./receipt.service");
const order_qris_payment_service_1 = require("../payment/order-qris-payment.service");
const disputes_service_1 = require("../disputes/disputes.service");
const current_user_decorator_1 = require("../../common/decorators/current-user.decorator");
const idempotency_decorator_1 = require("../../common/decorators/idempotency.decorator");
const public_decorator_1 = require("../../common/decorators/public.decorator");
const user_throttle_guard_1 = require("../../common/guards/user-throttle.guard");
const create_order_dto_1 = require("./dto/create-order.dto");
const create_order_link_dto_1 = require("./dto/create-order-link.dto");
const get_orders_query_dto_1 = require("./dto/get-orders-query.dto");
const order_actions_dto_1 = require("./dto/order-actions.dto");
const delivery_proof_dto_1 = require("./dto/delivery-proof.dto");
let OrdersController = class OrdersController {
    constructor(ordersService, orderStateService, orderExtensionsService, orderLinksService, deliveryProofService, invoiceService, receiptService, orderQrisPaymentService, disputesService) {
        this.ordersService = ordersService;
        this.orderStateService = orderStateService;
        this.orderExtensionsService = orderExtensionsService;
        this.orderLinksService = orderLinksService;
        this.deliveryProofService = deliveryProofService;
        this.invoiceService = invoiceService;
        this.receiptService = receiptService;
        this.orderQrisPaymentService = orderQrisPaymentService;
        this.disputesService = disputesService;
    }
    async getOrderSummary(userId) {
        return this.ordersService.getOrderSummary(userId);
    }
    async getAverageDurations() {
        return this.ordersService.getAverageDurations();
    }
    async calculateFee(userId, dto) {
        return this.ordersService.calculateFee(dto, userId);
    }
    async validateCounterpart(userId, dto) {
        return this.ordersService.validateCounterpart(userId, dto.username);
    }
    async createOrder(userId, dto) {
        return this.ordersService.createOrder(userId, dto);
    }
    async getOrders(userId, query) {
        return this.ordersService.getOrders(userId, query.page, query.limit, query.status, query.role, query.search);
    }
    async getOrderDetail(userId, orderId) {
        return this.ordersService.getOrderDetail(userId, orderId);
    }
    async confirmOrder(userId, orderId, dto) {
        return this.orderStateService.handleConfirmAction(orderId, userId, dto.action, dto.reason);
    }
    async payOrder(userId, orderId, dto, req) {
        return this.orderStateService.handlePayOrder(orderId, userId, dto.pin, req.ip);
    }
    async initiateQrisOrderPayment(userId, orderId) {
        return this.orderQrisPaymentService.initiate(orderId, userId);
    }
    async getOrderPaymentStatus(userId, orderId) {
        return { payment: await this.orderQrisPaymentService.getStatus(orderId, userId) };
    }
    async processOrder(userId, orderId) {
        return this.ordersService.processOrder(orderId, userId);
    }
    async updateShipping(userId, orderId, dto) {
        return this.ordersService.updateShipping(orderId, userId, dto);
    }
    async completeOrder(userId, orderId) {
        return this.orderStateService.handleCompleteOrder(orderId, userId);
    }
    async cancelOrder(userId, orderId, dto) {
        return this.orderStateService.handleCancelOrder(orderId, userId, dto.reason, dto.note);
    }
    async requestExtension(userId, orderId, dto) {
        return this.orderExtensionsService.requestExtension(orderId, userId, dto);
    }
    async respondExtension(userId, orderId, extensionId, dto) {
        return this.orderExtensionsService.respondExtension(extensionId, userId, dto, orderId);
    }
    async getExtensions(userId, orderId, page, limit) {
        return this.orderExtensionsService.getExtensions(orderId, userId, page, limit);
    }
    async submitDispute(userId, orderId, dto) {
        return this.disputesService.submitDispute(orderId, userId, dto);
    }
    async getOrderHistory(userId, orderId, page, limit) {
        return this.ordersService.getOrderHistory(orderId, userId, page, limit);
    }
    async createOrderLink(userId, dto) {
        return this.orderLinksService.createLink(userId, dto);
    }
    async getMyOrderLinks(userId, page, limit) {
        return this.orderLinksService.getMyLinks(userId, page, limit);
    }
    async getOrderLinkByToken(token) {
        return this.orderLinksService.getLinkByToken(token);
    }
    async acceptOrderLink(userId, token) {
        return this.orderLinksService.acceptLink(token, userId);
    }
    async cancelOrderLink(userId, token) {
        return this.orderLinksService.cancelLink(token, userId);
    }
    async submitDeliveryProof(userId, orderId, dto) {
        return this.deliveryProofService.submitProof(orderId, userId, dto);
    }
    async getDeliveryProofs(userId, orderId) {
        return this.deliveryProofService.getProofs(orderId, userId);
    }
    async confirmDelivery(userId, orderId, dto) {
        return this.deliveryProofService.confirmDelivery(orderId, userId, dto.proofId);
    }
    async rejectDelivery(userId, orderId, dto) {
        return this.deliveryProofService.rejectDelivery(orderId, userId, dto.note, dto.proofId);
    }
    async getInvoice(userId, orderId) {
        return this.invoiceService.getInvoiceData(orderId, userId);
    }
    async getReceipt(userId, orderId) {
        const html = await this.receiptService.generateReceiptHtml(orderId, userId);
        return { html };
    }
};
exports.OrdersController = OrdersController;
__decorate([
    (0, throttler_1.Throttle)({ default: { ttl: 60000, limit: 30 } }),
    (0, common_1.Get)('summary'),
    __param(0, (0, current_user_decorator_1.CurrentUser)('sub')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", Promise)
], OrdersController.prototype, "getOrderSummary", null);
__decorate([
    (0, throttler_1.Throttle)({ default: { ttl: 60000, limit: 10 } }),
    (0, common_1.Get)('average-durations'),
    (0, swagger_1.ApiOperation)({ summary: 'Get average duration per status transition from completed orders' }),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", Promise)
], OrdersController.prototype, "getAverageDurations", null);
__decorate([
    (0, common_1.UseGuards)(user_throttle_guard_1.UserThrottleGuard),
    (0, throttler_1.Throttle)({ default: { ttl: 60000, limit: 30 } }),
    (0, common_1.Post)('calculate-fee'),
    (0, common_1.HttpCode)(200),
    __param(0, (0, current_user_decorator_1.CurrentUser)('sub')),
    __param(1, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, order_actions_dto_1.CalculateFeeDto]),
    __metadata("design:returntype", Promise)
], OrdersController.prototype, "calculateFee", null);
__decorate([
    (0, common_1.UseGuards)(user_throttle_guard_1.UserThrottleGuard),
    (0, throttler_1.Throttle)({ default: { ttl: 60000, limit: 20 } }),
    (0, common_1.Post)('validate-counterpart'),
    (0, common_1.HttpCode)(200),
    __param(0, (0, current_user_decorator_1.CurrentUser)('sub')),
    __param(1, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, order_actions_dto_1.ValidateCounterpartDto]),
    __metadata("design:returntype", Promise)
], OrdersController.prototype, "validateCounterpart", null);
__decorate([
    (0, common_1.UseGuards)(user_throttle_guard_1.UserThrottleGuard),
    (0, throttler_1.Throttle)({ default: { ttl: 3600000, limit: 20 } }),
    (0, common_1.Post)(),
    (0, common_1.HttpCode)(201),
    (0, idempotency_decorator_1.Idempotency)(),
    __param(0, (0, current_user_decorator_1.CurrentUser)('sub')),
    __param(1, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, create_order_dto_1.CreateOrderDto]),
    __metadata("design:returntype", Promise)
], OrdersController.prototype, "createOrder", null);
__decorate([
    (0, common_1.Get)(),
    __param(0, (0, current_user_decorator_1.CurrentUser)('sub')),
    __param(1, (0, common_1.Query)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, get_orders_query_dto_1.GetOrdersQueryDto]),
    __metadata("design:returntype", Promise)
], OrdersController.prototype, "getOrders", null);
__decorate([
    (0, throttler_1.Throttle)({ default: { ttl: 60000, limit: 30 } }),
    (0, common_1.Get)(':orderId'),
    __param(0, (0, current_user_decorator_1.CurrentUser)('sub')),
    __param(1, (0, common_1.Param)('orderId', parse_id_pipe_1.ParseIdPipe)),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String]),
    __metadata("design:returntype", Promise)
], OrdersController.prototype, "getOrderDetail", null);
__decorate([
    (0, common_1.UseGuards)(user_throttle_guard_1.UserThrottleGuard),
    (0, throttler_1.Throttle)({ default: { ttl: 900000, limit: 10 } }),
    (0, common_1.Post)(':orderId/confirm'),
    (0, idempotency_decorator_1.Idempotency)(),
    (0, common_1.HttpCode)(200),
    __param(0, (0, current_user_decorator_1.CurrentUser)('sub')),
    __param(1, (0, common_1.Param)('orderId', parse_id_pipe_1.ParseIdPipe)),
    __param(2, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String, order_actions_dto_1.ConfirmOrderDto]),
    __metadata("design:returntype", Promise)
], OrdersController.prototype, "confirmOrder", null);
__decorate([
    (0, common_1.UseGuards)(user_throttle_guard_1.UserThrottleGuard),
    (0, throttler_1.Throttle)({ default: { ttl: 900000, limit: 5 } }),
    (0, common_1.Post)(':orderId/pay'),
    (0, idempotency_decorator_1.Idempotency)(),
    __param(0, (0, current_user_decorator_1.CurrentUser)('sub')),
    __param(1, (0, common_1.Param)('orderId', parse_id_pipe_1.ParseIdPipe)),
    __param(2, (0, common_1.Body)()),
    __param(3, (0, common_1.Req)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String, order_actions_dto_1.PayOrderDto, Object]),
    __metadata("design:returntype", Promise)
], OrdersController.prototype, "payOrder", null);
__decorate([
    (0, common_1.UseGuards)(user_throttle_guard_1.UserThrottleGuard),
    (0, throttler_1.Throttle)({ default: { ttl: 900000, limit: 5 } }),
    (0, common_1.Post)(':orderId/pay-qris'),
    (0, idempotency_decorator_1.Idempotency)(),
    (0, common_1.HttpCode)(200),
    __param(0, (0, current_user_decorator_1.CurrentUser)('sub')),
    __param(1, (0, common_1.Param)('orderId', parse_id_pipe_1.ParseIdPipe)),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String]),
    __metadata("design:returntype", Promise)
], OrdersController.prototype, "initiateQrisOrderPayment", null);
__decorate([
    (0, throttler_1.Throttle)({ default: { ttl: 60000, limit: 60 } }),
    (0, common_1.Get)(':orderId/payment-status'),
    __param(0, (0, current_user_decorator_1.CurrentUser)('sub')),
    __param(1, (0, common_1.Param)('orderId', parse_id_pipe_1.ParseIdPipe)),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String]),
    __metadata("design:returntype", Promise)
], OrdersController.prototype, "getOrderPaymentStatus", null);
__decorate([
    (0, common_1.UseGuards)(user_throttle_guard_1.UserThrottleGuard),
    (0, throttler_1.Throttle)({ default: { ttl: 900000, limit: 10 } }),
    (0, common_1.Post)(':orderId/process'),
    (0, idempotency_decorator_1.Idempotency)(),
    __param(0, (0, current_user_decorator_1.CurrentUser)('sub')),
    __param(1, (0, common_1.Param)('orderId', parse_id_pipe_1.ParseIdPipe)),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String]),
    __metadata("design:returntype", Promise)
], OrdersController.prototype, "processOrder", null);
__decorate([
    (0, common_1.UseGuards)(user_throttle_guard_1.UserThrottleGuard),
    (0, throttler_1.Throttle)({ default: { ttl: 900000, limit: 10 } }),
    (0, common_1.Put)(':orderId/shipping'),
    (0, idempotency_decorator_1.Idempotency)(),
    __param(0, (0, current_user_decorator_1.CurrentUser)('sub')),
    __param(1, (0, common_1.Param)('orderId', parse_id_pipe_1.ParseIdPipe)),
    __param(2, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String, order_actions_dto_1.UpdateShippingDto]),
    __metadata("design:returntype", Promise)
], OrdersController.prototype, "updateShipping", null);
__decorate([
    (0, common_1.UseGuards)(user_throttle_guard_1.UserThrottleGuard),
    (0, throttler_1.Throttle)({ default: { ttl: 900000, limit: 5 } }),
    (0, common_1.Post)(':orderId/complete'),
    (0, idempotency_decorator_1.Idempotency)(),
    __param(0, (0, current_user_decorator_1.CurrentUser)('sub')),
    __param(1, (0, common_1.Param)('orderId', parse_id_pipe_1.ParseIdPipe)),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String]),
    __metadata("design:returntype", Promise)
], OrdersController.prototype, "completeOrder", null);
__decorate([
    (0, common_1.UseGuards)(user_throttle_guard_1.UserThrottleGuard),
    (0, throttler_1.Throttle)({ default: { ttl: 900000, limit: 5 } }),
    (0, common_1.Post)(':orderId/cancel'),
    (0, idempotency_decorator_1.Idempotency)(),
    (0, common_1.HttpCode)(200),
    __param(0, (0, current_user_decorator_1.CurrentUser)('sub')),
    __param(1, (0, common_1.Param)('orderId', parse_id_pipe_1.ParseIdPipe)),
    __param(2, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String, order_actions_dto_1.CancelOrderDto]),
    __metadata("design:returntype", Promise)
], OrdersController.prototype, "cancelOrder", null);
__decorate([
    (0, common_1.UseGuards)(user_throttle_guard_1.UserThrottleGuard),
    (0, throttler_1.Throttle)({ default: { ttl: 900000, limit: 5 } }),
    (0, common_1.Post)(':orderId/extensions'),
    (0, idempotency_decorator_1.Idempotency)(),
    __param(0, (0, current_user_decorator_1.CurrentUser)('sub')),
    __param(1, (0, common_1.Param)('orderId', parse_id_pipe_1.ParseIdPipe)),
    __param(2, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String, order_actions_dto_1.RequestExtensionDto]),
    __metadata("design:returntype", Promise)
], OrdersController.prototype, "requestExtension", null);
__decorate([
    (0, common_1.UseGuards)(user_throttle_guard_1.UserThrottleGuard),
    (0, throttler_1.Throttle)({ default: { ttl: 900000, limit: 10 } }),
    (0, common_1.Put)(':orderId/extensions/:extensionId'),
    (0, idempotency_decorator_1.Idempotency)(),
    __param(0, (0, current_user_decorator_1.CurrentUser)('sub')),
    __param(1, (0, common_1.Param)('orderId', parse_id_pipe_1.ParseIdPipe)),
    __param(2, (0, common_1.Param)('extensionId', parse_id_pipe_1.ParseIdPipe)),
    __param(3, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String, String, order_actions_dto_1.RespondExtensionDto]),
    __metadata("design:returntype", Promise)
], OrdersController.prototype, "respondExtension", null);
__decorate([
    (0, common_1.Get)(':orderId/extensions'),
    __param(0, (0, current_user_decorator_1.CurrentUser)('sub')),
    __param(1, (0, common_1.Param)('orderId', parse_id_pipe_1.ParseIdPipe)),
    __param(2, (0, common_1.Query)('page', new common_1.DefaultValuePipe(1), common_1.ParseIntPipe)),
    __param(3, (0, common_1.Query)('limit', new common_1.DefaultValuePipe(20), common_1.ParseIntPipe, new clamp_limit_pipe_1.ClampLimitPipe())),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String, Number, Number]),
    __metadata("design:returntype", Promise)
], OrdersController.prototype, "getExtensions", null);
__decorate([
    (0, common_1.UseGuards)(user_throttle_guard_1.UserThrottleGuard),
    (0, throttler_1.Throttle)({ default: { ttl: 3600000, limit: 3 } }),
    (0, common_1.Post)(':orderId/dispute'),
    (0, idempotency_decorator_1.Idempotency)(),
    __param(0, (0, current_user_decorator_1.CurrentUser)('sub')),
    __param(1, (0, common_1.Param)('orderId', parse_id_pipe_1.ParseIdPipe)),
    __param(2, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String, order_actions_dto_1.SubmitDisputeDto]),
    __metadata("design:returntype", Promise)
], OrdersController.prototype, "submitDispute", null);
__decorate([
    (0, common_1.Get)(':orderId/history'),
    __param(0, (0, current_user_decorator_1.CurrentUser)('sub')),
    __param(1, (0, common_1.Param)('orderId', parse_id_pipe_1.ParseIdPipe)),
    __param(2, (0, common_1.Query)('page', new common_1.DefaultValuePipe(1), common_1.ParseIntPipe)),
    __param(3, (0, common_1.Query)('limit', new common_1.DefaultValuePipe(20), common_1.ParseIntPipe, new clamp_limit_pipe_1.ClampLimitPipe())),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String, Number, Number]),
    __metadata("design:returntype", Promise)
], OrdersController.prototype, "getOrderHistory", null);
__decorate([
    (0, common_1.UseGuards)(user_throttle_guard_1.UserThrottleGuard),
    (0, throttler_1.Throttle)({ default: { ttl: 3600000, limit: 20 } }),
    (0, common_1.Post)('links'),
    (0, idempotency_decorator_1.Idempotency)(),
    (0, common_1.HttpCode)(201),
    (0, swagger_1.ApiOperation)({ summary: 'Create an order link (Order via Link)' }),
    __param(0, (0, current_user_decorator_1.CurrentUser)('sub')),
    __param(1, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, create_order_link_dto_1.CreateOrderLinkDto]),
    __metadata("design:returntype", Promise)
], OrdersController.prototype, "createOrderLink", null);
__decorate([
    (0, common_1.Get)('links/my'),
    (0, swagger_1.ApiOperation)({ summary: 'Get my order links' }),
    __param(0, (0, current_user_decorator_1.CurrentUser)('sub')),
    __param(1, (0, common_1.Query)('page', new common_1.DefaultValuePipe(1), common_1.ParseIntPipe)),
    __param(2, (0, common_1.Query)('limit', new common_1.DefaultValuePipe(10), common_1.ParseIntPipe, new clamp_limit_pipe_1.ClampLimitPipe())),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Number, Number]),
    __metadata("design:returntype", Promise)
], OrdersController.prototype, "getMyOrderLinks", null);
__decorate([
    (0, public_decorator_1.Public)(),
    (0, throttler_1.Throttle)({ default: { ttl: 60000, limit: 20 } }),
    (0, common_1.Get)('links/:token'),
    (0, swagger_1.ApiOperation)({ summary: 'Get order link details by token' }),
    __param(0, (0, common_1.Param)('token', parse_token_pipe_1.ParseTokenPipe)),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", Promise)
], OrdersController.prototype, "getOrderLinkByToken", null);
__decorate([
    (0, common_1.UseGuards)(user_throttle_guard_1.UserThrottleGuard),
    (0, throttler_1.Throttle)({ default: { ttl: 3600000, limit: 10 } }),
    (0, common_1.Post)('links/:token/accept'),
    (0, idempotency_decorator_1.Idempotency)(),
    (0, swagger_1.ApiOperation)({ summary: 'Accept an order link' }),
    __param(0, (0, current_user_decorator_1.CurrentUser)('sub')),
    __param(1, (0, common_1.Param)('token', parse_token_pipe_1.ParseTokenPipe)),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String]),
    __metadata("design:returntype", Promise)
], OrdersController.prototype, "acceptOrderLink", null);
__decorate([
    (0, common_1.UseGuards)(user_throttle_guard_1.UserThrottleGuard),
    (0, throttler_1.Throttle)({ default: { ttl: 3600000, limit: 20 } }),
    (0, common_1.Post)('links/:token/cancel'),
    (0, idempotency_decorator_1.Idempotency)(),
    (0, swagger_1.ApiOperation)({ summary: 'Cancel an order link' }),
    __param(0, (0, current_user_decorator_1.CurrentUser)('sub')),
    __param(1, (0, common_1.Param)('token', parse_token_pipe_1.ParseTokenPipe)),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String]),
    __metadata("design:returntype", Promise)
], OrdersController.prototype, "cancelOrderLink", null);
__decorate([
    (0, common_1.UseGuards)(user_throttle_guard_1.UserThrottleGuard),
    (0, throttler_1.Throttle)({ default: { ttl: 3600000, limit: 10 } }),
    (0, common_1.Post)(':orderId/delivery-proof'),
    (0, idempotency_decorator_1.Idempotency)(),
    (0, swagger_1.ApiOperation)({ summary: 'Submit delivery proof' }),
    __param(0, (0, current_user_decorator_1.CurrentUser)('sub')),
    __param(1, (0, common_1.Param)('orderId', parse_id_pipe_1.ParseIdPipe)),
    __param(2, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String, delivery_proof_dto_1.SubmitDeliveryProofDto]),
    __metadata("design:returntype", Promise)
], OrdersController.prototype, "submitDeliveryProof", null);
__decorate([
    (0, common_1.Get)(':orderId/delivery-proof'),
    (0, swagger_1.ApiOperation)({ summary: 'Get delivery proofs for an order' }),
    __param(0, (0, current_user_decorator_1.CurrentUser)('sub')),
    __param(1, (0, common_1.Param)('orderId', parse_id_pipe_1.ParseIdPipe)),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String]),
    __metadata("design:returntype", Promise)
], OrdersController.prototype, "getDeliveryProofs", null);
__decorate([
    (0, common_1.UseGuards)(user_throttle_guard_1.UserThrottleGuard),
    (0, throttler_1.Throttle)({ default: { ttl: 900000, limit: 5 } }),
    (0, common_1.Post)(':orderId/delivery-proof/confirm'),
    (0, idempotency_decorator_1.Idempotency)(),
    (0, swagger_1.ApiOperation)({ summary: 'Confirm delivery (buyer)' }),
    __param(0, (0, current_user_decorator_1.CurrentUser)('sub')),
    __param(1, (0, common_1.Param)('orderId', parse_id_pipe_1.ParseIdPipe)),
    __param(2, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String, delivery_proof_dto_1.ConfirmDeliveryDto]),
    __metadata("design:returntype", Promise)
], OrdersController.prototype, "confirmDelivery", null);
__decorate([
    (0, common_1.UseGuards)(user_throttle_guard_1.UserThrottleGuard),
    (0, throttler_1.Throttle)({ default: { ttl: 900000, limit: 10 } }),
    (0, common_1.Post)(':orderId/delivery-proof/reject'),
    (0, idempotency_decorator_1.Idempotency)(),
    (0, swagger_1.ApiOperation)({ summary: 'Reject delivery proof (buyer)' }),
    __param(0, (0, current_user_decorator_1.CurrentUser)('sub')),
    __param(1, (0, common_1.Param)('orderId', parse_id_pipe_1.ParseIdPipe)),
    __param(2, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String, delivery_proof_dto_1.RejectDeliveryDto]),
    __metadata("design:returntype", Promise)
], OrdersController.prototype, "rejectDelivery", null);
__decorate([
    (0, common_1.Get)(':orderId/invoice'),
    (0, swagger_1.ApiOperation)({ summary: 'Get invoice data for an order' }),
    __param(0, (0, current_user_decorator_1.CurrentUser)('sub')),
    __param(1, (0, common_1.Param)('orderId', parse_id_pipe_1.ParseIdPipe)),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String]),
    __metadata("design:returntype", Promise)
], OrdersController.prototype, "getInvoice", null);
__decorate([
    (0, common_1.Get)(':orderId/receipt'),
    (0, swagger_1.ApiOperation)({ summary: 'Get printable receipt HTML for completed order' }),
    __param(0, (0, current_user_decorator_1.CurrentUser)('sub')),
    __param(1, (0, common_1.Param)('orderId', parse_id_pipe_1.ParseIdPipe)),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String]),
    __metadata("design:returntype", Promise)
], OrdersController.prototype, "getReceipt", null);
exports.OrdersController = OrdersController = __decorate([
    (0, swagger_1.ApiTags)('orders'),
    (0, swagger_1.ApiBearerAuth)('access-token'),
    (0, common_1.Controller)('orders'),
    __metadata("design:paramtypes", [orders_service_1.OrdersService,
        order_state_service_1.OrderStateService,
        order_extensions_service_1.OrderExtensionsService,
        order_links_service_1.OrderLinksService,
        delivery_proof_service_1.DeliveryProofService,
        invoice_service_1.InvoiceService,
        receipt_service_1.ReceiptService,
        order_qris_payment_service_1.OrderQrisPaymentService,
        disputes_service_1.DisputesService])
], OrdersController);
