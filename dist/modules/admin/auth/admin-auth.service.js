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
var AdminAuthService_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.AdminAuthService = void 0;
const common_1 = require("@nestjs/common");
const config_1 = require("@nestjs/config");
const speakeasy = __importStar(require("speakeasy"));
const client_1 = require("@prisma/client");
const prisma_service_1 = require("../../../prisma/prisma.service");
const redis_service_1 = require("../../../redis/redis.service");
const audit_log_service_1 = require("../../../common/services/audit-log.service");
const crypto_util_1 = require("../../../common/utils/crypto.util");
const token_service_1 = require("../../auth/token.service");
const redis_keys_1 = require("../../../common/constants/redis-keys");
const ErrorCodes = __importStar(require("../../../common/constants/error-codes"));
const ADMIN_LOCK_MAX_ATTEMPTS = 5;
const ADMIN_LOCK_DURATION_MINUTES = 30;
const ADMIN_2FA_MAX_ATTEMPTS = 5;
const DUMMY_HASH = '$2b$14$Kw0dKjm4DkJ5h8hfZKy6Ku8k1WdcM0X3PZ5kU5gRv5Y4Q3e5rN5uG';
let AdminAuthService = AdminAuthService_1 = class AdminAuthService {
    constructor(prisma, redis, configService, auditLogService, tokenService) {
        this.prisma = prisma;
        this.redis = redis;
        this.configService = configService;
        this.auditLogService = auditLogService;
        this.tokenService = tokenService;
        this.logger = new common_1.Logger(AdminAuthService_1.name);
    }
    async login(email, password, totpToken, ipAddress) {
        const normalizedEmail = email.toLowerCase();
        const admin = await this.prisma.adminUser.findUnique({ where: { email: normalizedEmail } });
        const hashToCompare = admin?.password ?? DUMMY_HASH;
        const isPasswordValid = await (0, crypto_util_1.bcryptCompare)(password, hashToCompare);
        if (!admin || !isPasswordValid) {
            if (admin) {
                if (!admin.isActive || admin.deletedAt) {
                    throw new common_1.UnauthorizedException({ code: ErrorCodes.INVALID_CREDENTIALS, message: 'Invalid email or password' });
                }
                if (admin.lockedUntil && admin.lockedUntil > new Date()) {
                    throw new common_1.UnauthorizedException({ code: ErrorCodes.INVALID_CREDENTIALS, message: 'Invalid email or password' });
                }
                const updated = await this.prisma.adminUser.update({
                    where: { id: admin.id },
                    data: { failedLoginAttempts: { increment: 1 } },
                    select: { failedLoginAttempts: true },
                });
                if (updated.failedLoginAttempts >= ADMIN_LOCK_MAX_ATTEMPTS) {
                    await this.prisma.adminUser.update({
                        where: { id: admin.id },
                        data: { lockedUntil: new Date(Date.now() + ADMIN_LOCK_DURATION_MINUTES * 60 * 1000) },
                    });
                }
            }
            throw new common_1.UnauthorizedException({
                code: ErrorCodes.INVALID_CREDENTIALS,
                message: 'Invalid email or password',
            });
        }
        if (!admin.isActive || admin.deletedAt) {
            this.logger.warn(`Admin login blocked (inactive/deleted) for ${normalizedEmail} from ${ipAddress}`);
            throw new common_1.UnauthorizedException({ code: ErrorCodes.INVALID_CREDENTIALS, message: 'Invalid email or password' });
        }
        if (admin.lockedUntil && admin.lockedUntil > new Date()) {
            this.logger.warn(`Admin login blocked (locked) for ${normalizedEmail} from ${ipAddress} until ${admin.lockedUntil.toISOString()}`);
            throw new common_1.UnauthorizedException({ code: ErrorCodes.INVALID_CREDENTIALS, message: 'Invalid email or password' });
        }
        const mfaRequired = await this.isAdminMfaRequired();
        if (mfaRequired && !admin.isMfaEnabled) {
            throw new common_1.ForbiddenException({
                code: ErrorCodes.MFA_NOT_CONFIGURED,
                message: '2FA is required for all admin accounts. Please contact a super admin to set up 2FA.',
            });
        }
        if (admin.isMfaEnabled) {
            if (!totpToken) {
                const tempToken = this.tokenService.signTempToken({ sub: admin.id, scope: 'admin_2fa_verify' });
                return { requiresMfa: true, tempToken };
            }
            if (!admin.mfaSecret) {
                throw new common_1.UnauthorizedException({
                    code: ErrorCodes.MFA_NOT_CONFIGURED,
                    message: '2FA is not configured for this account',
                });
            }
            const inlineAttemptKey = (0, redis_keys_1.ADMIN_2FA_ATTEMPT_KEY)(`admin:${admin.id}:inline`);
            const inlineAttempts = await this.redis.incr(inlineAttemptKey);
            if (inlineAttempts === 1) {
                await this.redis.expire(inlineAttemptKey, 15 * 60);
            }
            if (inlineAttempts > ADMIN_2FA_MAX_ATTEMPTS) {
                throw new common_1.UnauthorizedException({
                    code: ErrorCodes.TOO_MANY_REQUESTS,
                    message: 'Too many 2FA attempts. Please wait.',
                });
            }
            const decryptedSecret = await (0, crypto_util_1.decryptAES)(admin.mfaSecret);
            const isValidTotp = speakeasy.totp.verify({
                secret: decryptedSecret,
                encoding: 'base32',
                token: totpToken,
                window: 1,
            });
            if (!isValidTotp) {
                throw new common_1.UnauthorizedException({
                    code: ErrorCodes.INVALID_MFA,
                    message: 'Invalid 2FA code',
                });
            }
            await this.claimTotpCode(admin.id, totpToken);
            await this.redis.del(inlineAttemptKey, { throwOnError: true });
        }
        await this.prisma.adminUser.update({
            where: { id: admin.id },
            data: {
                failedLoginAttempts: 0,
                lockedUntil: null,
                lastLoginAt: new Date(),
                lastLoginIp: ipAddress,
            },
        });
        const accessToken = this.tokenService.signAdminAccessToken({
            sub: admin.id,
            adminId: admin.adminId,
            email: admin.email,
            role: admin.role,
        });
        const refreshToken = this.tokenService.signAdminRefreshToken({ sub: admin.id });
        this.logger.log(`Admin login: ${admin.adminId} [${admin.role}] dari ${ipAddress}`);
        this.auditLogService.logAdminAction({
            adminId: admin.id,
            action: client_1.AuditAction.ADMIN_LOGIN,
            targetType: 'AdminUser',
            targetId: admin.id,
            description: `Admin ${admin.adminId} logged in`,
            ipAddress: ipAddress ?? 'unknown',
        });
        return {
            accessToken,
            refreshToken,
            admin: {
                id: admin.id,
                adminId: admin.adminId,
                fullName: admin.fullName,
                email: admin.email,
                role: admin.role,
                isActive: admin.isActive,
                isMfaEnabled: admin.isMfaEnabled,
                lastLoginAt: admin.lastLoginAt ? admin.lastLoginAt.toISOString() : null,
            },
        };
    }
    async verifyAdmin2fa(tempToken, totpToken, ipAddress) {
        let payload;
        try {
            payload = this.tokenService.verifyTempToken(tempToken);
        }
        catch {
            throw new common_1.UnauthorizedException({ code: ErrorCodes.TEMP_TOKEN_EXPIRED, message: '2FA session expired, please log in again' });
        }
        if (payload.scope !== 'admin_2fa_verify') {
            throw new common_1.UnauthorizedException({ code: ErrorCodes.UNAUTHORIZED, message: 'Invalid token scope' });
        }
        if (payload.jti) {
            const alreadyConsumed = await this.redis.get((0, redis_keys_1.ADMIN_TOKEN_BLACKLIST)(payload.jti), { throwOnError: true });
            if (alreadyConsumed) {
                throw new common_1.UnauthorizedException({ code: ErrorCodes.TEMP_TOKEN_EXPIRED, message: '2FA session already used. Please log in again.' });
            }
        }
        const attemptKey = (0, redis_keys_1.ADMIN_2FA_ATTEMPT_KEY)(`admin:${payload.sub}:${payload.jti ?? 'no-jti'}`);
        const attempts = await this.redis.incr(attemptKey);
        if (attempts === 1) {
            await this.redis.expire(attemptKey, 15 * 60);
        }
        if (attempts > ADMIN_2FA_MAX_ATTEMPTS) {
            if (payload.jti) {
                const ttl = Math.max(60, 5 * 60);
                await this.redis.setex((0, redis_keys_1.ADMIN_TOKEN_BLACKLIST)(payload.jti), ttl, '1', { throwOnError: false });
            }
            throw new common_1.UnauthorizedException({ code: ErrorCodes.TOO_MANY_REQUESTS, message: 'Too many 2FA attempts. Please log in again.' });
        }
        const admin = await this.prisma.adminUser.findUnique({ where: { id: payload.sub } });
        if (!admin || !admin.isActive || admin.deletedAt) {
            throw new common_1.ForbiddenException({ code: ErrorCodes.ACCOUNT_INACTIVE, message: 'Admin account is inactive' });
        }
        if (admin.lockedUntil && admin.lockedUntil > new Date()) {
            throw new common_1.ForbiddenException({ code: ErrorCodes.ACCOUNT_LOCKED, message: 'Admin account is locked' });
        }
        if (!admin.mfaSecret) {
            throw new common_1.UnauthorizedException({ code: ErrorCodes.MFA_NOT_CONFIGURED, message: '2FA is not configured' });
        }
        const decryptedSecret = await (0, crypto_util_1.decryptAES)(admin.mfaSecret);
        const isValidTotp = speakeasy.totp.verify({ secret: decryptedSecret, encoding: 'base32', token: totpToken, window: 1 });
        if (!isValidTotp) {
            throw new common_1.UnauthorizedException({ code: ErrorCodes.INVALID_MFA, message: 'Invalid 2FA code' });
        }
        await this.claimTotpCode(admin.id, totpToken);
        await this.redis.del(attemptKey, { throwOnError: true });
        if (payload.jti) {
            await this.redis.setex((0, redis_keys_1.ADMIN_TOKEN_BLACKLIST)(payload.jti), 5 * 60, '1', { throwOnError: true });
        }
        await this.prisma.adminUser.update({
            where: { id: admin.id },
            data: { failedLoginAttempts: 0, lockedUntil: null, lastLoginAt: new Date(), lastLoginIp: ipAddress },
        });
        const accessToken = this.tokenService.signAdminAccessToken({
            sub: admin.id, adminId: admin.adminId, email: admin.email, role: admin.role,
        });
        const refreshToken = this.tokenService.signAdminRefreshToken({ sub: admin.id });
        this.logger.log(`Admin 2FA login: ${admin.adminId} [${admin.role}] dari ${ipAddress}`);
        this.auditLogService.logAdminAction({
            adminId: admin.id,
            action: client_1.AuditAction.ADMIN_LOGIN,
            targetType: 'AdminUser',
            targetId: admin.id,
            description: `Admin ${admin.adminId} logged in via 2FA`,
            ipAddress: ipAddress ?? 'unknown',
        });
        return {
            accessToken,
            refreshToken,
            admin: {
                id: admin.id,
                adminId: admin.adminId,
                fullName: admin.fullName,
                email: admin.email,
                role: admin.role,
                isActive: admin.isActive,
                isMfaEnabled: admin.isMfaEnabled,
                lastLoginAt: admin.lastLoginAt ? admin.lastLoginAt.toISOString() : null,
            },
        };
    }
    async refreshAdminToken(refreshToken) {
        try {
            const payload = this.tokenService.verifyAdminRefreshToken(refreshToken);
            if (payload.jti) {
                const isBlacklisted = await this.redis.get((0, redis_keys_1.ADMIN_REFRESH_BLACKLIST)(payload.jti), { throwOnError: true });
                if (isBlacklisted) {
                    throw new common_1.UnauthorizedException({
                        code: ErrorCodes.TOKEN_INVALID_OR_EXPIRED,
                        message: 'Refresh token is no longer valid (logged out)',
                    });
                }
            }
            const rotationLockKey = `admin_token_rotation:${payload.jti}`;
            const lockAcquired = await this.redis.setNx(rotationLockKey, '1', 15, { throwOnError: true });
            if (!lockAcquired) {
                throw new common_1.UnauthorizedException({
                    code: ErrorCodes.TOKEN_INVALID_OR_EXPIRED,
                    message: 'Token is being rotated. Please try again.',
                });
            }
            try {
                const admin = await this.prisma.adminUser.findUnique({ where: { id: payload.sub } });
                if (!admin || !admin.isActive || admin.deletedAt) {
                    throw new common_1.UnauthorizedException({
                        code: ErrorCodes.INVALID_CREDENTIALS,
                        message: 'Admin account not found or inactive',
                    });
                }
                if (admin.lockedUntil && admin.lockedUntil > new Date()) {
                    throw new common_1.UnauthorizedException({
                        code: ErrorCodes.ACCOUNT_LOCKED,
                        message: 'Admin account is locked',
                    });
                }
                const revokedAtRaw = await this.redis.get(`admin_revoked:${admin.id}`, { throwOnError: true });
                if (revokedAtRaw) {
                    const revokedAt = Number(revokedAtRaw);
                    const issuedAt = typeof payload.iat === 'number' ? payload.iat : 0;
                    const tokenRevoked = !Number.isFinite(revokedAt) || revokedAt <= 1 || issuedAt <= revokedAt;
                    if (tokenRevoked) {
                        throw new common_1.UnauthorizedException({
                            code: ErrorCodes.TOKEN_INVALID_OR_EXPIRED,
                            message: 'Admin refresh token has been revoked',
                        });
                    }
                }
                const newAccessToken = this.tokenService.signAdminAccessToken({
                    sub: admin.id,
                    adminId: admin.adminId,
                    email: admin.email,
                    role: admin.role,
                });
                const newRefreshToken = this.tokenService.signAdminRefreshToken({ sub: admin.id });
                if (payload.jti) {
                    const refreshTtlSeconds = this.getAdminRefreshTokenTtlSeconds();
                    await this.redis.setex((0, redis_keys_1.ADMIN_REFRESH_BLACKLIST)(payload.jti), refreshTtlSeconds, '1', { throwOnError: true });
                }
                return { accessToken: newAccessToken, refreshToken: newRefreshToken };
            }
            finally {
                await this.redis.del(rotationLockKey).catch((err) => this.logger.warn(`silent-catch: ${err instanceof Error ? err.message : String(err)}`));
            }
        }
        catch (err) {
            if (err instanceof common_1.UnauthorizedException)
                throw err;
            throw new common_1.UnauthorizedException({
                code: ErrorCodes.TOKEN_INVALID_OR_EXPIRED,
                message: 'Invalid or expired refresh token',
            });
        }
    }
    async claimTotpCode(adminId, totpToken) {
        const codeHash = (0, crypto_util_1.sha256)(totpToken);
        const replayKey = `${(0, redis_keys_1.TOTP_USED_CODE)(`admin:${adminId}`)}:${codeHash}`;
        const claimed = await this.redis.setNx(replayKey, '1', 90, { throwOnError: true });
        if (!claimed) {
            throw new common_1.BadRequestException({
                code: ErrorCodes.INVALID_MFA,
                message: '2FA code already used. Wait for the next code.',
            });
        }
    }
    async logout(adminId, accessTokenJti, ipAddress, refreshToken) {
        if (accessTokenJti) {
            const ttlSeconds = this.getAdminAccessTokenTtlSeconds();
            await this.redis.setex((0, redis_keys_1.ADMIN_TOKEN_BLACKLIST)(accessTokenJti), ttlSeconds, '1', { throwOnError: true });
            this.logger.log(`Admin access token blacklisted: jti=${accessTokenJti}`);
        }
        if (refreshToken) {
            try {
                const payload = this.tokenService.verifyAdminRefreshToken(refreshToken);
                if (payload.jti) {
                    const refreshTtlSeconds = this.getAdminRefreshTokenTtlSeconds();
                    await this.redis.setex((0, redis_keys_1.ADMIN_REFRESH_BLACKLIST)(payload.jti), refreshTtlSeconds, '1', { throwOnError: true });
                    this.logger.log(`Admin refresh token blacklisted: jti=${payload.jti}`);
                }
            }
            catch {
                this.logger.debug('Admin refresh token already expired/invalid during logout');
            }
        }
        this.auditLogService.logAdminAction({
            adminId,
            action: client_1.AuditAction.ADMIN_LOGOUT,
            targetType: 'AdminUser',
            targetId: adminId,
            description: 'Admin logged out',
            ipAddress,
        });
        return { message: 'Logout successful' };
    }
    async getProfile(adminId) {
        const admin = await this.prisma.adminUser.findUnique({
            where: { id: adminId },
            select: {
                id: true, adminId: true, fullName: true, email: true, role: true,
                isActive: true, isMfaEnabled: true, lastLoginAt: true, lastLoginIp: true,
            },
        });
        if (!admin)
            throw new common_1.UnauthorizedException({ code: ErrorCodes.ADMIN_NOT_FOUND, message: 'Admin not found' });
        return admin;
    }
    getAdminAccessTokenTtlSeconds() {
        const expiresIn = this.configService.get('jwt.adminExpiresIn') ?? '30m';
        const match = expiresIn.match(/^(\d+)([smhd])$/);
        if (!match)
            return 30 * 60;
        const value = parseInt(match[1], 10);
        const multipliers = { s: 1, m: 60, h: 3600, d: 86400 };
        return value * (multipliers[match[2]] ?? 60);
    }
    getAdminRefreshTokenTtlSeconds() {
        const expiresIn = this.configService.get('jwt.adminRefreshExpiresIn') ?? '7d';
        const match = expiresIn.match(/^(\d+)([smhd])$/);
        if (!match)
            return 7 * 24 * 3600;
        const value = parseInt(match[1], 10);
        const multipliers = { s: 1, m: 60, h: 3600, d: 86400 };
        return value * (multipliers[match[2]] ?? 60);
    }
    async isAdminMfaRequired() {
        try {
            const config = await this.prisma.systemConfig.findUnique({
                where: { key: 'admin_mfa_required' },
            });
            return config?.value === 'true';
        }
        catch (err) {
            this.logger.error('Failed to check admin MFA requirement from DB — defaulting to required (fail-closed)', err);
            return true;
        }
    }
};
exports.AdminAuthService = AdminAuthService;
exports.AdminAuthService = AdminAuthService = AdminAuthService_1 = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [prisma_service_1.PrismaService,
        redis_service_1.RedisService,
        config_1.ConfigService,
        audit_log_service_1.AuditLogService,
        token_service_1.TokenService])
], AdminAuthService);
