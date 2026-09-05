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
Object.defineProperty(exports, "__esModule", { value: true });
exports.PublicController = void 0;
const common_1 = require("@nestjs/common");
const swagger_1 = require("@nestjs/swagger");
const throttler_1 = require("@nestjs/throttler");
const public_decorator_1 = require("../../common/decorators/public.decorator");
const public_service_1 = require("./public.service");
let PublicController = class PublicController {
    constructor(publicService) {
        this.publicService = publicService;
    }
    async getPublicConfigs() {
        return this.publicService.getPublicConfigs();
    }
    getFeeSchedule() {
        return this.publicService.getFeeSchedule();
    }
    getBanks() {
        return this.publicService.getBanks();
    }
    async getSubscriptionPlans() {
        return this.publicService.getSubscriptionPlans();
    }
    async getExchangeRates() {
        return this.publicService.getExchangeRates();
    }
    getAppVersion() {
        return this.publicService.getAppVersion();
    }
};
exports.PublicController = PublicController;
__decorate([
    (0, public_decorator_1.Public)(),
    (0, throttler_1.Throttle)({ default: { ttl: 60000, limit: 30 } }),
    (0, common_1.Get)('config'),
    (0, common_1.Header)('Cache-Control', 'public, max-age=300, s-maxage=300'),
    (0, swagger_1.ApiOperation)({ summary: 'Get public system configurations' }),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", Promise)
], PublicController.prototype, "getPublicConfigs", null);
__decorate([
    (0, public_decorator_1.Public)(),
    (0, throttler_1.Throttle)({ default: { ttl: 60000, limit: 30 } }),
    (0, common_1.Get)('fee-schedule'),
    (0, common_1.Header)('Cache-Control', 'public, max-age=300, s-maxage=300'),
    (0, swagger_1.ApiOperation)({ summary: 'Get current fee schedule' }),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", Object)
], PublicController.prototype, "getFeeSchedule", null);
__decorate([
    (0, public_decorator_1.Public)(),
    (0, throttler_1.Throttle)({ default: { ttl: 60000, limit: 30 } }),
    (0, common_1.Get)('banks'),
    (0, common_1.Header)('Cache-Control', 'public, max-age=3600, s-maxage=3600'),
    (0, swagger_1.ApiOperation)({ summary: 'List supported bank codes' }),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", Object)
], PublicController.prototype, "getBanks", null);
__decorate([
    (0, public_decorator_1.Public)(),
    (0, throttler_1.Throttle)({ default: { ttl: 60000, limit: 30 } }),
    (0, common_1.Get)('subscription-plans'),
    (0, common_1.Header)('Cache-Control', 'public, max-age=300, s-maxage=300'),
    (0, swagger_1.ApiOperation)({ summary: 'List subscription plans and pricing' }),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", Promise)
], PublicController.prototype, "getSubscriptionPlans", null);
__decorate([
    (0, public_decorator_1.Public)(),
    (0, throttler_1.Throttle)({ default: { ttl: 60000, limit: 30 } }),
    (0, common_1.Get)('exchange-rates'),
    (0, common_1.Header)('Cache-Control', 'public, max-age=300, s-maxage=300'),
    (0, swagger_1.ApiOperation)({ summary: 'Get current exchange rates' }),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", Promise)
], PublicController.prototype, "getExchangeRates", null);
__decorate([
    (0, public_decorator_1.Public)(),
    (0, throttler_1.Throttle)({ default: { ttl: 60000, limit: 60 } }),
    (0, common_1.Get)('app-version'),
    (0, common_1.Header)('Cache-Control', 'public, max-age=300, s-maxage=300'),
    (0, swagger_1.ApiOperation)({ summary: 'Get minimum and latest app version for force-update' }),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", Object)
], PublicController.prototype, "getAppVersion", null);
exports.PublicController = PublicController = __decorate([
    (0, swagger_1.ApiTags)('public'),
    (0, common_1.Controller)('public'),
    __metadata("design:paramtypes", [public_service_1.PublicService])
], PublicController);
