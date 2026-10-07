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
import {
  NotificationType,
  Prisma,
  UserAuditAction,
  ReportCategory,
  ConsentType,
  DataExportFormat,
  DataExportStatus,
  PrivacyListVisibility,
  QaCommentPolicy,
  ShowcaseVisibility,
} from '@prisma/client';
import { ReportUserSettingsDto } from './dto/report-user.dto';
import { UpdatePrivacyDto } from './dto/update-privacy.dto';
import { UpdateConsentDto } from './dto/update-consent.dto';
import { UploadService } from '../upload/upload.service';
import { NotificationQueueService } from '../queue/notification-queue.service';
import { ReportFlagService } from '../../common/services/report-flag.service';
import { EMAIL_QUEUE, EmailJobData } from '../queue/processors/email.processor';
import { decryptAES } from '../../common/utils/crypto.util';
import { decryptPiiSafe } from '../../common/utils/pii.util';
import { CONSENT_POLICIES, CONSENT_TYPES, consentPolicyHash, hashIp } from './consent-policy.constants';
import { buildExportManifest, EXPORT_SCHEMA_VERSION, ExportLocale, ManifestDataset } from './export-manifest.util';
import {
  buildCsv,
  maskAccountNumberTail,
  sanitizeChatRoomForExport,
  sanitizeDisputeForExport,
  sanitizeOrderForExport,
  sanitizeTicketReplyForExport,
  sanitizeWalletTxForExport,
  senToIdr,
  REDACTED_PLACEHOLDER,
} from './export-redaction.util';
import { buildZip } from '../../common/utils/zip.util';
import { DEFAULT_PRIVACY_SETTING } from '../users/privacy-profile.util';

/**
 * G076–G083: respons gabungan — dua toggle lama (kolom User) + kontrol
 * granular (tabel privacy_settings). Bentuk lama tetap subset dari ini.
 */
export interface PrivacySettingsResponse {
  profileVisible: boolean;
  showOnlineStatus: boolean;
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

/** Status consent satu jenis untuk user (G084–G086). */
export interface ConsentStatus {
  type: ConsentType;
  granted: boolean;
  revocable: boolean;
  policyVersion: string;
  policyTextHash: string | null;
  title: { id: string; en: string };
  grantedAt: Date | null;
  revokedAt: Date | null;
  channel: string | null;
}

/** Satu baris riwayat ekspor (G087–G088). */
export interface ExportRequestSummary {
  id: string;
  status: DataExportStatus;
  format: DataExportFormat;
  requestedAt: Date;
  readyAt: Date | null;
  expiresAt: Date | null;
  downloadedAt: Date | null;
  downloadCount: number;
}

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
    // Section 6: agregasi laporan -> flag moderasi internal.
    private readonly reportFlagService: ReportFlagService,
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
      // Self-hosted only (2026-10-07): R2/Cloudflare dibuang — evidence harus
      // menunjuk ke storage platform (api.kahade.id/uploads).
      const trustedHostnames: string[] = ['api.kahade.id', 'kahade.id', 'cdn.kahade.id'];
      for (const rawUrl of dto.evidenceUrls) {
        try {
          const parsed = new URL(rawUrl);
          if (parsed.protocol !== 'https:') throw new Error('not https');
          // Hanya host platform yang diizinkan — menolak R2/Cloudflare
          // (*.r2.dev, *.r2.cloudflarestorage.com) dan host eksternal lain
          // untuk mencegah admin mengambil konten dari URL attacker-hosted
          // yang terlihat seperti platform storage.
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

    // Section 6: hitung agregasi setelah laporan tersimpan; tidak pernah
    // melempar dan tidak pernah memicu tindakan otomatis terhadap target.
    await this.reportFlagService.evaluateTarget(dto.targetId);

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

  async getPrivacySettings(userId: string): Promise<PrivacySettingsResponse> {
    const cached = await this.redis.get(this.privacyKey(userId));
    if (cached) {
      try {
        const parsed = JSON.parse(cached) as Partial<PrivacySettingsResponse>;
        // Cache lama (hanya 2 toggle) tidak punya field granular — abaikan.
        if (parsed && typeof parsed.showEmail === 'boolean') {
          return parsed as PrivacySettingsResponse;
        }
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

    const granular = await this.prisma.privacySetting.findUnique({ where: { userId } });
    const settings: PrivacySettingsResponse = {
      profileVisible: user.profileVisible,
      showOnlineStatus: user.showOnlineStatus,
      showEmail: granular?.showEmail ?? DEFAULT_PRIVACY_SETTING.showEmail,
      showPhone: granular?.showPhone ?? DEFAULT_PRIVACY_SETTING.showPhone,
      showDob: granular?.showDob ?? DEFAULT_PRIVACY_SETTING.showDob,
      showGender: granular?.showGender ?? DEFAULT_PRIVACY_SETTING.showGender,
      showFollowerList: granular?.showFollowerList ?? DEFAULT_PRIVACY_SETTING.showFollowerList,
      showFollowingList: granular?.showFollowingList ?? DEFAULT_PRIVACY_SETTING.showFollowingList,
      showcaseDefaultVisibility: granular?.showcaseDefaultVisibility ?? DEFAULT_PRIVACY_SETTING.showcaseDefaultVisibility,
      qaCommentPolicy: granular?.qaCommentPolicy ?? DEFAULT_PRIVACY_SETTING.qaCommentPolicy,
      qaAnswerModeration: granular?.qaAnswerModeration ?? DEFAULT_PRIVACY_SETTING.qaAnswerModeration,
      showReviews: granular?.showReviews ?? DEFAULT_PRIVACY_SETTING.showReviews,
      hiddenStats: granular?.hiddenStats ?? [],
      searchEngineIndex: granular?.searchEngineIndex ?? DEFAULT_PRIVACY_SETTING.searchEngineIndex,
    };
    await this.redis.set(this.privacyKey(userId), JSON.stringify(settings), 3600);
    return settings;
  }

  async updatePrivacySettings(userId: string, dto: UpdatePrivacyDto): Promise<PrivacySettingsResponse & { message: string }> {
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { id: true } });
    if (!user) {
      throw new NotFoundException({ code: ErrorCodes.USER_NOT_FOUND, message: 'User not found' });
    }

    // Pisahkan kolom User (kontrak lama) dari tabel privacy_settings (G076–G083).
    const userData: Prisma.UserUpdateInput = {};
    if (dto.profileVisible !== undefined) userData.profileVisible = dto.profileVisible;
    if (dto.showOnlineStatus !== undefined) userData.showOnlineStatus = dto.showOnlineStatus;

    const granularData: Record<string, string | boolean | string[] | undefined> = {};
    const granularKeys = [
      'showEmail', 'showPhone', 'showDob', 'showGender',
      'showFollowerList', 'showFollowingList', 'showcaseDefaultVisibility',
      'qaCommentPolicy', 'qaAnswerModeration', 'showReviews', 'hiddenStats',
      'searchEngineIndex',
    ] as const;
    for (const key of granularKeys) {
      const value = dto[key];
      if (value !== undefined) granularData[key] = value as string | boolean | string[];
    }

    if (Object.keys(userData).length > 0 || Object.keys(granularData).length > 0) {
      await this.prisma.$transaction(async (tx) => {
        if (Object.keys(userData).length > 0) {
          await tx.user.update({ where: { id: userId }, data: userData });
        }
        if (Object.keys(granularData).length > 0) {
          // granularData tidak pernah memuat userId (hanya kunci granular) —
          // Omit menenangkan TS2783 ('userId' specified more than once).
          const granularCreate = granularData as Omit<Prisma.PrivacySettingUncheckedCreateInput, 'userId'>;
          await tx.privacySetting.upsert({
            where: { userId },
            create: { userId, ...granularCreate },
            update: granularData as Prisma.PrivacySettingUncheckedUpdateInput,
          });
        }
      });
    }

    await this.redis.del(this.privacyKey(userId));

    this.auditLog.logUserAction({
      userId,
      action: UserAuditAction.PRIVACY_SETTINGS_UPDATED,
      entityType: 'PrivacySetting',
      entityId: userId,
      description: 'Updated privacy settings',
    });

    const settings = await this.getPrivacySettings(userId);
    return { ...settings, message: 'Pengaturan privasi berhasil disimpan.' };
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

  // ================================================================
  // G084–G086: persetujuan (consent) pemasaran vs transaksional, berversi.
  // ================================================================

  private async latestConsentRecord(userId: string, type: ConsentType) {
    return this.prisma.consentRecord.findFirst({
      where: { userId, type },
      orderBy: [{ grantedAt: 'desc' }, { id: 'desc' }],
    });
  }

  /**
   * Status consent saat ini per jenis. Bila belum ada ConsentRecord, fallback
   * ke preferensi notifikasi lama (transisi G084) — kecuali WhatsApp yang
   * default-nya tidak disetujui dan TRANSACTIONAL yang selalu aktif.
   */
  async getConsents(userId: string): Promise<ConsentStatus[]> {
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { id: true } });
    if (!user) {
      throw new NotFoundException({ code: ErrorCodes.USER_NOT_FOUND, message: 'User not found' });
    }

    const [records, pref] = await Promise.all([
      this.prisma.consentRecord.findMany({
        where: { userId },
        orderBy: [{ grantedAt: 'desc' }, { id: 'desc' }],
      }),
      this.prisma.notificationPreference.findUnique({
        where: { userId },
        select: { marketingEmail: true, marketingPush: true },
      }),
    ]);

    const latest = new Map<ConsentType, (typeof records)[number]>();
    for (const record of records) {
      if (!latest.has(record.type)) latest.set(record.type, record);
    }

    return CONSENT_TYPES.map((type) => {
      const policy = CONSENT_POLICIES[type];
      const record = latest.get(type);

      if (type === ConsentType.TRANSACTIONAL) {
        return {
          type,
          granted: true,
          revocable: false,
          policyVersion: policy.version,
          policyTextHash: consentPolicyHash(type),
          title: policy.title,
          grantedAt: record?.grantedAt ?? null,
          revokedAt: null,
          channel: record?.channel ?? null,
        };
      }

      if (record) {
        return {
          type,
          granted: record.revokedAt === null,
          revocable: true,
          policyVersion: record.policyVersion,
          policyTextHash: record.policyTextHash,
          title: policy.title,
          grantedAt: record.grantedAt,
          revokedAt: record.revokedAt,
          channel: record.channel,
        };
      }

      // Fallback transisi: preferensi lama sebelum ConsentRecord ada.
      const legacyGranted =
        type === ConsentType.MARKETING_EMAIL
          ? Boolean(pref?.marketingEmail)
          : type === ConsentType.MARKETING_PUSH
            ? Boolean(pref?.marketingPush)
            : false;
      return {
        type,
        granted: legacyGranted,
        revocable: true,
        policyVersion: 'legacy-notification-preference',
        policyTextHash: null,
        title: policy.title,
        grantedAt: null,
        revokedAt: null,
        channel: null,
      };
    });
  }

  /**
   * Berikan atau tarik sebuah persetujuan. Penarikan TRANSACTIONAL ditolak
   * (G084 — didokumentasikan di UI). Setiap pemberian membuat baris baru
   * (versioning); penarikan menutup baris terbuka via revokedAt.
   */
  async updateConsent(userId: string, dto: UpdateConsentDto, ip?: string): Promise<ConsentStatus> {
    const policy = CONSENT_POLICIES[dto.type];
    if (!policy) {
      throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Unknown consent type' });
    }
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { id: true } });
    if (!user) {
      throw new NotFoundException({ code: ErrorCodes.USER_NOT_FOUND, message: 'User not found' });
    }

    if (dto.type === ConsentType.TRANSACTIONAL) {
      if (!dto.granted) {
        throw new BadRequestException({
          code: ErrorCodes.VALIDATION_ERROR,
          message:
            'Notifikasi transaksional (order, dompet, keamanan, sengketa) bersifat wajib selama akun aktif dan tidak dapat dimatikan.',
        });
      }
      const current = await this.getConsents(userId);
      return current.find((c) => c.type === dto.type)!;
    }

    const latest = await this.latestConsentRecord(userId, dto.type);
    const isOpen = Boolean(latest && !latest.revokedAt);

    if (dto.granted) {
      if (!isOpen) {
        await this.prisma.consentRecord.create({
          data: {
            userId,
            type: dto.type,
            policyVersion: policy.version,
            policyTextHash: consentPolicyHash(dto.type),
            channel: dto.channel ?? null,
            ipHash: hashIp(ip),
          },
        });
        this.auditLog.logUserAction({
          userId,
          action: UserAuditAction.CONSENT_GRANTED,
          entityType: 'ConsentRecord',
          entityId: `${dto.type}`,
          description: `Granted consent ${dto.type} (${policy.version})`,
        });
      }
    } else if (isOpen && latest) {
      await this.prisma.consentRecord.update({
        where: { id: latest.id },
        data: { revokedAt: new Date() },
      });
      this.auditLog.logUserAction({
        userId,
        action: UserAuditAction.CONSENT_REVOKED,
        entityType: 'ConsentRecord',
        entityId: latest.id,
        description: `Revoked consent ${dto.type}`,
      });
    }

    // G084: selaraskan preferensi notifikasi lama agar tidak ada dua sumber kebenaran.
    if (dto.type === ConsentType.MARKETING_EMAIL || dto.type === ConsentType.MARKETING_PUSH) {
      const field = dto.type === ConsentType.MARKETING_EMAIL ? 'marketingEmail' : 'marketingPush';
      await this.prisma.notificationPreference.upsert({
        where: { userId },
        create: { userId, [field]: dto.granted },
        update: { [field]: dto.granted },
      });
    }

    const current = await this.getConsents(userId);
    return current.find((c) => c.type === dto.type)!;
  }

  /** G086: riwayat persetujuan (paginasi, terbaru dulu). */
  async getConsentHistory(
    userId: string,
    page: number,
    limit: number,
  ): Promise<PaginatedResponse<Record<string, unknown>>> {
    const safePage = Math.max(1, page);
    const safeLimit = Math.min(limit, 100);
    const skip = (safePage - 1) * safeLimit;

    const [records, total] = await Promise.all([
      this.prisma.consentRecord.findMany({
        where: { userId },
        skip,
        take: safeLimit,
        orderBy: [{ grantedAt: 'desc' }, { id: 'desc' }],
        select: {
          id: true,
          type: true,
          policyVersion: true,
          policyTextHash: true,
          channel: true,
          grantedAt: true,
          revokedAt: true,
        },
      }),
      this.prisma.consentRecord.count({ where: { userId } }),
    ]);

    return createPaginatedResponse(records, total, safePage, safeLimit);
  }

  /**
   * G087–G100: ekspor data pribadi yang diperluas.
   * - format=json: satu berkas JSON (kontrak lama dipertahankan + dataset baru + manifest).
   * - format=csv: ZIP berisi manifest.json + file per dataset (CSV untuk orders & wallet).
   * - Setiap permintaan dicatat di DataExportRequest (riwayat + status + expiry);
   *   URL unduhan bertanda waktu (15 menit) dan dibuat on-demand dari artifactKey.
   */
  async requestDataExport(
    userId: string,
    format: 'json' | 'csv' = 'json',
  ): Promise<{ message: string; downloadUrl: string; expiresAt: Date; requestId: string }> {
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

    // G087: catat permintaan ekspor (status awal PENDING).
    const exportRequest = await this.prisma.dataExportRequest.create({
      data: {
        userId,
        status: DataExportStatus.PENDING,
        format: format === 'csv' ? DataExportFormat.CSV : DataExportFormat.JSON,
      },
      select: { id: true },
    });

    try {
      const locale: ExportLocale = user.language === 'en' ? 'en' : 'id';
      const datasets = await this.buildExportDatasets(userId, user);

      let artifact: { downloadUrl: string; expiresAt: Date; fileKey: string };
      let manifestDatasets: ManifestDataset[];
      if (format === 'csv') {
        const zipEntries = this.buildCsvExportEntries(datasets);
        manifestDatasets = zipEntries.map((e) => ({ name: e.name, rows: e.rows, format: e.format as 'json' | 'csv' }));
        const manifest = buildExportManifest(locale, manifestDatasets);
        const zipBuffer = buildZip([
          { name: 'manifest.json', data: Buffer.from(JSON.stringify(manifest, null, 2), 'utf8') },
          ...zipEntries.map((e) => ({ name: e.name, data: Buffer.from(e.content, 'utf8') })),
        ]);
        artifact = await this.uploadService.uploadPrivateAccountExport(userId, zipBuffer, { fileExtension: 'zip' });
      } else {
        manifestDatasets = Object.entries(datasets.manifestRows).map(([name, rows]) => ({ name, rows, format: 'json' as const }));
        const manifest = buildExportManifest(locale, manifestDatasets);
        const exportPayload = { manifest, ...datasets.payload };
        const json = JSON.stringify(exportPayload, (_, value: unknown) => (typeof value === 'bigint' ? value.toString() : value), 2);
        artifact = await this.uploadService.uploadPrivateAccountExport(userId, Buffer.from(json, 'utf8'));
      }

      await this.prisma.dataExportRequest.update({
        where: { id: exportRequest.id },
        data: {
          status: DataExportStatus.READY,
          artifactKey: artifact.fileKey,
          readyAt: new Date(),
          expiresAt: artifact.expiresAt,
        },
      });

      const expiresAt = artifact.expiresAt.toISOString();
      const message =
        locale === 'en'
          ? 'Your account data is ready to download. The link is time-limited for your security.'
          : 'Data akun Anda siap diunduh. Tautan ini berlaku terbatas demi keamanan Anda.';

      if (user.email) {
        await this.emailQueue.add('send', {
          to: user.email,
          subject: locale === 'en' ? 'Your Kahade Account Data' : 'Data Akun Kahade Anda',
          templateName: 'data-export',
          templateContext: { name: user.fullName, downloadUrl: artifact.downloadUrl, expiresAt },
        });
      }
      await this.notificationQueue.enqueue({
        userId,
        type: NotificationType.DATA_EXPORT_READY,
        title: locale === 'en' ? 'Account data ready' : 'Data akun siap diunduh',
        body: message,
        actionUrl: artifact.downloadUrl,
        language: locale,
      });

      this.auditLog.logUserAction({
        userId,
        action: UserAuditAction.DATA_EXPORT_REQUESTED,
        entityType: 'DataExportRequest',
        entityId: exportRequest.id,
        description: `Generated personal data export (format=${format})`,
      });

      return { message, downloadUrl: artifact.downloadUrl, expiresAt: artifact.expiresAt, requestId: exportRequest.id };
    } catch (error) {
      await this.prisma.dataExportRequest
        .update({
          where: { id: exportRequest.id },
          data: {
            status: DataExportStatus.FAILED,
            failureReason: error instanceof Error ? error.message.slice(0, 500) : 'Unknown error',
          },
        })
        .catch(() => undefined);
      await this.redis.releaseLock(cooldownKey, cooldownToken);
      throw error;
    }
  }

  /**
   * G090–G096: rakit seluruh dataset ekspor dengan redaksi yang tepat.
   * Mengembalikan payload (untuk JSON) + jumlah baris per dataset (untuk manifest/CSV).
   */
  private async buildExportDatasets(
    userId: string,
    user: {
      id: string;
      userId: string;
      username: string | null;
      email: string | null;
      fullName: string;
      bio: string | null;
      avatarUrl: string | null;
      headerUrl: string | null;
      accountType: unknown;
      phoneNumber: string | null;
      phoneVerified: boolean;
      dateOfBirth: Date | null;
      gender: unknown;
      address: string | null;
      emailVerified: boolean;
      emailVerifiedAt: Date | null;
      kycStatus: unknown;
      kycApprovedAt: Date | null;
      isKahadePlus: boolean;
      subscriptionExpiresAt: Date | null;
      profileVisible: boolean;
      showOnlineStatus: boolean;
      language: string | null;
      membershipRank: unknown;
      memberSince: Date | null;
      createdAt: Date;
      updatedAt: Date;
    },
  ): Promise<{
    payload: Record<string, unknown>;
    manifestRows: Record<string, number>;
    ordersCsv: Array<Record<string, unknown>>;
    walletCsv: Array<Record<string, unknown>>;
  }> {
    const [
      sessions,
      devices,
      bankAccounts,
      links,
      following,
      followers,
      favorites,
      badges,
      notificationPreference,
      privacySetting,
      blocksCount,
      reportsCount,
      orders,
      wallet,
      walletTxs,
      chatRooms,
      disputes,
      ratingsGiven,
      ratingsReceived,
      questionsAsked,
      questionsReceived,
      qaComments,
      qaUpvotes,
      showcaseItems,
      showcaseComments,
      showcaseLikes,
      savedProfiles,
      tickets,
      feedbacks,
    ] = await Promise.all([
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
      this.prisma.follow.findMany({ where: { followerId: userId }, orderBy: { createdAt: 'desc' }, take: 2000, select: { followingId: true, createdAt: true, following: { select: { userId: true, username: true, fullName: true } } } }),
      this.prisma.follow.findMany({ where: { followingId: userId }, orderBy: { createdAt: 'desc' }, take: 2000, select: { followerId: true, createdAt: true, follower: { select: { userId: true, username: true, fullName: true } } } } ),
      this.prisma.userFavorite.findMany({ where: { userId }, orderBy: { createdAt: 'desc' }, take: 1000, select: { favoriteUserId: true, createdAt: true, favoriteUser: { select: { userId: true, username: true, fullName: true } } } }),
      this.prisma.userBadge.findMany({ where: { userId }, orderBy: { earnedAt: 'desc' }, select: { earnedAt: true, badge: { select: { id: true, name: true, description: true } } } }),
      this.prisma.notificationPreference.findUnique({ where: { userId } }),
      this.prisma.privacySetting.findUnique({ where: { userId } }),
      this.prisma.blockList.count({ where: { blockerId: userId } }),
      this.prisma.userReport.count({ where: { reporterId: userId } }),
      // G090: order milik user (sebagai buyer maupun seller).
      this.prisma.order.findMany({
        where: { OR: [{ buyerId: userId }, { sellerId: userId }], deletedAt: null },
        orderBy: { createdAt: 'desc' },
        take: 2000,
        select: {
          id: true, orderId: true, buyerId: true, sellerId: true,
          title: true, description: true, orderType: true,
          orderValue: true, feeAmount: true, buyerPayAmount: true, sellerReceiveAmount: true,
          status: true, cancelReason: true, courierName: true, trackingNumber: true,
          createdAt: true, confirmedAt: true, paidAt: true, shippedAt: true,
          completedAt: true, cancelledAt: true, disputedAt: true,
          buyer: { select: { username: true } },
          seller: { select: { username: true } },
        },
      }),
      // G091: dompet + transaksi.
      this.prisma.wallet.findUnique({
        where: { userId },
        select: { availableBalance: true, escrowBalance: true, totalBalance: true, createdAt: true, updatedAt: true },
      }),
      this.prisma.walletTransaction.findMany({
        where: { wallet: { userId } },
        orderBy: { createdAt: 'desc' },
        take: 2000,
        select: {
          id: true, txId: true, type: true, status: true,
          amount: true, balanceBefore: true, balanceAfter: true,
          orderId: true, description: true, failureReason: true,
          withdrawStatus: true, createdAt: true, updatedAt: true, completedAt: true,
          bankAccount: { select: { bankName: true, accountNumber: true } },
        },
      }),
      // G092: metadata chat (tanpa isi pesan).
      this.prisma.chatRoom.findMany({
        where: { OR: [{ initiatorId: userId }, { counterpartId: userId }], deletedAt: null },
        orderBy: { updatedAt: 'desc' },
        take: 1000,
        select: {
          id: true, type: true, status: true, subject: true,
          initiator: { select: { username: true } },
          counterpart: { select: { username: true } },
          _count: { select: { messages: true } },
          createdAt: true, updatedAt: true,
        },
      }),
      // G093: sengketa.
      this.prisma.dispute.findMany({
        where: {
          OR: [{ initiatorUserId: userId }, { order: { buyerId: userId } }, { order: { sellerId: userId } }],
          deletedAt: null,
        },
        orderBy: { createdAt: 'desc' },
        take: 500,
        select: {
          id: true, disputeId: true, orderId: true,
          order: { select: { orderId: true } },
          initiatedBy: true, initiatorUserId: true,
          buyerClaim: true, sellerClaim: true,
          status: true, category: true,
          createdAt: true, resolvedAt: true,
          decision: {
            select: {
              decisionType: true, buyerAmount: true, sellerAmount: true,
              decisionNotes: true, isExecuted: true, executedAt: true, createdAt: true,
            },
          },
          evidences: {
            orderBy: { createdAt: 'asc' },
            select: { id: true, submittedByRole: true, submittedByUserId: true, description: true, fileTypes: true, createdAt: true },
          },
          messages: {
            orderBy: { createdAt: 'asc' },
            take: 500,
            select: { id: true, senderId: true, adminId: true, message: true, createdAt: true },
          },
        },
      }),
      // G094: rating yang diberikan & diterima.
      this.prisma.rating.findMany({
        where: { giverId: userId },
        orderBy: { createdAt: 'desc' },
        take: 1000,
        select: { id: true, orderId: true, stars: true, comment: true, giverRole: true, createdAt: true, receiver: { select: { username: true } } },
      }),
      this.prisma.rating.findMany({
        where: { receiverId: userId },
        orderBy: { createdAt: 'desc' },
        take: 1000,
        select: { id: true, orderId: true, stars: true, comment: true, giverRole: true, createdAt: true, giver: { select: { username: true } } },
      }),
      // G094: Q&A profil.
      this.prisma.profileQuestion.findMany({
        where: { askerId: userId },
        orderBy: { createdAt: 'desc' },
        take: 1000,
        select: { id: true, question: true, answer: true, answeredAt: true, isPublic: true, upvoteCount: true, createdAt: true, receiver: { select: { username: true } } },
      }),
      this.prisma.profileQuestion.findMany({
        where: { receiverId: userId },
        orderBy: { createdAt: 'desc' },
        take: 1000,
        select: { id: true, question: true, answer: true, answeredAt: true, isPublic: true, upvoteCount: true, createdAt: true, asker: { select: { username: true } } },
      }),
      this.prisma.profileQuestionComment.findMany({
        where: { authorId: userId },
        orderBy: { createdAt: 'desc' },
        take: 1000,
        select: { id: true, questionId: true, content: true, createdAt: true },
      }),
      this.prisma.profileQuestionUpvote.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' },
        take: 2000,
        select: { questionId: true, createdAt: true },
      }),
      // G095: showcase milik user + interaksi.
      this.prisma.userShowcase.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' },
        take: 1000,
        select: {
          id: true, title: true, description: true, category: true, visibility: true,
          likeCount: true, commentCount: true, viewCount: true, shareCount: true,
          isActive: true, deletedAt: true, createdAt: true, updatedAt: true,
          images: { orderBy: { sortOrder: 'asc' }, select: { imageUrl: true, sortOrder: true } },
        },
      }),
      this.prisma.showcaseComment.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' },
        take: 1000,
        select: { id: true, showcaseId: true, content: true, createdAt: true, showcase: { select: { title: true, user: { select: { username: true } } } } },
      }),
      this.prisma.showcaseLike.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' },
        take: 2000,
        select: { showcaseId: true, createdAt: true, showcase: { select: { title: true, user: { select: { username: true } } } } },
      }),
      this.prisma.userSavedProfile.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' },
        take: 1000,
        select: { savedUserId: true, createdAt: true, savedUser: { select: { username: true, fullName: true } } },
      }),
      // G096: tiket support + feedback.
      this.prisma.supportTicket.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' },
        take: 500,
        select: {
          id: true, subject: true, category: true, status: true, priority: true,
          message: true, createdAt: true, updatedAt: true,
          replies: { orderBy: { createdAt: 'asc' }, take: 500, select: { id: true, senderType: true, senderId: true, message: true, createdAt: true } },
        },
      }),
      this.prisma.feedback.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' },
        take: 500,
        select: { id: true, category: true, message: true, rating: true, platform: true, status: true, createdAt: true },
      }),
    ]);

    const maskedBankAccounts = await Promise.all(bankAccounts.map(async (account) => {
      let maskedAccountNumber = '****';
      let accountName = account.accountName;
      try {
        const plain = await decryptAES(account.accountNumber);
        maskedAccountNumber = maskAccountNumberTail(plain);
      } catch {
        // Legacy records may not be encrypted; do not expose the raw value.
      }
      try { accountName = await decryptAES(account.accountName); } catch { /* legacy plaintext name */ }
      return { id: account.id, bankCode: account.bankCode, bankName: account.bankName, accountName, maskedAccountNumber, isPrimary: account.isPrimary, isVerified: account.isVerified, createdAt: account.createdAt, updatedAt: account.updatedAt };
    }));

    // G090: redaksi order (username lawan saja).
    const sanitizedOrders = orders.map((o) => sanitizeOrderForExport(o, userId));

    // G091: transaksi dompet + ringkasan ledger.
    const sanitizedWalletTxs = await Promise.all(walletTxs.map(async (tx) => {
      let masked: string | null = null;
      if (tx.bankAccount?.accountNumber) {
        try {
          masked = maskAccountNumberTail(await decryptAES(tx.bankAccount.accountNumber));
        } catch {
          masked = '****';
        }
      }
      return sanitizeWalletTxForExport({
        ...tx,
        bankAccount: tx.bankAccount ? { bankName: tx.bankAccount.bankName, maskedAccountNumber: masked ?? '****' } : null,
      });
    }));
    const ledgerSummary: Record<string, { count: number; totalAmountSen: string }> = {};
    for (const tx of walletTxs) {
      const key = `${tx.type}:${tx.status}`;
      const entry = ledgerSummary[key] ?? { count: 0, totalAmountSen: '0' };
      entry.count += 1;
      entry.totalAmountSen = (BigInt(entry.totalAmountSen) + tx.amount).toString();
      ledgerSummary[key] = entry;
    }

    // G092: metadata chat.
    const sanitizedChatRooms = chatRooms.map((r) => sanitizeChatRoomForExport(r, userId, null));

    // G093: sengketa.
    const sanitizedDisputes = disputes.map((d) => sanitizeDisputeForExport(d, userId));

    // G096: tiket support — pesan pihak lain dimaskir.
    const sanitizedTickets = tickets.map((t) => ({
      id: t.id,
      subject: t.subject,
      category: t.category,
      status: t.status,
      priority: t.priority,
      message: t.message,
      createdAt: t.createdAt,
      updatedAt: t.updatedAt,
      replies: t.replies.map((r) => sanitizeTicketReplyForExport({ ...r, senderType: String(r.senderType) }, userId)),
    }));

    const payload: Record<string, unknown> = {
      exportVersion: EXPORT_SCHEMA_VERSION,
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
      privacySettings: privacySetting
        ? {
            showEmail: privacySetting.showEmail, showPhone: privacySetting.showPhone,
            showDob: privacySetting.showDob, showGender: privacySetting.showGender,
            showFollowerList: privacySetting.showFollowerList, showFollowingList: privacySetting.showFollowingList,
            showcaseDefaultVisibility: privacySetting.showcaseDefaultVisibility,
            qaCommentPolicy: privacySetting.qaCommentPolicy, qaAnswerModeration: privacySetting.qaAnswerModeration,
            showReviews: privacySetting.showReviews, hiddenStats: privacySetting.hiddenStats,
            searchEngineIndex: privacySetting.searchEngineIndex,
          }
        : null,
      consents: (await this.getConsents(userId)).map((c) => ({
        type: c.type, granted: c.granted, revocable: c.revocable,
        policyVersion: c.policyVersion, grantedAt: c.grantedAt, revokedAt: c.revokedAt,
      })),
      // G090–G096
      orders: sanitizedOrders,
      wallet: {
        balances: wallet
          ? {
              availableSen: wallet.availableBalance.toString(),
              escrowSen: wallet.escrowBalance.toString(),
              totalSen: wallet.totalBalance.toString(),
            }
          : null,
        ledgerSummary,
        transactions: sanitizedWalletTxs,
      },
      chat: sanitizedChatRooms,
      disputes: sanitizedDisputes,
      ratings: {
        given: ratingsGiven.map((r) => ({ id: r.id, orderId: r.orderId, stars: r.stars, comment: r.comment, giverRole: r.giverRole, receiverUsername: r.receiver.username, createdAt: r.createdAt })),
        received: ratingsReceived.map((r) => ({ id: r.id, orderId: r.orderId, stars: r.stars, comment: r.comment, giverRole: r.giverRole, giverUsername: r.giver.username, createdAt: r.createdAt })),
      },
      qa: {
        questionsAsked: questionsAsked.map((q) => ({ id: q.id, question: q.question, answer: q.answer, answeredAt: q.answeredAt, isPublic: q.isPublic, upvoteCount: q.upvoteCount, receiverUsername: q.receiver.username, createdAt: q.createdAt })),
        questionsReceived: questionsReceived.map((q) => ({ id: q.id, question: q.question, answer: q.answer, answeredAt: q.answeredAt, isPublic: q.isPublic, upvoteCount: q.upvoteCount, askerUsername: q.asker.username, createdAt: q.createdAt })),
        commentsAuthored: qaComments,
        upvotesGiven: qaUpvotes,
      },
      showcase: {
        items: showcaseItems.map((s) => ({
          id: s.id, title: s.title, description: s.description, category: s.category,
          visibility: s.visibility, likeCount: s.likeCount, commentCount: s.commentCount,
          viewCount: s.viewCount, shareCount: s.shareCount, isActive: s.isActive,
          deletedAt: s.deletedAt, imageCount: s.images.length,
          imageUrls: s.images.map((i) => i.imageUrl),
          createdAt: s.createdAt, updatedAt: s.updatedAt,
        })),
        commentsAuthored: showcaseComments.map((c) => ({
          id: c.id, showcaseId: c.showcaseId, showcaseTitle: c.showcase.title,
          showcaseOwnerUsername: c.showcase.user.username, content: c.content, createdAt: c.createdAt,
        })),
        likesGiven: showcaseLikes.map((l) => ({
          showcaseId: l.showcaseId, showcaseTitle: l.showcase.title,
          showcaseOwnerUsername: l.showcase.user.username, createdAt: l.createdAt,
        })),
        savedProfiles: savedProfiles.map((s) => ({
          savedUserId: s.savedUserId, username: s.savedUser.username,
          fullName: s.savedUser.fullName, createdAt: s.createdAt,
        })),
      },
      supportTickets: sanitizedTickets,
      feedbacks,
      blockedUsersCount: blocksCount,
      submittedReportsCount: reportsCount,
    };

    const manifestRows: Record<string, number> = {
      profile: 1,
      sessions: sessions.length,
      devices: devices.length,
      bankAccounts: maskedBankAccounts.length,
      socialLinks: links.length,
      following: following.length,
      followers: followers.length,
      favorites: favorites.length,
      badges: badges.length,
      orders: sanitizedOrders.length,
      walletTransactions: sanitizedWalletTxs.length,
      chatRooms: sanitizedChatRooms.length,
      disputes: sanitizedDisputes.length,
      ratingsGiven: ratingsGiven.length,
      ratingsReceived: ratingsReceived.length,
      questionsAsked: questionsAsked.length,
      questionsReceived: questionsReceived.length,
      qaComments: qaComments.length,
      qaUpvotes: qaUpvotes.length,
      showcaseItems: showcaseItems.length,
      showcaseComments: showcaseComments.length,
      showcaseLikes: showcaseLikes.length,
      savedProfiles: savedProfiles.length,
      supportTickets: sanitizedTickets.length,
      feedbacks: feedbacks.length,
    };

    // G098: baris CSV untuk dataset tabular.
    const ordersCsv = sanitizedOrders.map((o) => ({
      orderId: o.orderId,
      myRole: o.myRole,
      counterpartUsername: o.counterpartUsername,
      title: o.title,
      orderType: o.orderType,
      status: o.status,
      orderValueIdr: senToIdr(o.orderValue as bigint),
      feeAmountIdr: senToIdr(o.feeAmount as bigint),
      buyerPayIdr: senToIdr(o.buyerPayAmount as bigint),
      sellerReceiveIdr: senToIdr(o.sellerReceiveAmount as bigint),
      createdAt: o.createdAt,
      completedAt: o.completedAt ?? '',
    }));
    const walletCsv = sanitizedWalletTxs.map((t) => ({
      txId: t.txId,
      type: t.type,
      status: t.status,
      amountIdr: senToIdr(t.amount as bigint),
      balanceBeforeIdr: senToIdr(t.balanceBefore as bigint),
      balanceAfterIdr: senToIdr(t.balanceAfter as bigint),
      description: t.description,
      orderId: t.orderId ?? '',
      createdAt: t.createdAt,
      completedAt: t.completedAt ?? '',
    }));

    return { payload, manifestRows, ordersCsv, walletCsv };
  }

  /** G098: susun entri ZIP untuk format CSV (manifest ditambahkan pemanggil). */
  private buildCsvExportEntries(datasets: {
    payload: Record<string, unknown>;
    ordersCsv: Array<Record<string, unknown>>;
    walletCsv: Array<Record<string, unknown>>;
  }): Array<{ name: string; rows: number; format: 'json' | 'csv'; content: string }> {
    const { payload, ordersCsv, walletCsv } = datasets;
    const jsonFile = (name: string, value: unknown, rows: number) => ({
      name,
      rows,
      format: 'json' as const,
      content: JSON.stringify(value, (_, v: unknown) => (typeof v === 'bigint' ? v.toString() : v), 2),
    });
    return [
      jsonFile('profile.json', {
        exportVersion: payload.exportVersion,
        exportedAt: payload.exportedAt,
        profile: payload.profile,
        security: payload.security,
        bankAccounts: payload.bankAccounts,
        socialLinks: payload.socialLinks,
        following: payload.following,
        followers: payload.followers,
        favorites: payload.favorites,
        badges: payload.badges,
        notificationPreferences: payload.notificationPreferences,
        privacySettings: payload.privacySettings,
        consents: payload.consents,
        blockedUsersCount: payload.blockedUsersCount,
        submittedReportsCount: payload.submittedReportsCount,
      }, 1),
      {
        name: 'orders.csv',
        rows: ordersCsv.length,
        format: 'csv' as const,
        content: buildCsv(
          ['orderId', 'myRole', 'counterpartUsername', 'title', 'orderType', 'status', 'orderValueIdr', 'feeAmountIdr', 'buyerPayIdr', 'sellerReceiveIdr', 'createdAt', 'completedAt'],
          ordersCsv,
        ),
      },
      {
        name: 'wallet_transactions.csv',
        rows: walletCsv.length,
        format: 'csv' as const,
        content: buildCsv(
          ['txId', 'type', 'status', 'amountIdr', 'balanceBeforeIdr', 'balanceAfterIdr', 'description', 'orderId', 'createdAt', 'completedAt'],
          walletCsv,
        ),
      },
      jsonFile('wallet_summary.json', (payload.wallet as Record<string, unknown>)?.balances
        ? { balances: (payload.wallet as Record<string, unknown>).balances, ledgerSummary: (payload.wallet as Record<string, unknown>).ledgerSummary }
        : null, 1),
      jsonFile('chat.json', payload.chat, Array.isArray(payload.chat) ? payload.chat.length : 0),
      jsonFile('disputes.json', payload.disputes, Array.isArray(payload.disputes) ? payload.disputes.length : 0),
      jsonFile('ratings.json', payload.ratings, 1),
      jsonFile('qa.json', payload.qa, 1),
      jsonFile('showcase.json', payload.showcase, 1),
      jsonFile('support_tickets.json', payload.supportTickets, Array.isArray(payload.supportTickets) ? payload.supportTickets.length : 0),
      jsonFile('feedbacks.json', payload.feedbacks, Array.isArray(payload.feedbacks) ? payload.feedbacks.length : 0),
    ];
  }

  /**
   * G087–G088: riwayat permintaan ekspor milik user (terbaru dulu).
   * Baris READY yang sudah lewat expiresAt dilaporkan sebagai EXPIRED.
   */
  async listExportRequests(userId: string, page: number, limit: number): Promise<PaginatedResponse<ExportRequestSummary>> {
    const now = new Date();
    // Tandai yang kedaluwarsa (best-effort; kegagalan tidak menggagalkan list).
    await this.prisma.dataExportRequest
      .updateMany({
        where: { userId, status: DataExportStatus.READY, expiresAt: { lt: now } },
        data: { status: DataExportStatus.EXPIRED },
      })
      .catch(() => undefined);

    const safePage = Math.max(1, page);
    const safeLimit = Math.min(limit, 50);
    const skip = (safePage - 1) * safeLimit;

    const [requests, total] = await Promise.all([
      this.prisma.dataExportRequest.findMany({
        where: { userId },
        skip,
        take: safeLimit,
        orderBy: { requestedAt: 'desc' },
        select: {
          id: true, status: true, format: true,
          requestedAt: true, readyAt: true, expiresAt: true,
          downloadedAt: true, downloadCount: true,
        },
      }),
      this.prisma.dataExportRequest.count({ where: { userId } }),
    ]);

    const items: ExportRequestSummary[] = requests.map((r) => ({
      id: r.id,
      status: r.status === DataExportStatus.READY && r.expiresAt && r.expiresAt < now ? DataExportStatus.EXPIRED : r.status,
      format: r.format,
      requestedAt: r.requestedAt,
      readyAt: r.readyAt,
      expiresAt: r.expiresAt,
      downloadedAt: r.downloadedAt,
      downloadCount: r.downloadCount,
    }));

    return createPaginatedResponse(items, total, safePage, safeLimit);
  }

  /**
   * G100: unduh arsip ekspor — mencatat setiap akses (downloadedAt,
   * downloadCount + audit log) dan menerbitkan URL signed baru yang
   * bertanda waktu singkat (5 menit). URL tidak pernah disimpan mentah.
   */
  async downloadExportRequest(
    userId: string,
    requestId: string,
  ): Promise<{ downloadUrl: string; expiresAt: Date }> {
    const request = await this.prisma.dataExportRequest.findUnique({
      where: { id: requestId },
      select: { id: true, userId: true, status: true, artifactKey: true, expiresAt: true },
    });
    if (!request || request.userId !== userId) {
      throw new NotFoundException({ code: ErrorCodes.USER_NOT_FOUND, message: 'Export request not found' });
    }
    if (request.status !== DataExportStatus.READY || !request.artifactKey) {
      throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Export is not ready for download' });
    }
    if (request.expiresAt && request.expiresAt < new Date()) {
      await this.prisma.dataExportRequest
        .update({ where: { id: request.id }, data: { status: DataExportStatus.EXPIRED } })
        .catch(() => undefined);
      throw new BadRequestException({
        code: ErrorCodes.VALIDATION_ERROR,
        message: 'Tautan ekspor sudah kedaluwarsa. Silakan minta ekspor baru.',
      });
    }

    // URL signed baru bertanda waktu singkat — kemampuan sekali pakai per unduhan.
    const { downloadUrl, expiresAt } = this.uploadService.createSignedDownloadUrl(request.artifactKey, 300);

    await this.prisma.dataExportRequest.update({
      where: { id: request.id },
      data: { downloadedAt: new Date(), downloadCount: { increment: 1 } },
    });

    this.auditLog.logUserAction({
      userId,
      action: UserAuditAction.DATA_EXPORT_DOWNLOADED,
      entityType: 'DataExportRequest',
      entityId: request.id,
      description: 'Downloaded personal data export',
    });

    return { downloadUrl, expiresAt };
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
