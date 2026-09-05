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
var UserThrottleGuard_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.UserThrottleGuard = void 0;
const common_1 = require("@nestjs/common");
const config_1 = require("@nestjs/config");
const redis_service_1 = require("../../redis/redis.service");
let UserThrottleGuard = UserThrottleGuard_1 = class UserThrottleGuard {
    constructor(redis, configService) {
        this.redis = redis;
        this.configService = configService;
        this.logger = new common_1.Logger(UserThrottleGuard_1.name);
    }
    async canActivate(context) {
        const req = context.switchToHttp().getRequest();
        const user = req.user;
        const admin = req.admin;
        let tracker;
        if (admin?.sub) {
            tracker = `admin:${admin.sub}`;
        }
        else if (user?.sub) {
            tracker = `user:${user.sub}`;
        }
        else {
            const resolvedIp = req.ip
                || req.socket?.remoteAddress
                || 'unknown';
            tracker = `ip:${resolvedIp}`;
        }
        const windowMs = this.configService.get('app.throttleGlobalTtlMs') ?? 60000;
        const limit = this.configService.get('app.throttleGlobalLimit') ?? 100;
        const key = `throttle:sliding:${tracker}`;
        try {
            const allowed = await this.redis.evalSlidingWindow(key, windowMs, limit, Date.now());
            if (!allowed) {
                throw new common_1.HttpException({ statusCode: common_1.HttpStatus.TOO_MANY_REQUESTS, message: 'Too many requests. Please try again later.' }, common_1.HttpStatus.TOO_MANY_REQUESTS);
            }
        }
        catch (error) {
            if (error instanceof common_1.HttpException)
                throw error;
            this.logger.error(`Sliding window throttle check failed for ${tracker}: ${error.message} — failing closed`);
            throw new common_1.ServiceUnavailableException('Service temporarily unavailable. Please try again later.');
        }
        return true;
    }
};
exports.UserThrottleGuard = UserThrottleGuard;
exports.UserThrottleGuard = UserThrottleGuard = UserThrottleGuard_1 = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [redis_service_1.RedisService,
        config_1.ConfigService])
], UserThrottleGuard);
