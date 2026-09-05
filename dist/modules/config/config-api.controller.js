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
exports.AppApiController = exports.ConfigApiController = void 0;
const common_1 = require("@nestjs/common");
const swagger_1 = require("@nestjs/swagger");
const throttler_1 = require("@nestjs/throttler");
const public_decorator_1 = require("../../common/decorators/public.decorator");
const public_service_1 = require("../public/public.service");
let ConfigApiController = class ConfigApiController {
    constructor(publicService) {
        this.publicService = publicService;
    }
    async getExchangeRates() {
        return this.publicService.getExchangeRates();
    }
};
exports.ConfigApiController = ConfigApiController;
__decorate([
    (0, public_decorator_1.Public)(),
    (0, throttler_1.Throttle)({ default: { ttl: 60000, limit: 30 } }),
    (0, common_1.Get)('exchange-rates'),
    (0, common_1.Header)('Cache-Control', 'public, max-age=300, s-maxage=300'),
    (0, swagger_1.ApiOperation)({ summary: 'Get current exchange rates' }),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", Promise)
], ConfigApiController.prototype, "getExchangeRates", null);
exports.ConfigApiController = ConfigApiController = __decorate([
    (0, swagger_1.ApiTags)('config'),
    (0, common_1.Controller)('config'),
    __metadata("design:paramtypes", [public_service_1.PublicService])
], ConfigApiController);
let AppApiController = class AppApiController {
    constructor(publicService) {
        this.publicService = publicService;
    }
    getAppVersion() {
        return this.publicService.getAppVersion();
    }
};
exports.AppApiController = AppApiController;
__decorate([
    (0, public_decorator_1.Public)(),
    (0, throttler_1.Throttle)({ default: { ttl: 60000, limit: 60 } }),
    (0, common_1.Get)('version'),
    (0, common_1.Header)('Cache-Control', 'public, max-age=300, s-maxage=300'),
    (0, swagger_1.ApiOperation)({ summary: 'Get minimum and latest app version for force-update' }),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", Object)
], AppApiController.prototype, "getAppVersion", null);
exports.AppApiController = AppApiController = __decorate([
    (0, swagger_1.ApiTags)('app'),
    (0, common_1.Controller)('app'),
    __metadata("design:paramtypes", [public_service_1.PublicService])
], AppApiController);
