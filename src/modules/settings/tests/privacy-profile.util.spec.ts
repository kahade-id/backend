/**
 * GAP-B1 (G076–G083): unit test util privasi profil publik.
 *
 * Memastikan:
 * - profil sendiri tidak diredaksi (isOwnProfile),
 * - kontak identitas hanya tampil bila opt-in (showEmail/showPhone/showDob/showGender),
 * - daftar follower/following menghormati EVERYONE/FOLLOWERS/ONLY_ME,
 * - ulasan & statistik tersembunyi sesuai pengaturan,
 * - alias deprecated tidak membocorkan lewat jalur lama.
 */
import {
  applyPrivacyToPublicProfile,
  canViewList,
  DEFAULT_PRIVACY_SETTING,
  resolveAccountContact,
  type AccountContactInfo,
  type PrivacySettingLike,
  type PrivacyViewerContext,
} from '../../users/privacy-profile.util';

function makeProfile(): Record<string, any> {
  return {
    social: {
      followersCount: 10,
      followingCount: 5,
      followers: [{ username: 'a' }],
      following: [{ username: 'b' }],
    },
    followersCount: 10,
    followingCount: 5,
    ratings: { averageRating: 4.5, totalRatingCount: 20, recent: [{ stars: 5 }] },
    recentRatings: [{ stars: 5 }],
    stats: { totalOrders: 100, avgRating: 4.5, ratingCount: 20, memberSince: '2020-01-01' },
  };
}

function makePrivacy(overrides: Partial<PrivacySettingLike> = {}): PrivacySettingLike {
  return { ...DEFAULT_PRIVACY_SETTING, ...overrides };
}

const contact: AccountContactInfo = {
  email: 'user@example.com',
  phone: '+6281234567890',
  dateOfBirth: '1990-01-01',
  gender: 'MALE',
};

const stranger: PrivacyViewerContext = { isOwnProfile: false, viewerFollowsOwner: false };
const follower: PrivacyViewerContext = { isOwnProfile: false, viewerFollowsOwner: true };

describe('applyPrivacyToPublicProfile', () => {
  it('profil sendiri: tidak ada redaksi', () => {
    const privacy = makePrivacy({ showEmail: false, showReviews: false });
    const out = applyPrivacyToPublicProfile(makeProfile(), contact, privacy, {
      isOwnProfile: true,
      viewerFollowsOwner: false,
    });
    expect(out.social.followersCount).toBe(10);
    expect(out.ratings.recent).toHaveLength(1);
    expect(out.accountContact.email).toBe('user@example.com');
  });

  it('G076: kontak identitas default disembunyikan, tampil bila opt-in', () => {
    const hidden = applyPrivacyToPublicProfile(makeProfile(), contact, makePrivacy(), stranger);
    expect(hidden.accountContact.email).toBeNull();
    expect(hidden.accountContact.phone).toBeNull();
    expect(hidden.accountContact.dateOfBirth).toBeNull();
    expect(hidden.accountContact.gender).toBeNull();

    const shown = applyPrivacyToPublicProfile(
      makeProfile(),
      contact,
      makePrivacy({ showEmail: true, showPhone: true }),
      stranger,
    );
    expect(shown.accountContact.email).toBe('user@example.com');
    expect(shown.accountContact.phone).toBe('+6281234567890');
    expect(shown.accountContact.dateOfBirth).toBeNull();
  });

  it('G077: daftar follower menghormati visibilitas', () => {
    const onlyMe = applyPrivacyToPublicProfile(
      makeProfile(), contact, makePrivacy({ showFollowerList: 'ONLY_ME' }), follower,
    );
    expect(onlyMe.social.followers).toEqual([]);
    expect(onlyMe.social.followersCount).toBeNull();
    // Alias deprecated ikut dibersihkan — tidak bocor lewat jalur lama.
    expect(onlyMe.followersCount).toBeNull();

    const followersOnly = applyPrivacyToPublicProfile(
      makeProfile(), contact, makePrivacy({ showFollowerList: 'FOLLOWERS' }), follower,
    );
    expect(followersOnly.social.followersCount).toBe(10);

    const blocked = applyPrivacyToPublicProfile(
      makeProfile(), contact, makePrivacy({ showFollowerList: 'FOLLOWERS' }), stranger,
    );
    expect(blocked.social.followers).toEqual([]);
  });

  it('G081: ulasan disembunyikan bila showReviews=false', () => {
    const out = applyPrivacyToPublicProfile(
      makeProfile(), contact, makePrivacy({ showReviews: false }), stranger,
    );
    expect(out.ratings.recent).toEqual([]);
    expect(out.ratings.averageRating).toBeNull();
    expect(out.recentRatings).toEqual([]);
  });

  it('G082: statistik tersembunyi dinull-kan satu per satu', () => {
    const out = applyPrivacyToPublicProfile(
      makeProfile(), contact, makePrivacy({ hiddenStats: ['totalOrders', 'memberSince'] }), stranger,
    );
    expect(out.stats.totalOrders).toBeNull();
    expect(out.stats.memberSince).toBeNull();
    expect(out.stats.avgRating).toBe(4.5);
    expect(out.stats.ratingCount).toBe(20);
  });
});

describe('canViewList', () => {
  it('EVERYONE selalu bisa; ONLY_ME hanya owner; FOLLOWERS butuh relasi', () => {
    expect(canViewList('EVERYONE', stranger)).toBe(true);
    expect(canViewList('ONLY_ME', stranger)).toBe(false);
    expect(canViewList('ONLY_ME', { isOwnProfile: true, viewerFollowsOwner: false })).toBe(true);
    expect(canViewList('FOLLOWERS', stranger)).toBe(false);
    expect(canViewList('FOLLOWERS', follower)).toBe(true);
  });
});

describe('resolveAccountContact', () => {
  it('owner selalu melihat datanya sendiri', () => {
    const out = resolveAccountContact(contact, makePrivacy(), {
      isOwnProfile: true,
      viewerFollowsOwner: false,
    });
    expect(out.email).toBe('user@example.com');
  });
});
