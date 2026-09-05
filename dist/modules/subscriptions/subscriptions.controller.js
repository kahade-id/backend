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
exports.SubscriptionsController = void 0;
const common_1 = require("@nestjs/common");
const clamp_limit_pipe_1 = require("../../common/pipes/clamp-limit.pipe");
const swagger_1 = require("@nestjs/swagger");
const throttler_1 = require("@nestjs/throttler");
const subscriptions_service_1 = require("./subscriptions.service");
const current_user_decorator_1 = require("../../common/decorators/current-user.decorator");
const public_decorator_1 = require("../../common/decorators/public.decorator");
const idempotency_decorator_1 = require("../../common/decorators/idempotency.decorator");
const kyc_required_guard_1 = require("../../common/guards/kyc-required.guard");
const user_throttle_guard_1 = require("../../common/guards/user-throttle.guard");
const subscribe_dto_1 = require("./dto/subscribe.dto");
let SubscriptionsController = class SubscriptionsController {
    constructor(subscriptionsService) {
        this.subscriptionsService = subscriptionsService;
    }
    async getStatus(userId) {
        return this.subscriptionsService.getStatus(userId);
    }
    async subscribe(userId, dto, req) {
        return this.subscriptionsService.subscribe(userId, dto.plan, dto.pin, req.ip);
    }
    async cancel(userId) {
        return this.subscriptionsService.cancel(userId);
    }
    async getHistory(userId, page, limit) {
        return this.subscriptionsService.getHistory(userId, page, limit);
    }
    async getBenefits(userId) {
        return this.subscriptionsService.getBenefits(userId);
    }
    async renew(userId, dto, req) {
        return this.subscriptionsService.renew(userId, dto.pin, req.ip);
    }
    async getPlans() {
        return this.subscriptionsService.getPlans();
    }
};
exports.SubscriptionsController = SubscriptionsController;
__decorate([
    (0, common_1.Get)('status'),
    __param(0, (0, current_user_decorator_1.CurrentUser)('sub')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", Promise)
], SubscriptionsController.prototype, "getStatus", null);
__decorate([
    (0, common_1.Post)('subscribe'),
    (0, common_1.UseGuards)(kyc_required_guard_1.KycRequiredGuard, user_throttle_guard_1.UserThrottleGuard),
    (0, idempotency_decorator_1.Idempotency)(),
    (0, throttler_1.Throttle)({ default: { ttl: 60000, limit: 5 } }),
    __param(0, (0, current_user_decorator_1.CurrentUser)('sub')),
    __param(1, (0, common_1.Body)()),
    __param(2, (0, common_1.Req)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, subscribe_dto_1.SubscribeDto, Object]),
    __metadata("design:returntype", Promise)
], SubscriptionsController.prototype, "subscribe", null);
__decorate([
    (0, throttler_1.Throttle)({ default: { ttl: 60000, limit: 3 } }),
    (0, idempotency_decorator_1.Idempotency)(),
    (0, common_1.UseGuards)(user_throttle_guard_1.UserThrottleGuard),
    (0, common_1.Post)('cancel'),
    __param(0, (0, current_user_decorator_1.CurrentUser)('sub')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", Promise)
], SubscriptionsController.prototype, "cancel", null);
__decorate([
    (0, common_1.Get)('history'),
    __param(0, (0, current_user_decorator_1.CurrentUser)('sub')),
    __param(1, (0, common_1.Query)('page', new common_1.DefaultValuePipe(1), common_1.ParseIntPipe)),
    __param(2, (0, common_1.Query)('limit', new common_1.DefaultValuePipe(20), common_1.ParseIntPipe, new clamp_limit_pipe_1.ClampLimitPipe())),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Number, Number]),
    __metadata("design:returntype", Promise)
], SubscriptionsController.prototype, "getHistory", null);
__decorate([
    (0, common_1.Get)('benefits'),
    __param(0, (0, current_user_decorator_1.CurrentUser)('sub')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", Promise)
], SubscriptionsController.prototype, "getBenefits", null);
__decorate([
    (0, common_1.Post)('renew'),
    (0, common_1.UseGuards)(kyc_required_guard_1.KycRequiredGuard, user_throttle_guard_1.UserThrottleGuard),
    (0, idempotency_decorator_1.Idempotency)(),
    (0, throttler_1.Throttle)({ default: { ttl: 60000, limit: 5 } }),
    __param(0, (0, current_user_decorator_1.CurrentUser)('sub')),
    __param(1, (0, common_1.Body)()),
    __param(2, (0, common_1.Req)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, subscribe_dto_1.RenewDto, Object]),
    __metadata("design:returntype", Promise)
], SubscriptionsController.prototype, "renew", null);
__decorate([
    (0, public_decorator_1.Public)(),
    (0, common_1.Get)('plans'),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", Promise)
], SubscriptionsController.prototype, "getPlans", null);
exports.SubscriptionsController = SubscriptionsController = __decorate([
    (0, swagger_1.ApiTags)('subscriptions'),
    (0, swagger_1.ApiBearerAuth)('access-token'),
    (0, common_1.Controller)('subscriptions'),
    __metadata("design:paramtypes", [subscriptions_service_1.SubscriptionsService])
], SubscriptionsController);
