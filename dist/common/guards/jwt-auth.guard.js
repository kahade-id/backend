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
var __param = (this && this.__param) || function (paramIndex, decorator) {
    return function (target, key) { decorator(target, key, paramIndex); }
};
var JwtAuthGuard_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.JwtAuthGuard = exports.ADMIN_JWT_SERVICE = void 0;
const common_1 = require("@nestjs/common");
const core_1 = require("@nestjs/core");
const jwt_1 = require("@nestjs/jwt");
const config_1 = require("@nestjs/config");
const public_decorator_1 = require("../decorators/public.decorator");
const redis_service_1 = require("../../redis/redis.service");
const prisma_service_1 = require("../../prisma/prisma.service");
const redis_keys_1 = require("../constants/redis-keys");
const ErrorCodes = __importStar(require("../constants/error-codes"));
const token_service_1 = require("../../modules/auth/token.service");
exports.ADMIN_JWT_SERVICE = 'ADMIN_JWT_SERVICE';
const CIRCUIT_BREAKER_THRESHOLD = 5;
const CIRCUIT_BREAKER_RESET_MS = 30_000;
const CIRCUIT_BREAKER_KEY = 'jwt_guard:circuit:failures';
const CIRCUIT_BREAKER_TS_KEY = 'jwt_guard:circuit:last_failure';
let JwtAuthGuard = JwtAuthGuard_1 = class JwtAuthGuard {
    constructor(reflector, jwtService, adminJwtService, redisService, configService, prismaService) {
        this.reflector = reflector;
        this.jwtService = jwtService;
        this.redisService = redisService;
        this.configService = configService;
        this.prismaService = prismaService;
        this.logger = new common_1.Logger(JwtAuthGuard_1.name);
        this.localCircuitFailureCount = 0;
        this.localCircuitLastFailure = 0;
        if (adminJwtService) {
            this.adminJwtService = adminJwtService;
        }
        else {
            const secret = this.configService.get('jwt.adminSecret');
            this.adminJwtService = new jwt_1.JwtService({ secret });
        }
    }
    async isCircuitOpen() {
        try {
            const client = this.redisService.getClient();
            const prefix = this.redisService.getPrefix();
            const [countStr, tsStr] = await Promise.all([
                client.get(`${prefix}${CIRCUIT_BREAKER_KEY}`),
                client.get(`${prefix}${CIRCUIT_BREAKER_TS_KEY}`),
            ]);
            const count = parseInt(countStr ?? '0', 10);
            const lastFailure = parseInt(tsStr ?? '0', 10);
            if (Date.now() - lastFailure > CIRCUIT_BREAKER_RESET_MS)
                return false;
            return count >= CIRCUIT_BREAKER_THRESHOLD;
        }
        catch {
            if (Date.now() - this.localCircuitLastFailure > CIRCUIT_BREAKER_RESET_MS) {
                this.localCircuitFailureCount = 0;
                return false;
            }
            return this.localCircuitFailureCount >= CIRCUIT_BREAKER_THRESHOLD;
        }
    }
    async recordRedisFailure() {
        this.localCircuitFailureCount++;
        this.localCircuitLastFailure = Date.now();
        try {
            const client = this.redisService.getClient();
            const prefix = this.redisService.getPrefix();
            const pipeline = client.pipeline();
            pipeline.incr(`${prefix}${CIRCUIT_BREAKER_KEY}`);
            pipeline.set(`${prefix}${CIRCUIT_BREAKER_TS_KEY}`, Date.now().toString());
            pipeline.expire(`${prefix}${CIRCUIT_BREAKER_KEY}`, Math.ceil(CIRCUIT_BREAKER_RESET_MS / 1000) + 5);
            pipeline.expire(`${prefix}${CIRCUIT_BREAKER_TS_KEY}`, Math.ceil(CIRCUIT_BREAKER_RESET_MS / 1000) + 5);
            await pipeline.exec();
        }
        catch (err) {
            this.logger.warn(`Failed to record Redis circuit breaker failure: ${err.message}`);
        }
        if (this.localCircuitFailureCount === CIRCUIT_BREAKER_THRESHOLD) {
            this.logger.error(`Redis circuit breaker OPEN after ${CIRCUIT_BREAKER_THRESHOLD} consecutive failures — ` +
                `financial endpoints will reject requests for ${CIRCUIT_BREAKER_RESET_MS / 1000}s`);
        }
    }
    async recordRedisSuccess() {
        if (this.localCircuitFailureCount === 0)
            return;
        this.localCircuitFailureCount = 0;
        try {
            const client = this.redisService.getClient();
            const prefix = this.redisService.getPrefix();
            await client.del(`${prefix}${CIRCUIT_BREAKER_KEY}`);
        }
        catch (err) {
            this.logger.warn(`Failed to record Redis circuit breaker success: ${err.message}`);
        }
    }
    async canActivate(context) {
        const isPublic = this.reflector.getAllAndOverride(public_decorator_1.IS_PUBLIC_KEY, [
            context.getHandler(), context.getClass(),
        ]);
        if (isPublic)
            return true;
        const isAdminRoute = this.reflector.getAllAndOverride(public_decorator_1.IS_ADMIN_ROUTE_KEY, [
            context.getHandler(), context.getClass(),
        ]);
        if (isAdminRoute) {
            const request = context.switchToHttp().getRequest();
            const token = this.extractTokenFromHeader(request);
            if (!token) {
                throw new common_1.UnauthorizedException({ code: ErrorCodes.UNAUTHORIZED, message: 'Admin access token required' });
            }
            try {
                const payload = await this.adminJwtService.verifyAsync(token, {
                    audience: token_service_1.ADMIN_TOKEN_AUDIENCE,
                    issuer: token_service_1.TOKEN_ISSUER,
                    algorithms: ['HS256'],
                });
                if (!payload.jti) {
                    throw new common_1.UnauthorizedException({ code: ErrorCodes.UNAUTHORIZED, message: 'Admin token missing jti claim' });
                }
                try {
                    const isBlacklisted = await this.redisService.get((0, redis_keys_1.ADMIN_TOKEN_BLACKLIST)(payload.jti), { throwOnError: true });
                    if (isBlacklisted) {
                        throw new common_1.UnauthorizedException({ code: ErrorCodes.UNAUTHORIZED, message: 'Token has been revoked' });
                    }
                }
                catch (redisErr) {
                    if (redisErr instanceof common_1.UnauthorizedException)
                        throw redisErr;
                    this.logger.warn('Redis unavailable during admin token blacklist check — rejecting request (fail-closed)');
                    throw new common_1.ServiceUnavailableException('Service temporarily unavailable. Please try again later.');
                }
                request.user = payload;
                return true;
            }
            catch (error) {
                if (error instanceof common_1.UnauthorizedException)
                    throw error;
                if (error instanceof common_1.ServiceUnavailableException)
                    throw error;
                if (error?.name === 'JsonWebTokenError' || error?.name === 'TokenExpiredError') {
                    throw new common_1.UnauthorizedException({ code: ErrorCodes.UNAUTHORIZED, message: 'Invalid or expired admin token' });
                }
                this.logger.warn('Unexpected error during admin token verification — rejecting request (fail-closed)');
                throw new common_1.ServiceUnavailableException('Service temporarily unavailable. Please try again later.');
            }
        }
        const request = context.switchToHttp().getRequest();
        const token = this.extractTokenFromHeader(request) || this.extractTokenFromCookie(request);
        if (!token) {
            throw new common_1.UnauthorizedException({ code: ErrorCodes.UNAUTHORIZED, message: 'Access token required' });
        }
        try {
            const secret = this.configService.get('jwt.secret');
            const payload = await this.jwtService.verifyAsync(token, {
                secret,
                audience: token_service_1.USER_TOKEN_AUDIENCE,
                issuer: token_service_1.TOKEN_ISSUER,
                algorithms: ['HS256'],
            });
            if (!payload.jti || !payload.sessionId) {
                throw new common_1.UnauthorizedException({ code: ErrorCodes.UNAUTHORIZED, message: 'Token missing required session claims' });
            }
            const blacklistCheckResult = await this.checkBlacklist(payload);
            if (blacklistCheckResult === 'unavailable') {
                throw new common_1.ServiceUnavailableException('Service temporarily unavailable. Please try again later.');
            }
            if (blacklistCheckResult === 'revoked') {
                throw new common_1.UnauthorizedException({ code: ErrorCodes.UNAUTHORIZED, message: 'Token has been revoked' });
            }
            if (blacklistCheckResult === 'session_revoked') {
                throw new common_1.UnauthorizedException({ code: ErrorCodes.SESSION_REVOKED, message: 'Session has been revoked' });
            }
            const databaseAuthResult = await this.checkDatabaseAuthorization(payload);
            if (databaseAuthResult === 'unavailable') {
                throw new common_1.ServiceUnavailableException('Service temporarily unavailable. Please try again later.');
            }
            if (databaseAuthResult === 'revoked') {
                throw new common_1.UnauthorizedException({ code: ErrorCodes.SESSION_REVOKED, message: 'Session has been revoked' });
            }
            if (databaseAuthResult === 'account_disabled') {
                throw new common_1.UnauthorizedException({ code: ErrorCodes.UNAUTHORIZED, message: 'Invalid or expired token' });
            }
            request.user = payload;
            return true;
        }
        catch (error) {
            if (error instanceof common_1.UnauthorizedException)
                throw error;
            if (error instanceof common_1.ServiceUnavailableException)
                throw error;
            throw new common_1.UnauthorizedException({ code: ErrorCodes.UNAUTHORIZED, message: 'Invalid or expired token' });
        }
    }
    isFailOpenEnabled() {
        return this.configService.get('app.redisAuthFailOpen') === true;
    }
    async checkBlacklist(payload) {
        if (await this.isCircuitOpen()) {
            if (this.isFailOpenEnabled()) {
                this.logger.warn('Redis circuit open — allowing cryptographically valid token (fail-open mode)');
                return 'ok';
            }
            this.logger.warn('Redis circuit open — rejecting request (fail-closed)');
            return 'unavailable';
        }
        try {
            if (payload.jti) {
                const isBlacklisted = await this.redisService.get((0, redis_keys_1.TOKEN_BLACKLIST)(payload.jti), { throwOnError: true });
                if (isBlacklisted) {
                    await this.recordRedisSuccess();
                    return 'revoked';
                }
            }
            if (payload.sessionId) {
                const sessionRevoked = await this.redisService.get((0, redis_keys_1.SESSION_REVOKED_KEY)(payload.sessionId), { throwOnError: true });
                if (sessionRevoked) {
                    await this.recordRedisSuccess();
                    return 'session_revoked';
                }
            }
            await this.recordRedisSuccess();
            return 'ok';
        }
        catch {
            await this.recordRedisFailure();
            if (this.isFailOpenEnabled()) {
                this.logger.warn('Redis unavailable — allowing cryptographically valid token (fail-open mode)');
                return 'ok';
            }
            this.logger.warn('Redis unavailable — rejecting request (fail-closed)');
            return 'unavailable';
        }
    }
    async checkDatabaseAuthorization(payload) {
        if (!payload.sub)
            return 'revoked';
        try {
            if (payload.sessionId) {
                const session = await this.prismaService.userSession.findUnique({
                    where: { id: payload.sessionId },
                    select: {
                        userId: true,
                        isRevoked: true,
                        expiresAt: true,
                        user: { select: { isActive: true, isBanned: true, deletedAt: true } },
                    },
                });
                if (!session || session.userId !== payload.sub || session.isRevoked || session.expiresAt <= new Date()) {
                    return 'revoked';
                }
                if (!session.user.isActive || session.user.isBanned || session.user.deletedAt) {
                    return 'account_disabled';
                }
                return 'ok';
            }
            const user = await this.prismaService.user.findUnique({
                where: { id: payload.sub },
                select: { isActive: true, isBanned: true, deletedAt: true },
            });
            if (!user)
                return 'revoked';
            if (!user.isActive || user.isBanned || user.deletedAt)
                return 'account_disabled';
            return 'ok';
        }
        catch (error) {
            this.logger.error(`Database authorization check failed: ${error.message}`);
            return 'unavailable';
        }
    }
    extractTokenFromHeader(request) {
        const match = /^Bearer\s+(\S+)$/i.exec(request.headers.authorization ?? '');
        return match?.[1];
    }
    extractTokenFromCookie(request) {
        return request.cookies?.kahade_access_token;
    }
};
exports.JwtAuthGuard = JwtAuthGuard;
exports.JwtAuthGuard = JwtAuthGuard = JwtAuthGuard_1 = __decorate([
    (0, common_1.Injectable)(),
    __param(2, (0, common_1.Optional)()),
    __param(2, (0, common_1.Inject)(exports.ADMIN_JWT_SERVICE)),
    __metadata("design:paramtypes", [core_1.Reflector,
        jwt_1.JwtService, Object, redis_service_1.RedisService,
        config_1.ConfigService,
        prisma_service_1.PrismaService])
], JwtAuthGuard);
