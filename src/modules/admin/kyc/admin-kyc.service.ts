import { Prisma, NotificationType, AuditAction } from '@prisma/client';
import { getCategoryForType } from '../../notifications/notification-category.map';
import { Injectable, NotFoundException, BadRequestException, UnauthorizedException, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bull';
import { Queue } from 'bull';
import { PrismaService } from '../../../prisma/prisma.service';
import { RedisService } from '../../../redis/redis.service';
import { AuditLogService } from '../../../common/services/audit-log.service';
import { UploadService } from '../../upload/upload.service';
import { createPaginatedResponse, PaginatedResponse } from '../../../common/dto/pagination.dto';
import { decryptAES, bcryptCompare } from '../../../common/utils/crypto.util';
import { generateNotifId } from '../../../common/utils/id-generator.util';
import { escapeHtml } from '../../../common/utils/sanitize.util';
import { EMAIL_QUEUE, EmailJobData } from '../../queue/processors/email.processor';
import * as ErrorCodes from '../../../common/constants/error-codes';

@Injectable()
export class AdminKycService {
  private readonly logger = new Logger(AdminKycService.name);
  constructor(
    private prisma: PrismaService,
    private redis: RedisService,
    private auditLog: AuditLogService,
    private uploadService: UploadService,
    @InjectQueue(EMAIL_QUEUE) private readonly emailQueue: Queue<EmailJobData>,
  ) {}

  private async invalidateKycCache(userId: string): Promise<void> {
    try {
      await this.redis.del(`guard:kyc:${userId}`);
    } catch (err) {
      this.logger.warn(`Failed to invalidate KYC cache for user ${userId}`, err);
    }
  }

  private normalizeOptionalText(value?: string): string | null {
    const normalized = value?.trim();
    return normalized ? normalized : null;
  }

  private normalizeRequiredText(value: string, field: string): string {
    const normalized = value.trim();
    if (!normalized) {
      throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: `${field} must contain non-whitespace text` });
    }
    return normalized;
  }

  async getKycQueue(page = 1, limit = 20, status?: string): Promise<PaginatedResponse<Record<string, unknown>>> {
    const safePage = Number.isFinite(page) ? Math.max(1, Math.floor(page)) : 1;
    const safeLimit = Number.isFinite(limit) ? Math.min(100, Math.max(1, Math.floor(limit))) : 20;
    const skip = (safePage - 1) * safeLimit;

    const validStatuses = ['PENDING', 'APPROVED', 'REJECTED', 'REVOKED'];
    if (status && !validStatuses.includes(status)) {
      throw new BadRequestException({
        code: ErrorCodes.INVALID_STATUS,
        message: `Invalid KYC status: ${status}. Valid values: ${validStatuses.join(', ')}`,
      });
    }

    const where = status ? { status: status as Prisma.EnumKycStatusFilter } : {};

    const [requests, total] = await Promise.all([
      this.prisma.kycRequest.findMany({
        where,
        skip,
        take: safeLimit,
        orderBy: { createdAt: 'asc' },
        select: {
          id: true,
          kycId: true,
          userId: true,
          status: true,
          rejectionReason: true,
          attemptNumber: true,
          createdAt: true,
          reviewedAt: true,
          reviewedBy: true,
          user: { select: { userId: true, email: true, fullName: true } },
          reviewer: { select: { adminId: true, fullName: true } },
        },
      }),
      this.prisma.kycRequest.count({ where }),
    ]);

    return createPaginatedResponse(requests, total, safePage, safeLimit);
  }

  async approveKyc(kycId: string, adminId: string, notes?: string, ipAddress: string = 'internal'): Promise<Record<string, unknown>> {
    const normalizedNotes = this.normalizeOptionalText(notes);
    const request = await this.prisma.kycRequest.findFirst({
      where: { OR: [{ id: kycId }, { kycId }] },
      include: { user: { select: { id: true, userId: true, email: true, fullName: true } } },
    });
    if (!request) throw new NotFoundException({ code: ErrorCodes.KYC_NOT_FOUND, message: 'KYC request not found' });
    if (request.status !== 'PENDING') {
      throw new BadRequestException({ code: ErrorCodes.INVALID_STATUS, message: `KYC is already ${request.status}` });
    }

    const updated = await this.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      const guard = await tx.kycRequest.updateMany({
        where: { id: request.id, status: 'PENDING' },
        data: {
          status: 'APPROVED',
          reviewedBy: adminId,
          reviewedAt: new Date(),
          adminNotes: normalizedNotes,
        },
      });
      if (guard.count === 0) {
        throw new BadRequestException({ code: ErrorCodes.INVALID_STATUS, message: 'KYC request was already processed by another admin' });
      }
      const result = await tx.kycRequest.findUniqueOrThrow({ where: { id: request.id } });

      await tx.user.update({
        where: { id: request.userId },
        data: {
          kycStatus: 'APPROVED',
          kycApprovedAt: new Date(),
        },
      });

      return result;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });

    await this.invalidateKycCache(request.userId);
    this.auditLog.logAdminAction({
      adminId,
      action: AuditAction.KYC_APPROVED,
      targetType: 'KYC_REQUEST',
      targetId: kycId,
      description: `KYC ${kycId} approved for user ${request.userId}${normalizedNotes ? ': ' + normalizedNotes : ''}`,
      ipAddress,
    });

    void this.prisma.notification.create({
      data: { notifId: generateNotifId(), userId: request.userId, type: NotificationType.KYC_APPROVED, category: getCategoryForType(NotificationType.KYC_APPROVED), title: 'KYC Verification Approved', body: 'Congratulations! Your identity has been successfully verified. You can now perform escrow transactions.', isRead: false },
    }).catch((error: unknown) => this.logger.warn(`KYC approval notification failed after commit: ${error instanceof Error ? error.message : String(error)}`));

    this.prisma.emitNotificationCreated({
      userId: request.userId,
      title: 'KYC Verification Approved',
      body: 'Congratulations! Your identity has been successfully verified. You can now perform escrow transactions.',
      data: { type: 'KYC_APPROVED' },
    });

    if (request.user?.email) {
      this.emailQueue.add('send', {
        to: request.user.email,
        subject: 'Kahade — Your KYC Verification Has Been Approved',
        templateName: 'kyc-approved',
        templateContext: { name: request.user.fullName ?? 'User' },
      }, { attempts: 3, backoff: { type: 'exponential', delay: 5000 } }).catch((err) => {
        this.logger.error(`Failed to queue KYC approval email for ${request.user?.email}`, err);
      });
    }

    return updated;
  }

  async rejectKyc(kycId: string, adminId: string, reason: string, notes?: string, ipAddress: string = 'internal'): Promise<Record<string, unknown>> {
    const normalizedReason = this.normalizeRequiredText(reason, 'Rejection reason');
    const normalizedNotes = this.normalizeOptionalText(notes);
    const request = await this.prisma.kycRequest.findFirst({
      where: { OR: [{ id: kycId }, { kycId }] },
      include: { user: { select: { id: true, userId: true, email: true, fullName: true } } },
    });
    if (!request) throw new NotFoundException({ code: ErrorCodes.KYC_NOT_FOUND, message: 'KYC request not found' });
    if (request.status !== 'PENDING') {
      throw new BadRequestException({ code: ErrorCodes.INVALID_STATUS, message: `KYC is already ${request.status}` });
    }

    const updated = await this.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      const guard = await tx.kycRequest.updateMany({
        where: { id: request.id, status: 'PENDING' },
        data: {
          status: 'REJECTED',
          reviewedBy: adminId,
          reviewedAt: new Date(),
          rejectionReason: normalizedReason,
          adminNotes: normalizedNotes,
        },
      });
      if (guard.count === 0) {
        throw new BadRequestException({ code: ErrorCodes.INVALID_STATUS, message: 'KYC request was already processed by another admin' });
      }
      const result = await tx.kycRequest.findUniqueOrThrow({ where: { id: request.id } });

      await tx.user.update({
        where: { id: request.userId },
        data: {
          kycStatus: 'REJECTED',
          kycApprovedAt: null,
        },
      });

      return result;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });

    await this.invalidateKycCache(request.userId);
    this.auditLog.logAdminAction({
      adminId,
      action: AuditAction.KYC_REJECTED,
      targetType: 'KYC_REQUEST',
      targetId: kycId,
      description: `KYC ${kycId} rejected for user ${request.userId}: ${normalizedReason}`,
      ipAddress,
    });

    const safeReason = escapeHtml(normalizedReason);
    void this.prisma.notification.create({
      data: { notifId: generateNotifId(), userId: request.userId, type: NotificationType.KYC_REJECTED, category: getCategoryForType(NotificationType.KYC_REJECTED), title: 'KYC Verification Rejected', body: `Your KYC application could not be approved. Reason: ${safeReason}. Please resubmit with the correct documents.`, isRead: false },
    }).catch((error: unknown) => this.logger.warn(`KYC rejection notification failed after commit: ${error instanceof Error ? error.message : String(error)}`));

    const safeReasonForPush = escapeHtml(normalizedReason);
    this.prisma.emitNotificationCreated({
      userId: request.userId,
      title: 'KYC Verification Rejected',
      body: `Your KYC application could not be approved. Reason: ${safeReasonForPush}. Please resubmit with the correct documents.`,
      data: { type: 'KYC_REJECTED' },
    });

    if (request.user?.email) {
      const safeReasonForEmail = escapeHtml(normalizedReason);
      const safeNotesForEmail = normalizedNotes ? escapeHtml(normalizedNotes) : undefined;
      this.emailQueue.add('send', {
        to: request.user.email,
        subject: 'Kahade — Your KYC Verification Was Not Approved',
        templateName: 'kyc-rejected',
        templateContext: { name: request.user.fullName ?? 'User', reason: safeReasonForEmail, notes: safeNotesForEmail },
      }, { attempts: 3, backoff: { type: 'exponential', delay: 5000 } }).catch((err) => {
        this.logger.error(`Failed to queue KYC rejection email for ${request.user?.email}`, err);
      });
    }

    return updated;
  }

  async revokeKyc(kycId: string, adminId: string, reason: string, ipAddress: string = 'internal'): Promise<Record<string, unknown>> {
    const normalizedReason = this.normalizeRequiredText(reason, 'Revocation reason');
    const request = await this.prisma.kycRequest.findFirst({
      where: { OR: [{ id: kycId }, { kycId }] },
      include: { user: { select: { id: true, userId: true, email: true, fullName: true } } },
    });
    if (!request) throw new NotFoundException({ code: ErrorCodes.KYC_NOT_FOUND, message: 'KYC request not found' });
    if (request.status !== 'APPROVED') {
      throw new BadRequestException({ code: ErrorCodes.INVALID_STATUS, message: `KYC can only be revoked from APPROVED status, current: ${request.status}` });
    }

    const updated = await this.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      const guard = await tx.kycRequest.updateMany({
        where: { id: request.id, status: 'APPROVED' },
        data: {
          status: 'REVOKED',
          reviewedBy: adminId,
          reviewedAt: new Date(),
          rejectionReason: normalizedReason,
        },
      });
      if (guard.count === 0) {
        throw new BadRequestException({ code: ErrorCodes.INVALID_STATUS, message: 'KYC request was already processed by another admin' });
      }
      const result = await tx.kycRequest.findUniqueOrThrow({ where: { id: request.id } });

      await tx.user.update({
        where: { id: request.userId },
        data: {
          kycStatus: 'REVOKED',
          kycApprovedAt: null,
        },
      });

      return result;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });

    await this.invalidateKycCache(request.userId);
    this.auditLog.logAdminAction({
      adminId,
      action: AuditAction.KYC_REVOKED,
      targetType: 'KYC_REQUEST',
      targetId: kycId,
      description: `KYC ${kycId} revoked for user ${request.userId}: ${normalizedReason}`,
      ipAddress,
    });

    const safeRevokeReason = escapeHtml(normalizedReason);
    void this.prisma.notification.create({
      data: { notifId: generateNotifId(), userId: request.userId, type: NotificationType.KYC_REVOKED, category: getCategoryForType(NotificationType.KYC_REVOKED), title: 'KYC Verification Revoked', body: `Your KYC verification has been revoked. Reason: ${safeRevokeReason}. Please contact customer support for more information.`, isRead: false },
    }).catch((error: unknown) => this.logger.warn(`KYC revocation notification failed after commit: ${error instanceof Error ? error.message : String(error)}`));

    const safeRevokeReasonForPush = escapeHtml(normalizedReason);
    this.prisma.emitNotificationCreated({
      userId: request.userId,
      title: 'KYC Verification Revoked',
      body: `Your KYC verification has been revoked. Reason: ${safeRevokeReasonForPush}. Please contact customer support for more information.`,
      data: { type: 'KYC_REVOKED' },
    });

    if (request.user?.email) {
      const safeReasonForEmail = escapeHtml(normalizedReason);
      this.emailQueue.add('send', {
        to: request.user.email,
        subject: 'Kahade — Your KYC Verification Has Been Revoked',
        templateName: 'kyc-revoked',
        templateContext: { name: request.user.fullName ?? 'User', reason: safeReasonForEmail },
      }, { attempts: 3, backoff: { type: 'exponential', delay: 5000 } }).catch((err) => {
        this.logger.error(`Failed to queue KYC revocation email for ${request.user?.email}`, err);
      });
    }

    return updated;
  }

  async getKycDetail(kycId: string, adminId?: string, ipAddress?: string): Promise<Record<string, unknown>> {
    const request = await this.prisma.kycRequest.findFirst({
      where: { OR: [{ id: kycId }, { kycId }] },
      select: {
        id: true,
        kycId: true,
        userId: true,
        status: true,
        rejectionReason: true,
        adminNotes: true,
        attemptNumber: true,
        submittedIp: true,
        createdAt: true,
        reviewedAt: true,
        reviewedBy: true,
        user: { select: { userId: true, email: true, fullName: true } },
        reviewer: { select: { adminId: true, fullName: true } },
      },
    });
    if (!request) throw new NotFoundException({ code: ErrorCodes.KYC_NOT_FOUND, message: 'KYC request not found' });

    if (adminId) {
      await this.auditLog.logAdminAction({
        adminId,
        action: AuditAction.ADMIN_ACTION,
        targetType: 'KYC_REQUEST',
        targetId: kycId,
        description: `Admin viewed KYC detail for ${kycId} (user ${request.userId})`,
        ipAddress: ipAddress ?? 'unknown',
      });
    }

    return request;
  }

  async getDocumentUrls(kycId: string, adminId: string, ipAddress: string = 'unknown', adminPassword?: string): Promise<{ ktpUrl: string | null; selfieUrl: string | null; partialErrors?: string[] }> {
    if (!adminPassword) {
      throw new UnauthorizedException({
        code: ErrorCodes.UNAUTHORIZED,
        message: 'Re-authentication required to access KYC documents. Provide your password.',
      });
    }

    const admin = await this.prisma.adminUser.findUnique({ where: { id: adminId } });
    if (!admin) {
      throw new UnauthorizedException({ code: ErrorCodes.UNAUTHORIZED, message: 'Admin not found' });
    }

    const isPasswordValid = await bcryptCompare(adminPassword, admin.password);
    if (!isPasswordValid) {
      await this.auditLog.logAdminAction({
        adminId,
        action: AuditAction.ADMIN_ACTION,
        targetType: 'KYC_REQUEST',
        targetId: kycId,
        description: `Failed re-authentication attempt for KYC document access (${kycId})`,
        ipAddress,
      });
      throw new UnauthorizedException({ code: ErrorCodes.INVALID_CREDENTIALS, message: 'Invalid password for re-authentication' });
    }

    const request = await this.prisma.kycRequest.findFirst({ where: { OR: [{ id: kycId }, { kycId }] } });
    if (!request) throw new NotFoundException({ code: ErrorCodes.KYC_NOT_FOUND, message: 'KYC request not found' });

    // KYC-006 fix: decrypt each document independently so a single corrupted
    // ciphertext doesn't prevent the admin from accessing the other (valid) document.
    let ktpFileKey: string | null = null;
    let selfieFileKey: string | null = null;
    const decryptErrors: string[] = [];

    try {
      ktpFileKey = await decryptAES(request.ktpPhotoUrl);
    } catch (err) {
      decryptErrors.push('KTP photo is unavailable');
      this.logger.error(`[AdminKycService] KTP photo decryption failed for kycId=${kycId}`, err);
    }
    try {
      selfieFileKey = await decryptAES(request.selfiePhotoUrl);
    } catch (err) {
      decryptErrors.push('Selfie photo is unavailable');
      this.logger.error(`[AdminKycService] Selfie photo decryption failed for kycId=${kycId}`, err);
    }

    if (!ktpFileKey && !selfieFileKey) {
      throw new BadRequestException({ code: ErrorCodes.INTERNAL_SERVER_ERROR, message: 'Both document decryption failed. Data may be corrupted.' });
    }

    let ktpUrl: string | null = null;
    let selfieUrl: string | null = null;
    if (ktpFileKey) {
      try {
        ktpUrl = await this.uploadService.generateDownloadUrl(ktpFileKey, 300);
      } catch (err) {
        this.logger.error(`[AdminKycService] KTP signed URL generation failed for kycId=${kycId}`, err);
        decryptErrors.push('KTP download URL is unavailable');
      }
    }
    if (selfieFileKey) {
      try {
        selfieUrl = await this.uploadService.generateDownloadUrl(selfieFileKey, 300);
      } catch (err) {
        this.logger.error(`[AdminKycService] Selfie signed URL generation failed for kycId=${kycId}`, err);
        decryptErrors.push('Selfie download URL is unavailable');
      }
    }

    await this.auditLog.logAdminAction({
      adminId,
      action: AuditAction.KYC_DOCUMENTS_ACCESSED,
      targetType: 'KYC_REQUEST',
      targetId: kycId,
      description: `Admin accessed KYC documents for ${kycId} (user ${request.userId}) after re-authentication`,
      ipAddress,
    });

    return { ktpUrl, selfieUrl, ...(decryptErrors.length > 0 ? { partialErrors: decryptErrors } : {}) };
  }
}
