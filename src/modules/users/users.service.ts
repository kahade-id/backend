import { Injectable, NotFoundException, BadRequestException, ConflictException, ForbiddenException, Logger, Optional, PayloadTooLargeException } from '@nestjs/common';
import { ActionLocationService, type ActionLocationContext } from '../action-location/action-location.service';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service';
import { RedisService } from '../../redis/redis.service';
import { Gender, KycStatus, NotificationType, OrderStatus, Prisma, UserAuditAction, WalletTransactionType, WithdrawStatus } from '@prisma/client';
import { AuditLogService } from '../../common/services/audit-log.service';
import { toIdr } from '../../common/utils/currency.util';
import { bcryptCompare, decryptAES, sha256 } from '../../common/utils/crypto.util';
import { decryptPiiSafe } from '../../common/utils/pii.util';
import * as speakeasy from 'speakeasy';
import { parseJwtTtl } from '../../common/utils/jwt.util';
import { nanoid } from 'nanoid';
import { randomBytes, randomInt, randomUUID } from 'crypto';
import * as path from 'path';
import * as ErrorCodes from '../../common/constants/error-codes';
import { MAX_LIMIT, RESERVED_USERNAMES } from '../../common/constants/app.constants';
import { ReportFlagService } from '../../common/services/report-flag.service';
import { LocalStorageService } from '../upload/local-storage.service';
import { stripImageMetadata } from '../upload/utils/strip-image-metadata';
import { TOKEN_BLACKLIST, SESSION_REVOKED_KEY, TOTP_USED_CODE } from '../../common/constants/redis-keys';
import { UpdateProfileDto } from './dto/update-profile.dto';
import { ReportUserDto } from './dto/report-user.dto';
import { UpdateLinksDto } from './dto/update-links.dto';
import { OgMetadataService } from './og-metadata.service';
import { VerificationBadgeService } from './verification-badge.service';
import { UserAnalyticsService } from './user-analytics.service';
import {
  applyPrivacyToPublicProfile,
  canViewList,
  loadPrivacySetting,
  type AccountContactInfo,
} from './privacy-profile.util';
import { generateNotifId } from '../../common/utils/id-generator.util';
import { getCategoryForType } from '../notifications/notification-category.map';
import { verifyOtp } from '../../common/utils/otp.util';
import { escapeLikePattern } from '../../common/utils/search.util';
import { AccountDeletionService, DeletionRequestResult } from './account-deletion.service';

/** Jumlah baris preview yang ikut di payload profil publik. List lengkap tetap
 * lewat endpoint paginasi masing-masing (followers/following/favorites). */
const PROFILE_SOCIAL_PREVIEW_LIMIT = 6;
const PROFILE_FAVORITES_PREVIEW_LIMIT = 12;
const PROFILE_RECENT_RATINGS_LIMIT = 5;

@Injectable()
export class UsersService {
  private readonly logger = new Logger(UsersService.name);

  constructor(
    private prisma: PrismaService,
    private redis: RedisService,
    private configService: ConfigService,
    private auditLog: AuditLogService,
    private ogMetadataService: OgMetadataService,
    private verificationBadgeService: VerificationBadgeService,
    // TrustScore profil publik — reuse logika UserAnalyticsService (satu sumber,
    // tanpa duplikasi rumus). Service ini hanya bergantung pada PrismaService,
    // jadi tidak ada circular dependency.
    private userAnalyticsService: UserAnalyticsService,
    // Section 6: agregasi laporan -> flag moderasi internal.
    private reportFlagService: ReportFlagService,
    // Self-hosted storage (2026-09-26, SS-007/ST-007): avatar & cover kini
    // disimpan di disk server, bukan R2.
    private localStorage: LocalStorageService,
    // GAP-A: status & pembatalan penghapusan akun (request row, OTP, cancel).
    private accountDeletionService: AccountDeletionService,
    // Lokasi presisi aksi sensitif — @Optional() agar unit test lama yang
    // tidak menyediakan provider tetap lolos.
    @Optional() private actionLocationService?: ActionLocationService,
  ) {}

  async getMyProfile(userId: string): Promise<object> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: {
        wallet: { select: { availableBalance: true, escrowBalance: true, totalBalance: true } },
        badges: { select: { badge: { select: { name: true, iconUrl: true, description: true } }, earnedAt: true } },
        twoFactorAuth: { select: { isEnabled: true } },
      },
    });
    if (!user) throw new NotFoundException({ code: ErrorCodes.USER_NOT_FOUND, message: 'User not found' });

    const decryptedPhone = await decryptPiiSafe(user.phoneNumber);

    return {
      id: user.id, userId: user.userId, username: user.username, email: user.email,
      fullName: user.fullName, avatarUrl: user.avatarUrl, headerUrl: user.headerUrl,
      accountType: user.accountType,
      bio: user.bio, emailVerified: user.emailVerified, kycStatus: user.kycStatus,
      kycApprovedAt: user.kycApprovedAt, membershipRank: user.membershipRank,
      rankUpdatedAt: user.rankUpdatedAt, isKahadePlus: user.isKahadePlus,
      subscriptionExpiresAt: user.subscriptionExpiresAt,
      isActive: user.isActive,
      isBanned: user.isBanned,
      createdAt: user.createdAt,
      phoneNumber: decryptedPhone,
      phoneVerified: user.phoneVerified,
      dateOfBirth: user.dateOfBirth,
      gender: user.gender,
      language: user.language,
      contactEmail: user.contactEmail,
      contactPhone: user.contactPhone,
      showContactEmail: user.showContactEmail,
      showContactPhone: user.showContactPhone,
      usernameChangedAt: user.usernameChangedAt,
      passwordChangedAt: user.passwordChangedAt,
      isMfaEnabled: user.twoFactorAuth?.isEnabled ?? false,
      wallet: user.wallet ? {
        availableBalance: toIdr(user.wallet.availableBalance),
        escrowBalance: toIdr(user.wallet.escrowBalance),
        totalBalance: toIdr(user.wallet.totalBalance),
      } : null,
      badges: user.badges.map((ub: { badge: { name: string; iconUrl: string | null; description: string | null }; earnedAt: Date }) => ({ ...ub.badge, earnedAt: ub.earnedAt })),
      stats: {
        totalOrdersCompleted: user.totalOrdersCompleted,
        totalTransactionValue: user.totalTransactionValue ? toIdr(user.totalTransactionValue as bigint) : 0,
        averageRating: Number(user.averageRating ?? 0),
        totalRatingCount: user.totalRatingCount,
        memberSince: user.memberSince,
      },
    };
  }

  async updateProfile(userId: string, dto: UpdateProfileDto): Promise<object> {
    if (dto.phoneNumber !== undefined) {
      throw new BadRequestException({
        code: 'PHONE_CHANGE_REQUIRES_VERIFICATION',
        message: 'Use the dedicated phone-change verification flow to update your phone number.',
      });
    }

    const hasSensitiveField =
      dto.username !== undefined ||
      dto.contactEmail !== undefined ||
      dto.contactPhone !== undefined;

    if (hasSensitiveField) {
      const currentUser = await this.prisma.user.findUnique({
        where: { id: userId },
        select: { password: true, username: true, contactEmail: true, contactPhone: true },
      });
      if (!currentUser) throw new NotFoundException({ code: ErrorCodes.USER_NOT_FOUND, message: 'User not found' });

      const actuallyChanged =
        (dto.username !== undefined && (dto.username?.toLowerCase() ?? null) !== (currentUser.username ?? null)) ||
        (dto.contactEmail !== undefined && (dto.contactEmail || null) !== (currentUser.contactEmail ?? null)) ||
        (dto.contactPhone !== undefined && (dto.contactPhone || null) !== (currentUser.contactPhone ?? null));

      if (actuallyChanged) {
        if (!dto.currentPassword) {
          throw new BadRequestException({
            code: ErrorCodes.VALIDATION_ERROR,
            message: 'Password is required to change username, phone number, or contact info',
          });
        }
        if (!currentUser.password) {
          throw new BadRequestException({ code: ErrorCodes.INVALID_CREDENTIALS, message: 'Password login is not configured for this account' });
        }
        const passwordValid = await bcryptCompare(dto.currentPassword, currentUser.password);
        if (!passwordValid) {
          throw new BadRequestException({ code: ErrorCodes.INVALID_CREDENTIALS, message: 'Password salah' });
        }
      }
    }

    const updateData: Prisma.UserUpdateInput = {};
    if (dto.fullName !== undefined) updateData.fullName = dto.fullName;
    if (dto.bio !== undefined) updateData.bio = dto.bio || null;
    if (dto.contactEmail !== undefined) updateData.contactEmail = dto.contactEmail || null;
    if (dto.contactPhone !== undefined) updateData.contactPhone = dto.contactPhone || null;
    if (dto.dateOfBirth !== undefined) {
      if (dto.dateOfBirth) {
        const [y, m, d] = dto.dateOfBirth.split('-').map(Number);
        updateData.dateOfBirth = new Date(Date.UTC(y, m - 1, d));
      } else {
        updateData.dateOfBirth = null;
      }
    }
    if (dto.gender !== undefined) updateData.gender = dto.gender ? (dto.gender as Gender) : null;
    if (dto.showContactEmail !== undefined) updateData.showContactEmail = dto.showContactEmail;
    if (dto.showContactPhone !== undefined) updateData.showContactPhone = dto.showContactPhone;
    if (dto.profileVisible !== undefined) updateData.profileVisible = dto.profileVisible;
    if (dto.showOnlineStatus !== undefined) updateData.showOnlineStatus = dto.showOnlineStatus;

    if (dto.username !== undefined) {
      const currentUser = await this.prisma.user.findUnique({ where: { id: userId }, select: { username: true, usernameChangedAt: true } });
      if (!currentUser) throw new NotFoundException({ code: ErrorCodes.USER_NOT_FOUND, message: 'User not found' });

      const normalizedUsername = dto.username.toLowerCase();
      if (normalizedUsername !== (currentUser.username ?? '')) {
        // AUDIT-22: mirror auth.setUsername's reserved-name and shape rules; without them,
        // register/setUsername blocklist could be bypassed by renaming to `admin`/`support`
        // via profile update (impersonation).
        if (RESERVED_USERNAMES.includes(normalizedUsername)) {
          throw new BadRequestException({
            code: ErrorCodes.USERNAME_RESERVED,
            message: 'Username is reserved and cannot be used',
          });
        }
        if (
          !/^[a-z0-9][a-z0-9._-]*[a-z0-9]$/.test(normalizedUsername) &&
          normalizedUsername.length > 2
        ) {
          throw new BadRequestException({
            code: ErrorCodes.VALIDATION_ERROR,
            message:
              'Username must start and end with a letter or number, and can only contain letters, numbers, dots, underscores, and hyphens',
          });
        }
        if (/[._-]{2,}/.test(normalizedUsername)) {
          throw new BadRequestException({
            code: ErrorCodes.VALIDATION_ERROR,
            message: 'Username cannot contain consecutive special characters',
          });
        }
        if (currentUser.usernameChangedAt) {
          const daysSinceChange = (Date.now() - currentUser.usernameChangedAt.getTime()) / (1000 * 60 * 60 * 24);
          if (daysSinceChange < 30) {
            const daysLeft = Math.ceil(30 - daysSinceChange);
            throw new BadRequestException({
              code: ErrorCodes.USERNAME_CHANGE_COOLDOWN,
              message: `Username hanya bisa diubah setiap 30 hari. Tunggu ${daysLeft} hari lagi.`,
            });
          }
        }

        const existing = await this.prisma.user.findUnique({ where: { username: normalizedUsername }, select: { id: true } });
        if (existing && existing.id !== userId) {
          throw new ConflictException({ code: ErrorCodes.USERNAME_TAKEN, message: 'Username is already taken' });
        }

        updateData.username = normalizedUsername;
        updateData.usernameChangedAt = new Date();
      }
    }

    const oldUser = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { username: true },
    });

    let user: Record<string, any>;
    let tfa: { isEnabled: boolean } | null;
    try {
      [user, tfa] = await Promise.all([
        this.prisma.user.update({
          where: { id: userId },
          data: updateData,
          select: {
            id: true, userId: true, username: true, email: true,
            fullName: true, bio: true, accountType: true, avatarUrl: true, headerUrl: true,
            emailVerified: true, kycStatus: true, membershipRank: true,
            language: true,
            isKahadePlus: true, subscriptionExpiresAt: true,
            isActive: true, isBanned: true,
            phoneNumber: true, phoneVerified: true, dateOfBirth: true, gender: true,
            contactEmail: true, contactPhone: true, showContactEmail: true, showContactPhone: true,
            usernameChangedAt: true,
            createdAt: true,
          },
        }),
        this.prisma.twoFactorAuth.findUnique({ where: { userId }, select: { isEnabled: true } }),
      ]);
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        const target = Array.isArray(error.meta?.target) ? error.meta.target.map(String) : [];
        if (target.includes('username')) {
          throw new ConflictException({ code: ErrorCodes.USERNAME_TAKEN, message: 'Username is already taken' });
        }
      }
      throw error;
    }

    if (dto.profileVisible !== undefined || dto.showOnlineStatus !== undefined) {
      await this.redis.del(`user_privacy:${userId}`).catch((err) =>
        this.logger.warn(`Failed to invalidate privacy cache for ${userId}: ${(err as Error).message}`),
      );
    }

    this.invalidateUserOgCaches(oldUser?.username, user.username);

    const decryptedPhone = await decryptPiiSafe(user.phoneNumber);
    return { ...user, phoneNumber: decryptedPhone, isMfaEnabled: tfa?.isEnabled ?? false };
  }

  /**
   * Section 2 — Profile Core.
   *
   * Endpoint publik `GET /users/:username`. Payload dikelompokkan per bagian
   * secara EKSPLISIT (identity / contact / links / social / favorites / badges /
   * about / ratings) supaya UI tidak perlu merakit sendiri dari field datar.
   *
   * Penegakan privasi:
   *  - `profileVisible` false, nonaktif, banned, atau soft-deleted -> 404
   *    (identik dengan sebelumnya; tidak membocorkan keberadaan akun)
   *  - ADA relasi block antara viewer dan owner (dua arah) -> 403 USER_BLOCKED.
   *    Sebelumnya endpoint ini hanya menyembunyikan field; sekarang seluruh
   *    endpoint ditolak, mengikuti pola block-list enforcement di
   *    user-search.service.ts dan orders.service.ts.
   *  - `contact.email` / `contact.phone` hanya terisi bila toggle
   *    showContactEmail/showContactPhone aktif, dan dipaksa null bila ada relasi
   *    block (defensive — jalur normalnya sudah 403 lebih dulu).
   *
   * Field datar lama (username, fullName, isKycVerified, isVip, stats, ...)
   * DIPERTAHANKAN sebagai alias deprecated agar client lama tidak putus selama
   * migrasi ke bentuk bersarang.
   */
  async getPublicProfile(username: string, viewerId?: string): Promise<object> {
    const user = await this.prisma.user.findUnique({
      where: { username: username.toLowerCase() },
      select: {
        id: true, userId: true, username: true, fullName: true, avatarUrl: true, headerUrl: true,
        accountType: true, bio: true, kycStatus: true, isVip: true, membershipRank: true,
        totalOrdersCompleted: true, averageRating: true, totalRatingCount: true, memberSince: true,
        // G076: field identitas untuk kontrol visibilitas granular (direduksi di bawah).
        email: true, phoneNumber: true, dateOfBirth: true, gender: true,
        // BUG#5: field tambahan khusus untuk menghitung trustScore publik
        // (reuse UserAnalyticsService.calculateTrustScore — tanpa duplikasi rumus).
        totalOrdersCancelled: true, totalOrdersDisputed: true, createdAt: true, isKahadePlus: true,
        profileVisible: true, showContactEmail: true, contactEmail: true, showContactPhone: true, contactPhone: true,
        isActive: true, isBanned: true, deletedAt: true,
        // Achievement badge (model Badge/UserBadge) — berbeda dari badge verifikasi.
        badges: { select: { badge: { select: { name: true, iconUrl: true, description: true } }, earnedAt: true } },
        ratingsReceived: {
          // Section 5: `profileVisible: true` ditambahkan supaya preview rating
          // di profil memakai aturan visibilitas yang sama persis dengan
          // GET /users/:username/ratings — pemberi rating yang menyembunyikan
          // profilnya tidak boleh muncul di satu tempat tapi hilang di tempat
          // lain (dan memang tidak seharusnya ditampilkan sama sekali).
          where: { isHidden: false, giver: { isActive: true, isBanned: false, deletedAt: null, profileVisible: true } },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], // tiebreak { id } — halaman stabil
          take: PROFILE_RECENT_RATINGS_LIMIT,
          select: { stars: true, comment: true, createdAt: true, giver: { select: { username: true, avatarUrl: true } },
            // BFI-128 (audit integrasi 2026-09-30): sertakan balasan rating
            // (aditif). Balasan yang disembunyikan tidak bocor ke publik.
            reply: { where: { isHidden: false }, select: { content: true, createdAt: true, replier: { select: { username: true, avatarUrl: true } } } },
          },
        },
        links: {
          orderBy: [{ displayOrder: 'asc' }, { id: 'asc' }],
          select: { id: true, platform: true, url: true, label: true, displayOrder: true },
        },
      },
    });
    if (!user) throw new NotFoundException({ code: ErrorCodes.USER_NOT_FOUND, message: 'User not found' });

    if (!user.profileVisible || user.isActive === false || user.isBanned === true || user.deletedAt != null) {
      throw new NotFoundException({ code: ErrorCodes.USER_NOT_FOUND, message: 'User not found' });
    }

    const isOwnProfile = Boolean(viewerId && viewerId === user.id);

    // Block-list enforcement: relasi block dua arah menutup seluruh endpoint.
    if (viewerId && !isOwnProfile) {
      const block = await this.prisma.blockList.findFirst({
        where: {
          OR: [
            { blockerId: user.id, blockedId: viewerId },
            { blockerId: viewerId, blockedId: user.id },
          ],
        },
        select: { id: true, blockerId: true },
      });
      if (block) {
        throw new ForbiddenException({
          code: ErrorCodes.USER_BLOCKED,
          message: 'This profile is not accessible',
        });
      }
    }

    // Setelah gate block lolos, semua query turunan bisa jalan paralel.
    const excludedIds = await this.getViewerExcludedIds(viewerId ?? undefined);
    const visibleUserFilter: Prisma.UserWhereInput = {
      isActive: true,
      isBanned: false,
      deletedAt: null,
      profileVisible: true,
      ...(excludedIds.length > 0 ? { id: { notIn: excludedIds } } : {}),
    };

    const [followRow, followedByRow, favoriteRow, followerPreview, followingPreview, favorites, verificationBadges, followersCount, followingCount] =
      await Promise.all([
        viewerId && !isOwnProfile
          ? this.prisma.follow.findUnique({
              where: { followerId_followingId: { followerId: viewerId, followingId: user.id } },
              select: { id: true },
            })
          : Promise.resolve(null),
        viewerId && !isOwnProfile
          ? this.prisma.follow.findUnique({
              where: { followerId_followingId: { followerId: user.id, followingId: viewerId } },
              select: { id: true },
            })
          : Promise.resolve(null),
        viewerId && !isOwnProfile
          ? this.prisma.userFavorite.findUnique({
              where: { userId_favoriteUserId: { userId: viewerId, favoriteUserId: user.id } },
              select: { id: true },
            })
          : Promise.resolve(null),
        this.prisma.follow.findMany({
          where: { followingId: user.id, follower: visibleUserFilter },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take: PROFILE_SOCIAL_PREVIEW_LIMIT,
          select: { follower: { select: { username: true, fullName: true, avatarUrl: true } } },
        }),
        this.prisma.follow.findMany({
          where: { followerId: user.id, following: visibleUserFilter },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take: PROFILE_SOCIAL_PREVIEW_LIMIT,
          select: { following: { select: { username: true, fullName: true, avatarUrl: true } } },
        }),
        this.prisma.userFavorite.findMany({
          where: { userId: user.id, favoriteUser: visibleUserFilter },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take: PROFILE_FAVORITES_PREVIEW_LIMIT,
          select: {
            createdAt: true,
            favoriteUser: { select: { userId: true, username: true, fullName: true, avatarUrl: true } },
          },
        }),
        this.verificationBadgeService.getBadges(user.id),
        // SS-019: counter memakai visibleUserFilter yang SAMA PERSIS dengan
        // GET /users/:username/followers|following → angka profil == total list
        // untuk viewer yang sama (termasuk eksklusi block khusus viewer).
        this.prisma.follow.count({ where: { followingId: user.id, follower: visibleUserFilter } }),
        this.prisma.follow.count({ where: { followerId: user.id, following: visibleUserFilter } }),
      ]);

    const favoritesTotal = await this.prisma.userFavorite.count({
      where: { userId: user.id, favoriteUser: visibleUserFilter },
    });

    // Kontak publik: hormati toggle, dan paksa null bila ada relasi block.
    // (Gate di atas sudah 403 untuk block, guard ini menjaga bila kelak ada
    // jalur lain yang memanggil method ini dengan viewer terblokir.)
    const contactAllowed = !viewerId || isOwnProfile;
    const publicContact = {
      email: contactAllowed && user.showContactEmail ? user.contactEmail : null,
      phone: contactAllowed && user.showContactPhone ? user.contactPhone : null,
    };

    // "Tentang": tanggal akun dibuat + tanggal tiap badge didapat.
    const badgeEarnedDates: Record<string, string | null> = {};
    for (const badge of verificationBadges) {
      badgeEarnedDates[badge.type] = badge.earnedAt ? badge.earnedAt.toISOString() : null;
    }

    // BUG#5: trustScore profil publik — dihitung dengan rumus yang SAMA
    // dengan endpoint GET /v1/users/me/trust-score (UserAnalyticsService),
    // tanpa duplikasi logika. Nilainya publik by-design (ditampilkan di tab
    // "Tentang" profil siapa pun).
    const publicTrustScore = this.userAnalyticsService.calculateTrustScore({
      totalOrdersCompleted: user.totalOrdersCompleted,
      totalOrdersCancelled: user.totalOrdersCancelled,
      totalOrdersDisputed: user.totalOrdersDisputed,
      averageRating: user.averageRating,
      totalRatingCount: user.totalRatingCount,
      kycStatus: user.kycStatus,
      isKahadePlus: user.isKahadePlus,
      createdAt: user.createdAt,
    });

    // G076–G083: muat pengaturan privasi pemilik & terapkan untuk viewer != owner.
    const privacy = await loadPrivacySetting(this.prisma, user.id);
    const accountContact: AccountContactInfo = {
      email: user.email,
      phone: await decryptPiiSafe(user.phoneNumber),
      dateOfBirth: user.dateOfBirth ? user.dateOfBirth.toISOString().slice(0, 10) : null,
      gender: user.gender ? String(user.gender) : null,
    };

    const profile = {
      // ================= Identity =================
      identity: {
        userId: user.userId,
        nickname: user.fullName,
        username: user.username,
        bio: user.bio,
        avatarUrl: user.avatarUrl,
        headerUrl: user.headerUrl,
        accountType: user.accountType,
        membershipRank: user.membershipRank,
      },

      // ================= Kontak publik =================
      contact: publicContact,

      // ================= Sosial media / link =================
      links: user.links,

      // ================= Follower / following =================
      social: {
        followersCount,
        followingCount,
        isFollowing: Boolean(followRow),
        isFollowedBy: Boolean(followedByRow),
        // Preview saja — list lengkap lewat GET /users/:username/followers|following
        followers: followerPreview.map((f) => f.follower),
        following: followingPreview.map((f) => f.following),
      },

      // ================= Favorit =================
      favorites: {
        total: favoritesTotal,
        isFavoritedByViewer: Boolean(favoriteRow),
        items: favorites.map((f) => ({ ...f.favoriteUser, favoritedAt: f.createdAt })),
      },

      // ================= Badge verifikasi (Section 1) =================
      badges: verificationBadges,

      // ================= Tentang =================
      about: {
        memberSince: user.memberSince,
        badgeEarnedDates,
        contact: publicContact,
      },

      // ================= Rating (Section 5) =================
      ratings: {
        averageRating: Number(user.averageRating ?? 0),
        totalRatingCount: user.totalRatingCount,
        recent: user.ratingsReceived,
      },

      stats: {
        totalOrders: user.totalOrdersCompleted,
        avgRating: Number(user.averageRating ?? 0),
        ratingCount: user.totalRatingCount,
        memberSince: user.memberSince,
      },

      // Achievement badge (katalog Badge/UserBadge) — sengaja dipisah dari badge
      // verifikasi agar UI bisa menampilkan keduanya di tempat berbeda.
      achievementBadges: user.badges.map(
        (ub: { badge: { name: string; iconUrl: string | null; description: string | null }; earnedAt: Date }) => ({
          ...ub.badge,
          earnedAt: ub.earnedAt,
        }),
      ),

      viewer: {
        isOwnProfile,
        isAuthenticated: Boolean(viewerId),
      },

      // ------------------------------------------------------------------
      // DEPRECATED flat aliases — dipertahankan agar client lama tidak putus.
      // Gunakan bagian bersarang di atas untuk kode baru.
      // ------------------------------------------------------------------
      userId: user.userId,
      username: user.username,
      fullName: user.fullName,
      avatarUrl: user.avatarUrl,
      headerUrl: user.headerUrl,
      accountType: user.accountType,
      bio: user.bio,
      isKycVerified: user.kycStatus === KycStatus.APPROVED,
      // BUG#5: skor kepercayaan publik — dihitung di atas via UserAnalyticsService
      // (rumus sama dengan GET /v1/users/me/trust-score). Dibaca frontend sebagai
      // `profile.trustScore` untuk tab "Tentang".
      trustScore: publicTrustScore,
      isVip: user.isVip,
      membershipRank: user.membershipRank,
      recentRatings: user.ratingsReceived,
      followersCount,
      followingCount,
      isFollowing: Boolean(followRow),
      // Viewer yang memblokir owner: sebelumnya field ini satu-satunya sinyal,
      // sekarang relasi block apa pun sudah ditolak 403 di atas. Dipertahankan
      // sebagai alias yang selalu false supaya bentuk response tidak berubah.
      isBlocked: false,
    };

    // G076–G083: redaksi sesuai PrivacySetting pemilik bila viewer bukan owner.
    // followRow dihitung di atas (null bila viewer == owner / anonim).
    return applyPrivacyToPublicProfile(profile, accountContact, privacy, {
      isOwnProfile,
      viewerFollowsOwner: Boolean(followRow),
    });
  }

  async getMyStats(userId: string): Promise<object> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true, membershipRank: true, averageRating: true, totalRatingCount: true,
        totalTransactionValue: true,
        totalOrdersAsBuyer: true, totalOrdersAsSeller: true,
        totalOrdersCompleted: true, totalOrdersCancelled: true, totalOrdersDisputed: true,
        _count: { select: { followers: true, following: true } },
      },
    });
    if (!user) throw new NotFoundException({ code: ErrorCodes.USER_NOT_FOUND, message: 'User not found' });

    const hasCounters = (user.totalOrdersCompleted ?? 0) > 0 ||
                        (user.totalOrdersAsBuyer ?? 0) > 0;

    let completedOrders: number, cancelledOrders: number, disputedOrders: number, totalOrders: number;

    if (hasCounters) {
      completedOrders = user.totalOrdersCompleted ?? 0;
      cancelledOrders = user.totalOrdersCancelled ?? 0;
      disputedOrders = user.totalOrdersDisputed ?? 0;
      totalOrders = (user.totalOrdersAsBuyer ?? 0) + (user.totalOrdersAsSeller ?? 0);
    } else {
      // Fallback: single groupBy query instead of 5 separate COUNT queries
      const counts = await this.prisma.order.groupBy({
        by: ['status'],
        where: { OR: [{ buyerId: userId }, { sellerId: userId }] },
        _count: { _all: true },
      });
      const byStatus = Object.fromEntries(counts.map((c) => [c.status, c._count._all]));
      completedOrders = byStatus[OrderStatus.COMPLETED] ?? 0;
      cancelledOrders = byStatus[OrderStatus.CANCELLED] ?? 0;
      disputedOrders = byStatus[OrderStatus.DISPUTED] ?? 0;
      totalOrders = counts.reduce((sum: number, c) => sum + c._count._all, 0);
    }

    return {
      totalOrders, completedOrders, cancelledOrders, disputedOrders,
      totalTransactionValue: user.totalTransactionValue ? toIdr(user.totalTransactionValue as bigint) : 0,
      avgRating: Number(user.averageRating ?? 0), ratingCount: user.totalRatingCount, membershipRank: user.membershipRank,
      followersCount: user._count.followers,
      followingCount: user._count.following,
      rankProgress: { currentRank: user.membershipRank, nextRank: this.getNextRank(user.membershipRank), requirements: [] },
    };
  }

  async searchUsers(query: string, page: number, limit: number, viewerId?: string): Promise<object> {
    if (!query || query.trim().length < 2) {
      throw new BadRequestException({
        code: ErrorCodes.VALIDATION_ERROR,
        message: 'Search query must be at least 2 characters long',
      });
    }

    const { page: safePage, limit: safeLimit, skip } = this.normalizePagination(page, limit);

    const sanitizedQuery = query.replace(/[<>&"']/g, '').trim();

    type UserRow = {
      id: string;
      userId: string;
      username: string | null;
      fullName: string;
      avatarUrl: string | null;
      membershipRank: string;
    };
    type CountRow = { count: bigint };

    const lowerQuery = sanitizedQuery.toLowerCase();

    let blockedIds: string[] = [];
    if (viewerId) {
      const blocks = await this.prisma.blockList.findMany({
        where: { OR: [{ blockerId: viewerId }, { blockedId: viewerId }] },
        select: { blockerId: true, blockedId: true },
      });
      const idSet = new Set<string>();
      for (const b of blocks) {
        if (b.blockerId !== viewerId) idSet.add(b.blockerId);
        if (b.blockedId !== viewerId) idSet.add(b.blockedId);
      }
      blockedIds = Array.from(idSet);
    }

    const blockedFilter = blockedIds.length > 0
      ? Prisma.sql`AND id NOT IN (${Prisma.join(blockedIds)})`
      : Prisma.empty;

    const [users, countResult] = await Promise.all([
      this.prisma.$queryRaw<UserRow[]>`
        SELECT id, "userId", username, "fullName", "avatarUrl", "membershipRank"
        FROM users
        WHERE "isActive" = true
          AND "isBanned" = false
          AND "deletedAt" IS NULL
          AND "profileVisible" = true
          AND to_tsvector('simple', coalesce(username, '') || ' ' || "fullName")
              @@ plainto_tsquery('simple', ${sanitizedQuery})
          ${blockedFilter}
        ORDER BY
          CASE WHEN lower(coalesce(username, '')) = ${lowerQuery} THEN 0
               WHEN lower(coalesce(username, '')) LIKE ${lowerQuery + '%'} THEN 1
               ELSE 2 END,
          "totalOrdersCompleted" DESC
        LIMIT ${safeLimit} OFFSET ${skip}
      `,
      this.prisma.$queryRaw<CountRow[]>`
        SELECT COUNT(*)::bigint AS count
        FROM users
        WHERE "isActive" = true
          AND "isBanned" = false
          AND "deletedAt" IS NULL
          AND "profileVisible" = true
          AND to_tsvector('simple', coalesce(username, '') || ' ' || "fullName")
              @@ plainto_tsquery('simple', ${sanitizedQuery})
          ${blockedFilter}
      `,
    ]);

    const total = Number(countResult[0]?.count ?? 0);
    // R1 (audit 2026-09-26): sematkan sealTier agar frontend bisa render
    // <VerifiedSeal> di hasil pencarian user tanpa N+1 request badge.
    // getSealTierMap dikunci oleh id internal — id publik USR-XXXX tidak dipakai.
    const sealTierMap = await this.verificationBadgeService.getSealTierMap(
      users.map((u) => u.id),
    );
    const mapped = users.map((u: UserRow) => ({
      userId: u.userId,
      username: u.username,
      fullName: u.fullName,
      avatarUrl: u.avatarUrl,
      membershipRank: u.membershipRank,
      sealTier: sealTierMap.get(u.id) ?? null,
    }));

    return { users: mapped, total, page: safePage, limit: safeLimit };
  }

  async checkUsernameAvailability(username: string): Promise<object> {
    const existingUser = await this.prisma.user.findUnique({ where: { username: username.toLowerCase() }, select: { id: true } });
    return {
      available: !existingUser,
      suggestion: existingUser ? this.generateUsernameSuggestion(username) : undefined,
    };
  }

  /**
   * Math.random() is not suitable for security-adjacent code even for username suggestions.
   * randomBytes(3) produces a 6-hex-character string that is cryptographically unpredictable.
   */
  private generateUsernameSuggestion(username: string): string {
    const suffix = randomBytes(3).toString('hex');
    return `${username.toLowerCase()}${suffix}`;
  }

  private invalidateUserOgCaches(...usernames: Array<string | null | undefined>): void {
    for (const username of new Set(usernames.filter((value): value is string => Boolean(value)))) {
      this.ogMetadataService.invalidateUserOgCache(username).catch((err) =>
        this.logger.warn(`Failed to invalidate OG cache for ${username}: ${(err as Error).message}`),
      );
    }
  }

  private getNextRank(currentRank: string): string | null {
    const ranks = ['BRONZE', 'SILVER', 'GOLD', 'PLATINUM', 'DIAMOND'];
    const currentIndex = ranks.indexOf(currentRank);
    return currentIndex < ranks.length - 1 ? ranks[currentIndex + 1] : null;
  }

  private normalizePagination(page: number, limit: number): { page: number; limit: number; skip: number } {
    const safePage = Number.isFinite(page) ? Math.max(1, Math.floor(page)) : 1;
    const safeLimit = Number.isFinite(limit) ? Math.min(MAX_LIMIT, Math.max(1, Math.floor(limit))) : MAX_LIMIT;
    return { page: safePage, limit: safeLimit, skip: (safePage - 1) * safeLimit };
  }

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

  // R2-F (audit): presigned PUTs cannot be size-capped by the browser, so the
  // interceptor limits only cover the direct-upload routes. The confirm endpoints
  // therefore reject oversized stored objects before publishing the key,
  // matching the direct-path caps (avatar 2 MB, header 5 MB).
  // Self-hosted (2026-09-26, SS-007/ST-007): verifikasi ke disk lokal via
  // LocalStorageService — helper S3/R2 sudah dihapus.
  private static readonly MAX_AVATAR_BYTES = 2 * 1024 * 1024;
  private static readonly MAX_HEADER_BYTES = 5 * 1024 * 1024;

  /**
   * Hapus file media lama dari self-hosted disk (best-effort, quiet).
   * Self-hosted (2026-09-26, SS-007/ST-007): R2 diganti LocalStorageService.
   */
  private async deleteStoredMediaQuietly(previousUrl: string | null | undefined, newKey: string): Promise<void> {
    if (!previousUrl) return;
    const oldKey = this.extractKeyFromUrl(previousUrl);
    if (!oldKey || oldKey === newKey) return;
    try {
      await this.localStorage.deleteFile(oldKey);
    } catch (err) {
      this.logger.warn(`Failed to delete old stored media ${oldKey}`, err);
    }
  }


  /**
   * @deprecated R2 dibuang (2026-09-26, SS-007/ST-007). Presigned URL tidak
   * didukung lagi — gunakan POST /v1/users/me/avatar/direct.
   */
  async uploadAvatar(userId: string, contentType?: string): Promise<{ uploadUrl: string; avatarKey: string; expiresIn: number }> {
    throw new BadRequestException({
      code: 'DEPRECATED',
      message: 'Presigned URL avatar upload is no longer supported. Use POST /v1/users/me/avatar/direct instead.',
    });
  }

  /**
   * Upload avatar langsung ke self-hosted disk (2026-09-26, SS-007/ST-007).
   * R2 tidak dipakai lagi — tidak ada dependensi kredensial R2.
   */
  async uploadAvatarDirect(userId: string, fileName: string, contentType: string, fileBuffer: Buffer): Promise<{ avatarUrl: string; avatarKey: string }> {
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { id: true, username: true, avatarUrl: true } });
    if (!user) throw new NotFoundException({ code: ErrorCodes.USER_NOT_FOUND, message: 'User not found' });

    const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
    if (!ALLOWED_TYPES.includes(contentType)) {
      throw new BadRequestException({
        code: ErrorCodes.VALIDATION_ERROR,
        message: `contentType must be image/jpeg, image/png, or image/webp`,
      });
    }

    const MAX_SIZE = 2 * 1024 * 1024;
    if (fileBuffer.length > MAX_SIZE) {
      // UPI-07: file kebesaran → 413 terstruktur (konsisten dengan
      // /v1/upload/direct via fileTooLargeException), bukan 400
      // VALIDATION_ERROR — agar FE bisa memetakan copy error.
      throw new PayloadTooLargeException({
        code: ErrorCodes.FILE_TOO_LARGE,
        message: 'File exceeds maximum allowed size of 2 MB',
      });
    }

    const detectedType = this.detectImageMimeType(fileBuffer);
    if (!detectedType || detectedType !== contentType) {
      throw new BadRequestException({
        code: ErrorCodes.VALIDATION_ERROR,
        message: 'File content does not match the declared content type',
      });
    }

    const ext = contentType === 'image/png' ? 'png' : contentType === 'image/webp' ? 'webp' : 'jpg';
    // BFI-103: key kanonis BARU memakai prefix `uploads/` (selaras folder
    // purpose lain). resolvePath/getPublicUrl men-strip prefix ini, jadi file
    // di disk & URL publik IDENTIK dengan key lama — URL lama tidak rusak.
    const avatarKey = `uploads/avatars/${userId}/${nanoid(16)}.${ext}`;

    // UPF-01: strip EXIF/GPS (termasuk koordinat) sebelum simpan — avatar
    // disajikan publik via nginx. Pola sama seperti uploadDirectTx.
    const safeBuffer = stripImageMetadata(fileBuffer, detectedType);

    try {
      await this.localStorage.saveFile(avatarKey, safeBuffer);
    } catch (err) {
      this.logger.error('Self-hosted avatar upload failed', err);
      throw new BadRequestException({
        code: ErrorCodes.UPLOAD_FAILED,
        message: 'Failed to upload avatar to storage. Please try again.',
      });
    }

    const avatarUrl = this.localStorage.getPublicUrl(avatarKey);

    await this.prisma.user.update({ where: { id: userId }, data: { avatarUrl } });
    // UPI-06: last-write-wins yang aman untuk upload paralel. Baca ulang
    // pemenang race: bila URL kita masih live, avatar lama yatim → hapus;
    // bila kalah, file KITA yang yatim → hapus (jangan sentuh file pemenang).
    const currentAvatar = await this.prisma.user.findUnique({ where: { id: userId }, select: { avatarUrl: true } });
    if (currentAvatar?.avatarUrl === avatarUrl) {
      // Menang: hapus avatar lama dari disk (best-effort) — dulu bocor di bucket R2 (R2-F).
      await this.deleteStoredMediaQuietly(user.avatarUrl, avatarKey);
    } else {
      // Kalah: file kita yatim — hapus best-effort agar tidak menumpuk.
      try {
        await this.localStorage.deleteFile(avatarKey);
      } catch (err) {
        this.logger.warn(`Failed to delete losing avatar upload ${avatarKey}`, err);
      }
    }
    this.invalidateUserOgCaches(user.username);
    // BFI-105: sertakan avatarKey (aditif) — FE memakainya untuk
    // confirmAvatar + cleanup orphan (G-04); pickString FE sudah membaca
    // ["avatarKey", "avatar_key"].
    return { avatarUrl, avatarKey };
  }

  async confirmAvatar(userId: string, avatarKey: string): Promise<{ avatarUrl: string }> {
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { id: true, username: true, avatarUrl: true } });
    if (!user) throw new NotFoundException({ code: ErrorCodes.USER_NOT_FOUND, message: 'User not found' });

    const normalizedKey = avatarKey.replace(/\.\.\//g, '').replace(/\/+/g, '/');
    // BFI-103: terima key kanonis BARU (`uploads/avatars/<uid>/…`) DAN key
    // LEGACY (`avatars/<uid>/…`) — kompatibilitas mundur confirm lama.
    const avatarKeyOk =
      normalizedKey.startsWith(`uploads/avatars/${userId}/`) ||
      normalizedKey.startsWith(`avatars/${userId}/`);
    if (!avatarKeyOk || normalizedKey !== avatarKey) {
      throw new BadRequestException({
        code: ErrorCodes.VALIDATION_ERROR,
        message: 'Invalid avatar key',
      });
    }

    // UPI-08: idempoten — uploadAvatarDirect SUDAH mem-publish avatar ke DB,
    // sehingga confirm untuk key yang sudah live adalah no-op. Tanpa ini,
    // retry/kegagalan transien memicu publish ulang + penghapusan file yang
    // salah (FE lama bahkan menghapus avatar live sebagai "orphan").
    if (user.avatarUrl === this.localStorage.getPublicUrl(normalizedKey)) {
      return { avatarUrl: user.avatarUrl };
    }

    // Self-hosted (2026-09-26, SS-007/ST-007): verifikasi ke disk lokal, bukan R2.
    try {
      const size = await this.localStorage.getFileSize(avatarKey);
      if (size === null) throw new Error('not found');
      if (size > UsersService.MAX_AVATAR_BYTES) {
        await this.localStorage.deleteFile(avatarKey);
        throw new BadRequestException({
          code: ErrorCodes.VALIDATION_ERROR,
          message: 'Avatar file exceeds maximum allowed size',
        });
      }
    } catch (err) {
      if (err instanceof BadRequestException) throw err;
      throw new BadRequestException({
        code: ErrorCodes.VALIDATION_ERROR,
        message: 'Avatar file not found in storage. Please upload the file first.',
      });
    }

    const avatarUrl = this.localStorage.getPublicUrl(avatarKey);

    await this.prisma.user.update({
      where: { id: userId },
      data: { avatarUrl },
    });
    // UPI-06: last-write-wins yang aman (lihat uploadAvatarDirect). Bila
    // kalah race, file key ini yatim → hapus best-effort.
    const currentAvatar = await this.prisma.user.findUnique({ where: { id: userId }, select: { avatarUrl: true } });
    if (currentAvatar?.avatarUrl === avatarUrl) {
      await this.deleteStoredMediaQuietly(user.avatarUrl, avatarKey);
    } else {
      try {
        await this.localStorage.deleteFile(avatarKey);
      } catch (err) {
        this.logger.warn(`Failed to delete losing avatar confirm ${avatarKey}`, err);
      }
    }
    this.invalidateUserOgCaches(user.username);

    return { avatarUrl };
  }

  async deleteAvatar(userId: string): Promise<{ message: string }> {
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { username: true, avatarUrl: true } });
    if (user?.avatarUrl) {
      const avatarKey = this.extractKeyFromUrl(user.avatarUrl);
      if (avatarKey) {
        try {
          await this.localStorage.deleteFile(avatarKey);
        } catch (err) {
          this.logger.warn(`Failed to delete avatar file for user ${userId}`, err);
        }
      }
    }
    await this.prisma.user.update({ where: { id: userId }, data: { avatarUrl: null } });
    this.invalidateUserOgCaches(user?.username);
    return { message: 'Avatar deleted successfully' };
  }

  private detectImageMimeType(buffer: Buffer): string | null {
    if (buffer.length < 4) return null;
    if (buffer[0] === 0xFF && buffer[1] === 0xD8 && buffer[2] === 0xFF) return 'image/jpeg';
    if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4E && buffer[3] === 0x47) return 'image/png';
    if (buffer.length >= 12 && buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46
      && buffer[8] === 0x57 && buffer[9] === 0x45 && buffer[10] === 0x42 && buffer[11] === 0x50) return 'image/webp';
    return null;
  }

  /**
   * Ekstrak fileKey dari URL avatar/header.
   * Mendukung: (1) URL self-hosted https://api.kahade.id/uploads/...,
   * (2) path relatif /uploads/.... R2 legacy dibuang 2026-10-07.
   */
  private extractKeyFromUrl(url: string): string | null {
    try {
      // URL self-hosted baru → key "uploads/avatars/..." (uploads/ prefix
      // di-strip LocalStorageService saat resolve path).
      const storagePublicUrl = this.configService.get<string>('app.storagePublicUrl') || 'https://api.kahade.id/uploads';
      if (url.startsWith(storagePublicUrl)) {
        return url.slice(storagePublicUrl.length + 1);
      }
      const parsed = new URL(url);
      return parsed.pathname.startsWith('/') ? parsed.pathname.slice(1) : parsed.pathname;
    } catch {
      return null;
    }
  }

  /**
   * GAP-A (G069): notifikasi in-app saat penghapusan akun tertunda karena
   * blocker (order aktif/sengketa, penarikan berjalan, saldo). Best-effort —
   * tidak menggagalkan penolakan request itu sendiri.
   */
  private async notifyDeletionBlocked(
    userId: string,
    blockers: Array<{ code: string; message: string }>,
  ): Promise<void> {
    const type = NotificationType.SYSTEM_ANNOUNCEMENT;
    const lines = blockers.map((b, i) => `${i + 1}. ${b.message}`).join('\n');
    await this.prisma.notification.create({
      data: {
        notifId: generateNotifId(),
        userId,
        type,
        category: getCategoryForType(type),
        title: 'Penghapusan akun tertunda',
        body:
          `Permintaan penghapusan akun belum bisa diproses karena hal berikut:\n${lines}\n` +
          `Selesaikan dulu hal di atas, lalu ajukan lagi dari menu Pengaturan → Hapus akun.`,
        isRead: false,
        refType: 'ACCOUNT_DELETION',
        refId: 'blocked',
      },
    });
  }

  async requestAccountDeletion(
    userId: string,
    currentAccessTokenJti?: string,
    password?: string,
    reason?: string,
    mfaCode?: string,
    otpCode?: string,
    idempotencyKey?: string,
    ctx?: ActionLocationContext,
  ): Promise<DeletionRequestResult> {
    // G072: idempoten — kunci duplikat atau request aktif yang sudah ada
    // mengembalikan request yang sama (tanpa membuat duplikat / tanpa
    // menjalankan ulang pemeriksaan).
    const existingRequest = await this.accountDeletionService.findExistingRequest(userId, idempotencyKey);
    if (existingRequest) {
      return this.accountDeletionService.toResult(existingRequest);
    }

    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { password: true } });
    if (!user) throw new NotFoundException({ code: ErrorCodes.USER_NOT_FOUND, message: 'User not found' });

    if (user.password) {
      // Akun ber-password: password TETAP wajib (jangan lemahkan).
      if (!password) {
        throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Password is required to delete your account' });
      }
      const passwordValid = await bcryptCompare(password, user.password);
      if (!passwordValid) {
        throw new BadRequestException({ code: ErrorCodes.INVALID_CREDENTIALS, message: 'Password salah' });
      }
    } else {
      // G071: akun tanpa password (sosial/OTP) — re-auth via OTP WhatsApp.
      if (!otpCode) {
        throw new BadRequestException({
          code: ErrorCodes.VALIDATION_ERROR,
          message: 'Kode verifikasi WhatsApp wajib diisi untuk akun tanpa kata sandi',
        });
      }
      await this.accountDeletionService.verifyDeletionRequestOtp(userId, otpCode);
    }

    const twoFactorAuth = await this.prisma.twoFactorAuth.findUnique({
      where: { userId },
      select: { id: true, isEnabled: true, secret: true, backupCodes: true, usedBackupCodes: true },
    });
    if (twoFactorAuth?.isEnabled) {
      if (!mfaCode) {
        throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: '2FA verification code is required' });
      }
      if (!twoFactorAuth.secret) {
        throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: '2FA is not properly configured. Please contact support.' });
      }
      const decryptedSecret = await decryptAES(twoFactorAuth.secret);
      const normalizedMfaCode = mfaCode.trim().toUpperCase();
      let verified = speakeasy.totp.verify({ secret: decryptedSecret, encoding: 'base32', token: normalizedMfaCode, window: 1 });
      if (!verified) {
        for (const backupCodeHash of twoFactorAuth.backupCodes ?? []) {
          if ((twoFactorAuth.usedBackupCodes ?? []).includes(backupCodeHash)) continue;
          if (!await verifyOtp(normalizedMfaCode, backupCodeHash)) continue;
          const claimed = await this.prisma.twoFactorAuth.updateMany({
            where: {
              id: twoFactorAuth.id,
              backupCodes: { has: backupCodeHash },
              NOT: { usedBackupCodes: { has: backupCodeHash } },
            },
            data: { usedBackupCodes: { push: backupCodeHash } },
          });
          verified = claimed.count === 1;
          break;
        }
      }
      if (!verified) {
        throw new BadRequestException({ code: ErrorCodes.INVALID_2FA_CODE, message: 'Invalid 2FA verification code' });
      }
    }

    const disputedOrderCount = await this.prisma.order.count({
      where: {
        OR: [{ buyerId: userId }, { sellerId: userId }],
        status: OrderStatus.DISPUTED,
      },
    });

    // GAP-A (G069): kumpulkan semua blocker; bila ada, kirim notifikasi in-app
    // yang menjelaskan apa yang harus diselesaikan user, lalu tolak request.
    const deletionBlockers: Array<{ code: string; message: string }> = [];
    if (disputedOrderCount > 0) {
      deletionBlockers.push({
        code: ErrorCodes.ACTIVE_ORDERS_PRESENT,
        message: `You have ${disputedOrderCount} ongoing dispute(s). Please wait for dispute resolution before deleting your account.`,
      });
    }

    const activeOrderCount = await this.prisma.order.count({
      where: {
        OR: [{ buyerId: userId }, { sellerId: userId }],
        status: {
          notIn: [
            OrderStatus.COMPLETED,
            OrderStatus.CANCELLED,
            OrderStatus.DISPUTED,
          ],
        },
      },
    });

    if (activeOrderCount > 0) {
      deletionBlockers.push({
        code: ErrorCodes.ACTIVE_ORDERS_PRESENT,
        message: `You have ${activeOrderCount} active order(s). Complete or cancel all orders before deleting your account.`,
      });
    }

    const [wallet, pendingWithdrawalCount] = await Promise.all([
      this.prisma.wallet.findUnique({ where: { userId } }),
      this.prisma.walletTransaction.count({
        where: {
          type: WalletTransactionType.WITHDRAW,
          withdrawStatus: { in: [WithdrawStatus.PENDING_OTP, WithdrawStatus.PENDING_PROCESS, WithdrawStatus.PROCESSING] },
          wallet: { userId },
        },
      }),
    ]);

    if (pendingWithdrawalCount > 0) {
      deletionBlockers.push({
        code: ErrorCodes.ACTIVE_ORDERS_PRESENT,
        message: 'You have a withdrawal still being processed. Wait for it to finish before deleting your account.',
      });
    }

    if (wallet && (wallet.escrowBalance > BigInt(0) || wallet.availableBalance > BigInt(0) || wallet.totalBalance > BigInt(0))) {
      deletionBlockers.push({
        code: wallet.escrowBalance > BigInt(0) ? ErrorCodes.ESCROW_BALANCE_PRESENT : ErrorCodes.WALLET_BALANCE_PRESENT,
        message: wallet.escrowBalance > BigInt(0)
          ? 'You have funds locked in escrow. Complete all pending orders before deleting your account.'
          : 'You still have funds in your wallet. Withdraw or resolve the balance before deleting your account.',
      });
    }

    if (deletionBlockers.length > 0) {
      await this.notifyDeletionBlocked(userId, deletionBlockers).catch((err) => {
        this.logger.warn(`[deletion] blocked notification failed: ${err instanceof Error ? err.message : String(err)}`);
      });
      throw new BadRequestException({
        code: deletionBlockers[0].code,
        message: deletionBlockers[0].message,
        blockers: deletionBlockers,
      });
    }

    if (reason) {
      this.logger.log(`Account deletion requested by user ${userId}: ${reason}`);
    }

    const deletionAt = new Date();
    const requestResult = await this.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      const txActiveOrderCount = await tx.order.count({
        where: {
          OR: [{ buyerId: userId }, { sellerId: userId }],
          status: { notIn: [OrderStatus.COMPLETED, OrderStatus.CANCELLED, OrderStatus.DISPUTED] },
        },
      });
      if (txActiveOrderCount > 0) {
        throw new BadRequestException({
          code: ErrorCodes.ACTIVE_ORDERS_PRESENT,
          message: `You have ${txActiveOrderCount} active order(s). Complete or cancel all orders before deleting your account.`,
        });
      }

      const txPendingWithdrawalCount = await tx.walletTransaction.count({
        where: {
          type: WalletTransactionType.WITHDRAW,
          withdrawStatus: { in: [WithdrawStatus.PENDING_OTP, WithdrawStatus.PENDING_PROCESS, WithdrawStatus.PROCESSING] },
          wallet: { userId },
        },
      });
      if (txPendingWithdrawalCount > 0) {
        throw new BadRequestException({
          code: ErrorCodes.ACTIVE_ORDERS_PRESENT,
          message: 'You have a withdrawal still being processed. Wait for it to finish before deleting your account.',
        });
      }

      const txWallet = await tx.wallet.findUnique({
        where: { userId },
        select: { escrowBalance: true, availableBalance: true, totalBalance: true },
      });
      if (txWallet && (txWallet.escrowBalance > BigInt(0) || txWallet.availableBalance > BigInt(0) || txWallet.totalBalance > BigInt(0))) {
        throw new BadRequestException({
          code: txWallet.escrowBalance > BigInt(0) ? ErrorCodes.ESCROW_BALANCE_PRESENT : ErrorCodes.WALLET_BALANCE_PRESENT,
          message: txWallet.escrowBalance > BigInt(0)
            ? 'You have funds locked in escrow. Complete all pending orders before deleting your account.'
            : 'You still have funds in your wallet. Withdraw or resolve the balance before deleting your account.',
        });
      }

      await tx.user.update({
        where: { id: userId },
        data: { deletedAt: deletionAt, isActive: false },
      });
      await tx.userSession.updateMany({
        where: { userId, isRevoked: false },
        data: { isRevoked: true, revokedAt: deletionAt, revokedReason: 'account_deletion' },
      });
      // Retain device rows for security/audit history, but make a deleted account
      // unable to receive pushes or remain trusted on a future token refresh.
      await tx.userDevice.updateMany({
        where: { userId },
        data: { pushToken: null, isTrusted: false, trustedAt: null },
      });

      // GAP-A (G061/G072): catat request penghapusan (referenceCode, purgeAt)
      // dalam transaksi yang sama dengan soft-delete user.
      return this.accountDeletionService.createRequest(tx, userId, {
        idempotencyKey: idempotencyKey?.trim() || randomUUID(),
        reason,
      });
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });

    const expiresIn = this.configService.get<string>('jwt.expiresIn') ?? '15m';
    const ttlSeconds = parseJwtTtl(expiresIn);

    try {
      if (currentAccessTokenJti) {
        await this.redis.setex(TOKEN_BLACKLIST(currentAccessTokenJti), ttlSeconds, '1', { throwOnError: true });
      }

      const activeSessions = await this.prisma.userSession.findMany({
        where: { userId, isRevoked: true, revokedReason: 'account_deletion' },
        select: { id: true },
      });
      await Promise.all(activeSessions.map((session) =>
        this.redis.setex(SESSION_REVOKED_KEY(session.id), ttlSeconds, '1', { throwOnError: true }),
      ));
    } catch (error) {
      // The deleted/inactive user and all sessions were committed before this
      // cache propagation step. JwtAuthGuard also checks that durable boundary.
      this.logger.warn(`[SECURITY] Account deletion persisted but Redis revocation propagation is unavailable: ${error instanceof Error ? error.message : String(error)}`);
    }

    // GAP-A (G057): email konfirmasi + notifikasi in-app (best-effort — tidak
    // menggagalkan request yang sudah ter-commit).
    await this.accountDeletionService.notifyRequestCreated(userId, requestResult).catch((err) => {
      this.logger.warn(`[deletion] notifyRequestCreated failed: ${err instanceof Error ? err.message : String(err)}`);
    });

    // Lokasi presisi tiap aksi sensitif — best-effort, tidak pernah throw.
    await this.actionLocationService?.logAction({
      userId,
      actionType: 'ACCOUNT_DELETE',
      referenceType: 'ACCOUNT_DELETION',
      referenceId: requestResult.referenceCode,
      location: ctx?.location,
      ipAddress: ctx?.ipAddress,
      deviceId: ctx?.deviceId,
    });

    return requestResult;
  }


  async getMyDevices(userId: string, page: number = 1, limit: number = 20): Promise<object> {
    const safePage = Number.isFinite(page) ? Math.max(1, Math.floor(page)) : 1;
    const safeLimit = Number.isFinite(limit) ? Math.min(MAX_LIMIT, Math.max(1, Math.floor(limit))) : 20;
    const skip = (safePage - 1) * safeLimit;

    const [devices, total] = await Promise.all([
      this.prisma.userDevice.findMany({
        where: { userId },
        orderBy: { lastLoginAt: 'desc' },
        skip,
        take: safeLimit,
        select: {
          id: true,
          deviceId: true,
          deviceName: true,
          deviceType: true,
          os: true,
          browser: true,
          ipAddress: true,
          isTrusted: true,
          trustedAt: true,
          lastLoginAt: true,
          loginCount: true,
          createdAt: true,
        },
      }),
      this.prisma.userDevice.count({ where: { userId } }),
    ]);

    return {
      devices: devices.map((device) => ({ ...device, ipAddress: this.maskIpAddress(device.ipAddress) })),
      meta: { total, page: safePage, limit: safeLimit, totalPages: Math.ceil(total / safeLimit) },
    };
  }

  async removeDevice(userId: string, deviceId: string): Promise<{ message: string }> {
    const revokedSessionIds = await this.prisma.$transaction(async (tx) => {
      const device = await tx.userDevice.findFirst({ where: { id: deviceId, userId } });
      if (!device) {
        throw new NotFoundException({ code: ErrorCodes.NOT_FOUND, message: 'Device not found' });
      }
      const sessions = await tx.userSession.findMany({
        where: {
          userId,
          isRevoked: false,
          OR: [{ deviceId: device.deviceId }, { deviceId: null }],
        },
        select: { id: true },
      });
      await tx.userSession.updateMany({
        where: { id: { in: sessions.map((session) => session.id) }, isRevoked: false },
        data: { isRevoked: true, revokedAt: new Date(), revokedReason: 'device_removed' },
      });
      await tx.userDevice.delete({ where: { id: deviceId } });
      return sessions.map((session) => session.id);
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });

    const ttlSeconds = parseJwtTtl(this.configService.get<string>('jwt.expiresIn') ?? '15m');
    await Promise.all(revokedSessionIds.map((sessionId) =>
      this.redis.setex(SESSION_REVOKED_KEY(sessionId), ttlSeconds, '1', { throwOnError: true }),
    ));
    return { message: 'Device removed successfully' };
  }

  private static readonly SECURITY_ACTIONS: UserAuditAction[] = [
    UserAuditAction.LOGIN,
    UserAuditAction.LOGOUT,
    UserAuditAction.LOGOUT_ALL,
    UserAuditAction.PASSWORD_CHANGED,
    UserAuditAction.PASSWORD_RESET,
    UserAuditAction.TWO_FA_ENABLED,
    UserAuditAction.TWO_FA_DISABLED,
    UserAuditAction.EMAIL_VERIFIED,
    UserAuditAction.DEVICE_TRUSTED,
    UserAuditAction.DEVICE_UNTRUSTED,
  ];

  async getSecurityLog(userId: string, page: number, limit: number, actionFilter?: string): Promise<object> {
    const safePage = Number.isFinite(page) ? Math.max(1, Math.floor(page)) : 1;
    const safeLimit = Number.isFinite(limit) ? Math.min(MAX_LIMIT, Math.max(1, Math.floor(limit))) : MAX_LIMIT;
    const skip = (safePage - 1) * safeLimit;

    const where: Prisma.AuditLogWhereInput = {
      userId,
      action: actionFilter && UsersService.SECURITY_ACTIONS.includes(actionFilter as UserAuditAction)
        ? actionFilter as UserAuditAction
        : { in: UsersService.SECURITY_ACTIONS },
    };

    const [logs, total] = await Promise.all([
      this.prisma.auditLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: safeLimit,
        select: {
          id: true,
          action: true,
          description: true,
          ipAddress: true,
          userAgent: true,
          createdAt: true,
        },
      }),
      this.prisma.auditLog.count({ where }),
    ]);

    return { data: logs, total, page: safePage, limit: safeLimit, totalPages: Math.ceil(total / safeLimit) };
  }

  private getTrustedDeviceExpiryDays(): number {
    const configured = this.configService.get<number>('app.trustedDeviceDays') ?? 30;
    return Number.isFinite(configured) ? Math.max(1, configured) : 30;
  }

  async setDeviceTrust(userId: string, deviceId: string, trusted: boolean, password: string, mfaCode?: string): Promise<{ message: string }> {
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { password: true } });
    if (!user) throw new NotFoundException({ code: ErrorCodes.USER_NOT_FOUND, message: 'User not found' });

    if (!user.password) {
      throw new ForbiddenException({ code: ErrorCodes.INVALID_CREDENTIALS, message: 'Password login is not configured for this account' });
    }
    const passwordValid = await bcryptCompare(password, user.password);
    if (!passwordValid) {
      throw new ForbiddenException({ code: ErrorCodes.INVALID_CREDENTIALS, message: 'Invalid password' });
    }

    const device = await this.prisma.userDevice.findFirst({
      where: { id: deviceId, userId },
    });
    if (!device) {
      throw new NotFoundException({ code: ErrorCodes.NOT_FOUND, message: 'Device not found' });
    }

    if (device.isTrusted === trusted) {
      return { message: trusted ? 'Device is already trusted' : 'Device is already untrusted' };
    }

    const twoFactorAuth = await this.prisma.twoFactorAuth.findUnique({
      where: { userId },
      select: { isEnabled: true, secret: true },
    });
    if (twoFactorAuth?.isEnabled) {
      if (!mfaCode) {
        throw new ForbiddenException({ code: 'TWO_FA_REQUIRED', message: 'Authenticator code is required to change trusted-device status' });
      }
      if (!twoFactorAuth.secret) {
        throw new BadRequestException({ code: ErrorCodes.TWO_FA_NOT_ENABLED, message: '2FA is not properly configured. Please re-setup 2FA.' });
      }
      if (!/^\d{6}$/.test(mfaCode.trim())) {
        throw new BadRequestException({ code: ErrorCodes.INVALID_2FA_CODE, message: 'Authenticator code must contain exactly six digits' });
      }
      const secret = await decryptAES(twoFactorAuth.secret);
      const verified = speakeasy.totp.verify({ secret, encoding: 'base32', token: mfaCode.trim(), window: 1 });
      if (!verified) {
        throw new BadRequestException({ code: ErrorCodes.INVALID_2FA_CODE, message: 'Invalid 2FA verification code' });
      }

      // Trusting a device changes future login requirements. A valid TOTP must be
      // single-use across sensitive actions just as it is for other 2FA mutations.
      const hmacSecret = this.configService.get<string>('crypto.hmacSecretKey') || this.configService.get<string>('jwt.secret') || '';
      const usedCodeKey = TOTP_USED_CODE(userId);
      const redisKey = `${this.redis.getPrefix()}${usedCodeKey}`;
      const codeHash = sha256(`${hmacSecret}:totp:${mfaCode.trim()}`);
      const wasAdded = await this.redis.getClient().sadd(redisKey, codeHash);
      if (wasAdded === 0) {
        throw new BadRequestException({ code: ErrorCodes.INVALID_2FA_CODE, message: 'TOTP code already used. Wait for the next code.' });
      }
      await this.redis.getClient().expire(redisKey, 90);
    }

    await this.prisma.userDevice.update({
      where: { id: deviceId },
      data: {
        isTrusted: trusted,
        trustedAt: trusted ? new Date() : null,
      },
    });

    this.auditLog.logUserAction({
      userId,
      action: trusted ? UserAuditAction.DEVICE_TRUSTED : UserAuditAction.DEVICE_UNTRUSTED,
      entityType: 'UserDevice',
      entityId: deviceId,
      description: `Device "${device.deviceName ?? device.deviceId}" ${trusted ? 'marked as trusted' : 'trust removed'}`,
    });
    const title = trusted ? 'Device Marked as Trusted' : 'Trusted Device Removed';
    const body = trusted
      ? `A device was marked as trusted and may bypass 2FA during its next login. Device: ${device.deviceName ?? device.deviceId}.`
      : `Trust was removed from a device. Device: ${device.deviceName ?? device.deviceId}.`;
    this.prisma.notification.create({
      data: {
        notifId: generateNotifId(),
        userId,
        type: NotificationType.SECURITY_NEW_LOGIN,
        category: getCategoryForType(NotificationType.SECURITY_NEW_LOGIN),
        title,
        body,
      },
    }).then(() => {
      this.prisma.emitNotificationCreated({ userId, title, body, data: { type: 'SECURITY_DEVICE_TRUST_CHANGED' } });
    }).catch((error: unknown) => {
      this.logger.error(`Failed to record trusted-device security notification for user ${userId}: ${error instanceof Error ? error.message : String(error)}`);
    });

    return { message: trusted ? 'Device marked as trusted' : 'Device trust removed' };
  }

  isDeviceTrustValid(trustedAt: Date | null): boolean {
    if (!trustedAt) return false;
    const expiryMs = this.getTrustedDeviceExpiryDays() * 24 * 60 * 60 * 1000;
    return Date.now() - trustedAt.getTime() < expiryMs;
  }

  private maskIpAddress(value: string | null): string | null {
    if (!value) return null;
    if (value.includes(':')) {
      const groups = value.split(':');
      return `${groups.slice(0, 3).join(':')}:****`;
    }
    const parts = value.split('.');
    return parts.length === 4 ? `${parts[0]}.${parts[1]}.***.***` : '***';
  }

  /**
   * D1-006 (perf 2026-09-29): SATU query `follow.findMany` — hanya kolom
   * id/username yang dibutuhkan filter "Mengikuti" di feed. Menggantikan
   * loop klien hingga 20 halaman `getFollowing`.
   */
  async getMyFollowingIds(userId: string): Promise<{ following: { userId: string; username: string | null }[] }> {
    const rows = await this.prisma.follow.findMany({
      where: { followerId: userId },
      select: { following: { select: { userId: true, username: true } } },
    });
    return {
      following: rows.map((r) => ({ userId: r.following.userId, username: r.following.username })),
    };
  }

  async getActivityLog(userId: string, page: number, limit: number): Promise<object> {
    const { page: safePage, limit: safeLimit, skip } = this.normalizePagination(page, limit);

    const [logs, total] = await Promise.all([
      this.prisma.auditLog.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' },
        skip,
        take: safeLimit,
        select: {
          id: true,
          action: true,
          entityType: true,
          entityId: true,
          description: true,
          ipAddress: true,
          createdAt: true,
        },
      }),
      this.prisma.auditLog.count({ where: { userId } }),
    ]);

    return { data: logs, total, page: safePage, limit: safeLimit, totalPages: Math.ceil(total / safeLimit) };
  }

  async getUserRatings(username: string, page: number, limit: number, filter?: string, viewerId?: string | null, sort?: string): Promise<object> {
    const user = await this.prisma.user.findUnique({ where: { username: username.toLowerCase() }, select: { id: true, averageRating: true, totalRatingCount: true, profileVisible: true, isActive: true, isBanned: true, deletedAt: true } });
    if (!user) throw new NotFoundException({ code: ErrorCodes.USER_NOT_FOUND, message: 'User not found' });
    if (user.profileVisible === false && viewerId !== user.id) {
      throw new NotFoundException({ code: ErrorCodes.USER_NOT_FOUND, message: 'User not found' });
    }
    if (user.isActive === false || user.isBanned === true || user.deletedAt != null) {
      throw new NotFoundException({ code: ErrorCodes.USER_NOT_FOUND, message: 'User not found' });
    }
    if (viewerId && viewerId !== user.id) {
      const blocked = await this.prisma.blockList.findFirst({ where: { OR: [{ blockerId: viewerId, blockedId: user.id }, { blockerId: user.id, blockedId: viewerId }] }, select: { id: true } });
      if (blocked) throw new NotFoundException({ code: ErrorCodes.USER_NOT_FOUND, message: 'User not found' });
    }

    const { page: safePage, limit: safeLimit, skip } = this.normalizePagination(page, limit);

    const where: Prisma.RatingWhereInput = {
      receiverId: user.id,
      isHidden: false,
      giver: { isActive: true, isBanned: false, deletedAt: null, profileVisible: true },
    };

    if (filter === 'positive') where.stars = { gte: 4 };
    else if (filter === 'neutral') where.stars = { equals: 3 };
    else if (filter === 'negative') where.stars = { lte: 2 };
    else if (filter) {
      throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Unsupported rating filter' });
    }

    // Batch 139 BE-API2 (item 119): sort=highest → bintang tertinggi dulu.
    // Default (dan sort=latest) tetap createdAt desc + tiebreak id desc —
    // perilaku lama tidak berubah.
    let orderBy: Prisma.RatingOrderByWithRelationInput[];
    if (sort === 'highest') {
      orderBy = [{ stars: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }];
    } else if (sort === undefined || sort === null || sort === '' || sort === 'latest') {
      orderBy = [{ createdAt: 'desc' }, { id: 'desc' }];
    } else {
      throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Unsupported rating sort' });
    }

    const [ratings, total] = await Promise.all([
      this.prisma.rating.findMany({
        where,
        skip,
        take: safeLimit,
        // Section 5: tiebreak { id } wajib untuk offset pagination — createdAt
        // tidak unik, jadi tanpa tiebreak dua rating yang lahir pada detik yang
        // sama bisa muncul dua kali atau terlewat saat halaman bergeser. Arah
        // `id: desc` disamakan dengan preview `ratingsReceived` di
        // getPublicProfile supaya halaman pertama list == preview profil.
        orderBy,
        select: {
          id: true,
          stars: true,
          comment: true,
          createdAt: true,
          giver: { select: { username: true, avatarUrl: true } },
          // BFI-128: sertakan balasan rating (aditif; yang disembunyikan tidak bocor).
          reply: { where: { isHidden: false }, select: { content: true, createdAt: true, replier: { select: { username: true, avatarUrl: true } } } },
        },
      }),
      this.prisma.rating.count({ where }),
    ]);

    // Batch 19 TIM A (item 5): distribusi bintang 1-5 atas filter visibilitas
    // dasar yang SAMA (isHidden=false, giver aktif/tidak-banned/visible) tapi
    // TANPA filter positive/neutral/negative — jadi distribusi tidak bergeser
    // saat pengguna berpindah tab filter. Field lama tidak diubah.
    const distributionRows = await this.prisma.rating.groupBy({
      by: ['stars'],
      where: {
        receiverId: user.id,
        isHidden: false,
        giver: { isActive: true, isBanned: false, deletedAt: null, profileVisible: true },
      },
      _count: { stars: true },
    });
    const distribution: Record<string, number> = { '1': 0, '2': 0, '3': 0, '4': 0, '5': 0 };
    for (const row of distributionRows) {
      const key = String(row.stars);
      if (key in distribution) distribution[key] = row._count.stars;
    }

    return {
      ratings,
      // `total` = jumlah rating yang lolos filter visibilitas halaman ini;
      // `totalRatingCount` = counter denormalisasi di profil. Keduanya bisa
      // berbeda (mis. filter=positive, atau pemberi rating yang menonaktifkan
      // profil), jadi keduanya dikembalikan agar klien tidak menebak.
      total,
      averageRating: Number(user.averageRating ?? 0),
      totalRatingCount: user.totalRatingCount,
      // Batch 19 TIM A (item 5): hitungan per bintang (string key "1".."5").
      distribution,
      filter: filter || null,
      // Batch 139 BE-API2 (item 119): gema sort yang dipakai.
      sort: sort || null,
      page: safePage,
      limit: safeLimit,
    };
  }

  // ========== FOLLOW ==========

  /**
   * Batch 139 BE-API2 (item 118): himpunan id yang di-follow viewer dari
   * daftar kandidat — satu query IN. Viewer anonim/null → himpunan kosong
   * (semua baris `isFollowingByViewer: false`).
   */
  private async getFollowedIdSet(viewerId: string | null | undefined, candidateIds: string[]): Promise<Set<string>> {
    if (!viewerId || candidateIds.length === 0) return new Set();
    try {
      const rows = await this.prisma.follow.findMany({
        where: { followerId: viewerId, followingId: { in: [...new Set(candidateIds)] } },
        select: { followingId: true },
      });
      return new Set(rows.map((r) => r.followingId));
    } catch {
      return new Set();
    }
  }

  private async withSerializableRetry<T>(fn: () => Promise<T>, maxRetries = 3): Promise<T> {
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        return await fn();
      } catch (err: unknown) {
        const isPrismaSerializationError =
          err != null &&
          typeof err === 'object' &&
          'code' in err &&
          (err as { code: string }).code === 'P2034';
        const isDbSerializationError =
          err instanceof Error &&
          (err.message.includes('could not serialize access') ||
           err.message.includes('deadlock detected'));
        if ((!isPrismaSerializationError && !isDbSerializationError) || attempt === maxRetries - 1) throw err;
        await new Promise(resolve => setTimeout(resolve, randomInt(0, 50 * (attempt + 1))));
      }
    }
    throw new Error('Unreachable');
  }

  async followUser(followerId: string, username: string): Promise<{ message: string }> {
    const target = await this.prisma.user.findUnique({ where: { username: username.toLowerCase() }, select: { id: true } });
    if (!target) throw new NotFoundException({ code: ErrorCodes.USER_NOT_FOUND, message: 'User not found' });

    if (target.id === followerId) {
      throw new BadRequestException({ code: ErrorCodes.CANNOT_FOLLOW_SELF, message: 'Cannot follow yourself' });
    }

    await this.withSerializableRetry(() =>
      this.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
        const blocked = await tx.blockList.findFirst({
          where: { OR: [{ blockerId: followerId, blockedId: target.id }, { blockerId: target.id, blockedId: followerId }] },
        });
        if (blocked) throw new NotFoundException({ code: ErrorCodes.USER_NOT_FOUND, message: 'User not found' });

        const existing = await tx.follow.findUnique({
          where: { followerId_followingId: { followerId, followingId: target.id } },
        });
        if (existing) throw new ConflictException({ code: ErrorCodes.ALREADY_FOLLOWING, message: 'Already following this user' });

        await tx.follow.create({ data: { followerId, followingId: target.id } });
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }),
    );

    return { message: 'Followed successfully' };
  }

  async unfollowUser(followerId: string, username: string): Promise<{ message: string }> {
    const target = await this.prisma.user.findUnique({ where: { username: username.toLowerCase() }, select: { id: true } });
    if (!target) throw new NotFoundException({ code: ErrorCodes.USER_NOT_FOUND, message: 'User not found' });

    await this.withSerializableRetry(() =>
      this.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
        const existing = await tx.follow.findUnique({
          where: { followerId_followingId: { followerId, followingId: target.id } },
        });
        if (!existing) throw new BadRequestException({ code: ErrorCodes.NOT_FOLLOWING, message: 'Not following this user' });

        await tx.follow.delete({ where: { id: existing.id } });
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }),
    );

    return { message: 'Unfollowed successfully' };
  }

  /**
   * I065 (Wave 2) — hapus follower dari daftar pengikut sendiri ("remove
   * follower"). Kebalikan unfollow: baris follow yang dihapus adalah
   * (followerId = target, followingId = pemilik sesi). Idempotent-aman via
   * unique compound; tanpa tx serializable karena delete satu baris.
   */
  async removeFollower(ownerId: string, followerUsername: string): Promise<{ message: string }> {
    const follower = await this.prisma.user.findUnique({
      where: { username: followerUsername.toLowerCase() },
      select: { id: true },
    });
    if (!follower) throw new NotFoundException({ code: ErrorCodes.USER_NOT_FOUND, message: 'User not found' });
    if (follower.id === ownerId) {
      throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Tidak bisa menghapus diri sendiri dari pengikut' });
    }

    const deleted = await this.prisma.follow.deleteMany({
      where: { followerId: follower.id, followingId: ownerId },
    });
    if (deleted.count === 0) {
      throw new BadRequestException({ code: ErrorCodes.NOT_FOLLOWING, message: 'User tersebut bukan pengikutmu' });
    }
    return { message: 'Follower removed successfully' };
  }

  async getFollowers(username: string, page: number, limit: number, search?: string, viewerId?: string | null): Promise<object> {
    const user = await this.prisma.user.findUnique({ where: { username: username.toLowerCase() }, select: { id: true, profileVisible: true, isActive: true, isBanned: true, deletedAt: true } });
    if (!user) throw new NotFoundException({ code: ErrorCodes.USER_NOT_FOUND, message: 'User not found' });
    if (user.profileVisible === false && viewerId !== user.id) {
      throw new NotFoundException({ code: ErrorCodes.USER_NOT_FOUND, message: 'User not found' });
    }
    if (user.isActive === false || user.isBanned === true || user.deletedAt != null) {
      throw new NotFoundException({ code: ErrorCodes.USER_NOT_FOUND, message: 'User not found' });
    }
    if (viewerId && viewerId !== user.id) {
      const blocked = await this.prisma.blockList.findFirst({ where: { OR: [{ blockerId: viewerId, blockedId: user.id }, { blockerId: user.id, blockedId: viewerId }] }, select: { id: true } });
      if (blocked) throw new NotFoundException({ code: ErrorCodes.USER_NOT_FOUND, message: 'User not found' });
    }

    const { page: safePage, limit: safeLimit, skip } = this.normalizePagination(page, limit);

    // G077: hormati pengaturan privasi daftar follower pemilik profil.
    // Daftar kosong (bukan 403) agar bentuk response tidak berubah.
    const privacy = await loadPrivacySetting(this.prisma, user.id);
    const isOwnList = viewerId === user.id;
    const viewerFollowsOwner = viewerId && !isOwnList
      ? Boolean(await this.prisma.follow.findUnique({
          where: { followerId_followingId: { followerId: viewerId, followingId: user.id } },
          select: { id: true },
        }))
      : false;
    if (!canViewList(privacy.showFollowerList, { isOwnProfile: isOwnList, viewerFollowsOwner })) {
      return { users: [], total: 0, page: safePage, limit: safeLimit };
    }

    const excludedIds = await this.getViewerExcludedIds(viewerId ?? undefined);
    const visibleFollower = {
      isActive: true,
      isBanned: false,
      deletedAt: null,
      profileVisible: true,
      ...(excludedIds.length > 0 ? { id: { notIn: excludedIds } } : {}),
    };
    const searchFilter = search?.trim()
      ? {
          follower: {
            ...visibleFollower,
            OR: [
              { fullName: { contains: escapeLikePattern(search.trim()), mode: 'insensitive' as const } },
              { username: { contains: escapeLikePattern(search.trim()), mode: 'insensitive' as const } },
            ],
          },
        }
      : { follower: visibleFollower };

    const where: Prisma.FollowWhereInput = { followingId: user.id, ...searchFilter };

    const [followers, total] = await Promise.all([
      this.prisma.follow.findMany({
        where,
        skip, take: safeLimit, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], // R2-L: stable page ordering
        select: { createdAt: true, follower: { select: { id: true, username: true, fullName: true, avatarUrl: true, membershipRank: true } } },
      }),
      this.prisma.follow.count({ where }),
    ]);

    // R1 (audit 2026-09-26, lanjutan): sematkan sealTier agar frontend bisa
    // render <VerifiedSeal> di daftar pengikut tanpa N+1 request badge.
    const sealTierMap = await this.verificationBadgeService.getSealTierMap(
      followers.map((f) => f.follower.id),
    );

    // Batch 139 BE-API2 (item 118): state awal follow per baris untuk viewer
    // (I064) — satu query IN, bukan N+1.
    const followedByViewer = await this.getFollowedIdSet(
      viewerId,
      followers.map((f) => f.follower.id),
    );

    return {
      users: followers.map((f) => {
        // id internal hanya dipakai untuk sealTierMap — jangan dibocorkan.
        const { id: _internalId, ...rest } = f.follower;
        return {
          ...rest,
          sealTier: sealTierMap.get(f.follower.id) ?? null,
          followedAt: f.createdAt,
          isFollowingByViewer: followedByViewer.has(f.follower.id),
        };
      }),
      total,
      page: safePage,
      limit: safeLimit,
    };
  }

  async getFollowing(username: string, page: number, limit: number, viewerId?: string | null): Promise<object> {
    const user = await this.prisma.user.findUnique({ where: { username: username.toLowerCase() }, select: { id: true, profileVisible: true, isActive: true, isBanned: true, deletedAt: true } });
    if (!user) throw new NotFoundException({ code: ErrorCodes.USER_NOT_FOUND, message: 'User not found' });
    if (user.profileVisible === false && viewerId !== user.id) {
      throw new NotFoundException({ code: ErrorCodes.USER_NOT_FOUND, message: 'User not found' });
    }
    if (user.isActive === false || user.isBanned === true || user.deletedAt != null) {
      throw new NotFoundException({ code: ErrorCodes.USER_NOT_FOUND, message: 'User not found' });
    }
    if (viewerId && viewerId !== user.id) {
      const blocked = await this.prisma.blockList.findFirst({ where: { OR: [{ blockerId: viewerId, blockedId: user.id }, { blockerId: user.id, blockedId: viewerId }] }, select: { id: true } });
      if (blocked) throw new NotFoundException({ code: ErrorCodes.USER_NOT_FOUND, message: 'User not found' });
    }

    const { page: safePage, limit: safeLimit, skip } = this.normalizePagination(page, limit);

    // G077: hormati pengaturan privasi daftar following pemilik profil.
    const followingPrivacy = await loadPrivacySetting(this.prisma, user.id);
    const isOwnFollowingList = viewerId === user.id;
    const viewerFollowsOwnerForList = viewerId && !isOwnFollowingList
      ? Boolean(await this.prisma.follow.findUnique({
          where: { followerId_followingId: { followerId: viewerId, followingId: user.id } },
          select: { id: true },
        }))
      : false;
    if (!canViewList(followingPrivacy.showFollowingList, { isOwnProfile: isOwnFollowingList, viewerFollowsOwner: viewerFollowsOwnerForList })) {
      return { users: [], total: 0, page: safePage, limit: safeLimit };
    }

    const excludedIds = await this.getViewerExcludedIds(viewerId ?? undefined);
    const visibleFollowing = {
      isActive: true,
      isBanned: false,
      deletedAt: null,
      profileVisible: true,
      ...(excludedIds.length > 0 ? { id: { notIn: excludedIds } } : {}),
    };
    const followingWhere: Prisma.FollowWhereInput = {
      followerId: user.id,
      following: visibleFollowing,
    };

    const [following, total] = await Promise.all([
      this.prisma.follow.findMany({
        where: followingWhere,
        skip, take: safeLimit, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], // R2-L: stable page ordering
        select: { createdAt: true, following: { select: { id: true, username: true, fullName: true, avatarUrl: true, membershipRank: true } } },
      }),
      this.prisma.follow.count({ where: followingWhere }),
    ]);

    // R1 (audit 2026-09-26, lanjutan): sematkan sealTier agar frontend bisa
    // render <VerifiedSeal> di daftar mengikuti tanpa N+1 request badge.
    const sealTierMap = await this.verificationBadgeService.getSealTierMap(
      following.map((f) => f.following.id),
    );

    // Batch 139 BE-API2 (item 118): state awal follow per baris untuk viewer.
    const followedByViewer = await this.getFollowedIdSet(
      viewerId,
      following.map((f) => f.following.id),
    );

    return {
      users: following.map((f) => {
        // id internal hanya dipakai untuk sealTierMap — jangan dibocorkan.
        const { id: _internalId, ...rest } = f.following;
        return {
          ...rest,
          sealTier: sealTierMap.get(f.following.id) ?? null,
          followedAt: f.createdAt,
          isFollowingByViewer: followedByViewer.has(f.following.id),
        };
      }),
      total,
      page: safePage,
      limit: safeLimit,
    };
  }

  // ========== BLOCK ==========

  async blockUser(blockerId: string, targetUserId: string): Promise<{ message: string }> {
    const target = await this.prisma.user.findUnique({ where: { userId: targetUserId }, select: { id: true } });
    if (!target) throw new NotFoundException({ code: ErrorCodes.USER_NOT_FOUND, message: 'User not found' });

    if (target.id === blockerId) {
      throw new BadRequestException({ code: ErrorCodes.CANNOT_BLOCK_SELF, message: 'Cannot block yourself' });
    }

    await this.withSerializableRetry(() =>
      this.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
        const existing = await tx.blockList.findUnique({
          where: { blockerId_blockedId: { blockerId, blockedId: target.id } },
        });
        if (existing) throw new ConflictException({ code: ErrorCodes.USER_ALREADY_BLOCKED, message: 'User is already blocked' });

        await tx.blockList.create({ data: { blockerId, blockedId: target.id } });
        await tx.follow.deleteMany({ where: { OR: [{ followerId: blockerId, followingId: target.id }, { followerId: target.id, followingId: blockerId }] } });
        await tx.userFavorite.deleteMany({ where: { OR: [{ userId: blockerId, favoriteUserId: target.id }, { userId: target.id, favoriteUserId: blockerId }] } });
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }),
    );

    return { message: 'User blocked successfully' };
  }

  async unblockUser(blockerId: string, targetUserId: string): Promise<{ message: string }> {
    const target = await this.prisma.user.findUnique({ where: { userId: targetUserId }, select: { id: true } });
    if (!target) throw new NotFoundException({ code: ErrorCodes.USER_NOT_FOUND, message: 'User not found' });

    const existing = await this.prisma.blockList.findUnique({
      where: { blockerId_blockedId: { blockerId, blockedId: target.id } },
    });
    if (!existing) throw new BadRequestException({ code: ErrorCodes.USER_NOT_BLOCKED, message: 'User is not in the blocked list' });

    await this.prisma.blockList.delete({ where: { id: existing.id } });
    return { message: 'User unblocked successfully' };
  }

  async getBlockedUsers(userId: string, page: number, limit: number): Promise<object> {
    const { page: safePage, limit: safeLimit, skip } = this.normalizePagination(page, limit);

    const [blocks, total] = await Promise.all([
      this.prisma.blockList.findMany({
        where: { blockerId: userId },
        skip, take: safeLimit, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], // R2-L: stable page ordering
        select: { id: true, createdAt: true, blocked: { select: { userId: true, username: true, fullName: true, avatarUrl: true } } },
      }),
      this.prisma.blockList.count({ where: { blockerId: userId } }),
    ]);

    return { users: blocks.map(b => ({ ...b.blocked, blockedAt: b.createdAt, blockId: b.id })), total, page: safePage, limit: safeLimit };
  }

  // ========== REPORT ==========

  async reportUser(reporterId: string, targetUserId: string, dto: ReportUserDto): Promise<{ message: string }> {
    const target = await this.prisma.user.findUnique({ where: { userId: targetUserId }, select: { id: true } });
    if (!target) throw new NotFoundException({ code: ErrorCodes.USER_NOT_FOUND, message: 'User not found' });

    if (target.id === reporterId) {
      throw new BadRequestException({ code: ErrorCodes.CANNOT_REPORT_SELF, message: 'Cannot report yourself' });
    }


    if (dto.evidenceUrls?.length) {
      // Self-hosted (2026-09-26, ST-007; R2 dibuang 2026-10-07): storage
      // utama adalah disk server. Bukti yang diunggah via POST
      // /v1/upload/direct menghasilkan URL https://api.kahade.id/uploads/...
      // — hostname inilah yang dipercaya.
      const trustedHostnames: string[] = [];
      const storagePublicUrl = this.configService.get<string>('app.storagePublicUrl') || 'https://api.kahade.id/uploads';
      try { trustedHostnames.push(new URL(storagePublicUrl).hostname); } catch {}
      if (trustedHostnames.length === 0) {
        throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Storage is not configured' });
      }
      for (const rawUrl of dto.evidenceUrls) {
        try {
          const parsed = new URL(rawUrl);
          if (parsed.protocol !== 'https:') {
            throw new Error('not https');
          }
          // Only configured application storage hosts are trusted. Broad R2
          // suffixes are not platform ownership proofs and allow attacker-owned
          // buckets to be submitted as report evidence.
          const isTrusted = trustedHostnames.some(h => parsed.hostname === h || parsed.hostname.endsWith(`.${h}`));
          if (!isTrusted) {
            throw new Error('domain mismatch');
          }
        } catch {
          throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Evidence URL must be from platform storage' });
        }
      }
    }

    if (dto.relatedOrderId) {
      const relatedOrder = await this.prisma.order.findUnique({
        where: { id: dto.relatedOrderId },
        select: { buyerId: true, sellerId: true },
      });
      const participants = relatedOrder ? [relatedOrder.buyerId, relatedOrder.sellerId] : [];
      if (!relatedOrder || !participants.includes(reporterId) || !participants.includes(target.id)) {
        throw new NotFoundException({ code: ErrorCodes.ORDER_NOT_FOUND, message: 'Related order not found' });
      }
    }

    const reportCooldownKey = `user-report:cooldown:${reporterId}:${target.id}`;
    const reportLockValue = randomUUID();
    let reportLockAcquired = false;
    let redisAvailable = false;
    try {
      redisAvailable = true;
      reportLockAcquired = (await this.redis.setNx(reportCooldownKey, reportLockValue, 24 * 60 * 60)) === true;
    } catch {
      // Database recency check below remains the fallback when Redis is unavailable.
    }

    const DAILY_REPORT_LIMIT = 10;
    let recentReport: { id: string } | null;
    let dailyReportCount: number;
    try {
      recentReport = await this.prisma.userReport.findFirst({
        where: {
          reporterId,
          targetId: target.id,
          status: 'PENDING',
          createdAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) },
        },
        select: { id: true },
      });
      dailyReportCount = await this.prisma.userReport.count({
        where: {
          reporterId,
          createdAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) },
        },
      });
    } catch (error) {
      if (reportLockAcquired) await this.redis.releaseLock(reportCooldownKey, reportLockValue).catch(() => undefined);
      throw error;
    }

    if (recentReport || (redisAvailable && !reportLockAcquired)) {
      if (reportLockAcquired) await this.redis.releaseLock(reportCooldownKey, reportLockValue).catch(() => undefined);
      throw new ConflictException({ code: ErrorCodes.DUPLICATE_REPORT, message: 'You have already reported this user in the last 24 hours' });
    }
    if (dailyReportCount >= DAILY_REPORT_LIMIT) {
      if (reportLockAcquired) await this.redis.releaseLock(reportCooldownKey, reportLockValue).catch(() => undefined);
      throw new BadRequestException({ code: ErrorCodes.DAILY_REPORT_LIMIT_EXCEEDED, message: 'Daily report limit reached. Try again tomorrow.' });
    }

    try {
      await this.prisma.userReport.create({
        data: {
          reporterId,
          targetId: target.id,
          category: dto.category,
          description: dto.description,
          evidenceUrls: dto.evidenceUrls ?? [],
          relatedOrderId: dto.relatedOrderId,
        },
      });
    } catch (error) {
      if (reportLockAcquired) await this.redis.releaseLock(reportCooldownKey, reportLockValue).catch(() => undefined);
      throw error;
    }

    // Section 6: laporan sudah tersimpan, baru agregasi dihitung. evaluateTarget
    // tidak pernah melempar, jadi kegagalan agregasi tidak membatalkan laporan.
    // Tidak ada auto-ban di sini — hanya flag antrean review untuk admin.
    await this.reportFlagService.evaluateTarget(target.id);

    return { message: 'Report submitted successfully' };
  }

  // ========== USER LINKS ==========

  async updateLinks(userId: string, dto: UpdateLinksDto): Promise<object> {
    const MAX_SOCIAL_LINKS = 10;
    if (dto.links.length > MAX_SOCIAL_LINKS) {
      throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: `Maximum ${MAX_SOCIAL_LINKS} social links allowed` });
    }

    const normalizedLinks = dto.links.map((link) => ({
      ...link,
      platform: link.platform.trim().toLowerCase(),
      url: link.url.trim(),
      label: link.label?.trim() || undefined,
    }));
    const platforms = new Set<string>();
    for (const link of normalizedLinks) {
      if (!link.platform) {
        throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Social link platform is required' });
      }
      if (platforms.has(link.platform)) {
        throw new ConflictException({ code: ErrorCodes.VALIDATION_ERROR, message: `Duplicate social link platform: ${link.platform}` });
      }
      platforms.add(link.platform);
      try {
        const parsed = new URL(link.url);
        if (parsed.protocol !== 'https:') {
          throw new BadRequestException({ code: ErrorCodes.INVALID_SOCIAL_LINK_URL, message: `Social link URL must use HTTPS: ${link.url}` });
        }
      } catch (e) {
        if (e instanceof BadRequestException) throw e;
        throw new BadRequestException({ code: ErrorCodes.INVALID_SOCIAL_LINK_URL, message: `Invalid social link URL: ${link.url}` });
      }
    }

    await this.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      const existingLinks = await tx.userLink.findMany({ where: { userId }, select: { id: true, platform: true } });
      const existingMap = new Map(existingLinks.map(l => [l.platform, l.id]));
      const incomingPlatforms = new Set(normalizedLinks.map(l => l.platform));

      for (const existing of existingLinks) {
        if (!incomingPlatforms.has(existing.platform)) {
          await tx.userLink.delete({ where: { id: existing.id } });
        }
      }

      for (const [index, link] of normalizedLinks.entries()) {
        const existingId = existingMap.get(link.platform);
        if (existingId) {
          await tx.userLink.update({
            where: { id: existingId },
            data: { url: link.url, label: link.label, displayOrder: index },
          });
        } else {
          await tx.userLink.create({
            data: {
              userId,
              platform: link.platform,
              url: link.url,
              label: link.label,
              displayOrder: index,
            },
          });
        }
      }
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });

    const links = await this.prisma.userLink.findMany({
      where: { userId },
      orderBy: { displayOrder: 'asc' },
      select: { id: true, platform: true, url: true, label: true, displayOrder: true },
    });

    return { links };
  }

  async getMyLinks(userId: string): Promise<object> {
    const links = await this.prisma.userLink.findMany({
      where: { userId },
      orderBy: { displayOrder: 'asc' },
      select: { id: true, platform: true, url: true, label: true, displayOrder: true },
    });
    return { links };
  }

  // ========== HEADER IMAGE ==========

  /**
   * @deprecated R2 dibuang (2026-09-26, SS-007/ST-007). Presigned URL tidak
   * didukung lagi — gunakan POST /v1/users/me/header/direct.
   */
  async uploadHeader(userId: string, contentType?: string): Promise<{ uploadUrl: string; headerKey: string; expiresIn: number }> {
    throw new BadRequestException({
      code: 'DEPRECATED',
      message: 'Presigned URL header upload is no longer supported. Use POST /v1/users/me/header/direct instead.',
    });
  }

  async confirmHeader(userId: string, headerKey: string): Promise<{ headerUrl: string }> {
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { id: true, username: true, headerUrl: true } });
    if (!user) throw new NotFoundException({ code: ErrorCodes.USER_NOT_FOUND, message: 'User not found' });

    const baseName = path.basename(headerKey);
    // BFI-103: terima key kanonis BARU (`uploads/headers/<uid>/…`) DAN key
    // LEGACY (`headers/<uid>/…`) — kepemilikan tetap dicek via segmen userId.
    const expectedPrefix = headerKey.startsWith(`uploads/headers/${userId}/`)
      ? `uploads/headers/${userId}/`
      : `headers/${userId}/`;
    const normalizedKey = `${expectedPrefix}${baseName}`;
    if (normalizedKey !== headerKey || !baseName || baseName.includes('..')) {
      throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Invalid header key' });
    }

    // UPI-08: idempoten — uploadHeaderDirect SUDAH mem-publish header ke DB,
    // sehingga confirm untuk key yang sudah live adalah no-op.
    if (user.headerUrl === this.localStorage.getPublicUrl(normalizedKey)) {
      return { headerUrl: user.headerUrl };
    }

    // Self-hosted (2026-09-26): verifikasi ke disk lokal, bukan R2.
    try {
      const size = await this.localStorage.getFileSize(headerKey);
      if (size === null) throw new Error('not found');
      if (size > UsersService.MAX_HEADER_BYTES) {
        await this.localStorage.deleteFile(headerKey);
        throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Header file exceeds maximum allowed size' });
      }
    } catch (err) {
      if (err instanceof BadRequestException) throw err;
      throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Header file not found in storage. Please upload the file first.' });
    }

    const headerUrl = this.localStorage.getPublicUrl(headerKey);

    await this.prisma.user.update({ where: { id: userId }, data: { headerUrl } });
    // UPI-06: last-write-wins yang aman (lihat uploadAvatarDirect). Bila
    // kalah race, file key ini yatim → hapus best-effort.
    const currentHeader = await this.prisma.user.findUnique({ where: { id: userId }, select: { headerUrl: true } });
    if (currentHeader?.headerUrl === headerUrl) {
      await this.deleteStoredMediaQuietly(user.headerUrl, headerKey);
    } else {
      try {
        await this.localStorage.deleteFile(headerKey);
      } catch (err) {
        this.logger.warn(`Failed to delete losing header confirm ${headerKey}`, err);
      }
    }
    this.invalidateUserOgCaches(user.username);
    return { headerUrl };
  }

  async uploadHeaderDirect(userId: string, fileName: string, contentType: string, fileBuffer: Buffer): Promise<{ headerUrl: string }> {
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { id: true, username: true, headerUrl: true } });
    if (!user) throw new NotFoundException({ code: ErrorCodes.USER_NOT_FOUND, message: 'User not found' });

    const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
    if (!ALLOWED_TYPES.includes(contentType)) {
      throw new BadRequestException({
        code: ErrorCodes.VALIDATION_ERROR,
        message: `contentType must be image/jpeg, image/png, or image/webp`,
      });
    }

    const MAX_SIZE = 5 * 1024 * 1024;
    if (fileBuffer.length > MAX_SIZE) {
      // UPI-07: file kebesaran → 413 terstruktur (konsisten dengan
      // /v1/upload/direct), bukan 400 VALIDATION_ERROR.
      throw new PayloadTooLargeException({
        code: ErrorCodes.FILE_TOO_LARGE,
        message: 'File exceeds maximum allowed size of 5 MB',
      });
    }

    const detectedType = this.detectImageMimeType(fileBuffer);
    if (!detectedType || detectedType !== contentType) {
      throw new BadRequestException({
        code: ErrorCodes.VALIDATION_ERROR,
        message: 'File content does not match the declared content type',
      });
    }

    const ext = contentType === 'image/png' ? 'png' : contentType === 'image/webp' ? 'webp' : 'jpg';
    // BFI-103: key kanonis BARU memakai prefix `uploads/` (lihat avatar di atas).
    const headerKey = `uploads/headers/${userId}/${nanoid(16)}.${ext}`;

    // UPF-01: strip EXIF/GPS (termasuk koordinat) sebelum simpan — sampul
    // disajikan publik via nginx. Pola sama seperti uploadDirectTx.
    const safeBuffer = stripImageMetadata(fileBuffer, detectedType);

    // Self-hosted (2026-09-26, SS-007/ST-007): R2 diganti LocalStorageService.
    try {
      await this.localStorage.saveFile(headerKey, safeBuffer);
    } catch (err) {
      this.logger.error('Self-hosted direct header upload failed', err);
      throw new BadRequestException({
        code: ErrorCodes.UPLOAD_FAILED,
        message: 'Failed to upload header to storage. Please try again.',
      });
    }

    const headerUrl = this.localStorage.getPublicUrl(headerKey);

    await this.prisma.user.update({ where: { id: userId }, data: { headerUrl } });
    // UPI-06: last-write-wins yang aman untuk upload paralel (lihat
    // uploadAvatarDirect): pemenang menghapus header lama, yang kalah
    // menghapus file-nya sendiri.
    const currentHeader = await this.prisma.user.findUnique({ where: { id: userId }, select: { headerUrl: true } });
    if (currentHeader?.headerUrl === headerUrl) {
      // Hapus header lama dari disk (best-effort).
      await this.deleteStoredMediaQuietly(user.headerUrl, headerKey);
    } else {
      try {
        await this.localStorage.deleteFile(headerKey);
      } catch (err) {
        this.logger.warn(`Failed to delete losing header upload ${headerKey}`, err);
      }
    }
    this.invalidateUserOgCaches(user.username);
    return { headerUrl };
  }

  // ========== FAVORITES ==========

  private isPubliclyAvailableSocialTarget<T extends { isActive?: boolean; isBanned?: boolean; deletedAt?: Date | null }>(target: T | null): target is T {
    return target !== null && target.isActive !== false && target.isBanned !== true && !target.deletedAt;
  }

  async getFavorites(userId: string, page: number, limit: number): Promise<object> {
    const { page: safePage, limit: safeLimit, skip } = this.normalizePagination(page, limit);

    const [favorites, total] = await Promise.all([
      this.prisma.userFavorite.findMany({
        where: {
          userId,
          favoriteUser: { isActive: true, isBanned: false, deletedAt: null },
        },
        skip,
        take: safeLimit,
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          favoriteUserId: true,
          createdAt: true,
          favoriteUser: {
            select: {
              id: true,
              userId: true,
              fullName: true,
              username: true,
              avatarUrl: true,
              isKahadePlus: true,
              kycStatus: true,
              averageRating: true,
              totalOrdersCompleted: true,
              totalTransactionValue: true,
            },
          },
        },
      }),
      this.prisma.userFavorite.count({
        where: {
          userId,
          favoriteUser: { isActive: true, isBanned: false, deletedAt: null },
        },
      }),
    ]);

    return {
      favorites: favorites.map(f => ({
        id: f.id,
        favoriteUserId: f.favoriteUserId,
        createdAt: f.createdAt,
        user: {
          id: f.favoriteUser.id,
          userId: f.favoriteUser.userId,
          fullName: f.favoriteUser.fullName,
          username: f.favoriteUser.username,
          avatarUrl: f.favoriteUser.avatarUrl,
          isKahadePlus: f.favoriteUser.isKahadePlus,
          kycStatus: f.favoriteUser.kycStatus,
          stats: {
            averageRating: Number(f.favoriteUser.averageRating),
            totalOrdersCompleted: f.favoriteUser.totalOrdersCompleted,
          },
        },
      })),
      total,
      page: safePage,
      limit: safeLimit,
    };
  }

  async checkFavorite(userId: string, username: string): Promise<{ isFavorited: boolean }> {
    const target = await this.prisma.user.findUnique({ where: { username: username.toLowerCase() }, select: { id: true, isActive: true, isBanned: true, deletedAt: true } });
    if (!this.isPubliclyAvailableSocialTarget(target)) throw new NotFoundException({ code: ErrorCodes.USER_NOT_FOUND, message: 'User not found' });

    const blocked = await this.prisma.blockList.findFirst({
      where: { OR: [{ blockerId: userId, blockedId: target.id }, { blockerId: target.id, blockedId: userId }] },
    });
    if (blocked) throw new NotFoundException({ code: ErrorCodes.USER_NOT_FOUND, message: 'User not found' });

    const existing = await this.prisma.userFavorite.findUnique({
      where: { userId_favoriteUserId: { userId, favoriteUserId: target.id } },
    });
    return { isFavorited: !!existing };
  }

  async addFavorite(userId: string, username: string): Promise<{ message: string }> {
    const target = await this.prisma.user.findUnique({ where: { username: username.toLowerCase() }, select: { id: true, isActive: true, isBanned: true, deletedAt: true } });
    if (!this.isPubliclyAvailableSocialTarget(target)) throw new NotFoundException({ code: ErrorCodes.USER_NOT_FOUND, message: 'User not found' });

    if (target.id === userId) {
      throw new BadRequestException({ code: ErrorCodes.CANNOT_FAVORITE_SELF, message: 'Cannot favorite yourself' });
    }

    await this.withSerializableRetry(() =>
      this.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
        const blocked = await tx.blockList.findFirst({
          where: { OR: [{ blockerId: userId, blockedId: target.id }, { blockerId: target.id, blockedId: userId }] },
        });
        if (blocked) throw new NotFoundException({ code: ErrorCodes.USER_NOT_FOUND, message: 'User not found' });

        const existing = await tx.userFavorite.findUnique({
          where: { userId_favoriteUserId: { userId, favoriteUserId: target.id } },
        });
        if (existing) return;

        try {
          await tx.userFavorite.create({ data: { userId, favoriteUserId: target.id } });
        } catch (err: unknown) {
          // A fresh double-tap can race after the preflight read. The unique
          // relation is authoritative, and the intended end-state is already
          // reached, so POST remains safely idempotent.
          if (!(err instanceof Prisma.PrismaClientKnownRequestError) || err.code !== 'P2002') throw err;
        }
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }),
    );

    return { message: 'Added to favorites successfully' };
  }

  async removeFavorite(userId: string, targetUserId: string): Promise<{ message: string }> {
    const target = await this.prisma.user.findFirst({
      where: { OR: [{ id: targetUserId }, { userId: targetUserId }, { username: targetUserId.toLowerCase() }] },
      select: { id: true },
    });
    if (!target) throw new NotFoundException({ code: ErrorCodes.USER_NOT_FOUND, message: 'User not found' });

    // Delete atomically rather than read-then-delete. Repeated removals are a
    // successful no-op, preventing a double-tap/race from surfacing as P2025.
    await this.prisma.userFavorite.deleteMany({
      where: { userId, favoriteUserId: target.id },
    });
    return { message: 'Removed from favorites successfully' };
  }

  // ========== SAVED PROFILES ==========

  async getSavedProfiles(userId: string, page: number, limit: number): Promise<object> {
    const { page: safePage, limit: safeLimit, skip } = this.normalizePagination(page, limit);
    const [saved, total] = await Promise.all([
      this.prisma.userSavedProfile.findMany({
        where: {
          userId,
          savedUser: { isActive: true, isBanned: false, deletedAt: null },
        },
        skip,
        take: safeLimit,
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          savedUserId: true,
          createdAt: true,
          savedUser: {
            select: {
              id: true,
              userId: true,
              fullName: true,
              username: true,
              avatarUrl: true,
              isKahadePlus: true,
              kycStatus: true,
              averageRating: true,
              totalOrdersCompleted: true,
            },
          },
        },
      }),
      this.prisma.userSavedProfile.count({
        where: {
          userId,
          savedUser: { isActive: true, isBanned: false, deletedAt: null },
        },
      }),
    ]);

    return {
      saved: saved.map((entry) => ({
        id: entry.id,
        savedUserId: entry.savedUserId,
        createdAt: entry.createdAt,
        user: {
          id: entry.savedUser.id,
          userId: entry.savedUser.userId,
          fullName: entry.savedUser.fullName,
          username: entry.savedUser.username,
          avatarUrl: entry.savedUser.avatarUrl,
          isKahadePlus: entry.savedUser.isKahadePlus,
          kycStatus: entry.savedUser.kycStatus,
          stats: {
            averageRating: Number(entry.savedUser.averageRating),
            totalOrdersCompleted: entry.savedUser.totalOrdersCompleted,
          },
        },
      })),
      total,
      page: safePage,
      limit: safeLimit,
    };
  }

  async checkSavedProfile(userId: string, username: string): Promise<{ isSaved: boolean }> {
    const target = await this.prisma.user.findUnique({ where: { username: username.toLowerCase() }, select: { id: true, isActive: true, isBanned: true, deletedAt: true } });
    if (!this.isPubliclyAvailableSocialTarget(target)) throw new NotFoundException({ code: ErrorCodes.USER_NOT_FOUND, message: 'User not found' });
    const blocked = await this.prisma.blockList.findFirst({
      where: { OR: [{ blockerId: userId, blockedId: target.id }, { blockerId: target.id, blockedId: userId }] },
    });
    if (blocked) throw new NotFoundException({ code: ErrorCodes.USER_NOT_FOUND, message: 'User not found' });
    const existing = await this.prisma.userSavedProfile.findUnique({
      where: { userId_savedUserId: { userId, savedUserId: target.id } },
    });
    return { isSaved: Boolean(existing) };
  }

  async saveProfile(userId: string, username: string): Promise<{ message: string }> {
    const target = await this.prisma.user.findUnique({ where: { username: username.toLowerCase() }, select: { id: true, isActive: true, isBanned: true, deletedAt: true } });
    if (!this.isPubliclyAvailableSocialTarget(target)) throw new NotFoundException({ code: ErrorCodes.USER_NOT_FOUND, message: 'User not found' });
    if (target.id === userId) {
      throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Cannot save your own profile' });
    }

    await this.withSerializableRetry(() => this.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      const blocked = await tx.blockList.findFirst({
        where: { OR: [{ blockerId: userId, blockedId: target.id }, { blockerId: target.id, blockedId: userId }] },
      });
      if (blocked) throw new NotFoundException({ code: ErrorCodes.USER_NOT_FOUND, message: 'User not found' });
      const existing = await tx.userSavedProfile.findUnique({
        where: { userId_savedUserId: { userId, savedUserId: target.id } },
      });
      if (existing) return;
      try {
        await tx.userSavedProfile.create({ data: { userId, savedUserId: target.id } });
      } catch (err: unknown) {
        if (!(err instanceof Prisma.PrismaClientKnownRequestError) || err.code !== 'P2002') throw err;
      }
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }));

    return { message: 'Profile saved successfully' };
  }

  async removeSavedProfile(userId: string, targetUserId: string): Promise<{ message: string }> {
    const target = await this.prisma.user.findFirst({
      where: { OR: [{ id: targetUserId }, { userId: targetUserId }, { username: targetUserId.toLowerCase() }] },
      select: { id: true },
    });
    if (!target) throw new NotFoundException({ code: ErrorCodes.USER_NOT_FOUND, message: 'User not found' });
    await this.prisma.userSavedProfile.deleteMany({ where: { userId, savedUserId: target.id } });
    return { message: 'Removed saved profile successfully' };
  }

  async deleteHeader(userId: string): Promise<{ message: string }> {
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { username: true, headerUrl: true } });
    if (user?.headerUrl) {
      const headerKey = this.extractKeyFromUrl(user.headerUrl);
      if (headerKey) {
        try {
          await this.localStorage.deleteFile(headerKey);
        } catch (err) {
          this.logger.warn(`Failed to delete header file for user ${userId}`, err);
        }
      }
    }
    await this.prisma.user.update({ where: { id: userId }, data: { headerUrl: null } });
    this.invalidateUserOgCaches(user?.username);
    return { message: 'Header image deleted successfully' };
  }

  // ============================================================
  // SHOWCASE
  // ============================================================
  // Section 3: seluruh logika showcase (etalase, gambar, like, komentar, feed
  // discover) dipindah ke ShowcaseService di src/modules/showcase/.
  // Route owner lama (/users/me/showcase*) tetap ada di UsersController dan
  // sekarang mendelegasikan ke service tersebut, jadi tidak ada URL yang berubah.
}
