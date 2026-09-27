import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import * as ErrorCodes from '../../../common/constants/error-codes';
import {
  SHOWCASE_HIGHLIGHT_MAX_PRODUCTS,
  SHOWCASE_MAX_HIGHLIGHTS,
} from '../../../common/constants/app.constants';
import { CreateHighlightDto, UpdateHighlightDto } from './dto/highlight.dto';

type HighlightRow = Prisma.UserHighlightGetPayload<{
  include: {
    items: {
      include: {
        showcase: {
          select: {
            id: true;
            title: true;
            visibility: true;
            isActive: true;
            deletedAt: true;
            images: true;
          };
        };
      };
    };
  };
}>;

type HighlightMediaRow = {
  id: string;
  kind: string | null;
  imageUrl: string;
  thumbnailUrl: string | null;
};

/**
 * Batch 19 TIM A (item 4) — highlight etalase.
 *
 * Highlight = koleksi pilihan berisi produk etalase milik user. Cover opsional
 * (media milik sendiri, divalidasi); tanpa cover dipakai media pertama produk
 * pertama. Endpoint publik (GET /v1/users/:username/highlights) HANYA
 * mengekspos highlight yang punya >=1 produk PUBLIC + aktif + tidak dihapus —
 * produk private/takedown tidak pernah bocor ke payload publik.
 */
@Injectable()
export class HighlightsService {
  constructor(private prisma: PrismaService) {}

  private readonly highlightInclude = {
    items: {
      orderBy: { sortOrder: 'asc' as const },
      include: {
        showcase: {
          select: {
            id: true,
            title: true,
            visibility: true,
            isActive: true,
            deletedAt: true,
            images: { orderBy: [{ sortOrder: 'asc' as const }, { id: 'asc' as const }] },
          },
        },
      },
    },
  };

  private async assertOwnedHighlight(userId: string, highlightId: string): Promise<HighlightRow> {
    const highlight = (await this.prisma.userHighlight.findFirst({
      where: { id: highlightId, userId, deletedAt: null },
      include: this.highlightInclude,
    })) as unknown as HighlightRow | null;
    if (!highlight) {
      throw new NotFoundException({ code: ErrorCodes.HIGHLIGHT_NOT_FOUND, message: 'Highlight not found' });
    }
    return highlight;
  }

  private async validateProductIds(userId: string, productIds: string[]): Promise<void> {
    if (productIds.length === 0) return;
    if (productIds.length > SHOWCASE_HIGHLIGHT_MAX_PRODUCTS) {
      throw new BadRequestException({
        code: ErrorCodes.HIGHLIGHT_PRODUCT_LIMIT_REACHED,
        message: `Maximum ${SHOWCASE_HIGHLIGHT_MAX_PRODUCTS} products per highlight`,
      });
    }
    const rows = await this.prisma.userShowcase.findMany({
      where: { id: { in: productIds }, userId, deletedAt: null },
      select: { id: true },
    });
    if (rows.length !== productIds.length) {
      // Fail closed: jangan biarkan highlight menunjuk produk orang lain /
      // produk yang sudah dihapus.
      throw new BadRequestException({
        code: ErrorCodes.SHOWCASE_NOT_FOUND,
        message: 'One or more products were not found or are not owned by you',
      });
    }
  }

  private async validateCoverMediaId(userId: string, coverMediaId: string): Promise<void> {
    const media = await this.prisma.showcaseImage.findFirst({
      where: { id: coverMediaId, showcase: { userId, deletedAt: null } },
      select: { id: true },
    });
    if (!media) {
      throw new BadRequestException({
        code: ErrorCodes.SHOWCASE_INVALID_MEDIA,
        message: 'Cover media not found or not owned by you',
      });
    }
  }

  /** URL cover dari baris media (video -> thumbnail bila ada). */
  private mediaUrl(media: HighlightMediaRow | null | undefined): string | null {
    if (!media) return null;
    if (media.kind === 'video' && media.thumbnailUrl) return media.thumbnailUrl;
    return media.imageUrl;
  }

  private async resolveCoverUrl(
    highlight: { coverMediaId: string | null; items: { showcase: { images: HighlightMediaRow[] } }[] },
    onlyVisibleProducts: boolean,
  ): Promise<string | null> {
    if (highlight.coverMediaId) {
      const media = await this.prisma.showcaseImage.findFirst({
        where: { id: highlight.coverMediaId },
        select: {
          id: true,
          kind: true,
          imageUrl: true,
          thumbnailUrl: true,
          showcase: { select: { visibility: true, isActive: true, deletedAt: true } },
        },
      });
      // Cover yang menunjuk media terhapus / produk yang tidak visible untuk
      // konteks ini -> abaikan (fallback), bukan error.
      if (media) {
        const s = media.showcase;
        const visible = s.deletedAt === null && s.isActive && (!onlyVisibleProducts || s.visibility === 'PUBLIC');
        if (visible) return this.mediaUrl(media);
      }
    }
    const firstProduct = highlight.items[0]?.showcase;
    return this.mediaUrl(firstProduct?.images[0]);
  }

  private async serializeHighlight(
    highlight: HighlightRow,
    opts: { onlyVisibleProducts: boolean },
  ): Promise<Record<string, unknown>> {
    const items = opts.onlyVisibleProducts
      ? highlight.items.filter(
          (item) =>
            item.showcase.deletedAt === null && item.showcase.isActive && item.showcase.visibility === 'PUBLIC',
        )
      : highlight.items;
    const products = items.map((item) => ({
      id: item.showcase.id,
      title: item.showcase.title,
      coverImageUrl: this.mediaUrl(item.showcase.images[0]),
    }));
    return {
      id: highlight.id,
      title: highlight.title,
      coverMediaId: highlight.coverMediaId,
      coverMediaUrl: await this.resolveCoverUrl(
        { coverMediaId: highlight.coverMediaId, items: items.map((i) => ({ showcase: i.showcase })) },
        opts.onlyVisibleProducts,
      ),
      sortOrder: highlight.sortOrder,
      products,
      productCount: products.length,
      createdAt: highlight.createdAt,
      updatedAt: highlight.updatedAt,
    };
  }

  async createHighlight(userId: string, dto: CreateHighlightDto): Promise<object> {
    const productIds = dto.productIds ?? [];
    const count = await this.prisma.userHighlight.count({ where: { userId, deletedAt: null } });
    if (count >= SHOWCASE_MAX_HIGHLIGHTS) {
      throw new ConflictException({
        code: ErrorCodes.HIGHLIGHT_LIMIT_REACHED,
        message: `Maximum ${SHOWCASE_MAX_HIGHLIGHTS} highlights per user`,
      });
    }
    await this.validateProductIds(userId, productIds);
    if (dto.coverMediaId) await this.validateCoverMediaId(userId, dto.coverMediaId);

    const highlight = (await this.prisma.userHighlight.create({
      data: {
        userId,
        title: dto.title,
        coverMediaId: dto.coverMediaId ?? null,
        sortOrder: count,
        items: { create: productIds.map((showcaseId, index) => ({ showcaseId, sortOrder: index })) },
      },
      include: this.highlightInclude,
    })) as unknown as HighlightRow;
    return this.serializeHighlight(highlight, { onlyVisibleProducts: false });
  }

  async listMyHighlights(userId: string): Promise<object> {
    const highlights = (await this.prisma.userHighlight.findMany({
      where: { userId, deletedAt: null },
      orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
      include: this.highlightInclude,
    })) as unknown as HighlightRow[];
    const data = await Promise.all(
      highlights.map((h) => this.serializeHighlight(h, { onlyVisibleProducts: false })),
    );
    return { highlights: data };
  }

  async getHighlight(userId: string, highlightId: string): Promise<object> {
    const highlight = await this.assertOwnedHighlight(userId, highlightId);
    return this.serializeHighlight(highlight, { onlyVisibleProducts: false });
  }

  async updateHighlight(userId: string, highlightId: string, dto: UpdateHighlightDto): Promise<object> {
    await this.assertOwnedHighlight(userId, highlightId);
    if (dto.productIds !== undefined) await this.validateProductIds(userId, dto.productIds);
    if (dto.coverMediaId !== undefined && dto.coverMediaId !== null) {
      await this.validateCoverMediaId(userId, dto.coverMediaId);
    }

    const updated = (await this.prisma.$transaction(async (tx) => {
      if (dto.productIds !== undefined) {
        // Replace penuh — bukan patch.
        await tx.userHighlightItem.deleteMany({ where: { highlightId } });
        if (dto.productIds.length > 0) {
          await tx.userHighlightItem.createMany({
            data: dto.productIds.map((showcaseId, index) => ({ highlightId, showcaseId, sortOrder: index })),
          });
        }
      }
      return tx.userHighlight.update({
        where: { id: highlightId },
        data: {
          ...(dto.title !== undefined ? { title: dto.title } : {}),
          ...(dto.coverMediaId !== undefined ? { coverMediaId: dto.coverMediaId } : {}),
        },
        include: this.highlightInclude,
      });
    })) as unknown as HighlightRow;
    return this.serializeHighlight(updated, { onlyVisibleProducts: false });
  }

  async deleteHighlight(userId: string, highlightId: string): Promise<{ deleted: boolean }> {
    const highlight = await this.assertOwnedHighlight(userId, highlightId);
    // Hard delete — items ikut terhapus via FK cascade.
    await this.prisma.userHighlight.delete({ where: { id: highlight.id } });
    return { deleted: true };
  }

  /**
   * Highlight publik milik username. Pola visibilitas disamakan dengan
   * getUserRatings: profil private / nonaktif / banned / terhapus -> 404
   * USER_NOT_FOUND; relasi block dua arah -> 404 (bukan 403) agar keberadaan
   * tidak bocor.
   */
  async getPublicHighlightsByUsername(username: string, viewerId?: string | null): Promise<object> {
    const user = await this.prisma.user.findUnique({
      where: { username: username.toLowerCase() },
      select: { id: true, profileVisible: true, isActive: true, isBanned: true, deletedAt: true },
    });
    if (!user) throw new NotFoundException({ code: ErrorCodes.USER_NOT_FOUND, message: 'User not found' });
    if (user.profileVisible === false && viewerId !== user.id) {
      throw new NotFoundException({ code: ErrorCodes.USER_NOT_FOUND, message: 'User not found' });
    }
    if (user.isActive === false || user.isBanned === true || user.deletedAt != null) {
      throw new NotFoundException({ code: ErrorCodes.USER_NOT_FOUND, message: 'User not found' });
    }
    if (viewerId && viewerId !== user.id) {
      const blocked = await this.prisma.blockList.findFirst({
        where: { OR: [{ blockerId: viewerId, blockedId: user.id }, { blockerId: user.id, blockedId: viewerId }] },
        select: { id: true },
      });
      if (blocked) throw new NotFoundException({ code: ErrorCodes.USER_NOT_FOUND, message: 'User not found' });
    }

    const visibleProductFilter: Prisma.UserHighlightItemWhereInput = {
      showcase: { deletedAt: null, isActive: true, visibility: 'PUBLIC' },
    };
    const highlights = (await this.prisma.userHighlight.findMany({
      where: {
        userId: user.id,
        deletedAt: null,
        items: { some: visibleProductFilter },
      },
      orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
      include: {
        items: {
          where: visibleProductFilter,
          orderBy: { sortOrder: 'asc' },
          include: {
            showcase: {
              select: {
                id: true,
                title: true,
                visibility: true,
                isActive: true,
                deletedAt: true,
                images: { orderBy: [{ sortOrder: 'asc' as const }, { id: 'asc' as const }] },
              },
            },
          },
        },
      },
    })) as unknown as HighlightRow[];

    const data = await Promise.all(
      highlights.map((h) => this.serializeHighlight(h, { onlyVisibleProducts: true })),
    );
    return { highlights: data };
  }
}
