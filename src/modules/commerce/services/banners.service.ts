import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { RedisService } from '../../../redis/redis.service';
import { Prisma } from '@prisma/client';
import * as ErrorCodes from '../../../common/constants/error-codes';
import { createPaginatedResponse, PaginatedResponse } from '../../../common/dto/pagination.dto';
import { CreateBannerDto, UpdateBannerDto } from '../dto/commerce.dto';

// Perf 2026-10-10: TTL cache daftar banner aktif publik (lihat getActiveBanners).
const ACTIVE_BANNERS_CACHE_TTL_SECONDS = 300; // 5 menit
const activeBannersCacheKey = (position?: string) =>
  `banners:active:${(position ?? 'all').trim().toLowerCase() || 'all'}`;

/**
 * BE-COMMERCE (2026-10-01) — item 15: banner/carousel promo.
 * CRUD admin + endpoint publik banner aktif (filter tanggal tayang).
 */
@Injectable()
export class BannersService {
  constructor(
    private prisma: PrismaService,
    private redis: RedisService,
  ) {}

  private async invalidateActiveBannersCache(): Promise<void> {
    // Posisi banner bebas (string admin) — hapus semua varian key sekaligus.
    try {
      await this.redis.delPattern('banners:active:*');
    } catch {
      // Kegagalan invalidasi cache tidak boleh menggagalkan mutasi admin;
      // TTL 5 menit tetap membatasi staleness.
    }
  }

  async createBanner(adminId: string, dto: CreateBannerDto) {
    this.validateRange(dto.startsAt, dto.endsAt);
    const created = await this.prisma.banner.create({
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
    await this.invalidateActiveBannersCache();
    return created;
  }

  async listAdminBanners(
    page = 1,
    limit = 20,
    filters: { isActive?: boolean; q?: string } = {},
  ): Promise<PaginatedResponse<Record<string, unknown>>> {
    // BAI-013: filter isActive & q yang dikirim admin — sebelumnya diabaikan.
    const where: Record<string, unknown> = {};
    if (filters.isActive !== undefined) where.isActive = filters.isActive;
    if (filters.q) where.title = { contains: filters.q, mode: 'insensitive' };
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
    const updated = await this.prisma.banner.update({
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
    await this.invalidateActiveBannersCache();
    return updated;
  }

  async deleteBanner(id: string) {
    const existing = await this.prisma.banner.findUnique({ where: { id }, select: { id: true } });
    if (!existing) throw new NotFoundException({ code: ErrorCodes.BANNER_NOT_FOUND, message: 'Banner tidak ditemukan' });
    await this.prisma.banner.delete({ where: { id } });
    await this.invalidateActiveBannersCache();
    return { id };
  }

  /** GET /v1/banners/active — publik: banner aktif dalam rentang tayang. */
  async getActiveBanners(position?: string) {
    // Perf 2026-10-10: di-cache 5 menit di Redis (pola public.service.ts —
    // Redis gagal = fall through ke DB). Banner diubah admin sesekali;
    // mutasi CRUD meng-invalidate via delPattern di atas.
    const cacheKey = activeBannersCacheKey(position);
    try {
      const cached = await this.redis.get(cacheKey);
      if (cached) {
        try {
          return JSON.parse(cached) as Array<Record<string, unknown>>;
        } catch {
          // Cache korup — hitung ulang dari DB.
        }
      }
    } catch {
      // Redis hanya optimisasi untuk path baca publik ini; lanjut ke DB.
    }

    const now = new Date();
    const where: Prisma.BannerWhereInput = {
      isActive: true,
      AND: [
        { OR: [{ startsAt: null }, { startsAt: { lte: now } }] },
        { OR: [{ endsAt: null }, { endsAt: { gte: now } }] },
      ],
      ...(position ? { position } : {}),
    };
    const rows = await this.prisma.banner.findMany({
      where,
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'desc' }],
      select: { id: true, title: true, imageUrl: true, linkUrl: true, position: true, sortOrder: true },
    });

    try {
      await this.redis.setex(cacheKey, ACTIVE_BANNERS_CACHE_TTL_SECONDS, JSON.stringify(rows));
    } catch {
      // Kegagalan tulis cache tidak boleh mengubah response publik yang sukses.
    }
    return rows;
  }

  private validateRange(startsAt?: string | null, endsAt?: string | null): void {
    if (startsAt && endsAt && new Date(endsAt).getTime() <= new Date(startsAt).getTime()) {
      throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Akhir tayang harus setelah awal tayang' });
    }
  }
}
