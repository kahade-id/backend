import { Injectable, NotFoundException, ForbiddenException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { DigitalAssetType, OrderStatus, ProductType, Prisma } from '@prisma/client';
import * as ErrorCodes from '../../../common/constants/error-codes';
import { createPaginatedResponse, PaginatedResponse } from '../../../common/dto/pagination.dto';
import { CreateDigitalAssetDto } from '../dto/commerce.dto';

/** Status order yang berarti buyer SUDAH bayar (escrow terisi). */
const PAID_STATUSES: OrderStatus[] = [
  OrderStatus.PROCESSING,
  OrderStatus.IN_DELIVERY,
  OrderStatus.COMPLETED,
  OrderStatus.DISPUTED,
];

/**
 * BE-COMMERCE (2026-10-01) — item 12: auto-delivery produk digital.
 * Seller upload file/link/lisensi per produk DIGITAL; otomatis terlihat buyer
 * SETELAH order berstatus dibayar. Owner selalu bisa lihat/kelola.
 */
@Injectable()
export class DigitalDeliveryService {
  constructor(private prisma: PrismaService) {}

  private async assertSellerShowcase(sellerId: string, showcaseId: string) {
    const row = await this.prisma.userShowcase.findFirst({
      where: { id: showcaseId, userId: sellerId, deletedAt: null },
      select: { id: true, productType: true },
    });
    if (!row) throw new NotFoundException({ code: ErrorCodes.SHOWCASE_NOT_FOUND, message: 'Etalase tidak ditemukan' });
    if (row.productType !== ProductType.DIGITAL) {
      throw new BadRequestException({
        code: ErrorCodes.INVALID_PRODUCT_TYPE,
        message: 'Aset digital hanya untuk produk bertipe DIGITAL',
      });
    }
    return row;
  }

  private validatePayload(dto: CreateDigitalAssetDto): void {
    if (dto.assetType === DigitalAssetType.LINK) {
      try {
        const url = new URL(dto.payload.trim());
        if (!['http:', 'https:'].includes(url.protocol)) throw new Error('bad protocol');
      } catch {
        throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Payload LINK harus URL http(s) valid' });
      }
    }
    if (dto.assetType === DigitalAssetType.FILE && !/^[A-Za-z0-9][A-Za-z0-9._/-]{1,500}$/.test(dto.payload.trim())) {
      throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Payload FILE harus fileKey upload yang valid' });
    }
  }

  async createAsset(sellerId: string, dto: CreateDigitalAssetDto) {
    await this.assertSellerShowcase(sellerId, dto.showcaseId);
    this.validatePayload(dto);
    return this.prisma.digitalAsset.create({
      data: {
        showcaseId: dto.showcaseId,
        sellerId,
        assetType: dto.assetType,
        payload: dto.payload.trim(),
        label: dto.label?.trim() || null,
      },
    });
  }

  async listSellerAssets(sellerId: string, showcaseId: string, page = 1, limit = 20): Promise<PaginatedResponse<Record<string, unknown>>> {
    await this.assertSellerShowcase(sellerId, showcaseId);
    const where: Prisma.DigitalAssetWhereInput = { showcaseId, sellerId, deletedAt: null };
    const [rows, total] = await Promise.all([
      this.prisma.digitalAsset.findMany({ where, orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }], skip: (page - 1) * limit, take: limit }),
      this.prisma.digitalAsset.count({ where }),
    ]);
    return createPaginatedResponse(rows, total, page, limit);
  }

  async deleteAsset(sellerId: string, assetId: string) {
    const asset = await this.prisma.digitalAsset.findFirst({
      where: { id: assetId, sellerId, deletedAt: null },
      select: { id: true },
    });
    if (!asset) throw new NotFoundException({ code: ErrorCodes.DIGITAL_ASSET_NOT_FOUND, message: 'Aset tidak ditemukan' });
    await this.prisma.digitalAsset.update({ where: { id: asset.id }, data: { deletedAt: new Date() } });
    return { id: asset.id };
  }

  /**
   * GET buyer: daftar aset digital produk — hanya bila user adalah OWNER atau
   * buyer dengan order BERBAYAR untuk showcase ini. Fail closed.
   */
  async listBuyerAssets(userId: string, showcaseId: string) {
    const showcase = await this.prisma.userShowcase.findFirst({
      where: { id: showcaseId, deletedAt: null },
      select: { id: true, userId: true },
    });
    if (!showcase) throw new NotFoundException({ code: ErrorCodes.SHOWCASE_NOT_FOUND, message: 'Etalase tidak ditemukan' });
    const isOwner = showcase.userId === userId;
    if (!isOwner) {
      const paidOrder = await this.prisma.order.findFirst({
        where: { showcaseId, buyerId: userId, status: { in: PAID_STATUSES }, deletedAt: null },
        select: { id: true },
      });
      if (!paidOrder) {
        throw new ForbiddenException({
          code: ErrorCodes.DIGITAL_ASSET_FORBIDDEN,
          message: 'Aset digital hanya terlihat setelah pembayaran',
        });
      }
    }
    return this.prisma.digitalAsset.findMany({
      where: { showcaseId, deletedAt: null },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
      select: { id: true, assetType: true, payload: true, label: true, sortOrder: true },
    });
  }
}
