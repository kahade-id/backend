import {
  Injectable,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import { BusinessVerificationStatus, Prisma, UserAccountType, UserAuditAction } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditLogService } from '../../common/services/audit-log.service';
import { WalletTxSerialService } from '../../common/services/wallet-tx-serial.service';
import { UploadService } from '../upload/upload.service';
import { VerificationBadgeService } from '../users/verification-badge.service';
import { createPaginatedResponse, PaginatedResponse } from '../../common/dto/pagination.dto';
import { generateBusinessVerificationId } from '../../common/utils/id-generator.util';
import { encryptAES, hmacSHA256 } from '../../common/utils/crypto.util';
import { SubmitBusinessVerificationDto } from './dto/submit-business-verification.dto';
import * as ErrorCodes from '../../common/constants/error-codes';

/** Jeda sebelum boleh resubmit setelah ditolak — sama seperti KYC. */
const RESUBMIT_COOLDOWN_HOURS = 24;

/** NPWP lama 15 digit, format baru (NIK badan) 16 digit. */
const NPWP_DIGIT_LENGTHS = [15, 16];

const BUSINESS_DOCUMENT_FOLDER = 'business-documents';

/**
 * Section 1(d) — Business Verification.
 *
 * Verifikasi BADAN USAHA, domain terpisah dari KYC personal:
 *  - KYC membuktikan siapa orangnya (NIK/KTP) -> badge KYC_VERIFIED
 *  - BusinessVerification membuktikan legalitas usahanya (NPWP/akta/SIUP)
 *    -> badge BUSINESS_VERIFIED
 *
 * Hanya akun `accountType == BUSINESS` yang boleh mengajukan. Review dilakukan
 * admin lewat AdminBusinessVerificationService (pola sama seperti admin-kyc).
 */
@Injectable()
export class BusinessVerificationService {

  constructor(
    private prisma: PrismaService,
    private serialService: WalletTxSerialService,
    private auditLog: AuditLogService,
    private uploadService: UploadService,
    private verificationBadgeService: VerificationBadgeService,
  ) {}

  /** Buang titik/strip/spasi, lalu validasi panjang digit NPWP. */
  private normalizeNpwp(rawNpwp: string): string {
    const digits = rawNpwp.replace(/[^0-9]/g, '');
    if (!NPWP_DIGIT_LENGTHS.includes(digits.length)) {
      throw new BadRequestException({
        code: ErrorCodes.VALIDATION_ERROR,
        message: `NPWP must be ${NPWP_DIGIT_LENGTHS.join(' or ')} digits after normalization`,
      });
    }
    return digits;
  }

  private normalizeOptionalText(value?: string): string | null {
    const normalized = value?.trim();
    return normalized ? normalized : null;
  }

  /**
   * Pastikan setiap fileKey (a) bentuknya aman, (b) milik user ini, dan
   * (c) sudah dikonfirmasi lewat POST /upload/confirm. Cermin dari
   * KycService.verifyKycFilesConfirmed + B-39 shape guard di UploadService.
   */
  private async verifyDocumentsConfirmed(userId: string, fileKeys: string[]): Promise<void> {
    const prefix = `uploads/${BUSINESS_DOCUMENT_FOLDER}/${userId}/`;
    const uniqueKeys = Array.from(new Set(fileKeys));
    if (uniqueKeys.length !== fileKeys.length) {
      throw new BadRequestException({
        code: ErrorCodes.VALIDATION_ERROR,
        message: 'documentFileKeys must not contain duplicates',
      });
    }

    for (const fileKey of uniqueKeys) {
      // B-39 shape guard: cek bentuk/traversal SEBELUM cek prefix, karena
      // `startsWith(prefix)` saja meloloskan
      // `uploads/business-documents/<myId>/../../kyc-ktp/<victim>/x.jpg`.
      if (!fileKey.startsWith(prefix) || fileKey.split('/').length !== 4 || fileKey.includes('..') || fileKey.includes('%')) {
        throw new BadRequestException({
          code: ErrorCodes.FILE_ACCESS_DENIED,
          message: 'One or more document file keys do not belong to this user',
        });
      }
      // Sengaja pakai isConfirmedUploadKey (non-consuming) seperti KYC, bukan
      // verifyUserFileKeys: kalau submit gagal di validasi berikutnya, konfirmasi
      // upload user tidak ikut hangus sehingga ia bisa langsung retry.
      const confirmed = await this.uploadService.isConfirmedUploadKey(userId, fileKey);
      if (!confirmed) {
        throw new BadRequestException({
          code: ErrorCodes.UPLOAD_NOT_CONFIRMED,
          message: `Document must be confirmed via /upload/confirm before submitting: ${fileKey}`,
        });
      }
    }
  }

  private isRetryableDbError(error: unknown): boolean {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2034') return true;
    if (error instanceof Prisma.PrismaClientUnknownRequestError) {
      const message = error.message.toLowerCase();
      return message.includes('40001') || message.includes('serialization') || message.includes('deadlock');
    }
    return false;
  }

  private async withSerializableRetry<T>(operation: () => Promise<T>, label: string): Promise<T> {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        return await operation();
      } catch (error: unknown) {
        if (!this.isRetryableDbError(error) || attempt === 3) throw error;
        await new Promise((resolve) => setTimeout(resolve, 100 * 2 ** (attempt - 1)));
      }
    }
    throw new Error(`${label} exhausted retry loop`);
  }

  /**
   * Gate utama: hanya akun BUSINESS. Dilempar sebagai Forbidden (bukan NotFound)
   * karena identitasnya memang ada — yang ditolak adalah eligibility-nya.
   */
  private async assertBusinessAccount(userId: string): Promise<void> {
    const user = await this.prisma.user.findFirst({
      // Soft-delete guard
      where: { id: userId, deletedAt: null },
      select: { accountType: true },
    });
    if (!user) {
      throw new ForbiddenException({ code: ErrorCodes.FORBIDDEN, message: 'User not found' });
    }
    if (user.accountType !== UserAccountType.BUSINESS) {
      throw new ForbiddenException({
        code: ErrorCodes.BUSINESS_ACCOUNT_REQUIRED,
        message: 'Business verification is only available for BUSINESS accounts. Switch your account type first.',
      });
    }
  }

  /**
   * @param allowRejected true hanya dari jalur /resubmit. Tanpa flag ini sebuah
   * pengajuan REJECTED akan selalu diarahkan ke /resubmit, dan /resubmit sendiri
   * tidak akan pernah bisa jalan.
   */
  private async assertNoActiveSubmission(userId: string, allowRejected = false): Promise<void> {
    const latest = await this.prisma.businessVerification.findFirst({
      where: { userId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: { status: true, reviewedAt: true },
    });
    if (!latest) return;

    if (latest.status === BusinessVerificationStatus.PENDING) {
      throw new BadRequestException({
        code: ErrorCodes.BUSINESS_VERIFICATION_ALREADY_PENDING,
        message: 'You already have a pending business verification request',
      });
    }
    if (latest.status === BusinessVerificationStatus.APPROVED) {
      throw new BadRequestException({
        code: ErrorCodes.BUSINESS_VERIFICATION_ALREADY_APPROVED,
        message: 'Your business is already verified',
      });
    }
    if (latest.status === BusinessVerificationStatus.REVOKED) {
      throw new ForbiddenException({
        code: ErrorCodes.BUSINESS_VERIFICATION_REVOKED,
        message: 'Your business verification has been revoked. Please contact support to resolve this.',
      });
    }
    if (latest.status === BusinessVerificationStatus.REJECTED) {
      const hoursSinceReview = latest.reviewedAt
        ? (Date.now() - latest.reviewedAt.getTime()) / 3_600_000
        : Infinity;
      if (hoursSinceReview < RESUBMIT_COOLDOWN_HOURS) {
        const hoursRemaining = Math.ceil(RESUBMIT_COOLDOWN_HOURS - hoursSinceReview);
        throw new BadRequestException({
          code: ErrorCodes.BUSINESS_VERIFICATION_COOLDOWN_ACTIVE,
          message: `Business verification resubmission available in ${hoursRemaining} hour(s). Please use /business-verification/resubmit.`,
        });
      }
      // Cooldown sudah lewat: jalur /resubmit boleh lanjut.
      if (allowRejected) return;
      throw new BadRequestException({
        code: ErrorCodes.BUSINESS_VERIFICATION_USE_RESUBMIT,
        message: 'Your previous business verification was rejected. Please use /business-verification/resubmit.',
      });
    }
  }

  private async assertNpwpNotTakenByOthers(userId: string, npwpNumberHash: string): Promise<void> {
    const existing = await this.prisma.businessVerification.findFirst({
      // Partial unique index hanya menutup PENDING/APPROVED; cek aplikasi harus
      // pakai filter yang sama supaya user bisa resubmit setelah REJECTED.
      where: {
        npwpNumberHash,
        status: { in: [BusinessVerificationStatus.PENDING, BusinessVerificationStatus.APPROVED] },
        userId: { not: userId },
      },
      select: { id: true },
    });
    if (existing) {
      throw new BadRequestException({
        code: ErrorCodes.BUSINESS_VERIFICATION_DUPLICATE_NPWP,
        message: 'This NPWP is already registered to another account',
      });
    }
  }

  private async createSubmission(
    userId: string,
    dto: SubmitBusinessVerificationDto,
    ipAddress: string | undefined,
    allowRejected = false,
  ): Promise<Record<string, unknown>> {
    await this.assertBusinessAccount(userId);
    await this.assertNoActiveSubmission(userId, allowRejected);
    await this.verifyDocumentsConfirmed(userId, dto.documentFileKeys);

    const npwpNumber = this.normalizeNpwp(dto.npwpNumber);
    const npwpNumberHash = hmacSHA256(npwpNumber);
    await this.assertNpwpNotTakenByOthers(userId, npwpNumberHash);

    const deedNumber = this.normalizeOptionalText(dto.deedNumber);
    const siupNumber = this.normalizeOptionalText(dto.siupNumber);
    if (!deedNumber && !siupNumber) {
      throw new BadRequestException({
        code: ErrorCodes.VALIDATION_ERROR,
        message: 'At least one of deedNumber or siupNumber is required',
      });
    }

    // fileKey disimpan terenkripsi (pola KycRequest.ktpPhotoUrl) — DB dump tidak
    // boleh membocorkan nama dokumen legalitas.
    const encryptedKeys = await Promise.all(
      Array.from(new Set(dto.documentFileKeys)).map((key) => encryptAES(key)),
    );

    const previousCount = await this.prisma.businessVerification.count({ where: { userId } });
    const serial = await this.serialService.getNextForPrefix('business_verification_serial');
    const verificationId = generateBusinessVerificationId(serial);

    try {
      const created = await this.withSerializableRetry(
        () =>
          this.prisma.$transaction(
            async (tx: Prisma.TransactionClient) => {
              // Re-check di dalam transaction: partial unique index adalah guard
              // terakhir, tapi error DB mentah tidak ramah untuk client.
              const concurrentPending = await tx.businessVerification.findFirst({
                where: { userId, status: BusinessVerificationStatus.PENDING },
                select: { id: true },
              });
              if (concurrentPending) {
                throw new BadRequestException({
                  code: ErrorCodes.BUSINESS_VERIFICATION_ALREADY_PENDING,
                  message: 'You already have a pending business verification request',
                });
              }

              return tx.businessVerification.create({
                data: {
                  verificationId,
                  userId,
                  status: BusinessVerificationStatus.PENDING,
                  businessName: dto.businessName.trim(),
                  npwpNumber: await encryptAES(npwpNumber),
                  npwpNumberHash,
                  deedNumber,
                  siupNumber,
                  documentFileKeys: encryptedKeys,
                  submittedIp: ipAddress ?? null,
                  attemptNumber: previousCount + 1,
                },
                select: {
                  id: true,
                  verificationId: true,
                  status: true,
                  businessName: true,
                  deedNumber: true,
                  siupNumber: true,
                  attemptNumber: true,
                  createdAt: true,
                },
              });
            },
            { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
          ),
        'business-verification-submit',
      );

      this.auditLog.logUserAction({
        userId,
        action: UserAuditAction.BUSINESS_VERIFICATION_SUBMITTED,
        entityType: 'BusinessVerification',
        entityId: created.id,
        description: `Submitted business verification for ${created.businessName}`,
      });

      return {
        ...created,
        message: 'Business verification submitted. Our team will review it shortly.',
      };
    } catch (error: unknown) {
      // P2002 = partial unique index menolak (double-submit balapan / NPWP sudah
      // dipakai akun lain). Terjemahkan ke error code yang konsisten.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        const target = Array.isArray(error.meta?.target) ? error.meta.target.join(',') : String(error.meta?.target ?? '');
        if (target.includes('npwpNumberHash') || target.includes('npwp_number_hash')) {
          throw new BadRequestException({
            code: ErrorCodes.BUSINESS_VERIFICATION_DUPLICATE_NPWP,
            message: 'This NPWP is already registered to another account',
          });
        }
        throw new BadRequestException({
          code: ErrorCodes.BUSINESS_VERIFICATION_ALREADY_PENDING,
          message: 'You already have a pending business verification request',
        });
      }
      throw error;
    }
  }

  async submit(
    userId: string,
    dto: SubmitBusinessVerificationDto,
    ipAddress?: string,
  ): Promise<Record<string, unknown>> {
    return this.createSubmission(userId, dto, ipAddress);
  }

  /**
   * Resubmit setelah REJECTED. Sengaja endpoint terpisah (bukan submit yang
   * di-overload) supaya throttle dan audit-nya bisa dibedakan, sama seperti KYC.
   */
  async resubmit(
    userId: string,
    dto: SubmitBusinessVerificationDto,
    ipAddress?: string,
  ): Promise<Record<string, unknown>> {
    const latest = await this.prisma.businessVerification.findFirst({
      where: { userId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: { status: true },
    });
    if (!latest || latest.status !== BusinessVerificationStatus.REJECTED) {
      throw new BadRequestException({
        code: ErrorCodes.INVALID_STATUS,
        message: 'Resubmission is only allowed after a REJECTED business verification',
      });
    }
    // allowRejected=true: gate REJECTED sudah diperiksa di atas, yang masih
    // ditegakkan di dalam createSubmission hanyalah cooldown 24 jam.
    return this.createSubmission(userId, dto, ipAddress, true);
  }

  async getStatus(userId: string): Promise<Record<string, unknown>> {
    const latest = await this.prisma.businessVerification.findFirst({
      where: { userId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: {
        verificationId: true,
        status: true,
        businessName: true,
        deedNumber: true,
        siupNumber: true,
        rejectionReason: true,
        attemptNumber: true,
        createdAt: true,
        reviewedAt: true,
        approvedAt: true,
        revokedAt: true,
      },
    });

    return {
      status: latest?.status ?? null,
      // Badge hanya menyala untuk APPROVED — dipakai UI supaya tidak perlu
      // memanggil endpoint badge terpisah.
      isBusinessVerified: latest?.status === BusinessVerificationStatus.APPROVED,
      latestRequest: latest ?? null,
    };
  }

  async getHistory(
    userId: string,
    page: number,
    limit: number,
  ): Promise<PaginatedResponse<Record<string, unknown>>> {
    const safePage = Number.isFinite(page) ? Math.max(1, Math.floor(page)) : 1;
    const safeLimit = Number.isFinite(limit) ? Math.min(100, Math.max(1, Math.floor(limit))) : 20;
    const skip = (safePage - 1) * safeLimit;
    const where = { userId };

    const [data, total] = await Promise.all([
      this.prisma.businessVerification.findMany({
        where,
        // Tiebreak { id } — tanpa ini dua baris ber-createdAt sama bisa bertukar
        // halaman (regresi yang sudah diperbaiki di modul lain).
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip,
        take: safeLimit,
        select: {
          verificationId: true,
          status: true,
          businessName: true,
          rejectionReason: true,
          attemptNumber: true,
          createdAt: true,
          reviewedAt: true,
        },
      }),
      this.prisma.businessVerification.count({ where }),
    ]);

    return createPaginatedResponse(data, total, safePage, safeLimit);
  }

  /**
   * Dipakai admin service setelah commit approve/reject/revoke supaya badge
   * "Business Verified" hilang/muncul tanpa menunggu TTL cache.
   */
  async invalidateBadgeCache(userId: string): Promise<void> {
    await this.verificationBadgeService.invalidate(userId);
  }
}
