import { ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { BusinessVerificationStatus, KycStatus, UserAccountType } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { RedisService } from '../../redis/redis.service';
import { PROFILE_VERIFICATION_BADGES } from '../../common/constants/redis-keys';
import * as ErrorCodes from '../../common/constants/error-codes';

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
  'KYC_VERIFIED',
  'BUSINESS_VERIFIED',
  'KAHADE_PLUS',
  'TRUSTED_BY_KAHADE',
  'CONTACT_VERIFIED',
] as const;

export type VerificationBadgeType = (typeof VERIFICATION_BADGE_TYPES)[number];

/**
 * TTL cache badge. Sengaja beberapa detik saja: cukup untuk meredam N pembacaan
 * profil per request halaman, tapi tidak cukup lama untuk membuat badge yang
 * sudah di-revoke tetap tampil. Setiap titik revoke juga memanggil
 * {@link VerificationBadgeService.invalidate} post-commit, jadi jalur normalnya
 * adalah invalid, bukan tunggu TTL.
 */
export const VERIFICATION_BADGE_CACHE_TTL_SECONDS = 5;

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
  memberSince: Date;
  deletedAt: Date | null;
}

export interface BadgeSourceBusinessVerification {
  status: BusinessVerificationStatus;
  approvedAt: Date | null;
}

const BADGE_PRIORITY: Record<VerificationBadgeType, number> = {
  KYC_VERIFIED: 1,
  BUSINESS_VERIFIED: 2,
  KAHADE_PLUS: 3,
  TRUSTED_BY_KAHADE: 4,
  CONTACT_VERIFIED: 5,
};

const BADGE_META: Record<
  VerificationBadgeType,
  Pick<VerificationBadge, 'labelKey' | 'label' | 'shortLabel' | 'description' | 'icon'>
> = {
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

    // Urutan prioritas tampil sudah eksplisit; sort stabil agar UI bisa langsung
    // render tanpa mengurutkan sendiri.
    return badges.sort((a, b) => a.priority - b.priority);
  }

  /**
   * Ambil badge aktif untuk satu user (read-through cache, TTL beberapa detik).
   * Cache di-invalidate eksplisit oleh setiap titik revoke — lihat
   * admin-kyc.service, subscription-expiry.service, dan admin-business-verification.service.
   */
  async getBadges(userId: string, opts?: { skipCache?: boolean }): Promise<VerificationBadge[]> {
    const cacheKey = PROFILE_VERIFICATION_BADGES(userId);

    if (!opts?.skipCache) {
      const cached = await this.redis.get(cacheKey);
      if (cached) {
        try {
          const parsed = JSON.parse(cached) as Array<Omit<VerificationBadge, 'earnedAt'> & { earnedAt: string | null }>;
          if (Array.isArray(parsed)) {
            return parsed.map((badge) => ({
              ...badge,
              earnedAt: badge.earnedAt ? new Date(badge.earnedAt) : null,
            }));
          }
        } catch (err) {
          // Cache korup bukan alasan untuk 500 — buang dan hitung ulang.
          this.logger.warn(`Corrupt verification-badge cache for ${userId}: ${(err as Error).message}`);
          await this.redis.del(cacheKey);
        }
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

  /** Baca state dari DB dan hitung badge. Tidak menyentuh cache. */
  async loadBadges(userId: string, now: Date = new Date()): Promise<VerificationBadge[]> {
    const user = await this.prisma.user.findFirst({
      // Soft-delete guard: badge user terhapus tidak boleh tampil.
      where: { id: userId, deletedAt: null },
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
        memberSince: true,
        deletedAt: true,
      },
    });
    if (!user) {
      throw new NotFoundException({ code: ErrorCodes.USER_NOT_FOUND, message: 'User not found' });
    }

    // Baris APPROVED paling baru. approvedAt dipertahankan walau nanti REVOKED,
    // jadi filter status di sini yang menentukan badge — bukan approvedAt.
    const businessVerification =
      user.accountType === UserAccountType.BUSINESS
        ? await this.prisma.businessVerification.findFirst({
            where: { userId, status: BusinessVerificationStatus.APPROVED },
            orderBy: [{ approvedAt: 'desc' }, { id: 'desc' }],
            select: { status: true, approvedAt: true },
          })
        : null;

    return this.computeBadges(user, businessVerification, now);
  }

  /**
   * Invalidasi post-commit. Dipanggil setelah transaction commit di setiap titik
   * yang mengubah sumber kebenaran badge (approve/revoke KYC, subscribe/expire
   * Kahade+, approve/revoke business verification, grant/revoke trust admin).
   *
   * Gagal invalidate TIDAK boleh membatalkan aksi utamanya — TTL pendek sudah
   * membatasi staleness, jadi cukup log.
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
    if (!owner || !owner.profileVisible || !owner.isActive || owner.isBanned || owner.deletedAt != null) {
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
