import { Injectable, NotFoundException, BadRequestException, ConflictException, ForbiddenException, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service';
import { RedisService } from '../../redis/redis.service';
import { Gender, KycStatus, NotificationType, OrderStatus, Prisma, UserAccountType, UserAuditAction, WalletTransactionType, WithdrawStatus } from '@prisma/client';
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
import { MAX_LIMIT } from '../../common/constants/app.constants';
import { TOKEN_BLACKLIST, SESSION_REVOKED_KEY, TOTP_USED_CODE } from '../../common/constants/redis-keys';
import { UpdateProfileDto } from './dto/update-profile.dto';
import { ReportUserDto } from './dto/report-user.dto';
import { UpdateLinksDto } from './dto/update-links.dto';
import { CreateShowcaseDto, UpdateShowcaseDto } from './dto/showcase.dto';
import { OgMetadataService } from './og-metadata.service';
import { generateNotifId } from '../../common/utils/id-generator.util';
import { getCategoryForType } from '../notifications/notification-category.map';
import { verifyOtp } from '../../common/utils/otp.util';

@Injectable()
export class UsersService {
  private readonly logger = new Logger(UsersService.name);

  private s3Client: unknown = null;
  private s3Modules: Record<string, unknown> | null = null;

  constructor(
    private prisma: PrismaService,
    private redis: RedisService,
    private configService: ConfigService,
    private auditLog: AuditLogService,
    private ogMetadataService: OgMetadataService,
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
    if (dto.accountType !== undefined) updateData.accountType = dto.accountType as UserAccountType;
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

  async getPublicProfile(username: string, viewerId?: string): Promise<object> {
    const user = await this.prisma.user.findUnique({
      where: { username: username.toLowerCase() },
      select: {
        id: true, userId: true, username: true, fullName: true, avatarUrl: true, headerUrl: true,
        accountType: true, bio: true, kycStatus: true, isVip: true, membershipRank: true,
        totalOrdersCompleted: true, averageRating: true, totalRatingCount: true, memberSince: true,
        profileVisible: true, showContactEmail: true, contactEmail: true, showContactPhone: true, contactPhone: true,
        isActive: true, isBanned: true, deletedAt: true,
        badges: { select: { badge: { select: { name: true, iconUrl: true, description: true } }, earnedAt: true } },
        ratingsReceived: {
          where: { isHidden: false, giver: { isActive: true, isBanned: false, deletedAt: null } },
          orderBy: { createdAt: 'desc' },
          take: 5,
          select: { stars: true, comment: true, createdAt: true, giver: { select: { username: true, avatarUrl: true } } },
        },
        links: {
          orderBy: { displayOrder: 'asc' },
          select: { id: true, platform: true, url: true, label: true, displayOrder: true },
        },
        _count: {
          select: {
            followers: { where: { follower: { isActive: true, isBanned: false, deletedAt: null, profileVisible: true } } },
            following: { where: { following: { isActive: true, isBanned: false, deletedAt: null, profileVisible: true } } },
          },
        },
      },
    });
    if (!user) throw new NotFoundException({ code: ErrorCodes.USER_NOT_FOUND, message: 'User not found' });

    if (!user.profileVisible || user.isActive === false || user.isBanned === true || user.deletedAt != null) {
      throw new NotFoundException({ code: ErrorCodes.USER_NOT_FOUND, message: 'User not found' });
    }

    let isFollowing = false;
    let isBlocked = false;
    if (viewerId && viewerId !== user.id) {
      const [followRow, blockRow, reverseBlockRow] = await Promise.all([
        this.prisma.follow.findUnique({ where: { followerId_followingId: { followerId: viewerId, followingId: user.id } } }),
        this.prisma.blockList.findUnique({ where: { blockerId_blockedId: { blockerId: viewerId, blockedId: user.id } } }),
        this.prisma.blockList.findUnique({ where: { blockerId_blockedId: { blockerId: user.id, blockedId: viewerId } } }),
      ]);
      isFollowing = !!followRow;
      isBlocked = !!blockRow;
      if (reverseBlockRow) {
        throw new NotFoundException({ code: ErrorCodes.USER_NOT_FOUND, message: 'User not found' });
      }
    }

    return {
      userId: user.userId, username: user.username, fullName: user.fullName, avatarUrl: user.avatarUrl, headerUrl: user.headerUrl,
      accountType: user.accountType, bio: user.bio, isKycVerified: user.kycStatus === KycStatus.APPROVED,
      isVip: user.isVip, membershipRank: user.membershipRank,
      badges: user.badges.map((ub: { badge: { name: string; iconUrl: string | null; description: string | null }; earnedAt: Date }) => ({ ...ub.badge, earnedAt: ub.earnedAt })),
      stats: { totalOrders: user.totalOrdersCompleted, avgRating: Number(user.averageRating ?? 0), ratingCount: user.totalRatingCount, memberSince: user.memberSince },
      recentRatings: user.ratingsReceived,
      links: user.links,
      followersCount: user._count.followers,
      followingCount: user._count.following,
      isFollowing,
      isBlocked,
      contact: {
        email: user.showContactEmail ? user.contactEmail : null,
        phone: user.showContactPhone ? user.contactPhone : null,
      },
    };
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
        SELECT "userId", username, "fullName", "avatarUrl", "membershipRank"
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
    const mapped = users.map((u: UserRow) => ({
      userId: u.userId,
      username: u.username,
      fullName: u.fullName,
      avatarUrl: u.avatarUrl,
      membershipRank: u.membershipRank,
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

  private async getS3Client(): Promise<{ s3: unknown; modules: Record<string, unknown> }> {
    if (!this.s3Modules) {
      const [s3Module, presignerModule] = await Promise.all([
        import('@aws-sdk/client-s3'),
        import('@aws-sdk/s3-request-presigner'),
      ]);
      this.s3Modules = { ...s3Module, getSignedUrl: presignerModule.getSignedUrl };
    }

    if (!this.s3Client) {
      const accessKeyId = this.configService.get<string>('r2.accessKeyId');
      const secretAccessKey = this.configService.get<string>('r2.secretAccessKey');
      const endpointUrl = this.configService.get<string>('r2.endpointUrl');

      if (!accessKeyId || !secretAccessKey) {
        throw new Error('R2 credentials (R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY) are not configured. File upload is unavailable.');
      }
      if (!endpointUrl) {
        throw new Error('R2 endpoint URL is not configured (R2_ACCOUNT_ID missing). File upload is unavailable.');
      }

      const S3ClientConstructor = this.s3Modules['S3Client'] as new (config: Record<string, unknown>) => unknown;
      this.s3Client = new S3ClientConstructor({
        region: 'auto',
        endpoint: endpointUrl,
        credentials: { accessKeyId, secretAccessKey },
        forcePathStyle: true,
      });
    }

    return { s3: this.s3Client, modules: this.s3Modules as Record<string, unknown> };
  }

  async uploadAvatar(userId: string, contentType?: string): Promise<{ uploadUrl: string; avatarKey: string; expiresIn: number }> {
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { id: true } });
    if (!user) throw new NotFoundException({ code: ErrorCodes.USER_NOT_FOUND, message: 'User not found' });

    const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
    const mimeType = contentType && ALLOWED_TYPES.includes(contentType) ? contentType : 'image/jpeg';
    const ext = mimeType === 'image/png' ? 'png' : mimeType === 'image/webp' ? 'webp' : 'jpg';
    const avatarKey = `avatars/${userId}/${nanoid(16)}.${ext}`;
    const expiresIn = this.configService.get<number>('r2.presignExpires') ?? 300;

    try {
      const bucket = this.configService.get<string>('r2.bucketPublic');
      if (!bucket) {
        throw new Error('R2_BUCKET_PUBLIC is not configured');
      }

      const { s3, modules } = await this.getS3Client();
      const PutObjectCommand = modules['PutObjectCommand'] as new (input: Record<string, unknown>) => unknown;

      const command = new PutObjectCommand({
        Bucket: bucket,
        Key: avatarKey,
        ContentType: mimeType,
      });

      const getSignedUrl = modules['getSignedUrl'] as (client: unknown, command: unknown, options: Record<string, unknown>) => Promise<string>;
      const uploadUrl = await getSignedUrl(s3, command, { expiresIn });
      return { uploadUrl, avatarKey, expiresIn };
    } catch (err) {
      this.logger.error('R2 avatar presigned URL generation failed', err);
      throw new BadRequestException({
        code: ErrorCodes.UPLOAD_FAILED,
        message: 'Failed to create avatar upload URL. Please check storage configuration.',
      });
    }
  }

  async uploadAvatarDirect(userId: string, fileName: string, contentType: string, fileBuffer: Buffer): Promise<{ avatarUrl: string }> {
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
      throw new BadRequestException({
        code: ErrorCodes.VALIDATION_ERROR,
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
    const avatarKey = `avatars/${userId}/${nanoid(16)}.${ext}`;

    const bucket = this.configService.get<string>('r2.bucketPublic');
    if (!bucket) {
      throw new BadRequestException({
        code: ErrorCodes.UPLOAD_FAILED,
        message: 'R2_BUCKET_PUBLIC is not configured',
      });
    }

    try {
      const { s3, modules } = await this.getS3Client();
      const PutObjectCommand = modules['PutObjectCommand'] as new (input: Record<string, unknown>) => unknown;
      const command = new PutObjectCommand({
        Bucket: bucket,
        Key: avatarKey,
        ContentType: contentType,
        Body: fileBuffer,
      });
      const send = (s3 as { send: (cmd: unknown) => Promise<unknown> }).send.bind(s3);
      await send(command);
    } catch (err) {
      this.logger.error('R2 direct avatar upload failed', err);
      throw new BadRequestException({
        code: ErrorCodes.UPLOAD_FAILED,
        message: 'Failed to upload avatar to storage. Please try again.',
      });
    }

    const publicUrl = this.configService.get<string>('r2.publicUrl');
    const avatarUrl = publicUrl ? `${publicUrl}/${avatarKey}` : `/uploads/${avatarKey}`;

    if (user.avatarUrl) {
      try {
        const oldKey = this.extractKeyFromUrl(user.avatarUrl);
        if (oldKey) {
          const { s3, modules } = await this.getS3Client();
          const DeleteObjectCommand = modules['DeleteObjectCommand'] as new (input: Record<string, unknown>) => unknown;
          const command = new DeleteObjectCommand({ Bucket: bucket, Key: oldKey });
          const send = (s3 as { send: (cmd: unknown) => Promise<unknown> }).send.bind(s3);
          await send(command);
        }
      } catch (err) {
        this.logger.warn(`Failed to delete old avatar for user ${userId}`, err);
      }
    }

    await this.prisma.user.update({ where: { id: userId }, data: { avatarUrl } });
    this.invalidateUserOgCaches(user.username);
    return { avatarUrl };
  }

  async confirmAvatar(userId: string, avatarKey: string): Promise<{ avatarUrl: string }> {
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { id: true, username: true } });
    if (!user) throw new NotFoundException({ code: ErrorCodes.USER_NOT_FOUND, message: 'User not found' });

    const normalizedKey = avatarKey.replace(/\.\.\//g, '').replace(/\/+/g, '/');
    if (!normalizedKey.startsWith(`avatars/${userId}/`) || normalizedKey !== avatarKey) {
      throw new BadRequestException({
        code: ErrorCodes.VALIDATION_ERROR,
        message: 'Invalid avatar key',
      });
    }

    const bucket = this.configService.get<string>('r2.bucketPublic');

    if (bucket) {
      try {
        const { s3, modules } = await this.getS3Client();
        const GetObjectCommand = modules['GetObjectCommand'] as new (input: Record<string, unknown>) => unknown;
        const command = new GetObjectCommand({ Bucket: bucket, Key: avatarKey, Range: 'bytes=0-15' });
        const send = (s3 as { send: (cmd: unknown) => Promise<{ Body?: { transformToByteArray?: () => Promise<Uint8Array> }; ContentType?: string }> }).send.bind(s3);
        const response = await send(command);
        if (response.Body?.transformToByteArray) {
          const headerBytes = Buffer.from(await response.Body.transformToByteArray());
          const detectedType = this.detectImageMimeType(headerBytes);
          if (!detectedType) {
            const DeleteObjectCommand = modules['DeleteObjectCommand'] as new (input: Record<string, unknown>) => unknown;
            const delCmd = new DeleteObjectCommand({ Bucket: bucket, Key: avatarKey });
            await send(delCmd as unknown as Record<string, unknown>);
            throw new BadRequestException({
              code: ErrorCodes.VALIDATION_ERROR,
              message: 'Uploaded file is not a valid image. Please upload a JPEG, PNG, or WebP image.',
            });
          }
        }
      } catch (err) {
        if (err instanceof BadRequestException) throw err;
        throw new BadRequestException({
          code: ErrorCodes.VALIDATION_ERROR,
          message: 'Avatar file not found in storage. Please upload the file first.',
        });
      }
    }

    const publicUrl = this.configService.get<string>('r2.publicUrl');

    const avatarUrl = publicUrl
      ? `${publicUrl}/${avatarKey}`
      : `/uploads/${avatarKey}`;

    await this.prisma.user.update({
      where: { id: userId },
      data: { avatarUrl },
    });
    this.invalidateUserOgCaches(user.username);

    return { avatarUrl };
  }

  async deleteAvatar(userId: string): Promise<{ message: string }> {
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { username: true, avatarUrl: true } });
    if (user?.avatarUrl) {
      const bucket = this.configService.get<string>('r2.bucketPublic');
      if (bucket) {
        try {
          const avatarKey = this.extractKeyFromUrl(user.avatarUrl);
          if (avatarKey) {
            const { s3, modules } = await this.getS3Client();
            const DeleteObjectCommand = modules['DeleteObjectCommand'] as new (input: Record<string, unknown>) => unknown;
            const command = new DeleteObjectCommand({ Bucket: bucket, Key: avatarKey });
            const send = (s3 as { send: (cmd: unknown) => Promise<unknown> }).send.bind(s3);
            await send(command);
          }
        } catch (err) {
          this.logger.warn(`Failed to delete old avatar from R2 for user ${userId}`, err);
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

  private extractKeyFromUrl(url: string): string | null {
    try {
      const publicUrl = this.configService.get<string>('r2.publicUrl');
      if (publicUrl && url.startsWith(publicUrl)) {
        return url.slice(publicUrl.length + 1);
      }
      const parsed = new URL(url);
      return parsed.pathname.startsWith('/') ? parsed.pathname.slice(1) : parsed.pathname;
    } catch {
      return null;
    }
  }

  async requestAccountDeletion(userId: string, currentAccessTokenJti?: string, password?: string, reason?: string, mfaCode?: string): Promise<{ message: string }> {
    if (!password) {
      throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Password is required to delete your account' });
    }
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { password: true } });
    if (!user) throw new NotFoundException({ code: ErrorCodes.USER_NOT_FOUND, message: 'User not found' });
    if (!user.password) {
      throw new BadRequestException({ code: ErrorCodes.INVALID_CREDENTIALS, message: 'Password login is not configured for this account' });
    }
    const passwordValid = await bcryptCompare(password, user.password);
    if (!passwordValid) {
      throw new BadRequestException({ code: ErrorCodes.INVALID_CREDENTIALS, message: 'Password salah' });
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

    if (disputedOrderCount > 0) {
      throw new BadRequestException({
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
      throw new BadRequestException({
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
      throw new BadRequestException({
        code: ErrorCodes.ACTIVE_ORDERS_PRESENT,
        message: 'You have a withdrawal still being processed. Wait for it to finish before deleting your account.',
      });
    }

    if (wallet && (wallet.escrowBalance > BigInt(0) || wallet.availableBalance > BigInt(0) || wallet.totalBalance > BigInt(0))) {
      throw new BadRequestException({
        code: wallet.escrowBalance > BigInt(0) ? ErrorCodes.ESCROW_BALANCE_PRESENT : ErrorCodes.WALLET_BALANCE_PRESENT,
        message: wallet.escrowBalance > BigInt(0)
          ? 'You have funds locked in escrow. Complete all pending orders before deleting your account.'
          : 'You still have funds in your wallet. Withdraw or resolve the balance before deleting your account.',
      });
    }

    if (reason) {
      this.logger.log(`Account deletion requested by user ${userId}: ${reason}`);
    }

    const deletionAt = new Date();
    await this.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
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

    return { message: 'Account deletion requested. Your account will be permanently deleted within 30 days.' };
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

  async getUserRatings(username: string, page: number, limit: number, filter?: string, viewerId?: string | null): Promise<object> {
    const user = await this.prisma.user.findUnique({ where: { username: username.toLowerCase() }, select: { id: true, averageRating: true, profileVisible: true, isActive: true, isBanned: true, deletedAt: true } });
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

    const [ratings, total] = await Promise.all([
      this.prisma.rating.findMany({
        where,
        skip,
        take: safeLimit,
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          stars: true,
          comment: true,
          createdAt: true,
          giver: { select: { username: true, avatarUrl: true } },
        },
      }),
      this.prisma.rating.count({ where }),
    ]);

    return { ratings, total, averageRating: Number(user.averageRating ?? 0), page: safePage, limit: safeLimit };
  }

  // ========== FOLLOW ==========

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
              { fullName: { contains: search.trim(), mode: 'insensitive' as const } },
              { username: { contains: search.trim(), mode: 'insensitive' as const } },
            ],
          },
        }
      : { follower: visibleFollower };

    const where: Prisma.FollowWhereInput = { followingId: user.id, ...searchFilter };

    const [followers, total] = await Promise.all([
      this.prisma.follow.findMany({
        where,
        skip, take: safeLimit, orderBy: { createdAt: 'desc' },
        select: { createdAt: true, follower: { select: { username: true, fullName: true, avatarUrl: true, membershipRank: true } } },
      }),
      this.prisma.follow.count({ where }),
    ]);

    return { users: followers.map(f => ({ ...f.follower, followedAt: f.createdAt })), total, page: safePage, limit: safeLimit };
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
        skip, take: safeLimit, orderBy: { createdAt: 'desc' },
        select: { createdAt: true, following: { select: { username: true, fullName: true, avatarUrl: true, membershipRank: true } } },
      }),
      this.prisma.follow.count({ where: followingWhere }),
    ]);

    return { users: following.map(f => ({ ...f.following, followedAt: f.createdAt })), total, page: safePage, limit: safeLimit };
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
        skip, take: safeLimit, orderBy: { createdAt: 'desc' },
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
      const s3BucketPublic = this.configService.get<string>('r2.bucketPublic');
      const s3BucketPrivate = this.configService.get<string>('r2.bucketPrivate');
      const allowedBuckets = [s3BucketPublic, s3BucketPrivate].filter(Boolean) as string[];
      if (allowedBuckets.length === 0) {
        throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Storage is not configured' });
      }
      const trustedHostnames: string[] = [];
      const endpointUrl = this.configService.get<string>('r2.endpointUrl');
      if (endpointUrl) {
        try { trustedHostnames.push(new URL(endpointUrl).hostname); } catch {}
      }
      const publicUrl = this.configService.get<string>('r2.publicUrl');
      if (publicUrl) {
        try { trustedHostnames.push(new URL(publicUrl).hostname); } catch {}
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

  async uploadHeader(userId: string, contentType?: string): Promise<{ uploadUrl: string; headerKey: string; expiresIn: number }> {
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { id: true } });
    if (!user) throw new NotFoundException({ code: ErrorCodes.USER_NOT_FOUND, message: 'User not found' });

    const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
    const mimeType = contentType && ALLOWED_TYPES.includes(contentType) ? contentType : 'image/jpeg';
    const ext = mimeType === 'image/png' ? 'png' : mimeType === 'image/webp' ? 'webp' : 'jpg';
    const headerKey = `headers/${userId}/${nanoid(16)}.${ext}`;
    const expiresIn = this.configService.get<number>('r2.presignExpires') ?? 300;

    try {
      const bucket = this.configService.get<string>('r2.bucketPublic');
      if (!bucket) throw new Error('R2_BUCKET_PUBLIC is not configured');

      const { s3, modules } = await this.getS3Client();
      const PutObjectCommand = modules['PutObjectCommand'] as new (input: Record<string, unknown>) => unknown;
      const command = new PutObjectCommand({ Bucket: bucket, Key: headerKey, ContentType: mimeType });
      const getSignedUrl = modules['getSignedUrl'] as (client: unknown, command: unknown, options: Record<string, unknown>) => Promise<string>;
      const uploadUrl = await getSignedUrl(s3, command, { expiresIn });
      return { uploadUrl, headerKey, expiresIn };
    } catch (err) {
      this.logger.error('R2 header presigned URL generation failed', err);
      throw new BadRequestException({
        code: ErrorCodes.UPLOAD_FAILED,
        message: 'Failed to create header upload URL. Please check storage configuration.',
      });
    }
  }

  async confirmHeader(userId: string, headerKey: string): Promise<{ headerUrl: string }> {
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { id: true, username: true } });
    if (!user) throw new NotFoundException({ code: ErrorCodes.USER_NOT_FOUND, message: 'User not found' });

    const baseName = path.basename(headerKey);
    const expectedPrefix = `headers/${userId}/`;
    const normalizedKey = `${expectedPrefix}${baseName}`;
    if (normalizedKey !== headerKey || !baseName || baseName.includes('..')) {
      throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Invalid header key' });
    }

    const bucket = this.configService.get<string>('r2.bucketPublic');

    if (bucket) {
      try {
        const { s3, modules } = await this.getS3Client();
        const GetObjectCommand = modules['GetObjectCommand'] as new (input: Record<string, unknown>) => unknown;
        const command = new GetObjectCommand({ Bucket: bucket, Key: headerKey, Range: 'bytes=0-15' });
        const send = (s3 as { send: (cmd: unknown) => Promise<{ Body?: { transformToByteArray?: () => Promise<Uint8Array> }; ContentType?: string }> }).send.bind(s3);
        const response = await send(command);
        if (response.Body?.transformToByteArray) {
          const headerBytes = Buffer.from(await response.Body.transformToByteArray());
          const detectedType = this.detectImageMimeType(headerBytes);
          if (!detectedType) {
            const DeleteObjectCommand = modules['DeleteObjectCommand'] as new (input: Record<string, unknown>) => unknown;
            const delCmd = new DeleteObjectCommand({ Bucket: bucket, Key: headerKey });
            await send(delCmd as unknown as Record<string, unknown>);
            throw new BadRequestException({
              code: ErrorCodes.VALIDATION_ERROR,
              message: 'Uploaded file is not a valid image. Please upload a JPEG, PNG, or WebP image.',
            });
          }
        }
      } catch (err) {
        if (err instanceof BadRequestException) throw err;
        throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Header file not found in storage. Please upload the file first.' });
      }
    }

    const publicUrl = this.configService.get<string>('r2.publicUrl');
    const headerUrl = publicUrl
      ? `${publicUrl}/${headerKey}`
      : `/uploads/${headerKey}`;

    await this.prisma.user.update({ where: { id: userId }, data: { headerUrl } });
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
      throw new BadRequestException({
        code: ErrorCodes.VALIDATION_ERROR,
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
    const headerKey = `headers/${userId}/${nanoid(16)}.${ext}`;

    const bucket = this.configService.get<string>('r2.bucketPublic');
    if (!bucket) {
      throw new BadRequestException({
        code: ErrorCodes.UPLOAD_FAILED,
        message: 'R2_BUCKET_PUBLIC is not configured',
      });
    }

    try {
      const { s3, modules } = await this.getS3Client();
      const PutObjectCommand = modules['PutObjectCommand'] as new (input: Record<string, unknown>) => unknown;
      const command = new PutObjectCommand({
        Bucket: bucket,
        Key: headerKey,
        ContentType: contentType,
        Body: fileBuffer,
      });
      const send = (s3 as { send: (cmd: unknown) => Promise<unknown> }).send.bind(s3);
      await send(command);
    } catch (err) {
      this.logger.error('R2 direct header upload failed', err);
      throw new BadRequestException({
        code: ErrorCodes.UPLOAD_FAILED,
        message: 'Failed to upload header to storage. Please try again.',
      });
    }

    const publicUrl = this.configService.get<string>('r2.publicUrl');
    const headerUrl = publicUrl ? `${publicUrl}/${headerKey}` : `/uploads/${headerKey}`;

    if (user.headerUrl) {
      try {
        const oldKey = this.extractKeyFromUrl(user.headerUrl);
        if (oldKey) {
          const { s3, modules } = await this.getS3Client();
          const DeleteObjectCommand = modules['DeleteObjectCommand'] as new (input: Record<string, unknown>) => unknown;
          const command = new DeleteObjectCommand({ Bucket: bucket, Key: oldKey });
          const send = (s3 as { send: (cmd: unknown) => Promise<unknown> }).send.bind(s3);
          await send(command);
        }
      } catch (err) {
        this.logger.warn(`Failed to delete old header for user ${userId}`, err);
      }
    }

    await this.prisma.user.update({ where: { id: userId }, data: { headerUrl } });
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
      const bucket = this.configService.get<string>('r2.bucketPublic');
      if (bucket) {
        try {
          const headerKey = this.extractKeyFromUrl(user.headerUrl);
          if (headerKey) {
            const { s3, modules } = await this.getS3Client();
            const DeleteObjectCommand = modules['DeleteObjectCommand'] as new (input: Record<string, unknown>) => unknown;
            const command = new DeleteObjectCommand({ Bucket: bucket, Key: headerKey });
            const send = (s3 as { send: (cmd: unknown) => Promise<unknown> }).send.bind(s3);
            await send(command);
          }
        } catch (err) {
          this.logger.warn(`Failed to delete old header from R2 for user ${userId}`, err);
        }
      }
    }
    await this.prisma.user.update({ where: { id: userId }, data: { headerUrl: null } });
    this.invalidateUserOgCaches(user?.username);
    return { message: 'Header image deleted successfully' };
  }

  async uploadShowcaseImage(userId: string, fileName: string, contentType: string, fileBuffer: Buffer): Promise<{ imageUrl: string }> {
    const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
    if (!ALLOWED_TYPES.includes(contentType)) {
      throw new BadRequestException({
        code: ErrorCodes.VALIDATION_ERROR,
        message: 'contentType must be image/jpeg, image/png, or image/webp',
      });
    }

    const MAX_SIZE = 5 * 1024 * 1024;
    if (fileBuffer.length > MAX_SIZE) {
      throw new BadRequestException({
        code: ErrorCodes.VALIDATION_ERROR,
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
    const imageKey = `showcase/${userId}/${nanoid(16)}.${ext}`;

    const bucket = this.configService.get<string>('r2.bucketPublic');
    if (!bucket) {
      throw new BadRequestException({
        code: ErrorCodes.UPLOAD_FAILED,
        message: 'R2_BUCKET_PUBLIC is not configured',
      });
    }

    try {
      const { s3, modules } = await this.getS3Client();
      const PutObjectCommand = modules['PutObjectCommand'] as new (input: Record<string, unknown>) => unknown;
      const command = new PutObjectCommand({
        Bucket: bucket,
        Key: imageKey,
        ContentType: contentType,
        Body: fileBuffer,
      });
      const send = (s3 as { send: (cmd: unknown) => Promise<unknown> }).send.bind(s3);
      await send(command);
    } catch (err) {
      this.logger.error('R2 direct showcase image upload failed', err);
      throw new BadRequestException({
        code: ErrorCodes.UPLOAD_FAILED,
        message: 'Failed to upload showcase image. Please try again.',
      });
    }

    const publicUrl = this.configService.get<string>('r2.publicUrl');
    const imageUrl = publicUrl ? `${publicUrl}/${imageKey}` : `/uploads/${imageKey}`;

    return { imageUrl };
  }

  private readonly MAX_SHOWCASE_ITEMS = 20;

  async getShowcaseByUsername(username: string, viewerId?: string): Promise<object> {
    const user = await this.prisma.user.findUnique({
      where: { username: username.toLowerCase() },
      select: { id: true, profileVisible: true, isActive: true, isBanned: true, deletedAt: true },
    });
    if (!user || !user.profileVisible || user.isActive === false || user.isBanned === true || user.deletedAt != null) {
      throw new NotFoundException({ code: ErrorCodes.USER_NOT_FOUND, message: 'User not found' });
    }

    if (viewerId && viewerId !== user.id) {
      const [viewerBlockedUser, userBlockedViewer] = await Promise.all([
        this.prisma.blockList.findUnique({ where: { blockerId_blockedId: { blockerId: viewerId, blockedId: user.id } } }),
        this.prisma.blockList.findUnique({ where: { blockerId_blockedId: { blockerId: user.id, blockedId: viewerId } } }),
      ]);
      if (viewerBlockedUser || userBlockedViewer) {
        throw new NotFoundException({ code: ErrorCodes.USER_NOT_FOUND, message: 'User not found' });
      }
    }

    const items = await this.prisma.userShowcase.findMany({
      where: { userId: user.id, isActive: true },
      orderBy: { sortOrder: 'asc' },
      select: {
        id: true, title: true, description: true, imageUrl: true,
        priceMin: true, priceMax: true, sortOrder: true, createdAt: true,
      },
    });

    return {
      items: items.map(item => ({
        ...item,
        priceMin: item.priceMin !== null ? Number(item.priceMin) : null,
        priceMax: item.priceMax !== null ? Number(item.priceMax) : null,
      })),
      total: items.length,
    };
  }

  async getMyShowcase(userId: string): Promise<object> {
    const items = await this.prisma.userShowcase.findMany({
      where: { userId },
      orderBy: { sortOrder: 'asc' },
      select: {
        id: true, title: true, description: true, imageUrl: true,
        priceMin: true, priceMax: true, isActive: true, sortOrder: true, createdAt: true,
      },
    });

    return {
      items: items.map(item => ({
        ...item,
        priceMin: item.priceMin !== null ? Number(item.priceMin) : null,
        priceMax: item.priceMax !== null ? Number(item.priceMax) : null,
      })),
      total: items.length,
    };
  }

  async createShowcaseItem(userId: string, dto: CreateShowcaseDto): Promise<object> {
    const count = await this.prisma.userShowcase.count({ where: { userId } });
    if (count >= this.MAX_SHOWCASE_ITEMS) {
      throw new BadRequestException({
        code: ErrorCodes.VALIDATION_ERROR,
        message: `Maximum ${this.MAX_SHOWCASE_ITEMS} showcase items allowed`,
      });
    }

    const trimmedTitle = dto.title.trim();
    if (!trimmedTitle) {
      throw new BadRequestException({
        code: ErrorCodes.VALIDATION_ERROR,
        message: 'Title is required',
      });
    }

    if (dto.priceMin !== undefined && dto.priceMax !== undefined && dto.priceMin > dto.priceMax) {
      throw new BadRequestException({
        code: ErrorCodes.VALIDATION_ERROR,
        message: 'priceMin must not exceed priceMax',
      });
    }

    const item = await this.prisma.userShowcase.create({
      data: {
        userId,
        title: trimmedTitle,
        description: dto.description?.trim() || null,
        imageUrl: dto.imageUrl || null,
        priceMin: dto.priceMin !== undefined ? BigInt(dto.priceMin) : null,
        priceMax: dto.priceMax !== undefined ? BigInt(dto.priceMax) : null,
        sortOrder: dto.sortOrder ?? count,
      },
      select: {
        id: true, title: true, description: true, imageUrl: true,
        priceMin: true, priceMax: true, isActive: true, sortOrder: true, createdAt: true,
      },
    });

    return {
      ...item,
      priceMin: item.priceMin !== null ? Number(item.priceMin) : null,
      priceMax: item.priceMax !== null ? Number(item.priceMax) : null,
    };
  }

  async updateShowcaseItem(userId: string, itemId: string, dto: UpdateShowcaseDto): Promise<object> {
    const existing = await this.prisma.userShowcase.findFirst({
      where: { id: itemId, userId },
    });
    if (!existing) {
      throw new NotFoundException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Showcase item not found' });
    }

    if (dto.title !== undefined) {
      const trimmedTitle = dto.title.trim();
      if (!trimmedTitle) {
        throw new BadRequestException({
          code: ErrorCodes.VALIDATION_ERROR,
          message: 'Title is required',
        });
      }
    }

    const priceMin = dto.priceMin !== undefined ? dto.priceMin : (existing.priceMin !== null ? Number(existing.priceMin) : undefined);
    const priceMax = dto.priceMax !== undefined ? dto.priceMax : (existing.priceMax !== null ? Number(existing.priceMax) : undefined);
    if (priceMin !== undefined && priceMax !== undefined && priceMin > priceMax) {
      throw new BadRequestException({
        code: ErrorCodes.VALIDATION_ERROR,
        message: 'priceMin must not exceed priceMax',
      });
    }

    const data: Record<string, unknown> = {};
    if (dto.title !== undefined) data.title = dto.title.trim();
    if (dto.description !== undefined) data.description = dto.description?.trim() || null;
    if (dto.imageUrl !== undefined) data.imageUrl = dto.imageUrl || null;
    if (dto.priceMin !== undefined) data.priceMin = BigInt(dto.priceMin);
    if (dto.priceMax !== undefined) data.priceMax = BigInt(dto.priceMax);
    if (dto.isActive !== undefined) data.isActive = dto.isActive;
    if (dto.sortOrder !== undefined) data.sortOrder = dto.sortOrder;

    const item = await this.prisma.userShowcase.update({
      where: { id: itemId },
      data,
      select: {
        id: true, title: true, description: true, imageUrl: true,
        priceMin: true, priceMax: true, isActive: true, sortOrder: true, createdAt: true,
      },
    });

    return {
      ...item,
      priceMin: item.priceMin !== null ? Number(item.priceMin) : null,
      priceMax: item.priceMax !== null ? Number(item.priceMax) : null,
    };
  }

  async deleteShowcaseItem(userId: string, itemId: string): Promise<{ message: string }> {
    const existing = await this.prisma.userShowcase.findFirst({
      where: { id: itemId, userId },
    });
    if (!existing) {
      throw new NotFoundException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Showcase item not found' });
    }

    await this.prisma.userShowcase.delete({ where: { id: itemId } });
    return { message: 'Showcase item deleted successfully' };
  }

}
