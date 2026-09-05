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
var KycRequiredGuard_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.KycRequiredGuard = void 0;
const common_1 = require("@nestjs/common");
const prisma_service_1 = require("../../prisma/prisma.service");
const redis_service_1 = require("../../redis/redis.service");
const client_1 = require("@prisma/client");
const ErrorCodes = __importStar(require("../constants/error-codes"));
const KYC_CACHE_TTL = 300;
const KYC_CACHE_KEY = (userId) => `guard:kyc:${userId}`;
let KycRequiredGuard = KycRequiredGuard_1 = class KycRequiredGuard {
    constructor(prisma, redis) {
        this.prisma = prisma;
        this.redis = redis;
        this.logger = new common_1.Logger(KycRequiredGuard_1.name);
    }
    async canActivate(context) {
        const request = context.switchToHttp().getRequest();
        const user = request.user;
        const userId = user?.sub;
        if (!userId) {
            throw new common_1.ForbiddenException({
                code: ErrorCodes.UNAUTHORIZED,
                message: 'Authentication required',
            });
        }
        const cacheKey = KYC_CACHE_KEY(userId);
        const cached = await this.redis.get(cacheKey);
        if (cached === client_1.KycStatus.APPROVED) {
            return true;
        }
        if (cached !== null) {
            throw new common_1.ForbiddenException({
                code: ErrorCodes.KYC_REQUIRED,
                message: 'KYC verification required for this action',
            });
        }
        const dbUser = await this.prisma.user.findUnique({
            where: { id: userId },
            select: { kycStatus: true },
        });
        if (dbUser) {
            await this.redis.set(cacheKey, dbUser.kycStatus, KYC_CACHE_TTL);
        }
        if (!dbUser || dbUser.kycStatus !== client_1.KycStatus.APPROVED) {
            throw new common_1.ForbiddenException({
                code: ErrorCodes.KYC_REQUIRED,
                message: 'KYC verification required for this action',
            });
        }
        return true;
    }
};
exports.KycRequiredGuard = KycRequiredGuard;
exports.KycRequiredGuard = KycRequiredGuard = KycRequiredGuard_1 = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [prisma_service_1.PrismaService, redis_service_1.RedisService])
], KycRequiredGuard);
