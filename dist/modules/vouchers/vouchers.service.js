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
var VouchersService_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.VouchersService = void 0;
const common_1 = require("@nestjs/common");
const prisma_service_1 = require("../../prisma/prisma.service");
const redis_service_1 = require("../../redis/redis.service");
const fee_calculator_service_1 = require("../orders/fee-calculator.service");
const pagination_dto_1 = require("../../common/dto/pagination.dto");
const ErrorCodes = __importStar(require("../../common/constants/error-codes"));
const currency_util_1 = require("../../common/utils/currency.util");
const redis_keys_1 = require("../../common/constants/redis-keys");
const client_1 = require("@prisma/client");
const ACTIVE_VOUCHERS_TTL = 300;
let VouchersService = VouchersService_1 = class VouchersService {
    constructor(prisma, redis, feeCalculator) {
        this.prisma = prisma;
        this.redis = redis;
        this.feeCalculator = feeCalculator;
    }
    serializeVouchers(vouchers) {
        return vouchers.map(v => ({
            ...v,
            discountAmount: v.discountAmount != null ? (0, currency_util_1.toIdr)(v.discountAmount) : null,
            maxDiscountAmount: v.maxDiscountAmount != null ? (0, currency_util_1.toIdr)(v.maxDiscountAmount) : null,
            minOrderValue: v.minOrderValue != null ? (0, currency_util_1.toIdr)(v.minOrderValue) : null,
            discountPercent: v.discountPercent != null ? Number(v.discountPercent) : null,
        }));
    }
    buildActiveVoucherWhere(applicableTo) {
        const now = new Date();
        const where = {
            isActive: true,
            validFrom: { lte: now },
            validUntil: { gte: now },
        };
        if (applicableTo)
            where.applicableTo = applicableTo;
        return where;
    }
    async fetchVoucherPage(where, page, limit) {
        const [vouchers, total] = await Promise.all([
            this.prisma.voucher.findMany({
                where,
                orderBy: [{ validUntil: 'asc' }, { id: 'asc' }],
                skip: (page - 1) * limit,
                take: limit,
                select: VouchersService_1.VOUCHER_SELECT,
            }),
            this.prisma.voucher.count({ where }),
        ]);
        const serialized = this.serializeVouchers(vouchers);
        return (0, pagination_dto_1.createPaginatedResponse)(serialized, total, page, limit);
    }
    async getAvailableVouchers(userId, page, limit, applicableTo) {
        const safePage = Math.max(1, Number.isFinite(page) ? Math.trunc(page) : 1);
        const safeLimit = Math.min(100, Math.max(1, Number.isFinite(limit) ? Math.trunc(limit) : 20));
        const user = await this.prisma.user.findUnique({
            where: { id: userId },
            select: { totalOrdersCompleted: true },
        });
        if (!user) {
            throw new common_1.NotFoundException({ code: ErrorCodes.USER_NOT_FOUND, message: 'User not found' });
        }
        if (user.totalOrdersCompleted > 0 && applicableTo === client_1.VoucherApplicability.NEW_USER) {
            return (0, pagination_dto_1.createPaginatedResponse)([], 0, safePage, safeLimit);
        }
        const where = this.buildActiveVoucherWhere(applicableTo);
        if (user.totalOrdersCompleted > 0) {
            where.applicableTo = { not: client_1.VoucherApplicability.NEW_USER };
        }
        if (safePage === 1) {
            const audience = user.totalOrdersCompleted > 0 ? 'existing' : 'new';
            const cacheKey = (0, redis_keys_1.ACTIVE_VOUCHERS_LIST)(applicableTo, safeLimit, audience);
            const cached = await this.redis.get(cacheKey);
            if (cached) {
                try {
                    return JSON.parse(cached);
                }
                catch (_) {
                    await this.redis.del(cacheKey);
                }
            }
            const result = await this.fetchVoucherPage(where, safePage, safeLimit);
            const now = Date.now();
            const earliestExpiry = result.data.reduce((earliest, item) => {
                const value = item.validUntil instanceof Date
                    ? item.validUntil.getTime()
                    : new Date(String(item.validUntil ?? '')).getTime();
                if (!Number.isFinite(value))
                    return earliest;
                return earliest === null ? value : Math.min(earliest, value);
            }, null);
            const ttlSeconds = earliestExpiry === null
                ? ACTIVE_VOUCHERS_TTL
                : Math.max(1, Math.min(ACTIVE_VOUCHERS_TTL, Math.ceil((earliestExpiry - now) / 1000)));
            await this.redis.setex(cacheKey, ttlSeconds, JSON.stringify(result));
            return result;
        }
        return this.fetchVoucherPage(where, safePage, safeLimit);
    }
    async invalidateAvailableVouchersCache() {
        await this.redis.delPattern('public:vouchers:active:*');
    }
    async validateVoucher(userId, code, orderValue, userRole) {
        const normalizedCode = code.trim().toUpperCase();
        const voucher = await this.prisma.voucher.findUnique({
            where: { code: normalizedCode },
        });
        if (!voucher) {
            throw new common_1.NotFoundException({
                code: ErrorCodes.VOUCHER_NOT_FOUND,
                message: 'Voucher not found',
            });
        }
        const user = await this.prisma.user.findUnique({
            where: { id: userId },
            select: { totalOrdersCompleted: true },
        });
        if (!user) {
            throw new common_1.NotFoundException({ code: ErrorCodes.USER_NOT_FOUND, message: 'User not found' });
        }
        const now = new Date();
        if (!voucher.isActive || now < voucher.validFrom || now > voucher.validUntil) {
            throw new common_1.BadRequestException({
                code: ErrorCodes.VOUCHER_EXPIRED,
                message: 'Voucher is expired or inactive',
            });
        }
        if (voucher.maxUsageTotal !== null && voucher.currentUsage >= voucher.maxUsageTotal) {
            throw new common_1.BadRequestException({
                code: ErrorCodes.VOUCHER_USAGE_LIMIT_REACHED,
                message: 'Voucher usage limit reached',
            });
        }
        const userUsageCount = await this.prisma.voucherUsage.count({
            where: { voucherId: voucher.id, userId },
        });
        if (voucher.maxUsagePerUser !== null && userUsageCount >= voucher.maxUsagePerUser) {
            throw new common_1.BadRequestException({
                code: ErrorCodes.VOUCHER_USAGE_LIMIT_REACHED,
                message: 'You have already used this voucher the maximum number of times',
            });
        }
        if (orderValue != null &&
            voucher.minOrderValue !== null &&
            (0, currency_util_1.toSen)(orderValue) < voucher.minOrderValue) {
            throw new common_1.BadRequestException({
                code: ErrorCodes.VOUCHER_NOT_APPLICABLE,
                message: 'Order value does not meet minimum requirement',
            });
        }
        if (voucher.applicableTo && voucher.applicableTo !== 'ALL') {
            if (voucher.applicableTo === 'NEW_USER') {
                if (user.totalOrdersCompleted > 0) {
                    throw new common_1.BadRequestException({
                        code: ErrorCodes.VOUCHER_NOT_APPLICABLE,
                        message: 'This voucher is only available for new users',
                    });
                }
            }
            else if (voucher.applicableTo === 'BUYER_ONLY' || voucher.applicableTo === 'SELLER_ONLY') {
                if (!userRole) {
                    throw new common_1.BadRequestException({
                        code: ErrorCodes.VOUCHER_NOT_APPLICABLE,
                        message: `This voucher is only for ${voucher.applicableTo === 'BUYER_ONLY' ? 'buyers' : 'sellers'}. Please specify your role.`,
                    });
                }
                const roleMatch = (voucher.applicableTo === 'BUYER_ONLY' && userRole === 'BUYER') ||
                    (voucher.applicableTo === 'SELLER_ONLY' && userRole === 'SELLER');
                if (!roleMatch) {
                    throw new common_1.BadRequestException({
                        code: ErrorCodes.VOUCHER_NOT_APPLICABLE,
                        message: `This voucher is only for ${voucher.applicableTo === 'BUYER_ONLY' ? 'buyers' : 'sellers'}`,
                    });
                }
            }
        }
        let discountAmount = null;
        if (voucher.voucherType === 'FEE_DISCOUNT_FLAT') {
            discountAmount = voucher.discountAmount;
            if (orderValue != null) {
                const standardFee = this.feeCalculator.getStandardFeeSen((0, currency_util_1.toSen)(orderValue));
                if (discountAmount > standardFee)
                    discountAmount = standardFee;
            }
        }
        else if (voucher.voucherType === 'FEE_DISCOUNT_PERCENT' &&
            voucher.discountPercent != null &&
            orderValue != null) {
            const feeConfig = await this.feeCalculator.getFeeConfig();
            const orderValueSen = (0, currency_util_1.toSen)(orderValue);
            const baseFeeSen = this.feeCalculator.getStandardFeeSen(orderValueSen, feeConfig);
            const percentBps = BigInt(Math.round(Number(voucher.discountPercent) * 100));
            discountAmount = (baseFeeSen * percentBps) / BigInt(10_000);
            if (voucher.maxDiscountAmount !== null && discountAmount > voucher.maxDiscountAmount) {
                discountAmount = voucher.maxDiscountAmount;
            }
        }
        return {
            valid: true,
            voucherId: voucher.voucherId,
            code: voucher.code,
            name: voucher.name,
            voucherType: voucher.voucherType,
            discountAmount: discountAmount != null ? (0, currency_util_1.toIdr)(discountAmount) : null,
            discountPercent: voucher.discountPercent ? Number(voucher.discountPercent) : null,
            minOrderValue: voucher.minOrderValue != null ? (0, currency_util_1.toIdr)(voucher.minOrderValue) : null,
            maxDiscountAmount: voucher.maxDiscountAmount != null ? (0, currency_util_1.toIdr)(voucher.maxDiscountAmount) : null,
        };
    }
    async getMyUsageHistory(userId, page, limit) {
        const safePage = Math.max(1, Number.isFinite(page) ? Math.trunc(page) : 1);
        const safeLimit = Math.min(100, Math.max(1, Number.isFinite(limit) ? Math.trunc(limit) : 20));
        const where = { userId };
        const [usages, total] = await Promise.all([
            this.prisma.voucherUsage.findMany({
                where,
                orderBy: [{ usedAt: 'desc' }, { id: 'desc' }],
                skip: (safePage - 1) * safeLimit,
                take: safeLimit,
                include: {
                    voucher: {
                        select: {
                            voucherId: true,
                            code: true,
                            name: true,
                            voucherType: true,
                        },
                    },
                },
            }),
            this.prisma.voucherUsage.count({ where }),
        ]);
        const serialized = usages.map(u => ({
            id: u.id,
            orderId: u.orderId,
            discountAmount: (0, currency_util_1.toIdr)(u.discountApplied),
            usedAt: u.usedAt,
            voucher: u.voucher,
        }));
        return (0, pagination_dto_1.createPaginatedResponse)(serialized, total, safePage, safeLimit);
    }
};
exports.VouchersService = VouchersService;
VouchersService.VOUCHER_SELECT = {
    id: true,
    voucherId: true,
    code: true,
    name: true,
    description: true,
    voucherType: true,
    discountAmount: true,
    discountPercent: true,
    maxDiscountAmount: true,
    maxUsagePerUser: true,
    minOrderValue: true,
    applicableTo: true,
    validFrom: true,
    validUntil: true,
    currentUsage: true,
    maxUsageTotal: true,
};
exports.VouchersService = VouchersService = VouchersService_1 = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [prisma_service_1.PrismaService,
        redis_service_1.RedisService,
        fee_calculator_service_1.FeeCalculatorService])
], VouchersService);
