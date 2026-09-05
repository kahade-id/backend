"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.RealtimeModule = void 0;
const common_1 = require("@nestjs/common");
const config_1 = require("@nestjs/config");
const jwt_1 = require("@nestjs/jwt");
const redis_module_1 = require("../../redis/redis.module");
const realtime_gateway_1 = require("./realtime.gateway");
const notifications_module_1 = require("../notifications/notifications.module");
const realtime_service_1 = require("./realtime.service");
let RealtimeModule = class RealtimeModule {
};
exports.RealtimeModule = RealtimeModule;
exports.RealtimeModule = RealtimeModule = __decorate([
    (0, common_1.Global)(),
    (0, common_1.Module)({
        imports: [jwt_1.JwtModule.register({}), redis_module_1.RedisModule, config_1.ConfigModule, notifications_module_1.NotificationsModule],
        providers: [realtime_gateway_1.RealtimeGateway, realtime_service_1.RealtimeService],
        exports: [realtime_service_1.RealtimeService],
    })
], RealtimeModule);
