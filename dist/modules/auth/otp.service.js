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
Object.defineProperty(exports, "__esModule", { value: true });
exports.OtpService = void 0;
const common_1 = require("@nestjs/common");
const config_1 = require("@nestjs/config");
class TooManyRequestsException extends common_1.HttpException {
    constructor(message = 'Too many requests') {
        super({ message, statusCode: common_1.HttpStatus.TOO_MANY_REQUESTS }, common_1.HttpStatus.TOO_MANY_REQUESTS);
    }
}
const prisma_service_1 = require("../../prisma/prisma.service");
const redis_service_1 = require("../../redis/redis.service");
const client_1 = require("@prisma/client");
const otp_util_1 = require("../../common/utils/otp.util");
const date_util_1 = require("../../common/utils/date.util");
const redis_keys_1 = require("../../common/constants/redis-keys");
const app_constants_1 = require("../../common/constants/app.constants");
const bcrypt = __importStar(require("bcrypt"));
const OTP_COOLDOWN_SECONDS = 60;
const OTP_EMAIL_RATE_LIMIT = 10;
const OTP_PHONE_RATE_LIMIT = 10;
const OTP_RATE_WINDOW_SECONDS = 3600;
const OTP_IP_RATE_LIMIT = 20;
const OTP_IP_RATE_WINDOW_SECONDS = 3600;
const DUMMY_OTP_HASH = '$2b$12$EixZaYVK1fsbw1ZfbX3OXePaWxn96p36WQoeG6Lruj3vjPGga31lW';
let OtpService = class OtpService {
    constructor(prisma, redis, configService) {
        this.prisma = prisma;
        this.redis = redis;
        this.configService = configService;
    }
    async generateOtp(email, type, userId, metadata, ipAddress) {
        const cooldownKey = (0, redis_keys_1.OTP_COOLDOWN)(email, type);
        const cooldownClaimed = await this.redis.setNx(cooldownKey, '1', OTP_COOLDOWN_SECONDS);
        if (!cooldownClaimed) {
            throw new TooManyRequestsException(`Please wait ${OTP_COOLDOWN_SECONDS} seconds before requesting a new OTP`);
        }
        try {
            if (ipAddress) {
                const ipRateKey = (0, redis_keys_1.OTP_IP_RATE)(ipAddress);
                const ipCount = await this.redis.incr(ipRateKey);
                if (ipCount === 1) {
                    await this.redis.expire(ipRateKey, OTP_IP_RATE_WINDOW_SECONDS);
                }
                if (ipCount > OTP_IP_RATE_LIMIT) {
                    throw new TooManyRequestsException('Too many OTP requests from this IP. Please try again later.');
                }
            }
            const emailRateKey = (0, redis_keys_1.OTP_EMAIL_RATE)(email, type);
            const emailCount = await this.redis.incr(emailRateKey);
            if (emailCount === 1) {
                await this.redis.expire(emailRateKey, OTP_RATE_WINDOW_SECONDS);
            }
            if (emailCount > OTP_EMAIL_RATE_LIMIT) {
                throw new TooManyRequestsException('Too many OTP requests for this email. Please try again later.');
            }
            const otp = (0, otp_util_1.generateOtp)(6);
            const hashedOtp = await (0, otp_util_1.hashOtp)(otp);
            const otpMinutes = this.configService.get('app.otpExpiresMinutes') ?? app_constants_1.OTP_EXPIRES_MINUTES;
            const expiresAt = (0, date_util_1.addMinutes)(new Date(), otpMinutes);
            await this.prisma.$transaction(async (tx) => {
                await tx.otpCode.updateMany({
                    where: { email, type, isUsed: false },
                    data: { isUsed: true, usedAt: new Date() },
                });
                await tx.otpCode.create({
                    data: { email, code: hashedOtp, type, userId, metadata: metadata || {}, expiresAt },
                });
            }, { isolationLevel: client_1.Prisma.TransactionIsolationLevel.Serializable });
            return otp;
        }
        catch (error) {
            await this.redis.del(cooldownKey);
            throw error;
        }
    }
    async generatePhoneOtp(phone, type, method, userId, metadata, ipAddress) {
        const cooldownKey = (0, redis_keys_1.OTP_COOLDOWN)(phone, type);
        const cooldownClaimed = await this.redis.setNx(cooldownKey, '1', OTP_COOLDOWN_SECONDS);
        if (!cooldownClaimed) {
            throw new TooManyRequestsException(`Please wait ${OTP_COOLDOWN_SECONDS} seconds before requesting a new OTP`);
        }
        try {
            if (ipAddress) {
                const ipRateKey = (0, redis_keys_1.OTP_IP_RATE)(ipAddress);
                const ipCount = await this.redis.incr(ipRateKey);
                if (ipCount === 1) {
                    await this.redis.expire(ipRateKey, OTP_IP_RATE_WINDOW_SECONDS);
                }
                if (ipCount > OTP_IP_RATE_LIMIT) {
                    throw new TooManyRequestsException('Too many OTP requests from this IP. Please try again later.');
                }
            }
            const phoneRateKey = (0, redis_keys_1.OTP_PHONE_RATE)(phone, type);
            const phoneCount = await this.redis.incr(phoneRateKey);
            if (phoneCount === 1) {
                await this.redis.expire(phoneRateKey, OTP_RATE_WINDOW_SECONDS);
            }
            if (phoneCount > OTP_PHONE_RATE_LIMIT) {
                throw new TooManyRequestsException('Too many OTP requests for this phone number. Please try again later.');
            }
            const otp = (0, otp_util_1.generateOtp)(6);
            const hashedOtp = await (0, otp_util_1.hashOtp)(otp);
            const otpMinutes = this.configService.get('app.otpExpiresMinutes') ?? app_constants_1.OTP_EXPIRES_MINUTES;
            const expiresAt = (0, date_util_1.addMinutes)(new Date(), otpMinutes);
            await this.prisma.$transaction(async (tx) => {
                await tx.otpCode.updateMany({
                    where: { phone, type, isUsed: false },
                    data: { isUsed: true, usedAt: new Date() },
                });
                await tx.otpCode.create({
                    data: { phone, code: hashedOtp, type, method, userId, metadata: metadata || {}, expiresAt },
                });
            }, { isolationLevel: client_1.Prisma.TransactionIsolationLevel.Serializable });
            return otp;
        }
        catch (error) {
            await this.redis.del(cooldownKey);
            throw error;
        }
    }
    async verifyPhoneOtp(phone, type, code) {
        const now = new Date();
        const result = await this.prisma.$transaction(async (tx) => {
            const record = await tx.otpCode.findFirst({
                where: { phone, type, isUsed: false, expiresAt: { gt: now }, attempts: { lt: app_constants_1.OTP_MAX_ATTEMPTS } },
                orderBy: { createdAt: 'desc' },
            });
            if (!record) {
                await bcrypt.compare('dummy_constant_time_sentinel', DUMMY_OTP_HASH);
                return false;
            }
            const bump = await tx.otpCode.updateMany({
                where: { id: record.id, isUsed: false, expiresAt: { gt: now }, attempts: { lt: app_constants_1.OTP_MAX_ATTEMPTS } },
                data: { attempts: { increment: 1 } },
            });
            if (bump.count === 0)
                return false;
            const isValid = await (0, otp_util_1.verifyOtp)(code, record.code);
            if (!isValid)
                return false;
            const used = await tx.otpCode.updateMany({
                where: { id: record.id, isUsed: false },
                data: { isUsed: true, usedAt: new Date() },
            });
            if (used.count === 1) {
                return { verified: true, phone: record.phone, type: record.type };
            }
            return false;
        }, { isolationLevel: client_1.Prisma.TransactionIsolationLevel.Serializable });
        return !!result;
    }
    async verifyPhoneOtpWithMetadata(phone, type, code, options = {}) {
        const now = new Date();
        const consume = options.consume !== false;
        const result = await this.prisma.$transaction(async (tx) => {
            const record = await tx.otpCode.findFirst({
                where: { phone, type, isUsed: false, expiresAt: { gt: now }, attempts: { lt: app_constants_1.OTP_MAX_ATTEMPTS } },
                orderBy: { createdAt: 'desc' },
            });
            if (!record) {
                await bcrypt.compare('dummy_constant_time_sentinel', DUMMY_OTP_HASH);
                return null;
            }
            const bump = await tx.otpCode.updateMany({
                where: { id: record.id, isUsed: false, expiresAt: { gt: now }, attempts: { lt: app_constants_1.OTP_MAX_ATTEMPTS } },
                data: { attempts: { increment: 1 } },
            });
            if (bump.count === 0)
                return null;
            if (!await (0, otp_util_1.verifyOtp)(code, record.code))
                return null;
            if (!consume) {
                return { verified: true, otpId: record.id, metadata: record.metadata };
            }
            const used = await tx.otpCode.updateMany({
                where: { id: record.id, isUsed: false },
                data: { isUsed: true, usedAt: new Date() },
            });
            return used.count === 1
                ? { verified: true, otpId: record.id, metadata: record.metadata }
                : null;
        }, { isolationLevel: client_1.Prisma.TransactionIsolationLevel.Serializable });
        if (result && typeof result === 'object' && 'verified' in result) {
            return { valid: true, metadata: result.metadata ?? undefined, otpId: result.otpId };
        }
        return { valid: false };
    }
    async invalidatePhoneOtps(phone, type) {
        await this.prisma.otpCode.updateMany({
            where: { phone, type, isUsed: false },
            data: { isUsed: true },
        });
        const cooldownKey = (0, redis_keys_1.OTP_COOLDOWN)(phone, type);
        await this.redis.del(cooldownKey);
    }
    async verifyOtpWithMetadata(email, type, code, options = {}) {
        const now = new Date();
        const consume = options.consume !== false;
        const result = await this.prisma.$transaction(async (tx) => {
            const record = await tx.otpCode.findFirst({
                where: { email, type, isUsed: false, expiresAt: { gt: now }, attempts: { lt: app_constants_1.OTP_MAX_ATTEMPTS } },
                orderBy: { createdAt: 'desc' },
            });
            if (!record) {
                await bcrypt.compare('dummy_constant_time_sentinel', DUMMY_OTP_HASH);
                return null;
            }
            const bump = await tx.otpCode.updateMany({
                where: { id: record.id, isUsed: false, expiresAt: { gt: now }, attempts: { lt: app_constants_1.OTP_MAX_ATTEMPTS } },
                data: { attempts: { increment: 1 } },
            });
            if (bump.count === 0)
                return null;
            const isValid = await (0, otp_util_1.verifyOtp)(code, record.code);
            if (!isValid)
                return null;
            if (!consume) {
                return { verified: true, otpId: record.id, email: record.email, type: record.type, metadata: record.metadata };
            }
            const used = await tx.otpCode.updateMany({
                where: { id: record.id, isUsed: false },
                data: { isUsed: true, usedAt: new Date() },
            });
            if (used.count === 1) {
                return { verified: true, otpId: record.id, email: record.email, type: record.type, metadata: record.metadata };
            }
            return null;
        }, { isolationLevel: client_1.Prisma.TransactionIsolationLevel.Serializable });
        if (result && typeof result === 'object' && 'verified' in result) {
            return { valid: true, metadata: result.metadata ?? undefined, otpId: result.otpId };
        }
        return { valid: false };
    }
    async consumeVerifiedOtp(otpId) {
        const consumed = await this.prisma.otpCode.updateMany({
            where: { id: otpId, isUsed: false },
            data: { isUsed: true, usedAt: new Date() },
        });
        return consumed.count === 1;
    }
    async verifyOtp(email, type, code) {
        const now = new Date();
        const result = await this.prisma.$transaction(async (tx) => {
            const record = await tx.otpCode.findFirst({
                where: { email, type, isUsed: false, expiresAt: { gt: now }, attempts: { lt: app_constants_1.OTP_MAX_ATTEMPTS } },
                orderBy: { createdAt: 'desc' },
            });
            if (!record) {
                await bcrypt.compare('dummy_constant_time_sentinel', DUMMY_OTP_HASH);
                return false;
            }
            const bump = await tx.otpCode.updateMany({
                where: { id: record.id, isUsed: false, expiresAt: { gt: now }, attempts: { lt: app_constants_1.OTP_MAX_ATTEMPTS } },
                data: { attempts: { increment: 1 } },
            });
            if (bump.count === 0)
                return false;
            const isValid = await (0, otp_util_1.verifyOtp)(code, record.code);
            if (!isValid)
                return false;
            const used = await tx.otpCode.updateMany({
                where: { id: record.id, isUsed: false },
                data: { isUsed: true, usedAt: new Date() },
            });
            if (used.count === 1) {
                return { verified: true, email: record.email, type: record.type };
            }
            return false;
        }, { isolationLevel: client_1.Prisma.TransactionIsolationLevel.Serializable });
        return !!result;
    }
    async invalidateOtps(email, type) {
        await this.prisma.otpCode.updateMany({
            where: { email, type, isUsed: false },
            data: { isUsed: true },
        });
        const cooldownKey = (0, redis_keys_1.OTP_COOLDOWN)(email, type);
        await this.redis.del(cooldownKey);
    }
    async getLatestOtp(email, type) {
        return this.prisma.otpCode.findFirst({
            where: { email, type, isUsed: false, expiresAt: { gt: new Date() } },
            orderBy: { createdAt: 'desc' },
        });
    }
};
exports.OtpService = OtpService;
exports.OtpService = OtpService = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [prisma_service_1.PrismaService,
        redis_service_1.RedisService,
        config_1.ConfigService])
], OtpService);
