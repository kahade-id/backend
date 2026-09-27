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
import {
  deriveLegalEntityType,
  documentsCompleteWhere,
  isDocumentsCompleteRow,
  legalEntityTypeWhere,
  maskNpwp,
  type LegalEntityType,
} from './legal-entity.util';
import type { BusinessVerificationQueueQueryDto } from './dto/business-verification-queue-query.dto';

const VALID_STATUSES: BusinessVerificationStatus[] = [
  BusinessVerificationStatus.PENDING,
  BusinessVerificationStatus.APPROVED,
  BusinessVerificationStatus.REJECTED,
  BusinessVerificationStatus.REVOKED,
];

/**
 * GAP-E G322 — masa berlaku verifikasi legalitas badan usaha.
 *
 * Skema tidak menyimpan tanggal kedaluwarsa per dokumen (dan worker ini
 * dilarang membuat migrasi baru), sehingga alarm "dokumen legal kedaluwarsa"
 * dihitung dari `approvedAt`: persetujuan dianggap berlaku selama
 * LEGALITY_VALIDITY_DAYS hari, setelah itu badan usaha perlu verifikasi ulang.
 *
 * NILAI SEMENTARA — butuh KEPUTUSAN PRODUK: berapa lama persetujuan verifikasi
 * bisnis berlaku, dan apakah tiap jenis dokumen (akta, SIUP/NIB) punya masa
 * berlaku sendiri (butuh kolom validUntil per dokumen + migrasi).
 */
export const LEGALITY_VALIDITY_DAYS = 3 * 365;
/** Ambang peringatan "segera kedaluwarsa": sisa <= 90 hari. */
export const LEGALITY_WARNING_DAYS = 90;

/** Tanggal kedaluwarsa masa berlaku dari approvedAt — null bila belum disetujui. */
export function legalitasValidUntil(approvedAt?: Date | null): Date | null {
  if (!approvedAt) return null;
  return new Date(approvedAt.getTime() + LEGALITY_VALIDITY_DAYS * 24 * 60 * 60 * 1000);
}

/** Status masa berlaku: 'ok' | 'warning' (<=90 hari tersisa) | 'expired' | 'na'. */
export function legalitasStatus(
  approvedAt?: Date | null,
  now: Date = new Date(),
): 'ok' | 'warning' | 'expired' | 'na' {
  const validUntil = legalitasValidUntil(approvedAt);
  if (!validUntil) return 'na';
  const remainingMs = validUntil.getTime() - now.getTime();
  if (remainingMs <= 0) return 'expired';
  if (remainingMs <= LEGALITY_WARNING_DAYS * 24 * 60 * 60 * 1000) return 'warning';
  return 'ok';
}

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
    query: {
      status?: string;
      legalEntityType?: string;
      docsComplete?: 'true' | 'false';
      awaitingDocs?: 'true';
      legalitasExpired?: 'true';
    } = {},
  ): Promise<PaginatedResponse<Record<string, unknown>>> {
    const safePage = Number.isFinite(page) ? Math.max(1, Math.floor(page)) : 1;
    const safeLimit = Number.isFinite(limit) ? Math.min(100, Math.max(1, Math.floor(limit))) : 20;
    const skip = (safePage - 1) * safeLimit;

    const resolvedStatus = this.assertValidStatus(query.status);
    const and: Prisma.BusinessVerificationWhereInput[] = [];

    // GAP-E G314–G316: filter jenis badan hukum / kelengkapan dokumen /
    // "menunggu dokumen tambahan" (sebelumnya hanya diekspor ke CSV).
    if (query.legalEntityType) {
      and.push(legalEntityTypeWhere(query.legalEntityType as LegalEntityType));
    }
    if (query.awaitingDocs === 'true') {
      and.push({ status: BusinessVerificationStatus.PENDING });
      and.push(documentsCompleteWhere(false));
    } else if (query.docsComplete === 'true' || query.docsComplete === 'false') {
      and.push(documentsCompleteWhere(query.docsComplete === 'true'));
    }
    // GAP-E G322: filter alarm legalitas kedaluwarsa (APPROVED + approvedAt
    // lebih tua dari LEGALITY_VALIDITY_DAYS).
    if (query.legalitasExpired === 'true') {
      and.push({ status: BusinessVerificationStatus.APPROVED });
      and.push({
        approvedAt: { lte: new Date(Date.now() - LEGALITY_VALIDITY_DAYS * 24 * 60 * 60 * 1000) },
      });
    }

    const where: Prisma.BusinessVerificationWhereInput = {
      ...(resolvedStatus ? { status: resolvedStatus } : {}),
      ...(and.length > 0 ? { AND: and } : {}),
    };

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
          // PENTING: documentFileKeys hanya dipakai untuk menghitung
          // docCount — NPWP (npwpNumber) TIDAK PERNAH di-select di antrean.
          documentFileKeys: true,
          rejectionReason: true,
          attemptNumber: true,
          createdAt: true,
          reviewedAt: true,
          approvedAt: true,
          reviewedBy: true,
          user: { select: { userId: true, email: true, fullName: true, accountType: true } },
          reviewer: { select: { adminId: true, fullName: true } },
        },
      }),
      this.prisma.businessVerification.count({ where }),
    ]);

    // Kolom turunan untuk UI (GAP-E G313/G322): jenis badan hukum,
    // kelengkapan dokumen, dan masa berlaku legalitas.
    // documentFileKeys hanya dipakai menghitung docCount — tidak dikembalikan.
    const rows = requests.map((r) => {
      const { documentFileKeys, ...rest } = r;
      const docCount = documentFileKeys.length;
      const approvedAt = r.approvedAt ?? null;
      const validUntil = legalitasValidUntil(approvedAt);
      return {
        ...rest,
        legalEntityType: deriveLegalEntityType(r.businessName),
        docCount,
        documentsComplete: isDocumentsCompleteRow(r.deedNumber, r.siupNumber, docCount),
        legalitasValidUntil: validUntil ? validUntil.toISOString() : null,
        legalitasExpired: legalitasStatus(approvedAt) === 'expired',
      };
    });

    return createPaginatedResponse(rows, total, safePage, safeLimit);
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
        // NPWP terenkripsi: didekripsi lalu DI-MASK sebelum dikembalikan
        // (preview minim-PII, G313). Tidak pernah mentah di respons detail.
        npwpNumber: true,
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
        assignedReviewerId: true,
        assignedReviewer: { select: { id: true, adminId: true, fullName: true } },
        // Hanya untuk menghitung docCount — tidak dikembalikan mentah.
        documentFileKeys: true,
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

    // NPWP adalah data sensitif — detail hanya membawa versi MASKED untuk
    // preview minim-PII; NPWP mentah tetap hanya lewat getDocumentUrls
    // yang butuh re-auth. Dekripsi gagal → null, detail tetap dikembalikan.
    let npwpMasked: string | null = null;
    try {
      npwpMasked = maskNpwp(await decryptAES(request.npwpNumber));
    } catch (err) {
      this.logger.warn(
        `[AdminBusinessVerification] NPWP decryption failed for detail ${verificationId}`,
      );
    }
    const { npwpNumber: _encryptedNpwp, documentFileKeys, ...safeRequest } = request;
    const docCount = documentFileKeys.length;

    // NPWP adalah data sensitif — detail hanya membawa versi MASKED untuk
    // preview minim-PII; NPWP mentah tetap hanya lewat getDocumentUrls
    // yang butuh re-auth.
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

    return {
      ...safeRequest,
      legalEntityType: deriveLegalEntityType(request.businessName),
      docCount,
      documentsComplete: isDocumentsCompleteRow(request.deedNumber, request.siupNumber, docCount),
      npwpMasked,
      // GAP-E G321/G322: masa berlaku legalitas untuk tab "Riwayat"/detail.
      legalitasValidUntil: legalitasValidUntil(request.approvedAt)?.toISOString() ?? null,
      legalitasExpired: legalitasStatus(request.approvedAt) === 'expired',
    };
  }

  async approve(
    verificationId: string,
    adminId: string,
    notes?: string,
    ipAddress = 'internal',
    batchId?: string,
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
      description:
        `Business verification ${verificationId} approved for user ${request.userId}` +
        (batchId ? ` [batchId=${batchId}]` : '') +
        (normalizedNotes ? ': ' + normalizedNotes : ''),
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
    batchId?: string,
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
      description:
        `Business verification ${verificationId} rejected for user ${request.userId}: ${normalizedReason}` +
        (batchId ? ` [batchId=${batchId}]` : ''),
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
    notes?: string,
  ): Promise<Record<string, unknown>> {
    const normalizedReason = this.normalizeRequiredText(reason, 'Revocation reason');
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

  /**
   * GAP-E: penugasan reviewer bisnis yang beraudit (G293 untuk domain bisnis).
   * assignedReviewerId terpisah dari reviewedBy (yang memutuskan) — menugaskan
   * tidak mengubah status pengajuan. Tidak ada nilai AuditAction baru
   * (menambah enum butuh migrasi) — penugasan dicatat sebagai ADMIN_ACTION
   * dengan deskripsi eksplisit.
   */
  async assignReviewer(
    verificationId: string,
    reviewerAdminId: string,
    actorAdminId: string,
    ipAddress = 'internal',
  ): Promise<Record<string, unknown>> {
    const request = await this.prisma.businessVerification.findFirst({
      where: this.findWhere(verificationId),
      select: { id: true, verificationId: true, userId: true, status: true, assignedReviewerId: true },
    });
    if (!request) {
      throw new NotFoundException({
        code: ErrorCodes.BUSINESS_VERIFICATION_NOT_FOUND,
        message: 'Business verification request not found',
      });
    }

    const reviewer = await this.prisma.adminUser.findUnique({
      where: { id: reviewerAdminId },
      select: { id: true, adminId: true, fullName: true, isActive: true, role: true },
    });
    if (!reviewer || !reviewer.isActive) {
      throw new BadRequestException({
        code: ErrorCodes.VALIDATION_ERROR,
        message: 'Reviewer admin tidak ditemukan atau tidak aktif',
      });
    }

    const updated = await this.prisma.businessVerification.update({
      where: { id: request.id },
      data: { assignedReviewerId: reviewer.id },
      select: { id: true, verificationId: true, assignedReviewerId: true, updatedAt: true },
    });

    this.auditLog.logAdminAction({
      adminId: actorAdminId,
      action: AuditAction.ADMIN_ACTION,
      targetType: 'BUSINESS_VERIFICATION',
      targetId: verificationId,
      description:
        `Business verification ${verificationId} assigned to reviewer ${reviewer.adminId} ` +
        `(${reviewer.fullName}) by admin ${actorAdminId}`,
      ipAddress,
    });

    return { ...updated, assignedReviewer: { adminId: reviewer.adminId, fullName: reviewer.fullName } };
  }

  /**
   * GAP-E: ringkasan volume disetujui/ditolak/dicabut per periode untuk
   * dasbor operasional. Dihitung dari reviewedAt dalam jendela periode;
   * `pending` = kedalaman antrean saat ini (semua waktu).
   */
  async getSummary(period: '7d' | '30d' | '90d' = '30d'): Promise<Record<string, unknown>> {
    const days = period === '7d' ? 7 : period === '90d' ? 90 : 30;
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    const [approved, rejected, revoked, pending] = await Promise.all([
      this.prisma.businessVerification.count({
        where: { status: BusinessVerificationStatus.APPROVED, reviewedAt: { gte: since } },
      }),
      this.prisma.businessVerification.count({
        where: { status: BusinessVerificationStatus.REJECTED, reviewedAt: { gte: since } },
      }),
      this.prisma.businessVerification.count({
        where: { status: BusinessVerificationStatus.REVOKED, reviewedAt: { gte: since } },
      }),
      this.prisma.businessVerification.count({
        where: { status: BusinessVerificationStatus.PENDING },
      }),
    ]);

    return { period, approved, rejected, revoked, pending, totalReviewed: approved + rejected + revoked };
  }

  /**
   * GAP-E: riwayat perubahan/audit untuk satu pengajuan — dibaca dari
   * admin_audit_logs (targetId = id maupun verificationId) untuk tab
   * "Riwayat" di detail: penugasan reviewer, akses dokumen, keputusan review.
   */
  async getHistory(verificationId: string): Promise<Record<string, unknown>[]> {
    const request = await this.prisma.businessVerification.findFirst({
      where: this.findWhere(verificationId),
      select: { id: true, verificationId: true },
    });
    if (!request) {
      throw new NotFoundException({
        code: ErrorCodes.BUSINESS_VERIFICATION_NOT_FOUND,
        message: 'Business verification request not found',
      });
    }

    const logs = await this.prisma.adminAuditLog.findMany({
      where: {
        targetType: 'BUSINESS_VERIFICATION',
        targetId: { in: [request.id, request.verificationId] },
      },
      orderBy: { createdAt: 'desc' },
      take: 100,
      select: {
        id: true,
        action: true,
        description: true,
        ipAddress: true,
        createdAt: true,
        admin: { select: { adminId: true, fullName: true } },
      },
    });

    return logs.map((l) => ({
      id: l.id,
      action: l.action,
      description: l.description,
      ipAddress: l.ipAddress,
      createdAt: l.createdAt,
      admin: l.admin,
    }));
  }

  /**
   * GAP-E: ekspor antrean sebagai CSV. NPWP TIDAK PERNAH disertakan —
   * kolom npwpNumber/npwpNumberHash tidak di-select sama sekali.
   */
  async exportCsv(query: BusinessVerificationQueueQueryDto): Promise<string> {
    const and: Prisma.BusinessVerificationWhereInput[] = [];
    const resolvedStatus = this.assertValidStatus(query.status);
    const where: Prisma.BusinessVerificationWhereInput = resolvedStatus ? { status: resolvedStatus } : {};
    if (query.legalEntityType) {
      and.push(legalEntityTypeWhere(query.legalEntityType as LegalEntityType));
    }
    if (query.awaitingDocs === 'true') {
      where.status = BusinessVerificationStatus.PENDING;
      and.push(documentsCompleteWhere(false));
    } else if (query.docsComplete === 'true' || query.docsComplete === 'false') {
      and.push(documentsCompleteWhere(query.docsComplete === 'true'));
    }
    // GAP-E G322: ekspor juga bisa difilter alarm legalitas kedaluwarsa.
    if (query.legalitasExpired === 'true') {
      and.push({ status: BusinessVerificationStatus.APPROVED });
      and.push({
        approvedAt: { lte: new Date(Date.now() - LEGALITY_VALIDITY_DAYS * 24 * 60 * 60 * 1000) },
      });
    }
    if (and.length > 0) {
      where.AND = and;
    }

    const rows = await this.prisma.businessVerification.findMany({
      where,
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: 5000,
      // PENTING: npwpNumber & npwpNumberHash sengaja TIDAK di-select.
      select: {
        verificationId: true,
        businessName: true,
        deedNumber: true,
        siupNumber: true,
        documentFileKeys: true,
        status: true,
        userId: true,
        attemptNumber: true,
        rejectionReason: true,
        createdAt: true,
        reviewedAt: true,
        approvedAt: true,
        revokedAt: true,
        reviewedBy: true,
        assignedReviewerId: true,
        user: { select: { email: true, fullName: true } },
        reviewer: { select: { adminId: true, fullName: true } },
      },
    });

    const esc = (v: unknown): string => {
      const s = v === null || v === undefined ? '' : String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };

    const header = [
      'verification_id',
      'nama_badan_usaha',
      'jenis_badan_hukum',
      'nomor_akta',
      'nomor_siup_nib',
      'jumlah_dokumen',
      'dokumen_lengkap',
      'status',
      'user_id',
      'email_pemohon',
      'nama_pemohon',
      'reviewer_ditugaskan',
      'reviewer_pemutus',
      'diajukan_pada',
      'ditinjau_pada',
      'disetujui_pada',
      'dicabut_pada',
      'alasan_penolakan',
      'upaya_ke',
    ];
    const lines = [header.join(',')];
    for (const r of rows) {
      const docCount = r.documentFileKeys.length;
      lines.push(
        [
          r.verificationId,
          r.businessName,
          deriveLegalEntityType(r.businessName),
          r.deedNumber,
          r.siupNumber,
          docCount,
          isDocumentsCompleteRow(r.deedNumber, r.siupNumber, docCount) ? 'YA' : 'TIDAK',
          r.status,
          r.userId,
          r.user?.email,
          r.user?.fullName,
          r.assignedReviewerId,
          r.reviewer ? `${r.reviewer.adminId} (${r.reviewer.fullName})` : '',
          r.createdAt.toISOString(),
          r.reviewedAt?.toISOString(),
          r.approvedAt?.toISOString(),
          r.revokedAt?.toISOString(),
          r.rejectionReason,
          r.attemptNumber,
        ]
          .map(esc)
          .join(','),
      );
    }
    return lines.join('\n');
  }
}
