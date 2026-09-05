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
var IdempotencyInterceptor_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.IdempotencyInterceptor = void 0;
const common_1 = require("@nestjs/common");
const config_1 = require("@nestjs/config");
const crypto_1 = require("crypto");
const client_1 = require("@prisma/client");
const rxjs_1 = require("rxjs");
const core_1 = require("@nestjs/core");
const redis_service_1 = require("../../redis/redis.service");
const prisma_service_1 = require("../../prisma/prisma.service");
const idempotency_decorator_1 = require("../decorators/idempotency.decorator");
const redis_keys_1 = require("../constants/redis-keys");
const app_constants_1 = require("../constants/app.constants");
const ErrorCodes = __importStar(require("../constants/error-codes"));
function canonicalize(value) {
    if (Array.isArray(value))
        return value.map(canonicalize);
    if (value && typeof value === 'object') {
        return Object.fromEntries(Object.entries(value)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([key, child]) => [key, canonicalize(child)]));
    }
    return value;
}
function requestFingerprint(body) {
    return (0, crypto_1.createHash)('sha256')
        .update(JSON.stringify(canonicalize(body ?? null)))
        .digest('hex');
}
function isMoneyMovementPath(path) {
    return (path.includes('/wallet/') ||
        path === '/wallet' ||
        path.startsWith('/bank-accounts') ||
        path.startsWith('/withdrawals/schedules') ||
        path.startsWith('/admin/finance'));
}
function makeInFlightSentinel() {
    return JSON.stringify({ status: 'in_flight', ts: Date.now() });
}
function isInFlightSentinel(value) {
    try {
        const parsed = JSON.parse(value);
        return parsed && parsed.status === 'in_flight';
    }
    catch {
        return false;
    }
}
let IdempotencyInterceptor = IdempotencyInterceptor_1 = class IdempotencyInterceptor {
    constructor(reflector, redisService, configService, prismaService) {
        this.reflector = reflector;
        this.redisService = redisService;
        this.configService = configService;
        this.prismaService = prismaService;
        this.logger = new common_1.Logger(IdempotencyInterceptor_1.name);
    }
    get ttl() {
        return this.configService.get('app.idempotencyTtlSeconds') ?? app_constants_1.IDEMPOTENCY_TTL;
    }
    async intercept(context, next) {
        const isIdempotencyRequired = this.reflector.getAllAndOverride(idempotency_decorator_1.IDEMPOTENCY_KEY, [
            context.getHandler(),
            context.getClass(),
        ]);
        if (!isIdempotencyRequired) {
            return next.handle();
        }
        const request = context.switchToHttp().getRequest();
        const idempotencyKey = request.headers['idempotency-key'];
        if (!idempotencyKey) {
            throw new common_1.BadRequestException({
                code: ErrorCodes.IDEMPOTENCY_KEY_REQUIRED,
                message: 'Idempotency-Key header (UUID v4) is required',
            });
        }
        const UUID_V4_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
        if (!UUID_V4_REGEX.test(idempotencyKey)) {
            throw new common_1.BadRequestException({
                code: ErrorCodes.INVALID_IDEMPOTENCY_KEY,
                message: 'Idempotency-Key must be a valid UUID v4 (e.g. xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx)',
            });
        }
        const payload = (request.admin ?? request.user);
        const scopeId = payload?.sub ?? payload?.userId;
        const requestPath = String(request.originalUrl ?? request.url ?? 'unknown').split('?')[0];
        const fingerprint = requestFingerprint(request.body);
        const scopeKey = `${scopeId ?? 'anonymous'}:${String(request.method ?? 'POST').toUpperCase()}:${requestPath}:${idempotencyKey}`;
        const cacheKey = (0, redis_keys_1.IDEMPOTENCY_CACHE_KEY)(scopeKey);
        let claim;
        let durableRecord = true;
        try {
            claim = await this.claimDurably(scopeKey, idempotencyKey, scopeId, fingerprint);
        }
        catch (error) {
            if (error instanceof common_1.BadRequestException) {
                throw error;
            }
            if (isMoneyMovementPath(requestPath)) {
                this.logger.error(`[IdempotencyInterceptor] Durable ledger unavailable for Money Movement route: ${error.message}`);
                throw new common_1.ServiceUnavailableException({
                    code: ErrorCodes.IDEMPOTENCY_SERVICE_UNAVAILABLE,
                    message: 'Financial mutation safety service unavailable. Please retry after a short delay.',
                });
            }
            durableRecord = false;
            this.logger.error(`[IdempotencyInterceptor] PostgreSQL ledger unavailable; using Redis fallback: ${error.message}`);
            claim = await this.claimWithRedis(cacheKey, idempotencyKey);
        }
        if (!claim.acquired) {
            if ('responseBody' in claim) {
                return (0, rxjs_1.of)(claim.responseBody);
            }
            throw new common_1.BadRequestException({
                code: ErrorCodes.IDEMPOTENCY_KEY_IN_USE,
                message: 'A request with this Idempotency-Key is already being processed. Please retry shortly.',
            });
        }
        const MAX_IDEMPOTENCY_RESPONSE_SIZE = 512 * 1024;
        const recordId = durableRecord ? claim.recordId : undefined;
        await this.redisService
            .setNx(cacheKey, makeInFlightSentinel(), this.ttl)
            .catch((error) => {
            this.logger.warn(`[IdempotencyInterceptor] Redis sentinel unavailable; PostgreSQL ledger remains authoritative: ${error.message}`);
        });
        return next.handle().pipe((0, rxjs_1.switchMap)(async (response) => {
            const serialized = JSON.stringify(response) ?? 'null';
            if (recordId) {
                try {
                    await this.prismaService.idempotencyRecord.update({
                        where: { id: recordId },
                        data: {
                            status: client_1.IdempotencyRecordStatus.COMPLETED,
                            responseBody: JSON.parse(serialized),
                            statusCode: 200,
                            completedAt: new Date(),
                            expiresAt: new Date(Date.now() + this.ttl * 1000),
                            errorMessage: null,
                        },
                    });
                }
                catch (error) {
                    this.logger.error(`[IdempotencyInterceptor] Ledger completion failed; keeping claim for key ${scopeKey}: ${error.message}`);
                }
            }
            if (serialized.length <= MAX_IDEMPOTENCY_RESPONSE_SIZE) {
                try {
                    await this.redisService.setex(cacheKey, this.ttl, serialized, { throwOnError: true });
                }
                catch (error) {
                    this.logger.error(`[IdempotencyInterceptor] Response cache failed after mutation success for key ${cacheKey}: ${error.message}`);
                }
            }
            else {
                this.logger.warn(`[IdempotencyInterceptor] Response too large (${serialized.length} bytes) for key ${cacheKey}; durable ledger remains authoritative`);
            }
            return response;
        }), (0, rxjs_1.catchError)((err) => {
            if (recordId) {
                this.prismaService.idempotencyRecord
                    .delete({ where: { id: recordId } })
                    .catch((error) => {
                    this.logger.error(`[IdempotencyInterceptor] Failed to remove failed ledger claim for key ${scopeKey}: ${error.message}`);
                });
            }
            this.redisService.del(cacheKey).catch((error) => {
                this.logger.error(`[IdempotencyInterceptor] Failed to clean up Redis sentinel for key ${cacheKey}: ${error.message}`);
            });
            return (0, rxjs_1.throwError)(() => err);
        }));
    }
    async claimDurably(scopeKey, key, userId, requestHash) {
        const now = new Date();
        const expiresAt = new Date(now.getTime() + this.ttl * 1000);
        for (let attempt = 0; attempt < 2; attempt += 1) {
            const existing = await this.prismaService.idempotencyRecord.findUnique({
                where: { scopeKey },
            });
            if (!existing) {
                try {
                    const created = await this.prismaService.idempotencyRecord.create({
                        data: {
                            scopeKey,
                            key,
                            userId,
                            requestHash,
                            status: client_1.IdempotencyRecordStatus.IN_FLIGHT,
                            expiresAt,
                        },
                        select: { id: true },
                    });
                    return { acquired: true, recordId: created.id };
                }
                catch (error) {
                    if (error.code === 'P2002')
                        continue;
                    throw error;
                }
            }
            if (existing.expiresAt > now) {
                if (existing.requestHash && existing.requestHash !== requestHash) {
                    throw new common_1.BadRequestException({
                        code: ErrorCodes.IDEMPOTENCY_KEY_REUSE,
                        message: 'Idempotency-Key was already used with a different request payload.',
                    });
                }
                if (existing.status === client_1.IdempotencyRecordStatus.COMPLETED) {
                    return { acquired: false, responseBody: existing.responseBody };
                }
                return { acquired: false, inFlight: true };
            }
            const reclaimed = await this.prismaService.idempotencyRecord.updateMany({
                where: { id: existing.id, expiresAt: { lte: now } },
                data: {
                    key,
                    userId,
                    requestHash,
                    status: client_1.IdempotencyRecordStatus.IN_FLIGHT,
                    responseBody: client_1.Prisma.JsonNull,
                    statusCode: 200,
                    errorMessage: null,
                    completedAt: null,
                    expiresAt,
                },
            });
            if (reclaimed.count === 1)
                return { acquired: true, recordId: existing.id };
        }
        return { acquired: false, inFlight: true };
    }
    async claimWithRedis(cacheKey, idempotencyKey) {
        let acquired;
        try {
            acquired = await this.redisService.setNx(cacheKey, makeInFlightSentinel(), this.ttl);
        }
        catch {
            const failOpen = this.configService.get('app.idempotencyFailOpen') === true;
            if (failOpen) {
                this.logger.warn(`[IdempotencyInterceptor] Redis unavailable (fail-open) — bypassing idempotency for key: ${idempotencyKey}`);
                return { acquired: true, recordId: '' };
            }
            throw new common_1.ServiceUnavailableException({
                code: ErrorCodes.IDEMPOTENCY_SERVICE_UNAVAILABLE,
                message: 'Idempotency service unavailable. Please retry after a short delay.',
            });
        }
        if (acquired)
            return { acquired: true, recordId: '' };
        let cachedResponse = null;
        try {
            cachedResponse = await this.redisService.get(cacheKey);
        }
        catch {
            throw new common_1.ServiceUnavailableException({
                code: ErrorCodes.IDEMPOTENCY_SERVICE_UNAVAILABLE,
                message: 'Idempotency check failed. Please retry after a short delay.',
            });
        }
        if (cachedResponse && !isInFlightSentinel(cachedResponse)) {
            try {
                return { acquired: false, responseBody: JSON.parse(cachedResponse) };
            }
            catch {
                await this.redisService.del(cacheKey).catch(() => undefined);
                return { acquired: true, recordId: '' };
            }
        }
        throw new common_1.BadRequestException({
            code: ErrorCodes.IDEMPOTENCY_KEY_IN_USE,
            message: 'A request with this Idempotency-Key is already being processed. Please retry shortly.',
        });
    }
};
exports.IdempotencyInterceptor = IdempotencyInterceptor;
exports.IdempotencyInterceptor = IdempotencyInterceptor = IdempotencyInterceptor_1 = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [core_1.Reflector,
        redis_service_1.RedisService,
        config_1.ConfigService,
        prisma_service_1.PrismaService])
], IdempotencyInterceptor);
