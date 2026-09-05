"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
var CsrfService_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.CsrfService = void 0;
const common_1 = require("@nestjs/common");
const config_1 = require("@nestjs/config");
const redis_service_1 = require("../../redis/redis.service");
const crypto = __importStar(require("crypto"));
function parseJwtExpiresIn(value) {
    const match = value.match(/^(\d+)(s|m|h|d)$/);
    if (!match)
        return 900;
    const num = parseInt(match[1], 10);
    switch (match[2]) {
        case 's': return num;
        case 'm': return num * 60;
        case 'h': return num * 3600;
        case 'd': return num * 86400;
        default: return 900;
    }
}
let CsrfService = CsrfService_1 = class CsrfService {
    constructor(redis, configService) {
        this.redis = redis;
        this.configService = configService;
        const jwtExpiresIn = this.configService.get('jwt.expiresIn') ?? '15m';
        this.ttlSeconds = parseJwtExpiresIn(jwtExpiresIn);
    }
    getTokenKey(userId, jti, token) {
        const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
        return `csrf:${userId}:${jti}:${tokenHash}`;
    }
    async generateToken(userId, jti) {
        const token = crypto.randomBytes(32).toString('hex');
        const redisKey = this.getTokenKey(userId, jti, token);
        await this.redis.setex(redisKey, this.ttlSeconds, '1', { throwOnError: true });
        return token;
    }
    async validateToken(userId, jti, csrfToken) {
        if (!csrfToken || !CsrfService_1.HEX_PATTERN.test(csrfToken)) {
            return false;
        }
        const redisKey = this.getTokenKey(userId, jti, csrfToken);
        const storedToken = await this.redis.getAndDelete(redisKey, { throwOnError: true });
        return storedToken === '1';
    }
};
exports.CsrfService = CsrfService;
CsrfService.HEX_PATTERN = /^[0-9a-f]{64}$/i;
exports.CsrfService = CsrfService = CsrfService_1 = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [redis_service_1.RedisService,
        config_1.ConfigService])
], CsrfService);
