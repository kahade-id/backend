import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { RedisService } from '../../../redis/redis.service';
import { ConflictException } from '@nestjs/common';
import { AuditLogService } from '../../../common/services/audit-log.service';
import { CreateVoucherDto } from './dto/create-voucher.dto';
import { createPaginatedResponse } from '../../../common/dto/pagination.dto';
import { AuditAction, Prisma } from '@prisma/client';
import * as ErrorCodes from '../../../common/constants/error-codes';
import { ADMIN_VOUCHERS_LIST } from '../../../common/constants/redis-keys';
import { toSen, toIdr } from '../../../common/utils/currency.util';

const VOUCHER_LIST_TTL = 300;

@Injectable()
export class AdminVouchersService {
  constructor(
    private prisma: PrismaService,
    private redis: RedisService,
    private auditLog: AuditLogService,
  ) {}

  async listVouchers(page: number, limit: number, isActive?: string): Promise<object> {
    const safePage = Math.max(1, Number.isFinite(page) ? Math.trunc(page) : 1);
    const safeLimit = Math.min(100, Math.max(1, Number.isFinite(limit) ? Math.trunc(limit) : 20));
    const normalizedActive =
      typeof isActive === 'string' ? isActive.trim().toLowerCase() : undefined;
    const where: Prisma.VoucherWhereInput = {};
    if (normalizedActive === 'true') where.isActive = true;
    if (normalizedActive === 'false') where.isActive = false;

    if (safePage === 1) {
      const cacheKey = ADMIN_VOUCHERS_LIST(normalizedActive, safeLimit);
      const cached = await this.redis.get(cacheKey);
      if (cached) {
        try {
          return JSON.parse(cached) as object;
        } catch (_) {
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
        discountAmount: v.discountAmount ? toIdr(v.discountAmount) : null,
        maxDiscountAmount: v.maxDiscountAmount ? toIdr(v.maxDiscountAmount) : null,
        minOrderValue: v.minOrderValue ? toIdr(v.minOrderValue) : null,
        usageCount: v._count.usages,
      }));

      const result = createPaginatedResponse(data, total, safePage, safeLimit);
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
      discountAmount: v.discountAmount ? toIdr(v.discountAmount) : null,
      maxDiscountAmount: v.maxDiscountAmount ? toIdr(v.maxDiscountAmount) : null,
      minOrderValue: v.minOrderValue ? toIdr(v.minOrderValue) : null,
      usageCount: v._count.usages,
    }));

    return createPaginatedResponse(data, total, safePage, safeLimit);
  }

  async getVoucherDetail(voucherId: string): Promise<object> {
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
      throw new NotFoundException({
        code: ErrorCodes.VOUCHER_NOT_FOUND,
        message: 'Voucher not found',
      });
    }

    return {
      ...voucher,
      discountAmount: voucher.discountAmount ? toIdr(voucher.discountAmount) : null,
      maxDiscountAmount: voucher.maxDiscountAmount ? toIdr(voucher.maxDiscountAmount) : null,
      minOrderValue: voucher.minOrderValue ? toIdr(voucher.minOrderValue) : null,
      usageCount: voucher._count.usages,
      usages: voucher.usages.map(u => ({
        ...u,
        discountApplied: toIdr(u.discountApplied),
      })),
    };
  }

  async createVoucher(adminId: string, dto: CreateVoucherDto, ipAddress: string): Promise<object> {
    const code = dto.code.trim().toUpperCase();
    const name = dto.name.trim();
    const description = dto.description?.trim() || undefined;
    if (!/^[A-Z0-9_-]{1,30}$/.test(code)) {
      throw new BadRequestException({
        code: ErrorCodes.VALIDATION_ERROR,
        message: 'Voucher code may contain only A-Z, 0-9, underscore, or hyphen',
      });
    }
    if (name.length === 0) {
      throw new BadRequestException({
        code: ErrorCodes.VALIDATION_ERROR,
        message: 'Voucher name is required',
      });
    }
    const validFrom = new Date(dto.validFrom);
    const validUntil = new Date(dto.validUntil);
    if (
      !Number.isFinite(validFrom.getTime()) ||
      !Number.isFinite(validUntil.getTime()) ||
      validFrom >= validUntil
    ) {
      throw new BadRequestException({
        code: ErrorCodes.INVALID_DATE_RANGE,
        message: 'validFrom must be before validUntil',
      });
    }

    const MAX_DISCOUNT_AMOUNT_IDR = 50_000_000;
    if (dto.discountAmount && dto.discountAmount > MAX_DISCOUNT_AMOUNT_IDR) {
      throw new BadRequestException({
        code: ErrorCodes.VALIDATION_ERROR,
        message: `Discount amount cannot exceed Rp ${MAX_DISCOUNT_AMOUNT_IDR.toLocaleString('id-ID')}`,
      });
    }
    if (dto.maxDiscountAmount && dto.maxDiscountAmount > MAX_DISCOUNT_AMOUNT_IDR) {
      throw new BadRequestException({
        code: ErrorCodes.VALIDATION_ERROR,
        message: `Max discount amount cannot exceed Rp ${MAX_DISCOUNT_AMOUNT_IDR.toLocaleString('id-ID')}`,
      });
    }
    if (dto.discountPercent !== undefined && dto.discountPercent !== null) {
      if (dto.discountPercent < 0.01 || dto.discountPercent > 100) {
        throw new BadRequestException({
          code: ErrorCodes.VALIDATION_ERROR,
          message: 'Discount percentage must be between 0.01 and 100',
        });
      }
    }
    const hasFlatDiscount = dto.discountAmount !== undefined && dto.discountAmount !== null;
    const hasPercentDiscount = dto.discountPercent !== undefined && dto.discountPercent !== null;
    if (hasFlatDiscount === hasPercentDiscount) {
      throw new BadRequestException({
        code: ErrorCodes.VALIDATION_ERROR,
        message: 'Set exactly one of discountAmount or discountPercent',
      });
    }
    if (dto.voucherType === 'FEE_DISCOUNT_PERCENT' && !hasPercentDiscount) {
      throw new BadRequestException({
        code: ErrorCodes.VALIDATION_ERROR,
        message: 'Percentage voucher must have a discountPercent value',
      });
    }
    if (dto.voucherType === 'FEE_DISCOUNT_FLAT' && !hasFlatDiscount) {
      throw new BadRequestException({
        code: ErrorCodes.VALIDATION_ERROR,
        message: 'Fixed amount voucher must have a discountAmount value',
      });
    }
    if (
      dto.voucherType === 'FEE_DISCOUNT_PERCENT' &&
      hasPercentDiscount &&
      (dto.maxDiscountAmount === undefined || dto.maxDiscountAmount === null)
    ) {
      throw new BadRequestException({
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
          discountAmount: dto.discountAmount ? toSen(dto.discountAmount) : null,
          discountPercent: dto.discountPercent ?? null,
          maxDiscountAmount: dto.maxDiscountAmount ? toSen(dto.maxDiscountAmount) : null,
          maxUsageTotal: dto.maxUsageTotal ?? null,
          maxUsagePerUser: dto.maxUsagePerUser ?? 1,
          validFrom,
          validUntil,
          minOrderValue: dto.minOrderValue ? toSen(dto.minOrderValue) : null,
          applicableTo: dto.applicableTo ?? 'ALL',
          createdBy: adminId,
        },
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictException({
          code: ErrorCodes.VOUCHER_CODE_TAKEN,
          message: 'Voucher code is already in use',
        });
      }
      throw error;
    }

    await this.invalidateVoucherListCache();

    this.auditLog.logAdminAction({
      adminId,
      action: AuditAction.VOUCHER_CREATED,
      targetType: 'Voucher',
      targetId: voucher.id,
      description: `Created voucher ${code}`,
      ipAddress,
    });

    return {
      ...voucher,
      discountAmount: voucher.discountAmount ? toIdr(voucher.discountAmount) : null,
      maxDiscountAmount: voucher.maxDiscountAmount ? toIdr(voucher.maxDiscountAmount) : null,
      minOrderValue: voucher.minOrderValue ? toIdr(voucher.minOrderValue) : null,
    };
  }

  async deactivateVoucher(voucherId: string, adminId: string, ipAddress: string): Promise<object> {
    const voucher = await this.prisma.voucher.findFirst({
      where: { OR: [{ id: voucherId }, { voucherId }] },
    });

    if (!voucher) {
      throw new NotFoundException({
        code: ErrorCodes.VOUCHER_NOT_FOUND,
        message: 'Voucher not found',
      });
    }

    if (!voucher.isActive) {
      throw new BadRequestException({
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
      throw new BadRequestException({
        code: ErrorCodes.INVALID_STATUS,
        message: 'Voucher is already deactivated',
      });
    }
    const updated = await this.prisma.voucher.findUniqueOrThrow({ where: { id: voucher.id } });

    await this.invalidateVoucherListCache();

    this.auditLog.logAdminAction({
      adminId,
      action: AuditAction.VOUCHER_DEACTIVATED,
      targetType: 'Voucher',
      targetId: voucher.id,
      description: `Deactivated voucher ${voucher.code}`,
      ipAddress,
    });

    return {
      ...updated,
      discountAmount: updated.discountAmount ? toIdr(updated.discountAmount) : null,
      maxDiscountAmount: updated.maxDiscountAmount ? toIdr(updated.maxDiscountAmount) : null,
      minOrderValue: updated.minOrderValue ? toIdr(updated.minOrderValue) : null,
    };
  }

  private async invalidateVoucherListCache(): Promise<void> {
    await Promise.all([
      this.redis.delPattern('admin:vouchers:list:*'),
      this.redis.delPattern('public:vouchers:active:*'),
    ]);
  }
}
