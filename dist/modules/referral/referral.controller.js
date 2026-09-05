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
exports.ReferralController = void 0;
const common_1 = require("@nestjs/common");
const swagger_1 = require("@nestjs/swagger");
const throttler_1 = require("@nestjs/throttler");
const referral_service_1 = require("./referral.service");
const current_user_decorator_1 = require("../../common/decorators/current-user.decorator");
const allow_response_fields_decorator_1 = require("../../common/decorators/allow-response-fields.decorator");
const apply_referral_dto_1 = require("./dto/apply-referral.dto");
const pagination_dto_1 = require("../../common/dto/pagination.dto");
const user_throttle_guard_1 = require("../../common/guards/user-throttle.guard");
let ReferralController = class ReferralController {
    constructor(referralService) {
        this.referralService = referralService;
    }
    async getMyCode(userId) {
        return this.referralService.getOrCreateCode(userId);
    }
    async applyCode(userId, dto) {
        return this.referralService.applyCode(userId, dto.code);
    }
    async getStats(userId) {
        return this.referralService.getStats(userId);
    }
    async getRewards(userId, query) {
        return this.referralService.getRewards(userId, query.page ?? 1, query.limit ?? 20);
    }
    async regenerateCode(userId) {
        return this.referralService.regenerateCode(userId);
    }
    async getHistory(userId, query) {
        return this.referralService.getHistory(userId, query.page ?? 1, query.limit ?? 20);
    }
};
exports.ReferralController = ReferralController;
__decorate([
    (0, throttler_1.Throttle)({ default: { ttl: 60000, limit: 30 } }),
    (0, common_1.Get)('my-code'),
    (0, allow_response_fields_decorator_1.AllowResponseFields)('code'),
    __param(0, (0, current_user_decorator_1.CurrentUser)('sub')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", Promise)
], ReferralController.prototype, "getMyCode", null);
__decorate([
    (0, common_1.UseGuards)(user_throttle_guard_1.UserThrottleGuard),
    (0, throttler_1.Throttle)({ default: { ttl: 3600000, limit: 10 } }),
    (0, common_1.Post)('apply'),
    __param(0, (0, current_user_decorator_1.CurrentUser)('sub')),
    __param(1, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, apply_referral_dto_1.ApplyReferralDto]),
    __metadata("design:returntype", Promise)
], ReferralController.prototype, "applyCode", null);
__decorate([
    (0, throttler_1.Throttle)({ default: { ttl: 60000, limit: 30 } }),
    (0, common_1.Get)('stats'),
    (0, allow_response_fields_decorator_1.AllowResponseFields)('code'),
    __param(0, (0, current_user_decorator_1.CurrentUser)('sub')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", Promise)
], ReferralController.prototype, "getStats", null);
__decorate([
    (0, throttler_1.Throttle)({ default: { ttl: 60000, limit: 30 } }),
    (0, common_1.Get)('rewards'),
    __param(0, (0, current_user_decorator_1.CurrentUser)('sub')),
    __param(1, (0, common_1.Query)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, pagination_dto_1.PaginationDto]),
    __metadata("design:returntype", Promise)
], ReferralController.prototype, "getRewards", null);
__decorate([
    (0, common_1.UseGuards)(user_throttle_guard_1.UserThrottleGuard),
    (0, throttler_1.Throttle)({ default: { ttl: 3600000, limit: 3 } }),
    (0, common_1.Post)('regenerate'),
    (0, common_1.HttpCode)(200),
    (0, allow_response_fields_decorator_1.AllowResponseFields)('code'),
    __param(0, (0, current_user_decorator_1.CurrentUser)('sub')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", Promise)
], ReferralController.prototype, "regenerateCode", null);
__decorate([
    (0, throttler_1.Throttle)({ default: { ttl: 60000, limit: 30 } }),
    (0, common_1.Get)('history'),
    __param(0, (0, current_user_decorator_1.CurrentUser)('sub')),
    __param(1, (0, common_1.Query)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, pagination_dto_1.PaginationDto]),
    __metadata("design:returntype", Promise)
], ReferralController.prototype, "getHistory", null);
exports.ReferralController = ReferralController = __decorate([
    (0, swagger_1.ApiTags)('referral'),
    (0, swagger_1.ApiBearerAuth)('access-token'),
    (0, common_1.Controller)('referral'),
    __metadata("design:paramtypes", [referral_service_1.ReferralService])
], ReferralController);
