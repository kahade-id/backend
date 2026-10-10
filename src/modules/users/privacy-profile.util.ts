import { PrivacyListVisibility, QaCommentPolicy, ShowcaseVisibility } from '@prisma/client';

/**
 * Penerapan PrivacySetting pada serializer profil publik (G076–G083).
 *
 * Fungsi murni: menerima payload profil yang sudah dirakit + setting privasi
 * pemilik + konteks viewer, mengembalikan payload baru yang sudah diredaksi.
 * Berlaku hanya saat viewer != owner; pemilik selalu melihat datanya sendiri.
 */

export interface PrivacySettingLike {
  showEmail: boolean;
  showPhone: boolean;
  showDob: boolean;
  showGender: boolean;
  showFollowerList: PrivacyListVisibility;
  showFollowingList: PrivacyListVisibility;
  showcaseDefaultVisibility: ShowcaseVisibility;
  qaCommentPolicy: QaCommentPolicy;
  qaAnswerModeration: boolean;
  showReviews: boolean;
  hiddenStats: string[];
  searchEngineIndex: boolean;
}

/** Default bila user belum pernah menyimpan pengaturan (selaras schema). */
export const DEFAULT_PRIVACY_SETTING: PrivacySettingLike = {
  showEmail: false,
  showPhone: false,
  showDob: false,
  showGender: false,
  showFollowerList: PrivacyListVisibility.EVERYONE,
  showFollowingList: PrivacyListVisibility.EVERYONE,
  showcaseDefaultVisibility: ShowcaseVisibility.PUBLIC,
  qaCommentPolicy: QaCommentPolicy.EVERYONE,
  qaAnswerModeration: false,
  showReviews: true,
  hiddenStats: [],
  searchEngineIndex: true,
};

export interface PrivacyViewerContext {
  isOwnProfile: boolean;
  /** Apakah viewer mem-follow pemilik profil (untuk visibilitas FOLLOWERS). */
  viewerFollowsOwner: boolean;
}

/** Kunci statistik yang boleh disembunyikan (G082); kunci asing diabaikan. */
export const KNOWN_HIDDEN_STAT_KEYS = ['totalOrders', 'avgRating', 'ratingCount', 'memberSince'] as const;

/**
 * Muat PrivacySetting pemilik profil; fallback ke default bila belum ada.
 * Prisma client apa pun yang punya `privacySetting.findUnique` bisa dipakai
 * (users, profile-qa, showcase) tanpa wiring modul baru.
 */
export async function loadPrivacySetting(
  prisma: { privacySetting: { findUnique: (args: { where: { userId: string } }) => Promise<Partial<PrivacySettingLike> | null> } },
  userId: string,
): Promise<PrivacySettingLike> {
  // Audit 2026-10-10: try/catch, bukan hanya `.catch` — bila client tidak
  // punya model `privacySetting` (mis. mock di unit test lama), akses
  // `prisma.privacySetting.findUnique` melempar TypeError SINKRON yang tak
  // tertangkap `.catch`, dan seluruh profil publik ikut 500.
  let row: Partial<PrivacySettingLike> | null = null;
  try {
    row = await prisma.privacySetting.findUnique({ where: { userId } });
  } catch {
    row = null;
  }
  if (!row) return { ...DEFAULT_PRIVACY_SETTING };
  return {
    showEmail: row.showEmail ?? DEFAULT_PRIVACY_SETTING.showEmail,
    showPhone: row.showPhone ?? DEFAULT_PRIVACY_SETTING.showPhone,
    showDob: row.showDob ?? DEFAULT_PRIVACY_SETTING.showDob,
    showGender: row.showGender ?? DEFAULT_PRIVACY_SETTING.showGender,
    showFollowerList: row.showFollowerList ?? DEFAULT_PRIVACY_SETTING.showFollowerList,
    showFollowingList: row.showFollowingList ?? DEFAULT_PRIVACY_SETTING.showFollowingList,
    showcaseDefaultVisibility: row.showcaseDefaultVisibility ?? DEFAULT_PRIVACY_SETTING.showcaseDefaultVisibility,
    qaCommentPolicy: row.qaCommentPolicy ?? DEFAULT_PRIVACY_SETTING.qaCommentPolicy,
    qaAnswerModeration: row.qaAnswerModeration ?? DEFAULT_PRIVACY_SETTING.qaAnswerModeration,
    showReviews: row.showReviews ?? DEFAULT_PRIVACY_SETTING.showReviews,
    hiddenStats: row.hiddenStats ?? [],
    searchEngineIndex: row.searchEngineIndex ?? DEFAULT_PRIVACY_SETTING.searchEngineIndex,
  };
}

export function canViewList(visibility: PrivacyListVisibility, ctx: PrivacyViewerContext): boolean {
  if (ctx.isOwnProfile) return true;
  if (visibility === PrivacyListVisibility.EVERYONE) return true;
  if (visibility === PrivacyListVisibility.FOLLOWERS) return ctx.viewerFollowsOwner;
  return false; // ONLY_ME
}

export interface AccountContactInfo {
  email: string | null;
  phone: string | null;
  dateOfBirth: string | null;
  gender: string | null;
}

/** G076: redaksi field identitas akun untuk viewer != owner. */
export function resolveAccountContact(
  info: AccountContactInfo,
  privacy: PrivacySettingLike,
  ctx: PrivacyViewerContext,
): AccountContactInfo {
  if (ctx.isOwnProfile) return info;
  return {
    email: privacy.showEmail ? info.email : null,
    phone: privacy.showPhone ? info.phone : null,
    dateOfBirth: privacy.showDob ? info.dateOfBirth : null,
    gender: privacy.showGender ? info.gender : null,
  };
}

/**
 * Terapkan seluruh aturan privasi pada payload profil publik.
 * `profile` mengikuti bentuk yang dirakit users.service.getPublicProfile.
 */
export function applyPrivacyToPublicProfile<T extends Record<string, unknown>>(
  profile: T,
  accountContact: AccountContactInfo,
  privacy: PrivacySettingLike,
  ctx: PrivacyViewerContext,
): T {
  if (ctx.isOwnProfile) {
    return {
      ...profile,
      accountContact,
      privacy: {
        searchEngineIndex: privacy.searchEngineIndex,
        qaCommentPolicy: privacy.qaCommentPolicy,
        qaAnswerModeration: privacy.qaAnswerModeration,
      },
    };
  }

  const next: Record<string, unknown> = { ...profile };

  // G076: kontak identitas akun (opt-in).
  next.accountContact = resolveAccountContact(accountContact, privacy, ctx);

  // G077: daftar follower/following.
  const social = (next.social ?? {}) as Record<string, unknown>;
  const canSeeFollowers = canViewList(privacy.showFollowerList, ctx);
  const canSeeFollowing = canViewList(privacy.showFollowingList, ctx);
  next.social = {
    ...social,
    followersCount: canSeeFollowers ? social.followersCount : null,
    followingCount: canSeeFollowing ? social.followingCount : null,
    followers: canSeeFollowers ? social.followers : [],
    following: canSeeFollowing ? social.following : [],
    // Audit 2026-10-10: `isFollowedBy` = keanggotaan viewer di daftar
    // mengikuti pemilik — bila daftar itu disembunyikan, flag ini pun tidak
    // boleh membocorkannya.
    ...(canSeeFollowing ? {} : { isFollowedBy: null }),
  };
  // Alias deprecated diselaraskan agar tidak membocorkan lewat jalur lama.
  if (!canSeeFollowers) next.followersCount = null;
  if (!canSeeFollowing) next.followingCount = null;

  // G081: ulasan/rating.
  const hidden = new Set((privacy.hiddenStats ?? []).filter((k): k is string => KNOWN_HIDDEN_STAT_KEYS.includes(k as (typeof KNOWN_HIDDEN_STAT_KEYS)[number])));
  if (!privacy.showReviews) {
    next.ratings = { averageRating: null, totalRatingCount: null, recent: [], hidden: true };
    next.recentRatings = [];
    // Audit 2026-10-10: angka rating juga hidup di `stats` — tanpa ini
    // "sembunyikan ulasan" masih membocorkan rata-rata & jumlah rating.
    hidden.add('avgRating');
    hidden.add('ratingCount');
  }

  // G082: statistik tersembunyi — di `stats` DAN salinan nilainya di bagian
  // lain payload (`ratings.*`, `about.memberSince`); dulu hanya `stats`
  // sehingga klien tinggal membaca dari bagian sebelah.
  if (hidden.size > 0) {
    const stats = { ...((next.stats ?? {}) as Record<string, unknown>) };
    for (const key of hidden) stats[key] = null;
    next.stats = stats;
    if (hidden.has('avgRating') || hidden.has('ratingCount')) {
      const ratings = { ...((next.ratings ?? {}) as Record<string, unknown>) };
      if (hidden.has('avgRating')) ratings.averageRating = null;
      if (hidden.has('ratingCount')) ratings.totalRatingCount = null;
      next.ratings = ratings;
    }
    if (hidden.has('memberSince')) {
      next.about = { ...((next.about ?? {}) as Record<string, unknown>), memberSince: null };
    }
  }

  // G083 + info Q&A untuk klien (mis. render meta noindex / badge kebijakan).
  next.privacy = {
    searchEngineIndex: privacy.searchEngineIndex,
    qaCommentPolicy: privacy.qaCommentPolicy,
    qaAnswerModeration: privacy.qaAnswerModeration,
  };

  return next as T;
}
