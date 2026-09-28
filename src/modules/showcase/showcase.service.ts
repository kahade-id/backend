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
import { isBotUserAgent } from '../../common/utils/bot-detection.util';
import {
  ORDER_MAX_VALUE,
  ORDER_MIN_VALUE,
  SHOWCASE_COMMENT_MAX_LENGTH,
  SHOWCASE_FEED_MAX_LIMIT,
  SHOWCASE_FOR_YOU_AFFINITY_POOL,
  SHOWCASE_FOR_YOU_FOLLOWED_POOL,
  SHOWCASE_FOR_YOU_FOLLOW_SIGNAL_LIMIT,
  SHOWCASE_FOR_YOU_LIKE_SIGNAL_LIMIT,
  SHOWCASE_FOR_YOU_RECENT_POOL,
  SHOWCASE_FOR_YOU_SCORE_TIME_BUCKET_MS,
  SHOWCASE_MAX_IMAGES_ABSOLUTE,
  SHOWCASE_MAX_ITEMS,
  SHOWCASE_REPLY_LIMIT,
  SHOWCASE_SEARCH_MIN_LENGTH,
  SHOWCASE_SHARE_DEDUPE_TTL_SECONDS,
  SHOWCASE_SPIN360_MAX_FRAMES,
  SHOWCASE_SPIN360_MIN_FRAMES,
  SHOWCASE_VIDEO_MAX_DURATION_SEC,
  SHOWCASE_VIEW_DEDUPE_TTL_SECONDS,
} from '../../common/constants/app.constants';
import { createPaginatedResponse } from '../../common/dto/pagination.dto';
import { SubscriptionsService } from '../subscriptions/subscriptions.service';
import { AdminShowcaseReportsService } from '../admin/showcase-reports/admin-showcase-reports.service';
import { moderationDb } from '../admin/showcase-reports/moderation-prisma.types';
import { CreateShowcaseItemDto, UpdateShowcaseItemDto } from './dto/showcase-item.dto';
import { ShowcaseMediaInputDto, ShowcaseMediaKind } from './dto/showcase-media.dto';
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
    // DC-010: id + kycStatus untuk badge author (sealTier/isKycVerified).
    user: { select: { id: true; userId: true; username: true; fullName: true; avatarUrl: true; kycStatus: true } };
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
  // DC-010: id + kycStatus untuk badge author komentar.
  user: { select: { id: true, userId: true, username: true, fullName: true, avatarUrl: true, kycStatus: true } },
} satisfies Prisma.ShowcaseCommentInclude;

/** Versi payload cursor. Naikkan bila struktur cursor berubah supaya cursor lama
 *  ditolak eksplisit (INVALID_CURSOR) alih-alih menghasilkan halaman ngawur.
 *  v2 (2026-09-28): `l` pada sort "popular" berubah arti dari likeCount
 *  (all-time) menjadi hotViews (populer harian); sort "foryou" menambah `s`
 *  (skor personal). */
const FEED_CURSOR_VERSION = 2;

/**
 * Sentinel untuk cabang "pemilik melihat itemnya sendiri" pada filter OR.
 * `userId` adalah cuid, jadi nilai ini tidak akan pernah cocok dengan baris apa
 * pun; dipakai supaya cabang tersebut tetap ada (dan tidak berubah arti) ketika
 * `viewerId` undefined (viewer anonim). `userId` adalah cuid (huruf kecil/angka,
 * tanpa tanda hubung), jadi sentinel dengan tanda hubung ini tidak pernah cocok.
 * JANGAN memakai byte NUL: PostgreSQL menolak 0x00 di kolom teks (error 22021)
 * sehingga semua request anonim menjadi 500.
 */
const SELF_BRANCH_NEVER_MATCHES = 'no-such-viewer';

interface FeedCursorPayload {
  /** createdAt baris terakhir, dalam epoch ms. */
  t: number;
  /** Kunci numerik baris terakhir: hotViews untuk sort "popular",
   *  likeCount untuk sort lain (tidak dipakai "latest", tapi tetap diisi
   *  agar struktur cursor seragam). */
  l: number;
  /** id baris terakhir — tiebreak terakhir, menjamin urutan total. */
  i: string;
  /** Skor personal baris terakhir — hanya diisi untuk sort "foryou". */
  s?: number;
}

/**
 * Tanggal hari kalender berjalan dalam zona Asia/Jakarta, format YYYY-MM-DD.
 * Dipakai sebagai bucket agregat harian (hotViews, showcase_daily_stats):
 * "populer harian" berarti populer pada hari kalender ini bagi user Indonesia.
 */
function wibToday(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Jakarta',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

function encodeFeedCursor(
  row: { createdAt: Date; likeCount: number; hotViews: number; id: string },
  sort: ShowcaseFeedSort,
  score?: number,
): string {
  const payload: { v: number } & FeedCursorPayload = {
    v: FEED_CURSOR_VERSION,
    t: row.createdAt.getTime(),
    l: sort === 'popular' ? row.hotViews : row.likeCount,
    i: row.id,
    // Skor personal hanya untuk "foryou" — dipakai keyset in-memory.
    ...(sort === 'foryou' && typeof score === 'number' ? { s: score } : {}),
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
    (p.s !== undefined && (typeof p.s !== 'number' || !Number.isFinite(p.s))) ||
    typeof p.i !== 'string' ||
    p.i.length === 0 ||
    p.i.length > 64
  ) {
    throw new BadRequestException({ code: ErrorCodes.INVALID_CURSOR, message: 'Invalid feed cursor' });
  }
  return {
    t: p.t as number,
    l: p.l as number,
    i: p.i as string,
    ...(typeof p.s === 'number' ? { s: p.s as number } : {}),
  };
}

function toNumber(value: bigint | null): number | null {
  return value === null || value === undefined ? null : Number(value);
}

/** Profil afinitas viewer untuk sort "foryou" (tab "Untuk Anda"). */
interface ForYouSignals {
  /** kategori (lowercase) → jumlah item yang di-like viewer di kategori itu. */
  categoryAffinity: Map<string, number>;
  /** id seller yang di-follow viewer. */
  followedSellerIds: Set<string>;
}

/**
 * Urutan total untuk sort "foryou": skor desc, lalu createdAt desc, lalu id
 * desc — cerminan tiebreak keyset SQL pada sort latest/popular.
 */
function compareForYouEntries(
  a: { row: { createdAt: Date; id: string }; score: number },
  b: { row: { createdAt: Date; id: string }; score: number },
): number {
  if (b.score !== a.score) return b.score - a.score;
  const timeDiff = b.row.createdAt.getTime() - a.row.createdAt.getTime();
  if (timeDiff !== 0) return timeDiff;
  return b.row.id.localeCompare(a.row.id);
}

/** Batch 19 TIM A (item 1 & 2): bentuk ternormalisasi satu entri media untuk create ShowcaseImage. */
interface MediaCreateEntry {
  fileKey: string;
  imageUrl: string;
  sortOrder: number;
  kind: string;
  thumbnailUrl: string | null;
  durationSec: number | null;
  width: number | null;
  height: number | null;
  groupKey: string | null;
  groupOrder: number | null;
}

/** Normalkan hasil prepareImageKeys (jalur lama, kind=image) maupun prepareMediaEntries ke MediaCreateEntry. */
function toImageCreates(entries: Array<MediaCreateEntry | { fileKey: string; imageUrl: string }>): MediaCreateEntry[] {
  return entries.map((entry, index) => {
    const full = entry as Partial<MediaCreateEntry> & { fileKey: string; imageUrl: string };
    return {
      fileKey: full.fileKey,
      imageUrl: full.imageUrl,
      sortOrder: full.sortOrder ?? index,
      kind: full.kind ?? ShowcaseMediaKind.IMAGE,
      thumbnailUrl: full.thumbnailUrl ?? null,
      durationSec: full.durationSec ?? null,
      width: full.width ?? null,
      height: full.height ?? null,
      groupKey: full.groupKey ?? null,
      groupOrder: full.groupOrder ?? null,
    };
  });
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
    // GAP-F (G415): cluster duplikat laporan — best-effort, tidak menggagalkan laporan.
    private readonly moderation: AdminShowcaseReportsService,
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
    // SS-008 (audit 2026-09-26): TANPA cap. excludedIds dipakai sebagai
    // `id: { notIn }` di visibleOwnerFilter — inilah penegak blokir di feed.
    // Cap 1000 lama membocorkan konten dari akun yang diblokir melewati batas.
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
   * Aturan: item harus belum dihapus; pemilik selalu boleh melihat itemnya
   * sendiri (termasuk yang isActive=false / PRIVATE — SH-B-001: owner preview
   * item nonaktif tidak boleh 404); selain pemilik, item harus PUBLIC +
   * isActive + pemiliknya akun aktif/tidak banned/belum terhapus/profil
   * publik, dan tidak ada relasi block dengan viewer.
   */
  private async findVisibleShowcase(
    showcaseId: string,
    viewerId?: string,
  ): Promise<{ row: ShowcaseRow; isOwner: boolean } | null> {
    const excludedIds = await this.getViewerExcludedIds(viewerId);
    const row = (await this.prisma.userShowcase.findFirst({
      where: {
        id: showcaseId,
        deletedAt: null,
        // Dua cabang: (1) pemilik selalu boleh melihat itemnya sendiri, termasuk
        //     yang PRIVATE dan yang sedang nonaktif (isActive=false) — kalau
        //     tidak, owner kehilangan preview itemnya sendiri;
        //     (2) selain pemilik, item harus PUBLIC + isActive dan pemiliknya
        //     harus akun aktif, tidak banned, belum terhapus, profil publik,
        //     dan tidak terlibat relasi block dengan viewer.
        OR: [
          { userId: viewerId ?? SELF_BRANCH_NEVER_MATCHES },
          { visibility: ShowcaseVisibility.PUBLIC, isActive: true, user: this.visibleOwnerFilter(excludedIds) },
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
    options: { isLiked?: boolean; isSaved?: boolean; isOwner?: boolean; authorBadges?: Array<{ type: string }>; followedAuthorIds?: Set<string>; excerpt?: boolean } = {},
  ): Record<string, unknown> {
    // Batch 19 TIM A (item 1 & 2): media etalase bisa image/video/spin360.
    // Field lama (id/imageUrl/sortOrder) tetap — kontrak lama tidak berubah.
    const images = row.images.map((image) => ({
      id: image.id,
      kind: image.kind ?? 'image',
      imageUrl: image.imageUrl,
      // Keputusan user 2026-09-28: `fileKey` hanya untuk OWNER — dipakai saat
      // PUT replace media untuk mereferensikan media existing tanpa upload
      // ulang. Response publik/non-owner tidak berubah.
      ...(options.isOwner ? { fileKey: image.fileKey ?? null } : {}),
      thumbnailUrl: image.thumbnailUrl ?? null,
      durationSec: image.durationSec ?? null,
      width: image.width ?? null,
      height: image.height ?? null,
      groupKey: image.groupKey ?? null,
      groupOrder: image.groupOrder ?? null,
      sortOrder: image.sortOrder,
    }));
    const priceMin = toNumber(row.priceMin);
    const priceMax = toNumber(row.priceMax);
    // Video memakai thumbnail sebagai cover agar kartu feed tidak hitam.
    const firstMedia = images[0];
    const coverImageUrl = firstMedia
      ? firstMedia.kind === 'video' && firstMedia.thumbnailUrl
        ? firstMedia.thumbnailUrl
        : firstMedia.imageUrl
      : null;
    const orderValue = priceMin ?? priceMax ?? null;
    const counterpartUsername = row.user.username ?? row.user.userId;

    // Deskripsi OrderLink punya minLength 10; deskripsi showcase boleh kosong,
    // jadi sediakan fallback yang tetap masuk akal.
    const description = row.description?.trim();
    const orderDescription =
      description && description.length >= 10
        ? description.slice(0, 500)
        : `Pesan "${row.title}" dari @${counterpartUsername} di Kahade.`.slice(0, 500);

    // NP-007 (perf-fix): mode excerpt (daftar feed) — deskripsi dipotong
    // 200 karakter dan descriptionHtml (HTML penuh, bisa besar) tidak dikirim.
    // Detail memakai endpoint tersendiri dengan field penuh.
    const descriptionOut = options.excerpt && row.description && row.description.length > 200
      ? row.description.slice(0, 200)
      : row.description;
    return {
      id: row.id,
      title: row.title,
      description: descriptionOut,
      // Benefit 7 Kahade+: deskripsi HTML subscriber (disimpan apa adanya;
      // frontend wajib mensanitasi sebelum render).
      descriptionHtml: options.excerpt ? null : (row.descriptionHtml ?? null),
      category: row.category,
      visibility: row.visibility,
      isActive: row.isActive,
      sortOrder: row.sortOrder,
      // Batch 19 TIM A (item 6): kondisi barang (BARU/BEKAS/null).
      condition: row.condition ?? null,
      images,
      coverImageUrl,
      // Alias deprecated: kolom tunggal `imageUrl` sudah diganti ShowcaseImage.
      // Dipertahankan supaya client lama tidak putus selama migrasi.
      imageUrl: coverImageUrl,
      priceMin,
      priceMax,
      // Batch 43 commerce (item 1 & 10): tipe produk + harga coret diserialkan
      // publik supaya frontend (feed/detail) bisa render badge DISKON dan
      // logika per tipe (jasa → tenggat). Field sudah ada di DB sejak
      // migrasi 20261001000000; sebelumnya hanya bisa dibaca via
      // PATCH /v1/commerce/products/:id response. Additive-only.
      productType: row.productType ?? null,
      originalPrice: toNumber(row.originalPrice ?? null),
      originalPriceValid:
        row.originalPrice != null &&
        (priceMin ?? priceMax) != null &&
        row.originalPrice > BigInt(0) &&
        row.originalPrice > (row.priceMin ?? row.priceMax)!,
      serviceDeadlineDays: row.serviceDeadlineDays ?? null,
      likeCount: row.likeCount,
      commentCount: row.commentCount,
      viewCount: row.viewCount,
      // S-4: berapa kali deep link share item ini dibuka.
      shareCount: row.shareCount,
      // Batch 19 TIM A (item 3): save counter + status save viewer.
      saveCount: row.saveCount,
      isLiked: Boolean(options.isLiked),
      isSaved: Boolean(options.isSaved),
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
        // Batch 139 BE-API1 (item 102): apakah viewer mengikuti author etalase.
        // Dihitung dari SATU batch query di serializeFeedPage (bukan N+1 per
        // kartu — dukung I056). false bila viewer anonim, viewer == author,
        // atau tidak follow. Pemanggil lain yang tidak meneruskan
        // `followedAuthorIds` tetap mendapat false (kontrak lama tak berubah).
        isFollowing: options.followedAuthorIds?.has(row.user.id) ?? false,
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

  /**
   * SS-012: daftar item milik user yang sedang di-soft-delete (dapat dipulihkan
   * dalam 30 hari). Menggantikan pelacakan lokal di perangkat (SecureStore)
   * yang hilang saat ganti perangkat/install ulang.
   */
  async listDeletedShowcaseItems(userId: string, page?: number, limit?: number): Promise<object> {
    const safePage = Number.isFinite(page) ? Math.max(1, Math.floor(page as number)) : 1;
    const safeLimit = Number.isFinite(limit) ? Math.min(Math.max(1, Math.floor(limit as number)), 50) : 20;
    const skip = (safePage - 1) * safeLimit;
    const retentionMs = 30 * 24 * 60 * 60 * 1000;
    const now = Date.now();

    const [items, total] = await Promise.all([
      this.prisma.userShowcase.findMany({
        where: { userId, deletedAt: { not: null } },
        orderBy: [{ deletedAt: 'desc' }, { id: 'desc' }],
        skip,
        take: safeLimit,
        include: SHOWCASE_INCLUDE,
      }) as unknown as Promise<ShowcaseRow[]>,
      this.prisma.userShowcase.count({ where: { userId, deletedAt: { not: null } } }),
    ]);

    return {
      items: items.map((item) => {
        const deletedAt = (item.deletedAt as Date).getTime();
        const daysRemaining = Math.max(0, Math.ceil((deletedAt + retentionMs - now) / (24 * 60 * 60 * 1000)));
        return {
          ...this.serializeShowcase(item, { isOwner: true }),
          deletedAt: new Date(deletedAt).toISOString(),
          daysRemaining,
          restorable: now - deletedAt <= retentionMs,
        };
      }),
      total,
      page: safePage,
      limit: safeLimit,
    };
  }

  async createShowcaseItem(userId: string, dto: CreateShowcaseItemDto): Promise<object> {
    const title = this.normalizeTitle(dto.title);
    this.assertPriceRange(dto.priceMin, dto.priceMax);
    // Batch 19 TIM A: media (image/video/spin360) ATAU imageFileKeys lama —
    // keduanya sekaligus = ambigu → tolak (fail closed).
    if (dto.media !== undefined && dto.imageFileKeys !== undefined) {
      throw new BadRequestException({
        code: ErrorCodes.SHOWCASE_INVALID_MEDIA,
        message: 'Gunakan salah satu: media atau imageFileKeys, tidak bisa keduanya',
      });
    }
    const mediaEntries = dto.media !== undefined
      ? await this.prepareMediaEntries(userId, dto.media)
      : null;
    const imageFileKeys = dto.media !== undefined
      ? []
      : await this.prepareImageKeys(userId, dto.imageFileKeys);

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
              condition: dto.condition ?? null,
              images: {
                create: toImageCreates(mediaEntries ?? imageFileKeys),
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

    // Batch 19 TIM A: media ATAU imageFileKeys — keduanya sekaligus = ambigu.
    if (dto.media !== undefined && dto.imageFileKeys !== undefined) {
      throw new BadRequestException({
        code: ErrorCodes.SHOWCASE_INVALID_MEDIA,
        message: 'Gunakan salah satu: media atau imageFileKeys, tidak bisa keduanya',
      });
    }

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
    // Batch 19 TIM A (item 6): kondisi barang.
    if (dto.condition !== undefined) data.condition = dto.condition;

    // R-3: samakan dengan create — item tidak boleh berakhir tanpa gambar sama
    // sekali. Array kosong ditolak eksplisit dengan pesan yang jelas (bukan
    // diartikan "hapus semua gambar"); penghapusan per gambar tetap lewat
    // endpoint DELETE /users/me/showcase/images/:imageId.
    if (dto.media !== undefined) {
      if (dto.media.length === 0) {
        throw new BadRequestException({
          code: ErrorCodes.VALIDATION_ERROR,
          message:
            'media must contain at least 1 entry: a showcase item cannot be left without media. ' +
            'Remove individual media via DELETE /users/me/showcase/images/:imageId instead.',
        });
      }
      // SH-B-007: validasi dulu TANPA consume; konfirmasi one-time baru
      // di-consume SETELAH update DB sukses.
      const mediaEntries = await this.prepareMediaEntries(userId, dto.media, { consume: false });
      const removedKeys = existing.images.flatMap((image) =>
        [image.fileKey, image.thumbnailUrl ? this.uploadService.fileKeyFromPublicUrl(image.thumbnailUrl) : null].filter(
          (k): k is string => Boolean(k),
        ),
      );
      data.images = {
        deleteMany: {},
        create: toImageCreates(mediaEntries),
      };
      // Bersihkan object lama dari storage SETELAH commit supaya kegagalan
      // storage tidak membatalkan update yang sudah sukses.
      this.scheduleImageCleanup(userId, removedKeys);
    } else if (dto.imageFileKeys !== undefined) {
      if (dto.imageFileKeys.length === 0) {
        throw new BadRequestException({
          code: ErrorCodes.VALIDATION_ERROR,
          message:
            'imageFileKeys must contain at least 1 image: a showcase item cannot be left without images. ' +
            'Remove individual images via DELETE /users/me/showcase/images/:imageId instead.',
        });
      }
      // SH-B-007: validasi dulu TANPA consume; konfirmasi one-time baru
      // di-consume SETELAH update DB sukses — bila update gagal, file tidak
      // yatim dan user tidak perlu upload ulang.
      const imageFileKeys = await this.prepareImageKeys(userId, dto.imageFileKeys, { consume: false });
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

    // SH-B-007: consume SETELAH update sukses. Bila consume gagal di sini
    // (sangat jarang — balapan double-submit), item sudah benar di DB;
    // key yang tersisa kedaluwarsa sendiri via TTL konfirmasi.
    if (dto.media !== undefined && dto.media.length > 0) {
      const consumeKeys = [...new Set(dto.media.flatMap((m) => [m.fileKey, m.thumbnailFileKey].filter((k): k is string => Boolean(k))))];
      await this.uploadService.consumeUploadConfirmations(userId, consumeKeys);
    } else if (dto.imageFileKeys !== undefined && dto.imageFileKeys.length > 0) {
      await this.uploadService.consumeUploadConfirmations(userId, dto.imageFileKeys);
    }

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
    // SH-B-008: restore tidak boleh mendorong owner melewati SHOWCASE_MAX_ITEMS
    // (skenario: hapus 1 → buat 1 baru → restore yang lama = 21 item).
    // Count + update dalam SATU transaksi dengan lock pada baris aktif user —
    // dua restore paralel tidak bisa sama-sama membaca count=N-1 lalu
    // sama-sama restore (yang satu menunggu lock, lalu melihat count=N).
    await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT id FROM "user_showcases" WHERE "userId" = ${userId} AND "deletedAt" IS NULL FOR UPDATE`;
      const activeCount = await tx.userShowcase.count({ where: { userId, deletedAt: null } });
      if (activeCount >= SHOWCASE_MAX_ITEMS) {
        throw new BadRequestException({
          code: ErrorCodes.SHOWCASE_ITEM_LIMIT_REACHED,
          message: `Maximum ${SHOWCASE_MAX_ITEMS} showcase items allowed. Delete one of your active items before restoring this one.`,
        });
      }
      await tx.userShowcase.update({
        where: { id: existing.id },
        data: { deletedAt: null },
      });
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
   *
   * SH-B-007: `opts.consume=false` hanya memvalidasi TANPA meng-consume
   * konfirmasi one-time — pemanggil wajib memanggil
   * `uploadService.consumeUploadConfirmations()` SETELAH mutasi DB sukses.
   */
  /**
   * Batch 19 TIM A (item 1 & 2): satu entri media yang siap di-create sebagai
   * baris ShowcaseImage. `prepareImageKeys` (jalur lama) menghasilkan subset
   * { fileKey, imageUrl }; `toImageCreates` menormalkan keduanya ke bentuk ini
   * supaya create/update punya satu sumber kebenaran.
   */
  private async prepareImageKeys(
    userId: string,
    fileKeys: string[] | undefined,
    opts: { consume?: boolean } = {},
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
      consume: opts.consume ?? true,
      label: 'Showcase image',
    });
    return fileKeys.map((fileKey) => ({ fileKey, imageUrl: this.uploadService.buildPublicUrl(fileKey) }));
  }
  /**
   * Batch 19 TIM A (item 1 & 2): validasi + normalisasi daftar media
   * (image/video/spin360) untuk create/update etalase.
   *
   * Fail closed di setiap langkah:
   *  - kind=video WAJIB punya thumbnailFileKey (confirmed SHOWCASE_IMAGE milik user).
   *  - kind=spin360 WAJIB punya groupKey + groupOrder; tiap grup 8-24 frame
   *    dengan groupOrder 0..n-1 kontinu (tanpa lompat/duplikat).
   *  - fileKey harus confirmed upload milik user dengan purpose yang cocok
   *    (image/spin360 -> SHOWCASE_IMAGE, video -> SHOWCASE_VIDEO).
   *  - duplikat fileKey (termasuk thumbnail) dalam satu request ditolak.
   */
  private async prepareMediaEntries(
    userId: string,
    entries: ShowcaseMediaInputDto[],
    opts: { consume?: boolean } = {},
  ): Promise<MediaCreateEntry[]> {
    if (entries.length === 0) return [];
    const maxImages = await this.subscriptionsService.getMaxShowcaseImages(userId);
    if (entries.length > maxImages) {
      throw new BadRequestException({
        code: ErrorCodes.SHOWCASE_IMAGE_LIMIT_REACHED,
        message: `Maximum ${maxImages} media per showcase item`,
      });
    }
    const shouldConsume = opts.consume ?? true;

    const imageKeys: string[] = [];
    const videoKeys: string[] = [];
    const thumbKeys: string[] = [];
    const spinKeys: string[] = [];
    const spinOrders = new Map<string, number[]>();
    for (const entry of entries) {
      if (entry.kind === ShowcaseMediaKind.VIDEO) {
        if (!entry.thumbnailFileKey) {
          throw new BadRequestException({
            code: ErrorCodes.SHOWCASE_INVALID_MEDIA,
            message: 'thumbnailFileKey wajib diisi untuk media video',
          });
        }
        videoKeys.push(entry.fileKey);
        thumbKeys.push(entry.thumbnailFileKey);
      } else if (entry.kind === ShowcaseMediaKind.SPIN360) {
        if (!entry.groupKey || entry.groupOrder === undefined) {
          throw new BadRequestException({
            code: ErrorCodes.SHOWCASE_SPIN360_INVALID,
            message: 'groupKey dan groupOrder wajib diisi untuk media spin360',
          });
        }
        spinKeys.push(entry.fileKey);
        const orders = spinOrders.get(entry.groupKey) ?? [];
        orders.push(entry.groupOrder);
        spinOrders.set(entry.groupKey, orders);
      } else {
        imageKeys.push(entry.fileKey);
      }
    }

    // Validasi grup spin360: 8-24 frame, groupOrder tepat 0..n-1.
    for (const [groupKey, orders] of spinOrders) {
      if (orders.length < SHOWCASE_SPIN360_MIN_FRAMES || orders.length > SHOWCASE_SPIN360_MAX_FRAMES) {
        throw new BadRequestException({
          code: ErrorCodes.SHOWCASE_SPIN360_INVALID,
          message: `Grup spin360 "${groupKey}" harus berisi ${SHOWCASE_SPIN360_MIN_FRAMES}-${SHOWCASE_SPIN360_MAX_FRAMES} frame`,
        });
      }
      const sorted = [...orders].sort((a, b) => a - b);
      if (!sorted.every((value, index) => value === index)) {
        throw new BadRequestException({
          code: ErrorCodes.SHOWCASE_SPIN360_INVALID,
          message: `Grup spin360 "${groupKey}": groupOrder harus 0..${orders.length - 1} kontinu tanpa lompat`,
        });
      }
    }

    // Duplikat key dalam satu request = ambigu → tolak sebelum verifikasi.
    const allKeys = [...imageKeys, ...videoKeys, ...thumbKeys, ...spinKeys];
    if (new Set(allKeys).size !== allKeys.length) {
      throw new BadRequestException({
        code: ErrorCodes.SHOWCASE_INVALID_MEDIA,
        message: 'Duplikat fileKey dalam daftar media tidak diizinkan',
      });
    }

    // Verifikasi kepemilikan + konfirmasi per purpose (fail closed).
    // verifyUserFileKeys melempar bila key bukan milik user / belum confirmed /
    // ukuran di luar batas / purpose salah.
    await this.uploadService.verifyUserFileKeys(userId, imageKeys, UploadPurpose.SHOWCASE_IMAGE, {
      maxFiles: maxImages, consume: shouldConsume, label: 'Showcase media',
    });
    await this.uploadService.verifyUserFileKeys(userId, spinKeys, UploadPurpose.SHOWCASE_IMAGE, {
      maxFiles: maxImages, consume: shouldConsume, label: 'Spin360 frame',
    });
    await this.uploadService.verifyUserFileKeys(userId, thumbKeys, UploadPurpose.SHOWCASE_IMAGE, {
      maxFiles: maxImages, consume: shouldConsume, label: 'Video thumbnail',
    });
    await this.uploadService.verifyUserFileKeys(userId, videoKeys, UploadPurpose.SHOWCASE_VIDEO, {
      maxFiles: maxImages, consume: shouldConsume, label: 'Showcase video',
    });

    const thumbByFileKey = new Map<string, string>();
    for (const entry of entries) {
      if (entry.kind === ShowcaseMediaKind.VIDEO && entry.thumbnailFileKey) {
        thumbByFileKey.set(entry.fileKey, entry.thumbnailFileKey);
      }
    }
    return entries.map((entry, index) => {
      const thumbKey = thumbByFileKey.get(entry.fileKey);
      return {
        fileKey: entry.fileKey,
        imageUrl: this.uploadService.buildPublicUrl(entry.fileKey),
        sortOrder: index,
        kind: entry.kind,
        thumbnailUrl: thumbKey ? this.uploadService.buildPublicUrl(thumbKey) : null,
        durationSec: entry.durationSec ?? null,
        width: entry.width ?? null,
        height: entry.height ?? null,
        groupKey: entry.kind === ShowcaseMediaKind.SPIN360 ? entry.groupKey ?? null : null,
        groupOrder: entry.kind === ShowcaseMediaKind.SPIN360 ? entry.groupOrder ?? null : null,
      };
    });
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
    // Pre-check cepat (UX): ditolak SEBELUM konfirmasi upload di-consume,
    // supaya user tidak perlu upload ulang. BUKAN otoritas akhir (TOCTOU).
    if (existing.images.length + fileKeys.length > maxImages) {
      throw new BadRequestException({
        code: ErrorCodes.SHOWCASE_IMAGE_LIMIT_REACHED,
        message: `Maximum ${maxImages} images per showcase item`,
      });
    }
    // SH-B-006: validasi dulu TANPA consume (pola sama seperti SH-B-007);
    // konfirmasi one-time baru di-consume SETELAH transaksi sukses — bila
    // cek otoritatif di dalam transaksi gagal (balapan), file tidak yatim
    // dan user tidak perlu upload ulang.
    const prepared = await this.prepareImageKeys(userId, fileKeys, { consume: false });
    if (prepared.length === 0) {
      throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'fileKeys must not be empty' });
    }

    const nextSortOrder = existing.images.reduce((max, image) => Math.max(max, image.sortOrder), -1) + 1;
    // SH-B-006: cek batas + createMany dalam SATU transaksi dengan row lock
    // (SELECT ... FOR UPDATE) pada item — dua request paralel tidak bisa
    // sama-sama lolos cek lalu totalnya melewati maxImages (TOCTOU).
    const created = await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT id FROM "user_showcases" WHERE id = ${itemId} FOR UPDATE`;
      const currentCount = await tx.showcaseImage.count({ where: { showcaseId: itemId } });
      if (currentCount + prepared.length > maxImages) {
        throw new BadRequestException({
          code: ErrorCodes.SHOWCASE_IMAGE_LIMIT_REACHED,
          message: `Maximum ${maxImages} images per showcase item`,
        });
      }
      return tx.showcaseImage.createMany({
        data: prepared.map((image, index) => ({
          showcaseId: itemId,
          imageUrl: image.imageUrl,
          fileKey: image.fileKey,
          sortOrder: nextSortOrder + index,
        })),
      });
    });

    // SH-B-006: consume SETELAH createMany sukses. Bila consume gagal
    // (sangat jarang — balapan double-submit), baris gambar sudah benar di
    // DB; key yang tersisa kedaluwarsa sendiri via TTL konfirmasi.
    await this.uploadService.consumeUploadConfirmations(userId, fileKeys);

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
    // SH-B-002: item wajib punya ≥1 gambar (invarian create/update). Hitung +
    // hapus dalam satu transaksi dengan row lock (SELECT ... FOR UPDATE) pada
    // item — dua request delete paralel tidak bisa sama-sama membaca count=2
    // lalu sama-sama menghapus (yang satu menunggu lock, lalu melihat count=1
    // dan ditolak). Lock juga menahan balapan dengan updateShowcaseItem yang
    // mengganti seluruh daftar gambar.
    await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT id FROM "user_showcases" WHERE id = ${image.showcaseId} FOR UPDATE`;
      const remaining = await tx.showcaseImage.count({ where: { showcaseId: image.showcaseId } });
      if (remaining <= 1) {
        throw new BadRequestException({
          code: ErrorCodes.SHOWCASE_IMAGE_MIN_ONE,
          message:
            'A showcase item must keep at least 1 image. Replace the image via update, or delete the whole item instead.',
        });
      }
      await tx.showcaseImage.delete({ where: { id: imageId } });
    });
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
    const savedIds = await this.getSavedShowcaseIds(viewerId, items.map((item) => item.id));
    const badgeMap = await this.getAuthorBadgeMap(items.map((item) => item.user.id));
    return {
      items: items.map((item) =>
        this.serializeShowcase(item, {
          isLiked: likedIds.has(item.id),
          isSaved: savedIds.has(item.id),
          authorBadges: badgeMap.get(item.user.id) ?? [],
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

    // SH-B-001 (fix): owner BOLEH mem-preview item miliknya yang sedang
    // nonaktif (isActive=false) — findVisibleShowcase tidak lagi memfilter
    // isActive untuk cabang owner. Preview semacam itu tidak ikut menaikkan
    // viewCount — angka view hanya untuk item yang tayang.
    const shouldCountView = !(visible.isOwner && !visible.row.isActive);
    const counted = shouldCountView ? await this.recordView(showcaseId, viewerId, options.clientIp) : false;
    const likedIds = await this.getLikedShowcaseIds(viewerId, [showcaseId]);
    const savedIds = await this.getSavedShowcaseIds(viewerId, [showcaseId]);
    const badgeMap = await this.getAuthorBadgeMap([visible.row.user.id]);

    return {
      ...this.serializeShowcase(visible.row, {
        isLiked: likedIds.has(showcaseId),
        isSaved: savedIds.has(showcaseId),
        isOwner: visible.isOwner,
        authorBadges: badgeMap.get(visible.row.user.id) ?? [],
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
    const savedIds = await this.getSavedShowcaseIds(
      viewerId,
      related.map((r) => r.id),
    );
    const badgeMap = await this.getAuthorBadgeMap(
      related.map((r) => r.user.id),
    );
    return related.map((r) =>
      this.serializeShowcase(r, {
        isLiked: likedIds.has(r.id),
        isSaved: savedIds.has(r.id),
        authorBadges: badgeMap.get(r.user.id) ?? [],
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
      let isNew: boolean;
      try {
        isNew = await this.redis.setNx(
          `showcase:view:${showcaseId}:${viewerKey}`,
          '1',
          SHOWCASE_VIEW_DEDUPE_TTL_SECONDS,
        );
      } catch {
        // SH-B-005/SH-S-008: Redis down TIDAK boleh membuat GET :showcaseId
        // me-return 500. View adalah metrik non-kritis → fail-open: hitung
        // tanpa dedupe sebagai degradasi.
        this.logger.warn(`recordView: Redis unavailable for showcase=${showcaseId}; counting view without dedupe`);
        isNew = true;
      }
      if (!isNew) return false;
    }
    // Atomic increment + scope id: pola TransactionTemplatesService.recordUsage.
    // R2 (audit Discovery 2026-09-26): guard status — item yang ter-soft-delete
    // / nonaktif di antara visibility-check dan increment tidak menambah counter.
    await this.prisma.userShowcase.updateMany({
      where: { id: showcaseId, deletedAt: null, isActive: true },
      data: { viewCount: { increment: 1 } },
    });
    // Populer harian: hotViews naik bila bucket hari kalender (WIB) masih
    // sama, reset ke 1 bila hari sudah berganti — satu statement CASE yang
    // atomik, tanpa cron. Guard status sama seperti updateMany di atas (R2).
    const today = wibToday();
    const touched = await this.prisma.$executeRaw`
      UPDATE "user_showcases"
      SET "hotViews" = CASE WHEN "hotViewDate" = ${today}::date THEN "hotViews" + 1 ELSE 1 END,
          "hotViewDate" = ${today}::date
      WHERE "id" = ${showcaseId} AND "deletedAt" IS NULL AND "isActive" = TRUE
    `;
    // Agregat harian (riwayat popularitas untuk analitik/admin). Best-effort:
    // metrik non-kritis — kegagalan tulis tidak boleh menggagalkan pencatatan
    // view (fail-open seperti Redis di atas). Dilewati bila barisnya ternyata
    // sudah tidak valid di antara check dan tulis (touched = 0).
    if (touched !== 0) {
      try {
        const dayStart = new Date(`${today}T00:00:00Z`);
        await this.prisma.showcaseDailyStat.upsert({
          where: { showcaseId_date: { showcaseId, date: dayStart } },
          update: { views: { increment: 1 } },
          create: { showcaseId, date: dayStart, views: 1 },
        });
      } catch (error) {
        this.logger.warn(
          `recordView: agregat harian gagal untuk showcase=${showcaseId}: ${(error as Error)?.message ?? error}`,
        );
      }
    }
    return true;
  }

  // ==================================================================
  // Feed discover (cursor-based)
  // ==================================================================

  async getFeed(viewerId: string | undefined, query: ShowcaseFeedQueryDto): Promise<object> {
    const limit = Math.min(Math.max(1, Math.floor(query.limit ?? 20)), SHOWCASE_FEED_MAX_LIMIT);
    const sort: ShowcaseFeedSort =
      query.sort === 'foryou' ? 'foryou' : query.sort === 'popular' ? 'popular' : 'latest';

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

    // Batch 19 TIM A (item 6): filter kondisi barang. Item tanpa kondisi
    // disembunyikan saat filter aktif (tidak bisa dipastikan cocok).
    if (query.condition !== undefined) {
      andClauses.push({ condition: query.condition });
    }

    // Batch 19 TIM A (item 6): filter rating penjual minimum. averageRating
    // adalah Decimal denormalisasi di users (>= 0, default 0, non-null).
    // Nilai 0 = tidak memfilter (semua pemilik lolos).
    if (query.minSellerRating !== undefined && query.minSellerRating > 0) {
      andClauses.push({ user: { averageRating: { gte: query.minSellerRating } } });
    }

    // Batch 139 BE-API2 (item 121): filter tipe produk.
    if (query.productType !== undefined) {
      andClauses.push({ productType: query.productType });
    }

    // Sort "foryou": ranking personal dihitung di aplikasi (butuh sinyal
    // viewer), jadi jalurnya terpisah dari keyset SQL latest/popular.
    if (sort === 'foryou') {
      return this.getForYouFeed(viewerId, baseWhere, andClauses, query, limit);
    }
    return this.getRankedFeed(sort, baseWhere, andClauses, query, limit, viewerId);
  }

  /**
   * Feed latest/popular dengan keyset pagination di SQL. Sort "popular" =
   * populer HARIAN: diurutkan menurut hotViews (view pada hari kalender
   * berjalan, zona Asia/Jakarta) — bukan likeCount all-time.
   */
  private async getRankedFeed(
    sort: 'latest' | 'popular',
    baseWhere: Prisma.UserShowcaseWhereInput,
    andClauses: Prisma.UserShowcaseWhereInput[],
    query: ShowcaseFeedQueryDto,
    limit: number,
    viewerId: string | undefined,
  ): Promise<object> {
    // Keyset: "baris-baris setelah cursor" menurut urutan sort. Menggunakan
    // tuple (sortKey..., id) sehingga hasilnya deterministik walau banyak baris
    // berbagi createdAt/hotViews yang sama.
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
        // Kunci keyset = (hotViews, createdAt, id): cursor.l membawa hotViews
        // baris terakhir (cursor v2).
        andClauses.push({
          OR: [
            { hotViews: { lt: cursor.l } },
            { hotViews: cursor.l, createdAt: { lt: cursorDate } },
            {
              hotViews: cursor.l,
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
        ? [{ hotViews: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }]
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
    const nextCursor =
      hasMore && pageRows.length > 0 ? encodeFeedCursor(pageRows[pageRows.length - 1], sort) : null;
    return this.serializeFeedPage(viewerId, pageRows, { sort, limit, hasMore, nextCursor });
  }

  /**
   * Sort "foryou" (tab "Untuk Anda"): ranking personal per viewer.
   *
   * Skor per item = kesegaran + afinitas kategori (dari item yang di-like
   * viewer) + boost seller yang di-follow + komponen keramaian kecil
   * (hotViews/likeCount sebagai tiebreak kualitas). Skor bergantung pada
   * viewer sehingga pengurutan tidak bisa di-keyset di SQL: kandidat diambil
   * dari 3 pool (afinitas kategori, seller yang di-follow, terbaru — semuanya
   * memakai filter `where` yang sama persis dengan feed biasa), digabung
   * (dedupe per id), diberi skor di aplikasi, lalu keyset in-memory memakai
   * cursor (skor, createdAt, id).
   *
   * Tamu (tanpa viewerId) atau user tanpa sinyal (cold start) → fallback ke
   * populer harian supaya tab tetap berguna.
   */
  private async getForYouFeed(
    viewerId: string | undefined,
    baseWhere: Prisma.UserShowcaseWhereInput,
    andClauses: Prisma.UserShowcaseWhereInput[],
    query: ShowcaseFeedQueryDto,
    limit: number,
  ): Promise<object> {
    const signals = viewerId ? await this.getForYouSignals(viewerId) : null;
    const hasSignal =
      !!signals && (signals.categoryAffinity.size > 0 || signals.followedSellerIds.size > 0);
    if (!hasSignal) {
      // Fallback: populer harian — deterministik dan sama untuk semua user.
      return this.getRankedFeed('popular', baseWhere, andClauses, query, limit, viewerId);
    }

    const where: Prisma.UserShowcaseWhereInput =
      andClauses.length > 0 ? { ...baseWhere, AND: andClauses } : baseWhere;
    const orderBy: Prisma.UserShowcaseOrderByWithRelationInput[] = [
      { createdAt: 'desc' },
      { id: 'desc' },
    ];
    const findPool = (poolWhere: Prisma.UserShowcaseWhereInput, take: number) =>
      this.prisma.userShowcase
        .findMany({ where: poolWhere, orderBy, take, include: SHOWCASE_INCLUDE })
        .then((rows) => rows as unknown as ShowcaseRow[]);

    const likedCategories = [...signals.categoryAffinity.keys()];
    const followedIds = [...signals.followedSellerIds];
    // Tiga pool kandidat — semuanya menghormati filter feed yang sama
    // (visibilitas, blokir, kategori/search/harga/lokasi dari query).
    const [affinityRows, followedRows, recentRows] = await Promise.all([
      // Pool 1: item terbaru dari kategori yang disukai viewer.
      likedCategories.length > 0
        ? findPool({ ...where, category: { in: likedCategories } }, SHOWCASE_FOR_YOU_AFFINITY_POOL)
        : Promise.resolve([] as ShowcaseRow[]),
      // Pool 2: item terbaru dari seller yang di-follow viewer.
      followedIds.length > 0
        ? findPool({ ...where, userId: { in: followedIds } }, SHOWCASE_FOR_YOU_FOLLOWED_POOL)
        : Promise.resolve([] as ShowcaseRow[]),
      // Pool 3: item terbaru secara umum (discovery + keragaman).
      findPool(where, SHOWCASE_FOR_YOU_RECENT_POOL),
    ]);

    const merged = new Map<string, ShowcaseRow>();
    for (const row of [...affinityRows, ...followedRows, ...recentRows]) {
      if (!merged.has(row.id)) merged.set(row.id, row);
    }

    // `now` dibulatkan ke bucket 15 menit supaya skor yang dihitung ulang
    // antar-request identik bit-per-bit (syarat keyset in-memory tetap valid
    // bila halaman 2 diminta beberapa menit setelah halaman 1).
    const nowBucket =
      Math.floor(Date.now() / SHOWCASE_FOR_YOU_SCORE_TIME_BUCKET_MS) *
      SHOWCASE_FOR_YOU_SCORE_TIME_BUCKET_MS;
    const scored = [...merged.values()].map((row) => ({
      row,
      score: this.scoreForYouItem(row, signals, nowBucket),
    }));
    scored.sort(compareForYouEntries);

    // Keyset in-memory: hanya baris "setelah" cursor (skor, createdAt, id).
    let after = scored;
    if (query.cursor) {
      const cursor = decodeFeedCursor(query.cursor);
      if (cursor.s === undefined) {
        throw new BadRequestException({
          code: ErrorCodes.INVALID_CURSOR,
          message: 'Invalid feed cursor',
        });
      }
      const cursorMsEnd = cursor.t + 1;
      const idx = scored.findIndex((entry) => {
        const t = entry.row.createdAt.getTime();
        if (entry.score !== cursor.s) return entry.score < (cursor.s as number);
        if (t < cursor.t) return true;
        // Bucket [t, t+1ms): presisi cursor hanya milidetik (pola T2) + tiebreak id.
        if (t >= cursor.t && t < cursorMsEnd) return entry.row.id < cursor.i;
        return false;
      });
      after = idx === -1 ? [] : scored.slice(idx);
    }

    const hasMore = after.length > limit;
    const page = hasMore ? after.slice(0, limit) : after;
    const pageRows = page.map((entry) => entry.row);
    const nextCursor =
      hasMore && page.length > 0
        ? encodeFeedCursor(page[page.length - 1].row, 'foryou', page[page.length - 1].score)
        : null;
    return this.serializeFeedPage(viewerId, pageRows, { sort: 'foryou', limit, hasMore, nextCursor });
  }

  /**
   * Profil afinitas viewer: kategori dari item yang di-like + seller yang
   * di-follow. Dua query kecil dan bounded (bukan seluruh riwayat).
   */
  private async getForYouSignals(viewerId: string): Promise<ForYouSignals> {
    const [likes, follows] = await Promise.all([
      this.prisma.showcaseLike.findMany({
        where: { userId: viewerId },
        select: { showcase: { select: { category: true } } },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: SHOWCASE_FOR_YOU_LIKE_SIGNAL_LIMIT,
      }),
      this.prisma.follow.findMany({
        where: { followerId: viewerId },
        select: { followingId: true },
        take: SHOWCASE_FOR_YOU_FOLLOW_SIGNAL_LIMIT,
      }),
    ]);
    const categoryAffinity = new Map<string, number>();
    for (const like of likes) {
      // Kategori disimpan lowercase (lihat normalizeCategory) — samakan di sini.
      const cat = like.showcase?.category?.trim().toLowerCase();
      if (!cat) continue;
      categoryAffinity.set(cat, (categoryAffinity.get(cat) ?? 0) + 1);
    }
    return {
      categoryAffinity,
      followedSellerIds: new Set(follows.map((f) => f.followingId)),
    };
  }

  /**
   * Skor personal satu item untuk sort "foryou". Deterministik untuk
   * (item, sinyal, bucket waktu) yang sama — syarat keyset in-memory.
   */
  private scoreForYouItem(row: ShowcaseRow, signals: ForYouSignals, nowBucketMs: number): number {
    const ageHours = Math.max(0, (nowBucketMs - row.createdAt.getTime()) / 3600000);
    // Kesegaran: 1000 saat baru lahir, meluruh (setengah tiap 24 jam).
    let score = 1000 / (1 + ageHours / 24);
    // Afinitas kategori: makin sering like kategori ini makin besar boost
    // (cap 5 like supaya satu kategori tidak mendominasi selamanya).
    const catLikes = row.category ? (signals.categoryAffinity.get(row.category) ?? 0) : 0;
    if (catLikes > 0) score += 300 * Math.min(catLikes, 5);
    // Seller yang di-follow: boost tetap yang besar.
    if (signals.followedSellerIds.has(row.userId)) score += 500;
    // Keramaian sebagai tiebreak kualitas (cap supaya tidak mengalahkan
    // sinyal personal).
    score += Math.min(row.hotViews, 200) * 0.5 + Math.min(row.likeCount, 200);
    return score;
  }

  /** Serialisasi satu halaman feed → kontrak respons (dipakai semua sort). */
  private async serializeFeedPage(
    viewerId: string | undefined,
    pageRows: ShowcaseRow[],
    opts: { sort: ShowcaseFeedSort; limit: number; hasMore: boolean; nextCursor: string | null },
  ): Promise<object> {
    const likedIds = await this.getLikedShowcaseIds(viewerId, pageRows.map((row) => row.id));
    const savedIds = await this.getSavedShowcaseIds(viewerId, pageRows.map((row) => row.id));
    // S1: badge 3-tier author (satu batch, cached di Redis).
    const badgeMap = await this.getAuthorBadgeMap(pageRows.map((row) => row.user.id));
    // Batch 139 BE-API1 (item 102): id author yang di-follow viewer — satu
    // batch query supaya FE tidak perlu N+1 request follow-status per kartu.
    const followedAuthorIds = await this.getFollowedAuthorIds(viewerId, pageRows.map((row) => row.user.id));

    return {
      items: pageRows.map((row) =>
        this.serializeShowcase(row, {
          isLiked: likedIds.has(row.id),
          isSaved: savedIds.has(row.id),
          authorBadges: badgeMap.get(row.user.id) ?? [],
          followedAuthorIds,
          excerpt: true,
        }),
      ),
      sort: opts.sort,
      limit: opts.limit,
      hasMore: opts.hasMore,
      nextCursor: opts.nextCursor,
    };
  }

  /**
   * Batch 139 BE-API1 (item 102): himpunan id author (User.id internal) yang
   * di-follow viewer — SATU query untuk satu halaman feed, bukan N+1.
   * Viewer anonim → himpunan kosong (semua `author.isFollowing` = false).
   * Diri sendiri dikecualikan (mengikuti diri sendiri tidak mungkin).
   */
  private async getFollowedAuthorIds(viewerId: string | undefined, authorIds: string[]): Promise<Set<string>> {
    if (!viewerId) return new Set();
    const unique = [...new Set(authorIds.filter((id) => id && id !== viewerId))];
    if (unique.length === 0) return new Set();
    const rows = await this.prisma.follow.findMany({
      where: { followerId: viewerId, followingId: { in: unique } },
      select: { followingId: true },
    });
    return new Set(rows.map((row) => row.followingId));
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
        // SH-B-010: guard status seperti recordView — item yang ter-soft-delete /
        // nonaktif di antara visibility-check dan commit TIDAK menaikkan counter.
        const bumped = await tx.userShowcase.updateMany({
          where: { id: showcaseId, deletedAt: null, isActive: true },
          data: { likeCount: { increment: 1 } },
        });
        if (bumped.count === 0) {
          // Item hilang/di-takedown di tengah jalan → rollback like.
          throw new NotFoundException({
            code: ErrorCodes.SHOWCASE_NOT_FOUND,
            message: 'Showcase item is no longer available',
          });
        }
        const row = await tx.userShowcase.findUnique({
          where: { id: showcaseId },
          select: { likeCount: true },
        });
        return { likeCount: row?.likeCount ?? 0 };
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
  // Save / unsave + daftar likers/savers (batch 19 TIM A, item 3)
  // ==================================================================

  /** `isSaved` untuk banyak item sekaligus — satu query, bukan N+1 (pola getLikedShowcaseIds). */
  private async getSavedShowcaseIds(viewerId: string | undefined, showcaseIds: string[]): Promise<Set<string>> {
    if (!viewerId || showcaseIds.length === 0) return new Set();
    const rows = await this.prisma.showcaseSave.findMany({
      where: { userId: viewerId, showcaseId: { in: showcaseIds } },
      select: { showcaseId: true },
    });
    return new Set(rows.map((r) => r.showcaseId));
  }

  async saveShowcase(userId: string, showcaseId: string): Promise<object> {
    const visible = await this.findVisibleShowcase(showcaseId, userId);
    if (!visible) {
      throw new NotFoundException({ code: ErrorCodes.SHOWCASE_NOT_FOUND, message: 'Showcase item not found' });
    }
    await this.assertNoBlockRelation(userId, visible.row.userId);

    try {
      const updated = await this.prisma.$transaction(async (tx) => {
        await tx.showcaseSave.create({ data: { userId, showcaseId } });
        // Guard seperti likeShowcase (SH-B-010): item yang ter-soft-delete /
        // nonaktif di antara visibility-check dan commit TIDAK menaikkan counter.
        const bumped = await tx.userShowcase.updateMany({
          where: { id: showcaseId, deletedAt: null, isActive: true },
          data: { saveCount: { increment: 1 } },
        });
        if (bumped.count === 0) {
          throw new NotFoundException({
            code: ErrorCodes.SHOWCASE_NOT_FOUND,
            message: 'Showcase item is no longer available',
          });
        }
        const row = await tx.userShowcase.findUnique({
          where: { id: showcaseId },
          select: { saveCount: true },
        });
        return { saveCount: row?.saveCount ?? 0 };
      });
      return { saved: true, saveCount: updated.saveCount };
    } catch (err) {
      // Unique (userId, showcaseId) -> save ganda dari request balapan.
      if (this.isUniqueViolation(err)) {
        const current = await this.prisma.userShowcase.findUnique({
          where: { id: showcaseId },
          select: { saveCount: true },
        });
        throw new ConflictException({
          code: ErrorCodes.SHOWCASE_ALREADY_SAVED,
          message: 'You already saved this showcase item',
          saveCount: current?.saveCount ?? null,
        });
      }
      throw err;
    }
  }

  async unsaveShowcase(userId: string, showcaseId: string): Promise<object> {
    const visible = await this.findVisibleShowcase(showcaseId, userId);
    if (!visible) {
      throw new NotFoundException({ code: ErrorCodes.SHOWCASE_NOT_FOUND, message: 'Showcase item not found' });
    }
    await this.assertNoBlockRelation(userId, visible.row.userId);

    const deleted = await this.prisma.showcaseSave.deleteMany({ where: { userId, showcaseId } });
    if (deleted.count === 0) {
      throw new NotFoundException({ code: ErrorCodes.SHOWCASE_NOT_SAVED, message: 'You have not saved this showcase item' });
    }
    // Decrement dengan guard gt 0 supaya counter tidak pernah negatif bila
    // ada drift data historis.
    await this.prisma.userShowcase.updateMany({
      where: { id: showcaseId, saveCount: { gt: 0 } },
      data: { saveCount: { decrement: 1 } },
    });
    const current = await this.prisma.userShowcase.findUnique({
      where: { id: showcaseId },
      select: { saveCount: true },
    });
    return { saved: false, saveCount: current?.saveCount ?? 0 };
  }

  /**
   * Daftar user yang me-like item — PUBLIK (item harus visible untuk viewer).
   * Pagination offset + tiebreak { id } agar halaman stabil (pola listComments).
   */
  async listLikers(
    showcaseId: string,
    viewerId: string | undefined,
    page: number,
    limit: number,
  ): Promise<object> {
    const visible = await this.findVisibleShowcase(showcaseId, viewerId);
    if (!visible) {
      throw new NotFoundException({ code: ErrorCodes.SHOWCASE_NOT_FOUND, message: 'Showcase item not found' });
    }
    const safePage = Number.isFinite(page) ? Math.max(1, Math.floor(page)) : 1;
    const safeLimit = Number.isFinite(limit) ? Math.min(Math.max(1, Math.floor(limit)), 100) : 20;
    const skip = (safePage - 1) * safeLimit;
    const [rows, total] = await Promise.all([
      this.prisma.showcaseLike.findMany({
        where: { showcaseId },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip,
        take: safeLimit,
        select: {
          createdAt: true,
          user: { select: { id: true, userId: true, username: true, fullName: true, avatarUrl: true } },
        },
      }),
      this.prisma.showcaseLike.count({ where: { showcaseId } }),
    ]);
    const data = rows.map((row) => ({
      userId: row.user.userId,
      username: row.user.username,
      fullName: row.user.fullName,
      avatarUrl: row.user.avatarUrl,
      likedAt: row.createdAt,
    }));
    return createPaginatedResponse(data, total, safePage, safeLimit);
  }

  /**
   * Daftar user yang menyimpan item — HANYA pemilik produk (privasi).
   * Bukan pemilik -> 403 SHOWCASE_FORBIDDEN. Item yang tidak ada / terhapus ->
   * 404 (sama seperti likers) agar keberadaan item tak bocor via perbedaan
   * status code.
   */
  async listSavers(
    userId: string,
    showcaseId: string,
    page: number,
    limit: number,
  ): Promise<object> {
    const item = await this.prisma.userShowcase.findFirst({
      where: { id: showcaseId, deletedAt: null },
      select: { id: true, userId: true },
    });
    if (!item) {
      throw new NotFoundException({ code: ErrorCodes.SHOWCASE_NOT_FOUND, message: 'Showcase item not found' });
    }
    if (item.userId !== userId) {
      throw new ForbiddenException({
        code: ErrorCodes.SHOWCASE_FORBIDDEN,
        message: 'Hanya pemilik produk yang dapat melihat daftar penyimpan',
      });
    }
    const safePage = Number.isFinite(page) ? Math.max(1, Math.floor(page)) : 1;
    const safeLimit = Number.isFinite(limit) ? Math.min(Math.max(1, Math.floor(limit)), 100) : 20;
    const skip = (safePage - 1) * safeLimit;
    const [rows, total] = await Promise.all([
      this.prisma.showcaseSave.findMany({
        where: { showcaseId },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip,
        take: safeLimit,
        select: {
          createdAt: true,
          user: { select: { id: true, userId: true, username: true, fullName: true, avatarUrl: true } },
        },
      }),
      this.prisma.showcaseSave.count({ where: { showcaseId } }),
    ]);
    const data = rows.map((row) => ({
      userId: row.user.userId,
      username: row.user.username,
      fullName: row.user.fullName,
      avatarUrl: row.user.avatarUrl,
      savedAt: row.createdAt,
    }));
    return createPaginatedResponse(data, total, safePage, safeLimit);
  }

  /**
   * BE-IMP (item 54): karya tersimpan milik user — untuk sinkronisasi koleksi
   * pribadi di frontend ("Karya tersimpan sync").
   *
   * Penyimpanan memakai model `ShowcaseSave` yang sudah ada (userId,
   * showcaseId, createdAt + unique constraint) — tidak perlu tabel/model baru.
   * Urutan: terbaru disimpan dulu. Setiap item memakai bentuk kartu publik
   * yang sama dengan feed (`serializeShowcase`) + `savedAt`.
   *
   * Item tetap dikembalikan walau sudah nonaktif/terhapus (soft delete) agar
   * frontend bisa menandai/membersihkan bookmark lokalnya — sinkronisasi
   * butuh melihat tombstone, bukan daftar yang diam-diam menyusut.
   */
  async listSavedShowcases(
    userId: string,
    page: number,
    limit: number,
  ): Promise<object> {
    const safePage = Number.isFinite(page) ? Math.max(1, Math.floor(page)) : 1;
    const safeLimit = Number.isFinite(limit) ? Math.min(Math.max(1, Math.floor(limit)), 100) : 20;
    const skip = (safePage - 1) * safeLimit;
    const [rows, total] = await Promise.all([
      this.prisma.showcaseSave.findMany({
        where: { userId },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip,
        take: safeLimit,
        include: { showcase: { include: SHOWCASE_INCLUDE } },
      }),
      this.prisma.showcaseSave.count({ where: { userId } }),
    ]);
    const showcaseRows = rows.map((row) => row.showcase) as unknown as ShowcaseRow[];
    const likedIds = await this.getLikedShowcaseIds(userId, showcaseRows.map((row) => row.id));
    const badgeMap = await this.getAuthorBadgeMap(showcaseRows.map((row) => row.user.id));
    const items = showcaseRows.map((item, index) => ({
      ...this.serializeShowcase(item, {
        isLiked: likedIds.has(item.id),
        isSaved: true,
        isOwner: item.user.id === userId,
        authorBadges: badgeMap.get(item.user.id) ?? [],
      }),
      savedAt: rows[index].createdAt,
    }));
    return createPaginatedResponse(items, total, safePage, safeLimit);
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
  async listComments(showcaseId: string, viewerId: string | undefined, page: number, limit: number, sort: 'newest' | 'oldest' = 'newest'): Promise<object> {
    const visible = await this.findVisibleShowcase(showcaseId, viewerId);
    if (!visible) {
      throw new NotFoundException({ code: ErrorCodes.SHOWCASE_NOT_FOUND, message: 'Showcase item not found' });
    }

    const safePage = Number.isFinite(page) ? Math.max(1, Math.floor(page)) : 1;
    const safeLimit = Number.isFinite(limit) ? Math.min(Math.max(1, Math.floor(limit)), 50) : 20;
    const skip = (safePage - 1) * safeLimit;
    // Batch 139 BE-API1 (item 103): urutan komentar root bisa dipilih —
    // `newest` (default, perilaku lama) atau `oldest`. Balasan di dalam tiap
    // thread TETAP kronologis menaik (percakapan dibaca dari atas).
    const rootOrder: 'asc' | 'desc' = sort === 'oldest' ? 'asc' : 'desc';

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
          orderBy: [{ createdAt: rootOrder }, { id: rootOrder }],
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

    // DC-010: sealTier author komentar — satu batch query untuk semua
    // author (roots + replies), bukan N+1.
    const authorIds = new Set<string>();
    for (const root of roots) {
      authorIds.add((root as CommentRow).user.id);
      for (const reply of repliesByParent.get(root.id) ?? []) authorIds.add(reply.user.id);
    }
    const sealTierMap = await this.verificationBadgeService.getSealTierMap(Array.from(authorIds));

    const data = roots.map((root) => ({
      ...this.serializeComment(root as CommentRow, sealTierMap),
      replyCount: replyCountByParent.get(root.id) ?? 0,
      replies: (repliesByParent.get(root.id) ?? []).map((reply) => this.serializeComment(reply, sealTierMap)),
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
      // Batch 139 BE-API1 (item 103): gema sort yang dipakai (additive).
      sort: sort === 'oldest' ? 'oldest' : 'newest',
    };
  }

  private serializeComment(row: CommentRow, sealTierMap?: Map<string, string | null>): Record<string, unknown> {
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
        // DC-010: info badge author agar UI bisa render VerifiedSeal di
        // komentar (konsisten dengan feed & profil).
        sealTier: sealTierMap?.get(row.user.id) ?? null,
        isKycVerified: row.user.kycStatus === 'APPROVED',
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
      // SH-B-009: guard status seperti recordView — item yang ter-soft-delete /
      // nonaktif di antara visibility-check dan commit TIDAK menaikkan counter.
      const bumped = await tx.userShowcase.updateMany({
        where: { id: showcaseId, deletedAt: null, isActive: true },
        data: { commentCount: { increment: 1 } },
      });
      if (bumped.count === 0) {
        // Item hilang/di-takedown di tengah jalan → rollback pembuatan komentar.
        throw new NotFoundException({
          code: ErrorCodes.SHOWCASE_NOT_FOUND,
          message: 'Showcase item is no longer available',
        });
      }
      return comment;
    })) as unknown as CommentRow;

    const sealTierMap = await this.verificationBadgeService.getSealTierMap([created.user.id]);
    return this.serializeComment(created, sealTierMap);
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
    const sealTierMap = await this.verificationBadgeService.getSealTierMap([updated.user.id]);
    return this.serializeComment(updated, sealTierMap);
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

    const sealTierMap = await this.verificationBadgeService.getSealTierMap([updated.user.id]);
    return this.serializeComment(updated, sealTierMap);
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
   * SS-005 (audit 2026-09-26): method ini MURNI — tidak lagi menaikkan
   * `shareCount`. Fetch metadata (retry, preview link, crawler) BUKAN aksi
   * share. Counter hanya naik lewat `recordShareOpen` (deep link dibuka) atau
   * `POST /v1/showcase/:showcaseId/share` (user menyelesaikan share sheet).
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
      // FX-001: scheme "kahade" sesuai app.json frontend (bukan "kahade-frontend").
      appUrl: `kahade://showcase/${encodeURIComponent(row.id)}`,
      // SS-005: nilai terkini TANPA increment — baca murni.
      shareCount: row.shareCount,
    };
  }

  /**
   * Mencatat satu kejadian share nyata: deep link dibuka atau user
   * menyelesaikan share sheet. Increment atomik; item yang tidak visible
   * → 404 sebelum increment (tidak ada share tercatat untuk konten privat).
   *
   * SH-B-004/SH-S-002 (anti-inflasi shareCount):
   *  - bot/crawler (UA) tidak menaikkan counter — dikembalikan apa adanya;
   *  - dedupe per (viewer, item) 24 jam via Redis SET NX (pola recordView);
   *  - endpoint tetap @Public(): frontend memanggilnya anonim (auth: "none"),
   *    jadi auth TIDAK diwajibkan agar kontrak existing tidak rusak.
   *    Untuk anonim dipakai hash IP seperti recordView.
   * Redis down → fail-open (tetap hitung, tanpa dedupe): share adalah metrik
   * non-kritis, jangan gagalkan aksi user.
   */
  async recordShareOpen(
    showcaseId: string,
    viewerId?: string,
    options: { clientIp?: string; userAgent?: string } = {},
  ): Promise<{ shareCount: number }> {
    const visible = await this.findVisibleShowcase(showcaseId, viewerId);
    if (!visible) {
      throw new NotFoundException({ code: ErrorCodes.SHOWCASE_NOT_FOUND, message: 'Showcase item not found' });
    }
    // Bot (preview OG/unfurl) bukan share nyata.
    if (isBotUserAgent(options.userAgent)) {
      return { shareCount: visible.row.shareCount };
    }
    const viewerKey = viewerId
      ? `u:${viewerId}`
      : options.clientIp
        ? `ip:${createHash('sha256').update(options.clientIp).digest('hex').slice(0, 32)}`
        : null;
    if (viewerKey) {
      let isNew: boolean;
      try {
        isNew = await this.redis.setNx(
          `showcase:share:${visible.row.id}:${viewerKey}`,
          '1',
          SHOWCASE_SHARE_DEDUPE_TTL_SECONDS,
        );
      } catch {
        // Redis down → hitung tanpa dedupe (degradasi), bukan 500.
        this.logger.warn(`recordShareOpen: Redis unavailable for showcase=${visible.row.id}; counting share without dedupe`);
        isNew = true;
      }
      if (!isNew) {
        return { shareCount: visible.row.shareCount };
      }
    }
    const updated = await this.prisma.userShowcase.update({
      where: { id: visible.row.id },
      data: { shareCount: { increment: 1 } },
      select: { shareCount: true },
    });
    return { shareCount: updated.shareCount };
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
    // SH-B-003 (lapis kedua): DTO sudah punya @Max(ORDER_MAX_VALUE), tapi jalur
    // internal/pemanggil langsung service tetap dijaga di sini.
    for (const [label, value] of [['priceMin', priceMin], ['priceMax', priceMax]] as const) {
      if (value !== undefined && (value < 0 || value > ORDER_MAX_VALUE)) {
        throw new BadRequestException({
          code: ErrorCodes.VALIDATION_ERROR,
          message: `${label} must be between 0 and ${ORDER_MAX_VALUE}`,
        });
      }
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
   * 5. GAP-F: laporan atas item takedown → 409 dengan arahan banding; laporan
   *    baru ditautkan ke cluster duplikat (G415, best-effort).
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
      // GAP-F (G404): item tidak tayang karena DINONAKTIFKAN moderasi
      // (takedown/restrict) → 409 dengan arahan: pemilik mengajukan banding,
      // laporan baru tidak diperlukan. Bukan 404 generik agar UX jelas.
      // Best-effort: bila tabel moderasi belum di-merge, pertahankan 404 lama.
      const takenDown = await this.findModerationEnforcement(showcaseId);
      if (takenDown) {
        throw new ConflictException({
          code: ErrorCodes.REPORT_APPEAL_REQUIRED,
          message:
            'Item ini sudah dinonaktifkan oleh moderasi Kahade sehingga tidak bisa dilaporkan lagi. ' +
            'Bila Anda pemilik item, ajukan banding melalui aplikasi Kahade.',
        });
      }
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

    // 5. GAP-F (G415): tautkan laporan baru ke cluster duplikat (showcaseId +
    // reason sama dalam 24 jam). Best-effort — tidak menggagalkan laporan.
    void this.moderation.linkReportToCluster(report.id, showcaseId, dto.reason);

    return { reported: true, reportId: report.id };
  }

  /**
   * GAP-F (G404): cari enforcement moderasi (TAKEDOWN/RESTRICTED) atas sebuah
   * item — dipakai untuk 409-with-appeal-direction saat item takedown dilaporkan.
   * Best-effort: null bila tabel fragment belum tersedia.
   */
  private async findModerationEnforcement(showcaseId: string): Promise<{ reportId: string } | null> {
    try {
      const mod = moderationDb(this.prisma);
      const ev = await mod.reportModerationEvent.findFirst({
        where: {
          action: { in: ['TAKEDOWN', 'RESTRICTED'] },
          report: { showcaseId },
        },
        orderBy: { createdAt: 'desc' },
        select: { reportId: true },
      });
      return ev ? { reportId: ev.reportId } : null;
    } catch (err) {
      this.logger.warn(
        `findModerationEnforcement(${showcaseId}) failed (best-effort): ${(err as Error).message}`,
      );
      return null;
    }
  }
}
