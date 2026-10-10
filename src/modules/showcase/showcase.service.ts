import { Injectable, Logger, BadRequestException, NotFoundException, ForbiddenException, ConflictException, GoneException, InternalServerErrorException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AuditAction, ContentHiddenReason, OrderStatus, Prisma, ShowcaseVisibility } from '@prisma/client';
import { createHash } from 'crypto';
import { PrismaService } from '../../prisma/prisma.service';
import { RedisService } from '../../redis/redis.service';
import { UploadService } from '../upload/upload.service';
import { UploadPurpose } from '../upload/dto/presigned-url.dto';
import * as ErrorCodes from '../../common/constants/error-codes';
import { escapeLikePattern } from '../../common/utils/search.util';
import { sanitizeShowcaseHtml } from '../../common/utils/sanitize-html.util';
import { isBotUserAgent } from '../../common/utils/bot-detection.util';
import { formatIdr, toIdr } from '../../common/utils/currency.util';
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
  SHOWCASE_FOR_YOU_SIGNALS_CACHE_TTL_SECONDS,
  SHOWCASE_FOR_YOU_POOL_CACHE_TTL_SECONDS,
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
import { toStorable, fromStorable, stableStringify } from '../../common/utils/json-cache.util';
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
// D1-001 (perf 2026-09-29): ambang badge commerce dipakai ulang di
// serializeFeedPage supaya definisi TERLARIS tetap satu sumber kebenaran
// (product-commerce.service tidak mengimpor showcase.service — aman dari
// circular import).
import { BEST_SELLER_MIN_COMPLETED, BEST_SELLER_WINDOW_DAYS } from '../commerce/services/product-commerce.service';

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

/** BEC-01: enforcement moderasi aktif pada satu item (lihat getActiveEnforcementMap). */
type ModerationEnforcement = {
  reportId: string;
  action: 'TAKEDOWN' | 'RESTRICTED';
  createdAt: Date;
  note: string | null;
  /** Batas restrict sementara (ISO) bila ada di metadata event. */
  until: string | null;
};

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

// ============================================================================
// NP-008 (perf-fix, 2026-09-29): keyset cursor untuk LIST DALAM (likers,
// savers, saved, comments). Offset (`skip` besar) memaksa Postgres memindai +
// membuang baris — makin dalam halaman makin lambat. Kursor opak =
// base64url(JSON { t: epochMs, i: id }) dengan keyset WHERE pada urutan
// (createdAt, id) — tiebreak id ganda menjaga stabilitas walau ada baris
// baru di tengah paginasi. Kompatibel mundur: tanpa `cursor`, perilaku
// offset lama tetap dipakai.
// ============================================================================

type NestedListDirection = 'desc' | 'asc';

interface NestedCursor {
  t: number;
  i: string;
}

function encodeNestedCursor(createdAt: Date, id: string): string {
  return Buffer.from(JSON.stringify({ t: createdAt.getTime(), i: id }), 'utf8').toString('base64url');
}

function decodeNestedCursor(cursor: string): NestedCursor {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    parsed = null;
  }
  const p = parsed as { t?: unknown; i?: unknown } | null;
  if (
    !p ||
    typeof p.t !== 'number' ||
    !Number.isFinite(p.t) ||
    typeof p.i !== 'string' ||
    p.i.length === 0 ||
    p.i.length > 64
  ) {
    throw new BadRequestException({ code: ErrorCodes.INVALID_CURSOR, message: 'Invalid pagination cursor' });
  }
  return { t: p.t, i: p.i };
}

/**
 * Kondisi keyset WHERE untuk urutan (createdAt, id). `direction` harus
 * mencerminkan orderBy query pemanggil — desc: baris SETELAH kursor =
 * (createdAt < t) ATAU (createdAt = t DAN id < i); asc sebaliknya.
 */
function nestedKeysetWhere(cursor: NestedCursor, direction: NestedListDirection): object {
  const op = direction === 'desc' ? 'lt' : 'gt';
  const at = new Date(cursor.t);
  return {
    OR: [{ createdAt: { [op]: at } }, { createdAt: at, id: { [op]: cursor.i } }],
  };
}

// NP-008: diekspor murni untuk unit test (tidak dipakai modul lain).
export const __cursorTestHooks = { encodeNestedCursor, decodeNestedCursor, nestedKeysetWhere };

// NP-007: hook test untuk kontrak feed — `serializeShowcase` tidak memakai
// `this`, jadi bisa dipanggil lewat prototype tanpa DI.
export function __serializeForTest(
  row: Record<string, unknown>,
  options: { excerpt?: boolean; isOwner?: boolean } = {},
): Record<string, unknown> {
  return (ShowcaseService.prototype as unknown as {
    serializeShowcase: (r: unknown, o: unknown) => Record<string, unknown>;
  }).serializeShowcase(row, options);
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

  /**
   * BEC-01 (audit etalase 2026-10-10): enforcement moderasi yang MASIH AKTIF
   * per item — event TAKEDOWN/RESTRICTED terakhir yang belum disusul RESTORED
   * (banding diterima / restrict berakhir / restore admin). Satu query batch
   * untuk daftar pemilik; best-effort (null bila fragment moderasi belum ada).
   */
  private async getActiveEnforcementMap(showcaseIds: string[]): Promise<Map<string, ModerationEnforcement>> {
    const map = new Map<string, ModerationEnforcement>();
    if (showcaseIds.length === 0) return map;
    try {
      const mod = moderationDb(this.prisma);
      const events = (await mod.reportModerationEvent.findMany({
        where: { action: { in: ['TAKEDOWN', 'RESTRICTED', 'RESTORED'] }, report: { showcaseId: { in: showcaseIds } } },
        orderBy: { createdAt: 'desc' },
        select: { reportId: true, action: true, createdAt: true, note: true, metadata: true, report: { select: { showcaseId: true } } },
      })) as unknown as Array<{
        reportId: string;
        action: string;
        createdAt: Date;
        note: string | null;
        metadata: unknown;
        report?: { showcaseId: string } | null;
      }>;
      const seen = new Set<string>();
      for (const ev of events) {
        const sid = ev.report?.showcaseId;
        if (!sid || seen.has(sid)) continue;
        seen.add(sid);
        // Event terakhir RESTORED = enforcement sudah dicabut.
        if (ev.action !== 'TAKEDOWN' && ev.action !== 'RESTRICTED') continue;
        const meta = ev.metadata && typeof ev.metadata === 'object' ? (ev.metadata as Record<string, unknown>) : {};
        const until = typeof meta.restrictUntil === 'string' ? meta.restrictUntil : null;
        map.set(sid, { reportId: ev.reportId, action: ev.action, createdAt: ev.createdAt, note: ev.note ?? null, until });
      }
    } catch (err) {
      this.logger.warn(`getActiveEnforcementMap failed (best-effort): ${(err as Error).message}`);
    }
    return map;
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
   *
   * PERF-FIX BD-002: satu batch call — cache dibaca paralel, semua miss
   * di-load dengan SATU `findMany` via getBadgesBatch (bukan N getBadges
   * paralel yang masing-masing bisa memicu query DB).
   */
  private async getAuthorBadgeMap(userIds: string[]): Promise<Map<string, Array<{ type: string }>>> {
    const unique = [...new Set(userIds.filter(Boolean))];
    try {
      const batch = await this.verificationBadgeService.getBadgesBatch(unique);
      return new Map(
        unique.map(
          (userId) =>
            [userId, (batch.get(userId) ?? []).map((b) => ({ type: b.type }))] as [
              string,
              Array<{ type: string }>,
            ],
        ),
      );
    } catch {
      return new Map(unique.map((userId) => [userId, []] as [string, Array<{ type: string }>]));
    }
  }

  /**
   * Bentuk publik satu item showcase.
   *
   * Mode detail/owner: `orderLink` berisi data siap pakai untuk membuat
   * OrderLink dari item ini (title/description/orderValue/counterpartUsername
   * sudah ter-prefill) supaya tombol "Pesan" di layar detail tidak perlu
   * merakit apa pun lagi. Mode excerpt (feed): orderLink TIDAK dikirim
   * (D1-011) — diganti flag eksplisit `isCommerce` + `badges[]` (D1-001).
   */
  private serializeShowcase(
    row: ShowcaseRow,
    options: { isLiked?: boolean; isSaved?: boolean; isOwner?: boolean; authorBadges?: Array<{ type: string }>; followedAuthorIds?: Set<string>; excerpt?: boolean; bestsellerIds?: Set<string>; moderation?: ModerationEnforcement | null } = {},
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
    const orderValueValid = orderValue !== null && orderValue >= ORDER_MIN_VALUE && orderValue <= ORDER_MAX_VALUE;
    const counterpartUsername = row.user.username ?? row.user.userId;
    // D1-001/D1-011 (perf 2026-09-29): flag commerce EKSPLISIT — pengganti
    // pemicu lama "keberadaan orderLink" yang selalu truthy (orderLink selalu
    // diserialkan, jadi tiap kartu feed me-render CommerceBadgesCompact dan
    // menembak GET /v1/commerce/products/:id/badges). Badge commerce kini
    // diserialkan langsung di payload feed: TERLARIS dari SATU groupBy per
    // halaman (options.bestsellerIds), DISKON dari originalPriceValid yang
    // sudah dihitung di sini — N+1 badge hilang total.
    // Satuan: priceMin/priceMax = IDR, originalPrice = SEN (ditulis
    // ProductCommerceService via toSen). Bandingkan dalam sen — dulu mentah
    // (sen vs IDR) sehingga badge DISKON muncul untuk harga coret di bawah
    // harga jual (audit etalase 2026-10-10).
    const salePriceIdr = row.priceMin ?? row.priceMax;
    const originalPriceValid =
      row.originalPrice != null &&
      salePriceIdr != null &&
      row.originalPrice > BigInt(0) &&
      row.originalPrice > salePriceIdr * 100n;
    const commerceBadges: string[] = [];
    if (options.bestsellerIds?.has(row.id)) commerceBadges.push('TERLARIS');
    if (originalPriceValid) commerceBadges.push('DISKON');

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
      // NP-007 (perf-fix, 2026-09-29): field manajemen pemilik (visibility,
      // isActive, sortOrder item, updatedAt) TIDAK dikirim di feed (excerpt) —
      // kartu publik tidak memakainya; hanya ada di detail/owner response.
      // Alias deprecated `imageUrl` (= coverImageUrl) DIHAPUS — satu sumber
      // kebenaran gambar: `images[]` + `coverImageUrl`. Client lama yang masih
      // membaca `imageUrl` top-level harus migrasi ke `coverImageUrl`.
      ...(options.excerpt
        ? {}
        : {
            visibility: row.visibility,
            isActive: row.isActive,
            sortOrder: row.sortOrder,
            updatedAt: row.updatedAt,
          }),
      // Batch 19 TIM A (item 6): kondisi barang (BARU/BEKAS/null).
      // D1-011: kartu feed tidak merendernya — hanya di detail/owner.
      ...(options.excerpt ? {} : { condition: row.condition ?? null }),
      images,
      coverImageUrl,
      priceMin,
      priceMax,
      // Batch 43 commerce (item 1 & 10): tipe produk + harga coret diserialkan
      // publik supaya frontend (feed/detail) bisa render badge DISKON dan
      // logika per tipe (jasa → tenggat). Field sudah ada di DB sejak
      // migrasi 20261001000000; sebelumnya hanya bisa dibaca via
      // PATCH /v1/commerce/products/:id response. Additive-only.
      // D1-011 (2026-09-29): kartu feed tidak memakai field-field ini —
      // badge DISKON kini datang dari `badges[]` (D1-001). Hanya detail/owner.
      ...(options.excerpt
        ? {}
        : {
            productType: row.productType ?? null,
            // `originalPrice` dipertahankan apa adanya (SEN — kontrak lama
            // PATCH /v1/commerce/products/:id). `originalPriceIdr` (BE-1,
            // audit etalase 2026-10-10) = nilai IDR siap pakai, satuan sama
            // dengan priceMin/priceMax. Additive-only.
            originalPrice: toNumber(row.originalPrice ?? null),
            originalPriceIdr: row.originalPrice == null ? null : toIdr(row.originalPrice),
            originalPriceValid,
            serviceDeadlineDays: row.serviceDeadlineDays ?? null,
            // BE-1: field commerce yang hanya relevan untuk editor pemilik —
            // dulu cuma bisa dibaca dari respons PATCH, jadi editor Kelola
            // Etalase memprefill default kosong dan menimpanya saat simpan.
            ...(options.isOwner
              ? {
                  digitalDeliveryInfo: row.digitalDeliveryInfo ?? null,
                  scheduledAt: row.scheduledAt ?? null,
                }
              : {}),
            // BEC-01 (audit etalase 2026-10-10): pemilik tahu itemnya
            // dinonaktifkan MODERASI (bukan olehnya) — klien menyembunyikan
            // "Aktifkan etalase" dan menampilkan notice + arah banding.
            // Nama field mengikuti resolver klien (lib/showcase-moderation.ts).
            ...(options.isOwner && options.moderation
              ? {
                  moderationStatus: options.moderation.action,
                  moderationReason: options.moderation.note,
                  moderatedAt: options.moderation.createdAt,
                  moderationReportId: options.moderation.reportId,
                  moderationUntil: options.moderation.until,
                }
              : {}),
          }),
      likeCount: row.likeCount,
      commentCount: row.commentCount,
      // D1-011: viewCount/shareCount tidak dirender kartu feed — hanya detail.
      ...(options.excerpt
        ? {}
        : {
            viewCount: row.viewCount,
            // S-4: berapa kali deep link share item ini dibuka.
            shareCount: row.shareCount,
          }),
      // Batch 19 TIM A (item 3): save counter + status save viewer.
      saveCount: row.saveCount,
      isLiked: Boolean(options.isLiked),
      isSaved: Boolean(options.isSaved),
      isOwner: Boolean(options.isOwner),
      createdAt: row.createdAt,
      // NP-007: updatedAt juga field manajemen — hanya di detail/owner.
      ...(options.excerpt ? {} : { updatedAt: row.updatedAt }),
      author: {
        // NB: userId TETAP dikirim di excerpt — parser frontend
        // (parseShowcaseItem) menjadikannya syarat validasi item.
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
      // D1-001 (perf 2026-09-29): badge commerce dari payload feed —
      // frontend tidak lagi N+1 GET /v1/commerce/products/:id/badges.
      // Selalu array (bisa kosong) supaya klien lama/baru konsisten.
      badges: commerceBadges,
      // D1-011: flag commerce EKSPLISIT — pengganti pemicu lama "orderLink
      // ada" di CommerceBadgesCompact. true = harga valid & bisa dipesan.
      isCommerce: orderValueValid,
      // D1-011 (2026-09-29): orderLink+shareUrl tidak dipakai kartu feed —
      // prefill transaksi hanya dipakai layar detail (non-excerpt). Payload
      // feed menghemat ~600 byte/item (title+description duplikat).
      ...(options.excerpt
        ? {}
        : {
            orderLink: {
              title: row.title.slice(0, 100),
              description: orderDescription,
              orderValue,
              orderValueValid,
              counterpartUsername,
            },
            shareUrl: this.buildShareUrl(row.id),
          }),
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

    const enforcement = await this.getActiveEnforcementMap(items.map((item) => item.id));
    return {
      items: items.map((item) => this.serializeShowcase(item, { isOwner: true, moderation: enforcement.get(item.id) ?? null })),
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
    // BES-03 (audit etalase 2026-10-10): validasi key TANPA consume — bila
    // batas 20 item menolak di bawah, konfirmasi upload tidak hangus (dulu
    // pengguna harus unggah ulang semua foto setelah ditolak).
    const mediaEntries = dto.media !== undefined
      ? await this.prepareMediaEntries(userId, dto.media, { consume: false })
      : null;
    const imageFileKeys = dto.media !== undefined
      ? []
      : await this.prepareImageKeys(userId, dto.imageFileKeys, { consume: false });

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

      // BES-03: consume SETELAH item tersimpan (pola yang sama dengan update).
      const consumeKeys = dto.media !== undefined
        ? [...new Set(dto.media.flatMap((m) => [m.fileKey, m.thumbnailFileKey].filter((k): k is string => Boolean(k))))]
        : (dto.imageFileKeys ?? []);
      if (consumeKeys.length > 0) await this.uploadService.consumeUploadConfirmations(userId, consumeKeys);

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
    // BEC-01 (audit etalase 2026-10-10): item yang dinonaktifkan MODERASI
    // (takedown/restrict) tidak boleh diaktifkan ulang pemilik lewat
    // isActive:true — dulu menu "Aktifkan etalase" membalikkan takedown.
    if (dto.isActive === true && !existing.isActive) {
      const enforcement = await this.findModerationEnforcement(itemId);
      if (enforcement) {
        throw new ForbiddenException({
          code: ErrorCodes.SHOWCASE_MODERATED,
          message: 'Etalase ini dinonaktifkan oleh moderasi Kahade dan tidak bisa diaktifkan sendiri. Ajukan banding lewat laporan terkait.',
          reportId: enforcement.reportId,
        });
      }
    }
    // BES-02: berkas lama dibersihkan SETELAH update DB sukses (dulu
    // dijadwalkan sebelum update → update gagal = media hilang).
    let cleanupKeys: string[] = [];

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
      cleanupKeys = removedKeys;
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
      // PERF-FIX (NP-001): hapus thumbnail foto lama juga — jangan yatim.
      const removedKeys = existing.images.flatMap((image) =>
        [image.fileKey, image.thumbnailUrl ? this.uploadService.fileKeyFromPublicUrl(image.thumbnailUrl) : null].filter(
          (k): k is string => Boolean(k),
        ),
      );
      data.images = {
        deleteMany: {},
        create: imageFileKeys.map((image, index) => ({
          imageUrl: image.imageUrl,
          fileKey: image.fileKey,
          sortOrder: index,
        })),
      };
      cleanupKeys = removedKeys;
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
    // BES-02: object lama dibersihkan setelah commit (fire-and-forget).
    if (cleanupKeys.length > 0) this.scheduleImageCleanup(userId, cleanupKeys);

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
  async restoreShowcaseItem(userId: string, itemId: string): Promise<{ message: string; alreadyRestored?: boolean }> {
    // BE-4 (audit etalase 2026-10-10): restore idempoten — item sudah aktif
    // (dipulihkan dari perangkat lain / ketuk ganda) → 200, bukan 404 yang
    // membuat klien menampilkan "Gagal memulihkan" untuk keadaan yang benar.
    const alreadyLive = await this.prisma.userShowcase.findFirst({
      where: { id: itemId, userId, deletedAt: null },
      select: { id: true },
    });
    if (alreadyLive) return { message: 'Etalase sudah aktif.', alreadyRestored: true };
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
        // PERF-FIX (NP-001): thumbnail foto server-side (sharp, ~640px)
        // — opsional untuk kompatibilitas mundur (foto lama tidak punya).
        // Bila dikirim, wajib confirmed SHOWCASE_IMAGE milik user (verifikasi
        // di bawah via thumbKeys, sama seperti thumbnail video).
        if (entry.thumbnailFileKey) thumbKeys.push(entry.thumbnailFileKey);
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
      // Video WAJIB thumbnail; image opsional (PERF-FIX NP-001 — thumbnail
      // foto server-side; spin360 tidak pakai thumbnail).
      if ((entry.kind === ShowcaseMediaKind.VIDEO || entry.kind === ShowcaseMediaKind.IMAGE) && entry.thumbnailFileKey) {
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

  async attachImages(
    userId: string,
    itemId: string,
    fileKeys: string[],
    thumbnails?: Record<string, string>,
  ): Promise<object> {
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

    // PERF-FIX (NP-001): sanitasi peta thumbnail — hanya untuk fileKey yang
    // memang dilampirkan, thumbnail tidak boleh sama dengan fileKey gambar
    // itu sendiri, dan satu thumbnail tidak dipakai dua gambar (fail closed).
    const thumbByFileKey = new Map<string, string>();
    if (thumbnails && typeof thumbnails === 'object') {
      const seenThumbKeys = new Set<string>();
      for (const [imgKey, thumbKey] of Object.entries(thumbnails)) {
        if (typeof imgKey !== 'string' || typeof thumbKey !== 'string' || thumbKey.length === 0) continue;
        if (!fileKeys.includes(imgKey)) continue;
        if (fileKeys.includes(thumbKey)) {
          throw new BadRequestException({
            code: ErrorCodes.SHOWCASE_INVALID_MEDIA,
            message: 'thumbnailFileKey tidak boleh sama dengan fileKey gambar',
          });
        }
        if (seenThumbKeys.has(thumbKey)) {
          throw new BadRequestException({
            code: ErrorCodes.SHOWCASE_INVALID_MEDIA,
            message: 'Satu thumbnail tidak boleh dipakai untuk dua gambar',
          });
        }
        seenThumbKeys.add(thumbKey);
        thumbByFileKey.set(imgKey, thumbKey);
      }
    }
    const thumbKeys = [...thumbByFileKey.values()];

    // SH-B-006: validasi dulu TANPA consume (pola sama seperti SH-B-007);
    // konfirmasi one-time baru di-consume SETELAH transaksi sukses — bila
    // cek otoritatif di dalam transaksi gagal (balapan), file tidak yatim
    // dan user tidak perlu upload ulang.
    const prepared = await this.prepareImageKeys(userId, fileKeys, { consume: false });
    if (prepared.length === 0) {
      throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'fileKeys must not be empty' });
    }
    // Thumbnail = confirmed SHOWCASE_IMAGE milik user (pola sama seperti
    // thumbnail video di prepareMediaEntries).
    if (thumbKeys.length > 0) {
      await this.uploadService.verifyUserFileKeys(userId, thumbKeys, UploadPurpose.SHOWCASE_IMAGE, {
        maxFiles: maxImages,
        consume: false,
        label: 'Showcase image thumbnail',
      });
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
        data: prepared.map((image, index) => {
          // PERF-FIX (NP-001): simpan thumbnail foto bila dikirim.
          const thumbKey = thumbByFileKey.get(image.fileKey);
          return {
            showcaseId: itemId,
            imageUrl: image.imageUrl,
            fileKey: image.fileKey,
            thumbnailUrl: thumbKey ? this.uploadService.buildPublicUrl(thumbKey) : null,
            sortOrder: nextSortOrder + index,
          };
        }),
      });
    });

    // SH-B-006: consume SETELAH createMany sukses. Bila consume gagal
    // (sangat jarang — balapan double-submit), baris gambar sudah benar di
    // DB; key yang tersisa kedaluwarsa sendiri via TTL konfirmasi.
    // PERF-FIX (NP-001): consume thumbnail foto juga — jangan sisakan key
    // terkonfirmasi yang bisa dipakai ulang.
    await this.uploadService.consumeUploadConfirmations(userId, [...fileKeys, ...thumbKeys]);

    return { added: created.count, images: await this.listImages(itemId) };
  }

  async removeImage(userId: string, imageId: string): Promise<{ message: string }> {
    const image = await this.prisma.showcaseImage.findFirst({
      where: { id: imageId, showcase: { userId } },
      select: { id: true, fileKey: true, thumbnailUrl: true, showcaseId: true },
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
    if (image.fileKey) {
      // PERF-FIX (NP-001): hapus thumbnail foto juga — jangan sisakan yatim.
      const thumbKey = image.thumbnailUrl ? this.uploadService.fileKeyFromPublicUrl(image.thumbnailUrl) : null;
      this.scheduleImageCleanup(userId, [image.fileKey, thumbKey].filter((k): k is string => Boolean(k)));
    }
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
    // BES-17 (audit etalase 2026-10-10): tayangan PEMILIK tidak pernah dihitung
    // (dulu hanya preview item nonaktif yang dikecualikan → angka view
    // menggelembung tiap pemilik membuka detailnya sendiri).
    const shouldCountView = !visible.isOwner;
    const counted = shouldCountView ? await this.recordView(showcaseId, viewerId, options.clientIp) : false;
    const likedIds = await this.getLikedShowcaseIds(viewerId, [showcaseId]);
    const savedIds = await this.getSavedShowcaseIds(viewerId, [showcaseId]);
    const badgeMap = await this.getAuthorBadgeMap([visible.row.user.id]);
    // BEC-01: notice moderasi hanya untuk pemilik (detail item sendiri).
    const moderation = visible.isOwner ? (await this.getActiveEnforcementMap([showcaseId])).get(showcaseId) ?? null : null;

    return {
      ...this.serializeShowcase(visible.row, {
        isLiked: likedIds.has(showcaseId),
        isSaved: savedIds.has(showcaseId),
        moderation,
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
    // B1-013 (perf): tulis DB fire-and-forget — 2 round-trip keluar dari
    // request path. Kehilangan sedikit count saat crash = acceptable (metrik).
    // Dedupe Redis di atas TETAP di-await karena hasilnya dipakai respons
    // (viewCount optimistis +1).
    const writes = (async () => {
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
    })().catch((error) => {
      this.logger.warn(
        `recordView: tulis DB gagal untuk showcase=${showcaseId}: ${(error as Error)?.message ?? error}`,
      );
    });
    void writes;
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

    // B1-001 (perf): `now` dibulatkan ke bucket 15 menit supaya skor yang
    // dihitung ulang antar-request identik bit-per-bit (syarat keyset
    // in-memory tetap valid bila halaman 2 diminta beberapa menit setelah
    // halaman 1). Dihitung DI SINI (bukan setelah fetch pool) supaya jadi
    // bagian dari cache key pool.
    const nowBucket =
      Math.floor(Date.now() / SHOWCASE_FOR_YOU_SCORE_TIME_BUCKET_MS) *
      SHOWCASE_FOR_YOU_SCORE_TIME_BUCKET_MS;

    // B1-001 (perf): cache merged candidate pool per (viewerId, filter hash,
    // bucket skor), TTL 15 menit. Pool hanya fungsi dari filter + sinyal;
    // sinyal per viewer di-cache terpisah (TTL 10 mnt) di getForYouSignals.
    // Skor DIHITUNG ULANG dari pool yang sama persis tiap request — ranking
    // dan hasil TIDAK berubah, hanya query DB yang dihemat.
    const filterHash = createHash('sha256')
      .update(stableStringify({ baseWhere, andClauses }))
      .digest('hex')
      .slice(0, 32);
    const poolCacheKey = `showcase:foryou:pool:${viewerId}:${filterHash}:${nowBucket}`;

    let merged = await this.getCachedForYouPool(poolCacheKey);
    if (!merged) {
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

      merged = new Map<string, ShowcaseRow>();
      for (const row of [...affinityRows, ...followedRows, ...recentRows]) {
        if (!merged.has(row.id)) merged.set(row.id, row);
      }
      await this.setCachedForYouPool(poolCacheKey, [...merged.values()]);
    }

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
   *
   * B1-001 (perf): hasil di-cache 10 menit di Redis — 2 query sinyal tidak
   * lagi diulang tiap halaman feed. Redis down -> fail-open (hitung ulang).
   */
  private async getForYouSignals(viewerId: string): Promise<ForYouSignals> {
    const cacheKey = `showcase:foryou:signals:${viewerId}`;
    try {
      const cached = await this.redis.get(cacheKey);
      if (cached) {
        const parsed = JSON.parse(cached) as { cats: [string, number][]; followed: string[] };
        return {
          categoryAffinity: new Map(parsed.cats),
          followedSellerIds: new Set(parsed.followed),
        };
      }
    } catch (error) {
      // Fail-open: Redis down / cache corrupt -> hitung ulang seperti biasa.
      this.logger.warn(
        `getForYouSignals: cache miss/error untuk viewer=${viewerId}: ${(error as Error)?.message ?? error}`,
      );
    }
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
    const signals: ForYouSignals = {
      categoryAffinity,
      followedSellerIds: new Set(follows.map((f) => f.followingId)),
    };
    await this.redis.set(
      cacheKey,
      JSON.stringify({
        cats: [...categoryAffinity.entries()],
        followed: [...signals.followedSellerIds],
      }),
      SHOWCASE_FOR_YOU_SIGNALS_CACHE_TTL_SECONDS,
    ).catch((error) => {
      this.logger.warn(`getForYouSignals: tulis cache gagal: ${(error as Error)?.message ?? error}`);
    });
    return signals;
  }

  /**
   * B1-001 (perf): baca merged candidate pool dari Redis. `null` bila miss /
   * corrupt / Redis down (fail-open — pemanggil fetch ulang dari DB).
   * Serialisasi aman untuk Date & bigint via json-cache.util.
   */
  private async getCachedForYouPool(cacheKey: string): Promise<Map<string, ShowcaseRow> | null> {
    try {
      const cached = await this.redis.get(cacheKey);
      if (!cached) return null;
      const rows = fromStorable<ShowcaseRow[]>(JSON.parse(cached));
      const merged = new Map<string, ShowcaseRow>();
      for (const row of rows) merged.set(row.id, row);
      return merged;
    } catch (error) {
      this.logger.warn(`getForYouFeed: pool cache miss/error: ${(error as Error)?.message ?? error}`);
      return null;
    }
  }

  /** B1-001 (perf): tulis merged candidate pool ke Redis (fail-open). */
  private async setCachedForYouPool(cacheKey: string, rows: ShowcaseRow[]): Promise<void> {
    try {
      await this.redis.set(
        cacheKey,
        JSON.stringify(toStorable(rows)),
        SHOWCASE_FOR_YOU_POOL_CACHE_TTL_SECONDS,
      );
    } catch (error) {
      this.logger.warn(`getForYouFeed: tulis pool cache gagal: ${(error as Error)?.message ?? error}`);
    }
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
    // D1-001 (perf 2026-09-29): badge TERLARIS dihitung batch per halaman —
    // SATU groupBy order COMPLETED 90 hari, bukan N+1 per kartu.
    const bestsellerIds = await this.getBestsellerIds(pageRows.map((row) => row.id));

    return {
      items: pageRows.map((row) =>
        this.serializeShowcase(row, {
          isLiked: likedIds.has(row.id),
          isSaved: savedIds.has(row.id),
          authorBadges: badgeMap.get(row.user.id) ?? [],
          followedAuthorIds,
          bestsellerIds,
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
   * D1-001 (perf 2026-09-29): id showcase yang berhak atas badge TERLARIS —
   * SATU query `groupBy` order COMPLETED dalam 90 hari terakhir untuk satu
   * halaman feed, menggantikan N request ke
   * GET /v1/commerce/products/:id/badges (yang tiap request-nya 2 query).
   * Ambang & jendela waktu memakai konstanta yang SAMA dengan endpoint
   * badges (BEST_SELLER_MIN_COMPLETED / BEST_SELLER_WINDOW_DAYS) supaya
   * definisi "terlaris" tidak drift.
   */
  private async getBestsellerIds(showcaseIds: string[]): Promise<Set<string>> {
    const unique = [...new Set(showcaseIds.filter((id) => id))];
    if (unique.length === 0) return new Set();
    const since = new Date(Date.now() - BEST_SELLER_WINDOW_DAYS * 24 * 60 * 60 * 1000);
    const groups = await this.prisma.order.groupBy({
      by: ['showcaseId'],
      where: {
        showcaseId: { in: unique },
        status: OrderStatus.COMPLETED,
        deletedAt: null,
        completedAt: { gte: since },
      },
      _count: { _all: true },
    });
    return new Set(
      groups
        .filter((g) => g.showcaseId && g._count._all >= BEST_SELLER_MIN_COMPLETED)
        .map((g) => g.showcaseId as string),
    );
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
          // RK-01/BES-01: state akhir → klien menulis lokal tanpa GET detail
          // (yang menaikkan viewCount). Diteruskan filter sebagai errors.data.
          data: { liked: true, likeCount: current?.likeCount ?? null },
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
          data: { saved: true, saveCount: current?.saveCount ?? null },
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
    cursor?: string,
  ): Promise<object> {
    const visible = await this.findVisibleShowcase(showcaseId, viewerId);
    if (!visible) {
      throw new NotFoundException({ code: ErrorCodes.SHOWCASE_NOT_FOUND, message: 'Showcase item not found' });
    }
    const safePage = Number.isFinite(page) ? Math.max(1, Math.floor(page)) : 1;
    const safeLimit = Number.isFinite(limit) ? Math.min(Math.max(1, Math.floor(limit)), 100) : 20;
    // NP-008 (perf-fix): keyset cursor bila diminta — tanpa `skip` besar.
    // Tanpa cursor: perilaku offset lama (kompatibel mundur).
    const decoded = cursor ? decodeNestedCursor(cursor) : null;
    const baseWhere = { showcaseId };
    const where = decoded ? { ...baseWhere, ...nestedKeysetWhere(decoded, 'desc') } : baseWhere;
    const take = decoded ? safeLimit + 1 : safeLimit;
    const [rows, total] = await Promise.all([
      this.prisma.showcaseLike.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        ...(decoded ? {} : { skip: (safePage - 1) * safeLimit }),
        take,
        select: {
          id: true,
          createdAt: true,
          user: { select: { id: true, userId: true, username: true, fullName: true, avatarUrl: true } },
        },
      }),
      this.prisma.showcaseLike.count({ where: baseWhere }),
    ]);
    const pageRows = decoded && rows.length > safeLimit ? rows.slice(0, safeLimit) : rows;
    const hasMore = decoded
      ? rows.length > safeLimit
      : safePage * safeLimit < total;
    const nextCursor =
      hasMore && pageRows.length > 0
        ? encodeNestedCursor(pageRows[pageRows.length - 1].createdAt, pageRows[pageRows.length - 1].id)
        : null;
    const data = pageRows.map((row) => ({
      userId: row.user.userId,
      username: row.user.username,
      fullName: row.user.fullName,
      avatarUrl: row.user.avatarUrl,
      likedAt: row.createdAt,
    }));
    return {
      ...createPaginatedResponse(data, total, safePage, safeLimit),
      // NP-008: `hasNext` dikoreksi untuk mode cursor (page selalu 1 di
      // mode itu); `nextCursor` selalu dikembalikan bila ada lanjutan —
      // client boleh mulai dari offset lalu beralih ke cursor.
      hasNext: hasMore,
      nextCursor,
    };
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
    cursor?: string,
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
    // NP-008 (perf-fix): keyset cursor bila diminta — tanpa `skip` besar.
    const decoded = cursor ? decodeNestedCursor(cursor) : null;
    const baseWhere = { showcaseId };
    const where = decoded ? { ...baseWhere, ...nestedKeysetWhere(decoded, 'desc') } : baseWhere;
    const take = decoded ? safeLimit + 1 : safeLimit;
    const [rows, total] = await Promise.all([
      this.prisma.showcaseSave.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        ...(decoded ? {} : { skip: (safePage - 1) * safeLimit }),
        take,
        select: {
          id: true,
          createdAt: true,
          user: { select: { id: true, userId: true, username: true, fullName: true, avatarUrl: true } },
        },
      }),
      this.prisma.showcaseSave.count({ where: baseWhere }),
    ]);
    const pageRows = decoded && rows.length > safeLimit ? rows.slice(0, safeLimit) : rows;
    const hasMore = decoded
      ? rows.length > safeLimit
      : safePage * safeLimit < total;
    const nextCursor =
      hasMore && pageRows.length > 0
        ? encodeNestedCursor(pageRows[pageRows.length - 1].createdAt, pageRows[pageRows.length - 1].id)
        : null;
    const data = pageRows.map((row) => ({
      userId: row.user.userId,
      username: row.user.username,
      fullName: row.user.fullName,
      avatarUrl: row.user.avatarUrl,
      savedAt: row.createdAt,
    }));
    return {
      ...createPaginatedResponse(data, total, safePage, safeLimit),
      hasNext: hasMore,
      nextCursor,
    };
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
    cursor?: string,
  ): Promise<object> {
    const safePage = Number.isFinite(page) ? Math.max(1, Math.floor(page)) : 1;
    const safeLimit = Number.isFinite(limit) ? Math.min(Math.max(1, Math.floor(limit)), 100) : 20;
    // NP-008 (perf-fix): keyset cursor bila diminta — tanpa `skip` besar.
    const decoded = cursor ? decodeNestedCursor(cursor) : null;
    const baseWhere = { userId };
    const where = decoded ? { ...baseWhere, ...nestedKeysetWhere(decoded, 'desc') } : baseWhere;
    const take = decoded ? safeLimit + 1 : safeLimit;
    const [rows, total] = await Promise.all([
      this.prisma.showcaseSave.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        ...(decoded ? {} : { skip: (safePage - 1) * safeLimit }),
        take,
        include: { showcase: { include: SHOWCASE_INCLUDE } },
      }),
      this.prisma.showcaseSave.count({ where: baseWhere }),
    ]);
    const pageRows = decoded && rows.length > safeLimit ? rows.slice(0, safeLimit) : rows;
    const hasMore = decoded
      ? rows.length > safeLimit
      : safePage * safeLimit < total;
    const nextCursor =
      hasMore && pageRows.length > 0
        ? encodeNestedCursor(pageRows[pageRows.length - 1].createdAt, pageRows[pageRows.length - 1].id)
        : null;
    const showcaseRows = pageRows.map((row) => row.showcase) as unknown as ShowcaseRow[];
    const likedIds = await this.getLikedShowcaseIds(userId, showcaseRows.map((row) => row.id));
    const badgeMap = await this.getAuthorBadgeMap(showcaseRows.map((row) => row.user.id));
    const items = showcaseRows.map((item, index) => {
      const isOwner = item.user.id === userId;
      // BES-05 (audit etalase 2026-10-10): item yang sudah dihapus / privat /
      // nonaktif (bukan milik sendiri) TIDAK dikirim sebagai kartu penuh —
      // dulu koleksi "Tersimpan" membocorkan judul/foto item yang pemiliknya
      // sudah sembunyikan. Klien menampilkan "tidak tersedia" / membersihkan.
      const unavailable =
        item.deletedAt != null || (!isOwner && (!item.isActive || item.visibility !== ShowcaseVisibility.PUBLIC));
      if (unavailable) return { id: item.id, unavailable: true, savedAt: pageRows[index].createdAt };
      return {
        ...this.serializeShowcase(item, {
          isLiked: likedIds.has(item.id),
          isSaved: true,
          isOwner,
          authorBadges: badgeMap.get(item.user.id) ?? [],
        }),
        savedAt: pageRows[index].createdAt,
      };
    });
    return {
      ...createPaginatedResponse(items, total, safePage, safeLimit),
      hasNext: hasMore,
      nextCursor,
    };
  }


  // ==================================================================
  // Komentar
  // ==================================================================

  /**
   * Daftar komentar ber-nesting (root + balasan satu tingkat).
   *
   * NP-008 (perf-fix): mendukung keyset cursor (`?cursor=`) — tanpa `skip`
   * besar. Tanpa cursor, offset lama tetap dipakai (kompatibel mundur);
   * tiebreak { id } menjaga halaman stabil. Komentar tersembunyi disaring,
   * kecuali untuk pemilik showcase yang memang perlu melihat apa yang ia
   * sembunyikan.
   */
  async listComments(showcaseId: string, viewerId: string | undefined, page: number, limit: number, sort: 'newest' | 'oldest' = 'newest', cursor?: string): Promise<object> {
    const visible = await this.findVisibleShowcase(showcaseId, viewerId);
    if (!visible) {
      throw new NotFoundException({ code: ErrorCodes.SHOWCASE_NOT_FOUND, message: 'Showcase item not found' });
    }

    const safePage = Number.isFinite(page) ? Math.max(1, Math.floor(page)) : 1;
    const safeLimit = Number.isFinite(limit) ? Math.min(Math.max(1, Math.floor(limit)), 50) : 20;
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
    const baseWhere: Prisma.ShowcaseCommentWhereInput = {
      showcaseId,
      parentId: null,
      user: authorFilter,
      ...(visible.isOwner ? {} : { isHidden: false }),
      // FAL-027 (audit 2026-10-03): komentar yang di-soft-delete disembunyikan
      // dari daftar publik — KECUALI root yang masih punya balasan yang
      // tampil; parent-nya diserialkan sebagai placeholder "komentar dihapus"
      // agar thread balasan tidak yatim.
      OR: [
        { deletedAt: null },
        {
          deletedAt: { not: null },
          replies: {
            some: {
              deletedAt: null,
              user: authorFilter,
              ...(visible.isOwner ? {} : { isHidden: false }),
            },
          },
        },
      ],
    };
    // NP-008 (perf-fix): keyset cursor bila diminta — tanpa `skip` besar.
    // Arah keyset mengikuti rootOrder (newest=desc, oldest=asc).
    const decoded = cursor ? decodeNestedCursor(cursor) : null;
    const where: Prisma.ShowcaseCommentWhereInput = decoded
      ? { ...baseWhere, ...nestedKeysetWhere(decoded, rootOrder) }
      : baseWhere;
    const take = decoded ? safeLimit + 1 : safeLimit;

    const [rootRows, total] = await Promise.all([
      this.prisma.showcaseComment
        .findMany({
          where,
          orderBy: [{ createdAt: rootOrder }, { id: rootOrder }],
          ...(decoded ? {} : { skip: (safePage - 1) * safeLimit }),
          take,
          include: COMMENT_INCLUDE,
        })
        .then((rows) => rows as unknown as CommentRow[]),
      this.prisma.showcaseComment.count({ where: baseWhere }),
    ]);
    // NP-008: potong baris probe (+1) di mode cursor.
    const roots = decoded && rootRows.length > safeLimit ? rootRows.slice(0, safeLimit) : rootRows;
    const hasMore = decoded
      ? rootRows.length > safeLimit
      : safePage * safeLimit < total;
    const nextCursor =
      hasMore && roots.length > 0
        ? encodeNestedCursor(roots[roots.length - 1].createdAt, roots[roots.length - 1].id)
        : null;

    // S-3: Balasan diambil per root dengan batas SHOWCASE_REPLY_LIMIT supaya satu
    // root viral tidak menghasilkan response raksasa. replyCount total tiap root
    // tetap akurat via groupBy. Query per root tetap ringan (indexed by parentId)
    // dan hanya dijalankan untuk root yang memang punya balasan.
    const rootIds = roots.map((root) => root.id);
    const replyWhere: Prisma.ShowcaseCommentWhereInput = {
      // FAL-027: balasan yang di-soft-delete tidak pernah tampil (tidak ada
      // placeholder untuk balasan).
      deletedAt: null,
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
    // BE-8: badge penulis komentar — satu batch (cache Redis per user).
    const commentBadgeMap = await this.getAuthorBadgeMap(Array.from(authorIds));

    // BFE-117/FAL-009: ringkasan reaksi untuk semua komentar yang tampil
    // (roots + replies) dalam 2 query batch.
    const allCommentIds = roots.flatMap((root) => [
      root.id,
      ...(repliesByParent.get(root.id) ?? []).map((reply) => reply.id),
    ]);
    const { counts: reactionCounts, userVotes } = await this.getCommentReactionMaps(allCommentIds, viewerId);

    // (2026-10-05: serializeComment bisa kembalikan null untuk user rusak —
    // filter agar tidak meruntuhkan response.)
    const data = roots.flatMap((root) => {
      const serialized = this.serializeComment(
        root as CommentRow,
        sealTierMap,
        this.reactionSummaryFor(root.id, reactionCounts, userVotes),
        commentBadgeMap,
      );
      if (!serialized) return [];
      return [{
        ...serialized,
        replyCount: replyCountByParent.get(root.id) ?? 0,
        replies: (repliesByParent.get(root.id) ?? []).flatMap((reply) => {
          const s = this.serializeComment(reply, sealTierMap, this.reactionSummaryFor(reply.id, reactionCounts, userVotes), commentBadgeMap);
          return s ? [s] : [];
        }),
      }];
    });

    const totalPages = Math.ceil(total / safeLimit);
    return {
      data,
      total,
      page: safePage,
      limit: safeLimit,
      totalPages,
      // NP-008: `hasNext` dikoreksi untuk mode cursor (page selalu 1 di mode
      // itu); `nextCursor` selalu dikembalikan bila ada lanjutan.
      hasNext: hasMore,
      // NP-008: paginasi cursor hanya maju — hasPrev false di mode cursor.
      hasPrev: decoded ? false : safePage > 1,
      nextCursor,
      // Batch 139 BE-API1 (item 103): gema sort yang dipakai (additive).
      sort: sort === 'oldest' ? 'oldest' : 'newest',
    };
  }

  /**
   * Audit 2026-10-03 (BFE-117/FAL-009, FAL-027): serializer komentar memuat
   * ringkasan reaksi (likes/dislikes/userVote) + penanda soft-delete.
   * Komentar yang di-soft-delete diserialkan sebagai placeholder ("komentar
   * dihapus"): content=null agar thread balasan tidak yatim.
   */
  private serializeComment(
    row: CommentRow,
    sealTierMap?: Map<string, string | null>,
    reactions?: { likes: number; dislikes: number; userVote: number },
    badgeMap?: Map<string, Array<{ type: string }>>,
  ): Record<string, unknown> | null {
    // (2026-10-05: defensif — user yang hilang/rusak tidak boleh meruntuhkan
    // seluruh response; kembalikan null agar pemanggil bisa melewatinya.)
    if (!row.user) return null
    const isDeleted = row.deletedAt != null;
    return {
      id: row.id,
      showcaseId: row.showcaseId,
      parentId: row.parentId,
      // 2026-10-03: jangan kirim null — frontend parser membutuhkan string.
      // Komentar yang dihapus tampil sebagai placeholder.
      content: isDeleted ? "[Komentar dihapus]" : row.content,
      isDeleted,
      isHidden: row.isHidden,
      hiddenReason: row.isHidden ? row.hiddenReason : null,
      likes: reactions?.likes ?? 0,
      dislikes: reactions?.dislikes ?? 0,
      userVote: reactions?.userVote ?? 0,
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
        // BE-8 (audit etalase 2026-10-10): badge verifikasi penulis komentar —
        // kontrak yang sama dengan author etalase (feed/detail).
        badges: badgeMap?.get(row.user.id) ?? [],
      },
    };
  }

  /**
   * Audit 2026-10-03 (BFE-117/FAL-009): agregat reaksi untuk sekumpulan
   * komentar dalam 2 query (tanpa N+1): groupBy hitungan per value + vote
   * viewer sendiri.
   */
  private async getCommentReactionMaps(
    commentIds: string[],
    viewerId?: string,
  ): Promise<{
    counts: Map<string, { likes: number; dislikes: number }>;
    userVotes: Map<string, number>;
  }> {
    const counts = new Map<string, { likes: number; dislikes: number }>();
    const userVotes = new Map<string, number>();
    if (commentIds.length === 0) return { counts, userVotes };
    const rows = await this.prisma.showcaseCommentReaction.groupBy({
      by: ['commentId', 'value'],
      where: { commentId: { in: commentIds } },
      _count: { _all: true },
    });
    for (const row of rows) {
      const entry = counts.get(row.commentId) ?? { likes: 0, dislikes: 0 };
      if (row.value === 1) entry.likes = row._count._all;
      else if (row.value === -1) entry.dislikes = row._count._all;
      counts.set(row.commentId, entry);
    }
    if (viewerId) {
      const mine = await this.prisma.showcaseCommentReaction.findMany({
        where: { commentId: { in: commentIds }, userId: viewerId },
        select: { commentId: true, value: true },
      });
      for (const r of mine) userVotes.set(r.commentId, r.value);
    }
    return { counts, userVotes };
  }

  private reactionSummaryFor(
    commentId: string,
    counts: Map<string, { likes: number; dislikes: number }>,
    userVotes: Map<string, number>,
  ): { likes: number; dislikes: number; userVote: number } {
    const c = counts.get(commentId) ?? { likes: 0, dislikes: 0 };
    return { likes: c.likes, dislikes: c.dislikes, userVote: userVotes.get(commentId) ?? 0 };
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
        // FAL-027: parent yang di-soft-delete dianggap tidak ada.
        where: { id: dto.parentId, showcaseId, deletedAt: null },
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
    const result = this.serializeComment(created, sealTierMap);
    if (!result) throw new InternalServerErrorException('Gagal serialisasi komentar');
    return result;
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
      select: { id: true, userId: true, isHidden: true, deletedAt: true },
    });
    if (!existing || existing.deletedAt) {
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
    const { counts: reactionCounts, userVotes } = await this.getCommentReactionMaps([updated.id], userId);
    const result = this.serializeComment(updated, sealTierMap, this.reactionSummaryFor(updated.id, reactionCounts, userVotes));
    if (!result) throw new InternalServerErrorException('Gagal serialisasi komentar');
    return result;
  }

  /**
   * Audit 2026-10-03 (FAL-027): hapus komentar = SOFT-DELETE — set
   * deletedAt/deletedBy/deleteReason, JANGAN hapus balasan. Parent yang
   * dihapus tampil sebagai placeholder "komentar dihapus" selama masih punya
   * balasan yang tampil (lihat listComments). Komentar yang sedang hidden
   * tidak mengubah commentCount (sudah dikurangi saat di-hide).
   */
  async deleteComment(userId: string, commentId: string, reason?: string): Promise<{ message: string; commentCount?: number | null }> {
    const existing = await this.prisma.showcaseComment.findUnique({
      where: { id: commentId },
      select: { id: true, userId: true, showcaseId: true, parentId: true, isHidden: true, deletedAt: true },
    });
    if (!existing || existing.deletedAt) {
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
      await tx.showcaseComment.update({
        where: { id: commentId },
        data: {
          deletedAt: new Date(),
          deletedBy: userId,
          deleteReason: reason?.trim() ? reason.trim().slice(0, 500) : null,
        },
      });
      // commentCount hanya menghitung komentar yang tampil. Yang sedang hidden
      // sudah dikurangi saat di-hide; balasan TIDAK ikut terhapus sehingga
      // counter-nya tidak berubah.
      if (!existing.isHidden) {
        await tx.userShowcase.updateMany({
          where: { id: existing.showcaseId, commentCount: { gt: 0 } },
          data: { commentCount: { decrement: 1 } },
        });
      }
    });

    // BE-8 (audit etalase 2026-10-10): kembalikan hitungan final supaya klien
    // tidak perlu menebak (ledger lokal) atau GET detail yang menaikkan view.
    const after = await this.prisma.userShowcase.findUnique({
      where: { id: existing.showcaseId },
      select: { commentCount: true },
    });
    return { message: 'Comment deleted successfully', commentCount: after?.commentCount ?? null };
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
      select: { id: true, showcaseId: true, isHidden: true, deletedAt: true },
    });
    if (!existing || existing.deletedAt) {
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
    const { counts: reactionCounts, userVotes } = await this.getCommentReactionMaps([updated.id], userId);
    const result = this.serializeComment(updated, sealTierMap, this.reactionSummaryFor(updated.id, reactionCounts, userVotes));
    if (!result) throw new InternalServerErrorException('Gagal serialisasi komentar');
    return result;
  }

  /**
   * Audit 2026-10-03 (BFE-117/FAL-009): like/dislike komentar, persisten per
   * user, toggle idempoten via @@unique([commentId, userId]).
   * value: 1 = suka, -1 = tidak suka, 0 = hapus reaksi.
   * Komentar yang di-soft-delete / hidden tidak bisa di-like (404/403).
   */
  async toggleCommentLike(
    userId: string,
    commentId: string,
    value: number,
  ): Promise<{ likes: number; dislikes: number; userVote: number }> {
    if (value !== 1 && value !== -1 && value !== 0) {
      throw new BadRequestException({
        code: ErrorCodes.VALIDATION_ERROR,
        message: 'value must be 1 (like), -1 (dislike), or 0 (remove)',
      });
    }
    const comment = await this.prisma.showcaseComment.findUnique({
      where: { id: commentId },
      select: { id: true, isHidden: true, deletedAt: true, showcaseId: true },
    });
    if (!comment || comment.deletedAt) {
      throw new NotFoundException({
        code: ErrorCodes.SHOWCASE_COMMENT_NOT_FOUND,
        message: 'Comment not found',
      });
    }
    if (comment.isHidden) {
      throw new ForbiddenException({
        code: ErrorCodes.SHOWCASE_COMMENT_HIDDEN,
        message: 'Hidden comments cannot be liked',
      });
    }
    // BES-04 (audit etalase 2026-10-10): sama seperti suka/simpan — item
    // harus terlihat oleh pelaku (privat/nonaktif/takedown → 404) dan tidak
    // ada relasi blokir dengan pemilik.
    const visible = await this.findVisibleShowcase(comment.showcaseId, userId);
    if (!visible) {
      throw new NotFoundException({ code: ErrorCodes.SHOWCASE_NOT_FOUND, message: 'Showcase item not found' });
    }
    await this.assertNoBlockRelation(userId, visible.row.userId);
    if (value === 0) {
      await this.prisma.showcaseCommentReaction.deleteMany({ where: { commentId, userId } });
    } else {
      await this.prisma.showcaseCommentReaction.upsert({
        where: { commentId_userId: { commentId, userId } },
        create: { commentId, userId, value },
        update: { value },
      });
    }
    const { counts, userVotes } = await this.getCommentReactionMaps([commentId], userId);
    return this.reactionSummaryFor(commentId, counts, userVotes);
  }

  // ==================================================================
  // Moderasi komentar oleh admin (audit 2026-10-03, FAL-010)
  // ==================================================================

  /**
   * Daftar komentar untuk panel Trust & Safety.
   * status: 'all' | 'visible' | 'hidden' | 'deleted'.
   * search: cocokkan isi komentar / username / nama author.
   */
  async adminListComments(
    status: string,
    search: string | undefined,
    page: number,
    limit: number,
  ): Promise<object> {
    const normalizedStatus = (status ?? 'all').toLowerCase();
    if (!['all', 'visible', 'hidden', 'deleted'].includes(normalizedStatus)) {
      throw new BadRequestException({
        code: ErrorCodes.VALIDATION_ERROR,
        message: 'status must be one of: all, visible, hidden, deleted',
      });
    }
    const statusWhere: Prisma.ShowcaseCommentWhereInput =
      normalizedStatus === 'visible'
        ? { deletedAt: null, isHidden: false }
        : normalizedStatus === 'hidden'
          ? { deletedAt: null, isHidden: true }
          : normalizedStatus === 'deleted'
            ? { deletedAt: { not: null } }
            : {};
    const trimmedSearch = search?.trim();
    const where: Prisma.ShowcaseCommentWhereInput = {
      ...statusWhere,
      ...(trimmedSearch
        ? {
            OR: [
              { content: { contains: trimmedSearch, mode: 'insensitive' } },
              { user: { username: { contains: trimmedSearch, mode: 'insensitive' } } },
              { user: { fullName: { contains: trimmedSearch, mode: 'insensitive' } } },
            ],
          }
        : {}),
    };
    const safePage = Number.isFinite(page) ? Math.max(1, Math.floor(page)) : 1;
    const safeLimit = Number.isFinite(limit) ? Math.min(Math.max(1, Math.floor(limit)), 100) : 20;
    const [rows, total] = await Promise.all([
      this.prisma.showcaseComment.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (safePage - 1) * safeLimit,
        take: safeLimit,
        include: {
          user: { select: { userId: true, username: true, fullName: true, avatarUrl: true } },
          // ADM-07 (audit etalase 2026-10-10): judul ikut dikirim — admin web
          // sebelumnya menampilkan id etalase mentah seolah judul.
          showcase: { select: { id: true, title: true } },
        },
      }),
      this.prisma.showcaseComment.count({ where }),
    ]);
    return {
      data: rows.map((row) => ({
        id: row.id,
        showcaseId: row.showcaseId,
        parentId: row.parentId,
        content: row.deletedAt ? null : row.content,
        isHidden: row.isHidden,
        hiddenReason: row.isHidden ? row.hiddenReason : null,
        hiddenAt: row.hiddenAt,
        hiddenBy: row.hiddenBy,
        isDeleted: row.deletedAt != null,
        deletedAt: row.deletedAt,
        deletedBy: row.deletedBy,
        deleteReason: row.deleteReason,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        author: row.user,
        showcase: row.showcase,
      })),
      total,
      page: safePage,
      limit: safeLimit,
      totalPages: Math.ceil(total / safeLimit),
      status: normalizedStatus,
    };
  }

  /**
   * Aksi moderasi admin pada komentar: 'hide' | 'unhide' | 'delete'.
   * - hide: pakai field isHidden/hiddenReason/hiddenAt/hiddenBy (seperti
   *   pemilik item); commentCount dikurangi bila komentar sedang tampil.
   * - unhide: kebalikan hide.
   * - delete: soft-delete (FAL-027): set deletedAt/deletedBy/deleteReason;
   *   commentCount dikurangi bila komentar sedang tampil (hidden sudah
   *   dikurangi saat hide).
   * Setiap aksi dicatat di audit log admin.
   */
  async adminModerateComment(
    adminId: string,
    commentId: string,
    action: 'hide' | 'unhide' | 'delete',
    reason: string | undefined,
    ipAddress: string,
  ): Promise<object> {
    const existing = await this.prisma.showcaseComment.findUnique({
      where: { id: commentId },
      select: {
        id: true,
        showcaseId: true,
        isHidden: true,
        hiddenReason: true,
        deletedAt: true,
      },
    });
    if (!existing) {
      throw new NotFoundException({
        code: ErrorCodes.SHOWCASE_COMMENT_NOT_FOUND,
        message: 'Comment not found',
      });
    }
    const before = { isHidden: existing.isHidden, isDeleted: existing.deletedAt != null };
    let after: Record<string, unknown>;
    let description: string;

    if (action === 'hide') {
      if (existing.deletedAt) {
        throw new BadRequestException({
          code: ErrorCodes.VALIDATION_ERROR,
          message: 'Deleted comments cannot be hidden',
        });
      }
      if (existing.isHidden) {
        throw new ConflictException({
          code: ErrorCodes.VALIDATION_ERROR,
          message: 'Comment is already hidden',
        });
      }
      const hiddenReason = this.parseAdminHiddenReason(reason);
      await this.prisma.$transaction(async (tx) => {
        await tx.showcaseComment.update({
          where: { id: commentId },
          data: { isHidden: true, hiddenReason, hiddenAt: new Date(), hiddenBy: adminId },
        });
        await tx.userShowcase.updateMany({
          where: { id: existing.showcaseId, commentCount: { gt: 0 } },
          data: { commentCount: { decrement: 1 } },
        });
      });
      after = { isHidden: true, hiddenReason };
      description = `Admin hid showcase comment ${commentId} (reason: ${hiddenReason})`;
    } else if (action === 'unhide') {
      if (existing.deletedAt) {
        throw new BadRequestException({
          code: ErrorCodes.VALIDATION_ERROR,
          message: 'Deleted comments cannot be unhidden',
        });
      }
      if (!existing.isHidden) {
        throw new ConflictException({
          code: ErrorCodes.VALIDATION_ERROR,
          message: 'Comment is not hidden',
        });
      }
      await this.prisma.$transaction(async (tx) => {
        await tx.showcaseComment.update({
          where: { id: commentId },
          data: { isHidden: false, hiddenReason: null, hiddenAt: null, hiddenBy: null },
        });
        await tx.userShowcase.update({
          where: { id: existing.showcaseId },
          data: { commentCount: { increment: 1 } },
        });
      });
      after = { isHidden: false };
      description = `Admin unhid showcase comment ${commentId}`;
    } else {
      // delete → soft-delete (FAL-027).
      if (existing.deletedAt) {
        throw new ConflictException({
          code: ErrorCodes.VALIDATION_ERROR,
          message: 'Comment is already deleted',
        });
      }
      await this.prisma.$transaction(async (tx) => {
        await tx.showcaseComment.update({
          where: { id: commentId },
          data: {
            deletedAt: new Date(),
            deletedBy: adminId,
            deleteReason: reason?.trim() ? reason.trim().slice(0, 500) : null,
          },
        });
        if (!existing.isHidden) {
          await tx.userShowcase.updateMany({
            where: { id: existing.showcaseId, commentCount: { gt: 0 } },
            data: { commentCount: { decrement: 1 } },
          });
        }
      });
      after = { isDeleted: true };
      description = `Admin soft-deleted showcase comment ${commentId}`;
    }

    this.auditLog.logAdminAction({
      adminId,
      action: AuditAction.ADMIN_ACTION,
      targetType: 'ShowcaseComment',
      targetId: commentId,
      description,
      before,
      after: { ...after, reason: reason ?? null },
      ipAddress,
    });
    this.logger.log(`Showcase comment ${commentId} ${action} by admin ${adminId}`);
    return { ok: true, action, commentId };
  }

  private parseAdminHiddenReason(reason: string | undefined): ContentHiddenReason {
    const normalized = (reason ?? 'OTHER').trim().toUpperCase();
    const allowed: ContentHiddenReason[] = ['SPAM', 'INAPPROPRIATE', 'HARASSMENT', 'OTHER'];
    if (!allowed.includes(normalized as ContentHiddenReason)) {
      throw new BadRequestException({
        code: ErrorCodes.VALIDATION_ERROR,
        message: 'reason must be one of: SPAM, INAPPROPRIATE, HARASSMENT, OTHER',
      });
    }
    return normalized as ContentHiddenReason;
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
        ? `${formatIdr(priceMin)} - ${formatIdr(priceMax)}`
        : priceMin !== null
          ? formatIdr(priceMin)
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
  private async findModerationEnforcement(showcaseId: string): Promise<ModerationEnforcement | null> {
    try {
      const map = await this.getActiveEnforcementMap([showcaseId]);
      return map.get(showcaseId) ?? null;
    } catch (err) {
      this.logger.warn(
        `findModerationEnforcement(${showcaseId}) failed (best-effort): ${(err as Error).message}`,
      );
      return null;
    }
  }
}
