import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ConflictException,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bull';
import { Queue } from 'bull';
import { randomUUID } from 'crypto';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditLogService } from '../../common/services/audit-log.service';
import { RedisService } from '../../redis/redis.service';
import { createPaginatedResponse, PaginatedResponse } from '../../common/dto/pagination.dto';
import * as ErrorCodes from '../../common/constants/error-codes';
import { NotificationType, Prisma, UserAuditAction, ReportCategory } from '@prisma/client';
import { ReportUserSettingsDto } from './dto/report-user.dto';
import { UploadService } from '../upload/upload.service';
import { NotificationQueueService } from '../queue/notification-queue.service';
import { EMAIL_QUEUE, EmailJobData } from '../queue/processors/email.processor';
import { decryptAES } from '../../common/utils/crypto.util';
import { decryptPiiSafe } from '../../common/utils/pii.util';

@Injectable()
export class SettingsService {
  constructor(
    private prisma: PrismaService,
    private auditLog: AuditLogService,
    private redis: RedisService,
    private configService: ConfigService,
    private uploadService: UploadService,
    private notificationQueue: NotificationQueueService,
    @InjectQueue(EMAIL_QUEUE) private readonly emailQueue: Queue<EmailJobData>,
  ) {}

  async listBlockedUsers(userId: string, page: number, limit: number): Promise<PaginatedResponse<Record<string, unknown>>> {
    const safePage = Math.max(1, page);
    const safeLimit = Math.min(limit, 100);
    const skip = (safePage - 1) * safeLimit;

    const [blocks, total] = await Promise.all([
      this.prisma.blockList.findMany({
        where: { blockerId: userId },
        skip,
        take: safeLimit,
        orderBy: { createdAt: 'desc' },
        include: {
          blocked: {
            select: {
              id: true,
              userId: true,
              username: true,
              fullName: true,
              avatarUrl: true,
            },
          },
        },
      }),
      this.prisma.blockList.count({ where: { blockerId: userId } }),
    ]);

    return createPaginatedResponse(blocks, total, safePage, safeLimit);
  }

  async blockUser(blockerId: string, blockedId: string): Promise<{ message: string }> {
    if (blockerId === blockedId) {
      throw new BadRequestException({
        code: ErrorCodes.CANNOT_BLOCK_SELF,
        message: 'You cannot block yourself',
      });
    }

    const targetUser = await this.prisma.user.findUnique({
      where: { id: blockedId },
    });
    if (!targetUser) {
      throw new NotFoundException({
        code: ErrorCodes.USER_NOT_FOUND,
        message: 'User not found',
      });
    }

    let block: { id: string };
    try {
      block = await this.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
        const existing = await tx.blockList.findUnique({
          where: { blockerId_blockedId: { blockerId, blockedId } },
        });
        if (existing) {
          throw new ConflictException({
            code: ErrorCodes.USER_ALREADY_BLOCKED,
            message: 'User is already blocked',
          });
        }

        const created = await tx.blockList.create({
          data: { blockerId, blockedId },
          select: { id: true },
        });
        await tx.follow.deleteMany({
          where: {
            OR: [
              { followerId: blockerId, followingId: blockedId },
              { followerId: blockedId, followingId: blockerId },
            ],
          },
        });
        await tx.userFavorite.deleteMany({
          where: {
            OR: [
              { userId: blockerId, favoriteUserId: blockedId },
              { userId: blockedId, favoriteUserId: blockerId },
            ],
          },
        });
        await tx.userSavedProfile.deleteMany({
          where: {
            OR: [
              { userId: blockerId, savedUserId: blockedId },
              { userId: blockedId, savedUserId: blockerId },
            ],
          },
        });
        return created;
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictException({ code: ErrorCodes.USER_ALREADY_BLOCKED, message: 'User is already blocked' });
      }
      throw error;
    }

    this.auditLog.logUserAction({
      userId: blockerId,
      action: UserAuditAction.USER_BLOCKED,
      entityType: 'BlockList',
      entityId: block.id,
      description: `Blocked user ${blockedId}`,
    });

    return { message: 'User blocked successfully' };
  }

  async unblockUser(blockerId: string, blockedId: string): Promise<{ message: string }> {
    const existing = await this.prisma.blockList.findUnique({
      where: { blockerId_blockedId: { blockerId, blockedId } },
    });
    if (!existing) {
      throw new NotFoundException({
        code: ErrorCodes.USER_NOT_BLOCKED,
        message: 'User is not blocked',
      });
    }

    await this.prisma.blockList.delete({
      where: { blockerId_blockedId: { blockerId, blockedId } },
    });

    this.auditLog.logUserAction({
      userId: blockerId,
      action: UserAuditAction.USER_UNBLOCKED,
      entityType: 'BlockList',
      entityId: existing.id,
      description: `Unblocked user ${blockedId}`,
    });

    return { message: 'User unblocked successfully' };
  }

  async reportUser(reporterId: string, dto: ReportUserSettingsDto): Promise<{ message: string; reportId: string }> {
    if (reporterId === dto.targetId) {
      throw new BadRequestException({
        code: ErrorCodes.CANNOT_REPORT_SELF,
        message: 'You cannot report yourself',
      });
    }

    const targetUser = await this.prisma.user.findUnique({
      where: { id: dto.targetId },
    });
    if (!targetUser) {
      throw new NotFoundException({
        code: ErrorCodes.USER_NOT_FOUND,
        message: 'User not found',
      });
    }

    if (dto.evidenceUrls?.length) {
      const trustedHostnames: string[] = [];
      const r2Endpoint = this.configService.get<string>('r2.endpointUrl');
      if (r2Endpoint) {
        try { trustedHostnames.push(new URL(r2Endpoint).hostname); } catch {}
      }
      const r2PublicUrl = this.configService.get<string>('r2.publicUrl');
      if (r2PublicUrl) {
        try { trustedHostnames.push(new URL(r2PublicUrl).hostname); } catch {}
      }
      if (trustedHostnames.length === 0) {
        throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Storage not configured' });
      }
      for (const rawUrl of dto.evidenceUrls) {
        try {
          const parsed = new URL(rawUrl);
          if (parsed.protocol !== 'https:') throw new Error('not https');
          // The two `endsWith` fallbacks below used to accept ANY `*.r2.dev` or
          // `*.r2.cloudflarestorage.com` host — i.e. any Cloudflare R2 bucket on
          // any account, including one the reporter controls. Admins reviewing a
          // report would then be fetching attacker-hosted content from a URL that
          // looked like platform storage. `trustedHostnames` is already derived
          // from r2.endpointUrl + r2.publicUrl (which are the account-specific
          // hosts) and we bail out above when it is empty, so the wildcards were
          // pure over-permission.
          const isTrusted = trustedHostnames.some(h => parsed.hostname === h || parsed.hostname.endsWith(`.${h}`));
          if (!isTrusted) throw new Error('not allowed host');
        } catch {
          throw new BadRequestException({
            code: ErrorCodes.VALIDATION_ERROR,
            message: 'Evidence URL must point to platform storage',
          });
        }
      }
    }

    if (dto.relatedOrderId) {
      const relatedOrder = await this.prisma.order.findUnique({
        where: { id: dto.relatedOrderId },
        select: { buyerId: true, sellerId: true },
      });
      const participants = relatedOrder ? [relatedOrder.buyerId, relatedOrder.sellerId] : [];
      if (!relatedOrder || !participants.includes(reporterId) || !participants.includes(dto.targetId)) {
        throw new NotFoundException({ code: ErrorCodes.ORDER_NOT_FOUND, message: 'Related order not found' });
      }
    }

    const reportCooldownKey = `user-report:cooldown:${reporterId}:${dto.targetId}`;
    const reportLockValue = randomUUID();
    let reportLockAcquired = false;
    let redisAvailable = false;
    try {
      redisAvailable = true;
      reportLockAcquired = (await this.redis.setNx(reportCooldownKey, reportLockValue, 24 * 60 * 60)) === true;
    } catch {
      // The database recency check below remains the fallback when Redis is unavailable.
    }

    let recentReport: { id: string } | null;
    try {
      recentReport = await this.prisma.userReport.findFirst({
        where: {
          reporterId,
          targetId: dto.targetId,
          createdAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) },
        },
      });
    } catch (error) {
      if (reportLockAcquired) await this.redis.releaseLock(reportCooldownKey, reportLockValue).catch(() => undefined);
      throw error;
    }
    if (recentReport || (redisAvailable && !reportLockAcquired)) {
      if (reportLockAcquired) await this.redis.releaseLock(reportCooldownKey, reportLockValue).catch(() => undefined);
      throw new BadRequestException({
        code: ErrorCodes.RATE_LIMIT_EXCEEDED,
        message: 'You have already reported this user recently. Please wait before reporting again.',
      });
    }

    let report: { id: string };
    try {
      report = await this.prisma.userReport.create({
        data: {
          reporterId,
          targetId: dto.targetId,
          category: dto.category as ReportCategory,
          description: dto.description,
          evidenceUrls: dto.evidenceUrls ?? [],
          relatedOrderId: dto.relatedOrderId ?? null,
          relatedMessageId: dto.relatedMessageId ?? null,
        },
        select: { id: true },
      });
    } catch (error) {
      if (reportLockAcquired) await this.redis.releaseLock(reportCooldownKey, reportLockValue).catch(() => undefined);
      throw error;
    }

    this.auditLog.logUserAction({
      userId: reporterId,
      action: UserAuditAction.USER_REPORTED,
      entityType: 'UserReport',
      entityId: report.id,
      description: `Reported user ${dto.targetId} for ${dto.category}`,
    });

    return { message: 'Report submitted successfully', reportId: report.id };
  }

  async listMyReports(userId: string, page: number, limit: number): Promise<PaginatedResponse<Record<string, unknown>>> {
    const safePage = Math.max(1, page);
    const safeLimit = Math.min(limit, 100);
    const skip = (safePage - 1) * safeLimit;

    const [reports, total] = await Promise.all([
      this.prisma.userReport.findMany({
        where: { reporterId: userId },
        skip,
        take: safeLimit,
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          targetId: true,
          category: true,
          description: true,
          status: true,
          createdAt: true,
          updatedAt: true,
          target: {
            select: {
              userId: true,
              username: true,
              fullName: true,
            },
          },
        },
      }),
      this.prisma.userReport.count({ where: { reporterId: userId } }),
    ]);

    return createPaginatedResponse(reports, total, safePage, safeLimit);
  }

  private privacyKey(userId: string): string {
    return `user_privacy:${userId}`;
  }

  private languageKey(userId: string): string {
    return `user_language:${userId}`;
  }

  async getPrivacySettings(userId: string): Promise<{ profileVisible: boolean; showOnlineStatus: boolean }> {
    const cached = await this.redis.get(this.privacyKey(userId));
    if (cached) {
      try {
        return JSON.parse(cached);
      } catch {
        // Cache parse error — fall through to DB
      }
    }

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, profileVisible: true, showOnlineStatus: true },
    });
    if (!user) {
      throw new NotFoundException({ code: ErrorCodes.USER_NOT_FOUND, message: 'User not found' });
    }

    const settings = { profileVisible: user.profileVisible, showOnlineStatus: user.showOnlineStatus };
    await this.redis.set(this.privacyKey(userId), JSON.stringify(settings), 3600);
    return settings;
  }

  async updatePrivacySettings(userId: string, dto: { profileVisible?: boolean; showOnlineStatus?: boolean }): Promise<{ profileVisible: boolean; showOnlineStatus: boolean; message: string }> {
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { id: true, profileVisible: true, showOnlineStatus: true } });
    if (!user) {
      throw new NotFoundException({ code: ErrorCodes.USER_NOT_FOUND, message: 'User not found' });
    }

    const updated = {
      profileVisible: dto.profileVisible ?? user.profileVisible,
      showOnlineStatus: dto.showOnlineStatus ?? user.showOnlineStatus,
    };

    await this.prisma.user.update({
      where: { id: userId },
      data: updated,
    });
    await this.redis.set(this.privacyKey(userId), JSON.stringify(updated), 3600);

    this.auditLog.logUserAction({
      userId,
      action: UserAuditAction.PROFILE_UPDATED,
      entityType: 'User',
      entityId: userId,
      description: 'Updated privacy settings',
    });

    return { ...updated, message: 'Privacy settings updated successfully' };
  }

  async getLanguage(userId: string): Promise<{ language: string }> {
    const cached = await this.redis.get(this.languageKey(userId));
    if (cached === 'id' || cached === 'en') return { language: cached };

    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { id: true, language: true } });
    if (!user) {
      throw new NotFoundException({ code: ErrorCodes.USER_NOT_FOUND, message: 'User not found' });
    }

    const language = user.language === 'en' ? 'en' : 'id';
    await this.redis.setex(this.languageKey(userId), 365 * 24 * 3600, language);
    return { language };
  }

  async updateLanguage(userId: string, language: string): Promise<{ language: string; message: string }> {
    if (language !== 'id' && language !== 'en') {
      throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Language must be id or en' });
    }

    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { id: true } });
    if (!user) {
      throw new NotFoundException({ code: ErrorCodes.USER_NOT_FOUND, message: 'User not found' });
    }

    await this.prisma.user.update({ where: { id: userId }, data: { language } });
    await this.redis.setex(this.languageKey(userId), 365 * 24 * 3600, language);

    this.auditLog.logUserAction({
      userId,
      action: UserAuditAction.PROFILE_UPDATED,
      entityType: 'User',
      entityId: userId,
      description: `Updated language to ${language}`,
    });

    return { language, message: 'Language preference updated successfully' };
  }

  async requestDataExport(userId: string): Promise<{ message: string; downloadUrl: string; expiresAt: Date }> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        userId: true,
        username: true,
        email: true,
        fullName: true,
        bio: true,
        avatarUrl: true,
        headerUrl: true,
        accountType: true,
        phoneNumber: true,
        phoneVerified: true,
        dateOfBirth: true,
        gender: true,
        address: true,
        emailVerified: true,
        emailVerifiedAt: true,
        kycStatus: true,
        kycApprovedAt: true,
        isKahadePlus: true,
        subscriptionExpiresAt: true,
        profileVisible: true,
        showOnlineStatus: true,
        language: true,
        membershipRank: true,
        memberSince: true,
        createdAt: true,
        updatedAt: true,
      },
    });
    if (!user) {
      throw new NotFoundException({ code: ErrorCodes.USER_NOT_FOUND, message: 'User not found' });
    }

    const cooldownKey = `data-export:cooldown:${userId}`;
    const cooldownToken = randomUUID();
    const acquired = await this.redis.setNx(cooldownKey, cooldownToken, 86400);
    if (!acquired) {
      throw new BadRequestException({
        code: ErrorCodes.VALIDATION_ERROR,
        message: 'A data export was already requested recently. Please wait 24 hours between requests.',
      });
    }

    try {
      const [sessions, devices, bankAccounts, links, following, followers, favorites, badges, notificationPreference, blocksCount, reportsCount] = await Promise.all([
        this.prisma.userSession.findMany({
          where: { userId },
          orderBy: { lastActiveAt: 'desc' },
          select: { id: true, deviceInfo: true, ipAddress: true, isRevoked: true, revokedAt: true, revokedReason: true, lastActiveAt: true, expiresAt: true, createdAt: true },
        }),
        this.prisma.userDevice.findMany({
          where: { userId },
          orderBy: { lastLoginAt: 'desc' },
          select: { id: true, deviceName: true, deviceType: true, os: true, browser: true, ipAddress: true, isTrusted: true, trustedAt: true, lastLoginAt: true, loginCount: true, createdAt: true },
        }),
        this.prisma.bankAccount.findMany({
          where: { userId, deletedAt: null },
          orderBy: { createdAt: 'asc' },
          select: { id: true, bankCode: true, bankName: true, accountNumber: true, accountName: true, isPrimary: true, isVerified: true, createdAt: true, updatedAt: true },
        }),
        this.prisma.userLink.findMany({ where: { userId }, orderBy: { displayOrder: 'asc' }, select: { platform: true, url: true, label: true, displayOrder: true, createdAt: true, updatedAt: true } }),
        this.prisma.follow.findMany({ where: { followerId: userId }, orderBy: { createdAt: 'desc' }, select: { followingId: true, createdAt: true, following: { select: { userId: true, username: true, fullName: true } } } }),
        this.prisma.follow.findMany({ where: { followingId: userId }, orderBy: { createdAt: 'desc' }, select: { followerId: true, createdAt: true, follower: { select: { userId: true, username: true, fullName: true } } } }),
        this.prisma.userFavorite.findMany({ where: { userId }, orderBy: { createdAt: 'desc' }, select: { favoriteUserId: true, createdAt: true, favoriteUser: { select: { userId: true, username: true, fullName: true } } } }),
        this.prisma.userBadge.findMany({ where: { userId }, orderBy: { earnedAt: 'desc' }, select: { earnedAt: true, badge: { select: { id: true, name: true, description: true } } } }),
        this.prisma.notificationPreference.findUnique({ where: { userId }, select: { orderInApp: true, orderPush: true, orderEmail: true, walletInApp: true, walletPush: true, walletEmail: true, securityInApp: true, securityPush: true, securityEmail: true, chatInApp: true, chatPush: true, disputeInApp: true, disputePush: true, disputeEmail: true, rankingInApp: true, rankingPush: true, marketingEmail: true } }),
        this.prisma.blockList.count({ where: { blockerId: userId } }),
        this.prisma.userReport.count({ where: { reporterId: userId } }),
      ]);

      const maskedBankAccounts = await Promise.all(bankAccounts.map(async (account) => {
        let maskedAccountNumber = '****';
        let accountName = account.accountName;
        try {
          const plain = await decryptAES(account.accountNumber);
          maskedAccountNumber = `****${plain.slice(-4)}`;
        } catch {
          // Legacy records may not be encrypted; do not expose the raw value.
        }
        try { accountName = await decryptAES(account.accountName); } catch { /* legacy plaintext name */ }
        return { id: account.id, bankCode: account.bankCode, bankName: account.bankName, accountName, maskedAccountNumber, isPrimary: account.isPrimary, isVerified: account.isVerified, createdAt: account.createdAt, updatedAt: account.updatedAt };
      }));

      const exportPayload = {
        exportVersion: 1,
        exportedAt: new Date().toISOString(),
        profile: { ...user, phoneNumber: await decryptPiiSafe(user.phoneNumber) },
        security: { sessions: sessions.map((session) => ({ ...session, ipAddress: this.maskIpAddress(session.ipAddress) })), devices: devices.map((device) => ({ ...device, ipAddress: this.maskIpAddress(device.ipAddress) })) },
        bankAccounts: maskedBankAccounts,
        socialLinks: links,
        following,
        followers,
        favorites,
        badges,
        notificationPreferences: notificationPreference,
        blockedUsersCount: blocksCount,
        submittedReportsCount: reportsCount,
      };
      const json = JSON.stringify(exportPayload, (_, value: unknown) => typeof value === 'bigint' ? value.toString() : value, 2);
      const artifact = await this.uploadService.uploadPrivateAccountExport(userId, Buffer.from(json, 'utf8'));
      const expiresAt = artifact.expiresAt.toISOString();
      const message = 'Data akun Anda siap diunduh. Tautan ini berlaku terbatas dan dapat digunakan secara aman.';

      if (user.email) {
        await this.emailQueue.add('send', {
          to: user.email,
          subject: 'Data Akun Kahade Anda',
          templateName: 'data-export',
          templateContext: { name: user.fullName, downloadUrl: artifact.downloadUrl, expiresAt },
        });
      }
      await this.notificationQueue.enqueue({
        userId,
        type: NotificationType.DATA_EXPORT_READY,
        title: 'Data akun siap diunduh',
        body: message,
        actionUrl: artifact.downloadUrl,
        language: user.language === 'en' ? 'en' : 'id',
      });

      this.auditLog.logUserAction({
        userId,
        action: UserAuditAction.PROFILE_UPDATED,
        entityType: 'User',
        entityId: userId,
        description: 'Generated personal data export',
      });

      return { message, downloadUrl: artifact.downloadUrl, expiresAt: artifact.expiresAt };
    } catch (error) {
      await this.redis.releaseLock(cooldownKey, cooldownToken);
      throw error;
    }
  }

  private maskIpAddress(value: string): string {
    if (!value) return 'unknown';
    if (value.includes(':')) {
      const parts = value.split(':');
      return `${parts.slice(0, 3).join(':')}:xxxx`;
    }
    const parts = value.split('.');
    return parts.length === 4 ? `${parts[0]}.${parts[1]}.x.x` : 'masked';
  }
}
