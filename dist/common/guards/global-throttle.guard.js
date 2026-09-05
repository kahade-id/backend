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
var GlobalThrottleGuard_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.GlobalThrottleGuard = void 0;
const common_1 = require("@nestjs/common");
const redis_service_1 = require("../../redis/redis.service");
const GLOBAL_IP_LIMIT = 1000;
const GLOBAL_IP_WINDOW_SECONDS = 60;
let GlobalThrottleGuard = GlobalThrottleGuard_1 = class GlobalThrottleGuard {
    constructor(redis) {
        this.redis = redis;
        this.logger = new common_1.Logger(GlobalThrottleGuard_1.name);
    }
    async canActivate(context) {
        const req = context.switchToHttp().getRequest();
        if (!req)
            return true;
        const resolvedIp = req.ip
            || req.socket?.remoteAddress
            || 'unknown';
        const key = `global_throttle:${resolvedIp}`;
        try {
            const count = await this.redis.incr(key);
            if (count === 1) {
                await this.redis.expire(key, GLOBAL_IP_WINDOW_SECONDS);
            }
            if (count > GLOBAL_IP_LIMIT) {
                throw new common_1.HttpException({ statusCode: common_1.HttpStatus.TOO_MANY_REQUESTS, message: 'Too many requests. Please try again later.' }, common_1.HttpStatus.TOO_MANY_REQUESTS);
            }
            return true;
        }
        catch (error) {
            if (error instanceof common_1.HttpException)
                throw error;
            this.logger.error(`Global throttle check failed for ${resolvedIp}: ${error.message} — failing closed`);
            throw new common_1.ServiceUnavailableException('Service temporarily unavailable. Please try again later.');
        }
    }
};
exports.GlobalThrottleGuard = GlobalThrottleGuard;
exports.GlobalThrottleGuard = GlobalThrottleGuard = GlobalThrottleGuard_1 = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [redis_service_1.RedisService])
], GlobalThrottleGuard);
