import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { RedisService } from '../../redis/redis.service';
import { FeeCalculatorService } from '../orders/fee-calculator.service';
import { createPaginatedResponse, PaginatedResponse } from '../../common/dto/pagination.dto';
import * as ErrorCodes from '../../common/constants/error-codes';
import { toIdr, toSen } from '../../common/utils/currency.util';
import { ACTIVE_VOUCHERS_LIST } from '../../common/constants/redis-keys';
import { VoucherApplicability, Prisma } from '@prisma/client';

const ACTIVE_VOUCHERS_TTL = 300;

@Injectable()
export class VouchersService {
  constructor(
    private prisma: PrismaService,
    private redis: RedisService,
    private feeCalculator: FeeCalculatorService,
  ) {}

  private static readonly VOUCHER_SELECT = {
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
  } as const;

  private serializeVouchers(
    vouchers: Array<Record<string, unknown>>,
  ): Array<Record<string, unknown>> {
    return vouchers.map(v => ({
      ...v,
      discountAmount: v.discountAmount != null ? toIdr(v.discountAmount as bigint) : null,
      maxDiscountAmount: v.maxDiscountAmount != null ? toIdr(v.maxDiscountAmount as bigint) : null,
      minOrderValue: v.minOrderValue != null ? toIdr(v.minOrderValue as bigint) : null,
      discountPercent: v.discountPercent != null ? Number(v.discountPercent) : null,
    }));
  }

  private buildActiveVoucherWhere(applicableTo?: VoucherApplicability): Prisma.VoucherWhereInput {
    const now = new Date();
    const where: Prisma.VoucherWhereInput = {
      isActive: true,
      validFrom: { lte: now },
      validUntil: { gte: now },
    };
    if (applicableTo) where.applicableTo = applicableTo;
    return where;
  }

  private async fetchVoucherPage(
    where: Prisma.VoucherWhereInput,
    page: number,
    limit: number,
  ): Promise<PaginatedResponse<Record<string, unknown>>> {
    const [vouchers, total] = await Promise.all([
      this.prisma.voucher.findMany({
        where,
        orderBy: [{ validUntil: 'asc' }, { id: 'asc' }],
        skip: (page - 1) * limit,
        take: limit,
        select: VouchersService.VOUCHER_SELECT,
      }),
      this.prisma.voucher.count({ where }),
    ]);
    const serialized = this.serializeVouchers(
      vouchers as unknown as Array<Record<string, unknown>>,
    );
    return createPaginatedResponse(serialized, total, page, limit);
  }

  async getAvailableVouchers(
    userId: string,
    page: number,
    limit: number,
    applicableTo?: VoucherApplicability,
  ): Promise<PaginatedResponse<Record<string, unknown>>> {
    const safePage = Math.max(1, Number.isFinite(page) ? Math.trunc(page) : 1);
    const safeLimit = Math.min(100, Math.max(1, Number.isFinite(limit) ? Math.trunc(limit) : 20));
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { totalOrdersCompleted: true },
    });
    if (!user) {
      throw new NotFoundException({ code: ErrorCodes.USER_NOT_FOUND, message: 'User not found' });
    }

    if (user.totalOrdersCompleted > 0 && applicableTo === VoucherApplicability.NEW_USER) {
      return createPaginatedResponse([], 0, safePage, safeLimit);
    }

    const where = this.buildActiveVoucherWhere(applicableTo);
    if (user.totalOrdersCompleted > 0) {
      where.applicableTo = { not: VoucherApplicability.NEW_USER };
    }

    if (safePage === 1) {
      const audience = user.totalOrdersCompleted > 0 ? 'existing' : 'new';
      const cacheKey = ACTIVE_VOUCHERS_LIST(applicableTo, safeLimit, audience);
      const cached = await this.redis.get(cacheKey);
      if (cached) {
        try {
          return JSON.parse(cached) as PaginatedResponse<Record<string, unknown>>;
        } catch (_) {
          await this.redis.del(cacheKey);
        }
      }

      const result = await this.fetchVoucherPage(where, safePage, safeLimit);
      const now = Date.now();
      const earliestExpiry = result.data.reduce<number | null>((earliest, item) => {
        const value =
          item.validUntil instanceof Date
            ? item.validUntil.getTime()
            : new Date(String(item.validUntil ?? '')).getTime();
        if (!Number.isFinite(value)) return earliest;
        return earliest === null ? value : Math.min(earliest, value);
      }, null);
      const ttlSeconds =
        earliestExpiry === null
          ? ACTIVE_VOUCHERS_TTL
          : Math.max(1, Math.min(ACTIVE_VOUCHERS_TTL, Math.ceil((earliestExpiry - now) / 1000)));
      await this.redis.setex(cacheKey, ttlSeconds, JSON.stringify(result));
      return result;
    }

    return this.fetchVoucherPage(where, safePage, safeLimit);
  }

  async invalidateAvailableVouchersCache(): Promise<void> {
    await this.redis.delPattern('public:vouchers:active:*');
  }

  async validateVoucher(
    userId: string,
    code: string,
    orderValue?: number,
    userRole?: 'BUYER' | 'SELLER',
  ): Promise<Record<string, unknown>> {
    const normalizedCode = code.trim().toUpperCase();
    const voucher = await this.prisma.voucher.findUnique({
      where: { code: normalizedCode },
    });

    if (!voucher) {
      throw new NotFoundException({
        code: ErrorCodes.VOUCHER_NOT_FOUND,
        message: 'Voucher not found',
      });
    }

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { totalOrdersCompleted: true },
    });
    if (!user) {
      throw new NotFoundException({ code: ErrorCodes.USER_NOT_FOUND, message: 'User not found' });
    }

    const now = new Date();

    if (!voucher.isActive || now < voucher.validFrom || now > voucher.validUntil) {
      throw new BadRequestException({
        code: ErrorCodes.VOUCHER_EXPIRED,
        message: 'Voucher is expired or inactive',
      });
    }

    if (voucher.maxUsageTotal !== null && voucher.currentUsage >= voucher.maxUsageTotal) {
      throw new BadRequestException({
        code: ErrorCodes.VOUCHER_USAGE_LIMIT_REACHED,
        message: 'Voucher usage limit reached',
      });
    }

    const userUsageCount = await this.prisma.voucherUsage.count({
      where: { voucherId: voucher.id, userId },
    });

    if (voucher.maxUsagePerUser !== null && userUsageCount >= voucher.maxUsagePerUser) {
      throw new BadRequestException({
        code: ErrorCodes.VOUCHER_USAGE_LIMIT_REACHED,
        message: 'You have already used this voucher the maximum number of times',
      });
    }

    if (
      orderValue != null &&
      voucher.minOrderValue !== null &&
      toSen(orderValue) < voucher.minOrderValue
    ) {
      throw new BadRequestException({
        code: ErrorCodes.VOUCHER_NOT_APPLICABLE,
        message: 'Order value does not meet minimum requirement',
      });
    }

    if (voucher.applicableTo && voucher.applicableTo !== 'ALL') {
      if (voucher.applicableTo === 'NEW_USER') {
        if (user.totalOrdersCompleted > 0) {
          throw new BadRequestException({
            code: ErrorCodes.VOUCHER_NOT_APPLICABLE,
            message: 'This voucher is only available for new users',
          });
        }
      } else if (voucher.applicableTo === 'BUYER_ONLY' || voucher.applicableTo === 'SELLER_ONLY') {
        if (!userRole) {
          throw new BadRequestException({
            code: ErrorCodes.VOUCHER_NOT_APPLICABLE,
            message: `This voucher is only for ${voucher.applicableTo === 'BUYER_ONLY' ? 'buyers' : 'sellers'}. Please specify your role.`,
          });
        }
        const roleMatch =
          (voucher.applicableTo === 'BUYER_ONLY' && userRole === 'BUYER') ||
          (voucher.applicableTo === 'SELLER_ONLY' && userRole === 'SELLER');
        if (!roleMatch) {
          throw new BadRequestException({
            code: ErrorCodes.VOUCHER_NOT_APPLICABLE,
            message: `This voucher is only for ${voucher.applicableTo === 'BUYER_ONLY' ? 'buyers' : 'sellers'}`,
          });
        }
      }
    }

    let discountAmount: bigint | null = null;

    if (voucher.voucherType === 'FEE_DISCOUNT_FLAT') {
      discountAmount = voucher.discountAmount!;
      if (orderValue != null) {
        const standardFee = this.feeCalculator.getStandardFeeSen(toSen(orderValue));
        if (discountAmount > standardFee) discountAmount = standardFee;
      }
    } else if (
      voucher.voucherType === 'FEE_DISCOUNT_PERCENT' &&
      voucher.discountPercent != null &&
      orderValue != null
    ) {
      const feeConfig = await this.feeCalculator.getFeeConfig();
      const orderValueSen = toSen(orderValue);
      // Keep voucher preview identical to final order creation. The standard
      // fee has configured floor/ceiling clamps, so raw order-value × rate
      // underestimates small orders and overestimates large orders.
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
      discountAmount: discountAmount != null ? toIdr(discountAmount) : null,
      discountPercent: voucher.discountPercent ? Number(voucher.discountPercent) : null,
      minOrderValue: voucher.minOrderValue != null ? toIdr(voucher.minOrderValue) : null,
      maxDiscountAmount:
        voucher.maxDiscountAmount != null ? toIdr(voucher.maxDiscountAmount) : null,
    };
  }

  async getMyUsageHistory(
    userId: string,
    page: number,
    limit: number,
  ): Promise<PaginatedResponse<Record<string, unknown>>> {
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
      discountAmount: toIdr(u.discountApplied),
      usedAt: u.usedAt,
      voucher: u.voucher,
    }));

    return createPaginatedResponse(serialized, total, safePage, safeLimit);
  }
}
