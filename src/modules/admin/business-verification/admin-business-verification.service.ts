import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { AuditAction, BusinessVerificationStatus, NotificationType, Prisma } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { AuditLogService } from '../../../common/services/audit-log.service';
import { UploadService } from '../../upload/upload.service';
import { NotificationQueueService } from '../../queue/notification-queue.service';
import { VerificationBadgeService } from '../../users/verification-badge.service';
import { createPaginatedResponse, PaginatedResponse } from '../../../common/dto/pagination.dto';
import { bcryptCompare, decryptAES } from '../../../common/utils/crypto.util';
import { escapeHtml } from '../../../common/utils/sanitize.util';
import * as ErrorCodes from '../../../common/constants/error-codes';

const VALID_STATUSES: BusinessVerificationStatus[] = [
  BusinessVerificationStatus.PENDING,
  BusinessVerificationStatus.APPROVED,
  BusinessVerificationStatus.REJECTED,
  BusinessVerificationStatus.REVOKED,
];

/**
 * Section 1(d) — review verifikasi badan usaha lewat admin console.
 *
 * Mengikuti pola `admin-kyc.service.ts` secara sengaja:
 *  - queue FIFO per status dengan pagination offset + tiebreak `{ id }`
 *  - approve/reject/revoke memakai `updateMany({ where: { status: <expected> } })`
 *    di dalam transaction Serializable sebagai guard agar dua admin tidak
 *    memproses baris yang sama dua kali
 *  - akses dokumen butuh re-authentication password admin dan diaudit
 *
 * Perbedaan penting: badge "Business Verified" TIDAK disimpan di kolom user
 * (tidak seperti kycStatus yang denormalized), jadi setiap keputusan review
 * cukup invalidate cache badge post-commit — tidak ada sync kolom yang bisa basi.
 */
@Injectable()
export class AdminBusinessVerificationService {
  private readonly logger = new Logger(AdminBusinessVerificationService.name);

  constructor(
    private prisma: PrismaService,
    private auditLog: AuditLogService,
    private uploadService: UploadService,
    private notificationQueue: NotificationQueueService,
    private verificationBadgeService: VerificationBadgeService,
  ) {}

  private normalizeOptionalText(value?: string): string | null {
    const normalized = value?.trim();
    return normalized ? normalized : null;
  }

  private normalizeRequiredText(value: string, field: string): string {
    const normalized = value.trim();
    if (!normalized) {
      throw new BadRequestException({
        code: ErrorCodes.VALIDATION_ERROR,
        message: `${field} must contain non-whitespace text`,
      });
    }
    return normalized;
  }

  private assertValidStatus(status?: string): BusinessVerificationStatus | undefined {
    if (!status) return undefined;
    const match = VALID_STATUSES.find((candidate) => candidate === status);
    if (!match) {
      throw new BadRequestException({
        code: ErrorCodes.INVALID_STATUS,
        message: `Invalid business verification status: ${status}. Valid values: ${VALID_STATUSES.join(', ')}`,
      });
    }
    return match;
  }

  private findWhere(verificationId: string): Prisma.BusinessVerificationWhereInput {
    // Terima primary key maupun verificationId (BIZ-...) seperti admin-kyc.
    return { OR: [{ id: verificationId }, { verificationId }] };
  }

  async getQueue(
    page = 1,
    limit = 20,
    status?: string,
  ): Promise<PaginatedResponse<Record<string, unknown>>> {
    const safePage = Number.isFinite(page) ? Math.max(1, Math.floor(page)) : 1;
    const safeLimit = Number.isFinite(limit) ? Math.min(100, Math.max(1, Math.floor(limit))) : 20;
    const skip = (safePage - 1) * safeLimit;

    const resolvedStatus = this.assertValidStatus(status);
    const where: Prisma.BusinessVerificationWhereInput = resolvedStatus ? { status: resolvedStatus } : {};

    const [requests, total] = await Promise.all([
      this.prisma.businessVerification.findMany({
        where,
        skip,
        take: safeLimit,
        // FIFO untuk review; tiebreak { id } supaya halaman stabil.
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        select: {
          id: true,
          verificationId: true,
          userId: true,
          status: true,
          businessName: true,
          deedNumber: true,
          siupNumber: true,
          rejectionReason: true,
          attemptNumber: true,
          createdAt: true,
          reviewedAt: true,
          reviewedBy: true,
          user: { select: { userId: true, email: true, fullName: true, accountType: true } },
          reviewer: { select: { adminId: true, fullName: true } },
        },
      }),
      this.prisma.businessVerification.count({ where }),
    ]);

    return createPaginatedResponse(requests, total, safePage, safeLimit);
  }

  async getDetail(
    verificationId: string,
    adminId?: string,
    ipAddress = 'unknown',
  ): Promise<Record<string, unknown>> {
    const request = await this.prisma.businessVerification.findFirst({
      where: this.findWhere(verificationId),
      select: {
        id: true,
        verificationId: true,
        userId: true,
        status: true,
        businessName: true,
        deedNumber: true,
        siupNumber: true,
        rejectionReason: true,
        adminNotes: true,
        attemptNumber: true,
        submittedIp: true,
        createdAt: true,
        reviewedAt: true,
        reviewedBy: true,
        approvedAt: true,
        revokedAt: true,
        user: { select: { userId: true, email: true, fullName: true, accountType: true } },
        reviewer: { select: { adminId: true, fullName: true } },
      },
    });
    if (!request) {
      throw new NotFoundException({
        code: ErrorCodes.BUSINESS_VERIFICATION_NOT_FOUND,
        message: 'Business verification request not found',
      });
    }

    // NPWP adalah data sensitif — admin melihatnya lewat getDocumentUrls yang
    // butuh re-auth, jadi detail queue tidak membocorkannya (bahkan terenkripsi).
    if (adminId) {
      this.auditLog.logAdminAction({
        adminId,
        action: AuditAction.ADMIN_ACTION,
        targetType: 'BUSINESS_VERIFICATION',
        targetId: verificationId,
        description: `Admin viewed business verification detail for ${verificationId} (user ${request.userId})`,
        ipAddress,
      });
    }

    return request;
  }

  async approve(
    verificationId: string,
    adminId: string,
    notes?: string,
    ipAddress = 'internal',
  ): Promise<Record<string, unknown>> {
    const normalizedNotes = this.normalizeOptionalText(notes);
    const request = await this.prisma.businessVerification.findFirst({
      where: this.findWhere(verificationId),
      select: { id: true, verificationId: true, userId: true, status: true, businessName: true },
    });
    if (!request) {
      throw new NotFoundException({
        code: ErrorCodes.BUSINESS_VERIFICATION_NOT_FOUND,
        message: 'Business verification request not found',
      });
    }
    if (request.status !== BusinessVerificationStatus.PENDING) {
      throw new BadRequestException({
        code: ErrorCodes.INVALID_STATUS,
        message: `Business verification is already ${request.status}`,
      });
    }

    const now = new Date();
    const updated = await this.prisma.$transaction(
      async (tx: Prisma.TransactionClient) => {
        // Guard atomik: kalau admin lain sudah memproses, count === 0.
        const guard = await tx.businessVerification.updateMany({
          where: { id: request.id, status: BusinessVerificationStatus.PENDING },
          data: {
            status: BusinessVerificationStatus.APPROVED,
            reviewedBy: adminId,
            reviewedAt: now,
            approvedAt: now,
            adminNotes: normalizedNotes,
          },
        });
        if (guard.count === 0) {
          throw new BadRequestException({
            code: ErrorCodes.INVALID_STATUS,
            message: 'Business verification was already processed by another admin',
          });
        }
        return tx.businessVerification.findUniqueOrThrow({ where: { id: request.id } });
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );

    // Post-commit: badge "Business Verified" harus langsung muncul.
    await this.verificationBadgeService.invalidate(request.userId);

    this.auditLog.logAdminAction({
      adminId,
      action: AuditAction.BUSINESS_VERIFICATION_APPROVED,
      targetType: 'BUSINESS_VERIFICATION',
      targetId: verificationId,
      description: `Business verification ${verificationId} approved for user ${request.userId}${normalizedNotes ? ': ' + normalizedNotes : ''}`,
      ipAddress,
    });

    await this.notificationQueue.enqueue({
      userId: request.userId,
      type: NotificationType.BUSINESS_VERIFICATION_APPROVED,
      title: 'Business Verification Approved',
      body: `Congratulations! ${escapeHtml(request.businessName)} is now a verified business. The Business Verified badge is live on your profile.`,
      pushData: { type: 'BUSINESS_VERIFICATION_APPROVED', verificationId: request.verificationId },
    });

    return updated;
  }

  async reject(
    verificationId: string,
    adminId: string,
    reason: string,
    notes?: string,
    ipAddress = 'internal',
  ): Promise<Record<string, unknown>> {
    const normalizedReason = this.normalizeRequiredText(reason, 'Rejection reason');
    const normalizedNotes = this.normalizeOptionalText(notes);
    const request = await this.prisma.businessVerification.findFirst({
      where: this.findWhere(verificationId),
      select: { id: true, verificationId: true, userId: true, status: true, businessName: true },
    });
    if (!request) {
      throw new NotFoundException({
        code: ErrorCodes.BUSINESS_VERIFICATION_NOT_FOUND,
        message: 'Business verification request not found',
      });
    }
    if (request.status !== BusinessVerificationStatus.PENDING) {
      throw new BadRequestException({
        code: ErrorCodes.INVALID_STATUS,
        message: `Business verification is already ${request.status}`,
      });
    }

    const updated = await this.prisma.$transaction(
      async (tx: Prisma.TransactionClient) => {
        const guard = await tx.businessVerification.updateMany({
          where: { id: request.id, status: BusinessVerificationStatus.PENDING },
          data: {
            status: BusinessVerificationStatus.REJECTED,
            reviewedBy: adminId,
            reviewedAt: new Date(),
            rejectionReason: normalizedReason,
            adminNotes: normalizedNotes,
          },
        });
        if (guard.count === 0) {
          throw new BadRequestException({
            code: ErrorCodes.INVALID_STATUS,
            message: 'Business verification was already processed by another admin',
          });
        }
        return tx.businessVerification.findUniqueOrThrow({ where: { id: request.id } });
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );

    await this.verificationBadgeService.invalidate(request.userId);

    this.auditLog.logAdminAction({
      adminId,
      action: AuditAction.BUSINESS_VERIFICATION_REJECTED,
      targetType: 'BUSINESS_VERIFICATION',
      targetId: verificationId,
      description: `Business verification ${verificationId} rejected for user ${request.userId}: ${normalizedReason}`,
      ipAddress,
    });

    const safeReason = escapeHtml(normalizedReason);
    await this.notificationQueue.enqueue({
      userId: request.userId,
      type: NotificationType.BUSINESS_VERIFICATION_REJECTED,
      title: 'Business Verification Rejected',
      body: `Your business verification for ${escapeHtml(request.businessName)} could not be approved. Reason: ${safeReason}. You may resubmit after 24 hours.`,
      pushData: { type: 'BUSINESS_VERIFICATION_REJECTED', verificationId: request.verificationId },
    });

    return updated;
  }

  /**
   * Revoke verifikasi yang sudah APPROVED. Ini salah satu dari tiga jalur
   * "revoke otomatis harus langsung menghilangkan badge" — invalidation cache
   * dipanggil post-commit, bukan menunggu TTL.
   */
  async revoke(
    verificationId: string,
    adminId: string,
    reason: string,
    ipAddress = 'internal',
  ): Promise<Record<string, unknown>> {
    const normalizedReason = this.normalizeRequiredText(reason, 'Revocation reason');
    const request = await this.prisma.businessVerification.findFirst({
      where: this.findWhere(verificationId),
      select: { id: true, verificationId: true, userId: true, status: true, businessName: true },
    });
    if (!request) {
      throw new NotFoundException({
        code: ErrorCodes.BUSINESS_VERIFICATION_NOT_FOUND,
        message: 'Business verification request not found',
      });
    }
    if (request.status !== BusinessVerificationStatus.APPROVED) {
      throw new BadRequestException({
        code: ErrorCodes.INVALID_STATUS,
        message: `Business verification can only be revoked from APPROVED status, current: ${request.status}`,
      });
    }

    const updated = await this.prisma.$transaction(
      async (tx: Prisma.TransactionClient) => {
        const guard = await tx.businessVerification.updateMany({
          where: { id: request.id, status: BusinessVerificationStatus.APPROVED },
          data: {
            status: BusinessVerificationStatus.REVOKED,
            reviewedBy: adminId,
            reviewedAt: new Date(),
            revokedAt: new Date(),
            rejectionReason: normalizedReason,
          },
        });
        if (guard.count === 0) {
          throw new BadRequestException({
            code: ErrorCodes.INVALID_STATUS,
            message: 'Business verification was already processed by another admin',
          });
        }
        return tx.businessVerification.findUniqueOrThrow({ where: { id: request.id } });
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );

    await this.verificationBadgeService.invalidate(request.userId);

    this.auditLog.logAdminAction({
      adminId,
      action: AuditAction.BUSINESS_VERIFICATION_REVOKED,
      targetType: 'BUSINESS_VERIFICATION',
      targetId: verificationId,
      description: `Business verification ${verificationId} revoked for user ${request.userId}: ${normalizedReason}`,
      ipAddress,
    });

    const safeReason = escapeHtml(normalizedReason);
    await this.notificationQueue.enqueue({
      userId: request.userId,
      type: NotificationType.BUSINESS_VERIFICATION_REVOKED,
      title: 'Business Verification Revoked',
      body: `Your business verification for ${escapeHtml(request.businessName)} has been revoked. Reason: ${safeReason}. Please contact customer support for more information.`,
      pushData: { type: 'BUSINESS_VERIFICATION_REVOKED', verificationId: request.verificationId },
    });

    return updated;
  }

  /**
   * Signed URL short-lived (5 menit) untuk dokumen legalitas. Butuh
   * re-authentication password admin, sama seperti akses dokumen KYC — dokumen
   * badan usaha adalah data sensitif yang aksesnya harus bisa diaudit per admin.
   */
  async getDocumentUrls(
    verificationId: string,
    adminId: string,
    ipAddress = 'unknown',
    adminPassword?: string,
  ): Promise<{ npwpNumber: string | null; documentUrls: string[]; partialErrors?: string[] }> {
    if (!adminPassword) {
      throw new UnauthorizedException({
        code: ErrorCodes.UNAUTHORIZED,
        message: 'Re-authentication required to access business verification documents. Provide your password.',
      });
    }

    const admin = await this.prisma.adminUser.findUnique({ where: { id: adminId } });
    if (!admin) {
      throw new UnauthorizedException({ code: ErrorCodes.UNAUTHORIZED, message: 'Admin not found' });
    }
    const isPasswordValid = await bcryptCompare(adminPassword, admin.password);
    if (!isPasswordValid) {
      this.auditLog.logAdminAction({
        adminId,
        action: AuditAction.ADMIN_ACTION,
        targetType: 'BUSINESS_VERIFICATION',
        targetId: verificationId,
        description: `Failed re-authentication attempt for business verification document access (${verificationId})`,
        ipAddress,
      });
      throw new UnauthorizedException({
        code: ErrorCodes.INVALID_CREDENTIALS,
        message: 'Invalid password for re-authentication',
      });
    }

    const request = await this.prisma.businessVerification.findFirst({
      where: this.findWhere(verificationId),
      select: { id: true, userId: true, npwpNumber: true, documentFileKeys: true },
    });
    if (!request) {
      throw new NotFoundException({
        code: ErrorCodes.BUSINESS_VERIFICATION_NOT_FOUND,
        message: 'Business verification request not found',
      });
    }

    // Decrypt per item (pola KYC-006): satu ciphertext korup tidak boleh membuat
    // seluruh dokumen lain tidak bisa diakses admin.
    const partialErrors: string[] = [];
    let npwpNumber: string | null = null;
    try {
      npwpNumber = await decryptAES(request.npwpNumber);
    } catch (err) {
      partialErrors.push('NPWP is unavailable');
      this.logger.error(`[AdminBusinessVerification] NPWP decryption failed for ${verificationId}`, err);
    }

    const documentUrls: string[] = [];
    for (const encryptedKey of request.documentFileKeys) {
      let fileKey: string;
      try {
        fileKey = await decryptAES(encryptedKey);
      } catch (err) {
        partialErrors.push('One document is unavailable');
        this.logger.error(`[AdminBusinessVerification] document key decryption failed for ${verificationId}`, err);
        continue;
      }
      try {
        documentUrls.push(await this.uploadService.generateDownloadUrl(fileKey, 300));
      } catch (err) {
        partialErrors.push('One document download URL is unavailable');
        this.logger.error(`[AdminBusinessVerification] signed URL generation failed for ${verificationId}`, err);
      }
    }

    if (npwpNumber === null && documentUrls.length === 0) {
      throw new BadRequestException({
        code: ErrorCodes.INTERNAL_SERVER_ERROR,
        message: 'All document decryption failed. Data may be corrupted.',
      });
    }

    this.auditLog.logAdminAction({
      adminId,
      action: AuditAction.BUSINESS_DOCUMENTS_ACCESSED,
      targetType: 'BUSINESS_VERIFICATION',
      targetId: verificationId,
      description: `Admin accessed business verification documents for ${verificationId} (user ${request.userId}) after re-authentication`,
      ipAddress,
    });

    return {
      npwpNumber,
      documentUrls,
      ...(partialErrors.length > 0 ? { partialErrors } : {}),
    };
  }
}
