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
exports.AdminVouchersService = void 0;
const common_1 = require("@nestjs/common");
const prisma_service_1 = require("../../../prisma/prisma.service");
const redis_service_1 = require("../../../redis/redis.service");
const common_2 = require("@nestjs/common");
const audit_log_service_1 = require("../../../common/services/audit-log.service");
const pagination_dto_1 = require("../../../common/dto/pagination.dto");
const client_1 = require("@prisma/client");
const ErrorCodes = __importStar(require("../../../common/constants/error-codes"));
const redis_keys_1 = require("../../../common/constants/redis-keys");
const currency_util_1 = require("../../../common/utils/currency.util");
const VOUCHER_LIST_TTL = 300;
let AdminVouchersService = class AdminVouchersService {
    constructor(prisma, redis, auditLog) {
        this.prisma = prisma;
        this.redis = redis;
        this.auditLog = auditLog;
    }
    async listVouchers(page, limit, isActive) {
        const safePage = Math.max(1, Number.isFinite(page) ? Math.trunc(page) : 1);
        const safeLimit = Math.min(100, Math.max(1, Number.isFinite(limit) ? Math.trunc(limit) : 20));
        const normalizedActive = typeof isActive === 'string' ? isActive.trim().toLowerCase() : undefined;
        const where = {};
        if (normalizedActive === 'true')
            where.isActive = true;
        if (normalizedActive === 'false')
            where.isActive = false;
        if (safePage === 1) {
            const cacheKey = (0, redis_keys_1.ADMIN_VOUCHERS_LIST)(normalizedActive, safeLimit);
            const cached = await this.redis.get(cacheKey);
            if (cached) {
                try {
                    return JSON.parse(cached);
                }
                catch (_) {
                    await this.redis.del(cacheKey);
                }
            }
            const [vouchers, total] = await Promise.all([
                this.prisma.voucher.findMany({
                    where,
                    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
                    skip: 0,
                    take: safeLimit,
                    include: { _count: { select: { usages: true } } },
                }),
                this.prisma.voucher.count({ where }),
            ]);
            const data = vouchers.map(v => ({
                ...v,
                discountAmount: v.discountAmount ? (0, currency_util_1.toIdr)(v.discountAmount) : null,
                maxDiscountAmount: v.maxDiscountAmount ? (0, currency_util_1.toIdr)(v.maxDiscountAmount) : null,
                minOrderValue: v.minOrderValue ? (0, currency_util_1.toIdr)(v.minOrderValue) : null,
                usageCount: v._count.usages,
            }));
            const result = (0, pagination_dto_1.createPaginatedResponse)(data, total, safePage, safeLimit);
            await this.redis.setex(cacheKey, VOUCHER_LIST_TTL, JSON.stringify(result));
            return result;
        }
        const [vouchers, total] = await Promise.all([
            this.prisma.voucher.findMany({
                where,
                orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
                skip: (safePage - 1) * safeLimit,
                take: safeLimit,
                include: { _count: { select: { usages: true } } },
            }),
            this.prisma.voucher.count({ where }),
        ]);
        const data = vouchers.map(v => ({
            ...v,
            discountAmount: v.discountAmount ? (0, currency_util_1.toIdr)(v.discountAmount) : null,
            maxDiscountAmount: v.maxDiscountAmount ? (0, currency_util_1.toIdr)(v.maxDiscountAmount) : null,
            minOrderValue: v.minOrderValue ? (0, currency_util_1.toIdr)(v.minOrderValue) : null,
            usageCount: v._count.usages,
        }));
        return (0, pagination_dto_1.createPaginatedResponse)(data, total, safePage, safeLimit);
    }
    async getVoucherDetail(voucherId) {
        const voucher = await this.prisma.voucher.findFirst({
            where: { OR: [{ id: voucherId }, { voucherId }] },
            include: {
                usages: {
                    include: {
                        user: { select: { id: true, userId: true, fullName: true, email: true } },
                    },
                    orderBy: [{ usedAt: 'desc' }, { id: 'desc' }],
                    take: 50,
                },
                _count: { select: { usages: true } },
            },
        });
        if (!voucher) {
            throw new common_1.NotFoundException({
                code: ErrorCodes.VOUCHER_NOT_FOUND,
                message: 'Voucher not found',
            });
        }
        return {
            ...voucher,
            discountAmount: voucher.discountAmount ? (0, currency_util_1.toIdr)(voucher.discountAmount) : null,
            maxDiscountAmount: voucher.maxDiscountAmount ? (0, currency_util_1.toIdr)(voucher.maxDiscountAmount) : null,
            minOrderValue: voucher.minOrderValue ? (0, currency_util_1.toIdr)(voucher.minOrderValue) : null,
            usageCount: voucher._count.usages,
            usages: voucher.usages.map(u => ({
                ...u,
                discountApplied: (0, currency_util_1.toIdr)(u.discountApplied),
            })),
        };
    }
    async createVoucher(adminId, dto, ipAddress) {
        const code = dto.code.trim().toUpperCase();
        const name = dto.name.trim();
        const description = dto.description?.trim() || undefined;
        if (!/^[A-Z0-9_-]{1,30}$/.test(code)) {
            throw new common_1.BadRequestException({
                code: ErrorCodes.VALIDATION_ERROR,
                message: 'Voucher code may contain only A-Z, 0-9, underscore, or hyphen',
            });
        }
        if (name.length === 0) {
            throw new common_1.BadRequestException({
                code: ErrorCodes.VALIDATION_ERROR,
                message: 'Voucher name is required',
            });
        }
        const validFrom = new Date(dto.validFrom);
        const validUntil = new Date(dto.validUntil);
        if (!Number.isFinite(validFrom.getTime()) ||
            !Number.isFinite(validUntil.getTime()) ||
            validFrom >= validUntil) {
            throw new common_1.BadRequestException({
                code: ErrorCodes.INVALID_DATE_RANGE,
                message: 'validFrom must be before validUntil',
            });
        }
        const MAX_DISCOUNT_AMOUNT_IDR = 50_000_000;
        if (dto.discountAmount && dto.discountAmount > MAX_DISCOUNT_AMOUNT_IDR) {
            throw new common_1.BadRequestException({
                code: ErrorCodes.VALIDATION_ERROR,
                message: `Discount amount cannot exceed Rp ${MAX_DISCOUNT_AMOUNT_IDR.toLocaleString('id-ID')}`,
            });
        }
        if (dto.maxDiscountAmount && dto.maxDiscountAmount > MAX_DISCOUNT_AMOUNT_IDR) {
            throw new common_1.BadRequestException({
                code: ErrorCodes.VALIDATION_ERROR,
                message: `Max discount amount cannot exceed Rp ${MAX_DISCOUNT_AMOUNT_IDR.toLocaleString('id-ID')}`,
            });
        }
        if (dto.discountPercent !== undefined && dto.discountPercent !== null) {
            if (dto.discountPercent < 0.01 || dto.discountPercent > 100) {
                throw new common_1.BadRequestException({
                    code: ErrorCodes.VALIDATION_ERROR,
                    message: 'Discount percentage must be between 0.01 and 100',
                });
            }
        }
        const hasFlatDiscount = dto.discountAmount !== undefined && dto.discountAmount !== null;
        const hasPercentDiscount = dto.discountPercent !== undefined && dto.discountPercent !== null;
        if (hasFlatDiscount === hasPercentDiscount) {
            throw new common_1.BadRequestException({
                code: ErrorCodes.VALIDATION_ERROR,
                message: 'Set exactly one of discountAmount or discountPercent',
            });
        }
        if (dto.voucherType === 'FEE_DISCOUNT_PERCENT' && !hasPercentDiscount) {
            throw new common_1.BadRequestException({
                code: ErrorCodes.VALIDATION_ERROR,
                message: 'Percentage voucher must have a discountPercent value',
            });
        }
        if (dto.voucherType === 'FEE_DISCOUNT_FLAT' && !hasFlatDiscount) {
            throw new common_1.BadRequestException({
                code: ErrorCodes.VALIDATION_ERROR,
                message: 'Fixed amount voucher must have a discountAmount value',
            });
        }
        if (dto.voucherType === 'FEE_DISCOUNT_PERCENT' &&
            hasPercentDiscount &&
            (dto.maxDiscountAmount === undefined || dto.maxDiscountAmount === null)) {
            throw new common_1.BadRequestException({
                code: ErrorCodes.VALIDATION_ERROR,
                message: 'Percentage voucher must have a maxDiscountAmount cap',
            });
        }
        const voucherId = `VCH-${code}`;
        let voucher;
        try {
            voucher = await this.prisma.voucher.create({
                data: {
                    voucherId,
                    code,
                    name,
                    description,
                    voucherType: dto.voucherType,
                    discountAmount: dto.discountAmount ? (0, currency_util_1.toSen)(dto.discountAmount) : null,
                    discountPercent: dto.discountPercent ?? null,
                    maxDiscountAmount: dto.maxDiscountAmount ? (0, currency_util_1.toSen)(dto.maxDiscountAmount) : null,
                    maxUsageTotal: dto.maxUsageTotal ?? null,
                    maxUsagePerUser: dto.maxUsagePerUser ?? 1,
                    validFrom,
                    validUntil,
                    minOrderValue: dto.minOrderValue ? (0, currency_util_1.toSen)(dto.minOrderValue) : null,
                    applicableTo: dto.applicableTo ?? 'ALL',
                    createdBy: adminId,
                },
            });
        }
        catch (error) {
            if (error instanceof client_1.Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
                throw new common_2.ConflictException({
                    code: ErrorCodes.VOUCHER_CODE_TAKEN,
                    message: 'Voucher code is already in use',
                });
            }
            throw error;
        }
        await this.invalidateVoucherListCache();
        this.auditLog.logAdminAction({
            adminId,
            action: client_1.AuditAction.VOUCHER_CREATED,
            targetType: 'Voucher',
            targetId: voucher.id,
            description: `Created voucher ${code}`,
            ipAddress,
        });
        return {
            ...voucher,
            discountAmount: voucher.discountAmount ? (0, currency_util_1.toIdr)(voucher.discountAmount) : null,
            maxDiscountAmount: voucher.maxDiscountAmount ? (0, currency_util_1.toIdr)(voucher.maxDiscountAmount) : null,
            minOrderValue: voucher.minOrderValue ? (0, currency_util_1.toIdr)(voucher.minOrderValue) : null,
        };
    }
    async deactivateVoucher(voucherId, adminId, ipAddress) {
        const voucher = await this.prisma.voucher.findFirst({
            where: { OR: [{ id: voucherId }, { voucherId }] },
        });
        if (!voucher) {
            throw new common_1.NotFoundException({
                code: ErrorCodes.VOUCHER_NOT_FOUND,
                message: 'Voucher not found',
            });
        }
        if (!voucher.isActive) {
            throw new common_1.BadRequestException({
                code: ErrorCodes.INVALID_STATUS,
                message: 'Voucher is already deactivated',
            });
        }
        const updatedResult = await this.prisma.voucher.updateMany({
            where: { id: voucher.id, isActive: true },
            data: {
                isActive: false,
                deactivatedBy: adminId,
                deactivatedAt: new Date(),
            },
        });
        if (updatedResult.count === 0) {
            throw new common_1.BadRequestException({
                code: ErrorCodes.INVALID_STATUS,
                message: 'Voucher is already deactivated',
            });
        }
        const updated = await this.prisma.voucher.findUniqueOrThrow({ where: { id: voucher.id } });
        await this.invalidateVoucherListCache();
        this.auditLog.logAdminAction({
            adminId,
            action: client_1.AuditAction.VOUCHER_DEACTIVATED,
            targetType: 'Voucher',
            targetId: voucher.id,
            description: `Deactivated voucher ${voucher.code}`,
            ipAddress,
        });
        return {
            ...updated,
            discountAmount: updated.discountAmount ? (0, currency_util_1.toIdr)(updated.discountAmount) : null,
            maxDiscountAmount: updated.maxDiscountAmount ? (0, currency_util_1.toIdr)(updated.maxDiscountAmount) : null,
            minOrderValue: updated.minOrderValue ? (0, currency_util_1.toIdr)(updated.minOrderValue) : null,
        };
    }
    async invalidateVoucherListCache() {
        await Promise.all([
            this.redis.delPattern('admin:vouchers:list:*'),
            this.redis.delPattern('public:vouchers:active:*'),
        ]);
    }
};
exports.AdminVouchersService = AdminVouchersService;
exports.AdminVouchersService = AdminVouchersService = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [prisma_service_1.PrismaService,
        redis_service_1.RedisService,
        audit_log_service_1.AuditLogService])
], AdminVouchersService);
