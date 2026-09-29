import { Injectable, NotFoundException, ForbiddenException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { OrderStatus, ProductType } from '@prisma/client';
import * as ErrorCodes from '../../../common/constants/error-codes';
import { toIdr, toSen } from '../../../common/utils/currency.util';
import { UpdateProductCommerceDto } from '../dto/commerce.dto';

/** Ambang badge TERLARIS: order selesai dalam 90 hari terakhir. */
export const BEST_SELLER_MIN_COMPLETED = 10;
export const BEST_SELLER_WINDOW_DAYS = 90;

/**
 * BE-COMMERCE (2026-10-01) — item 1, 5, 7, 8:
 * - productType JASA/FISIK/DIGITAL/LAINNYA + validasi per tipe
 * - harga coret (originalPrice > harga jual)
 * - statistik produk (view/save/click/purchase) — baca khusus pemilik
 * - badge Terlaris — komputasi on-read dari order selesai
 *
 * Catatan: resi/ongkir khusus FISIK sudah ditegakkan di
 * OrdersService.updateShipping via OrderType — tidak diduplikasi di sini.
 */
@Injectable()
export class ProductCommerceService {
  constructor(private prisma: PrismaService) {}

  private async assertOwnerShowcase(userId: string, showcaseId: string) {
    const row = await this.prisma.userShowcase.findFirst({
      where: { id: showcaseId, userId, deletedAt: null },
      select: {
        id: true,
        userId: true,
        priceMin: true,
        priceMax: true,
        productType: true,
        serviceDeadlineDays: true,
        originalPrice: true,
      },
    });
    if (!row) throw new NotFoundException({ code: ErrorCodes.SHOWCASE_NOT_FOUND, message: 'Etalase tidak ditemukan' });
    return row;
  }

  /**
   * PATCH /v1/commerce/products/:id — update field commerce milik owner.
   * Validasi fail-closed:
   * - JASA wajib serviceDeadlineDays (dari request atau yang tersimpan)
   * - originalPrice (harga coret) harus > harga jual (priceMin ?? priceMax)
   * - scheduledAt harus di masa depan bila diisi
   */
  async updateCommerceFields(userId: string, showcaseId: string, dto: UpdateProductCommerceDto) {
    const row = await this.assertOwnerShowcase(userId, showcaseId);
    const productType = dto.productType ?? row.productType ?? undefined;

    if (productType === ProductType.JASA) {
      const deadline = dto.serviceDeadlineDays ?? row.serviceDeadlineDays ?? undefined;
      if (!deadline) {
        throw new BadRequestException({
          code: ErrorCodes.SERVICE_DEADLINE_REQUIRED,
          message: 'Produk jasa wajib memiliki tenggat pengerjaan (serviceDeadlineDays)',
        });
      }
    }

    let originalPriceSen: bigint | undefined;
    if (dto.originalPriceIdr !== undefined) {
      const saleSen = row.priceMin ?? row.priceMax ?? null;
      originalPriceSen = toSen(dto.originalPriceIdr);
      if (saleSen !== null && originalPriceSen <= saleSen) {
        throw new BadRequestException({
          code: ErrorCodes.ORIGINAL_PRICE_INVALID,
          message: 'Harga coret harus lebih besar dari harga jual',
        });
      }
      if (originalPriceSen <= 0n) {
        throw new BadRequestException({
          code: ErrorCodes.ORIGINAL_PRICE_INVALID,
          message: 'Harga coret harus lebih besar dari nol',
        });
      }
    }

    let scheduledAt: Date | null | undefined;
    if (dto.scheduledAt !== undefined) {
      if (dto.scheduledAt === null || dto.scheduledAt === '') {
        scheduledAt = null;
      } else {
        const d = new Date(dto.scheduledAt);
        if (Number.isNaN(d.getTime()) || d.getTime() <= Date.now()) {
          throw new BadRequestException({
            code: ErrorCodes.SCHEDULED_AT_INVALID,
            message: 'Jadwal publish harus di masa depan',
          });
        }
        scheduledAt = d;
      }
    }

    return this.prisma.userShowcase.update({
      where: { id: row.id },
      data: {
        ...(dto.productType !== undefined ? { productType: dto.productType } : {}),
        ...(dto.serviceDeadlineDays !== undefined ? { serviceDeadlineDays: dto.serviceDeadlineDays } : {}),
        ...(dto.digitalDeliveryInfo !== undefined ? { digitalDeliveryInfo: dto.digitalDeliveryInfo || null } : {}),
        ...(originalPriceSen !== undefined ? { originalPrice: originalPriceSen } : {}),
        ...(scheduledAt !== undefined ? { scheduledAt } : {}),
      },
      select: {
        id: true,
        productType: true,
        originalPrice: true,
        serviceDeadlineDays: true,
        digitalDeliveryInfo: true,
        scheduledAt: true,
        isActive: true,
      },
    });
  }

  /** POST /v1/commerce/products/:id/click — hit klik (atomik, publik). */
  async recordClick(showcaseId: string): Promise<{ ok: true }> {
    await this.prisma.userShowcase.updateMany({
      where: { id: showcaseId, deletedAt: null },
      data: { clickCount: { increment: 1 } },
    });
    return { ok: true };
  }

  /**
   * GET /v1/commerce/products/:id/stats — statistik khusus PEMILIK.
   * views/saves dari counter denormalisasi; purchases dihitung on-read dari
   * order selesai yang berelasi ke showcase ini.
   */
  async getProductStats(userId: string, showcaseId: string) {
    const row = await this.prisma.userShowcase.findFirst({
      where: { id: showcaseId, deletedAt: null },
      select: {
        id: true,
        userId: true,
        viewCount: true,
        saveCount: true,
        likeCount: true,
        shareCount: true,
        clickCount: true,
        hotViews: true,
      },
    });
    if (!row) throw new NotFoundException({ code: ErrorCodes.SHOWCASE_NOT_FOUND, message: 'Etalase tidak ditemukan' });
    if (row.userId !== userId) {
      throw new ForbiddenException({ code: ErrorCodes.FORBIDDEN, message: 'Statistik hanya bisa dibaca pemilik' });
    }
    const [purchases, ordersTotal] = await Promise.all([
      this.prisma.order.count({ where: { showcaseId: row.id, status: OrderStatus.COMPLETED, deletedAt: null } }),
      this.prisma.order.count({ where: { showcaseId: row.id, deletedAt: null } }),
    ]);
    return {
      showcaseId: row.id,
      views: row.viewCount,
      saves: row.saveCount,
      likes: row.likeCount,
      shares: row.shareCount,
      clicks: row.clickCount,
      hotViews: row.hotViews,
      purchases,
      ordersTotal,
    };
  }

  /**
   * GET /v1/commerce/products/:id/badges — komputasi on-read (publik).
   * TERLARIS bila >= BEST_SELLER_MIN_COMPLETED order COMPLETED dalam
   * 90 hari terakhir.
   */
  async getProductBadges(showcaseId: string) {
    const exists = await this.prisma.userShowcase.findFirst({
      where: { id: showcaseId, deletedAt: null },
      select: { id: true, originalPrice: true },
    });
    if (!exists) throw new NotFoundException({ code: ErrorCodes.SHOWCASE_NOT_FOUND, message: 'Etalase tidak ditemukan' });
    const since = new Date(Date.now() - BEST_SELLER_WINDOW_DAYS * 24 * 60 * 60 * 1000);
    const completed = await this.prisma.order.count({
      where: { showcaseId, status: OrderStatus.COMPLETED, deletedAt: null, completedAt: { gte: since } },
    });
    const badges: string[] = [];
    if (completed >= BEST_SELLER_MIN_COMPLETED) badges.push('TERLARIS');
    if (exists.originalPrice !== null) badges.push('DISKON');
    return { showcaseId, badges, completedOrders90d: completed };
  }

  /** Helper serialisasi harga coret untuk dipakai modul lain. */
  static originalPriceToIdr(originalPrice: bigint | null): number | null {
    return originalPrice === null ? null : toIdr(originalPrice);
  }
}
