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
var JwtAdminGuard_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.JwtAdminGuard = void 0;
const common_1 = require("@nestjs/common");
const jwt_1 = require("@nestjs/jwt");
const config_1 = require("@nestjs/config");
const redis_service_1 = require("../../redis/redis.service");
const prisma_service_1 = require("../../prisma/prisma.service");
const redis_keys_1 = require("../constants/redis-keys");
const ErrorCodes = __importStar(require("../constants/error-codes"));
const TOKEN_ISSUER = 'kahade-auth';
const ADMIN_TOKEN_AUDIENCE = 'kahade-admin-api';
let JwtAdminGuard = JwtAdminGuard_1 = class JwtAdminGuard {
    constructor(jwtService, redisService, configService, prisma) {
        this.jwtService = jwtService;
        this.redisService = redisService;
        this.configService = configService;
        this.prisma = prisma;
        this.logger = new common_1.Logger(JwtAdminGuard_1.name);
    }
    async canActivate(context) {
        const request = context.switchToHttp().getRequest();
        const token = this.extractTokenFromHeader(request);
        if (!token) {
            throw new common_1.UnauthorizedException({
                code: ErrorCodes.UNAUTHORIZED,
                message: 'Admin access token required',
            });
        }
        try {
            const secret = this.configService.get('jwt.adminSecret');
            const payload = await this.jwtService.verifyAsync(token, {
                secret,
                audience: ADMIN_TOKEN_AUDIENCE,
                issuer: TOKEN_ISSUER,
                algorithms: ['HS256'],
            });
            if (!payload.sub || !payload.jti) {
                throw new common_1.UnauthorizedException({
                    code: ErrorCodes.UNAUTHORIZED,
                    message: 'Admin token missing required claims',
                });
            }
            const isBlacklisted = await this.redisService.get((0, redis_keys_1.ADMIN_TOKEN_BLACKLIST)(payload.jti), { throwOnError: true });
            if (isBlacklisted) {
                throw new common_1.UnauthorizedException({
                    code: ErrorCodes.UNAUTHORIZED,
                    message: 'Token has been revoked',
                });
            }
            const revokedAtRaw = await this.redisService.get(`admin_revoked:${payload.sub}`, { throwOnError: true });
            if (revokedAtRaw) {
                const revokedAt = Number(revokedAtRaw);
                const issuedAt = typeof payload.iat === 'number' ? payload.iat : 0;
                const tokenRevoked = !Number.isFinite(revokedAt) || revokedAt <= 1 || issuedAt <= revokedAt;
                if (tokenRevoked) {
                    throw new common_1.UnauthorizedException({
                        code: ErrorCodes.UNAUTHORIZED,
                        message: 'Admin token has been revoked',
                    });
                }
            }
            const admin = await this.prisma.adminUser.findUnique({
                where: { id: payload.sub },
                select: { isActive: true, deletedAt: true, lockedUntil: true },
            });
            if (!admin || !admin.isActive || admin.deletedAt) {
                throw new common_1.UnauthorizedException({
                    code: ErrorCodes.UNAUTHORIZED,
                    message: 'Admin account has been deactivated',
                });
            }
            if (admin.lockedUntil && admin.lockedUntil > new Date()) {
                throw new common_1.UnauthorizedException({
                    code: ErrorCodes.ACCOUNT_LOCKED,
                    message: 'Admin account is locked',
                });
            }
            if (payload.scope) {
                const allowedPaths = this.getAllowedPathsForScope(payload.scope);
                const rawPath = (request.originalUrl || request.url || '').split('?')[0].replace(/\/+$/, '');
                const apiPrefix = '/v1';
                const normalizedPath = rawPath.startsWith(apiPrefix) ? rawPath.slice(apiPrefix.length) : rawPath;
                const isAllowed = allowedPaths.some(path => normalizedPath === path);
                if (!isAllowed) {
                    throw new common_1.ForbiddenException({
                        code: ErrorCodes.INSUFFICIENT_TOKEN_SCOPE,
                        message: 'Token scope insufficient for this endpoint',
                    });
                }
            }
            request.admin = payload;
            return true;
        }
        catch (error) {
            if (error instanceof common_1.ForbiddenException || error instanceof common_1.UnauthorizedException)
                throw error;
            if (error instanceof common_1.ServiceUnavailableException)
                throw error;
            if (error?.name === 'JsonWebTokenError' || error?.name === 'TokenExpiredError') {
                throw new common_1.UnauthorizedException({
                    code: ErrorCodes.UNAUTHORIZED,
                    message: 'Invalid or expired admin token',
                });
            }
            this.logger.warn('Unexpected error during admin token verification — rejecting request (fail-closed)');
            throw new common_1.ServiceUnavailableException('Service temporarily unavailable. Please try again later.');
        }
    }
    getAllowedPathsForScope(scope) {
        const scopePaths = {
            mfa_setup: ['/admin/auth/2fa/setup'],
            mfa_confirm: ['/admin/auth/2fa/confirm'],
            change_password_required: ['/admin/auth/change-password'],
            admin_2fa_verify: ['/admin/auth/2fa/verify'],
            '2fa_verify': ['/admin/auth/2fa/verify'],
        };
        return scopePaths[scope] || [];
    }
    extractTokenFromHeader(request) {
        const [type, token] = request.headers.authorization?.split(' ') ?? [];
        return type === 'Bearer' ? token : undefined;
    }
};
exports.JwtAdminGuard = JwtAdminGuard;
exports.JwtAdminGuard = JwtAdminGuard = JwtAdminGuard_1 = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [jwt_1.JwtService,
        redis_service_1.RedisService,
        config_1.ConfigService,
        prisma_service_1.PrismaService])
], JwtAdminGuard);
