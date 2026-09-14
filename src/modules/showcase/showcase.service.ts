import { Injectable, Logger, BadRequestException, NotFoundException, ForbiddenException, ConflictException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ContentHiddenReason, Prisma, ShowcaseVisibility } from '@prisma/client';
import { createHash } from 'crypto';
import { PrismaService } from '../../prisma/prisma.service';
import { RedisService } from '../../redis/redis.service';
import { UploadService } from '../upload/upload.service';
import { UploadPurpose } from '../upload/dto/presigned-url.dto';
import * as ErrorCodes from '../../common/constants/error-codes';
import { escapeLikePattern } from '../../common/utils/search.util';
import {
  ORDER_MAX_VALUE,
  ORDER_MIN_VALUE,
  SHOWCASE_COMMENT_MAX_LENGTH,
  SHOWCASE_FEED_MAX_LIMIT,
  SHOWCASE_MAX_IMAGES,
  SHOWCASE_MAX_ITEMS,
  SHOWCASE_VIEW_DEDUPE_TTL_SECONDS,
} from '../../common/constants/app.constants';
import { CreateShowcaseItemDto, UpdateShowcaseItemDto } from './dto/showcase-item.dto';
import { CreateShowcaseCommentDto, UpdateShowcaseCommentDto } from './dto/showcase-comment.dto';
import { ShowcaseFeedQueryDto, ShowcaseFeedSort } from './dto/showcase-feed-query.dto';

/**
 * Section 3 — Showcase sebagai konten sosial + feed discover.
 *
 * Prinsip yang dipegang di seluruh file ini:
 *  - Soft-delete / status akun: item hanya tampil publik bila pemiliknya
 *    isActive, tidak banned, deletedAt null, dan profileVisible true.
 *  - Block-list: viewer tidak pernah melihat item/komentar dari orang yang
 *    saling blokir dengannya (pola user-search.service.ts). Interaksi (like /
 *    komentar) ditolak 403 USER_BLOCKED, bukan disembunyikan diam-diam.
 *  - Counter denormalisasi (likeCount/commentCount/viewCount) selalu di-update
 *    dengan Prisma atomic increment di dalam transaksi yang sama dengan mutasi
 *    barisnya (pola TransactionTemplatesService.recordUsage), dan decrement
 *    diberi guard `gt/gte 0` supaya tidak pernah negatif.
 *  - Feed memakai CURSOR (keyset), bukan offset: offset pada feed yang terus
 *    bertambah menghasilkan duplikat/lompatan.
 *  - Pencarian memakai `escapeLikePattern` agar `%`/`_`/`\` dari user tidak
 *    menjadi wildcard.
 */

/** Baris showcase lengkap dengan relasi yang dipakai serializer. */
type ShowcaseRow = Prisma.UserShowcaseGetPayload<{
  include: {
    images: true;
    user: {
      select: {
        id: true;
        userId: true;
        username: true;
        fullName: true;
        avatarUrl: true;
        kycStatus: true;
        isVip: true;
        membershipRank: true;
      };
    };
  };
}>;

type CommentRow = Prisma.ShowcaseCommentGetPayload<{
  include: {
    user: { select: { userId: true; username: true; fullName: true; avatarUrl: true } };
  };
}>;

/** Include standar: gambar terurut + ringkasan pemilik. Dipakai di semua jalur baca. */
const SHOWCASE_INCLUDE = {
  images: { orderBy: [{ sortOrder: 'asc' as const }, { id: 'asc' as const }] },
  user: {
    select: {
      id: true,
      userId: true,
      username: true,
      fullName: true,
      avatarUrl: true,
      kycStatus: true,
      isVip: true,
      membershipRank: true,
    },
  },
} satisfies Prisma.UserShowcaseInclude;

const COMMENT_INCLUDE = {
  user: { select: { userId: true, username: true, fullName: true, avatarUrl: true } },
} satisfies Prisma.ShowcaseCommentInclude;

/** Versi payload cursor. Naikkan bila struktur cursor berubah supaya cursor lama
 *  ditolak eksplisit (INVALID_CURSOR) alih-alih menghasilkan halaman ngawur. */
const FEED_CURSOR_VERSION = 1;

/**
 * Sentinel untuk cabang "pemilik melihat itemnya sendiri" pada filter OR.
 * `userId` adalah cuid, jadi nilai ini tidak akan pernah cocok dengan baris apa
 * pun; dipakai supaya cabang tersebut tetap ada (dan tidak berubah arti) ketika
 * `viewerId` undefined (viewer anonim).
 */
const SELF_BRANCH_NEVER_MATCHES = '\u0000anonymous';

interface FeedCursorPayload {
  /** createdAt baris terakhir, dalam epoch ms. */
  t: number;
  /** likeCount baris terakhir (dipakai sort `popular`). */
  l: number;
  /** id baris terakhir — tiebreak terakhir, menjamin urutan total. */
  i: string;
}

function encodeFeedCursor(row: { createdAt: Date; likeCount: number; id: string }): string {
  const payload: { v: number } & FeedCursorPayload = {
    v: FEED_CURSOR_VERSION,
    t: row.createdAt.getTime(),
    l: row.likeCount,
    i: row.id,
  };
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

function decodeFeedCursor(cursor: string): FeedCursorPayload {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    parsed = null;
  }
  const p = parsed as ({ v: unknown } & Partial<FeedCursorPayload>) | null;
  if (
    !p ||
    p.v !== FEED_CURSOR_VERSION ||
    typeof p.t !== 'number' ||
    !Number.isFinite(p.t) ||
    typeof p.l !== 'number' ||
    !Number.isFinite(p.l) ||
    typeof p.i !== 'string' ||
    p.i.length === 0 ||
    p.i.length > 64
  ) {
    throw new BadRequestException({ code: ErrorCodes.INVALID_CURSOR, message: 'Invalid feed cursor' });
  }
  return { t: p.t as number, l: p.l as number, i: p.i as string };
}

function toNumber(value: bigint | null): number | null {
  return value === null || value === undefined ? null : Number(value);
}

@Injectable()
export class ShowcaseService {
  private readonly logger = new Logger(ShowcaseService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly uploadService: UploadService,
    private readonly configService: ConfigService,
  ) {}

  // ==================================================================
  // Helper privasi
  // ==================================================================

  /**
   * ID user yang harus disaring dari hasil baca milik `viewerId`: semua pihak
   * dalam relasi block dua arah. Pola sama dengan user-search.service.ts.
   */
  private async getViewerExcludedIds(viewerId?: string): Promise<string[]> {
    if (!viewerId) return [];
    const blocks = await this.prisma.blockList.findMany({
      where: { OR: [{ blockerId: viewerId }, { blockedId: viewerId }] },
      select: { blockerId: true, blockedId: true },
    });
    const ids = new Set<string>();
    for (const block of blocks) {
      if (block.blockerId !== viewerId) ids.add(block.blockerId);
      if (block.blockedId !== viewerId) ids.add(block.blockedId);
    }
    return Array.from(ids);
  }

  /** Filter pemilik agar item hanya muncul dari akun yang sehat & publik. */
  private visibleOwnerFilter(excludedIds: string[]): Prisma.UserWhereInput {
    return {
      isActive: true,
      isBanned: false,
      deletedAt: null,
      profileVisible: true,
      ...(excludedIds.length > 0 ? { id: { notIn: excludedIds } } : {}),
    };
  }

  /**
   * Menolak 403 bila ada relasi block dua arah antara actor dan pemilik showcase.
   * Dipakai sebelum like/komentar supaya user yang diblokir tidak bisa berinteraksi.
   */
  private async assertNoBlockRelation(actorId: string, ownerId: string): Promise<void> {
    if (actorId === ownerId) return;
    const block = await this.prisma.blockList.findFirst({
      where: {
        OR: [
          { blockerId: actorId, blockedId: ownerId },
          { blockerId: ownerId, blockedId: actorId },
        ],
      },
      select: { id: true },
    });
    if (block) {
      throw new ForbiddenException({
        code: ErrorCodes.USER_BLOCKED,
        message: 'You cannot interact with this content',
      });
    }
  }

  /**
   * Ambil showcase untuk konsumsi PUBLIK. Mengembalikan null (bukan melempar)
   * bila tidak boleh terlihat, supaya pemanggil bisa memutuskan 404-nya.
   *
   * Aturan: item harus isActive; visibility PRIVATE hanya untuk pemiliknya;
   * pemilik harus aktif/tidak banned/belum dihapus/profil publik; dan tidak ada
   * relasi block dengan viewer.
   */
  private async findVisibleShowcase(
    showcaseId: string,
    viewerId?: string,
  ): Promise<{ row: ShowcaseRow; isOwner: boolean } | null> {
    const excludedIds = await this.getViewerExcludedIds(viewerId);
    const row = (await this.prisma.userShowcase.findFirst({
      where: {
        id: showcaseId,
        isActive: true,
        // Dua cabang: (1) pemilik selalu boleh melihat itemnya sendiri, termasuk
        //     yang PRIVATE dan termasuk saat profilnya sedang tidak publik —
        //     kalau tidak, owner kehilangan preview item privatnya sendiri;
        //     (2) selain pemilik, item harus PUBLIC dan pemiliknya harus akun
        //     aktif, tidak banned, belum terhapus, profil publik, dan tidak
        //     terlibat relasi block dengan viewer.
        OR: [
          { userId: viewerId ?? SELF_BRANCH_NEVER_MATCHES },
          { visibility: ShowcaseVisibility.PUBLIC, user: this.visibleOwnerFilter(excludedIds) },
        ],
      },
      include: SHOWCASE_INCLUDE,
    })) as ShowcaseRow | null;
    if (!row) return null;

    const isOwner = Boolean(viewerId && viewerId === row.userId);
    return { row, isOwner };
  }

  /** Ambil showcase milik `userId` untuk jalur tulis (CRUD owner). */
  private async findOwnedShowcase(userId: string, showcaseId: string) {
    const row = await this.prisma.userShowcase.findFirst({
      where: { id: showcaseId, userId },
      include: { images: { orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }] } },
    });
    if (!row) {
      throw new NotFoundException({ code: ErrorCodes.SHOWCASE_NOT_FOUND, message: 'Showcase item not found' });
    }
    return row;
  }

  // ==================================================================
  // Serializer
  // ==================================================================

  /**
   * Bentuk publik satu item showcase.
   *
   * `orderLink` berisi data siap pakai untuk membuat OrderLink dari item ini
   * (title/description/orderValue/counterpartUsername sudah ter-prefill) supaya
   * tombol "Pesan" di feed discover tidak perlu merakit apa pun lagi.
   */
  private serializeShowcase(
    row: ShowcaseRow,
    options: { isLiked?: boolean; isOwner?: boolean } = {},
  ): Record<string, unknown> {
    const images = row.images.map((image) => ({
      id: image.id,
      imageUrl: image.imageUrl,
      sortOrder: image.sortOrder,
    }));
    const priceMin = toNumber(row.priceMin);
    const priceMax = toNumber(row.priceMax);
    const coverImageUrl = images.length > 0 ? images[0].imageUrl : null;
    const orderValue = priceMin ?? priceMax ?? null;
    const counterpartUsername = row.user.username ?? row.user.userId;

    // Deskripsi OrderLink punya minLength 10; deskripsi showcase boleh kosong,
    // jadi sediakan fallback yang tetap masuk akal.
    const description = row.description?.trim();
    const orderDescription =
      description && description.length >= 10
        ? description.slice(0, 500)
        : `Pesan "${row.title}" dari @${counterpartUsername} di Kahade.`.slice(0, 500);

    return {
      id: row.id,
      title: row.title,
      description: row.description,
      category: row.category,
      visibility: row.visibility,
      isActive: row.isActive,
      sortOrder: row.sortOrder,
      images,
      coverImageUrl,
      // Alias deprecated: kolom tunggal `imageUrl` sudah diganti ShowcaseImage.
      // Dipertahankan supaya client lama tidak putus selama migrasi.
      imageUrl: coverImageUrl,
      priceMin,
      priceMax,
      likeCount: row.likeCount,
      commentCount: row.commentCount,
      viewCount: row.viewCount,
      isLiked: Boolean(options.isLiked),
      isOwner: Boolean(options.isOwner),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      author: {
        userId: row.user.userId,
        username: row.user.username,
        fullName: row.user.fullName,
        avatarUrl: row.user.avatarUrl,
        membershipRank: row.user.membershipRank,
        isKycVerified: row.user.kycStatus === 'APPROVED',
        isVip: row.user.isVip,
      },
      orderLink: {
        title: row.title.slice(0, 100),
        description: orderDescription,
        orderValue,
        orderValueValid: orderValue !== null && orderValue >= ORDER_MIN_VALUE && orderValue <= ORDER_MAX_VALUE,
        counterpartUsername,
      },
      shareUrl: this.buildShareUrl(row.id),
    };
  }

  /** URL web untuk halaman share showcase (pola OrderLinksService.getShareUrl). */
  private buildShareUrl(showcaseId: string): string {
    const base = (
      this.configService?.get<string>('app.publicWebBaseUrl') ??
      process.env.PUBLIC_WEB_BASE_URL ??
      'https://kahade.id'
    ).replace(/\/$/, '');
    return `${base}/showcase/${encodeURIComponent(showcaseId)}`;
  }

  /** `isLiked` untuk banyak item sekaligus — satu query, bukan N+1. */
  private async getLikedShowcaseIds(viewerId: string | undefined, showcaseIds: string[]): Promise<Set<string>> {
    if (!viewerId || showcaseIds.length === 0) return new Set();
    const rows = await this.prisma.showcaseLike.findMany({
      where: { userId: viewerId, showcaseId: { in: showcaseIds } },
      select: { showcaseId: true },
    });
    return new Set(rows.map((r) => r.showcaseId));
  }

  // ==================================================================
  // CRUD owner
  // ==================================================================

  async getMyShowcase(userId: string): Promise<object> {
    const items = (await this.prisma.userShowcase.findMany({
      where: { userId },
      orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
      include: SHOWCASE_INCLUDE,
    })) as unknown as ShowcaseRow[];

    return {
      items: items.map((item) => this.serializeShowcase(item, { isOwner: true })),
      total: items.length,
      limits: { maxItems: SHOWCASE_MAX_ITEMS, maxImagesPerItem: SHOWCASE_MAX_IMAGES },
    };
  }

  async createShowcaseItem(userId: string, dto: CreateShowcaseItemDto): Promise<object> {
    const count = await this.prisma.userShowcase.count({ where: { userId } });
    if (count >= SHOWCASE_MAX_ITEMS) {
      throw new BadRequestException({
        code: ErrorCodes.SHOWCASE_ITEM_LIMIT_REACHED,
        message: `Maximum ${SHOWCASE_MAX_ITEMS} showcase items allowed`,
      });
    }

    const title = this.normalizeTitle(dto.title);
    this.assertPriceRange(dto.priceMin, dto.priceMax);
    const imageFileKeys = await this.prepareImageKeys(userId, dto.imageFileKeys);

    const item = (await this.prisma.userShowcase.create({
      data: {
        userId,
        title,
        description: this.normalizeDescription(dto.description),
        category: this.normalizeCategory(dto.category),
        visibility: dto.visibility ?? ShowcaseVisibility.PUBLIC,
        priceMin: dto.priceMin !== undefined ? BigInt(dto.priceMin) : null,
        priceMax: dto.priceMax !== undefined ? BigInt(dto.priceMax) : null,
        sortOrder: dto.sortOrder ?? count,
        images: {
          create: imageFileKeys.map((image, index) => ({
            imageUrl: image.imageUrl,
            fileKey: image.fileKey,
            sortOrder: index,
          })),
        },
      },
      include: SHOWCASE_INCLUDE,
    })) as unknown as ShowcaseRow;

    return this.serializeShowcase(item, { isOwner: true });
  }

  async updateShowcaseItem(userId: string, itemId: string, dto: UpdateShowcaseItemDto): Promise<object> {
    const existing = await this.findOwnedShowcase(userId, itemId);

    if (dto.title !== undefined) this.normalizeTitle(dto.title);
    const priceMin = dto.priceMin !== undefined ? dto.priceMin : toNumber(existing.priceMin) ?? undefined;
    const priceMax = dto.priceMax !== undefined ? dto.priceMax : toNumber(existing.priceMax) ?? undefined;
    this.assertPriceRange(priceMin, priceMax);

    const data: Prisma.UserShowcaseUpdateInput = {};
    if (dto.title !== undefined) data.title = dto.title.trim();
    if (dto.description !== undefined) data.description = this.normalizeDescription(dto.description);
    if (dto.category !== undefined) data.category = this.normalizeCategory(dto.category);
    if (dto.visibility !== undefined) data.visibility = dto.visibility;
    if (dto.priceMin !== undefined) data.priceMin = BigInt(dto.priceMin);
    if (dto.priceMax !== undefined) data.priceMax = BigInt(dto.priceMax);
    if (dto.isActive !== undefined) data.isActive = dto.isActive;
    if (dto.sortOrder !== undefined) data.sortOrder = dto.sortOrder;

    // imageFileKeys yang diisi (termasuk array kosong) berarti "ganti semua gambar".
    if (dto.imageFileKeys !== undefined) {
      const imageFileKeys = await this.prepareImageKeys(userId, dto.imageFileKeys);
      const removedKeys = existing.images.map((image) => image.fileKey).filter((k): k is string => Boolean(k));
      data.images = {
        deleteMany: {},
        create: imageFileKeys.map((image, index) => ({
          imageUrl: image.imageUrl,
          fileKey: image.fileKey,
          sortOrder: index,
        })),
      };
      // Bersihkan object lama dari R2 SETELAH commit supaya kegagalan storage
      // tidak membatalkan update yang sudah sukses.
      this.scheduleImageCleanup(userId, removedKeys);
    }

    const item = (await this.prisma.userShowcase.update({
      where: { id: itemId },
      data,
      include: SHOWCASE_INCLUDE,
    })) as unknown as ShowcaseRow;

    return this.serializeShowcase(item, { isOwner: true });
  }

  async deleteShowcaseItem(userId: string, itemId: string): Promise<{ message: string }> {
    const existing = await this.findOwnedShowcase(userId, itemId);
    await this.prisma.userShowcase.delete({ where: { id: itemId } });
    const removedKeys = existing.images.map((image) => image.fileKey).filter((k): k is string => Boolean(k));
    this.scheduleImageCleanup(userId, removedKeys);
    return { message: 'Showcase item deleted successfully' };
  }

  // ==================================================================
  // Gambar (one-to-many)
  // ==================================================================

  /**
   * Verifikasi + ubah object key hasil upload presigned menjadi baris gambar.
   * `verifyUserFileKeys` menegakkan: bentuk key, kepemilikan (folder = userId),
   * konfirmasi /upload/confirm, ukuran tersimpan, dan content type tersimpan —
   * setara `verifyStoredImage` pada alur avatar/header.
   */
  private async prepareImageKeys(
    userId: string,
    fileKeys: string[] | undefined,
  ): Promise<{ fileKey: string; imageUrl: string }[]> {
    if (!fileKeys || fileKeys.length === 0) return [];
    if (fileKeys.length > SHOWCASE_MAX_IMAGES) {
      throw new BadRequestException({
        code: ErrorCodes.SHOWCASE_IMAGE_LIMIT_REACHED,
        message: `Maximum ${SHOWCASE_MAX_IMAGES} images per showcase item`,
      });
    }
    await this.uploadService.verifyUserFileKeys(userId, fileKeys, UploadPurpose.SHOWCASE_IMAGE, {
      maxFiles: SHOWCASE_MAX_IMAGES,
      consume: true,
      label: 'Showcase image',
    });
    return fileKeys.map((fileKey) => ({ fileKey, imageUrl: this.uploadService.buildPublicUrl(fileKey) }));
  }

  /**
   * Hapus object gambar dari R2 tanpa menggagalkan operasi utamanya.
   * Kegagalan storage hanya di-log: baris DB sudah benar, object yatim akan
   * disapu oleh orphaned-upload-cleanup.service.ts.
   */
  private scheduleImageCleanup(userId: string, fileKeys: string[]): void {
    if (fileKeys.length === 0) return;
    void this.uploadService
      .cleanupFileKeys(userId, fileKeys)
      .catch((err) => this.logger.warn(`Showcase image cleanup failed for user=${userId}`, err));
  }

  async attachImages(userId: string, itemId: string, fileKeys: string[]): Promise<object> {
    const existing = await this.findOwnedShowcase(userId, itemId);
    if (existing.images.length + fileKeys.length > SHOWCASE_MAX_IMAGES) {
      throw new BadRequestException({
        code: ErrorCodes.SHOWCASE_IMAGE_LIMIT_REACHED,
        message: `Maximum ${SHOWCASE_MAX_IMAGES} images per showcase item`,
      });
    }
    const prepared = await this.prepareImageKeys(userId, fileKeys);
    if (prepared.length === 0) {
      throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'fileKeys must not be empty' });
    }

    const nextSortOrder = existing.images.reduce((max, image) => Math.max(max, image.sortOrder), -1) + 1;
    const created = await this.prisma.showcaseImage.createMany({
      data: prepared.map((image, index) => ({
        showcaseId: itemId,
        imageUrl: image.imageUrl,
        fileKey: image.fileKey,
        sortOrder: nextSortOrder + index,
      })),
    });

    return { added: created.count, images: await this.listImages(itemId) };
  }

  async removeImage(userId: string, imageId: string): Promise<{ message: string }> {
    const image = await this.prisma.showcaseImage.findFirst({
      where: { id: imageId, showcase: { userId } },
      select: { id: true, fileKey: true, showcaseId: true },
    });
    if (!image) {
      throw new NotFoundException({ code: ErrorCodes.SHOWCASE_NOT_FOUND, message: 'Showcase image not found' });
    }
    await this.prisma.showcaseImage.delete({ where: { id: imageId } });
    if (image.fileKey) this.scheduleImageCleanup(userId, [image.fileKey]);
    return { message: 'Showcase image deleted successfully' };
  }

  async reorderImages(userId: string, itemId: string, imageIds: string[]): Promise<object> {
    const existing = await this.findOwnedShowcase(userId, itemId);
    const currentIds = existing.images.map((image) => image.id).sort();
    const requestedIds = [...imageIds].sort();
    if (currentIds.length !== requestedIds.length || currentIds.some((id, index) => id !== requestedIds[index])) {
      throw new BadRequestException({
        code: ErrorCodes.VALIDATION_ERROR,
        message: 'imageIds must contain every image of this showcase item exactly once',
      });
    }

    await this.prisma.$transaction(
      imageIds.map((imageId, index) =>
        this.prisma.showcaseImage.updateMany({
          where: { id: imageId, showcaseId: itemId },
          data: { sortOrder: index },
        }),
      ),
    );
    return { images: await this.listImages(itemId) };
  }

  private async listImages(showcaseId: string) {
    const images = await this.prisma.showcaseImage.findMany({
      where: { showcaseId },
      orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
      select: { id: true, imageUrl: true, sortOrder: true },
    });
    return images;
  }

  /**
   * Jalur upload langsung (multipart) yang lama. Dipertahankan untuk client yang
   * belum pindah ke alur presigned, tapi sekarang lewat UploadService supaya
   * validasi magic-byte/ukuran terpusat di satu tempat.
   */
  async uploadShowcaseImageDirect(
    userId: string,
    fileName: string,
    contentType: string,
    fileBuffer: Buffer,
  ): Promise<{ imageUrl: string; fileKey: string }> {
    const result = await this.uploadService.uploadDirect(
      userId,
      UploadPurpose.SHOWCASE_IMAGE,
      fileName,
      contentType,
      fileBuffer,
    );
    return { imageUrl: result.fileUrl, fileKey: result.fileKey };
  }

  // ==================================================================
  // Baca publik
  // ==================================================================

  /** Etalase di profil publik: hanya item PUBLIC milik owner yang terlihat. */
  async getShowcaseByUsername(username: string, viewerId?: string): Promise<object> {
    const user = await this.prisma.user.findUnique({
      where: { username: username.toLowerCase() },
      select: { id: true, profileVisible: true, isActive: true, isBanned: true, deletedAt: true },
    });
    if (!user || !user.profileVisible || user.isActive === false || user.isBanned === true || user.deletedAt != null) {
      throw new NotFoundException({ code: ErrorCodes.USER_NOT_FOUND, message: 'User not found' });
    }
    // Section 2/3 menyamakan perilaku: relasi block dua arah -> 403, bukan
    // menyembunyikan sebagian field.
    if (viewerId && viewerId !== user.id) {
      await this.assertNoBlockRelation(viewerId, user.id);
    }

    const excludedIds = await this.getViewerExcludedIds(viewerId);
    const items = (await this.prisma.userShowcase.findMany({
      where: {
        userId: user.id,
        isActive: true,
        visibility: ShowcaseVisibility.PUBLIC,
        user: this.visibleOwnerFilter(excludedIds),
      },
      orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
      include: SHOWCASE_INCLUDE,
    })) as unknown as ShowcaseRow[];

    const likedIds = await this.getLikedShowcaseIds(viewerId, items.map((item) => item.id));
    return {
      items: items.map((item) => this.serializeShowcase(item, { isLiked: likedIds.has(item.id) })),
      total: items.length,
    };
  }

  /**
   * Detail satu item + kenaikan viewCount.
   *
   * viewCount dinaikkan dengan atomic increment dan di-dedupe per viewer selama
   * SHOWCASE_VIEW_DEDUPE_TTL_SECONDS memakai SET NX (bukan INCR telanjang), jadi
   * refresh berulang tidak menggelembungkan angka.
   */
  async getShowcaseDetail(
    showcaseId: string,
    viewerId?: string,
    options: { clientIp?: string } = {},
  ): Promise<object> {
    const visible = await this.findVisibleShowcase(showcaseId, viewerId);
    if (!visible) {
      throw new NotFoundException({ code: ErrorCodes.SHOWCASE_NOT_FOUND, message: 'Showcase item not found' });
    }

    const counted = await this.recordView(showcaseId, viewerId, options.clientIp);
    const likedIds = await this.getLikedShowcaseIds(viewerId, [showcaseId]);

    return {
      ...this.serializeShowcase(visible.row, {
        isLiked: likedIds.has(showcaseId),
        isOwner: visible.isOwner,
      }),
      // viewCount yang dikembalikan adalah nilai SETELAH increment bila view ini
      // ikut dihitung, supaya UI tidak menampilkan angka yang tertinggal.
      viewCount: counted ? visible.row.viewCount + 1 : visible.row.viewCount,
    };
  }

  private async recordView(showcaseId: string, viewerId?: string, clientIp?: string): Promise<boolean> {
    const viewerKey = viewerId
      ? `u:${viewerId}`
      : clientIp
        ? `ip:${createHash('sha256').update(clientIp).digest('hex').slice(0, 32)}`
        : null;
    // Tanpa identitas yang stabil (anonim tanpa IP) view tetap dihitung, tapi
    // tidak bisa di-dedupe — lebih baik sedikit over-count daripada kehilangan
    // sinyal popularitas sama sekali.
    if (viewerKey) {
      const isNew = await this.redis.setNx(
        `showcase:view:${showcaseId}:${viewerKey}`,
        '1',
        SHOWCASE_VIEW_DEDUPE_TTL_SECONDS,
      );
      if (!isNew) return false;
    }
    // Atomic increment + scope id: pola TransactionTemplatesService.recordUsage.
    await this.prisma.userShowcase.updateMany({
      where: { id: showcaseId },
      data: { viewCount: { increment: 1 } },
    });
    return true;
  }

  // ==================================================================
  // Feed discover (cursor-based)
  // ==================================================================

  async getFeed(viewerId: string | undefined, query: ShowcaseFeedQueryDto): Promise<object> {
    const limit = Math.min(Math.max(1, Math.floor(query.limit ?? 20)), SHOWCASE_FEED_MAX_LIMIT);
    const sort: ShowcaseFeedSort = query.sort === 'popular' ? 'popular' : 'latest';

    const excludedIds = await this.getViewerExcludedIds(viewerId);
    const andClauses: Prisma.UserShowcaseWhereInput[] = [];

    const baseWhere: Prisma.UserShowcaseWhereInput = {
      visibility: ShowcaseVisibility.PUBLIC,
      isActive: true,
      user: this.visibleOwnerFilter(excludedIds),
    };

    // Normalisasi defensif (trim + lowercase) walau DTO sudah melakukannya:
    // category disimpan dalam bentuk lowercase oleh createShowcaseItem, jadi
    // filter yang tidak dinormalisasi tidak akan pernah cocok.
    const category = this.normalizeCategory(query.category);
    if (category) {
      andClauses.push({ category });
    }

    const search = query.search?.trim();
    if (search) {
      // escapeLikePattern: `%`, `_`, `\` dari user diperlakukan literal.
      const pattern = escapeLikePattern(search);
      andClauses.push({
        OR: [
          { title: { contains: pattern, mode: 'insensitive' } },
          { description: { contains: pattern, mode: 'insensitive' } },
          { category: { contains: pattern, mode: 'insensitive' } },
          { user: { username: { contains: pattern, mode: 'insensitive' } } },
          { user: { fullName: { contains: pattern, mode: 'insensitive' } } },
        ],
      });
    }

    // Keyset: "baris-baris setelah cursor" menurut urutan sort. Menggunakan
    // tuple (sortKey..., id) sehingga hasilnya deterministik walau banyak baris
    // berbagi createdAt/likeCount yang sama.
    if (query.cursor) {
      const cursor = decodeFeedCursor(query.cursor);
      const cursorDate = new Date(cursor.t);
      if (sort === 'popular') {
        andClauses.push({
          OR: [
            { likeCount: { lt: cursor.l } },
            { likeCount: cursor.l, createdAt: { lt: cursorDate } },
            { likeCount: cursor.l, createdAt: cursorDate, id: { lt: cursor.i } },
          ],
        });
      } else {
        andClauses.push({
          OR: [{ createdAt: { lt: cursorDate } }, { createdAt: cursorDate, id: { lt: cursor.i } }],
        });
      }
    }

    const where: Prisma.UserShowcaseWhereInput =
      andClauses.length > 0 ? { ...baseWhere, AND: andClauses } : baseWhere;
    const orderBy: Prisma.UserShowcaseOrderByWithRelationInput[] =
      sort === 'popular'
        ? [{ likeCount: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }]
        : [{ createdAt: 'desc' }, { id: 'desc' }];

    // Ambil limit + 1: satu baris ekstra dipakai untuk memastikan `hasMore`
    // akurat tanpa perlu query COUNT(*) di setiap scroll.
    const rows = (await this.prisma.userShowcase.findMany({
      where,
      orderBy,
      take: limit + 1,
      include: SHOWCASE_INCLUDE,
    })) as unknown as ShowcaseRow[];

    const hasMore = rows.length > limit;
    const pageRows = hasMore ? rows.slice(0, limit) : rows;
    const likedIds = await this.getLikedShowcaseIds(viewerId, pageRows.map((row) => row.id));

    return {
      items: pageRows.map((row) => this.serializeShowcase(row, { isLiked: likedIds.has(row.id) })),
      sort,
      limit,
      hasMore,
      nextCursor: hasMore && pageRows.length > 0 ? encodeFeedCursor(pageRows[pageRows.length - 1]) : null,
    };
  }

  // ==================================================================
  // Like
  // ==================================================================

  async likeShowcase(userId: string, showcaseId: string): Promise<object> {
    const visible = await this.findVisibleShowcase(showcaseId, userId);
    if (!visible) {
      throw new NotFoundException({ code: ErrorCodes.SHOWCASE_NOT_FOUND, message: 'Showcase item not found' });
    }
    await this.assertNoBlockRelation(userId, visible.row.userId);

    try {
      const updated = await this.prisma.$transaction(async (tx) => {
        await tx.showcaseLike.create({ data: { userId, showcaseId } });
        return tx.userShowcase.update({
          where: { id: showcaseId },
          data: { likeCount: { increment: 1 } },
          select: { likeCount: true },
        });
      });
      return { liked: true, likeCount: updated.likeCount };
    } catch (err) {
      // Unique (userId, showcaseId) -> like ganda dari request balapan.
      if (this.isUniqueViolation(err)) {
        const current = await this.prisma.userShowcase.findUnique({
          where: { id: showcaseId },
          select: { likeCount: true },
        });
        throw new ConflictException({
          code: ErrorCodes.SHOWCASE_ALREADY_LIKED,
          message: 'You already liked this showcase item',
          likeCount: current?.likeCount ?? null,
        });
      }
      throw err;
    }
  }

  async unlikeShowcase(userId: string, showcaseId: string): Promise<object> {
    const visible = await this.findVisibleShowcase(showcaseId, userId);
    if (!visible) {
      throw new NotFoundException({ code: ErrorCodes.SHOWCASE_NOT_FOUND, message: 'Showcase item not found' });
    }

    await this.prisma.$transaction(async (tx) => {
      const deleted = await tx.showcaseLike.deleteMany({ where: { userId, showcaseId } });
      if (deleted.count === 0) {
        throw new NotFoundException({
          code: ErrorCodes.SHOWCASE_NOT_LIKED,
          message: 'You have not liked this showcase item',
        });
      }
      // Guard `gt: 0` supaya counter tidak pernah turun di bawah nol walaupun
      // ada selisih historis antara baris like dan counter.
      await tx.userShowcase.updateMany({
        where: { id: showcaseId, likeCount: { gt: 0 } },
        data: { likeCount: { decrement: 1 } },
      });
    });

    const current = await this.prisma.userShowcase.findUnique({
      where: { id: showcaseId },
      select: { likeCount: true },
    });
    return { liked: false, likeCount: current?.likeCount ?? 0 };
  }

  private isUniqueViolation(err: unknown): boolean {
    return (
      typeof err === 'object' &&
      err !== null &&
      (err as { code?: string }).code === 'P2002'
    );
  }

  // ==================================================================
  // Komentar
  // ==================================================================

  /**
   * Daftar komentar ber-nesting (root + balasan satu tingkat).
   *
   * Offset pagination di sini aman karena daftar komentar satu item tidak
   * di-infinite-scroll lintas filter; tiebreak { id } menjaga halaman stabil.
   * Komentar tersembunyi disaring, kecuali untuk pemilik showcase yang memang
   * perlu melihat apa yang ia sembunyikan.
   */
  async listComments(showcaseId: string, viewerId: string | undefined, page: number, limit: number): Promise<object> {
    const visible = await this.findVisibleShowcase(showcaseId, viewerId);
    if (!visible) {
      throw new NotFoundException({ code: ErrorCodes.SHOWCASE_NOT_FOUND, message: 'Showcase item not found' });
    }

    const safePage = Number.isFinite(page) ? Math.max(1, Math.floor(page)) : 1;
    const safeLimit = Number.isFinite(limit) ? Math.min(Math.max(1, Math.floor(limit)), 50) : 20;
    const skip = (safePage - 1) * safeLimit;

    const excludedIds = await this.getViewerExcludedIds(viewerId);
    const authorFilter: Prisma.UserWhereInput = {
      isActive: true,
      isBanned: false,
      deletedAt: null,
      ...(excludedIds.length > 0 ? { id: { notIn: excludedIds } } : {}),
    };
    const where: Prisma.ShowcaseCommentWhereInput = {
      showcaseId,
      parentId: null,
      user: authorFilter,
      ...(visible.isOwner ? {} : { isHidden: false }),
    };

    const [roots, total] = await Promise.all([
      this.prisma.showcaseComment
        .findMany({
          where,
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          skip,
          take: safeLimit,
          include: COMMENT_INCLUDE,
        })
        .then((rows) => rows as unknown as CommentRow[]),
      this.prisma.showcaseComment.count({ where }),
    ]);

    // Semua balasan untuk root di halaman ini diambil sekali (bukan N+1).
    const replies =
      roots.length > 0
        ? ((await this.prisma.showcaseComment.findMany({
            where: {
              parentId: { in: roots.map((root) => root.id) },
              user: authorFilter,
              ...(visible.isOwner ? {} : { isHidden: false }),
            },
            orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
            include: COMMENT_INCLUDE,
          })) as unknown as CommentRow[])
        : [];

    const repliesByParent = new Map<string, CommentRow[]>();
    for (const reply of replies) {
      const parentId = reply.parentId as string | null;
      if (!parentId) continue;
      const bucket = repliesByParent.get(parentId);
      if (bucket) bucket.push(reply);
      else repliesByParent.set(parentId, [reply]);
    }

    const data = roots.map((root) => ({
      ...this.serializeComment(root as CommentRow),
      replies: (repliesByParent.get(root.id) ?? []).map((reply) => this.serializeComment(reply)),
    }));

    const totalPages = Math.ceil(total / safeLimit);
    return {
      data,
      total,
      page: safePage,
      limit: safeLimit,
      totalPages,
      hasNext: safePage < totalPages,
      hasPrev: safePage > 1,
    };
  }

  private serializeComment(row: CommentRow): Record<string, unknown> {
    return {
      id: row.id,
      showcaseId: row.showcaseId,
      parentId: row.parentId,
      content: row.content,
      isHidden: row.isHidden,
      hiddenReason: row.isHidden ? row.hiddenReason : null,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      author: {
        userId: row.user.userId,
        username: row.user.username,
        fullName: row.user.fullName,
        avatarUrl: row.user.avatarUrl,
      },
    };
  }

  async addComment(userId: string, showcaseId: string, dto: CreateShowcaseCommentDto): Promise<object> {
    const content = dto.content?.trim();
    if (!content) {
      throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Comment content is required' });
    }
    if (content.length > SHOWCASE_COMMENT_MAX_LENGTH) {
      throw new BadRequestException({
        code: ErrorCodes.VALIDATION_ERROR,
        message: `Comment exceeds maximum length of ${SHOWCASE_COMMENT_MAX_LENGTH} characters`,
      });
    }

    const visible = await this.findVisibleShowcase(showcaseId, userId);
    if (!visible) {
      throw new NotFoundException({ code: ErrorCodes.SHOWCASE_NOT_FOUND, message: 'Showcase item not found' });
    }
    await this.assertNoBlockRelation(userId, visible.row.userId);

    let parentId: string | null = null;
    if (dto.parentId) {
      const parent = await this.prisma.showcaseComment.findFirst({
        where: { id: dto.parentId, showcaseId },
        select: { id: true, parentId: true, isHidden: true },
      });
      if (!parent) {
        throw new NotFoundException({
          code: ErrorCodes.SHOWCASE_COMMENT_NOT_FOUND,
          message: 'Parent comment not found',
        });
      }
      if (parent.isHidden) {
        throw new BadRequestException({
          code: ErrorCodes.SHOWCASE_COMMENT_HIDDEN,
          message: 'Cannot reply to a hidden comment',
        });
      }
      // Kedalaman maksimum 2 (root + balasan). Balasan dari balasan ditolak
      // eksplisit supaya UI tidak perlu merender tree tak terbatas.
      if (parent.parentId !== null) {
        throw new BadRequestException({
          code: ErrorCodes.SHOWCASE_COMMENT_DEPTH_EXCEEDED,
          message: 'Replies cannot be nested deeper than one level',
        });
      }
      parentId = parent.id;
    }

    const created = (await this.prisma.$transaction(async (tx) => {
      const comment = await tx.showcaseComment.create({
        data: { showcaseId, userId, parentId, content },
        include: COMMENT_INCLUDE,
      });
      await tx.userShowcase.update({
        where: { id: showcaseId },
        data: { commentCount: { increment: 1 } },
      });
      return comment;
    })) as unknown as CommentRow;

    return this.serializeComment(created);
  }

  async updateComment(userId: string, commentId: string, dto: UpdateShowcaseCommentDto): Promise<object> {
    const content = dto.content?.trim();
    if (!content) {
      throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Comment content is required' });
    }
    if (content.length > SHOWCASE_COMMENT_MAX_LENGTH) {
      throw new BadRequestException({
        code: ErrorCodes.VALIDATION_ERROR,
        message: `Comment exceeds maximum length of ${SHOWCASE_COMMENT_MAX_LENGTH} characters`,
      });
    }

    const existing = await this.prisma.showcaseComment.findUnique({
      where: { id: commentId },
      select: { id: true, userId: true, isHidden: true },
    });
    if (!existing) {
      throw new NotFoundException({
        code: ErrorCodes.SHOWCASE_COMMENT_NOT_FOUND,
        message: 'Comment not found',
      });
    }
    if (existing.userId !== userId) {
      throw new ForbiddenException({ code: ErrorCodes.FORBIDDEN, message: 'You can only edit your own comment' });
    }
    if (existing.isHidden) {
      throw new ForbiddenException({
        code: ErrorCodes.SHOWCASE_COMMENT_HIDDEN,
        message: 'Hidden comments cannot be edited',
      });
    }

    const updated = (await this.prisma.showcaseComment.update({
      where: { id: commentId },
      data: { content },
      include: COMMENT_INCLUDE,
    })) as unknown as CommentRow;
    return this.serializeComment(updated);
  }

  async deleteComment(userId: string, commentId: string): Promise<{ message: string }> {
    const existing = await this.prisma.showcaseComment.findUnique({
      where: { id: commentId },
      select: { id: true, userId: true, showcaseId: true, parentId: true, isHidden: true },
    });
    if (!existing) {
      throw new NotFoundException({
        code: ErrorCodes.SHOWCASE_COMMENT_NOT_FOUND,
        message: 'Comment not found',
      });
    }

    const showcase = await this.prisma.userShowcase.findUnique({
      where: { id: existing.showcaseId },
      select: { id: true, userId: true },
    });
    const isShowcaseOwner = Boolean(showcase && showcase.userId === userId);
    if (existing.userId !== userId && !isShowcaseOwner) {
      throw new ForbiddenException({
        code: ErrorCodes.FORBIDDEN,
        message: 'You can only delete your own comment',
      });
    }

    await this.prisma.$transaction(async (tx) => {
      // Menghapus root ikut menghapus balasannya (FK ON DELETE CASCADE), jadi
      // counter harus dikurangi sebanyak komentar + balasan yang masih tampil.
      let removed = 1;
      if (existing.parentId === null) {
        const visibleReplies = await tx.showcaseComment.count({
          where: { parentId: commentId, isHidden: false },
        });
        removed += visibleReplies;
      } else if (existing.isHidden) {
        removed = 0;
      }
      await tx.showcaseComment.delete({ where: { id: commentId } });
      if (removed > 0) {
        await tx.userShowcase.updateMany({
          where: { id: existing.showcaseId, commentCount: { gte: removed } },
          data: { commentCount: { decrement: removed } },
        });
      }
    });

    return { message: 'Comment deleted successfully' };
  }

  /**
   * Moderasi oleh pemilik showcase: sembunyikan komentar beserta alasan
   * kategorinya. commentCount ikut disesuaikan karena counter hanya menghitung
   * komentar yang tampil.
   */
  async setCommentHidden(
    userId: string,
    commentId: string,
    hidden: boolean,
    reason?: ContentHiddenReason,
  ): Promise<object> {
    const existing = await this.prisma.showcaseComment.findUnique({
      where: { id: commentId },
      select: { id: true, showcaseId: true, isHidden: true },
    });
    if (!existing) {
      throw new NotFoundException({
        code: ErrorCodes.SHOWCASE_COMMENT_NOT_FOUND,
        message: 'Comment not found',
      });
    }
    const showcase = await this.prisma.userShowcase.findUnique({
      where: { id: existing.showcaseId },
      select: { id: true, userId: true },
    });
    if (!showcase || showcase.userId !== userId) {
      throw new ForbiddenException({
        code: ErrorCodes.FORBIDDEN,
        message: 'Only the showcase owner can moderate comments',
      });
    }
    if (hidden && !reason) {
      throw new BadRequestException({
        code: ErrorCodes.VALIDATION_ERROR,
        message: 'hiddenReason is required when hiding a comment',
      });
    }
    if (existing.isHidden === hidden) {
      throw new ConflictException({
        code: ErrorCodes.VALIDATION_ERROR,
        message: hidden ? 'Comment is already hidden' : 'Comment is not hidden',
      });
    }

    // Baris hasil update sudah ikut memuat relasi author (COMMENT_INCLUDE), jadi
    // tidak perlu query kedua setelah commit.
    const updated = (await this.prisma.$transaction(async (tx) => {
      const comment = await tx.showcaseComment.update({
        where: { id: commentId },
        data: hidden
          ? { isHidden: true, hiddenReason: reason, hiddenAt: new Date(), hiddenBy: userId }
          : { isHidden: false, hiddenReason: null, hiddenAt: null, hiddenBy: null },
        include: COMMENT_INCLUDE,
      });
      if (hidden) {
        await tx.userShowcase.updateMany({
          where: { id: existing.showcaseId, commentCount: { gt: 0 } },
          data: { commentCount: { decrement: 1 } },
        });
      } else {
        await tx.userShowcase.update({
          where: { id: existing.showcaseId },
          data: { commentCount: { increment: 1 } },
        });
      }
      return comment;
    })) as unknown as CommentRow;

    return this.serializeComment(updated);
  }

  // ==================================================================
  // Share (deep link)
  // ==================================================================

  /**
   * Payload share untuk halaman deep link. Menghormati visibility PRIVATE,
   * profileVisible pemilik, dan relasi block — item yang tidak boleh terlihat
   * menghasilkan 404/403 yang sama seperti jalur baca lainnya, jadi halaman
   * share tidak bisa dipakai untuk mengintip konten privat.
   */
  async getSharePayload(showcaseId: string, viewerId?: string): Promise<object> {
    const visible = await this.findVisibleShowcase(showcaseId, viewerId);
    if (!visible) {
      throw new NotFoundException({ code: ErrorCodes.SHOWCASE_NOT_FOUND, message: 'Showcase item not found' });
    }
    const { row } = visible;
    const coverImageUrl = row.images.length > 0 ? row.images[0].imageUrl : null;
    const priceMin = toNumber(row.priceMin);
    const priceMax = toNumber(row.priceMax);
    const priceLabel =
      priceMin !== null && priceMax !== null && priceMin !== priceMax
        ? `Rp ${priceMin} - Rp ${priceMax}`
        : priceMin !== null
          ? `Rp ${priceMin}`
          : 'Harga lewat diskusi';

    return {
      showcaseId: row.id,
      title: row.title,
      description: row.description ?? priceLabel,
      imageUrl: coverImageUrl,
      priceLabel,
      authorUsername: row.user.username ?? row.user.userId,
      authorFullName: row.user.fullName,
      shareUrl: this.buildShareUrl(row.id),
      appUrl: `kahade-frontend://showcase/${encodeURIComponent(row.id)}`,
    };
  }

  // ==================================================================
  // Normalisasi input
  // ==================================================================

  private normalizeTitle(title: string): string {
    const trimmed = title?.trim();
    if (!trimmed) {
      throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Title is required' });
    }
    return trimmed;
  }

  private normalizeDescription(description?: string): string | null {
    return description?.trim() || null;
  }

  private normalizeCategory(category?: string): string | null {
    const trimmed = category?.trim().toLowerCase();
    return trimmed ? trimmed : null;
  }

  private assertPriceRange(priceMin?: number, priceMax?: number): void {
    if (priceMin !== undefined && priceMax !== undefined && priceMin > priceMax) {
      throw new BadRequestException({
        code: ErrorCodes.VALIDATION_ERROR,
        message: 'priceMin must not exceed priceMax',
      });
    }
  }

  async reportShowcase(userId: string, showcaseId: string, reason: string, description?: string): Promise<object> {
    const showcase = await this.prisma.showcaseItem.findUnique({ where: { id: showcaseId }, select: { id: true, userId: true } });
    if (!showcase) throw new BadRequestException({ code: ErrorCodes.NOT_FOUND ?? 'NOT_FOUND', message: 'Showcase not found' });
    if (showcase.userId === userId) throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Cannot report own showcase' });

    // Use UserReport as generic report table if ShowcaseReport doesn't exist, else create via prisma
    try {
      const report = await (this.prisma as any).showcaseReport?.create?.({
        data: { showcaseId, reporterId: userId, reason, description: description?.slice(0, 1000) },
      });
      if (report) return { reported: true, reportId: report.id };
    } catch {}

    // Fallback: create entry in admin audit log + redis alert
    await this.prisma.adminAuditLog.create({
      data: {
        adminId: (await this.prisma.adminUser.findFirst({ where: { role: 'SUPER_ADMIN' }, select: { id: true } }))?.id ?? userId,
        action: 'SYSTEM_CONFIG_CHANGED' as any,
        targetType: 'ShowcaseItem',
        targetId: showcaseId,
        description: `User ${userId} reported showcase ${showcaseId}: ${reason} ${description ?? ''}`,
        ipAddress: 'system',
      },
    }).catch(() => {});

    return { reported: true, showcaseId, reason };
  }
}
