import { Injectable, NotFoundException, ForbiddenException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { DigitalAssetType, OrderStatus, ProductType, Prisma } from '@prisma/client';
import * as ErrorCodes from '../../../common/constants/error-codes';
import { createPaginatedResponse, PaginatedResponse } from '../../../common/dto/pagination.dto';
import { CreateDigitalAssetDto } from '../dto/commerce.dto';
import { UploadService } from '../../upload/upload.service';
import { UploadPurpose } from '../../upload/dto/presigned-url.dto';

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
  constructor(
    private prisma: PrismaService,
    private uploadService: UploadService,
  ) {}

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

  private async validatePayload(sellerId: string, dto: CreateDigitalAssetDto): Promise<void> {
    if (dto.assetType === DigitalAssetType.LINK) {
      try {
        const url = new URL(dto.payload.trim());
        // Tautan yang dikirim ke pembeli wajib https (http = bisa disadap/diubah).
        if (url.protocol !== 'https:') throw new Error('bad protocol');
      } catch {
        throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Payload LINK harus URL https valid' });
      }
    }
    if (dto.assetType === DigitalAssetType.FILE) {
      if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{1,500}$/.test(dto.payload.trim())) {
        throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Payload FILE harus fileKey upload yang valid' });
      }
      // BEC-05 (audit etalase 2026-10-10): fileKey harus milik seller ini,
      // purpose DIGITAL_ASSET, dan sudah terkonfirmasi upload — dulu
      // sembarang string lolos (termasuk key milik user lain).
      await this.uploadService.verifyUserFileKeys(sellerId, [dto.payload.trim()], UploadPurpose.DIGITAL_ASSET, {
        maxFiles: 1,
        consume: false,
        label: 'Aset digital',
      });
    }
  }

  async createAsset(sellerId: string, dto: CreateDigitalAssetDto) {
    await this.assertSellerShowcase(sellerId, dto.showcaseId);
    await this.validatePayload(sellerId, dto);
    const created = await this.prisma.digitalAsset.create({
      data: {
        showcaseId: dto.showcaseId,
        sellerId,
        assetType: dto.assetType,
        payload: dto.payload.trim(),
        label: dto.label?.trim() || null,
      },
    });
    // Konfirmasi upload di-consume SETELAH aset tersimpan (pola etalase).
    if (dto.assetType === DigitalAssetType.FILE) {
      await this.uploadService.consumeUploadConfirmations(sellerId, [dto.payload.trim()]);
    }
    return created;
  }

  /**
   * BEC-04 / BE-5 (audit etalase 2026-10-10): unduhan aset FILE untuk pemilik
   * ATAU pembeli dengan order berbayar — signed URL kedaluwarsa (15 menit).
   * Dulu klien diarahkan ke GET /v1/upload/my-file yang owner-only → pembeli
   * tidak pernah bisa mengunduh. BES-11: etalase yang sudah di-soft-delete
   * TIDAK memutus akses pembeli yang sudah membayar.
   */
  async downloadAsset(userId: string, assetId: string): Promise<{ id: string; downloadUrl: string; expiresAt: Date }> {
    const asset = await this.prisma.digitalAsset.findFirst({
      where: { id: assetId, deletedAt: null },
      select: { id: true, assetType: true, payload: true, showcaseId: true, sellerId: true },
    });
    if (!asset) throw new NotFoundException({ code: ErrorCodes.DIGITAL_ASSET_NOT_FOUND, message: 'Aset tidak ditemukan' });
    if (asset.assetType !== DigitalAssetType.FILE) {
      throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Hanya aset FILE yang bisa diunduh' });
    }
    if (asset.sellerId !== userId) {
      const paidOrder = await this.prisma.order.findFirst({
        where: { showcaseId: asset.showcaseId, buyerId: userId, status: { in: PAID_STATUSES }, deletedAt: null },
        select: { id: true },
      });
      if (!paidOrder) {
        throw new ForbiddenException({ code: ErrorCodes.DIGITAL_ASSET_FORBIDDEN, message: 'Aset digital hanya bisa diunduh setelah pembayaran' });
      }
    }
    const signed = this.uploadService.createSignedDownloadUrl(asset.payload, 900);
    return { id: asset.id, downloadUrl: signed.downloadUrl, expiresAt: signed.expiresAt };
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
