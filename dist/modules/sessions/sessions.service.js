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
var SessionsService_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.SessionsService = void 0;
const common_1 = require("@nestjs/common");
const config_1 = require("@nestjs/config");
const client_1 = require("@prisma/client");
const prisma_service_1 = require("../../prisma/prisma.service");
const redis_service_1 = require("../../redis/redis.service");
const redis_keys_1 = require("../../common/constants/redis-keys");
const ErrorCodes = __importStar(require("../../common/constants/error-codes"));
const jwt_util_1 = require("../../common/utils/jwt.util");
let SessionsService = SessionsService_1 = class SessionsService {
    constructor(prisma, redis, configService) {
        this.prisma = prisma;
        this.redis = redis;
        this.configService = configService;
        this.logger = new common_1.Logger(SessionsService_1.name);
        this.accessTokenTtlSeconds = (0, jwt_util_1.parseJwtTtl)(this.configService.get('jwt.expiresIn') ?? '15m');
    }
    async getActiveSessions(userId, currentSessionId, page = 1, limit = 50) {
        const safePage = Number.isFinite(page) ? Math.max(1, Math.floor(page)) : 1;
        const safeLimit = Number.isFinite(limit) ? Math.min(Math.max(1, Math.floor(limit)), 50) : 50;
        const where = {
            userId,
            isRevoked: false,
            expiresAt: { gt: new Date() },
        };
        const [sessions, total] = await Promise.all([
            this.prisma.userSession.findMany({
                where,
                orderBy: { lastActiveAt: 'desc' },
                take: safeLimit,
                skip: (safePage - 1) * safeLimit,
                select: {
                    id: true,
                    deviceInfo: true,
                    ipAddress: true,
                    lastActiveAt: true,
                    createdAt: true,
                },
            }),
            this.prisma.userSession.count({ where }),
        ]);
        return {
            sessions: sessions.map((session) => ({
                id: session.id,
                deviceInfo: session.deviceInfo,
                ipAddress: this.maskIpAddress(session.ipAddress),
                lastActiveAt: session.lastActiveAt,
                createdAt: session.createdAt,
                isCurrentSession: session.id === currentSessionId,
            })),
            total,
            page: safePage,
            limit: safeLimit,
        };
    }
    maskIpAddress(ip) {
        if (!ip)
            return null;
        if (ip.includes(':')) {
            const full = this.expandIPv6(ip);
            const groups = full.split(':');
            return groups.slice(0, 4).join(':') + ':****:****:****:****';
        }
        const parts = ip.split('.');
        if (parts.length === 4) {
            return `${parts[0]}.${parts[1]}.***.***`;
        }
        return '***';
    }
    expandIPv6(ip) {
        let addr = ip;
        if (addr.startsWith('::ffff:') && addr.includes('.')) {
            return '::ffff:***:***';
        }
        if (addr.includes('::')) {
            const [left, right] = addr.split('::');
            const leftGroups = left ? left.split(':') : [];
            const rightGroups = right ? right.split(':') : [];
            const missing = 8 - leftGroups.length - rightGroups.length;
            const middle = Array(missing).fill('0000');
            addr = [...leftGroups, ...middle, ...rightGroups].join(':');
        }
        return addr.split(':').map(g => g.padStart(4, '0')).join(':');
    }
    async revokeSession(userId, sessionId) {
        const revokedId = await this.prisma.$transaction(async (tx) => {
            const session = await tx.userSession.findUnique({ where: { id: sessionId } });
            if (!session) {
                throw new common_1.NotFoundException({ code: ErrorCodes.SESSION_NOT_FOUND, message: 'Session not found' });
            }
            if (session.userId !== userId) {
                throw new common_1.ForbiddenException({ code: ErrorCodes.SESSION_NOT_OWNED, message: 'Session not owned by user' });
            }
            if (session.isRevoked) {
                throw new common_1.BadRequestException({ code: ErrorCodes.SESSION_ALREADY_REVOKED, message: 'Session already revoked' });
            }
            await tx.userSession.update({
                where: { id: sessionId },
                data: { isRevoked: true, revokedAt: new Date(), revokedReason: 'user_revoke' },
            });
            return sessionId;
        }, { isolationLevel: client_1.Prisma.TransactionIsolationLevel.Serializable });
        await this.redis.setex((0, redis_keys_1.SESSION_REVOKED_KEY)(revokedId), this.accessTokenTtlSeconds, '1', { throwOnError: true })
            .catch((error) => {
            this.logger.warn(`[SECURITY] Session revocation persisted but Redis propagation is unavailable: ${error instanceof Error ? error.message : String(error)}`);
        });
        return { message: 'Session revoked' };
    }
    async revokeAllOtherSessions(userId, currentSessionId) {
        const revokedIds = await this.prisma.$transaction(async (tx) => {
            const sessions = await tx.userSession.findMany({
                where: { userId, id: { not: currentSessionId }, isRevoked: false },
                select: { id: true },
            });
            if (sessions.length === 0)
                return [];
            await tx.userSession.updateMany({
                where: { userId, id: { not: currentSessionId }, isRevoked: false },
                data: { isRevoked: true, revokedAt: new Date(), revokedReason: 'revoke_all' },
            });
            return sessions.map((s) => s.id);
        }, { isolationLevel: client_1.Prisma.TransactionIsolationLevel.Serializable });
        if (revokedIds.length > 0) {
            await Promise.all(revokedIds.map((id) => this.redis.setex((0, redis_keys_1.SESSION_REVOKED_KEY)(id), this.accessTokenTtlSeconds, '1', { throwOnError: true }))).catch((error) => {
                this.logger.warn(`[SECURITY] Other-session revocations persisted but Redis propagation is unavailable: ${error instanceof Error ? error.message : String(error)}`);
            });
        }
        return { count: revokedIds.length };
    }
};
exports.SessionsService = SessionsService;
exports.SessionsService = SessionsService = SessionsService_1 = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [prisma_service_1.PrismaService,
        redis_service_1.RedisService,
        config_1.ConfigService])
], SessionsService);
