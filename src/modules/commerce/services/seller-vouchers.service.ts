import { Injectable, NotFoundException, BadRequestException, ConflictException } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { Prisma, VoucherType } from '@prisma/client';
import * as ErrorCodes from '../../../common/constants/error-codes';
import { toIdr, toSen } from '../../../common/utils/currency.util';
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
  constructor(private prisma: PrismaService) {}

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
    void now;
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
        message: `Minimal belanja Rp${toIdr(voucher.minOrderValue).toLocaleString('id-ID')}`,
      });
    }
    const usedByUser = await this.prisma.voucherUsage.count({ where: { voucherId: voucher.id, userId } });
    if (usedByUser >= voucher.maxUsagePerUser) {
      throw new BadRequestException({ code: ErrorCodes.VOUCHER_USAGE_LIMIT_REACHED, message: 'Batas pemakaian per user tercapai' });
    }
    // Hitung estimasi diskon (tidak mengubah fee — hanya info untuk UI).
    let discountIdr = 0;
    if (voucher.voucherType === VoucherType.FEE_DISCOUNT_PERCENT && voucher.discountPercent !== null) {
      const raw = (dto.orderValueIdr * Number(voucher.discountPercent)) / 100;
      const capped =
        voucher.maxDiscountAmount !== null ? Math.min(raw, toIdr(voucher.maxDiscountAmount)) : raw;
      discountIdr = Math.floor(capped);
    } else if (voucher.discountAmount !== null) {
      discountIdr = Math.min(toIdr(voucher.discountAmount), dto.orderValueIdr);
    }
    return { valid: true, code: voucher.code, name: voucher.name, discountIdr };
  }
}
