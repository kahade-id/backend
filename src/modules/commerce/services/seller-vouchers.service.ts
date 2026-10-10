import { Injectable, NotFoundException, BadRequestException, ConflictException } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { Prisma, VoucherType } from '@prisma/client';
import * as ErrorCodes from '../../../common/constants/error-codes';
import { toIdr, toSen, formatSen, percentToBpsBigInt } from '../../../common/utils/currency.util';
import { FeeCalculatorService } from '../../orders/fee-calculator.service';
import { createPaginatedResponse, PaginatedResponse } from '../../../common/dto/pagination.dto';
import { CreateSellerVoucherDto, ValidateSellerVoucherDto } from '../dto/commerce.dto';

/**
 * BE-COMMERCE (2026-10-01) — item 9: voucher buatan SELLER.
 * Memakai ulang model Voucher yang sudah ada (sellerId = NULL berarti voucher
 * platform — perilaku lama tidak berubah). Pemakaian saat buat order otomatis
 * lewat alur voucher existing di OrdersService (voucherCode) karena voucher
 * seller tersimpan di tabel yang sama.
 */
@Injectable()
export class SellerVouchersService {
  constructor(
    private prisma: PrismaService,
    // Audit voucher 2026-10-10 (B11): estimasi diskon harus memakai basis yang
    // sama dengan create order (fee platform), bukan nilai order.
    private feeCalculator: FeeCalculatorService,
  ) {}

  private serialize(row: Record<string, unknown>) {
    return {
      ...row,
      discountAmount: row.discountAmount != null ? toIdr(row.discountAmount as bigint) : null,
      maxDiscountAmount: row.maxDiscountAmount != null ? toIdr(row.maxDiscountAmount as bigint) : null,
      minOrderValue: row.minOrderValue != null ? toIdr(row.minOrderValue as bigint) : null,
      discountPercent: row.discountPercent != null ? Number(row.discountPercent) : null,
    };
  }

  private validateBenefit(dto: CreateSellerVoucherDto): void {
    const isPercent = dto.voucherType === VoucherType.FEE_DISCOUNT_PERCENT;
    if (isPercent) {
      if (dto.discountPercent === undefined) {
        throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'discountPercent wajib untuk tipe persen' });
      }
      if (dto.discountAmountIdr !== undefined) {
        throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Pilih salah satu: persen ATAU nominal' });
      }
    } else {
      if (dto.discountAmountIdr === undefined) {
        throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'discountAmountIdr wajib untuk tipe nominal' });
      }
      if (dto.discountPercent !== undefined) {
        throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Pilih salah satu: persen ATAU nominal' });
      }
    }
    const validFrom = new Date(dto.validFrom);
    const validUntil = new Date(dto.validUntil);
    if (!(validUntil > validFrom)) {
      throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'validUntil harus setelah validFrom' });
    }
  }

  async createVoucher(sellerId: string, dto: CreateSellerVoucherDto) {
    this.validateBenefit(dto);
    const code = dto.code.trim().toUpperCase();
    const existing = await this.prisma.voucher.findUnique({ where: { code }, select: { id: true } });
    if (existing) {
      throw new ConflictException({ code: ErrorCodes.SELLER_VOUCHER_CODE_TAKEN, message: 'Kode voucher sudah dipakai' });
    }
    const row = await this.prisma.voucher.create({
      data: {
        voucherId: `VCH-${code}`,
        code,
        name: dto.name.trim(),
        description: dto.description?.trim() || null,
        voucherType: dto.voucherType,
        discountAmount: dto.discountAmountIdr !== undefined ? toSen(dto.discountAmountIdr) : null,
        discountPercent:
          dto.discountPercent !== undefined ? new Prisma.Decimal(dto.discountPercent) : null,
        maxDiscountAmount: dto.maxDiscountAmountIdr !== undefined ? toSen(dto.maxDiscountAmountIdr) : null,
        maxUsageTotal: dto.maxUsageTotal ?? null,
        maxUsagePerUser: dto.maxUsagePerUser ?? 1,
        minOrderValue: dto.minOrderValueIdr !== undefined ? toSen(dto.minOrderValueIdr) : null,
        isActive: true,
        validFrom: new Date(dto.validFrom),
        validUntil: new Date(dto.validUntil),
        createdBy: `SELLER_${sellerId}`,
        sellerId,
      },
    });
    return this.serialize(row as unknown as Record<string, unknown>);
  }

  async listMyVouchers(sellerId: string, page: number, limit: number): Promise<PaginatedResponse<Record<string, unknown>>> {
    const where: Prisma.VoucherWhereInput = { sellerId };
    const [rows, total] = await Promise.all([
      this.prisma.voucher.findMany({ where, orderBy: [{ createdAt: 'desc' }], skip: (page - 1) * limit, take: limit }),
      this.prisma.voucher.count({ where }),
    ]);
    return createPaginatedResponse(rows.map((r) => this.serialize(r as unknown as Record<string, unknown>)), total, page, limit);
  }

  async deactivateVoucher(sellerId: string, id: string) {
    const row = await this.prisma.voucher.findFirst({ where: { id, sellerId }, select: { id: true } });
    if (!row) throw new NotFoundException({ code: ErrorCodes.VOUCHER_NOT_FOUND, message: 'Voucher tidak ditemukan' });
    const updated = await this.prisma.voucher.update({
      where: { id: row.id },
      data: { isActive: false, deactivatedAt: new Date() },
    });
    return this.serialize(updated as unknown as Record<string, unknown>);
  }

  // ── Admin (monitoring + nonaktifkan; pembuatan tetap di aplikasi seller) ──

  /** Nama display seller untuk field sellerName di response admin. */
  private async userDisplayNames(userIds: string[]): Promise<Map<string, string | null>> {
    const uniq = [...new Set(userIds.filter((id) => !!id))];
    if (uniq.length === 0) return new Map();
    const users = await this.prisma.user.findMany({
      where: { id: { in: uniq } },
      select: { id: true, fullName: true },
    });
    return new Map(users.map((u) => [u.id, u.fullName]));
  }

  /** Shape item voucher seller untuk admin (nominal sudah dalam rupiah). */
  private toAdminItem(row: Record<string, unknown>, sellerName: string | null) {
    const s = this.serialize(row) as Record<string, unknown>;
    return {
      id: s['id'] as string,
      code: s['code'] as string,
      name: s['name'] as string,
      description: (s['description'] as string | null) ?? null,
      sellerId: s['sellerId'] as string,
      sellerName,
      sellerShopName: null,
      discountAmount: s['discountAmount'] as number | null,
      discountPercent: s['discountPercent'] as number | null,
      maxDiscountAmount: s['maxDiscountAmount'] as number | null,
      minOrderValue: s['minOrderValue'] as number | null,
      usageQuota: (s['maxUsageTotal'] as number | null) ?? null,
      usageCount: (s['currentUsage'] as number) ?? 0,
      isActive: s['isActive'] as boolean,
      startsAt: s['validFrom'] as Date,
      endsAt: s['validUntil'] as Date,
      createdAt: s['createdAt'] as Date,
      updatedAt: s['updatedAt'] as Date,
    };
  }

  /** Daftar voucher seller untuk admin: filter isActive + pencarian kode/nama/seller. */
  async listAdminVouchers(page = 1, limit = 20, isActive?: 'true' | 'false', q?: string) {
    const where: Prisma.VoucherWhereInput = { sellerId: { not: null } };
    if (isActive === 'true') where.isActive = true;
    else if (isActive === 'false') where.isActive = false;
    const keyword = q?.trim();
    if (keyword) {
      where.OR = [
        { code: { contains: keyword, mode: 'insensitive' } },
        { name: { contains: keyword, mode: 'insensitive' } },
        { sellerId: { contains: keyword } },
      ];
    }
    const [rows, total] = await Promise.all([
      this.prisma.voucher.findMany({ where, orderBy: [{ createdAt: 'desc' }], skip: (page - 1) * limit, take: limit }),
      this.prisma.voucher.count({ where }),
    ]);
    const names = await this.userDisplayNames(rows.map((r) => r.sellerId).filter((s): s is string => !!s));
    const items = rows.map((r) =>
      this.toAdminItem(r as unknown as Record<string, unknown>, names.get(r.sellerId ?? '') ?? null),
    );
    return createPaginatedResponse(items, total, page, limit);
  }

  /** Detail voucher seller untuk admin: item + riwayat pemakaian. */
  async getAdminVoucherDetail(id: string) {
    const row = await this.prisma.voucher.findFirst({
      where: { id, sellerId: { not: null } },
      include: {
        usages: {
          orderBy: { usedAt: 'desc' },
          take: 200,
          include: { user: { select: { id: true, fullName: true, email: true, phoneNumber: true } } },
        },
      },
    });
    if (!row) throw new NotFoundException({ code: ErrorCodes.VOUCHER_NOT_FOUND, message: 'Voucher seller tidak ditemukan' });
    const names = await this.userDisplayNames(row.sellerId ? [row.sellerId] : []);
    return {
      ...this.toAdminItem(row as unknown as Record<string, unknown>, names.get(row.sellerId ?? '') ?? null),
      usages: row.usages.map((u) => ({
        id: u.id,
        discountApplied: toIdr(u.discountApplied),
        orderId: u.orderId,
        usedAt: u.usedAt,
        user: u.user
          ? { id: u.user.id, fullName: u.user.fullName, email: u.user.email, phone: u.user.phoneNumber }
          : null,
      })),
    };
  }

  /**
   * Nonaktifkan voucher seller oleh admin (IDEMPOTEN): bila sudah nonaktif,
   * kembalikan apa adanya tanpa perubahan.
   */
  async deactivateAdminVoucher(id: string, adminId: string) {
    const row = await this.prisma.voucher.findFirst({
      where: { id, sellerId: { not: null } },
      select: { id: true, isActive: true, sellerId: true },
    });
    if (!row) throw new NotFoundException({ code: ErrorCodes.VOUCHER_NOT_FOUND, message: 'Voucher seller tidak ditemukan' });
    const updated = row.isActive
      ? await this.prisma.voucher.update({
          where: { id: row.id },
          data: { isActive: false, deactivatedAt: new Date(), deactivatedBy: `ADMIN_${adminId}` },
        })
      : await this.prisma.voucher.findUniqueOrThrow({ where: { id: row.id } });
    const names = await this.userDisplayNames(row.sellerId ? [row.sellerId] : []);
    return this.toAdminItem(updated as unknown as Record<string, unknown>, names.get(row.sellerId ?? '') ?? null);
  }

  /**
   * Validasi voucher seller untuk dipakai pada order ke seller tertentu.
   * Fail-closed: kode salah / kedaluwarsa / kuota habis / bukan milik seller
   * → 400 dengan kode yang jelas.
   */
  async validateVoucher(userId: string, dto: ValidateSellerVoucherDto) {
    const code = dto.code.trim().toUpperCase();
    const voucher = await this.prisma.voucher.findUnique({ where: { code } });
    if (!voucher || voucher.sellerId !== dto.sellerId) {
      throw new BadRequestException({ code: ErrorCodes.SELLER_VOUCHER_INVALID, message: 'Kode voucher tidak valid untuk toko ini' });
    }
    const now = new Date();
    if (!voucher.isActive || voucher.validFrom > now || voucher.validUntil < now) {
      throw new BadRequestException({ code: ErrorCodes.VOUCHER_EXPIRED, message: 'Voucher tidak aktif / kedaluwarsa' });
    }
    if (voucher.maxUsageTotal !== null && voucher.currentUsage >= voucher.maxUsageTotal) {
      throw new BadRequestException({ code: ErrorCodes.VOUCHER_USAGE_LIMIT_REACHED, message: 'Kuota voucher habis' });
    }
    const orderValueSen = toSen(dto.orderValueIdr);
    if (voucher.minOrderValue !== null && orderValueSen < voucher.minOrderValue) {
      throw new BadRequestException({
        code: ErrorCodes.VOUCHER_NOT_APPLICABLE,
        message: `Minimal belanja ${formatSen(voucher.minOrderValue)}`,
      });
    }
    const usedByUser = await this.prisma.voucherUsage.count({ where: { voucherId: voucher.id, userId } });
    if (usedByUser >= voucher.maxUsagePerUser) {
      throw new BadRequestException({ code: ErrorCodes.VOUCHER_USAGE_LIMIT_REACHED, message: 'Batas pemakaian per user tercapai' });
    }
    // Hitung estimasi diskon (tidak mengubah fee — hanya info untuk UI).
    // B11: voucher toko bertipe FEE_DISCOUNT_* memotong FEE PLATFORM, bukan
    // nilai order — saat create order `calculateOrderVoucherBenefitSen`
    // (orders.service) memakai basis fee standar. Dulu preview memakai nilai
    // order: "Diskon Rp50.000" tampil, realisasinya Rp2.500. Cerminan rumus
    // yang sama (basis poin, cap maxDiscountAmount, cap ke basis).
    const feeConfig = await this.feeCalculator.getFeeConfig();
    const feeBaseSen = this.feeCalculator.getStandardFeeSen(orderValueSen, feeConfig);
    let discountSen = BigInt(0);
    if (voucher.voucherType === VoucherType.FEE_DISCOUNT_PERCENT && voucher.discountPercent !== null) {
      const percentBps = percentToBpsBigInt(voucher.discountPercent);
      discountSen = (feeBaseSen * percentBps) / BigInt(10_000);
      if (voucher.maxDiscountAmount !== null && discountSen > voucher.maxDiscountAmount) {
        discountSen = voucher.maxDiscountAmount;
      }
    } else if (voucher.discountAmount !== null) {
      discountSen = voucher.discountAmount;
    }
    if (discountSen > feeBaseSen) discountSen = feeBaseSen;
    const discountIdr = toIdr(discountSen);
    return { valid: true, code: voucher.code, name: voucher.name, discountIdr };
  }
}
