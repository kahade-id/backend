import {
  Injectable,
  BadRequestException,
  ConflictException,
  ForbiddenException,
  GoneException,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectQueue } from '@nestjs/bull';
import { Queue } from 'bull';
import { JwtService } from '@nestjs/jwt';
import { randomInt } from 'crypto';
import { nanoid } from 'nanoid';
import { Prisma, DeletionRequestStatus } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { RedisService } from '../../redis/redis.service';
import { OtpService } from '../auth/otp.service';
import { OtpGatewayService } from '../auth/otp-gateway.service';
import { TOKEN_ISSUER } from '../auth/token.service';
import { EMAIL_QUEUE, type EmailJobData } from '../queue/processors/email.processor';
import * as ErrorCodes from '../../common/constants/error-codes';
import { hashPhoneNumber, decryptPiiSafe } from '../../common/utils/pii.util';
import { normalizeIndonesianPhone } from '../../common/utils/phone.util';
import { generateNotifId } from '../../common/utils/id-generator.util';
import { getCategoryForType } from '../notifications/notification-category.map';
import { NotificationType, OtpType } from '@prisma/client';
import { DELETION_PURGE_LOCK } from '../../common/constants/redis-keys';

/**
 * GAP-A — Masa tenggang penghapusan akun: 30 hari sejak permintaan dibuat.
 * Selama masa ini profil publik disembunyikan seketika, data dianonimkan
 * tepat pada purgeAt (kecuali dibatalkan / ON_HOLD retensi hukum).
 */
export const DELETION_GRACE_PERIOD_DAYS = 30;
export const DELETION_GRACE_PERIOD_MS = DELETION_GRACE_PERIOD_DAYS * 24 * 60 * 60 * 1000;

/** Audience JWT sekali-pakai untuk pembatalan penghapusan (TTL 15 menit). */
export const DELETION_CANCEL_AUDIENCE = 'kahade-deletion-cancel';
export const DELETION_CANCEL_SCOPE = 'deletion_cancel';
export const DELETION_CANCEL_TTL_SECONDS = 15 * 60;

/**
 * Status yang dianggap "aktif" — masih bisa dibatalkan dan menunggu purge.
 * PENDING tidak pernah diproduksi jalur kode mana pun (lihat enum di
 * schema.prisma) tetapi tetap dianggap aktif untuk kompatibilitas maju.
 */
export const ACTIVE_DELETION_STATUSES: DeletionRequestStatus[] = [
  DeletionRequestStatus.REQUESTED,
  DeletionRequestStatus.PENDING,
];

const REFERENCE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // tanpa I, O, 0, 1 (ambigu)

export function generateDeletionReferenceCode(): string {
  let suffix = '';
  for (let i = 0; i < 6; i += 1) {
    suffix += REFERENCE_ALPHABET[randomInt(REFERENCE_ALPHABET.length)];
  }
  return `DEL-${suffix}`;
}

export function computePurgeAt(requestedAt: Date): Date {
  return new Date(requestedAt.getTime() + DELETION_GRACE_PERIOD_MS);
}

export interface DeletionBlocker {
  code: string;
  message: string;
}

export interface DeletionRequestResult {
  message: string;
  referenceCode: string;
  status: DeletionRequestStatus;
  requestedAt: Date;
  purgeAt: Date;
  serverNow: Date;
}

@Injectable()
export class AccountDeletionService {
  private readonly logger = new Logger(AccountDeletionService.name);

  constructor(
    private prisma: PrismaService,
    private redis: RedisService,
    private configService: ConfigService,
    private jwtService: JwtService,
    private otpService: OtpService,
    private otpGateway: OtpGatewayService,
    @InjectQueue(EMAIL_QUEUE) private readonly emailQueue: Queue<EmailJobData>,
  ) {}

  // ─────────────────────────────────────────────────────────────────
  // Eligibilitas penghapusan (G066/G070) — satu sumber kebenaran untuk
  // UI pra-konfirmasi dan penjagaan di requestAccountDeletion.
  // ─────────────────────────────────────────────────────────────────
  /**
   * SEC-001: `db` opsional memungkinkan pengecekan dijalankan di dalam
   * transaksi purge (Serializable) — bukan snapshot basi di luar transaksi.
   * Bila tidak diberikan, memakai PrismaService milik service ini.
   */
  async getDeletionEligibility(
    userId: string,
    db?: Pick<PrismaService, 'order' | 'walletTransaction' | 'wallet'>,
  ): Promise<{ eligible: boolean; blockers: DeletionBlocker[] }> {
    const prisma = db ?? this.prisma;
    const blockers: DeletionBlocker[] = [];

    const disputedOrderCount = await prisma.order.count({
      where: {
        OR: [{ buyerId: userId }, { sellerId: userId }],
        status: 'DISPUTED',
      },
    });
    if (disputedOrderCount > 0) {
      blockers.push({
        code: ErrorCodes.ACTIVE_ORDERS_PRESENT,
        message: `Anda memiliki ${disputedOrderCount} sengketa yang sedang berjalan. Tunggu hingga sengketa selesai sebelum menghapus akun.`,
      });
    }

    const activeOrderCount = await prisma.order.count({
      where: {
        OR: [{ buyerId: userId }, { sellerId: userId }],
        status: { notIn: ['COMPLETED', 'CANCELLED', 'DISPUTED'] },
      },
    });
    if (activeOrderCount > 0) {
      blockers.push({
        code: ErrorCodes.ACTIVE_ORDERS_PRESENT,
        message: `Anda memiliki ${activeOrderCount} pesanan aktif. Selesaikan atau batalkan semua pesanan sebelum menghapus akun.`,
      });
    }

    const pendingWithdrawalCount = await prisma.walletTransaction.count({
      where: {
        type: 'WITHDRAW',
        withdrawStatus: { in: ['PENDING_OTP', 'PENDING_PROCESS', 'PROCESSING'] },
        wallet: { userId },
      },
    });
    if (pendingWithdrawalCount > 0) {
      blockers.push({
        code: ErrorCodes.ACTIVE_ORDERS_PRESENT,
        message: 'Anda memiliki penarikan dana yang sedang diproses. Tunggu hingga selesai sebelum menghapus akun.',
      });
    }

    const wallet = await prisma.wallet.findUnique({ where: { userId } });
    if (wallet && (wallet.escrowBalance > BigInt(0) || wallet.availableBalance > BigInt(0) || wallet.totalBalance > BigInt(0))) {
      blockers.push({
        code: wallet.escrowBalance > BigInt(0) ? ErrorCodes.ESCROW_BALANCE_PRESENT : ErrorCodes.WALLET_BALANCE_PRESENT,
        message: wallet.escrowBalance > BigInt(0)
          ? 'Anda memiliki dana yang tertahan di escrow. Selesaikan semua pesanan tertunda sebelum menghapus akun.'
          : 'Anda masih memiliki saldo di dompet. Tarik atau selesaikan saldo sebelum menghapus akun.',
      });
    }

    return { eligible: blockers.length === 0, blockers };
  }

  /** G071: kirim OTP WhatsApp untuk re-auth akun tanpa password sebelum hapus. */
  async sendDeletionRequestOtp(userId: string): Promise<{ message: string }> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, password: true, phoneNumber: true },
    });
    if (!user) throw new NotFoundException({ code: ErrorCodes.USER_NOT_FOUND, message: 'User not found' });
    if (user.password) {
      throw new BadRequestException({
        code: ErrorCodes.VALIDATION_ERROR,
        message: 'Akun ini memakai kata sandi — gunakan kata sandi untuk verifikasi.',
      });
    }
    const phone = await decryptPiiSafe(user.phoneNumber);
    if (!phone) {
      throw new BadRequestException({ code: ErrorCodes.RECOVERY_ESCALATION, message: 'Nomor HP tidak tersedia.' });
    }
    await this.sendDeletionOtpInternal(phone, userId, 'deletion_request');
    return { message: 'Kode verifikasi telah dikirim via WhatsApp ke nomor terdaftar Anda.' };
  }

  /** G071: verifikasi OTP re-auth untuk akun tanpa password (consume sekali pakai). */
  async verifyDeletionRequestOtp(userId: string, otpCode: string): Promise<void> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, phoneNumber: true },
    });
    if (!user) throw new NotFoundException({ code: ErrorCodes.USER_NOT_FOUND, message: 'User not found' });
    const phone = await decryptPiiSafe(user.phoneNumber);
    if (!phone) {
      throw new BadRequestException({ code: ErrorCodes.RECOVERY_ESCALATION, message: 'Nomor HP tidak tersedia.' });
    }
    const verification = await this.otpService.verifyPhoneOtpWithMetadata(phone, OtpType.SENSITIVE_ACTION, otpCode);
    const metadata = verification.metadata as { purpose?: string; userId?: string } | undefined;
    if (!verification.valid || metadata?.purpose !== 'deletion_request' || metadata?.userId !== userId) {
      throw new BadRequestException({ code: ErrorCodes.OTP_INVALID, message: 'Kode verifikasi salah atau kedaluwarsa.' });
    }
  }

  private async sendDeletionOtpInternal(phone: string, userId: string, purpose: 'deletion_request' | 'deletion_status', requestId?: string): Promise<void> {
    if (!this.otpGateway.supportsMethod('WHATSAPP')) {
      throw new ServiceUnavailableException({
        code: ErrorCodes.RECOVERY_ESCALATION,
        message: 'Pengiriman OTP WhatsApp sedang tidak tersedia. Hubungi support dengan kode referensi Anda.',
      });
    }
    const otp = await this.otpService.generatePhoneOtp(
      phone,
      OtpType.SENSITIVE_ACTION,
      'WHATSAPP',
      userId,
      { purpose, userId, ...(requestId ? { requestId } : {}) } as Prisma.InputJsonValue,
    );
    let delivery: { success: boolean; error?: string };
    try {
      delivery = await this.otpGateway.sendOtp(phone, otp, 'WHATSAPP');
    } catch {
      await this.otpService.invalidatePhoneOtps(phone, OtpType.SENSITIVE_ACTION).catch(() => undefined);
      throw new ServiceUnavailableException({
        code: ErrorCodes.RECOVERY_ESCALATION,
        message: 'Pengiriman OTP gagal. Hubungi support dengan kode referensi Anda (jalur eskalasi manual).',
      });
    }
    if (!delivery.success) {
      await this.otpService.invalidatePhoneOtps(phone, OtpType.SENSITIVE_ACTION).catch(() => undefined);
      throw new ServiceUnavailableException({
        code: ErrorCodes.RECOVERY_ESCALATION,
        message: `Pengiriman OTP gagal (${delivery.error ?? 'unknown'}). Hubungi support dengan kode referensi Anda (jalur eskalasi manual).`,
      });
    }
  }

  // ─────────────────────────────────────────────────────────────────
  // Pembuatan request (G072): idempoten via idempotencyKey; bila user
  // sudah punya request aktif, kembalikan yang sama (tanpa duplikat).
  // ─────────────────────────────────────────────────────────────────
  async findExistingRequest(userId: string, idempotencyKey?: string) {
    if (idempotencyKey) {
      const byKey = await this.prisma.accountDeletionRequest.findUnique({ where: { idempotencyKey } });
      if (byKey && byKey.userId === userId) return byKey;
      // Kunci milik user lain → konflik (jangan bocorkan data).
      if (byKey) throw new ConflictException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Idempotency key sudah dipakai.' });
    }
    return this.prisma.accountDeletionRequest.findFirst({
      where: { userId, status: { in: ACTIVE_DELETION_STATUSES } },
      orderBy: { requestedAt: 'desc' },
    });
  }

  async createRequest(
    tx: Prisma.TransactionClient,
    userId: string,
    opts: { idempotencyKey: string; reason?: string },
  ): Promise<DeletionRequestResult> {
    const requestedAt = new Date();
    const purgeAt = computePurgeAt(requestedAt);

    // referenceCode unik — retry kecil bila tabrakan (sangat jarang).
    let referenceCode = '';
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const candidate = generateDeletionReferenceCode();
      const clash = await tx.accountDeletionRequest.findUnique({ where: { referenceCode: candidate } });
      if (!clash) {
        referenceCode = candidate;
        break;
      }
    }
    if (!referenceCode) {
      throw new InternalServerErrorException({ code: ErrorCodes.INTERNAL_ERROR, message: 'Gagal membuat kode referensi.' });
    }

    const request = await tx.accountDeletionRequest.create({
      data: {
        userId,
        referenceCode,
        status: DeletionRequestStatus.REQUESTED,
        idempotencyKey: opts.idempotencyKey,
        requestedAt,
        purgeAt,
      },
    });
    await this.writeStatusHistory(tx, request.id, null, DeletionRequestStatus.REQUESTED, 'USER', userId, opts.reason);

    return {
      message: 'Permintaan penghapusan akun diterima. Akun Anda akan dihapus permanen dalam 30 hari.',
      referenceCode,
      status: request.status,
      requestedAt,
      purgeAt,
      serverNow: new Date(),
    };
  }

  async writeStatusHistory(
    tx: Prisma.TransactionClient,
    requestId: string,
    fromStatus: DeletionRequestStatus | null,
    toStatus: DeletionRequestStatus,
    actorType: 'USER' | 'SYSTEM' | 'ADMIN',
    actorUserId?: string,
    reason?: string,
  ): Promise<void> {
    // G062: append-only — tidak ada update/delete history di seluruh kode.
    await tx.accountDeletionStatusHistory.create({
      data: { requestId, fromStatus, toStatus, actorType, actorUserId, reason },
    });
  }

  /** Notifikasi email + in-app saat request dibuat (G057) — best-effort. */
  async notifyRequestCreated(userId: string, result: DeletionRequestResult): Promise<void> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { email: true, phoneNumber: true },
    });
    const purgeDate = result.purgeAt.toLocaleDateString('id-ID', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Asia/Jakarta' });

    const title = 'Permintaan penghapusan akun diterima';
    const body =
      `Kode referensi: ${result.referenceCode}. ` +
      `Akun Anda akan dihapus permanen pada ${purgeDate}. ` +
      `Profil publik Anda sudah disembunyikan. ` +
      `Untuk membatalkan, buka aplikasi Kahade → Masuk → "Akun dihapus? Pulihkan di sini" sebelum tanggal tersebut.`;

    // G059: in-app notification record selalu dibuat (tidak bergantung push token).
    try {
      await this.prisma.notification.create({
        data: {
          notifId: generateNotifId(),
          userId,
          type: NotificationType.SYSTEM_ANNOUNCEMENT,
          category: getCategoryForType(NotificationType.SYSTEM_ANNOUNCEMENT),
          title,
          body,
          isRead: false,
          refType: 'ACCOUNT_DELETION',
          refId: result.referenceCode,
        },
      });
    } catch (err) {
      this.logger.warn(`[deletion] in-app notification failed for ${userId}: ${err instanceof Error ? err.message : String(err)}`);
    }

    if (user?.email) {
      try {
        await this.emailQueue.add(
          'send',
          {
            to: user.email,
            subject: 'Kahade — Permintaan penghapusan akun',
            templateName: 'account-deletion',
            templateContext: {
              referenceCode: result.referenceCode,
              purgeDate,
              daysRemaining: DELETION_GRACE_PERIOD_DAYS,
            },
          } as EmailJobData,
          { attempts: 3, backoff: { type: 'exponential', delay: 5000 }, removeOnComplete: 100, removeOnFail: 50 },
        );
      } catch (err) {
        this.logger.warn(`[deletion] email enqueue failed for ${userId}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  toResult(request: { referenceCode: string; status: DeletionRequestStatus; requestedAt: Date; purgeAt: Date }): DeletionRequestResult {
    return {
      message: 'Permintaan penghapusan akun diterima. Akun Anda akan dihapus permanen dalam 30 hari.',
      referenceCode: request.referenceCode,
      status: request.status,
      requestedAt: request.requestedAt,
      purgeAt: request.purgeAt,
      serverNow: new Date(),
    };
  }

  // ─────────────────────────────────────────────────────────────────
  // Status pra-login (G052): kirim OTP → verifikasi → status lengkap
  // + deletionToken sekali-pakai. TIDAK membuat sesi login.
  // ─────────────────────────────────────────────────────────────────
  private async resolveUserByIdentifier(identifier: { phoneNumber?: string; email?: string }) {
    const { phoneNumber, email } = identifier;
    if (email && email.includes('@')) {
      return this.prisma.user.findUnique({ where: { email: email.trim().toLowerCase() } });
    }
    if (phoneNumber) {
      const normalized = normalizeIndonesianPhone(phoneNumber.trim());
      const phoneHash = hashPhoneNumber(normalized);
      return this.prisma.user.findFirst({
        where: { OR: [{ phoneNumberHash: phoneHash }, { phoneNumber: normalized }] },
      });
    }
    return null;
  }

  private maskPhone(phone: string): string {
    if (phone.length <= 7) return '•••••••';
    return `${phone.slice(0, 4)}••••${phone.slice(-3)}`;
  }

  async requestStatusOtp(identifier: { phoneNumber?: string; email?: string }): Promise<{ requiresOtp: boolean; maskedPhone?: string }> {
    if (!identifier.phoneNumber && !identifier.email) {
      throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Nomor HP atau email wajib diisi.' });
    }
    const user = await this.resolveUserByIdentifier(identifier);
    if (!user) return { requiresOtp: false };

    const request = await this.prisma.accountDeletionRequest.findFirst({
      where: { userId: user.id, status: { in: ACTIVE_DELETION_STATUSES } },
      orderBy: { requestedAt: 'desc' },
    });
    if (!request) return { requiresOtp: false };

    const phone = await decryptPiiSafe(user.phoneNumber);
    if (!phone) {
      // G065: nomor tak aktif/tak tersedia → eskalasi manual, jangan bypass.
      throw new ServiceUnavailableException({
        code: ErrorCodes.RECOVERY_ESCALATION,
        message: `Nomor WhatsApp terdaftar tidak tersedia. Hubungi support Kahade dengan kode referensi ${request.referenceCode} untuk verifikasi manual.`,
      });
    }

    try {
      await this.sendDeletionOtpInternal(phone, user.id, 'deletion_status', request.id);
    } catch (err) {
      if (err instanceof ServiceUnavailableException) {
        // Sertakan referenceCode agar user bisa eskalasi ke support (G065).
        const body = err.getResponse() as { message?: string };
        throw new ServiceUnavailableException({
          code: ErrorCodes.RECOVERY_ESCALATION,
          message: `${body?.message ?? 'Pengiriman OTP gagal.'} Kode referensi Anda: ${request.referenceCode}.`,
        });
      }
      throw err;
    }
    return { requiresOtp: true, maskedPhone: this.maskPhone(phone) };
  }

  async verifyStatusOtp(
    identifier: { phoneNumber?: string; email?: string },
    otp: string,
  ): Promise<{
    referenceCode: string;
    status: DeletionRequestStatus;
    requestedAt: Date;
    purgeAt: Date;
    daysRemaining: number;
    serverNow: Date;
    deletionToken: string;
    deletionTokenExpiresIn: number;
  }> {
    const user = await this.resolveUserByIdentifier(identifier);
    if (!user) {
      throw new BadRequestException({ code: ErrorCodes.OTP_INVALID, message: 'Kode verifikasi salah atau kedaluwarsa.' });
    }
    const request = await this.prisma.accountDeletionRequest.findFirst({
      where: { userId: user.id, status: { in: ACTIVE_DELETION_STATUSES } },
      orderBy: { requestedAt: 'desc' },
    });
    if (!request) {
      throw new NotFoundException({ code: ErrorCodes.DELETION_REQUEST_NOT_FOUND, message: 'Tidak ada permintaan penghapusan aktif untuk akun ini.' });
    }
    const phone = await decryptPiiSafe(user.phoneNumber);
    if (!phone) {
      throw new ServiceUnavailableException({
        code: ErrorCodes.RECOVERY_ESCALATION,
        message: `Nomor WhatsApp terdaftar tidak tersedia. Hubungi support Kahade dengan kode referensi ${request.referenceCode} untuk verifikasi manual.`,
      });
    }

    const verification = await this.otpService.verifyPhoneOtpWithMetadata(phone, OtpType.SENSITIVE_ACTION, otp);
    const metadata = verification.metadata as { purpose?: string; userId?: string; requestId?: string } | undefined;
    if (
      !verification.valid ||
      metadata?.purpose !== 'deletion_status' ||
      metadata?.userId !== user.id ||
      metadata?.requestId !== request.id
    ) {
      throw new BadRequestException({ code: ErrorCodes.OTP_INVALID, message: 'Kode verifikasi salah atau kedaluwarsa.' });
    }

    const deletionToken = this.issueDeletionToken(user.id, request.id);
    const now = new Date();
    const daysRemaining = Math.max(0, Math.ceil((request.purgeAt.getTime() - now.getTime()) / (24 * 60 * 60 * 1000)));
    return {
      referenceCode: request.referenceCode,
      status: request.status,
      requestedAt: request.requestedAt,
      purgeAt: request.purgeAt,
      daysRemaining,
      serverNow: now,
      deletionToken,
      deletionTokenExpiresIn: DELETION_CANCEL_TTL_SECONDS,
    };
  }

  private issueDeletionToken(userId: string, requestId: string): string {
    const tempSecret = this.configService.get<string>('jwt.tempSecret');
    if (!tempSecret) {
      throw new InternalServerErrorException({ code: ErrorCodes.INTERNAL_ERROR, message: 'Deletion token secret belum dikonfigurasi.' });
    }
    return this.jwtService.sign(
      { sub: userId, scope: DELETION_CANCEL_SCOPE, requestId, jti: nanoid(), iss: TOKEN_ISSUER, aud: DELETION_CANCEL_AUDIENCE },
      { secret: tempSecret, expiresIn: `${DELETION_CANCEL_TTL_SECONDS}s`, algorithm: 'HS256' },
    );
  }

  private verifyDeletionToken(token: string): { userId: string; requestId: string } {
    const tempSecret = this.configService.get<string>('jwt.tempSecret');
    if (!tempSecret) {
      throw new InternalServerErrorException({ code: ErrorCodes.INTERNAL_ERROR, message: 'Deletion token secret belum dikonfigurasi.' });
    }
    try {
      const payload = this.jwtService.verify(token, {
        secret: tempSecret,
        audience: DELETION_CANCEL_AUDIENCE,
        issuer: TOKEN_ISSUER,
      }) as { sub?: string; scope?: string; requestId?: string };
      if (payload.scope !== DELETION_CANCEL_SCOPE || !payload.sub || !payload.requestId) {
        throw new ForbiddenException({ code: ErrorCodes.INVALID_TOKEN, message: 'Token pembatalan tidak valid.' });
      }
      return { userId: payload.sub, requestId: payload.requestId };
    } catch (err) {
      if (err instanceof ForbiddenException) throw err;
      throw new ForbiddenException({ code: ErrorCodes.INVALID_TOKEN, message: 'Token pembatalan tidak valid atau kedaluwarsa.' });
    }
  }

  // ─────────────────────────────────────────────────────────────────
  // Pembatalan (G053/G054/G055/G064): token sekali-pakai → reaktivasi
  // transaksional. Sesi lama TETAP revoked — user login ulang normal.
  // ─────────────────────────────────────────────────────────────────
  async cancelDeletion(deletionToken: string, cancelReason?: string): Promise<{
    message: string;
    referenceCode: string;
    status: DeletionRequestStatus;
    reactivatedAt: Date;
    serverNow: Date;
  }> {
    const { userId, requestId } = this.verifyDeletionToken(deletionToken);

    const result = await this.prisma.$transaction(async (tx) => {
      const request = await tx.accountDeletionRequest.findUnique({ where: { id: requestId } });
      if (!request || request.userId !== userId) {
        throw new NotFoundException({ code: ErrorCodes.DELETION_REQUEST_NOT_FOUND, message: 'Permintaan penghapusan tidak ditemukan.' });
      }
      // Idempoten: sudah CANCELLED → kembalikan status yang sama.
      if (request.status === DeletionRequestStatus.CANCELLED) {
        return { request, reactivated: false as boolean };
      }
      if (!ACTIVE_DELETION_STATUSES.includes(request.status)) {
        throw new ConflictException({
          code: ErrorCodes.DELETION_REQUEST_NOT_ACTIVE,
          message: `Permintaan sudah ${request.status} dan tidak dapat dibatalkan.`,
        });
      }

      const cancelledAt = new Date();
      const updated = await tx.accountDeletionRequest.update({
        where: { id: requestId },
        data: { status: DeletionRequestStatus.CANCELLED, cancelledAt, cancelReason: cancelReason?.slice(0, 500) ?? null },
      });
      await this.writeStatusHistory(tx, requestId, request.status, DeletionRequestStatus.CANCELLED, 'USER', userId, cancelReason);

      // Reaktivasi: isActive=true, deletedAt=null. Sesi lama TIDAK dipulihkan.
      await tx.user.update({
        where: { id: userId },
        data: { isActive: true, deletedAt: null },
      });
      return { request: updated, reactivated: true as boolean };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });

    // Notifikasi in-app (best-effort) — akun kini aktif kembali.
    try {
      await this.prisma.notification.create({
        data: {
          notifId: generateNotifId(),
          userId,
          type: NotificationType.SYSTEM_ANNOUNCEMENT,
          category: getCategoryForType(NotificationType.SYSTEM_ANNOUNCEMENT),
          title: 'Penghapusan akun dibatalkan',
          body: `Permintaan penghapusan akun (${result.request.referenceCode}) telah dibatalkan. Akun Anda aktif kembali — silakan masuk ulang.`,
          isRead: false,
          refType: 'ACCOUNT_DELETION',
          refId: result.request.referenceCode,
        },
      });
    } catch (err) {
      this.logger.warn(`[deletion] cancel notification failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    return {
      message: 'Penghapusan akun dibatalkan. Akun Anda aktif kembali — silakan masuk ulang.',
      referenceCode: result.request.referenceCode,
      status: result.request.status,
      reactivatedAt: result.request.cancelledAt ?? new Date(),
      serverNow: new Date(),
    };
  }


  // ─────────────────────────────────────────────────────────────────
  // Pengingat H-7 & H-1 (G058/G059): implementasi KANONIS ada di
  // DataCleanupService.processDeletionReminders (dipanggil scheduler
  // harian; diuji di data-cleanup-deletion.spec.ts). Versi duplikat di
  // sini DIHAPUS 2026-09-27 agar tidak ada dua sumber kebenaran.
  // ─────────────────────────────────────────────────────────────────

  /** Kunci redis per-user untuk purge (G056) — dipakai data-cleanup.service. */
  purgeLockKey(userId: string): string {
    return DELETION_PURGE_LOCK(userId);
  }
}
