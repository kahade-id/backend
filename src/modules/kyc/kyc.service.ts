import { Injectable, BadRequestException, ForbiddenException, ConflictException } from '@nestjs/common';
import { KycStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditLogService } from '../../common/services/audit-log.service';
import { WalletTxSerialService } from '../../common/services/wallet-tx-serial.service';
import { generateKycId } from '../../common/utils/id-generator.util';
import { encryptKycNik, encryptKycKtp, encryptKycSelfie, decryptAES, hmacSHA256, argon2HashNik } from '../../common/utils/crypto.util';
import { createPaginatedResponse, PaginatedResponse } from '../../common/dto/pagination.dto';
import * as ErrorCodes from '../../common/constants/error-codes';
import { UserAuditAction } from '@prisma/client';
import { UploadService } from '../upload/upload.service';

@Injectable()
export class KycService {
  constructor(
    private prisma: PrismaService,
    private serialService: WalletTxSerialService,
    private auditLog: AuditLogService,
    private uploadService: UploadService,
  ) {}

  private async getNextKycSerial(): Promise<number> {
    return this.serialService.getNextForPrefix('kyc_serial');
  }

  private isRetryableDbError(error: unknown): boolean {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2034') return true;
    if (error instanceof Prisma.PrismaClientUnknownRequestError) {
      const message = error.message.toLowerCase();
      return message.includes('40001') || message.includes('serialization') || message.includes('40p01') || message.includes('deadlock');
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

  private async verifyKycFilesConfirmed(userId: string, ktpFileKey: string, selfieFileKey: string): Promise<void> {
    const [ktpConfirmed, selfieConfirmed] = await Promise.all([
      this.uploadService.isConfirmedUploadKey(userId, ktpFileKey),
      this.uploadService.isConfirmedUploadKey(userId, selfieFileKey),
    ]);

    if (!ktpConfirmed || !selfieConfirmed) {
      throw new BadRequestException({
        code: 'UPLOAD_NOT_CONFIRMED',
        message: 'Both KTP and selfie files must be confirmed via /upload/confirm before submitting KYC',
      });
    }
  }

  private async canonicalizeLegacyNik(tx: Prisma.TransactionClient, nik: string, nikHash: string, userId: string): Promise<string | null> {
    // The former implementation loaded and decrypted every active KYC row. Legacy
    // Argon2 NIK hashes use a fixed, secret-derived salt, so the same NIK can be
    // looked up deterministically without touching unrelated ciphertexts.
    const legacyArgonHash = await argon2HashNik(nik);
    const legacyRows = await tx.kycRequest.findMany({
      where: {
        status: { in: [KycStatus.PENDING, KycStatus.APPROVED, KycStatus.REVOKED] },
        ktpNumberHash: legacyArgonHash,
      },
      select: { id: true, userId: true, ktpNumberHash: true },
    });
    for (const row of legacyRows) {
      await tx.kycRequest.update({ where: { id: row.id }, data: { ktpNumberHash: nikHash } });
      return row.userId === userId ? null : row.userId;
    }
    return null;
  }
  async submit(userId: string, ktpFileKey: string, selfieFileKey: string, nik: string, ipAddress?: string): Promise<Record<string, unknown>> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { phoneVerified: true },
    });

    if (!user || !user.phoneVerified) {
      throw new ForbiddenException({
        code: ErrorCodes.PHONE_NOT_VERIFIED,
        message: 'Your phone number must be verified before submitting KYC',
      });
    }

    await this.verifyKycFilesConfirmed(userId, ktpFileKey, selfieFileKey);

    const latestKyc = await this.prisma.kycRequest.findFirst({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      select: { status: true, reviewedAt: true },
    });

    if (latestKyc) {
      if (latestKyc.status === KycStatus.PENDING) {
        throw new BadRequestException({
          code: ErrorCodes.KYC_ALREADY_PENDING,
          message: 'You already have a pending KYC request',
        });
      }

      if (latestKyc.status === KycStatus.APPROVED) {
        throw new BadRequestException({
          code: ErrorCodes.KYC_ALREADY_APPROVED,
          message: 'Your KYC has already been approved',
        });
      }

      if (latestKyc.status === KycStatus.REVOKED) {
        throw new ForbiddenException({
          code: ErrorCodes.KYC_REVOKED,
          message: 'Your KYC verification has been revoked. Please contact support to resolve this.',
        });
      }

      if (latestKyc.status === KycStatus.REJECTED) {
        const COOLDOWN_HOURS = 24;
        const hoursSinceReview = latestKyc.reviewedAt
          ? (Date.now() - latestKyc.reviewedAt.getTime()) / 3_600_000
          : Infinity;

        if (hoursSinceReview < COOLDOWN_HOURS) {
          const hoursRemaining = Math.ceil(COOLDOWN_HOURS - hoursSinceReview);
          throw new BadRequestException({
            code: ErrorCodes.KYC_COOLDOWN_ACTIVE,
            message: `KYC resubmission available in ${hoursRemaining} hour(s). Please use /kyc/resubmit.`,
          });
        }

        throw new BadRequestException({
          code: ErrorCodes.KYC_USE_RESUBMIT,
          message: 'Your previous KYC was rejected. Please use /kyc/resubmit to submit a new request.',
        });
      }
    }

    // Canonical storage is deterministic HMAC so the database partial index can
    // enforce one active identity. Argon2 raw hashes are retained only for rows
    // written by the former implementation.
    const nikHash = hmacSHA256(nik);
    const encryptedKtpUrl = await encryptKycKtp(ktpFileKey);
    const encryptedSelfieUrl = await encryptKycSelfie(selfieFileKey);
    const encryptedNik = await encryptKycNik(nik);

    const serial = await this.getNextKycSerial();
    const kycId = generateKycId(serial);

    let kycRequest: Awaited<ReturnType<typeof this.prisma.kycRequest.create>>;
    try {
      kycRequest = await this.withSerializableRetry(
        () => this.prisma.$transaction(async (tx) => {
      const concurrentPending = await tx.kycRequest.findFirst({
        where: { userId, status: KycStatus.PENDING },
      });
      if (concurrentPending) {
        throw new BadRequestException({
          code: ErrorCodes.KYC_ALREADY_PENDING,
          message: 'You already have a pending KYC request',
        });
      }

      const concurrentApproved = await tx.kycRequest.findFirst({
        where: { userId, status: KycStatus.APPROVED },
      });
      if (concurrentApproved) {
        throw new BadRequestException({
          code: ErrorCodes.KYC_ALREADY_APPROVED,
          message: 'Your KYC has already been approved',
        });
      }

      const existingNik = await tx.kycRequest.findFirst({ where: { ktpNumberHash: nikHash, status: { in: [KycStatus.APPROVED, KycStatus.PENDING, KycStatus.REVOKED] } } });
      const legacyOwnerId = existingNik ? null : await this.canonicalizeLegacyNik(tx, nik, nikHash, userId);
      if ((existingNik && existingNik.userId !== userId) || (legacyOwnerId && legacyOwnerId !== userId)) {
        throw new BadRequestException({
          code: ErrorCodes.KYC_DUPLICATE_NIK,
          message: 'This NIK has already been used for KYC verification',
        });
      }

      const attemptCount = await tx.kycRequest.count({
        where: { userId },
      });
      const MAX_KYC_ATTEMPTS = 10;
      if (attemptCount >= MAX_KYC_ATTEMPTS) {
        throw new BadRequestException({
          code: ErrorCodes.KYC_MAX_ATTEMPTS_REACHED,
          message: 'Maximum KYC submission attempts reached. Please contact support.',
        });
      }

      const created = await tx.kycRequest.create({
        data: {
          kycId,
          userId,
          ktpPhotoUrl: encryptedKtpUrl,
          selfiePhotoUrl: encryptedSelfieUrl,
          ktpNumber: encryptedNik,
          ktpNumberHash: nikHash,
          submittedIp: ipAddress,
          attemptNumber: attemptCount + 1,
        },
      });

      await tx.user.update({
        where: { id: userId },
        data: { kycStatus: KycStatus.PENDING },
      });

      return created;
        }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }),
        'KYC_SUBMIT_TX',
      );
    } catch (error: unknown) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictException({ code: ErrorCodes.KYC_DUPLICATE_NIK, message: 'This NIK has already been used for an active KYC request' });
      }
      throw error;
    }

    this.auditLog.logUserAction({
      userId,
      action: UserAuditAction.KYC_SUBMITTED,
      entityType: 'KycRequest',
      entityId: kycRequest.id,
      description: `KYC request submitted (${kycId})`,
      ipAddress,
    });

    return {
      kycId: kycRequest.kycId,
      status: kycRequest.status,
      attemptNumber: kycRequest.attemptNumber,
      createdAt: kycRequest.createdAt,
    };
  }

  async getStatus(userId: string): Promise<Record<string, unknown>> {
    const latestKyc = await this.prisma.kycRequest.findFirst({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      select: {
        kycId: true,
        status: true,
        rejectionReason: true,
        attemptNumber: true,
        createdAt: true,
        reviewedAt: true,
      },
    });

    if (!latestKyc) {
      return {
        status: KycStatus.UNVERIFIED,
        latestRequest: null,
      };
    }

    return {
      status: latestKyc.status,
      latestRequest: latestKyc,
    };
  }

  async getHistory(userId: string, page: number, limit: number): Promise<PaginatedResponse<Record<string, unknown>>> {
    const safePage = Number.isFinite(page) ? Math.max(1, Math.floor(page)) : 1;
    const safeLimit = Number.isFinite(limit) ? Math.min(100, Math.max(1, Math.floor(limit))) : 20;
    const skip = (safePage - 1) * safeLimit;

    const [data, total] = await Promise.all([
      this.prisma.kycRequest.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' },
        skip,
        take: safeLimit,
        select: {
          kycId: true,
          status: true,
          rejectionReason: true,
          attemptNumber: true,
          createdAt: true,
          reviewedAt: true,
        },
      }),
      this.prisma.kycRequest.count({ where: { userId } }),
    ]);

    return createPaginatedResponse(data, total, safePage, safeLimit);
  }

  async resubmit(userId: string, ktpFileKey: string, selfieFileKey: string, nik: string, ipAddress?: string): Promise<Record<string, unknown>> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { phoneVerified: true },
    });

    if (!user || !user.phoneVerified) {
      throw new ForbiddenException({
        code: ErrorCodes.PHONE_NOT_VERIFIED,
        message: 'Your phone number must be verified before resubmitting KYC',
      });
    }

    const latestKyc = await this.prisma.kycRequest.findFirst({
      where: { userId },
      orderBy: { createdAt: 'desc' },
    });

    if (latestKyc && latestKyc.status === KycStatus.REVOKED) {
      throw new ForbiddenException({
        code: 'KYC_REVOKED',
        message: 'Your KYC verification has been revoked. Please contact support to resolve this.',
      });
    }

    if (!latestKyc || latestKyc.status !== KycStatus.REJECTED) {
      throw new BadRequestException({
        code: 'KYC_RESUBMIT_NOT_ALLOWED',
        message: 'KYC resubmission is only allowed after a rejection',
      });
    }

    const COOLDOWN_HOURS = 24;
    if (latestKyc.reviewedAt) {
      const hoursSinceReview = (Date.now() - latestKyc.reviewedAt.getTime()) / 3_600_000;
      if (hoursSinceReview < COOLDOWN_HOURS) {
        const hoursRemaining = Math.ceil(COOLDOWN_HOURS - hoursSinceReview);
        throw new BadRequestException({
          code: ErrorCodes.KYC_COOLDOWN_ACTIVE,
          message: `KYC resubmission available in ${hoursRemaining} hour(s)`,
        });
      }
    }

    await this.verifyKycFilesConfirmed(userId, ktpFileKey, selfieFileKey);

    const nikHash = hmacSHA256(nik);
    const encryptedKtpUrl = await encryptKycKtp(ktpFileKey);
    const encryptedSelfieUrl = await encryptKycSelfie(selfieFileKey);
    const encryptedNik = await encryptKycNik(nik);
    const resubmitSerial = await this.getNextKycSerial();
    const resubmitKycId = generateKycId(resubmitSerial);

    let updated: Awaited<ReturnType<typeof this.prisma.kycRequest.create>>;
    try {
      updated = await this.withSerializableRetry(
        () => this.prisma.$transaction(async (tx) => {
      const attemptCount = await tx.kycRequest.count({ where: { userId } });
      const MAX_KYC_ATTEMPTS = 10;
      if (attemptCount >= MAX_KYC_ATTEMPTS) {
        throw new BadRequestException({
          code: ErrorCodes.KYC_MAX_ATTEMPTS_REACHED,
          message: 'Maximum KYC submission attempts reached. Please contact support.',
        });
      }

      const concurrentPending = await tx.kycRequest.findFirst({
        where: { userId, status: KycStatus.PENDING },
      });
      if (concurrentPending) {
        throw new BadRequestException({
          code: ErrorCodes.KYC_ALREADY_PENDING,
          message: 'You already have a pending KYC request',
        });
      }

      const concurrentApproved = await tx.kycRequest.findFirst({
        where: { userId, status: KycStatus.APPROVED },
      });
      if (concurrentApproved) {
        throw new BadRequestException({
          code: ErrorCodes.KYC_ALREADY_APPROVED,
          message: 'Your KYC has already been approved',
        });
      }

      const existingNikOwner = await tx.kycRequest.findFirst({ where: { ktpNumberHash: nikHash, status: { in: [KycStatus.APPROVED, KycStatus.PENDING, KycStatus.REVOKED] } } });
      const legacyOwnerId = existingNikOwner ? null : await this.canonicalizeLegacyNik(tx, nik, nikHash, userId);
      if ((existingNikOwner && existingNikOwner.userId !== userId) || (legacyOwnerId && legacyOwnerId !== userId)) {
        throw new BadRequestException({
          code: ErrorCodes.KYC_DUPLICATE_NIK,
          message: 'This NIK has already been used for KYC verification',
        });
      }

      const locked = await tx.kycRequest.findFirst({
        where: { id: latestKyc.id, status: KycStatus.REJECTED },
      });
      if (!locked) {
        throw new ConflictException({
          code: 'KYC_STATE_CHANGED',
          message: 'KYC status changed concurrently. Please reload and try again.',
        });
      }

      const result = await tx.kycRequest.create({
        data: {
          kycId: resubmitKycId,
          userId,
          status: KycStatus.PENDING,
          ktpPhotoUrl: encryptedKtpUrl,
          selfiePhotoUrl: encryptedSelfieUrl,
          ktpNumber: encryptedNik,
          ktpNumberHash: nikHash,
          submittedIp: ipAddress ?? null,
          attemptNumber: attemptCount + 1,
        },
      });

      await tx.user.update({
        where: { id: userId },
        data: { kycStatus: KycStatus.PENDING },
      });

      return result!;
        }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }),
        'KYC_RESUBMIT_TX',
      );
    } catch (error: unknown) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictException({ code: ErrorCodes.KYC_DUPLICATE_NIK, message: 'This NIK has already been used for an active KYC request' });
      }
      throw error;
    }

    this.auditLog.logUserAction({
      userId,
      action: UserAuditAction.KYC_SUBMITTED,
      entityType: 'KycRequest',
      // Was `updated.kycId` (the human-readable KYC-xxx id) while submit() above logs
      // `kycRequest.id` (the cuid) under the same entityType. Two different id spaces
      // in one entityType make the audit trail impossible to join reliably; every
      // other module logs the row's `.id`, so align on that.
      entityId: updated.id,
      description: 'User resubmitted KYC after rejection',
      ipAddress,
    });

    return { kycId: updated.kycId, status: updated.status };
  }
}
