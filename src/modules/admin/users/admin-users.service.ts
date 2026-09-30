import { Injectable, NotFoundException, ForbiddenException, BadRequestException, ConflictException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bull';
import { Queue } from 'bull';
import { randomUUID } from 'crypto';
import { Prisma, AuditAction, OrderStatus, WalletTransactionType, WalletTransactionStatus, OtpType, NotificationType, DeletionRequestStatus } from '@prisma/client';
import { getCategoryForType } from '../../notifications/notification-category.map';
import { PrismaService } from '../../../prisma/prisma.service';
import { RedisService } from '../../../redis/redis.service';
import { SESSION_REVOKED_KEY } from '../../../common/constants/redis-keys';
import { AuditLogService } from '../../../common/services/audit-log.service';
import { WalletAdjustDto, WalletAdjustType } from './dto/wallet-adjust.dto';
import { WalletTxSerialService } from '../../../common/services/wallet-tx-serial.service';
import { toSen, toIdr } from '../../../common/utils/currency.util';
import { createPaginatedResponse } from '../../../common/dto/pagination.dto';
import * as ErrorCodes from '../../../common/constants/error-codes';
import { OtpService } from '../../auth/otp.service';
import { withCsvExportWatermark } from '../../../common/utils/csv-watermark.util';
import { VerificationBadgeService } from '../../users/verification-badge.service';
import { EMAIL_QUEUE, EmailJobData } from '../../queue/processors/email.processor';
import { generateNotifId, generateWalletTxId } from '../../../common/utils/id-generator.util';
import { parseJwtTtl } from '../../../common/utils/jwt.util';
import { decryptPiiSafe, hashPhoneNumber, normalizePhoneNumber } from '../../../common/utils/pii.util';
import { escapeLikePattern } from '../../../common/utils/search.util';
import { DashboardService } from '../dashboard/dashboard.service';
import { UploadService } from '../../upload/upload.service';
import { LocalStorageService } from '../../upload/local-storage.service';
import { encryptAES } from '../../../common/utils/crypto.util';
import { applyUserMask, PII_UNMASKED_ROLES, maskIp } from '../../../common/maskPiiByRole';
import { walletTxDirection } from '../../../common/utils/wallet-direction.util';
import { UserExportQueryDto } from './dto/user-export-query.dto';
import { ModerationEventsQueryDto, ModerationEventType } from './dto/moderation-events-query.dto';

@Injectable()
export class AdminUsersService {
  private readonly logger = new Logger(AdminUsersService.name);
  private readonly accessTokenTtlSeconds: number;

  constructor(
    private prisma: PrismaService,
    private redis: RedisService,
    private configService: ConfigService,
    private auditLog: AuditLogService,
    private walletTxSerial: WalletTxSerialService,
    private otpService: OtpService,
    private verificationBadge: VerificationBadgeService,
    @InjectQueue(EMAIL_QUEUE) private readonly emailQueue: Queue<EmailJobData>,
    // AW-018: invalidasi cache summary dashboard setelah mutasi yang
    // memengaruhi angka (via helper terpusat, bukan del() manual).
    private readonly dashboard: DashboardService,
    // GAP-E (G380): signed URL 15 menit untuk hasil ekspor async.
    private readonly uploadService: UploadService,
    private readonly localStorage: LocalStorageService,
  ) {
    this.accessTokenTtlSeconds = parseJwtTtl(
      this.configService.get<string>('jwt.expiresIn') ?? '15m',
    );
  }


  /**
   * ADM-008: `adminRole` dipakai untuk penyamaran PII — hanya SUPER_ADMIN
   * melihat email/nomor HP penuh; role lain (mis. CUSTOMER_SUPPORT) mendapat
   * versi ter-mask, sesuai kebijakan `PII_UNMASKED_ROLES`.
   */
  async listUsers(page = 1, limit = 20, search?: string, status?: string, sortBy?: string, sortOrder?: 'asc' | 'desc', adminRole?: string): Promise<object> {
    const safeLimit = Math.min(limit, 100);
    const skip = (page - 1) * safeLimit;
    const where = this.buildUserWhere(search, status);

    const allowedSortFields = ['createdAt', 'lastLoginAt', 'email', 'fullName'];
    const orderField = sortBy && allowedSortFields.includes(sortBy) ? sortBy : 'createdAt';
    const orderDir = sortOrder === 'asc' ? 'asc' : 'desc';

    const [users, total] = await Promise.all([
      this.prisma.user.findMany({
        where,
        skip,
        take: safeLimit,
        orderBy: { [orderField]: orderDir },
        select: {
          id: true, userId: true, username: true, email: true, fullName: true,
          kycStatus: true, isBanned: true, banReason: true,
          emailVerified: true, isActive: true, isKahadePlus: true,
          membershipRank: true, averageRating: true,
          totalOrdersAsBuyer: true, totalOrdersAsSeller: true, totalOrdersCompleted: true,
          createdAt: true, lastLoginAt: true,
          // Section 6: penanda antrean moderasi (internal admin saja).
          flaggedForReview: true, flaggedForReviewAt: true,
          wallet: { select: { totalBalance: true, availableBalance: true } },
        },
      }),
      this.prisma.user.count({ where }),
    ]);

    const serialized = users.map((u) => {
      const masked = applyUserMask(adminRole, { email: u.email, phoneNumber: null });
      return {
        ...u,
        email: masked.email,
        wallet: u.wallet ? {
          totalBalance: toIdr(u.wallet.totalBalance),
          availableBalance: toIdr(u.wallet.availableBalance),
        } : null,
      };
    });
    return createPaginatedResponse(serialized, total, page, safeLimit);
  }

  /**
   * GAP-E (G380): where filter pengguna bersama untuk list & ekspor CSV.
   * Diekstrak dari listUsers agar ekspor memakai semantik filter yang sama.
   */
  private buildUserWhere(search?: string, status?: string): Prisma.UserWhereInput {
    const where: Prisma.UserWhereInput = { deletedAt: null };

    if (search) {
      const orClauses: Prisma.UserWhereInput[] = [
        { email: { contains: escapeLikePattern(search), mode: 'insensitive' } },
        { fullName: { contains: escapeLikePattern(search), mode: 'insensitive' } },
        { userId: { contains: escapeLikePattern(search), mode: 'insensitive' } },
        { username: { contains: escapeLikePattern(search), mode: 'insensitive' } },
      ];
      const digitsOnly = search.replace(/\D/g, '');
      if (digitsOnly.length >= 8) {
        try {
          const normalized = normalizePhoneNumber(search);
          orClauses.push({ phoneNumberHash: hashPhoneNumber(normalized) });
        } catch {
          /* ignore — invalid phone format, fall back to other fields */
        }
      }
      where.OR = orClauses;
    }
    if (status === 'banned') where.isBanned = true;
    if (status === 'active') where.isBanned = false;
    if (status === 'kyc_approved') where.kycStatus = 'APPROVED';
    if (status === 'kyc_pending') where.kycStatus = 'PENDING';
    // BAI-070: segmen KYC lain yang sebelumnya tak terjangkau filter.
    if (status === 'kyc_rejected') where.kycStatus = 'REJECTED';
    if (status === 'kyc_revoked') where.kycStatus = 'REVOKED';
    if (status === 'kyc_unverified') where.kycStatus = 'UNVERIFIED';
    // Section 6: antrean moderasi — user yang terflag agregasi laporan
    // (>= 3 reporter berbeda dalam 24 jam). Flag ini sinyal saja, bukan sanksi.
    if (status === 'flagged') where.flaggedForReview = true;
    return where;
  }

  /**
   * ADM-008: `adminRole` dipakai untuk penyamaran PII — hanya SUPER_ADMIN
   * melihat email/nomor HP penuh (kebijakan `PII_UNMASKED_ROLES`).
   */
  async getUserDetail(userId: string, adminId?: string, ipAddress?: string, adminRole?: string): Promise<object> {
    const user = await this.prisma.user.findFirst({
      where: { OR: [{ id: userId }, { userId }], deletedAt: null },
      select: {
        id: true, userId: true, email: true, fullName: true, username: true,
        avatarUrl: true, accountType: true,
        phoneNumber: true, phoneVerified: true,
        kycStatus: true, isBanned: true, banReason: true,
        emailVerified: true, isActive: true, isKahadePlus: true, membershipRank: true,
        averageRating: true,
        totalOrdersAsBuyer: true, totalOrdersAsSeller: true,
        totalOrdersCompleted: true, totalOrdersDisputed: true,
        createdAt: true, updatedAt: true, lastLoginAt: true, lastLoginIp: true,
        bio: true, headerUrl: true, usernameChangedAt: true,
        // Section 6: penanda antrean moderasi + kapan ambang laporan terlampaui.
        flaggedForReview: true, flaggedForReviewAt: true,
        contactEmail: true, contactPhone: true,
        showContactEmail: true, showContactPhone: true,
        wallet: { select: { totalBalance: true, availableBalance: true, escrowBalance: true } },
        kycRequests: {
          orderBy: { createdAt: 'desc' },
          take: 1,
          select: { kycId: true, status: true, createdAt: true, reviewedAt: true, rejectionReason: true },
        },
        links: {
          orderBy: { displayOrder: 'asc' },
          select: { id: true, platform: true, url: true, label: true, displayOrder: true },
        },
        _count: {
          select: {
            followers: true,
            following: true,
            blockedUsers: true,
            reportsReceived: true,
          },
        },
      },
    });
    if (!user) throw new NotFoundException({ code: ErrorCodes.USER_NOT_FOUND, message: 'User not found' });

    // Fire-and-forget audit log — never block or fail the response.
    // CW-019: jangan simpan email (PII) di deskripsi audit log — userId
    // publik sudah cukup untuk penelusuran.
    if (adminId) {
      this.auditLog.logAdminAction({
        adminId,
        action: AuditAction.ADMIN_ACTION,
        targetType: 'User',
        targetId: user.id,
        description: `Admin viewed user detail for ${user.userId}`,
        ipAddress: ipAddress ?? 'unknown',
      });
    }

    const { _count, phoneNumber, ...userData } = user;
    const decryptedPhone = await decryptPiiSafe(phoneNumber);
    // ADM-008: terapkan masking PII sesuai role peminta (SUPER_ADMIN unmasked).
    const maskedPii = applyUserMask(adminRole, {
      email: userData.email,
      phoneNumber: decryptedPhone,
    });
    // BAI-076: lastLoginIp (data lokasi-ish sensitif) di-mask untuk role
    // non-SUPER_ADMIN — konsisten dengan email/nomor HP.
    const isUnmasked = !!adminRole && PII_UNMASKED_ROLES.includes(adminRole);
    return {
      ...userData,
      email: maskedPii.email,
      phoneNumber: maskedPii.phoneNumber,
      lastLoginIp: isUnmasked ? userData.lastLoginIp : maskIp(userData.lastLoginIp),
      followersCount: _count.followers,
      followingCount: _count.following,
      blockedUsersCount: _count.blockedUsers,
      reportsReceivedCount: _count.reportsReceived,
      wallet: userData.wallet ? {
        totalBalance: toIdr(userData.wallet.totalBalance),
        availableBalance: toIdr(userData.wallet.availableBalance),
        escrowBalance: toIdr(userData.wallet.escrowBalance),
      } : null,
    };
  }

  async banUser(userId: string, reason: string, adminId: string, ipAddress: string = 'internal'): Promise<object> {
    const user = await this.prisma.user.findFirst({
      where: { OR: [{ id: userId }, { userId }], deletedAt: null },
    });
    if (!user) throw new NotFoundException({ code: ErrorCodes.USER_NOT_FOUND, message: 'User not found' });
    if (user.isBanned) throw new ForbiddenException({ code: ErrorCodes.USER_ALREADY_BANNED, message: 'User is already banned' });

    const now = new Date();
    const updated = await this.prisma.user.update({
      where: { id: user.id },
      data: {
        isBanned: true,
        banReason: reason,
        bannedAt: now,
        bannedBy: adminId,
        // Section 6: ban adalah kesimpulan dari review, jadi flag antrean
        // dibersihkan agar user tidak terus muncul di daftar flagged.
        flaggedForReview: false,
        flaggedForReviewAt: null,
      },
      select: { userId: true, isBanned: true, banReason: true, bannedAt: true, bannedBy: true, flaggedForReview: true },
    });

    const activeSessions = await this.prisma.userSession.findMany({
      where: { userId: user.id, isRevoked: false },
      select: { id: true },
    });

    if (activeSessions.length > 0) {
      await this.prisma.userSession.updateMany({
        where: { userId: user.id, isRevoked: false },
        data: { isRevoked: true, revokedAt: now, revokedReason: 'user_banned' },
      });

      await Promise.all(
        activeSessions.map((s) =>
          this.redis.setex(SESSION_REVOKED_KEY(s.id), this.accessTokenTtlSeconds, 'revoked'),
        ),
      );
    }

    this.auditLog.logAdminAction({
      adminId,
      action: AuditAction.USER_BANNED,
      targetType: 'User',
      targetId: user.id,
      description: `Admin banned user ${user.id}. Reason: ${reason}`,
      before: { isBanned: false },
      after: { isBanned: true, banReason: reason },
      ipAddress,
    });

    // AW-018: angka dashboard (total/verifikasi user) bisa berubah.
    await this.dashboard.invalidateSummaryCache();

    return updated;
  }

  /**
   * BAI-071 — update terbatas profil user (SUPER_ADMIN, whitelist field).
   *
   * SENSITIF: hanya field yang dideklarasikan di `UpdateUserDto` yang
   * diproses (pipe global menolak field lain — forbidNonWhitelisted).
   * Setiap perubahan dicatat di audit log dengan before/after.
   * Perubahan accountType → invalidate badge agar badge biru/abu sinkron.
   */
  async updateUser(
    userId: string,
    dto: UpdateUserDto,
    adminId: string,
    ipAddress: string = 'internal',
  ): Promise<object> {
    const user = await this.prisma.user.findFirst({
      where: { OR: [{ id: userId }, { userId }], deletedAt: null },
      select: { id: true, userId: true, accountType: true },
    });
    if (!user) throw new NotFoundException({ code: ErrorCodes.USER_NOT_FOUND, message: 'User not found' });

    const changes: Record<string, { before: unknown; after: unknown }> = {};
    const data: Prisma.UserUpdateInput = {};
    if (dto.accountType !== undefined && dto.accountType !== user.accountType) {
      data.accountType = dto.accountType;
      changes.accountType = { before: user.accountType, after: dto.accountType };
    }
    if (Object.keys(changes).length === 0) {
      throw new BadRequestException({
        code: ErrorCodes.VALIDATION_ERROR,
        message: 'No changes to apply',
      });
    }

    const updated = await this.prisma.user.update({
      where: { id: user.id },
      data,
      select: { userId: true, accountType: true },
    });

    // Badge publik bisa berubah mengikuti accountType (mis. BUSINESS_VERIFIED
    // mensyaratkan accountType=BUSINESS) — sinkronkan segera.
    await this.verificationBadge.invalidate(user.id);

    this.auditLog.logAdminAction({
      adminId,
      action: AuditAction.USER_UPDATED,
      targetType: 'User',
      targetId: user.id,
      description: `Admin updated user ${user.id}: ${Object.keys(changes).join(', ')}`,
      before: Object.fromEntries(Object.entries(changes).map(([k, v]) => [k, v.before])),
      after: Object.fromEntries(Object.entries(changes).map(([k, v]) => [k, v.after])),
      ipAddress,
    });

    return updated;
  }

  async unbanUser(userId: string, adminId: string, ipAddress: string = 'internal'): Promise<object> {
    const user = await this.prisma.user.findFirst({
      where: { OR: [{ id: userId }, { userId }], deletedAt: null },
    });
    if (!user) throw new NotFoundException({ code: ErrorCodes.USER_NOT_FOUND, message: 'User not found' });
    if (!user.isBanned) throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'User is not currently banned' });

    const result = await this.prisma.user.update({
      where: { id: user.id },
      data: {
        isBanned: false, banReason: null, bannedAt: null, bannedBy: null,
        // Section 6: setelah banding diterima, user tidak boleh langsung
        // muncul lagi di antrean moderasi karena flag lama.
        flaggedForReview: false, flaggedForReviewAt: null,
      },
      select: { userId: true, isBanned: true, flaggedForReview: true },
    });

    this.auditLog.logAdminAction({
      adminId,
      action: AuditAction.USER_RESTORED,
      targetType: 'User',
      targetId: user.id,
      description: `Admin unbanned user ${user.id}`,
      before: { isBanned: true },
      after: { isBanned: false },
      ipAddress,
    });

    // AW-018: angka dashboard (total/verifikasi user) bisa berubah.
    await this.dashboard.invalidateSummaryCache();

    return result;
  }

  /**
   * Tier verified 3 tingkat (koreksi model 2026-09-26):
   *  - Abu (FULLY_VERIFIED): OTOMATIS dari KYC APPROVED + email verified +
   *    phone verified + alamat lengkap + Kahade Plus aktif. Bisa di-revoke
   *    admin kapanpun via revokeGrayVerified, dan di-restore via
   *    restoreGrayVerified.
   *  - Bisnis (BUSINESS_VERIFIED): manual oleh admin via modul
   *    business-verification (APPROVED).
   *  - Emas (TRUSTED_BY_KAHADE): manual ke customer pilihan via grantGoldVerified
   *    di bawah (reuse isVip/vipGrantedAt, tanpa field baru).
   * Badge (model Badge/UserBadge) adalah domain TERPISAH untuk event/pencapaian.
   */

  /** Cari user aktif (by id atau userId publik). */
  private async findActiveUserOrThrow(userId: string) {
    const user = await this.prisma.user.findFirst({
      where: { OR: [{ id: userId }, { userId }], deletedAt: null },
      select: {
        id: true, userId: true, email: true, isVip: true, vipGrantedAt: true,
        grayVerifiedRevokedAt: true,
      },
    });
    if (!user) throw new NotFoundException({ code: ErrorCodes.USER_NOT_FOUND, message: 'User not found' });
    return user;
  }

  /**
   * Grant tier EMAS (TRUSTED_BY_KAHADE) ke customer pilihan.
   * Hanya SUPER_ADMIN. Idempoten: bila sudah isVip, tetap 200 tanpa duplikasi.
   */
  async grantGoldVerified(userId: string, adminId: string, ipAddress: string = 'internal'): Promise<{ message: string }> {
    const user = await this.findActiveUserOrThrow(userId);
    const now = new Date();

    if (!user.isVip) {
      await this.prisma.user.update({
        where: { id: user.id },
        data: { isVip: true, vipGrantedAt: now, vipGrantedBy: adminId },
      });
    }

    this.auditLog.logAdminAction({
      adminId,
      action: AuditAction.ADMIN_ACTION,
      targetType: 'User',
      targetId: user.id,
      description: `Admin granted GOLD verified tier (TRUSTED_BY_KAHADE) to user ${user.id}`,
      before: { isVip: user.isVip },
      after: { isVip: true, vipGrantedAt: now.toISOString(), vipGrantedBy: adminId },
      ipAddress,
    });

    // Invalidate post-commit: badge TRUSTED_BY_KAHADE dihitung ulang dari isVip.
    await this.verificationBadge.invalidate(user.id);

    return { message: 'Tier emas (Dipercaya Kahade) berhasil diberikan.' };
  }

  /**
   * Revoke tier EMAS. vipGrantedAt dipertahankan untuk jejak audit;
   * yang menentukan badge hanya flag isVip.
   * Hanya SUPER_ADMIN.
   */
  async revokeGoldVerified(userId: string, adminId: string, ipAddress: string = 'internal'): Promise<{ message: string }> {
    const user = await this.findActiveUserOrThrow(userId);

    if (!user.isVip) {
      throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'User does not hold the gold verified tier' });
    }

    await this.prisma.user.update({
      where: { id: user.id },
      data: { isVip: false },
    });

    this.auditLog.logAdminAction({
      adminId,
      action: AuditAction.ADMIN_ACTION,
      targetType: 'User',
      targetId: user.id,
      description: `Admin revoked GOLD verified tier (TRUSTED_BY_KAHADE) from user ${user.id}`,
      before: { isVip: true },
      after: { isVip: false },
      ipAddress,
    });

    await this.verificationBadge.invalidate(user.id);

    return { message: 'Tier emas (Dipercaya Kahade) berhasil dicabut.' };
  }

  /**
   * Revoke tier ABU (FULLY_VERIFIED) manual oleh admin.
   * Syarat otomatis (KYC/email/HP/alamat/Kahade+) TIDAK diubah — hanya flag
   * revoke yang di-set, sehingga badge hilang sampai di-restore.
   * Admin tidak boleh me-revoke akunnya sendiri (dicek via email).
   * Hanya SUPER_ADMIN + KYC_ADMIN.
   */
  async revokeGrayVerified(
    userId: string,
    reason: string,
    adminId: string,
    adminEmail: string,
    ipAddress: string = 'internal',
  ): Promise<{ message: string }> {
    const user = await this.findActiveUserOrThrow(userId);

    if (user.email != null && user.email.toLowerCase() === adminEmail.toLowerCase()) {
      throw new ForbiddenException({ code: 'CANNOT_REVOKE_OWN_GRAY_TIER', message: 'Cannot revoke your own gray verified tier' });
    }
    if (user.grayVerifiedRevokedAt != null) {
      throw new ConflictException({ code: 'GRAY_TIER_ALREADY_REVOKED', message: 'Gray verified tier is already revoked' });
    }

    const now = new Date();
    await this.prisma.user.update({
      where: { id: user.id },
      data: {
        grayVerifiedRevokedAt: now,
        grayVerifiedRevokedBy: adminId,
        grayVerifiedRevokeReason: reason,
      },
    });

    this.auditLog.logAdminAction({
      adminId,
      action: AuditAction.ADMIN_ACTION,
      targetType: 'User',
      targetId: user.id,
      description: `Admin revoked GRAY verified tier (FULLY_VERIFIED) from user ${user.id}. Reason: ${reason}`,
      before: { grayVerifiedRevokedAt: null },
      after: { grayVerifiedRevokedAt: now.toISOString(), grayVerifiedRevokedBy: adminId, reason },
      ipAddress,
    });

    // Invalidate post-commit: badge FULLY_VERIFIED dihitung ulang.
    await this.verificationBadge.invalidate(user.id);

    return { message: 'Tier abu (Terverifikasi Penuh) berhasil dicabut.' };
  }

  /**
   * Restore tier ABU yang sebelumnya di-revoke.
   * Hanya SUPER_ADMIN + KYC_ADMIN.
   */
  async restoreGrayVerified(userId: string, adminId: string, ipAddress: string = 'internal'): Promise<{ message: string }> {
    const user = await this.findActiveUserOrThrow(userId);

    if (user.grayVerifiedRevokedAt == null) {
      throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Gray verified tier is not revoked' });
    }

    await this.prisma.user.update({
      where: { id: user.id },
      data: {
        grayVerifiedRevokedAt: null,
        grayVerifiedRevokedBy: null,
        grayVerifiedRevokeReason: null,
      },
    });

    this.auditLog.logAdminAction({
      adminId,
      action: AuditAction.ADMIN_ACTION,
      targetType: 'User',
      targetId: user.id,
      description: `Admin restored GRAY verified tier (FULLY_VERIFIED) for user ${user.id}`,
      before: { grayVerifiedRevokedAt: user.grayVerifiedRevokedAt?.toISOString() ?? null },
      after: { grayVerifiedRevokedAt: null },
      ipAddress,
    });

    await this.verificationBadge.invalidate(user.id);

    return { message: 'Tier abu (Terverifikasi Penuh) berhasil dikembalikan.' };
  }

  /**
   * Section 6 — menutup antrean moderasi tanpa sanksi.
   *
   * `flaggedForReview` hanya sinyal bahwa >= 3 reporter berbeda melaporkan user
   * ini dalam 24 jam. Dua dari tiga kemungkinan kesimpulan sudah punya jalur
   * sendiri (ban -> banUser, banding -> unbanUser); method ini untuk kesimpulan
   * ketiga: "sudah direview, tidak ada pelanggaran". Tidak ada tindakan
   * otomatis lain terhadap user — flag dihapus, audit dicatat, selesai.
   */
  async clearReviewFlag(userId: string, adminId: string, ipAddress: string = 'internal'): Promise<object> {
    const user = await this.prisma.user.findFirst({
      where: { OR: [{ id: userId }, { userId }], deletedAt: null },
      select: { id: true, userId: true, flaggedForReview: true, flaggedForReviewAt: true },
    });
    if (!user) throw new NotFoundException({ code: ErrorCodes.USER_NOT_FOUND, message: 'User not found' });
    if (!user.flaggedForReview) {
      throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'User is not flagged for review' });
    }

    // Bersyarat flaggedForReview: true -> idempoten terhadap klik ganda admin.
    const cleared = await this.prisma.user.updateMany({
      where: { id: user.id, flaggedForReview: true },
      data: { flaggedForReview: false, flaggedForReviewAt: null },
    });
    if (cleared.count === 0) {
      throw new ConflictException({ code: ErrorCodes.INVALID_STATUS, message: 'Review flag state changed; reload and retry' });
    }

    this.auditLog.logAdminAction({
      adminId,
      action: AuditAction.ADMIN_ACTION,
      targetType: 'User',
      targetId: user.id,
      description: `Admin cleared review flag for user ${user.id} (no sanction)`,
      before: { flaggedForReview: true, flaggedForReviewAt: user.flaggedForReviewAt },
      after: { flaggedForReview: false, flaggedForReviewAt: null },
      ipAddress,
    });

    return { message: 'Review flag cleared', userId: user.userId, flaggedForReview: false };
  }

  private async resolveUserId(userId: string): Promise<string> {
    const user = await this.prisma.user.findFirst({
      where: { OR: [{ id: userId }, { userId }], deletedAt: null },
      select: { id: true },
    });
    if (!user) throw new NotFoundException({ code: ErrorCodes.USER_NOT_FOUND, message: 'User not found' });
    return user.id;
  }

  async getUserOrders(userId: string, page = 1, limit = 20, status?: string, adminId?: string, ipAddress?: string): Promise<object> {
    const id = await this.resolveUserId(userId);
    if (adminId) {
      this.auditLog.logAdminAction({ adminId, action: AuditAction.ADMIN_ACTION, targetType: 'User', targetId: id, description: `Viewed user orders (page=${page})`, ipAddress: ipAddress || 'unknown' });
    }
    const safeLimit = Math.min(limit, 100);
    const skip = (page - 1) * safeLimit;

    const where: Prisma.OrderWhereInput = {
      OR: [{ buyerId: id }, { sellerId: id }],
    };
    if (status) {
      where.status = status as OrderStatus;
    }

    const [orders, total] = await Promise.all([
      this.prisma.order.findMany({
        where,
        skip,
        take: safeLimit,
        orderBy: { createdAt: 'desc' },
        select: {
          id: true, orderId: true, title: true, orderType: true,
          status: true, orderValue: true, feeAmount: true,
          buyerId: true, sellerId: true,
          createdAt: true, completedAt: true, cancelledAt: true,
        },
      }),
      this.prisma.order.count({ where }),
    ]);

    const serializedOrders = orders.map((o) => ({
      ...o,
      orderValue: toIdr(o.orderValue),
      feeAmount: toIdr(o.feeAmount),
    }));
    return createPaginatedResponse(serializedOrders, total, page, safeLimit);
  }

  /**
   * ADM-013: transaksi wallet dipaginasi (page/limit opsional; default 10,
   * maks 100). Ringkasan saldo tetap dari satu baris wallet — tidak ada
   * migrasi, hanya memecah query transaksi.
   */
  async getUserWallet(userId: string, adminId?: string, ipAddress?: string, page: number = 1, limit: number = 10): Promise<object> {
    const id = await this.resolveUserId(userId);
    if (adminId) {
      this.auditLog.logAdminAction({ adminId, action: AuditAction.ADMIN_ACTION, targetType: 'Wallet', targetId: id, description: `Viewed user wallet details (page=${page})`, ipAddress: ipAddress || 'unknown' });
    }
    const safePage = Math.max(1, page || 1);
    const safeLimit = Math.min(Math.max(1, limit || 10), 100);
    const skip = (safePage - 1) * safeLimit;

    const wallet = await this.prisma.wallet.findUnique({
      where: { userId: id },
      select: {
        id: true, availableBalance: true, escrowBalance: true, totalBalance: true,
        todayTopupAmount: true, todayWithdrawAmount: true,
        isLocked: true, lockedAt: true, lockReason: true, lockReasonCode: true,
        createdAt: true, updatedAt: true,
      },
    });

    if (!wallet) throw new NotFoundException({ code: ErrorCodes.WALLET_NOT_FOUND, message: 'User wallet not found' });

    const [transactions, txTotal] = await Promise.all([
      this.prisma.walletTransaction.findMany({
        where: { walletId: wallet.id },
        orderBy: { createdAt: 'desc' },
        skip,
        take: safeLimit,
        select: {
          id: true, txId: true, type: true, status: true,
          amount: true, balanceBefore: true, balanceAfter: true,
          description: true, createdAt: true,
        },
      }),
      this.prisma.walletTransaction.count({ where: { walletId: wallet.id } }),
    ]);

    return {
      ...wallet,
      availableBalance: toIdr(wallet.availableBalance),
      escrowBalance: toIdr(wallet.escrowBalance),
      totalBalance: toIdr(wallet.totalBalance),
      todayTopupAmount: toIdr(wallet.todayTopupAmount),
      todayWithdrawAmount: toIdr(wallet.todayWithdrawAmount),
      transactions: transactions.map((tx) => ({
        ...tx,
        // ADM-007: arah mutasi diturunkan dari `type` (amount selalu positif).
        direction: walletTxDirection(tx.type),
        amount: toIdr(tx.amount),
        balanceBefore: toIdr(tx.balanceBefore),
        balanceAfter: toIdr(tx.balanceAfter),
      })),
      transactionsMeta: {
        page: safePage,
        limit: safeLimit,
        total: txTotal,
        totalPages: Math.max(1, Math.ceil(txTotal / safeLimit)),
      },
    };
  }

  async getUserSessions(userId: string, page: number = 1, limit: number = 20, adminId?: string, ipAddress?: string): Promise<object> {
    const id = await this.resolveUserId(userId);
    if (adminId) {
      this.auditLog.logAdminAction({ adminId, action: AuditAction.ADMIN_ACTION, targetType: 'UserSession', targetId: id, description: `Viewed user sessions (page=${page})`, ipAddress: ipAddress || 'unknown' });
    }
    const safeLimit = Math.min(limit, 100);
    const skip = (page - 1) * safeLimit;

    const where = { userId: id, isRevoked: false };
    const [sessions, total] = await Promise.all([
      this.prisma.userSession.findMany({
        where,
        orderBy: { lastActiveAt: 'desc' },
        skip,
        take: safeLimit,
        select: {
          id: true, deviceInfo: true, ipAddress: true,
          lastActiveAt: true, expiresAt: true, createdAt: true,
        },
      }),
      this.prisma.userSession.count({ where }),
    ]);

    return createPaginatedResponse(sessions, total, page, safeLimit);
  }

  async adjustWallet(userId: string, dto: WalletAdjustDto, adminId: string, ipAddress: string = 'internal'): Promise<{ txId: string; type: string; amount: number; reason: string; balanceAfter: number }> {
    const id = await this.resolveUserId(userId);

    const amountInSen = toSen(dto.amount);
    const isCredit = dto.type === WalletAdjustType.CREDIT;
    const txType = isCredit ? WalletTransactionType.ADMIN_CREDIT : WalletTransactionType.ADMIN_DEBIT;

    // Serial generated before the transaction to avoid Redis incr gaps on rollback.
    const serial = await this.walletTxSerial.getNext();
    const txId = generateWalletTxId(serial);

    let balanceBefore!: bigint;
    let balanceAfter!: bigint;
    let walletId!: string;

    await this.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      const wallet = await tx.wallet.findUnique({ where: { userId: id } });
      if (!wallet) throw new NotFoundException({ code: ErrorCodes.WALLET_NOT_FOUND, message: 'User wallet not found' });

      if (wallet.isLocked) {
        throw new BadRequestException({ code: ErrorCodes.WALLET_LOCKED, message: `Wallet is locked${wallet.lockReason ? `: ${wallet.lockReason}` : ''}. Unlock the wallet before adjusting.` });
      }

      if (!isCredit && wallet.availableBalance < amountInSen) {
        throw new BadRequestException({ code: ErrorCodes.INSUFFICIENT_BALANCE, message: 'Insufficient available balance for debit' });
      }

      balanceBefore = wallet.availableBalance;
      balanceAfter = isCredit ? wallet.availableBalance + amountInSen : wallet.availableBalance - amountInSen;
      walletId = wallet.id;

      const updated = await tx.wallet.updateMany({
        where: { id: wallet.id, version: wallet.version },
        data: {
          availableBalance: balanceAfter,
          totalBalance: isCredit ? wallet.totalBalance + amountInSen : wallet.totalBalance - amountInSen,
          version: { increment: 1 },
        },
      });

      if (updated.count === 0) {
        throw new ConflictException({ code: ErrorCodes.OPTIMISTIC_LOCK_CONFLICT, message: 'Concurrent wallet update detected, please retry' });
      }

      await tx.walletTransaction.create({
        data: {
          txId,
          walletId: wallet.id,
          type: txType,
          status: WalletTransactionStatus.SUCCESS,
          amount: amountInSen,
          balanceBefore,
          balanceAfter,
          description: `Admin ${dto.type.toLowerCase()}: ${dto.reason}`,
          completedAt: new Date(),
        },
      });

      const notifType = isCredit ? NotificationType.WALLET_TOPUP_SUCCESS : NotificationType.WALLET_WITHDRAW_SUCCESS;
      await tx.notification.create({
        data: {
          notifId: generateNotifId(),
          userId: id,
          type: notifType,
          category: getCategoryForType(notifType),
          title: isCredit ? 'Balance Credited by Admin' : 'Balance Debited by Admin',
          body: isCredit
            ? `Rp ${dto.amount.toLocaleString('id-ID')} has been added to your wallet balance. Reason: ${dto.reason}`
            : `Rp ${dto.amount.toLocaleString('id-ID')} has been deducted from your wallet balance. Reason: ${dto.reason}`,
          isRead: false,
        },
      });

    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });

    const notifTitle = isCredit ? 'Balance Credited by Admin' : 'Balance Debited by Admin';
    const notifBody = isCredit
      ? `Rp ${dto.amount.toLocaleString('id-ID')} has been added to your wallet balance. Reason: ${dto.reason}`
      : `Rp ${dto.amount.toLocaleString('id-ID')} has been deducted from your wallet balance. Reason: ${dto.reason}`;
    this.prisma.emitNotificationCreated({ userId: id, title: notifTitle, body: notifBody, data: { type: 'WALLET_ADJUSTED' } });

    const auditAction = isCredit ? AuditAction.WALLET_CREDIT : AuditAction.WALLET_DEBIT;
    this.auditLog.logAdminAction({
      adminId,
      action: auditAction,
      targetType: 'Wallet',
      targetId: walletId,
      description: `Admin ${dto.type.toLowerCase()} ${dto.amount} IDR to user ${id}. Reason: ${dto.reason}`,
      before: { availableBalance: balanceBefore.toString() },
      after: { availableBalance: balanceAfter.toString() },
      ipAddress,
    });

    // AW-018: totalWalletBalance di summary dashboard berubah.
    await this.dashboard.invalidateSummaryCache();

    return { txId, type: dto.type, amount: dto.amount, reason: dto.reason, balanceAfter: toIdr(balanceAfter) };
  }

  async getUserAuditLog(userId: string, page = 1, limit = 20, adminId?: string, ipAddress?: string): Promise<object> {
    const id = await this.resolveUserId(userId);
    if (adminId) {
      this.auditLog.logAdminAction({ adminId, action: AuditAction.AUDIT_LOG_VIEWED, targetType: 'AuditLog', targetId: id, description: `Viewed user audit log (page=${page})`, ipAddress: ipAddress || 'unknown' });
    }
    const safeLimit = Math.min(limit, 100);
    const skip = (page - 1) * safeLimit;

    const [logs, total] = await Promise.all([
      this.prisma.auditLog.findMany({
        where: { userId: id },
        skip,
        take: safeLimit,
        orderBy: { createdAt: 'desc' },
        select: {
          id: true, action: true, entityType: true, entityId: true,
          description: true, ipAddress: true, createdAt: true,
        },
      }),
      this.prisma.auditLog.count({ where: { userId: id } }),
    ]);

    return createPaginatedResponse(logs, total, page, safeLimit);
  }

  async forceLogout(userId: string, adminId: string, ipAddress: string = 'internal'): Promise<{ message: string; revokedCount: number }> {
    const id = await this.resolveUserId(userId);
    const now = new Date();

    const activeSessions = await this.prisma.userSession.findMany({
      where: { userId: id, isRevoked: false },
      select: { id: true },
    });

    if (activeSessions.length === 0) {
      return { message: 'No active sessions found', revokedCount: 0 };
    }

    await this.prisma.userSession.updateMany({
      where: { userId: id, isRevoked: false },
      data: { isRevoked: true, revokedAt: now, revokedReason: 'admin_force_logout' },
    });

    await Promise.all(
      activeSessions.map((s) =>
        this.redis.setex(SESSION_REVOKED_KEY(s.id), this.accessTokenTtlSeconds, 'revoked').catch((error: unknown) => {
          // DB revocation above is durable and is checked by JwtAuthGuard. Redis is
          // only an acceleration layer here; do not report a successful force logout
          // as failed merely because cache propagation is temporarily unavailable.
          this.logger.warn(`Admin force logout Redis propagation failed for session ${s.id}: ${error instanceof Error ? error.message : String(error)}`);
        }),
      ),
    );

    this.auditLog.logAdminAction({
      adminId,
      action: AuditAction.ADMIN_ACTION,
      targetType: 'User',
      targetId: id,
      description: `Admin force-logged out user ${id}. ${activeSessions.length} session(s) revoked.`,
      ipAddress,
    });

    return { message: 'All sessions revoked', revokedCount: activeSessions.length };
  }

  async revokeUserSession(userId: string, sessionId: string, adminId: string, ipAddress: string = 'internal'): Promise<{ message: string }> {
    const id = await this.resolveUserId(userId);

    const session = await this.prisma.userSession.findFirst({
      where: { id: sessionId, userId: id, isRevoked: false },
    });

    if (!session) {
      throw new NotFoundException({ code: ErrorCodes.SESSION_NOT_FOUND, message: 'Active session not found for this user' });
    }

    await this.prisma.userSession.update({
      where: { id: sessionId },
      data: { isRevoked: true, revokedAt: new Date(), revokedReason: 'admin_revoke_session' },
    });

    await this.redis.setex(SESSION_REVOKED_KEY(sessionId), this.accessTokenTtlSeconds, 'revoked').catch((error: unknown) => {
      // The session is already revoked durably in PostgreSQL and JwtAuthGuard
      // checks that record. Redis propagation is best-effort acceleration only.
      this.logger.warn(`Admin session Redis propagation failed for ${sessionId}: ${error instanceof Error ? error.message : String(error)}`);
    });

    this.auditLog.logAdminAction({
      adminId,
      action: AuditAction.ADMIN_ACTION,
      targetType: 'UserSession',
      targetId: sessionId,
      description: `Admin revoked session ${sessionId} for user ${id}`,
      ipAddress,
    });

    return { message: 'Session revoked' };
  }

  async resetUserPassword(userId: string, adminId: string, ipAddress: string = 'internal'): Promise<{ message: string }> {
    const id = await this.resolveUserId(userId);

    const user = await this.prisma.user.findUnique({
      where: { id },
      select: { id: true, email: true, isActive: true, isBanned: true },
    });

    if (!user) {
      throw new NotFoundException({ code: ErrorCodes.USER_NOT_FOUND, message: 'User not found' });
    }
    if (!user.isActive || user.isBanned) {
      throw new BadRequestException({ code: ErrorCodes.ACCOUNT_INACTIVE, message: 'Cannot reset password for inactive or banned account' });
    }

    // Phone-only accounts (phoneRegister) have no email. The old `user.email ?? ''`
    // fallback made every emailless account share the '' OTP bucket (see auth.service
    // requestDisable2faOtp for full explanation) and sent mail to '', a silent dead end.
    // Admin-initiated resets need email delivery; reject explicitly if none exists.
    if (!user.email) {
      throw new BadRequestException({
        code: 'EMAIL_NOT_CONFIGURED',
        message: 'User has no email address on file — cannot send password reset.',
      });
    }

    await this.otpService.invalidateOtps(user.email, OtpType.PASSWORD_RESET);
    const otp = await this.otpService.generateOtp(user.email, OtpType.PASSWORD_RESET, user.id);

    await this.emailQueue.add('send', {
      to: user.email,
      subject: 'Kahade - Reset Password (Admin Request)',
      templateName: 'admin-password-reset',
      templateContext: { otp },
    }, { attempts: 3, backoff: { type: 'exponential', delay: 5000 } });

    this.auditLog.logAdminAction({
      adminId,
      action: AuditAction.ADMIN_ACTION,
      targetType: 'User',
      targetId: id,
      description: `Admin triggered password reset OTP for user ${id}`,
      ipAddress,
    });

    return { message: 'Password reset email sent to user' };
  }

  // ADM-401/ADM-407: impersonateUser DIHAPUS total (2026-09-27).
  // Token impersonate sebelumnya unsigned & guessable (`imp_<adminId>_<userId>_<timestamp>`)
  // dan fragmennya ditulis ke audit log. Kedua pola dilarang di produk keuangan:
  // jangan pernah menulis material mirip kredensial ke audit log.

  // ══════════════════════════════════════════════════════════════
  // GAP-E — Timeline moderasi pengguna
  // GET /v1/admin/users/:userId/moderation-events
  //
  // Menggabungkan 4 sumber menjadi satu timeline terurut menurun:
  //  1. AdminAuditLog (targetType User) — aksi admin atas user ini
  //     (termasuk ban/unban via USER_BANNED/USER_RESTORED).
  //  2. KycRequest yang sudah diputus — keputusan KYC (admin).
  //  3. UserReport yang sudah direview — resolusi laporan (admin).
  //  4. Flag agregasi laporan — sinyal OTOMATIS (source 'system').
  // Catatan internal KYC (adminNotes) disembunyikan dari CUSTOMER_SUPPORT.
  // ══════════════════════════════════════════════════════════════

  /** Role yang boleh melihat catatan internal moderasi (semua kecuali support biasa). */
  private static readonly INTERNAL_NOTES_ALLOWED_ROLES = [
    'SUPER_ADMIN',
    'DISPUTE_ADMIN',
    'KYC_ADMIN',
    'FINANCE_ADMIN',
  ];

  private static readonly MODERATION_TIMELINE_LIMIT = 200;

  async listModerationEvents(
    userId: string,
    query: ModerationEventsQueryDto,
    requesterRole: string,
    adminId?: string,
    ipAddress?: string,
  ): Promise<object> {
    const id = await this.resolveUserId(userId);
    if (adminId) {
      this.auditLog.logAdminAction({
        adminId,
        action: AuditAction.ADMIN_ACTION,
        targetType: 'User',
        targetId: id,
        description: `Viewed moderation timeline for user ${id}`,
        ipAddress: ipAddress || 'unknown',
      });
    }

    const canSeeInternalNotes = AdminUsersService.INTERNAL_NOTES_ALLOWED_ROLES.includes(requesterRole);
    const eventFilter = query.event;
    // ADM-005: filter sumber event yang dikirim UI (sebelumnya diabaikan).
    const kindFilter = query.kind;
    const kindOk = (source: 'system' | 'admin'): boolean =>
      !kindFilter || source === kindFilter;
    const actorFilter = query.actor;
    const from = query.from ? new Date(query.from) : undefined;
    const to = query.to ? new Date(query.to) : undefined;
    // BAI-061/BAI-073: paginasi nyata — page/limit dari DTO dipatuhi, bukan
    // selalu 200 pertama. limit di-cap 100 oleh PaginationDto.
    const page = query.page ?? 1;
    const safePage = Number.isFinite(page) ? Math.max(1, Math.floor(page)) : 1;
    const limit = query.limit ?? 20;
    const safeLimit = Number.isFinite(limit) ? Math.min(100, Math.max(1, Math.floor(limit))) : 20;
    const skip = (safePage - 1) * safeLimit;

    const inRange = (d: Date): boolean =>
      (!from || d >= from) && (!to || d <= to);
    const actorOk = (actorId: string | null | undefined): boolean =>
      !actorFilter || actorId === actorFilter;

    type TimelineEvent = {
      id: string;
      type: ModerationEventType;
      source: 'system' | 'admin';
      title: string;
      description: string | null;
      actor: { id: string; name: string | null; role: string | null } | null;
      createdAt: Date;
      internalNote?: string;
      internalNoteHidden?: boolean;
      metadata?: Record<string, unknown>;
    };
    const events: TimelineEvent[] = [];

    // 1. AdminAuditLog atas user ini.
    const auditWhere: Prisma.AdminAuditLogWhereInput = {
      targetId: id,
      targetType: { in: ['User', 'user'] },
    };
    if (actorFilter) auditWhere.adminId = actorFilter;
    if (from || to) {
      auditWhere.createdAt = {};
      if (from) (auditWhere.createdAt as Prisma.DateTimeFilter).gte = from;
      if (to) (auditWhere.createdAt as Prisma.DateTimeFilter).lte = to;
    }
    const auditLogs = await this.prisma.adminAuditLog.findMany({
      where: auditWhere,
      orderBy: { createdAt: 'desc' },
      take: AdminUsersService.MODERATION_TIMELINE_LIMIT,
      include: { admin: { select: { id: true, fullName: true, role: true } } },
    });
    for (const log of auditLogs) {
      let type: ModerationEventType = 'admin_action';
      let title: string = log.action;
      if (log.action === AuditAction.USER_BANNED) { type = 'ban'; title = 'Pengguna diblokir'; }
      else if (log.action === AuditAction.USER_RESTORED) { type = 'unban'; title = 'Blokir dibuka'; }
      if (eventFilter && type !== eventFilter) continue;
      events.push({
        id: `audit:${log.id}`,
        type,
        source: 'admin',
        title,
        description: log.description,
        actor: log.admin ? { id: log.admin.id, name: log.admin.fullName, role: log.admin.role } : null,
        createdAt: log.createdAt,
        metadata: { action: log.action },
      });
    }

    // 2. Keputusan KYC.
    if (!eventFilter || eventFilter === 'kyc_decision') {
      const kycDecisions = await this.prisma.kycRequest.findMany({
        where: { userId: id, reviewedAt: { not: null } },
        orderBy: { reviewedAt: 'desc' },
        take: 50,
        select: {
          id: true, kycId: true, status: true, reviewedAt: true,
          rejectionReason: true, adminNotes: true,
          reviewer: { select: { id: true, fullName: true, role: true } },
        },
      });
      for (const k of kycDecisions) {
        if (!k.reviewedAt || !inRange(k.reviewedAt)) continue;
        if (!actorOk(k.reviewer?.id)) continue;
        const approved = k.status === 'APPROVED';
        events.push({
          id: `kyc:${k.id}`,
          type: 'kyc_decision',
          source: 'admin',
          title: approved ? 'KYC disetujui' : `KYC ${k.status.toLowerCase()}`,
          description: k.rejectionReason ?? null,
          actor: k.reviewer ? { id: k.reviewer.id, name: k.reviewer.fullName, role: k.reviewer.role } : null,
          createdAt: k.reviewedAt,
          ...(canSeeInternalNotes && k.adminNotes
            ? { internalNote: k.adminNotes }
            : k.adminNotes
              ? { internalNoteHidden: true }
              : {}),
          metadata: { kycId: k.kycId, status: k.status },
        });
      }
    }

    // 3. Resolusi laporan.
    if (!eventFilter || eventFilter === 'report_resolved') {
      const reports = await this.prisma.userReport.findMany({
        where: { targetId: id, reviewedAt: { not: null } },
        orderBy: { reviewedAt: 'desc' },
        take: 50,
        select: {
          id: true, category: true, status: true, reviewedAt: true,
          resolution: true,
        },
      });
      // reviewedBy adalah soft FK (String) — ambil info admin terpisah bila ada.
      const reviewerIds = [...new Set(reports.map((r) => (r as unknown as { reviewedBy: string | null }).reviewedBy).filter(Boolean))] as string[];
      const reviewers = reviewerIds.length > 0
        ? await this.prisma.adminUser.findMany({
            where: { id: { in: reviewerIds } },
            select: { id: true, fullName: true, role: true },
          })
        : [];
      const reviewerById = new Map(reviewers.map((r) => [r.id, r]));
      for (const r of reports) {
        if (!r.reviewedAt || !inRange(r.reviewedAt)) continue;
        const rb = (r as unknown as { reviewedBy: string | null }).reviewedBy;
        if (!actorOk(rb)) continue;
        const reviewer = rb ? reviewerById.get(rb) : undefined;
        events.push({
          id: `report:${r.id}`,
          type: 'report_resolved',
          source: 'admin',
          title: `Laporan diselesaikan (${r.status})`,
          description: r.resolution ?? null,
          actor: reviewer ? { id: reviewer.id, name: reviewer.fullName, role: reviewer.role } : null,
          createdAt: r.reviewedAt,
          metadata: { category: r.category, reportId: r.id },
        });
      }
    }

    // 4. Flag agregasi laporan — sinyal otomatis (system).
    if (!eventFilter || eventFilter === 'flag_raised' || eventFilter === 'flag_cleared') {
      const user = await this.prisma.user.findUnique({
        where: { id },
        select: { flaggedForReview: true, flaggedForReviewAt: true },
      });
      if (user?.flaggedForReview && user.flaggedForReviewAt && inRange(user.flaggedForReviewAt)) {
        if ((!eventFilter || eventFilter === 'flag_raised') && actorOk(null)) {
          events.push({
            id: `flag:${id}`,
            type: 'flag_raised',
            source: 'system',
            title: 'Ditandai untuk review (otomatis)',
            description: '≥ 3 pengguna berbeda melaporkan akun ini dalam 24 jam. Bukan sanksi — menunggu review admin.',
            actor: null,
            createdAt: user.flaggedForReviewAt,
          });
        }
      }
    }

    events.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    // ADM-005: filter sumber event (system/admin) — diterapkan setelah merge.
    const kindFiltered = kindFilter ? events.filter((e) => kindOk(e.source)) : events;
    // BAI-061/BAI-073: paginasi nyata atas timeline gabungan. Sumber
    // di-fetch bounded (audit ≤200 terbaru, KYC ≤50, laporan ≤50) sehingga
    // total mencerminkan seluruh event dalam batas tersebut; halaman >1
    // mengembalikan data yang berbeda dari halaman 1.
    const total = kindFiltered.length;
    const pageData = kindFiltered.slice(skip, skip + safeLimit);
    return createPaginatedResponse(pageData, total, safePage, safeLimit);
  }

  // ══════════════════════════════════════════════════════════════
  // GAP-E (G380) — Ekspor CSV pengguna yang diperkuat
  //
  // - `reason` WAJIB → dicatat di UserExportAudit + AdminAuditLog.
  // - `columns` opsional (whitelist); default kolom minimal.
  // - `mask` default true; unmask hanya untuk role allowlist.
  // - Dataset > 5000 baris → 202 + jobId; hasil di storage privat +
  //   signed URL 15 menit (pola sama seperti ekspor akun ST-019).
  // ══════════════════════════════════════════════════════════════

  private static readonly EXPORTABLE_COLUMNS = [
    'userId', 'username', 'fullName', 'email', 'phoneNumber', 'status',
    'kycStatus', 'isBanned', 'banReason', 'emailVerified', 'phoneVerified',
    'isActive', 'isKahadePlus', 'membershipRank', 'averageRating',
    'totalOrdersAsBuyer', 'totalOrdersAsSeller', 'totalOrdersCompleted',
    'createdAt', 'lastLoginAt',
  ] as const;

  private static readonly DEFAULT_EXPORT_COLUMNS = [
    'userId', 'username', 'status', 'kycStatus', 'createdAt',
  ];

  /** Ambang async: di atas ini ekspor berjalan di latar (202 + jobId). */
  private static readonly EXPORT_ASYNC_THRESHOLD = 5000;
  private static readonly EXPORT_BATCH_SIZE = 1000;
  private static readonly EXPORT_JOB_TTL_SECONDS = 2 * 60 * 60;
  private static readonly EXPORT_JOB_KEY = (jobId: string): string => `admin_user_export_job:${jobId}`;
  /** Signed URL unduhan hasil ekspor: 15 menit. */
  private static readonly EXPORT_DOWNLOAD_TTL_SECONDS = 900;

  private parseExportColumns(columns?: string): string[] {
    if (!columns || !columns.trim()) return [...AdminUsersService.DEFAULT_EXPORT_COLUMNS];
    const parsed = columns.split(',').map((c) => c.trim()).filter(Boolean);
    const unknown = parsed.filter((c) => !(AdminUsersService.EXPORTABLE_COLUMNS as readonly string[]).includes(c));
    if (unknown.length > 0) {
      throw new BadRequestException({
        code: ErrorCodes.VALIDATION_ERROR,
        message: `Unknown export columns: ${unknown.join(', ')}. Allowed: ${AdminUsersService.EXPORTABLE_COLUMNS.join(', ')}`,
      });
    }
    return [...new Set(parsed)];
  }

  private escapeCsvCell(value: unknown): string {
    if (value === null || value === undefined) return '';
    const s = String(value);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }

  private async buildExportRow(
    u: {
      userId: string; username: string | null; fullName: string | null; email: string | null;
      phoneNumber: string | null; isBanned: boolean; banReason: string | null; kycStatus: unknown;
      emailVerified: boolean; phoneVerified: boolean; isActive: boolean; isKahadePlus: boolean | null;
      membershipRank: string | null; averageRating: { toNumber(): number } | number | null;
      totalOrdersAsBuyer: number; totalOrdersAsSeller: number; totalOrdersCompleted: number;
      createdAt: Date; lastLoginAt: Date | null;
    },
    columns: string[],
    adminRole: string,
    mask: boolean,
  ): Promise<string[]> {
    const decryptedPhone = await decryptPiiSafe(u.phoneNumber);
    const masked = applyUserMask(adminRole, { email: u.email, phoneNumber: decryptedPhone });
    const email = mask ? masked.email : u.email;
    const phone = mask ? masked.phoneNumber : decryptedPhone;
    const values: Record<string, unknown> = {
      userId: u.userId,
      username: u.username,
      fullName: u.fullName,
      email,
      phoneNumber: phone,
      status: u.isBanned ? 'banned' : 'active',
      kycStatus: u.kycStatus,
      isBanned: u.isBanned,
      banReason: u.banReason,
      emailVerified: u.emailVerified,
      phoneVerified: u.phoneVerified,
      isActive: u.isActive,
      isKahadePlus: u.isKahadePlus,
      membershipRank: u.membershipRank,
      averageRating: typeof u.averageRating === 'number' ? u.averageRating : u.averageRating?.toNumber() ?? null,
      totalOrdersAsBuyer: u.totalOrdersAsBuyer,
      totalOrdersAsSeller: u.totalOrdersAsSeller,
      totalOrdersCompleted: u.totalOrdersCompleted,
      createdAt: u.createdAt?.toISOString(),
      lastLoginAt: u.lastLoginAt?.toISOString() ?? null,
    };
    return columns.map((c) => this.escapeCsvCell(values[c]));
  }

  private async writeExportAudit(
    adminId: string,
    dto: UserExportQueryDto,
    columns: string[],
    rowCount: number,
    ipAddress: string,
    jobId?: string,
  ): Promise<void> {
    await this.prisma.userExportAudit.create({
      data: {
        adminId,
        filters: { search: dto.search ?? null, status: dto.status ?? null } as Prisma.InputJsonValue,
        columns,
        rowCount,
        reason: dto.reason,
      },
    });
    this.auditLog.logAdminAction({
      adminId,
      action: AuditAction.USER_EXPORTED,
      targetType: 'User',
      targetId: jobId ?? 'bulk',
      description: `Admin exported ${rowCount} user(s) to CSV. Reason: ${dto.reason}${jobId ? ` (async job ${jobId})` : ''}`,
      after: { rowCount, columns, filters: { search: dto.search ?? null, status: dto.status ?? null }, jobId: jobId ?? null },
      ipAddress,
    });
  }

  async exportUsersCsv(
    dto: UserExportQueryDto,
    adminRole: string,
    adminId: string,
    ipAddress: string,
  ): Promise<
    | { kind: 'sync'; csv: string; filename: string; rowCount: number }
    | { kind: 'async'; jobId: string; rowCount: number }
  > {
    const columns = this.parseExportColumns(dto.columns);
    const mask = dto.mask !== false;
    if (!mask && !PII_UNMASKED_ROLES.includes(adminRole)) {
      throw new ForbiddenException({
        code: ErrorCodes.INSUFFICIENT_ADMIN_ROLE,
        message: 'Unmasked export is restricted to SUPER_ADMIN',
      });
    }

    const where = this.buildUserWhere(dto.search, dto.status);
    const rowCount = await this.prisma.user.count({ where });

    if (rowCount > AdminUsersService.EXPORT_ASYNC_THRESHOLD) {
      const jobId = randomUUID();
      const job = {
        status: 'pending',
        adminId,
        adminRole,
        reason: dto.reason,
        columns,
        mask,
        filters: { search: dto.search ?? null, status: dto.status ?? null },
        rowCount,
        createdAt: new Date().toISOString(),
      };
      await this.redis.setex(
        AdminUsersService.EXPORT_JOB_KEY(jobId),
        AdminUsersService.EXPORT_JOB_TTL_SECONDS,
        JSON.stringify(job),
        { throwOnError: true },
      );
      await this.writeExportAudit(adminId, dto, columns, rowCount, ipAddress, jobId);
      // Latar: jangan blok respons 202. Kegagalan dicatat di status job.
      void this.runExportJobInBackground(jobId, job).catch((err: unknown) => {
        this.logger.error(`Export job ${jobId} crashed: ${err instanceof Error ? err.message : String(err)}`);
      });
      return { kind: 'async', jobId, rowCount };
    }

    // Jalur sinkron (≤ 5000 baris): bangun CSV langsung.
    const header = columns.join(',');
    const lines: string[] = [header];
    let skip = 0;
    for (;;) {
      const batch = await this.prisma.user.findMany({
        where,
        skip,
        take: AdminUsersService.EXPORT_BATCH_SIZE,
        orderBy: { createdAt: 'asc' },
        select: {
          userId: true, username: true, fullName: true, email: true, phoneNumber: true,
          isBanned: true, banReason: true, kycStatus: true,
          emailVerified: true, phoneVerified: true, isActive: true, isKahadePlus: true,
          membershipRank: true, averageRating: true,
          totalOrdersAsBuyer: true, totalOrdersAsSeller: true, totalOrdersCompleted: true,
          createdAt: true, lastLoginAt: true,
        },
      });
      if (batch.length === 0) break;
      for (const u of batch) {
        lines.push((await this.buildExportRow(u, columns, adminRole, mask)).join(','));
      }
      skip += batch.length;
      if (batch.length < AdminUsersService.EXPORT_BATCH_SIZE) break;
    }

    await this.writeExportAudit(adminId, dto, columns, rowCount, ipAddress);
    const stamp = new Date().toISOString().slice(0, 10);
    return {
      kind: 'sync',
      // ADM-429: watermark pengekspor di baris awal CSV untuk keterlacakan kebocoran.
      csv: withCsvExportWatermark('\uFEFF' + lines.join('\n'), adminId, 'admin/users/export'),
      filename: `kahade-users-${stamp}.csv`,
      rowCount,
    };
  }

  /** Pekerja latar untuk ekspor async: batch → CSV → enkripsi → storage privat. */
  private async runExportJobInBackground(
    jobId: string,
    job: {
      adminId: string; adminRole: string; columns: string[]; mask: boolean;
      filters: { search: string | null; status: string | null }; rowCount: number;
    },
  ): Promise<void> {
    const key = AdminUsersService.EXPORT_JOB_KEY(jobId);
    const fail = async (message: string): Promise<void> => {
      await this.redis.setex(
        key,
        AdminUsersService.EXPORT_JOB_TTL_SECONDS,
        JSON.stringify({ ...job, status: 'failed', error: message, finishedAt: new Date().toISOString() }),
        { throwOnError: false },
      );
    };
    try {
      const where = this.buildUserWhere(job.filters.search ?? undefined, job.filters.status ?? undefined);
      const lines: string[] = [job.columns.join(',')];
      let skip = 0;
      for (;;) {
        const batch = await this.prisma.user.findMany({
          where,
          skip,
          take: AdminUsersService.EXPORT_BATCH_SIZE,
          orderBy: { createdAt: 'asc' },
          select: {
            userId: true, username: true, fullName: true, email: true, phoneNumber: true,
            isBanned: true, banReason: true, kycStatus: true,
            emailVerified: true, phoneVerified: true, isActive: true, isKahadePlus: true,
            membershipRank: true, averageRating: true,
            totalOrdersAsBuyer: true, totalOrdersAsSeller: true, totalOrdersCompleted: true,
            createdAt: true, lastLoginAt: true,
          },
        });
        if (batch.length === 0) break;
        for (const u of batch) {
          lines.push((await this.buildExportRow(u, job.columns, job.adminRole, job.mask)).join(','));
        }
        skip += batch.length;
        // Update progres agar UI bisa menampilkan persentase.
        await this.redis.setex(
          key,
          AdminUsersService.EXPORT_JOB_TTL_SECONDS,
          JSON.stringify({ ...job, status: 'processing', processed: skip, rowCount: job.rowCount }),
          { throwOnError: false },
        );
        if (batch.length < AdminUsersService.EXPORT_BATCH_SIZE) break;
      }

      // ADM-429: watermark pengekspor di baris awal CSV untuk keterlacakan kebocoran.
      const csv = withCsvExportWatermark('\uFEFF' + lines.join('\n'), job.adminId, 'admin/users/export');
      // ST-019: enkripsi at-rest, pola sama seperti ekspor akun.
      const encrypted = await encryptAES(Buffer.from(csv, 'utf-8').toString('base64'));
      const fileKey = `uploads/admin-exports/${job.adminId}/${jobId}.csv`;
      await this.localStorage.saveFile(fileKey, Buffer.from(encrypted, 'utf-8'));

      await this.redis.setex(
        key,
        AdminUsersService.EXPORT_JOB_TTL_SECONDS,
        JSON.stringify({ ...job, status: 'ready', processed: skip, fileKey, finishedAt: new Date().toISOString() }),
        { throwOnError: false },
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`Export job ${jobId} failed: ${message}`);
      await fail(message);
    }
  }

  /** Poll status job ekspor async. Signed URL 15 menit dibuat saat poll (fresh). */
  async getExportJobStatus(jobId: string, adminId: string): Promise<object> {
    const raw = await this.redis.get(AdminUsersService.EXPORT_JOB_KEY(jobId), { throwOnError: true });
    if (!raw) {
      throw new NotFoundException({ code: 'EXPORT_JOB_NOT_FOUND', message: 'Export job not found or expired' });
    }
    let job: Record<string, unknown>;
    try {
      job = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      throw new NotFoundException({ code: 'EXPORT_JOB_NOT_FOUND', message: 'Export job not found or expired' });
    }
    if (job.adminId !== adminId) {
      throw new ForbiddenException({ code: ErrorCodes.FORBIDDEN, message: 'Export job belongs to another admin' });
    }
    if (job.status === 'ready' && typeof job.fileKey === 'string') {
      const downloadUrl = await this.uploadService.generateDownloadUrl(
        job.fileKey,
        AdminUsersService.EXPORT_DOWNLOAD_TTL_SECONDS,
      );
      return {
        jobId,
        status: 'ready',
        rowCount: job.rowCount,
        processed: job.processed,
        downloadUrl,
        expiresIn: AdminUsersService.EXPORT_DOWNLOAD_TTL_SECONDS,
        finishedAt: job.finishedAt,
      };
    }
    return {
      jobId,
      status: job.status,
      rowCount: job.rowCount,
      processed: job.processed ?? 0,
      error: job.error ?? null,
      finishedAt: job.finishedAt ?? null,
    };
  }

  // ─────────────────────────────────────────────────────────────────
  // GAP-A (G067): status penghapusan akun + legal hold.
  // Data yang wajib ditahan (sengketa/retensi hukum) dipisahkan dari data
  // yang akan dipurge: request ON_HOLD tidak diproses purge worker.
  // ─────────────────────────────────────────────────────────────────

  /**
   * Lihat permintaan penghapusan akun terbaru user + riwayat status
   * (read-only untuk audit admin).
   */
  async getDeletionStatus(userId: string): Promise<object> {
    // G071: user dalam masa tenggang sudah soft-deleted — lookup menyertakan mereka.
    const user = await this.findUserIncludingDeletedOrThrow(userId);
    const request = await this.prisma.accountDeletionRequest.findFirst({
      where: { userId: user.id },
      orderBy: { requestedAt: 'desc' },
      include: {
        history: { orderBy: { createdAt: 'asc' } },
      },
    });
    if (!request) {
      return { userId: user.id, request: null, history: [] };
    }
    return { userId: user.id, request, history: request.history };
  }

  /**
   * Lookup user TANPA filter deletedAt — untuk alur penghapusan akun:
   * user dengan request penghapusan aktif SUDAH soft-deleted (deletedAt
   * terisi, isActive=false), jadi findActiveUserOrThrow selalu 404
   * untuk mereka (GAP-A G071). Dipakai legal hold/release.
   */
  private async findUserIncludingDeletedOrThrow(userId: string) {
    const user = await this.prisma.user.findFirst({
      where: { OR: [{ id: userId }, { userId }] },
      select: { id: true, userId: true, email: true },
    });
    if (!user) throw new NotFoundException({ code: ErrorCodes.USER_NOT_FOUND, message: 'User not found' });
    return user;
  }

  /**
   * Tahan penghapusan karena sengketa/retensi hukum (ON_HOLD).
   * Purge worker melewati request ON_HOLD (G056).
   */
  async placeDeletionLegalHold(
    userId: string,
    reason: string,
    adminId: string,
    ipAddress: string = 'internal',
  ): Promise<object> {
    // G071: user dalam masa tenggang sudah soft-deleted — jangan pakai
    // findActiveUserOrThrow (deletedAt: null) yang selalu 404 untuk mereka.
    const user = await this.findUserIncludingDeletedOrThrow(userId);
    if (!reason?.trim()) {
      throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Alasan legal hold wajib diisi.' });
    }
    const request = await this.prisma.accountDeletionRequest.findFirst({
      where: {
        userId: user.id,
        status: { in: [DeletionRequestStatus.REQUESTED, DeletionRequestStatus.PENDING] },
      },
      orderBy: { requestedAt: 'desc' },
    });
    if (!request) {
      throw new NotFoundException({
        code: ErrorCodes.DELETION_REQUEST_NOT_FOUND,
        message: 'Tidak ada permintaan penghapusan aktif untuk user ini.',
      });
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      const fresh = await tx.accountDeletionRequest.findUnique({ where: { id: request.id } });
      if (!fresh || (fresh.status !== DeletionRequestStatus.REQUESTED && fresh.status !== DeletionRequestStatus.PENDING)) {
        throw new ConflictException({
          code: ErrorCodes.DELETION_REQUEST_NOT_ACTIVE,
          message: 'Status permintaan berubah; muat ulang dan coba lagi.',
        });
      }
      const next = await tx.accountDeletionRequest.update({
        where: { id: request.id },
        data: { status: DeletionRequestStatus.ON_HOLD, legalHoldReason: reason.trim().slice(0, 500) },
      });
      await tx.accountDeletionStatusHistory.create({
        data: {
          requestId: request.id,
          fromStatus: fresh.status,
          toStatus: DeletionRequestStatus.ON_HOLD,
          actorType: 'ADMIN',
          actorUserId: adminId,
          reason: reason.trim().slice(0, 500),
        },
      });
      return next;
    });

    this.auditLog.logAdminAction({
      adminId,
      action: AuditAction.ADMIN_ACTION,
      targetType: 'AccountDeletionRequest',
      targetId: request.id,
      description: `Admin placed legal hold on deletion request ${request.referenceCode}. Reason: ${reason.trim().slice(0, 200)}`,
      before: { status: request.status },
      after: { status: DeletionRequestStatus.ON_HOLD, legalHoldReason: reason.trim().slice(0, 500) },
      ipAddress,
    });

    return updated;
  }

  /**
   * Lepaskan legal hold — request kembali aktif (REQUESTED) dengan purgeAt
   * yang sama; riwayat mencatat pelepasan oleh admin.
   */
  async releaseDeletionLegalHold(
    userId: string,
    adminId: string,
    ipAddress: string = 'internal',
  ): Promise<object> {
    // G071: lihat placeDeletionLegalHold — user dalam masa tenggang sudah
    // soft-deleted, lookup harus menyertakan mereka.
    const user = await this.findUserIncludingDeletedOrThrow(userId);
    const request = await this.prisma.accountDeletionRequest.findFirst({
      where: { userId: user.id, status: DeletionRequestStatus.ON_HOLD },
      orderBy: { requestedAt: 'desc' },
    });
    if (!request) {
      throw new NotFoundException({
        code: ErrorCodes.DELETION_REQUEST_NOT_FOUND,
        message: 'Tidak ada permintaan penghapusan yang sedang ON_HOLD untuk user ini.',
      });
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      const fresh = await tx.accountDeletionRequest.findUnique({ where: { id: request.id } });
      if (!fresh || fresh.status !== DeletionRequestStatus.ON_HOLD) {
        throw new ConflictException({
          code: ErrorCodes.DELETION_REQUEST_NOT_ACTIVE,
          message: 'Status permintaan berubah; muat ulang dan coba lagi.',
        });
      }
      const next = await tx.accountDeletionRequest.update({
        where: { id: request.id },
        data: { status: DeletionRequestStatus.REQUESTED, legalHoldReason: null },
      });
      await tx.accountDeletionStatusHistory.create({
        data: {
          requestId: request.id,
          fromStatus: DeletionRequestStatus.ON_HOLD,
          toStatus: DeletionRequestStatus.REQUESTED,
          actorType: 'ADMIN',
          actorUserId: adminId,
          reason: 'Legal hold dilepas admin',
        },
      });
      return next;
    });

    this.auditLog.logAdminAction({
      adminId,
      action: AuditAction.ADMIN_ACTION,
      targetType: 'AccountDeletionRequest',
      targetId: request.id,
      description: `Admin released legal hold on deletion request ${request.referenceCode}.`,
      before: { status: DeletionRequestStatus.ON_HOLD },
      after: { status: DeletionRequestStatus.REQUESTED },
      ipAddress,
    });

    return updated;
  }

}
