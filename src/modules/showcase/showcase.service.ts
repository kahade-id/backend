import { Injectable, Logger, BadRequestException, NotFoundException, ForbiddenException, ConflictException, GoneException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ContentHiddenReason, Prisma, ShowcaseVisibility } from '@prisma/client';
import { createHash } from 'crypto';
import { PrismaService } from '../../prisma/prisma.service';
import { RedisService } from '../../redis/redis.service';
import { UploadService } from '../upload/upload.service';
import { UploadPurpose } from '../upload/dto/presigned-url.dto';
import * as ErrorCodes from '../../common/constants/error-codes';
import { escapeLikePattern } from '../../common/utils/search.util';
import { sanitizeShowcaseHtml } from '../../common/utils/sanitize-html.util';
import {
  ORDER_MAX_VALUE,
  ORDER_MIN_VALUE,
  SHOWCASE_COMMENT_MAX_LENGTH,
  SHOWCASE_FEED_MAX_LIMIT,
  SHOWCASE_MAX_IMAGES_ABSOLUTE,
  SHOWCASE_MAX_ITEMS,
  SHOWCASE_REPLY_LIMIT,
  SHOWCASE_SEARCH_MIN_LENGTH,
  SHOWCASE_VIEW_DEDUPE_TTL_SECONDS,
} from '../../common/constants/app.constants';
import { SubscriptionsService } from '../subscriptions/subscriptions.service';
import { CreateShowcaseItemDto, UpdateShowcaseItemDto } from './dto/showcase-item.dto';
import { CreateShowcaseCommentDto, UpdateShowcaseCommentDto } from './dto/showcase-comment.dto';
import { ShowcaseFeedQueryDto, ShowcaseFeedSort } from './dto/showcase-feed-query.dto';
import { ReportShowcaseDto } from './dto/report-showcase.dto';
import { AuditLogService } from '../../common/services/audit-log.service';
import { VerificationBadgeService, getSealTierFromTypes } from '../users/verification-badge.service';

/**
 * Section 3 — Showcase sebagai konten sosial + feed discover.
 *
 * Prinsip yang dipegang di seluruh file ini:
 *  - Soft-delete / status akun: item hanya tampil publik bila pemiliknya
 *    isActive, tidak banned, deletedAt null, dan profileVisible true.
 *  - Block-list: viewer tidak pernah melihat item/komentar dari orang yang
 *    saling blokir dengannya (pola user-search.service.ts). Interaksi (like /
 *    komentar) ditolak 403 USER_BLOCKED, bukan disembunyikan diam-diam.
 *  - Counter denormalisasi (likeCount/commentCount/viewCount/shareCount) selalu di-update
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
    private readonly auditLog: AuditLogService,
    private readonly verificationBadgeService: VerificationBadgeService,
    private readonly subscriptionsService: SubscriptionsService,
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
    // S5 (audit Discovery 2026-09-26): cap 1000 seperti getBlockedUserIds di
    // modul search — block list adalah filter relevansi, bukan security
    // boundary (visibleOwnerFilter yang menegakkan privasi).
    const blocks = await this.prisma.blockList.findMany({
      where: { OR: [{ blockerId: viewerId }, { blockedId: viewerId }] },
      select: { blockerId: true, blockedId: true },
      take: 1000,
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
        deletedAt: null,
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
      where: { id: showcaseId, userId, deletedAt: null },
      include: { images: { orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }] } },
    });
    if (!row) {
      throw new NotFoundException({ code: ErrorCodes.SHOWCASE_NOT_FOUND, message: 'Showcase item not found' });
    }
    return row;
  }

  /**
   * Ambil showcase milik `userId` yang sedang di-soft-delete (untuk restore).
   * Item yang tidak dihapus atau sudah lewat 30 hari tidak ditemukan di sini.
   */
  private async findDeletedShowcase(userId: string, showcaseId: string) {
    const row = await this.prisma.userShowcase.findFirst({
      where: { id: showcaseId, userId, deletedAt: { not: null } },
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
   * S1 (audit 2026-09-26): ambil badge verifikasi untuk sekumpulan author
   * sekaligus. `getBadges` di-cache di Redis per user, jadi ini murah —
   * dipakai feed/detail supaya <VerifiedSeal> 3-tier konsisten dengan profil.
   * Gagal ambil untuk satu user → badge kosong (fallback `verified` boolean
   * di klien), bukan error.
   */
  private async getAuthorBadgeMap(userIds: string[]): Promise<Map<string, Array<{ type: string }>>> {
    const unique = [...new Set(userIds.filter(Boolean))];
    const entries = await Promise.all(
      unique.map(async (userId): Promise<[string, Array<{ type: string }>]> => {
        try {
          const badges = await this.verificationBadgeService.getBadges(userId);
          return [userId, badges.map((b) => ({ type: b.type }))];
        } catch {
          return [userId, []];
        }
      }),
    );
    return new Map(entries);
  }

  /**
   * Bentuk publik satu item showcase.
   *
   * `orderLink` berisi data siap pakai untuk membuat OrderLink dari item ini
   * (title/description/orderValue/counterpartUsername sudah ter-prefill) supaya
   * tombol "Pesan" di feed discover tidak perlu merakit apa pun lagi.
   */
  private serializeShowcase(
    row: ShowcaseRow,
    options: { isLiked?: boolean; isOwner?: boolean; authorBadges?: Array<{ type: string }> } = {},
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
      // Benefit 7 Kahade+: deskripsi HTML subscriber (disimpan apa adanya;
      // frontend wajib mensanitasi sebelum render).
      descriptionHtml: row.descriptionHtml ?? null,
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
      // S-4: berapa kali deep link share item ini dibuka.
      shareCount: row.shareCount,
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
        // S1 (audit 2026-09-26): badge verifikasi 3-tier untuk <VerifiedSeal>
        // di feed/detail. Sumber sama dengan profil (getBadges), bukan flag
        // terpisah — satukan definisi tier.
        badges: options.authorBadges ?? [],
        // R1 (audit 2026-09-26): sealTier disematkan di payload agar frontend
        // bisa render <VerifiedSeal> tanpa N+1 request badge per author.
        sealTier: getSealTierFromTypes((options.authorBadges ?? []).map((b) => b.type)),
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
      where: { userId, deletedAt: null },
      orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
      include: SHOWCASE_INCLUDE,
    })) as unknown as ShowcaseRow[];

    return {
      items: items.map((item) => this.serializeShowcase(item, { isOwner: true })),
      total: items.length,
      limits: {
        maxItems: SHOWCASE_MAX_ITEMS,
        // Benefit 7 Kahade+: batas gambar per item berbasis subscription.
        maxImagesPerItem: await this.subscriptionsService.getMaxShowcaseImages(userId),
      },
    };
  }

  async createShowcaseItem(userId: string, dto: CreateShowcaseItemDto): Promise<object> {
    const title = this.normalizeTitle(dto.title);
    this.assertPriceRange(dto.priceMin, dto.priceMax);
    const imageFileKeys = await this.prepareImageKeys(userId, dto.imageFileKeys);

    const limitError = () =>
      new BadRequestException({
        code: ErrorCodes.SHOWCASE_ITEM_LIMIT_REACHED,
        message: `Maximum ${SHOWCASE_MAX_ITEMS} showcase items allowed`,
      });

    // S-2: count + create dibungkus transaksi serializable supaya dua request
    // paralel tidak bisa sama-sama lolos cek batas 20 item. Konflik serialisasi
    // (P2034) ditangani dengan verifikasi ulang batas di luar transaksi.
    try {
      const item = (await this.prisma.$transaction(
        async (tx) => {
          const count = await tx.userShowcase.count({ where: { userId, deletedAt: null } });
          if (count >= SHOWCASE_MAX_ITEMS) {
            throw limitError();
          }
          return (await tx.userShowcase.create({
            data: {
              userId,
              title,
              description: this.normalizeDescription(dto.description),
              // Benefit 7 Kahade+: deskripsi HTML subscriber — DISANITASI di
              // backend sebelum disimpan (allowlist); frontend juga mensanitasi
              // sebelum kirim/render (defense in depth).
              descriptionHtml: dto.descriptionHtml != null ? sanitizeShowcaseHtml(dto.descriptionHtml) : null,
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
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      )) as unknown as ShowcaseRow;

      return this.serializeShowcase(item, { isOwner: true });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2034') {
        // Race pada cek batas: verifikasi ulang di luar transaksi.
        const count = await this.prisma.userShowcase.count({ where: { userId, deletedAt: null } });
        if (count >= SHOWCASE_MAX_ITEMS) {
          throw limitError();
        }
      }
      throw err;
    }
  }

  async updateShowcaseItem(userId: string, itemId: string, dto: UpdateShowcaseItemDto): Promise<object> {
    const existing = await this.findOwnedShowcase(userId, itemId);

    // R-2: pakai hasil normalizeTitle langsung (validasi + trim) supaya tidak
    // ada dua sumber kebenaran untuk nilai title yang disimpan.
    const priceMin = dto.priceMin !== undefined ? dto.priceMin : toNumber(existing.priceMin) ?? undefined;
    const priceMax = dto.priceMax !== undefined ? dto.priceMax : toNumber(existing.priceMax) ?? undefined;
    this.assertPriceRange(priceMin, priceMax);

    const data: Prisma.UserShowcaseUpdateInput = {};
    if (dto.title !== undefined) data.title = this.normalizeTitle(dto.title);
    if (dto.description !== undefined) data.description = this.normalizeDescription(dto.description);
    if (dto.descriptionHtml !== undefined) data.descriptionHtml = sanitizeShowcaseHtml(dto.descriptionHtml);
    if (dto.category !== undefined) data.category = this.normalizeCategory(dto.category);
    if (dto.visibility !== undefined) data.visibility = dto.visibility;
    if (dto.priceMin !== undefined) data.priceMin = BigInt(dto.priceMin);
    if (dto.priceMax !== undefined) data.priceMax = BigInt(dto.priceMax);
    if (dto.isActive !== undefined) data.isActive = dto.isActive;
    if (dto.sortOrder !== undefined) data.sortOrder = dto.sortOrder;

    // R-3: samakan dengan create — item tidak boleh berakhir tanpa gambar sama
    // sekali. Array kosong ditolak eksplisit dengan pesan yang jelas (bukan
    // diartikan "hapus semua gambar"); penghapusan per gambar tetap lewat
    // endpoint DELETE /users/me/showcase/images/:imageId.
    if (dto.imageFileKeys !== undefined) {
      if (dto.imageFileKeys.length === 0) {
        throw new BadRequestException({
          code: ErrorCodes.VALIDATION_ERROR,
          message:
            'imageFileKeys must contain at least 1 image: a showcase item cannot be left without images. ' +
            'Remove individual images via DELETE /users/me/showcase/images/:imageId instead.',
        });
      }
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
      // Defense-in-depth: findOwnedShowcase sudah memastikan kepemilikan,
      // tapi where ikut memfilter userId supaya update tidak pernah bisa
      // menyentuh baris milik user lain walau ada bug di alur atas.
      where: { id: itemId, userId },
      data,
      include: SHOWCASE_INCLUDE,
    })) as unknown as ShowcaseRow;

    return this.serializeShowcase(item, { isOwner: true });
  }

  async deleteShowcaseItem(userId: string, itemId: string): Promise<{ message: string }> {
    const existing = await this.findOwnedShowcase(userId, itemId);
    // Soft delete: item disembunyikan dari semua jalur baca, bisa dipulihkan
    // dalam 30 hari. Hard delete otomatis oleh cron setelah 30 hari.
    // Gambar di R2 TIDAK dihapus sekarang — dibersihkan saat hard delete.
    await this.prisma.userShowcase.update({
      where: { id: existing.id },
      data: { deletedAt: new Date() },
    });
    // Invalidate badge/cache terkait bila ada (tidak ada cache khusus showcase).
    return { message: 'Etalase dihapus. Dapat dipulihkan dalam 30 hari.' };
  }

  /**
   * Pulihkan item yang di-soft-delete (dalam 30 hari).
   * Setelah 30 hari → 410 GONE (sudah hard delete oleh cron).
   */
  async restoreShowcaseItem(userId: string, itemId: string): Promise<{ message: string }> {
    const existing = await this.findDeletedShowcase(userId, itemId);
    const deletedAt = existing.deletedAt as Date;
    const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;
    if (Date.now() - deletedAt.getTime() > thirtyDaysMs) {
      throw new GoneException({
        code: ErrorCodes.SHOWCASE_RESTORE_EXPIRED,
        message: 'Masa pemulihan 30 hari telah berakhir. Etalase sudah dihapus permanen.',
      });
    }
    await this.prisma.userShowcase.update({
      where: { id: existing.id },
      data: { deletedAt: null },
    });
    return { message: 'Etalase berhasil dipulihkan.' };
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
    // Benefit 7 Kahade+: batas gambar berbasis subscription (18 aktif / 8 biasa).
    // DTO hanya menegakkan batas atas absolut (18); batas per-user di sini.
    const maxImages = await this.subscriptionsService.getMaxShowcaseImages(userId);
    if (fileKeys.length > maxImages) {
      throw new BadRequestException({
        code: ErrorCodes.SHOWCASE_IMAGE_LIMIT_REACHED,
        message: `Maximum ${maxImages} images per showcase item`,
      });
    }
    await this.uploadService.verifyUserFileKeys(userId, fileKeys, UploadPurpose.SHOWCASE_IMAGE, {
      maxFiles: maxImages,
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
    const maxImages = await this.subscriptionsService.getMaxShowcaseImages(userId);
    if (existing.images.length + fileKeys.length > maxImages) {
      throw new BadRequestException({
        code: ErrorCodes.SHOWCASE_IMAGE_LIMIT_REACHED,
        message: `Maximum ${maxImages} images per showcase item`,
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
        deletedAt: null,
        visibility: ShowcaseVisibility.PUBLIC,
        user: this.visibleOwnerFilter(excludedIds),
      },
      orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
      include: SHOWCASE_INCLUDE,
    })) as unknown as ShowcaseRow[];

    const likedIds = await this.getLikedShowcaseIds(viewerId, items.map((item) => item.id));
    const badgeMap = await this.getAuthorBadgeMap(items.map((item) => item.user.userId));
    return {
      items: items.map((item) =>
        this.serializeShowcase(item, {
          isLiked: likedIds.has(item.id),
          authorBadges: badgeMap.get(item.user.userId) ?? [],
        }),
      ),
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

    // R-4: owner yang mem-preview item miliknya yang sedang nonaktif (isActive=false)
    // tidak ikut menaikkan viewCount — angka view hanya untuk item yang tayang.
    const shouldCountView = !(visible.isOwner && !visible.row.isActive);
    const counted = shouldCountView ? await this.recordView(showcaseId, viewerId, options.clientIp) : false;
    const likedIds = await this.getLikedShowcaseIds(viewerId, [showcaseId]);
    const badgeMap = await this.getAuthorBadgeMap([visible.row.user.userId]);

    return {
      ...this.serializeShowcase(visible.row, {
        isLiked: likedIds.has(showcaseId),
        isOwner: visible.isOwner,
        authorBadges: badgeMap.get(visible.row.user.userId) ?? [],
      }),
      // R-6: nilai di sini adalah row.viewCount + 1 (asumsi, bukan hasil baca
      // ulang setelah increment) — bisa sedikit basi bila dua viewer membaca
      // bersamaan. Diterima sebagai minor: increment-nya sendiri tetap atomik
      // (updateMany) dan angka DB selalu benar; yang berpotensi tertinggal
      // hanya angka di respons ini.
      viewCount: counted ? visible.row.viewCount + 1 : visible.row.viewCount,
      // Karya terkait: kategori sama dulu, lalu populer sebagai pengisi.
      related: await this.getRelatedShowcase(visible.row, viewerId),
    };
  }

  /**
   * Karya terkait untuk detail: item lain berkategori sama (maks 6),
   * dilengkapi item populer bila kategori sama kurang dari 6.
   * Hanya item PUBLIC + aktif + tidak dihapus + pemilik terlihat.
   */
  private async getRelatedShowcase(
    row: ShowcaseRow,
    viewerId?: string,
  ): Promise<Array<Record<string, unknown>>> {
    const RELATED_LIMIT = 6;
    const excludedIds = await this.getViewerExcludedIds(viewerId);
    const baseWhere: Prisma.UserShowcaseWhereInput = {
      id: { not: row.id },
      visibility: ShowcaseVisibility.PUBLIC,
      isActive: true,
      deletedAt: null,
      user: this.visibleOwnerFilter(excludedIds),
    };

    const category = row.category?.trim().toLowerCase();
    let related: ShowcaseRow[] = [];
    if (category) {
      related = await this.prisma.userShowcase.findMany({
        where: { ...baseWhere, category },
        include: SHOWCASE_INCLUDE,
        orderBy: [{ likeCount: 'desc' }, { createdAt: 'desc' }],
        take: RELATED_LIMIT,
      });
    }

    // Pengisi: item populer lintas kategori bila kurang dari limit.
    if (related.length < RELATED_LIMIT) {
      const exclude = [row.id, ...related.map((r) => r.id)];
      const filler = await this.prisma.userShowcase.findMany({
        where: { ...baseWhere, id: { notIn: exclude } },
        include: SHOWCASE_INCLUDE,
        orderBy: [{ likeCount: 'desc' }, { createdAt: 'desc' }],
        take: RELATED_LIMIT - related.length,
      });
      related = [...related, ...filler];
    }

    const likedIds = await this.getLikedShowcaseIds(
      viewerId,
      related.map((r) => r.id),
    );
    const badgeMap = await this.getAuthorBadgeMap(
      related.map((r) => r.user.userId),
    );
    return related.map((r) =>
      this.serializeShowcase(r, {
        isLiked: likedIds.has(r.id),
        authorBadges: badgeMap.get(r.user.userId) ?? [],
      }),
    );
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
    // R2 (audit Discovery 2026-09-26): guard status — item yang ter-soft-delete
    // / nonaktif di antara visibility-check dan increment tidak menambah counter.
    await this.prisma.userShowcase.updateMany({
      where: { id: showcaseId, deletedAt: null, isActive: true },
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
      deletedAt: null,
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
    // R-1: terapkan SHOWCASE_SEARCH_MIN_LENGTH — query lebih pendek dari 2
    // karakter hanya menghasilkan noise, jadi diabaikan (feed tanpa filter
    // search) alih-alih memindai title/deskripsi/username.
    if (search && search.length >= SHOWCASE_SEARCH_MIN_LENGTH) {
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

    // D-02 (audit Discovery 2026-09-26): filter harga. Rentang efektif item =
    // [COALESCE(priceMin, priceMax), COALESCE(priceMax, priceMin)]; item cocok
    // bila rentangnya beririsan dengan [minPrice, maxPrice]. Item tanpa harga
    // (keduanya null) disembunyikan saat filter harga aktif — tidak bisa
    // dipastikan masuk bujet. Perbandingan `lte`/`gte` Prisma tidak cocok
    // dengan NULL di SQL, jadi cabang "batas satunya null" ditulis eksplisit.
    const minPrice = query.minPrice;
    const maxPrice = query.maxPrice;
    if (minPrice !== undefined && maxPrice !== undefined && minPrice > maxPrice) {
      throw new BadRequestException({
        code: ErrorCodes.SHOWCASE_INVALID_PRICE_RANGE,
        message: 'minPrice tidak boleh lebih besar dari maxPrice',
      });
    }
    if (minPrice !== undefined || maxPrice !== undefined) {
      const loOk: Prisma.UserShowcaseWhereInput =
        maxPrice === undefined
          ? { OR: [{ priceMin: { not: null } }, { priceMax: { not: null } }] }
          : {
              OR: [
                { priceMin: { lte: maxPrice } },
                { AND: [{ priceMin: null }, { priceMax: { lte: maxPrice } }] },
              ],
            };
      const hiOk: Prisma.UserShowcaseWhereInput =
        minPrice === undefined
          ? { OR: [{ priceMin: { not: null } }, { priceMax: { not: null } }] }
          : {
              OR: [
                { priceMax: { gte: minPrice } },
                { AND: [{ priceMax: null }, { priceMin: { gte: minPrice } }] },
              ],
            };
      andClauses.push({ AND: [loOk, hiOk] });
    }

    // Filter lokasi: cocokkan free-text users.address milik owner
    // (case-insensitive). escapeLikePattern: `%`, `_`, `\` dari user
    // diperlakukan literal — bukan wildcard LIKE.
    const location = query.location?.trim();
    if (location) {
      andClauses.push({
        user: { address: { contains: escapeLikePattern(location), mode: 'insensitive' } },
      });
    }

    // Keyset: "baris-baris setelah cursor" menurut urutan sort. Menggunakan
    // tuple (sortKey..., id) sehingga hasilnya deterministik walau banyak baris
    // berbagi createdAt/likeCount yang sama.
    if (query.cursor) {
      const cursor = decodeFeedCursor(query.cursor);
      const cursorDate = new Date(cursor.t);
      // T2 (audit Discovery 2026-09-26): cursor hanya menyimpan epoch-ms,
      // sedangkan createdAt di DB bertipe timestamptz (presisi mikrodetik).
      // Baris yang lahir dalam milidetik yang SAMA dengan baris terakhir
      // halaman sebelumnya tetapi mikrodetiknya lebih kecil akan hilang
      // permanen bila batasnya `createdAt < T`. Sertakan seluruh bucket
      // [T, T+1ms) dengan tiebreak id — duplikat kecil yang mungkin muncul
      // sudah di-dedupe di klien (mergeById/visibleItems), dan anchor
      // (bucket, id) selalu maju sehingga tidak ada livelock halaman.
      const cursorMsEnd = new Date(cursor.t + 1);
      if (sort === 'popular') {
        andClauses.push({
          OR: [
            { likeCount: { lt: cursor.l } },
            { likeCount: cursor.l, createdAt: { lt: cursorDate } },
            {
              likeCount: cursor.l,
              createdAt: { gte: cursorDate, lt: cursorMsEnd },
              id: { lt: cursor.i },
            },
          ],
        });
      } else {
        andClauses.push({
          OR: [
            { createdAt: { lt: cursorDate } },
            { createdAt: { gte: cursorDate, lt: cursorMsEnd }, id: { lt: cursor.i } },
          ],
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
    // S1: badge 3-tier author (satu batch, cached di Redis).
    const badgeMap = await this.getAuthorBadgeMap(pageRows.map((row) => row.user.userId));

    return {
      items: pageRows.map((row) =>
        this.serializeShowcase(row, {
          isLiked: likedIds.has(row.id),
          authorBadges: badgeMap.get(row.user.userId) ?? [],
        }),
      ),
      sort,
      limit,
      hasMore,
      nextCursor: hasMore && pageRows.length > 0 ? encodeFeedCursor(pageRows[pageRows.length - 1]) : null,
    };
  }

  /**
   * D-01 (audit Discovery 2026-09-26): agregasi kategori yang benar-benar
   * dipakai karya publik + aktif + tidak dihapus. Dipakai klien sebagai saran
   * saat mengisi kategori (mengurangi fragmentasi ejaan teks bebas).
   */
  async getPopularCategories(limit: number): Promise<object> {
    const take = Math.min(Math.max(Math.floor(limit) || 20, 1), 50);
    // S1 (audit Discovery 2026-09-26): cache 5 menit — agregasi nyaris statis,
    // sebelumnya groupBy mentah tiap request. Key mencakup `take` supaya
    // limit berbeda tidak saling menimpa.
    const cacheKey = `showcase:popular-categories:${take}`;
    try {
      const cached = await this.redis.get(cacheKey);
      if (cached) return JSON.parse(cached) as object;
    } catch {}
    const groups = await this.prisma.userShowcase.groupBy({
      by: ['category'],
      where: {
        visibility: ShowcaseVisibility.PUBLIC,
        isActive: true,
        deletedAt: null,
        category: { not: null },
        // S1: paritas dengan feed — hanya hitung item yang benar-benar bisa
        // muncul di feed (pemilik sehat & publik).
        user: { isActive: true, isBanned: false, deletedAt: null, profileVisible: true },
      },
      _count: { category: true },
      orderBy: { _count: { category: 'desc' } },
      take,
    });
    const result = {
      categories: groups
        .filter((g) => typeof g.category === 'string' && g.category.trim().length > 0)
        .map((g) => ({ category: g.category as string, count: g._count.category })),
    };
    try {
      await this.redis.set(cacheKey, JSON.stringify(result), 300);
    } catch {}
    return result;
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
    // R-7: cek block yang sama seperti likeShowcase, demi konsistensi —
    // user yang diblokir tidak boleh berinteraksi sama sekali dengan kontennya.
    await this.assertNoBlockRelation(userId, visible.row.userId);

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
    // R-5: konsisten dengan feed — komentar dari user yang memprivatkan
    // profilnya tidak ikut tampil di item publik.
    const authorFilter: Prisma.UserWhereInput = {
      isActive: true,
      isBanned: false,
      deletedAt: null,
      profileVisible: true,
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

    // S-3: Balasan diambil per root dengan batas SHOWCASE_REPLY_LIMIT supaya satu
    // root viral tidak menghasilkan response raksasa. replyCount total tiap root
    // tetap akurat via groupBy. Query per root tetap ringan (indexed by parentId)
    // dan hanya dijalankan untuk root yang memang punya balasan.
    const rootIds = roots.map((root) => root.id);
    const replyWhere: Prisma.ShowcaseCommentWhereInput = {
      user: authorFilter,
      ...(visible.isOwner ? {} : { isHidden: false }),
    };
    const replyCountRows =
      rootIds.length > 0
        ? await this.prisma.showcaseComment.groupBy({
            by: ['parentId'],
            where: { parentId: { in: rootIds }, ...replyWhere },
            _count: { _all: true },
          })
        : [];
    const replyCountByParent = new Map<string, number>();
    for (const row of replyCountRows) {
      if (row.parentId) replyCountByParent.set(row.parentId, row._count._all);
    }

    // S4 (audit Discovery 2026-09-26): query balasan dijalankan PARALEL
    // (Promise.all), bukan sequential — sebelumnya N round-trip berurutan
    // untuk N root (hingga 50). Semantik identik: take per root tetap
    // SHOWCASE_REPLY_LIMIT dengan urutan yang sama.
    const repliesByParent = new Map<string, CommentRow[]>();
    const rootsWithReplies = roots.filter((root) => (replyCountByParent.get(root.id) ?? 0) > 0);
    const repliesResults = await Promise.all(
      rootsWithReplies.map((root) =>
        this.prisma.showcaseComment
          .findMany({
            where: { parentId: root.id, ...replyWhere },
            orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
            take: SHOWCASE_REPLY_LIMIT,
            include: COMMENT_INCLUDE,
          })
          .then((rows) => ({ rootId: root.id, rows: rows as unknown as CommentRow[] })),
      ),
    );
    for (const { rootId, rows } of repliesResults) {
      repliesByParent.set(rootId, rows);
    }

    const data = roots.map((root) => ({
      ...this.serializeComment(root as CommentRow),
      replyCount: replyCountByParent.get(root.id) ?? 0,
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
        // R-8: pesan lama menyesatkan — pemilik showcase juga boleh menghapus
        // komentar di itemnya, bukan hanya penulis komentar.
        message: 'You can only delete your own comment or comments on your showcase',
      });
    }

    await this.prisma.$transaction(async (tx) => {
      // Menghapus root ikut menghapus balasannya (FK ON DELETE CASCADE), jadi
      // counter harus dikurangi sebanyak komentar + balasan yang masih tampil.
      // Root yang sedang hidden sudah tidak termasuk dalam commentCount
      // (dikurangi saat di-hide di setCommentHidden), jadi saat dihapus hanya
      // balasannya yang masih tampil yang perlu dikurangi.
      let removed: number;
      if (existing.parentId === null) {
        const visibleReplies = await tx.showcaseComment.count({
          where: { parentId: commentId, isHidden: false },
        });
        removed = existing.isHidden ? visibleReplies : 1 + visibleReplies;
      } else {
        removed = existing.isHidden ? 0 : 1;
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
   *
   * S-4: setiap pemanggilan yang lolos visibility check mencatat satu kejadian
   * share via atomic increment `shareCount` (pola yang sama dengan viewCount,
   * tapi tanpa dedupe — share memang dihitung per pembukaan deep link).
   * Nilai aktual diambil dari hasil `update` supaya payload tidak memakai
   * asumsi basi. Item yang tidak terlihat → 404 SEBELUM increment, jadi tidak
   * ada share tercatat untuk konten yang tidak boleh diakses.
   */
  async getSharePayload(showcaseId: string, viewerId?: string): Promise<object> {
    const visible = await this.findVisibleShowcase(showcaseId, viewerId);
    if (!visible) {
      throw new NotFoundException({ code: ErrorCodes.SHOWCASE_NOT_FOUND, message: 'Showcase item not found' });
    }
    const { row } = visible;
    const updated = await this.prisma.userShowcase.update({
      where: { id: row.id },
      data: { shareCount: { increment: 1 } },
      select: { shareCount: true },
    });
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
      // S-4: nilai SETELAH increment pada pemanggilan ini.
      shareCount: updated.shareCount,
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

  /**
   * Laporkan item showcase (Etalase) oleh user.
   *
   * Alur:
   * 1. Visibility check via `findVisibleShowcase` — item PRIVATE/inactive/
   *    milik akun banned tidak bisa dilaporkan (404).
   * 2. Tolak laporan terhadap item sendiri (400).
   * 3. Cegah duplikat: satu user hanya boleh melaporkan satu item sekali (409).
   * 4. Simpan ke `showcase_reports` + catat ke user audit log (`SHOWCASE_REPORTED`).
   *
   * Validasi `reason`/`description` ditangani `ReportShowcaseDto` via ValidationPipe.
   */
  async reportShowcase(
    userId: string,
    showcaseId: string,
    dto: ReportShowcaseDto,
    opts?: { ipAddress?: string },
  ): Promise<{ reported: true; reportId: string }> {
    // 1. Visibility check — hanya item yang terlihat oleh pelapor yang bisa dilaporkan.
    const visible = await this.findVisibleShowcase(showcaseId, userId);
    if (!visible) {
      throw new NotFoundException({ code: ErrorCodes.SHOWCASE_NOT_FOUND, message: 'Showcase item not found' });
    }
    if (visible.row.userId === userId) {
      throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Cannot report own showcase' });
    }

    // 2. Cegah duplikat.
    const existing = await this.prisma.showcaseReport.findUnique({
      where: { showcaseId_reporterId: { showcaseId, reporterId: userId } },
      select: { id: true },
    });
    if (existing) {
      throw new ConflictException({ code: ErrorCodes.SHOWCASE_ALREADY_REPORTED, message: 'Showcase already reported by this user' });
    }

    // 3. Simpan laporan. Unique constraint (showcaseId, reporterId) sebagai
    // pertahanan kedua terhadap race condition.
    let report: { id: string };
    try {
      report = await this.prisma.showcaseReport.create({
        data: {
          showcaseId,
          reporterId: userId,
          reason: dto.reason,
          description: dto.description ?? null,
        },
        select: { id: true },
      });
    } catch (err) {
      // P2002 = pelanggaran unique constraint (race: dua request paralel).
      // Cek via properti `code` (bukan instanceof) agar robust terhadap
      // varian error Prisma yang di-wrap.
      if ((err as { code?: string })?.code === 'P2002') {
        throw new ConflictException({ code: ErrorCodes.SHOWCASE_ALREADY_REPORTED, message: 'Showcase already reported by this user' });
      }
      this.logger.error(`Failed to create showcase report for ${showcaseId} by ${userId}: ${(err as Error).message}`);
      throw err;
    }

    // 4. Audit trail sisi user — BUKAN adminAuditLog (pelapor adalah user biasa,
    // bukan admin). Kegagalan audit tidak menggagalkan laporan yang sudah tersimpan.
    try {
      this.auditLog.logUserAction({
        userId,
        action: 'SHOWCASE_REPORTED',
        entityType: 'ShowcaseItem',
        entityId: showcaseId,
        description: `User ${userId} reported showcase ${showcaseId}: ${dto.reason}`,
        ipAddress: opts?.ipAddress,
      });
    } catch (err) {
      this.logger.warn(`Failed to write audit log for showcase report ${report.id}: ${(err as Error).message}`);
    }

    return { reported: true, reportId: report.id };
  }
}
