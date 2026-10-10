import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { Prisma } from '@prisma/client';
import * as ErrorCodes from '../../../common/constants/error-codes';
import { createPaginatedResponse, PaginatedResponse } from '../../../common/dto/pagination.dto';
import { CreateBannerDto, UpdateBannerDto } from '../dto/commerce.dto';
import { escapeLikePattern } from '../../../common/utils/search.util';

/**
 * BE-COMMERCE (2026-10-01) — item 15: banner/carousel promo.
 * CRUD admin + endpoint publik banner aktif (filter tanggal tayang).
 */
@Injectable()
export class BannersService {
  constructor(private prisma: PrismaService) {}

  async createBanner(adminId: string, dto: CreateBannerDto) {
    this.validateRange(dto.startsAt, dto.endsAt);
    return this.prisma.banner.create({
      data: {
        title: dto.title.trim(),
        imageUrl: dto.imageUrl,
        linkUrl: dto.linkUrl ?? null,
        position: dto.position ?? 'home_top',
        sortOrder: dto.sortOrder ?? 0,
        // BAI-029 (audit integrasi 2026-09-30) — hormati checkbox "Aktif" admin.
        // DTO sudah menerima isActive, tapi service mengabaikannya sehingga
        // banner selalu langsung live (default model true).
        isActive: dto.isActive ?? true,
        startsAt: dto.startsAt ? new Date(dto.startsAt) : null,
        endsAt: dto.endsAt ? new Date(dto.endsAt) : null,
        createdBy: adminId,
      },
    });
  }

  async listAdminBanners(
    page = 1,
    limit = 20,
    filters: { isActive?: boolean; q?: string } = {},
  ): Promise<PaginatedResponse<Record<string, unknown>>> {
    // BAI-013: filter isActive & q yang dikirim admin — sebelumnya diabaikan.
    const where: Record<string, unknown> = {};
    if (filters.isActive !== undefined) where.isActive = filters.isActive;
    // BES-15 (audit etalase 2026-10-10): % dan _ dari input admin bukan wildcard.
    if (filters.q) where.title = { contains: escapeLikePattern(filters.q), mode: 'insensitive' };
    const [rows, total] = await Promise.all([
      this.prisma.banner.findMany({ where, orderBy: [{ sortOrder: 'asc' }, { createdAt: 'desc' }], skip: (page - 1) * limit, take: limit }),
      this.prisma.banner.count({ where }),
    ]);
    return createPaginatedResponse(rows, total, page, limit);
  }

  /** Wave 2 integritas-139: detail satu banner (admin) — dipakai halaman detail banner admin. */
  async getAdminBanner(id: string) {
    const banner = await this.prisma.banner.findUnique({ where: { id } });
    if (!banner) throw new NotFoundException({ code: ErrorCodes.BANNER_NOT_FOUND, message: 'Banner tidak ditemukan' });
    return banner;
  }

  async updateBanner(id: string, dto: UpdateBannerDto) {
    const existing = await this.prisma.banner.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException({ code: ErrorCodes.BANNER_NOT_FOUND, message: 'Banner tidak ditemukan' });
    const startsAt = dto.startsAt !== undefined ? (dto.startsAt ? new Date(dto.startsAt) : null) : existing.startsAt;
    const endsAt = dto.endsAt !== undefined ? (dto.endsAt ? new Date(dto.endsAt) : null) : existing.endsAt;
    this.validateRange(startsAt?.toISOString(), endsAt?.toISOString());
    return this.prisma.banner.update({
      where: { id },
      data: {
        ...(dto.title !== undefined ? { title: dto.title.trim() } : {}),
        ...(dto.imageUrl !== undefined ? { imageUrl: dto.imageUrl } : {}),
        ...(dto.linkUrl !== undefined ? { linkUrl: dto.linkUrl } : {}),
        ...(dto.position !== undefined ? { position: dto.position } : {}),
        ...(dto.sortOrder !== undefined ? { sortOrder: dto.sortOrder } : {}),
        ...(dto.isActive !== undefined ? { isActive: dto.isActive } : {}),
        startsAt,
        endsAt,
      },
    });
  }

  async deleteBanner(id: string) {
    const existing = await this.prisma.banner.findUnique({ where: { id }, select: { id: true } });
    if (!existing) throw new NotFoundException({ code: ErrorCodes.BANNER_NOT_FOUND, message: 'Banner tidak ditemukan' });
    await this.prisma.banner.delete({ where: { id } });
    return { id };
  }

  /** GET /v1/banners/active — publik: banner aktif dalam rentang tayang. */
  async getActiveBanners(position?: string) {
    const now = new Date();
    const where: Prisma.BannerWhereInput = {
      isActive: true,
      AND: [
        { OR: [{ startsAt: null }, { startsAt: { lte: now } }] },
        { OR: [{ endsAt: null }, { endsAt: { gte: now } }] },
      ],
      ...(position ? { position } : {}),
    };
    return this.prisma.banner.findMany({
      where,
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'desc' }],
      select: { id: true, title: true, imageUrl: true, linkUrl: true, position: true, sortOrder: true },
    });
  }

  private validateRange(startsAt?: string | null, endsAt?: string | null): void {
    if (startsAt && endsAt && new Date(endsAt).getTime() <= new Date(startsAt).getTime()) {
      throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Akhir tayang harus setelah awal tayang' });
    }
  }
}
