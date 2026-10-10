import { ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { BusinessVerificationStatus, KycStatus, UserAccountType } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { RedisService } from '../../redis/redis.service';
import { PROFILE_VERIFICATION_BADGES } from '../../common/constants/redis-keys';
import * as ErrorCodes from '../../common/constants/error-codes';

/** Tier seal untuk <VerifiedSeal> — disematkan di payload agar frontend
 *  tidak perlu N+1 request badge per user. */
export type SealTier = 'gold' | 'blue' | 'gray';

/**
 * Tentukan tier seal dari daftar tipe badge.
 * Prioritas: emas (TRUSTED_BY_KAHADE) > biru (BUSINESS_VERIFIED) >
 * abu (FULLY_VERIFIED). Sama dengan frontend getSealTier — jangan ubah
 * satu sisi tanpa sisi lain.
 */
export function getSealTierFromTypes(types: Iterable<string>): SealTier | null {
  const set = new Set(types);
  if (set.has('TRUSTED_BY_KAHADE')) return 'gold';
  if (set.has('BUSINESS_VERIFIED')) return 'blue';
  if (set.has('FULLY_VERIFIED')) return 'gray';
  return null;
}

/**
 * Section 1 — Verified Badge System.
 *
 * Lima kategori badge verifikasi yang INDEPENDEN dan ditampilkan di samping
 * username. Badge dihitung ulang dari state sumber kebenaran (bukan disimpan
 * sebagai flag tunggal), jadi begitu KYC di-revoke, subscription expire, atau
 * business verification di-revoke, badge-nya hilang tanpa perlu migrasi data.
 *
 * Urutan prioritas tampil (untuk UI ruang terbatas, index 1 = paling kiri):
 *   KYC_VERIFIED > BUSINESS_VERIFIED > KAHADE_PLUS > TRUSTED_BY_KAHADE > CONTACT_VERIFIED
 *
 * Catatan desain:
 * - `TRUSTED_BY_KAHADE` memakai infrastruktur admin-manual yang SUDAH ada
 *   (`isVip` / `vipGrantedAt` / `vipGrantedBy`) — di-reframe, bukan field baru.
 * - `BUSINESS_VERIFIED` hanya berlaku untuk `accountType == BUSINESS`; badge
 *   sengaja tidak menyala untuk akun PERSONAL yang (keliru) punya baris
 *   BusinessVerification APPROVED.
 * - `CONTACT_VERIFIED` adalah kombinasi emailVerified + phoneVerified; earnedAt
 *   diambil dari yang paling BELAKANG, karena badge baru lengkap saat keduanya
 *   terverifikasi.
 */

export const VERIFICATION_BADGE_TYPES = [
  'FULLY_VERIFIED',
  'KYC_VERIFIED',
  'BUSINESS_VERIFIED',
  'KAHADE_PLUS',
  'TRUSTED_BY_KAHADE',
  'CONTACT_VERIFIED',
] as const;

export type VerificationBadgeType = (typeof VERIFICATION_BADGE_TYPES)[number];

/**
 * TTL cache badge. PERF-FIX BD-001: dinaikkan dari 5 detik ke 600 detik
 * (10 menit). TTL 5 detik membuat hit rate Redis praktis 0% (audit:
 * 8,08% dalam 19 hari) — setiap halaman feed memicu ~20 query DB yang
 * tidak perlu. Data badge berubah jarang (status KYC/VIP/langganan),
 * dan SETIAP titik yang mengubah sumber kebenaran badge memanggil
 * {@link VerificationBadgeService.invalidate} post-commit (admin-kyc,
 * admin-badges, admin-business-verification, admin-subscriptions,
 * admin-users, business-verification, subscription-expiry,
 * subscription-auto-resume, subscriptions), jadi jalur normalnya adalah
 * invalidasi eksplisit, bukan tunggu TTL. Staleness maksimum 10 menit
 * hanya untuk perubahan yang tidak lewat titik-titik tersebut (mis.
 * pengisian alamat profil — kosmetik, bukan keamanan).
 */
export const VERIFICATION_BADGE_CACHE_TTL_SECONDS = 600;

export interface VerificationBadge {
  /** Identifier stabil untuk logika UI (jangan pakai label untuk branching). */
  type: VerificationBadgeType;
  /** Kunci i18n stabil — frontend boleh melokalkan tanpa backend deploy. */
  labelKey: string;
  /** Label siap pakai (id-ID). */
  label: string;
  /** Label pendek untuk pill/chip di ruang sempit. */
  shortLabel: string;
  description: string;
  /** Nama ikon (bukan URL) supaya tema/asset tetap milik frontend. */
  icon: string;
  /** Kapan badge didapat. NULL = state lama sebelum timestamp dicatat. */
  earnedAt: Date | null;
  /** 1 = prioritas tampil tertinggi. */
  priority: number;
}

/** Input minimum yang dibutuhkan untuk menghitung badge. */
export interface BadgeSourceUser {
  id: string;
  accountType: UserAccountType;
  emailVerified: boolean;
  emailVerifiedAt: Date | null;
  phoneVerified: boolean;
  phoneVerifiedAt: Date | null;
  kycStatus: KycStatus;
  kycApprovedAt: Date | null;
  isKahadePlus: boolean;
  subscriptionExpiresAt: Date | null;
  kahadePlusSince: Date | null;
  isVip: boolean;
  vipGrantedAt: Date | null;
  /** Alamat profil — syarat badge FULLY_VERIFIED (non-empty). */
  address: string | null;
  /**
   * Revoke manual tier abu oleh admin. Non-null = badge FULLY_VERIFIED
   * dinonaktifkan sampai di-restore, walau syarat otomatis terpenuhi.
   */
  grayVerifiedRevokedAt: Date | null;
  memberSince: Date;
  deletedAt: Date | null;
}

export interface BadgeSourceBusinessVerification {
  status: BusinessVerificationStatus;
  approvedAt: Date | null;
}

const BADGE_PRIORITY: Record<VerificationBadgeType, number> = {
  FULLY_VERIFIED: 1,
  KYC_VERIFIED: 2,
  BUSINESS_VERIFIED: 3,
  KAHADE_PLUS: 4,
  TRUSTED_BY_KAHADE: 5,
  CONTACT_VERIFIED: 6,
};

const BADGE_META: Record<
  VerificationBadgeType,
  Pick<VerificationBadge, 'labelKey' | 'label' | 'shortLabel' | 'description' | 'icon'>
> = {
  FULLY_VERIFIED: {
    labelKey: 'badge.fullyVerified',
    label: 'Terverifikasi Penuh',
    shortLabel: 'Terverifikasi',
    description:
      'Menyelesaikan seluruh verifikasi: identitas (KYC), email, nomor handphone, alamat lengkap, dan langganan Kahade+ aktif. Dapat dicabut admin kapanpun.',
    icon: 'seal-check',
  },
  KYC_VERIFIED: {
    labelKey: 'badge.kycVerified',
    label: 'Identitas Terverifikasi',
    shortLabel: 'KYC',
    description: 'Identitas pribadi sudah diverifikasi melalui KTP dan selfie.',
    icon: 'badge-check',
  },
  BUSINESS_VERIFIED: {
    labelKey: 'badge.businessVerified',
    label: 'Bisnis Terverifikasi',
    shortLabel: 'Bisnis',
    description: 'Legalitas badan usaha (NPWP dan akta/SIUP) sudah diverifikasi Kahade.',
    icon: 'briefcase-check',
  },
  KAHADE_PLUS: {
    labelKey: 'badge.kahadePlus',
    label: 'Kahade+',
    shortLabel: 'Kahade+',
    description: 'Langganan Kahade+ sedang aktif.',
    icon: 'sparkles',
  },
  TRUSTED_BY_KAHADE: {
    labelKey: 'badge.trustedByKahade',
    label: 'Dipercaya Kahade',
    shortLabel: 'Trusted',
    description: 'Ditandai langsung oleh tim Kahade sebagai akun tepercaya.',
    icon: 'shield-star',
  },
  CONTACT_VERIFIED: {
    labelKey: 'badge.contactVerified',
    label: 'Email & HP Terverifikasi',
    shortLabel: 'Kontak',
    description: 'Email dan nomor handphone sudah terverifikasi.',
    icon: 'envelope-check',
  },
};

function latest(...dates: Array<Date | null | undefined>): Date | null {
  let result: Date | null = null;
  for (const date of dates) {
    if (!date) continue;
    if (!result || date.getTime() > result.getTime()) result = date;
  }
  return result;
}

/**
 * Batch 139 BE-API2 (item 115): versi murni module-level dari logika
 * `VerificationBadgeService.computeBadges` — tanpa I/O dan tanpa `this`,
 * sehingga bisa dipakai modul lain (mis. wallet transfer lookup) tanpa
 * menambah dependency antar-modul. Perilaku identik dengan method aslinya.
 */
export function computeVerificationBadges(
  user: BadgeSourceUser,
  businessVerification: BadgeSourceBusinessVerification | null,
  now: Date = new Date(),
): VerificationBadge[] {
  const badges: VerificationBadge[] = [];

  const push = (type: VerificationBadgeType, earnedAt: Date | null): void => {
    badges.push({
      type,
      ...BADGE_META[type],
      earnedAt,
      priority: BADGE_PRIORITY[type],
    });
  };

  // (b) KYC terverifikasi
  if (user.kycStatus === KycStatus.APPROVED) {
    push('KYC_VERIFIED', user.kycApprovedAt);
  }

  // (d) Business terverifikasi — domain terpisah dari KYC personal dan hanya
  // untuk akun BUSINESS.
  if (
    user.accountType === UserAccountType.BUSINESS &&
    businessVerification?.status === BusinessVerificationStatus.APPROVED
  ) {
    push('BUSINESS_VERIFIED', businessVerification.approvedAt);
  }

  // (c) Kahade+ — flag denormalized bisa saja basi sebentar setelah expiry cron
  // jalan, jadi subscriptionExpiresAt ikut diperiksa sebagai guard kedua.
  const plusStillValid = !user.subscriptionExpiresAt || user.subscriptionExpiresAt > now;
  if (user.isKahadePlus && plusStillValid) {
    push('KAHADE_PLUS', user.kahadePlusSince);
  }

  // (e) Trust admin-manual — reuse isVip/vipGrantedAt, TIDAK ada field baru.
  if (user.isVip) {
    push('TRUSTED_BY_KAHADE', user.vipGrantedAt);
  }

  // (a) Email & nomor HP terverifikasi — kombinasi keduanya.
  if (user.emailVerified && user.phoneVerified) {
    push('CONTACT_VERIFIED', latest(user.emailVerifiedAt, user.phoneVerifiedAt));
  }

  // (f) Verifikasi penuh — TIER ABU: KYC + email + HP + alamat terisi +
  // Kahade+ aktif, DAN tidak sedang di-revoke manual oleh admin.
  // earnedAt = yang paling belakang, karena badge baru lengkap saat itu.
  // Definisi "Kahade+ aktif" sama dengan badge KAHADE_PLUS (plusStillValid).
  if (
    user.kycStatus === KycStatus.APPROVED &&
    user.emailVerified &&
    user.phoneVerified &&
    user.address != null &&
    user.address.trim().length > 0 &&
    user.isKahadePlus &&
    plusStillValid &&
    user.grayVerifiedRevokedAt == null
  ) {
    push('FULLY_VERIFIED', latest(user.kycApprovedAt, user.emailVerifiedAt, user.phoneVerifiedAt, user.kahadePlusSince));
  }

  // Urutan prioritas tampil sudah eksplisit; sort stabil agar UI bisa langsung
  // render tanpa mengurutkan sendiri.
  return badges.sort((a, b) => a.priority - b.priority);
}

@Injectable()
export class VerificationBadgeService {
  private readonly logger = new Logger(VerificationBadgeService.name);

  constructor(
    private prisma: PrismaService,
    private redis: RedisService,
  ) {}

  /**
   * Hitung badge murni dari data yang sudah ada di tangan pemanggil — tanpa I/O.
   * Dipisah dari {@link getBadges} supaya bisa di-unit-test dan dipakai ulang
   * oleh presenter yang sudah memuat user row.
   */
  computeBadges(
    user: BadgeSourceUser,
    businessVerification: BadgeSourceBusinessVerification | null,
    now: Date = new Date(),
  ): VerificationBadge[] {
    return computeVerificationBadges(user, businessVerification, now);
  }

  /**
   * Batch badge untuk banyak user sekaligus (dipakai feed, search, chat).
   * PERF-FIX BD-002: cache dibaca paralel per key; untuk SEMUA cache miss
   * hanya SATU `user.findMany` + SATU `businessVerification.findMany`
   * (bukan N `findFirst`). Dipadukan dengan TTL 600 dtk (BD-001), miss
   * menjadi langka dan kalaupun miss biayanya 2 query, bukan 20-40.
   *
   * User yang tidak ada di DB (soft-deleted) DIABAIKAN dari map hasil —
   * pemanggil yang butuh tier memakai {@link getSealTierMap} (null),
   * pemanggil yang butuh daftar badge memakai `?? []`.
   * Gagal batch load tidak melempar — yang hit cache tetap terlayani.
   */
  async getBadgesBatch(userIds: string[]): Promise<Map<string, VerificationBadge[]>> {
    const unique = [...new Set(userIds.filter(Boolean))];
    const result = new Map<string, VerificationBadge[]>();
    if (unique.length === 0) return result;

    // 1) Read-through cache, paralel (1 RTT Redis per key, bukan per query DB).
    const cached = await Promise.all(
      unique.map(async (userId): Promise<[string, VerificationBadge[] | null]> => {
        try {
          const raw = await this.redis.get(PROFILE_VERIFICATION_BADGES(userId));
          if (!raw) return [userId, null];
          const badges = await this.parseCachedBadges(raw, userId);
          return [userId, badges];
        } catch {
          return [userId, null];
        }
      }),
    );
    const missed: string[] = [];
    for (const [userId, badges] of cached) {
      if (badges) {
        result.set(userId, badges);
      } else {
        missed.push(userId);
      }
    }

    // 2) Cache miss → batch load SATU kali untuk semua, lalu hangatkan cache.
    if (missed.length > 0) {
      let badgeMap: Map<string, VerificationBadge[]>;
      try {
        badgeMap = await this.loadBadgesBatch(missed);
      } catch (err) {
        this.logger.warn(
          `getBadgesBatch batch load failed for ${missed.length} users: ${(err as Error).message}`,
        );
        return result;
      }
      await Promise.all(
        missed.map(async (userId) => {
          const badges = badgeMap.get(userId);
          // User tidak ada / soft-deleted → diabaikan (konsisten dengan
          // perilaku lama loadBadges yang throw NotFoundException).
          if (!badges) return;
          result.set(userId, badges);
          await this.redis
            .setex(PROFILE_VERIFICATION_BADGES(userId), VERIFICATION_BADGE_CACHE_TTL_SECONDS, JSON.stringify(badges))
            .catch((err: unknown) =>
              this.logger.warn(
                `Failed to cache verification badges for ${userId}: ${err instanceof Error ? err.message : String(err)}`,
              ),
            );
        }),
      );
    }
    return result;
  }

  /**
   * Batch seal tier untuk banyak user sekaligus (dipakai feed, search, chat).
   * Dibangun di atas {@link getBadgesBatch} — user yang tidak ada di DB
   * (soft-deleted) mendapat tier null, bukan error.
   */
  async getSealTierMap(userIds: string[]): Promise<Map<string, SealTier | null>> {
    const unique = [...new Set(userIds.filter(Boolean))];
    const badgeMap = await this.getBadgesBatch(unique);
    return new Map(unique.map((userId) => {
      const badges = badgeMap.get(userId);
      return [userId, badges ? getSealTierFromTypes(badges.map((b) => b.type)) : null] as [string, SealTier | null];
    }));
  }

  /**
   * Parse isi cache badge. Return null bila kosong/korup (pemanggil
   * menghapus key korup supaya dihitung ulang, bukan 500).
   */
  private async parseCachedBadges(raw: string, userId: string): Promise<VerificationBadge[] | null> {
    try {
      const parsed = JSON.parse(raw) as Array<Omit<VerificationBadge, 'earnedAt'> & { earnedAt: string | null }>;
      if (!Array.isArray(parsed)) {
        await this.redis.del(PROFILE_VERIFICATION_BADGES(userId));
        return null;
      }
      return parsed.map((badge) => ({
        ...badge,
        earnedAt: badge.earnedAt ? new Date(badge.earnedAt) : null,
      }));
    } catch (err) {
      // Cache korup bukan alasan untuk 500 — buang dan hitung ulang.
      this.logger.warn(`Corrupt verification-badge cache for ${userId}: ${(err as Error).message}`);
      await this.redis.del(PROFILE_VERIFICATION_BADGES(userId));
      return null;
    }
  }

  /**
   * Ambil badge aktif untuk satu user (read-through cache, TTL 10 menit —
   * lihat BD-001). Cache di-invalidate eksplisit oleh setiap titik yang
   * mengubah sumber kebenaran badge — lihat admin-kyc.service,
   * admin-badges.service, subscription-expiry.service,
   * admin-business-verification.service, admin-subscriptions.service,
   * admin-users.service, business-verification.service, dan
   * subscriptions.service.
   */
  async getBadges(userId: string, opts?: { skipCache?: boolean }): Promise<VerificationBadge[]> {
    const cacheKey = PROFILE_VERIFICATION_BADGES(userId);

    if (!opts?.skipCache) {
      const cached = await this.redis.get(cacheKey);
      if (cached) {
        const badges = await this.parseCachedBadges(cached, userId);
        if (badges) return badges;
      }
    }

    const badges = await this.loadBadges(userId);
    await this.redis
      .setex(cacheKey, VERIFICATION_BADGE_CACHE_TTL_SECONDS, JSON.stringify(badges))
      .catch((err: unknown) =>
        this.logger.warn(
          `Failed to cache verification badges for ${userId}: ${err instanceof Error ? err.message : String(err)}`,
        ),
      );
    return badges;
  }

  /**
   * Baca state dari DB dan hitung badge untuk BANYAK user sekaligus.
   * PERF-FIX BD-002: satu `user.findMany({ id: { in } })` + satu
   * `businessVerification.findMany` untuk akun BUSINESS — menggantikan N
   * `findFirst` per user. Tidak menyentuh cache.
   */
  async loadBadgesBatch(userIds: string[], now: Date = new Date()): Promise<Map<string, VerificationBadge[]>> {
    const unique = [...new Set(userIds.filter(Boolean))];
    const result = new Map<string, VerificationBadge[]>();
    if (unique.length === 0) return result;

    const users = await this.prisma.user.findMany({
      // Soft-delete guard: badge user terhapus tidak boleh tampil.
      where: { id: { in: unique }, deletedAt: null },
      select: {
        id: true,
        accountType: true,
        emailVerified: true,
        emailVerifiedAt: true,
        phoneVerified: true,
        phoneVerifiedAt: true,
        kycStatus: true,
        kycApprovedAt: true,
        isKahadePlus: true,
        subscriptionExpiresAt: true,
        kahadePlusSince: true,
        isVip: true,
        vipGrantedAt: true,
        address: true,
        grayVerifiedRevokedAt: true,
        memberSince: true,
        deletedAt: true,
      },
    });

    // Baris APPROVED paling baru per user. Satu query untuk semua akun
    // BUSINESS. Diurutkan eksplisit di aplikasi (approvedAt desc, id desc)
    // agar tidak bergantung pada urutan kembalian DB; baris pertama per
    // userId = hasil yang sama dengan findFirst per user.
    const businessIds = users.filter((u) => u.accountType === UserAccountType.BUSINESS).map((u) => u.id);
    const bvByUser = new Map<string, BadgeSourceBusinessVerification>();
    if (businessIds.length > 0) {
      const bvRows = await this.prisma.businessVerification.findMany({
        where: { userId: { in: businessIds }, status: BusinessVerificationStatus.APPROVED },
        orderBy: [{ approvedAt: 'desc' }, { id: 'desc' }],
        select: { userId: true, status: true, approvedAt: true },
      });
      const sorted = [...bvRows].sort((a, b) => {
        const at = a.approvedAt ? new Date(a.approvedAt).getTime() : 0;
        const bt = b.approvedAt ? new Date(b.approvedAt).getTime() : 0;
        if (bt !== at) return bt - at;
        return String((b as { id?: unknown }).id ?? '').localeCompare(String((a as { id?: unknown }).id ?? ''));
      });
      for (const row of sorted) {
        if (!bvByUser.has(row.userId)) {
          bvByUser.set(row.userId, { status: row.status, approvedAt: row.approvedAt });
        }
      }
    }

    for (const user of users) {
      result.set(user.id, this.computeBadges(user, bvByUser.get(user.id) ?? null, now));
    }
    return result;
  }

  /** Baca state dari DB dan hitung badge. Tidak menyentuh cache. */
  async loadBadges(userId: string, now: Date = new Date()): Promise<VerificationBadge[]> {
    const badges = (await this.loadBadgesBatch([userId], now)).get(userId);
    if (!badges) {
      throw new NotFoundException({ code: ErrorCodes.USER_NOT_FOUND, message: 'User not found' });
    }
    return badges;
  }

  /**
   * Invalidasi post-commit. Dipanggil setelah transaction commit di setiap titik
   * yang mengubah sumber kebenaran badge (approve/revoke KYC, subscribe/expire
   * Kahade+, approve/revoke business verification, grant/revoke trust admin).
   *
   * Gagal invalidate TIDAK boleh membatalkan aksi utamanya — TTL 600 dtk
   * membatasi staleness maksimum, jadi cukup log.
   */
  async invalidate(userId: string): Promise<void> {
    await this.redis.del(PROFILE_VERIFICATION_BADGES(userId)).catch((err: unknown) =>
      this.logger.warn(
        `Failed to invalidate verification-badge cache for ${userId}: ${err instanceof Error ? err.message : String(err)}`,
      ),
    );
  }

  /** Metadata katalog badge untuk UI (termasuk yang belum dimiliki user). */
  getCatalog(): Array<Omit<VerificationBadge, 'earnedAt'>> {
    return VERIFICATION_BADGE_TYPES.map((type) => ({
      type,
      ...BADGE_META[type],
      priority: BADGE_PRIORITY[type],
    }));
  }

  /**
   * Endpoint publik `GET /users/:username/badges`.
   *
   * Menerapkan gate privasi yang sama dengan `getPublicProfile`:
   *  - profil tidak terlihat / nonaktif / banned / soft-deleted -> 404
   *  - viewer diblokir owner ATAU viewer memblokir owner -> 403 USER_BLOCKED
   *    (bukan sekadar menyembunyikan field; pola block-list enforcement yang
   *    sama dipakai user-search.service.ts dan orders.service.ts)
   */
  async getPublicBadgesByUsername(username: string, viewerId?: string): Promise<{ username: string; badges: VerificationBadge[] }> {
    const owner = await this.prisma.user.findUnique({
      where: { username: username.toLowerCase() },
      select: { id: true, username: true, profileVisible: true, isActive: true, isBanned: true, deletedAt: true },
    });
    if (!owner || !owner.isActive || owner.isBanned || owner.deletedAt != null) {
      throw new NotFoundException({ code: ErrorCodes.USER_NOT_FOUND, message: 'User not found' });
    }
    // Audit 2026-10-10: pemilik tetap melihat lencananya sendiri saat profil
    // privat (selaras getPublicProfile/followers/ratings).
    if (!owner.profileVisible && viewerId !== owner.id) {
      throw new NotFoundException({ code: ErrorCodes.USER_NOT_FOUND, message: 'User not found' });
    }

    if (viewerId && viewerId !== owner.id) {
      const block = await this.prisma.blockList.findFirst({
        where: {
          OR: [
            { blockerId: owner.id, blockedId: viewerId },
            { blockerId: viewerId, blockedId: owner.id },
          ],
        },
        select: { id: true },
      });
      if (block) {
        throw new ForbiddenException({ code: ErrorCodes.USER_BLOCKED, message: 'Profile is not accessible' });
      }
    }

    return { username: owner.username ?? username.toLowerCase(), badges: await this.getBadges(owner.id) };
  }
}
