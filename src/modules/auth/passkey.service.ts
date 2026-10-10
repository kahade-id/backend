import {
  Injectable,
  BadRequestException,
  UnauthorizedException,
  NotFoundException,
  ConflictException,
  ServiceUnavailableException,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service';
import { RedisService } from '../../redis/redis.service';
import { TokenService } from './token.service';
import { OtpService } from './otp.service';
import { OtpGatewayService } from './otp-gateway.service';
import { AuthService } from './auth.service';
import { AuditLogService } from '../../common/services/audit-log.service';
import { OtpType, NotificationType, UserAuditAction } from '@prisma/client';
import { getCategoryForType } from '../notifications/notification-category.map';
import { generateNotifId } from '../../common/utils/id-generator.util';
import { decryptPiiSafe, hashPhoneNumber, normalizePhoneNumber } from '../../common/utils/pii.util';
import { PASSKEY_RECOVER_COOLDOWN, PASSKEY_RECOVER_RATE } from '../../common/constants/redis-keys';
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
  type RegistrationResponseJSON,
  type AuthenticationResponseJSON,
} from '@simplewebauthn/server';
import { randomUUID } from 'crypto';
import {
  PasskeyRegisterOptionsDto,
  PasskeyRegisterVerifyDto,
  PasskeyAuthOptionsDto,
  PasskeyAuthVerifyDto,
  PasskeyRenameDto,
  PasskeyRevokeDto,
  PasskeyRecoverDto,
} from './dto/passkey.dto';

// ═══════════════════════════════════════════════════════════════════
// Helpers base64url (tanpa dependency tambahan di server)
// ═══════════════════════════════════════════════════════════════════
function uint8ToBase64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url');
}

function base64UrlToUint8(value: string): Uint8Array<ArrayBuffer> {
  // new Uint8Array(Buffer) menyalin — aman dari pool ArrayBuffer Node.
  return new Uint8Array(Buffer.from(value, 'base64url'));
}

export interface PasskeySummary {
  id: string;
  deviceName: string;
  deviceType: string | null;
  createdAt: Date;
  lastUsedAt: Date | null;
}

interface StoredChallenge {
  challenge: string;
  type: 'registration' | 'authentication';
  userId: string | null;
}

// Audit Auth 2026-10-10 (#BE-44): OTP pemulihan passkey — cooldown 60 d per
// user + maks 3 permintaan/jam (Redis). Sebelumnya hanya throttle rute 5/menit.
const RECOVER_COOLDOWN_SECONDS = 60;
const RECOVER_RATE_LIMIT = 3;
const RECOVER_RATE_WINDOW_SECONDS = 3600;

function tooManyRequests(message: string, retryAfterSeconds: number): HttpException {
  return new HttpException(
    {
      statusCode: HttpStatus.TOO_MANY_REQUESTS,
      code: 'TOO_MANY_REQUESTS',
      message,
      retryAfter: retryAfterSeconds,
    },
    HttpStatus.TOO_MANY_REQUESTS,
  );
}

/**
 * PasskeyService — WebAuthn/passkey Kahade (GAP-A: G026–G050).
 *
 * Keputusan keamanan non-obvious (didokumentasikan di /tmp/gap-a-passkey.md):
 *  - Challenge sekali-pakai & atomik: disimpan di Redis (SET NX, TTL 5 mnt),
 *    dikonsumsi via getAndDelete (Lua get+del atomik) — anti-replay (G031).
 *  - Counter: assertion DITOLAK bila counter baru <= counter tersimpan,
 *    KECUALI 0/0 (passkey tersinkron multi-perangkat seperti iCloud Keychain
 *    lazim melaporkan counter 0 — menolaknya akan merusak passkey sync yang
 *    sah). Anomali counter → tolak + wajib re-auth penuh + notifikasi (G046).
 *  - Login passkey: bila 2FA aktif, tetap minta TOTP (passkey + TOTP),
 *    kecuali perangkat sudah dipercaya — sama seperti login password (G030).
 *  - Revoke bersifat soft (revokedAt) untuk jejak audit (G037); kredensial
 *    terakhir tidak boleh dihapus bila tidak ada metode login lain (G038).
 *  - Private key TIDAK PERNAH dikirim ke server — klien hanya mengirim
 *    attestation/assertion (G041).
 */
@Injectable()
export class PasskeyService {
  private readonly logger = new Logger(PasskeyService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly config: ConfigService,
    private readonly tokenService: TokenService,
    private readonly otpService: OtpService,
    private readonly otpGateway: OtpGatewayService,
    private readonly authService: AuthService,
    private readonly auditLog: AuditLogService,
  ) {}

  // ── Konfigurasi RP (G032, G044) ──────────────────────────────────

  private rpId(): string {
    return this.config.get<string>('webauthn.rpId') ?? 'localhost';
  }

  private rpName(): string {
    return this.config.get<string>('webauthn.rpName') ?? 'Kahade';
  }

  private origins(): string[] {
    return this.config.get<string[]>('webauthn.origins') ?? [];
  }

  private challengeTtl(): number {
    return this.config.get<number>('webauthn.challengeTtlSeconds') ?? 300;
  }

  private maxPerUser(): number {
    return this.config.get<number>('webauthn.maxPerUser') ?? 10;
  }

  /** Kebijakan aksi berisiko dari PASSKEY_REQUIRED_FOR (G044). */
  getRequiredForActions(): string[] {
    return this.config.get<string[]>('webauthn.requiredFor') ?? ['bank_account_change', 'security_change'];
  }

  /**
   * G040: gerbang kebijakan untuk aksi berisiko (ubah rekening, ubah keamanan).
   *
   * Cara pakai (titik integrasi yang disarankan):
   *   await this.passkeyService.requireRecentPasskeyOrReauth(
   *     userId, 'bank_account_change', { password, mfaCode, otpCode, reauthToken },
   *   );
   * di awal handler endpoint aksi berisiko.
   *
   * Perilaku: bila `action` tidak ada di PASSKEY_REQUIRED_FOR → lolos.
   * Bila ada DAN user punya passkey aktif → wajibkan bukti re-auth kuat
   * (password/OTP/TOTP/reauthToken via assertPasskeyReauthenticated).
   * Bila user belum punya passkey, kebijakan passkey tidak berlaku
   * (re-auth standar endpoint masing-masing tetap jalan).
   */
  async requireRecentPasskeyOrReauth(
    userId: string,
    action: string,
    reauth: { password?: string; mfaCode?: string; otpCode?: string; reauthToken?: string },
  ): Promise<void> {
    if (!this.getRequiredForActions().includes(action)) return;
    const activeCount = await this.prisma.passkeyCredential.count({
      where: { userId, revokedAt: null },
    });
    if (activeCount === 0) return;
    await this.authService.assertPasskeyReauthenticated(userId, reauth);
  }

  private assertWebauthnEnabled(): void {
    const enabled = (process.env.WEBAUTHN_ENABLED ?? 'true') === 'true';
    if (!enabled || this.origins().length === 0) {
      throw new BadRequestException({
        code: 'WEBAUTHN_NOT_SUPPORTED',
        message:
          'Passkey belum diaktifkan di server ini. Silakan masuk dengan kata sandi atau OTP WhatsApp.',
      });
    }
  }

  // ── Challenge sekali-pakai (G027, G031) ───────────────────────────

  private challengeKey(userId: string | null, challengeId: string): string {
    return `passkey:challenge:${userId ?? 'anon'}:${challengeId}`;
  }

  /**
   * Simpan challenge dengan SET NX (G027): tidak menimpa bila sudah ada.
   * Kegagalan Redis di sini bersifat fail-closed — tanpa challenge yang
   * tersimpan aman, alur WebAuthn tidak boleh lanjut.
   */
  private async storeChallenge(
    userId: string | null,
    type: StoredChallenge['type'],
    challenge: string,
    // Audit Auth 2026-10-10 (#BE-42): userId yang DIIKAT ke payload boleh
    // berbeda dari namespace key (auth memakai namespace anon tetapi tetap
    // mengikat challenge ke akun yang di-resolve dari identifier).
    boundUserId: string | null = userId,
  ): Promise<string> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const challengeId = randomUUID();
      const payload: StoredChallenge = { challenge, type, userId: boundUserId };
      const stored = await this.redis.setNx(
        this.challengeKey(userId, challengeId),
        JSON.stringify(payload),
        this.challengeTtl(),
        { throwOnError: true },
      );
      if (stored) return challengeId;
    }
    throw new ServiceUnavailableException({
      code: 'PASSKEY_CHALLENGE_FAILED',
      message: 'Gagal menyiapkan tantangan passkey. Silakan coba lagi.',
    });
  }

  /**
   * Konsumsi challenge secara atomik (GETDEL via Lua — G031).
   * Mengembalikan null bila tidak ada / kedaluwarsa / sudah dipakai.
   */
  private async consumeChallenge(
    userId: string | null,
    challengeId: string,
    expectedType: StoredChallenge['type'],
  ): Promise<StoredChallenge> {
    const raw = await this.redis.getAndDelete(this.challengeKey(userId, challengeId));
    if (!raw) {
      throw new BadRequestException({
        code: 'PASSKEY_CHALLENGE_INVALID',
        message:
          'Tantangan passkey kedaluwarsa atau sudah dipakai. Minta opsi baru dan coba lagi.',
      });
    }
    let parsed: StoredChallenge;
    try {
      parsed = JSON.parse(raw) as StoredChallenge;
    } catch {
      throw new BadRequestException({
        code: 'PASSKEY_CHALLENGE_INVALID',
        message: 'Tantangan passkey tidak valid. Minta opsi baru dan coba lagi.',
      });
    }
    if (parsed.type !== expectedType || !parsed.challenge) {
      throw new BadRequestException({
        code: 'PASSKEY_CHALLENGE_INVALID',
        message: 'Tantangan passkey tidak cocok. Minta opsi baru dan coba lagi.',
      });
    }
    return parsed;
  }

  // ── REGISTRASI (G027, G028) ───────────────────────────────────────

  async getRegistrationOptions(
    userId: string,
    dto: PasskeyRegisterOptionsDto,
    ipAddress: string,
  ): Promise<{ challengeId: string; options: unknown }> {
    this.assertWebauthnEnabled();
    await this.authService.assertPasskeyReauthenticated(userId, dto);

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, username: true, email: true, fullName: true, isActive: true, isBanned: true },
    });
    if (!user || !user.isActive || user.isBanned) {
      throw new UnauthorizedException({
        code: 'INVALID_CREDENTIALS',
        message: 'Kredensial tidak valid.',
      });
    }

    const activeCount = await this.prisma.passkeyCredential.count({
      where: { userId, revokedAt: null },
    });
    if (activeCount >= this.maxPerUser()) {
      throw new BadRequestException({
        code: 'PASSKEY_LIMIT_REACHED',
        message: `Batas maksimal ${this.maxPerUser()} passkey per akun tercapai. Hapus salah satu untuk menambah yang baru.`,
      });
    }

    const existing = await this.prisma.passkeyCredential.findMany({
      where: { userId, revokedAt: null },
      select: { credentialId: true },
    });

    const options = await generateRegistrationOptions({
      rpName: this.rpName(),
      rpID: this.rpId(),
      userName: user.username ?? user.email ?? user.id,
      userID: new TextEncoder().encode(user.id),
      userDisplayName: user.fullName || undefined,
      attestationType: 'none',
      authenticatorSelection: { residentKey: 'preferred', userVerification: 'preferred' },
      excludeCredentials: existing.map(c => ({ id: c.credentialId })),
    });

    const challengeId = await this.storeChallenge(userId, 'registration', options.challenge);
    this.logger.log(`[PASSKEY] registration options issued for user ${userId} (ip ${ipAddress})`);
    return { challengeId, options };
  }

  async verifyRegistration(
    userId: string,
    dto: PasskeyRegisterVerifyDto,
    ipAddress: string,
  ): Promise<PasskeySummary> {
    this.assertWebauthnEnabled();
    const stored = await this.consumeChallenge(userId, dto.challengeId, 'registration');
    if (stored.userId !== userId) {
      throw new BadRequestException({
        code: 'PASSKEY_CHALLENGE_INVALID',
        message: 'Tantangan passkey tidak cocok. Minta opsi baru dan coba lagi.',
      });
    }

    let verified;
    try {
      verified = await verifyRegistrationResponse({
        response: dto.attestation as unknown as RegistrationResponseJSON,
        expectedChallenge: stored.challenge,
        expectedOrigin: this.origins(),
        expectedRPID: this.rpId(),
        requireUserVerification: true,
      });
    } catch (err) {
      this.auditLog.logUserAction({
        userId,
        action: UserAuditAction.PASSKEY_FAILED,
        entityType: 'PasskeyCredential',
        entityId: userId,
        description: `Passkey registration failed: ${(err as Error).message}`,
        ipAddress,
      });
      throw new BadRequestException({
        code: 'PASSKEY_ATTESTATION_INVALID',
        message: 'Verifikasi passkey gagal. Pastikan Anda memakai perangkat & browser yang mendukung passkey.',
      });
    }
    if (!verified.verified || !verified.registrationInfo) {
      throw new BadRequestException({
        code: 'PASSKEY_ATTESTATION_INVALID',
        message: 'Verifikasi passkey gagal.',
      });
    }

    const info = verified.registrationInfo;
    const credentialId = info.credential.id;
    const publicKey = uint8ToBase64Url(info.credential.publicKey);

    const duplicate = await this.prisma.passkeyCredential.findUnique({
      where: { credentialId },
      select: { id: true, userId: true, revokedAt: true },
    });
    if (duplicate && !duplicate.revokedAt) {
      throw new ConflictException({
        code: 'PASSKEY_ALREADY_REGISTERED',
        message: 'Passkey ini sudah terdaftar di akun Anda.',
      });
    }
    if (duplicate && duplicate.userId !== userId) {
      // credentialId global-unik: tidak mungkin milik user lain kecuali anomali data.
      this.auditLog.logUserAction({
        userId,
        action: UserAuditAction.PASSKEY_FAILED,
        entityType: 'PasskeyCredential',
        entityId: duplicate.id,
        description: 'Passkey registration failed: credentialId milik akun lain',
        ipAddress,
      });
      throw new ConflictException({
        code: 'PASSKEY_ALREADY_REGISTERED',
        message: 'Passkey ini sudah terdaftar.',
      });
    }

    // Batas dihitung ulang di sini (bukan hanya saat options): request paralel
    // tidak boleh melewati PASSKEY_MAX_PER_USER.
    const activeCount = await this.prisma.passkeyCredential.count({
      where: { userId, revokedAt: null },
    });
    if (activeCount >= this.maxPerUser() && !duplicate) {
      throw new BadRequestException({
        code: 'PASSKEY_LIMIT_REACHED',
        message: `Batas maksimal ${this.maxPerUser()} passkey per akun tercapai. Hapus salah satu untuk menambah yang baru.`,
      });
    }

    const deviceName = (dto.deviceName || 'Perangkat saya').trim().slice(0, 100);
    // Kredensial yang pernah di-revoke lalu didaftarkan ulang = reaktivasi
    // (kepemilikan private key baru saja dibuktikan lewat upacara attestation),
    // bukan insert baru yang menabrak unique constraint.
    const created = duplicate
      ? await this.prisma.passkeyCredential.update({
          where: { id: duplicate.id },
          data: {
            publicKey,
            counter: BigInt(info.credential.counter ?? 0),
            deviceName,
            deviceType: info.credentialDeviceType ?? null,
            backedUp: info.credentialBackedUp ?? false,
            revokedAt: null,
            lastUsedAt: null,
          },
        })
      : await this.prisma.passkeyCredential.create({
          data: {
            userId,
            credentialId,
            publicKey,
            counter: BigInt(info.credential.counter ?? 0),
            deviceName,
            deviceType: info.credentialDeviceType ?? null,
            backedUp: info.credentialBackedUp ?? false,
          },
        });

    this.auditLog.logUserAction({
      userId,
      action: UserAuditAction.PASSKEY_REGISTERED,
      entityType: 'PasskeyCredential',
      entityId: created.id,
      description: `Passkey didaftarkan (${deviceName})`,
      ipAddress,
    });
    await this.sendSecurityNotification(
      userId,
      'Passkey baru didaftarkan',
      `Sebuah passkey baru ("${deviceName}") baru saja didaftarkan ke akun Kahade Anda. Jika ini bukan Anda, segera hapus dari menu Keamanan.`,
    ).catch(() => undefined);

    return this.toSummary(created);
  }

  // ── LOGIN (G029, G030) ────────────────────────────────────────────

  async getAuthenticationOptions(
    dto: PasskeyAuthOptionsDto,
  ): Promise<{ challengeId: string; options: unknown }> {
    this.assertWebauthnEnabled();

    // Audit Auth 2026-10-10 (#BE-41): endpoint ini publik. Sebelumnya respons
    // berbeda untuk identifier tak dikenal / ada tanpa passkey / ada dengan
    // passkey (+ bocor credentialId) → orakel eksistensi akun. Sekarang
    // respons SELALU seragam tanpa allowCredentials (resident key
    // 'preferred' saat registrasi → browser memakai discoverable credential).
    // Identifier hanya dipakai untuk mengikat challenge ke akun (#BE-42).
    let userId: string | null = null;
    if (dto.username?.trim()) {
      const user = await this.findUserByIdentifier(dto.username.trim());
      if (user) userId = user.id;
    }

    const options = await generateAuthenticationOptions({
      rpID: this.rpId(),
      userVerification: 'preferred',
    });

    // Challenge auth SELALU di namespace anon agar alur discoverable
    // credential (tanpa username) tetap bisa diverifikasi — challengeId acak
    // tidak bisa ditebak pihak lain. Audit Auth 2026-10-10 (#BE-42): userId
    // hasil resolve DISIMPAN di payload dan dicocokkan saat verify (sebelumnya
    // selalu null sehingga pengecekan di verifyAuthentication mati).
    const challengeId = await this.storeChallenge(null, 'authentication', options.challenge, userId);
    return { challengeId, options };
  }

  async verifyAuthentication(
    dto: PasskeyAuthVerifyDto,
    ipAddress: string,
  ): Promise<unknown> {
    this.assertWebauthnEnabled();

    // Konsumsi atomik (GETDEL): challenge kedaluwarsa/sudah dipakai → 400.
    const stored = await this.consumeChallenge(null, dto.challengeId, 'authentication');
    const challengeUserId = stored.userId;

    const credentialId = (dto.assertion as { id?: string }).id;
    if (!credentialId) {
      throw new BadRequestException({
        code: 'PASSKEY_ASSERTION_INVALID',
        message: 'Respons passkey tidak valid.',
      });
    }

    const credential = await this.prisma.passkeyCredential.findUnique({
      where: { credentialId },
      include: {
        user: {
          select: {
            id: true, isActive: true, isBanned: true, lockedUntil: true,
            phoneVerified: true,
          },
        },
      },
    });
    if (!credential || credential.revokedAt || !credential.user) {
      this.auditLog.logUserAction({
        action: UserAuditAction.PASSKEY_FAILED,
        entityType: 'PasskeyCredential',
        entityId: (dto.assertion as { id?: string } | undefined)?.id ?? 'unknown',
        description: 'Passkey login failed: unknown credential',
        ipAddress,
      });
      throw new UnauthorizedException({
        code: 'INVALID_CREDENTIALS',
        message: 'Kredensial tidak valid.',
      });
    }
    if (challengeUserId && credential.userId !== challengeUserId) {
      throw new UnauthorizedException({
        code: 'INVALID_CREDENTIALS',
        message: 'Kredensial tidak valid.',
      });
    }

    const user = credential.user;
    if (!user.isActive || user.isBanned) {
      throw new UnauthorizedException({ code: 'INVALID_CREDENTIALS', message: 'Kredensial tidak valid.' });
    }
    if (user.lockedUntil && user.lockedUntil > new Date()) {
      throw new UnauthorizedException({
        code: 'ACCOUNT_LOCKED',
        message: 'Akun dikunci sementara karena terlalu banyak percobaan gagal.',
      });
    }

    let verification: Awaited<ReturnType<typeof verifyAuthenticationResponse>>;
    try {
      verification = await verifyAuthenticationResponse({
        response: dto.assertion as unknown as AuthenticationResponseJSON,
        expectedChallenge: stored.challenge,
        expectedOrigin: this.origins(),
        expectedRPID: this.rpId(),
        credential: {
          id: credential.credentialId,
          publicKey: base64UrlToUint8(credential.publicKey),
          counter: Number(credential.counter),
        },
        requireUserVerification: true,
      });
    } catch (err) {
      this.auditLog.logUserAction({
        userId: credential.userId,
        action: UserAuditAction.PASSKEY_FAILED,
        entityType: 'PasskeyCredential',
        entityId: credential.id,
        description: `Passkey assertion failed: ${(err as Error).message}`,
        ipAddress,
      });
      throw new UnauthorizedException({
        code: 'PASSKEY_ASSERTION_INVALID',
        message: 'Verifikasi passkey gagal. Coba lagi.',
      });
    }
    if (!verification.verified || !verification.authenticationInfo) {
      throw new UnauthorizedException({
        code: 'PASSKEY_ASSERTION_INVALID',
        message: 'Verifikasi passkey gagal. Coba lagi.',
      });
    }

    // ── Deteksi anomali counter (G046) ──────────────────────────────
    const storedCounter = credential.counter;
    const newCounter = BigInt(verification.authenticationInfo.newCounter ?? 0);
    const isSyncedZeroPair = storedCounter === 0n && newCounter === 0n;
    if (!isSyncedZeroPair && newCounter <= storedCounter) {
      // Kemungkinan kloning authenticator: tolak, wajibkan re-auth penuh,
      // kirim notifikasi keamanan (G046).
      this.auditLog.logUserAction({
        userId: credential.userId,
        action: UserAuditAction.PASSKEY_FAILED,
        entityType: 'PasskeyCredential',
        entityId: credential.id,
        description: `Anomali counter passkey: stored=${storedCounter} new=${newCounter}`,
        ipAddress,
      });
      await this.sendSecurityNotification(
        credential.userId,
        'Aktivitas passkey mencurigakan',
        'Terdeteksi anomali pada passkey Anda (kemungkinan authenticator digandakan). Untuk keamanan, silakan masuk ulang dengan kata sandi atau OTP WhatsApp, lalu periksa daftar passkey di menu Keamanan.',
      ).catch(() => undefined);
      throw new UnauthorizedException({
        code: 'PASSKEY_COUNTER_ANOMALY',
        message:
          'Terdeteksi anomali keamanan pada passkey Anda. Silakan masuk dengan kata sandi atau OTP WhatsApp.',
      });
    }

    // Audit Auth 2026-10-10 (#BE-43): update counter ATOMIK — hanya berhasil
    // bila counter tersimpan masih sama dengan yang dibaca di atas. Dua
    // assertion paralel dari authenticator kloning tidak bisa sama-sama lolos
    // pemeriksaan non-atomik di atas lalu saling menimpa.
    const counterUpdate = await this.prisma.passkeyCredential.updateMany({
      where: { id: credential.id, counter: storedCounter, revokedAt: null },
      data: { counter: newCounter, lastUsedAt: new Date() },
    });
    if (counterUpdate.count === 0) {
      this.auditLog.logUserAction({
        userId: credential.userId,
        action: UserAuditAction.PASSKEY_FAILED,
        entityType: 'PasskeyCredential',
        entityId: credential.id,
        description: `Anomali counter passkey (race): stored=${storedCounter} new=${newCounter}`,
        ipAddress,
      });
      throw new UnauthorizedException({
        code: 'PASSKEY_COUNTER_ANOMALY',
        message:
          'Terdeteksi anomali keamanan pada passkey Anda. Silakan masuk dengan kata sandi atau OTP WhatsApp.',
      });
    }

    this.auditLog.logUserAction({
      userId: credential.userId,
      action: UserAuditAction.PASSKEY_USED,
      entityType: 'PasskeyCredential',
      entityId: credential.id,
      description: `Login dengan passkey (${credential.deviceName})`,
      ipAddress,
    });

    // Terbitkan sesi seperti login normal (G030 → AuthService.loginWithPasskey).
    return this.authService.loginWithPasskey(credential.userId, ipAddress, {
      deviceId: dto.deviceId ?? `passkey-web-${Date.now()}`,
      deviceInfo: dto.deviceInfo,
    });
  }

  // ── MANAJEMEN (G035–G037) ─────────────────────────────────────────

  async listCredentials(userId: string): Promise<PasskeySummary[]> {
    const creds = await this.prisma.passkeyCredential.findMany({
      where: { userId, revokedAt: null },
      orderBy: { createdAt: 'desc' },
      select: { id: true, deviceName: true, deviceType: true, createdAt: true, lastUsedAt: true },
    });
    return creds.map(c => this.toSummary(c));
  }

  async renameCredential(
    userId: string,
    credentialId: string,
    dto: PasskeyRenameDto,
  ): Promise<PasskeySummary> {
    await this.authService.assertPasskeyReauthenticated(userId, dto);
    const deviceName = dto.deviceName.trim().slice(0, 100);
    const existing = await this.prisma.passkeyCredential.findFirst({
      where: { id: credentialId, userId, revokedAt: null },
      select: { id: true },
    });
    if (!existing) {
      throw new NotFoundException({
        code: 'PASSKEY_NOT_FOUND',
        message: 'Passkey tidak ditemukan.',
      });
    }
    const updated = await this.prisma.passkeyCredential.update({
      where: { id: existing.id },
      data: { deviceName },
      select: { id: true, deviceName: true, deviceType: true, createdAt: true, lastUsedAt: true },
    });
    this.auditLog.logUserAction({
      userId,
      action: UserAuditAction.PASSKEY_RENAMED,
      entityType: 'PasskeyCredential',
      entityId: updated.id,
      description: `Passkey diganti nama menjadi "${deviceName}"`,
    });
    return this.toSummary(updated);
  }

  async revokeCredential(
    userId: string,
    credentialId: string,
    dto: PasskeyRevokeDto,
    ipAddress: string,
  ): Promise<{ message: string }> {
    await this.authService.assertPasskeyReauthenticated(userId, dto);
    const credential = await this.prisma.passkeyCredential.findFirst({
      where: { id: credentialId, userId, revokedAt: null },
      select: { id: true, deviceName: true },
    });
    if (!credential) {
      throw new NotFoundException({ code: 'PASSKEY_NOT_FOUND', message: 'Passkey tidak ditemukan.' });
    }

    // G038: tolak bila ini kredensial terakhir DAN tidak ada metode login lain.
    const canRemove = await this.canRemoveAuthMethod(userId, credential.id);
    if (!canRemove) {
      throw new BadRequestException({
        code: 'PASSKEY_LAST_CREDENTIAL',
        message:
          'Ini satu-satunya metode masuk Anda. Tambahkan kata sandi atau tautkan akun lain sebelum menghapus passkey ini.',
      });
    }

    await this.prisma.passkeyCredential.update({
      where: { id: credential.id },
      data: { revokedAt: new Date() },
    });

    this.auditLog.logUserAction({
      userId,
      action: UserAuditAction.PASSKEY_REVOKED,
      entityType: 'PasskeyCredential',
      entityId: credential.id,
      description: `Passkey "${credential.deviceName}" dihapus`,
      ipAddress,
    });
    await this.sendSecurityNotification(
      userId,
      'Passkey dihapus',
      `Passkey "${credential.deviceName}" telah dihapus dari akun Kahade Anda. Jika ini bukan Anda, segera amankan akun Anda.`,
    ).catch(() => undefined);

    return { message: 'Passkey berhasil dihapus.' };
  }

  /**
   * G038: boleh menghapus passkey bila masih ada metode login lain:
   * password terpasang, akun social tertaut, atau passkey aktif lain.
   * SocialAccount dibuat worker A — bila model belum ada, aman via try/catch.
   */
  async canRemoveAuthMethod(userId: string, excludeCredentialId?: string): Promise<boolean> {
    const [user, otherPasskeys, socialCount] = await Promise.all([
      this.prisma.user.findUnique({ where: { id: userId }, select: { password: true } }),
      this.prisma.passkeyCredential.count({
        where: {
          userId,
          revokedAt: null,
          ...(excludeCredentialId ? { id: { not: excludeCredentialId } } : {}),
        },
      }),
      this.countSocialAccounts(userId),
    ]);
    return !!user?.password || otherPasskeys > 0 || socialCount > 0;
  }

  private async countSocialAccounts(userId: string): Promise<number> {
    try {
      const delegate = (
        this.prisma as unknown as Record<string, { count?: (args: unknown) => Promise<number> } | undefined>
      ).socialAccount;
      if (!delegate || typeof delegate.count !== 'function') return 0;
      return await delegate.count({ where: { userId } });
    } catch {
      return 0;
    }
  }

  // ── RECOVERY (G039) ───────────────────────────────────────────────

  /**
   * Dua langkah dalam satu endpoint:
   *  - step=request: kirim OTP WhatsApp ke nomor terdaftar (+ deteksi perangkat baru).
   *  - step=verify: verifikasi OTP → terbitkan reauthToken sementara
   *    (scope passkey_reauth, sekali pakai) untuk dipakai di /register/options.
   */
  async recover(
    userId: string,
    dto: PasskeyRecoverDto,
    ipAddress: string,
  ): Promise<{ message: string; newDevice?: boolean; reauthToken?: string; expiresIn?: number }> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, phoneNumber: true, isActive: true, isBanned: true },
    });
    if (!user || !user.isActive || user.isBanned) {
      throw new UnauthorizedException({ code: 'INVALID_CREDENTIALS', message: 'Kredensial tidak valid.' });
    }
    // Audit Auth 2026-10-10 (#BE-27): `user.phoneNumber` tersimpan TERENKRIPSI
    // (encryptPii) — sebelumnya ciphertext dipakai langsung sebagai tujuan OTP
    // sehingga OTP terkirim ke string acak dan verifikasi selalu gagal.
    const phoneNumber = await decryptPiiSafe(user.phoneNumber);
    if (!phoneNumber) {
      throw new BadRequestException({
        code: 'PHONE_NOT_SET',
        message: 'Nomor HP terdaftar tidak tersedia. Hubungi dukungan Kahade.',
      });
    }

    if (dto.step === 'request') {
      const newDevice = await this.isNewDevice(userId, dto.deviceId);
      if (!this.otpGateway.supportsMethod('WHATSAPP')) {
        throw new ServiceUnavailableException({
          code: 'OTP_DELIVERY_FAILED',
          message: 'Pengiriman OTP sedang tidak tersedia. Coba lagi nanti.',
        });
      }
      // Audit Auth 2026-10-10 (#BE-44): cooldown 60 d per user + maks 3/jam.
      const cooldownKey = PASSKEY_RECOVER_COOLDOWN(userId);
      const cooldownClaimed = await this.redis.setNx(cooldownKey, '1', RECOVER_COOLDOWN_SECONDS);
      if (!cooldownClaimed) {
        throw tooManyRequests(
          `Tunggu ${RECOVER_COOLDOWN_SECONDS} detik sebelum meminta kode pemulihan baru.`,
          RECOVER_COOLDOWN_SECONDS,
        );
      }
      try {
        const hourly = await this.redis.incrWithTtl(PASSKEY_RECOVER_RATE(userId), RECOVER_RATE_WINDOW_SECONDS);
        if (hourly > RECOVER_RATE_LIMIT) {
          throw tooManyRequests(
            'Terlalu banyak permintaan kode pemulihan. Coba lagi dalam satu jam.',
            RECOVER_RATE_WINDOW_SECONDS,
          );
        }
        const otp = await this.otpService.generatePhoneOtp(
          phoneNumber,
          OtpType.SENSITIVE_ACTION,
          'WHATSAPP',
          userId,
          { purpose: 'passkey_recover', userId },
          ipAddress,
        );
        let delivery: { success: boolean; error?: string };
        try {
          delivery = await this.otpGateway.sendOtp(phoneNumber, otp, 'WHATSAPP');
        } catch {
          await this.otpService.invalidatePhoneOtps(phoneNumber, OtpType.SENSITIVE_ACTION).catch(() => undefined);
          throw new ServiceUnavailableException({
            code: 'OTP_DELIVERY_FAILED',
            message: 'Pengiriman OTP sedang tidak tersedia. Coba lagi nanti.',
          });
        }
        if (!delivery.success) {
          await this.otpService.invalidatePhoneOtps(phoneNumber, OtpType.SENSITIVE_ACTION).catch(() => undefined);
          throw new ServiceUnavailableException({
            code: 'OTP_DELIVERY_FAILED',
            message: 'Pengiriman OTP gagal. Coba lagi nanti.',
          });
        }
      } catch (error) {
        // Cooldown dilepas hanya bila OTP gagal dibuat/dikirim (bukan karena
        // batas kuota) agar user sah bisa langsung mencoba lagi.
        const status = error instanceof HttpException ? error.getStatus() : undefined;
        if (status !== HttpStatus.TOO_MANY_REQUESTS) {
          await this.redis.del(cooldownKey).catch(() => undefined);
        }
        throw error;
      }
      this.auditLog.logUserAction({
        userId,
        action: UserAuditAction.PASSKEY_FAILED,
        entityType: 'User',
        entityId: userId,
        description: `OTP pemulihan passkey diminta${newDevice ? ' dari perangkat baru' : ''}`,
        ipAddress,
      });
      return {
        message: 'Kode OTP telah dikirim via WhatsApp ke nomor HP terdaftar Anda.',
        newDevice,
      };
    }

    // step=verify
    if (!dto.otpCode) {
      throw new BadRequestException({ code: 'OTP_REQUIRED', message: 'Kode OTP wajib diisi.' });
    }
    // Audit Auth 2026-10-10 (#BE-27): verifikasi memakai nomor terdekripsi DAN
    // wajib metadata.purpose === 'passkey_recover' + userId cocok — OTP
    // SENSITIVE_ACTION lain (hapus akun, ganti nomor) tidak bisa dipakai
    // sebagai re-auth passkey.
    const otpResult = await this.otpService.verifyPhoneOtpWithMetadata(
      phoneNumber,
      OtpType.SENSITIVE_ACTION,
      dto.otpCode,
    );
    const otpMeta = (otpResult.metadata ?? {}) as { purpose?: unknown; userId?: unknown };
    if (!otpResult.valid || otpMeta.purpose !== 'passkey_recover' || otpMeta.userId !== userId) {
      throw new BadRequestException({
        code: 'INVALID_OTP',
        message: 'Kode OTP salah atau kedaluwarsa.',
      });
    }
    const newDevice = await this.isNewDevice(userId, dto.deviceId);
    if (newDevice) {
      await this.sendSecurityNotification(
        userId,
        'Pemulihan passkey dari perangkat baru',
        'Seseorang (kemungkinan Anda) memulihkan passkey dari perangkat yang belum dikenal. Jika ini bukan Anda, segera amankan akun Anda.',
      ).catch(() => undefined);
    }
    const reauthToken = this.tokenService.signTempToken({
      sub: userId,
      scope: 'passkey_reauth',
      deviceId: dto.deviceId,
    });
    this.auditLog.logUserAction({
      userId,
      action: UserAuditAction.PASSKEY_FAILED,
      entityType: 'User',
      entityId: userId,
      description: 'OTP pemulihan passkey terverifikasi — token re-auth diterbitkan',
      ipAddress,
    });
    return {
      message: 'Verifikasi berhasil. Anda dapat mendaftarkan passkey baru.',
      reauthToken,
      expiresIn: 300,
    };
  }

  /** Pemeriksaan risiko sederhana (G039): perangkat belum pernah terlihat? */
  private async isNewDevice(userId: string, deviceId?: string): Promise<boolean> {
    if (!deviceId) return true;
    try {
      const known = await this.prisma.userDevice.findFirst({
        where: { userId, deviceId },
        select: { id: true },
      });
      return !known;
    } catch {
      return true;
    }
  }

  // ── Util ──────────────────────────────────────────────────────────

  private toSummary(c: {
    id: string;
    deviceName: string;
    deviceType: string | null;
    createdAt: Date;
    lastUsedAt: Date | null;
  }): PasskeySummary {
    return {
      id: c.id,
      deviceName: c.deviceName,
      deviceType: c.deviceType,
      createdAt: c.createdAt,
      lastUsedAt: c.lastUsedAt,
    };
  }

  private async findUserByIdentifier(identifier: string) {
    // Cerminkan pencarian login: username / email / nomor HP.
    const normalized = identifier.trim();
    // Audit Auth 2026-10-10 (#BE-42): nomor HP tersimpan terenkripsi — cocokkan
    // via phoneNumberHash (dinormalkan ke +62 dulu) agar binding challenge ke
    // akun juga bekerja untuk identifier berupa nomor HP.
    const phoneHash = /^[+\d][\d\s\-.]{6,}$/.test(normalized)
      ? hashPhoneNumber(normalizePhoneNumber(normalized))
      : null;
    return this.prisma.user.findFirst({
      where: {
        OR: [
          { username: normalized },
          { email: normalized.toLowerCase() },
          { phoneNumber: normalized },
          ...(phoneHash ? [{ phoneNumberHash: phoneHash }] : []),
        ],
      },
      select: { id: true },
    });
  }

  private async sendSecurityNotification(userId: string, title: string, body: string): Promise<void> {
    const type = NotificationType.SECURITY_NEW_LOGIN;
    await this.prisma.notification.create({
      data: {
        notifId: generateNotifId(),
        userId,
        type,
        category: getCategoryForType(type),
        title,
        body,
      },
    });
    this.prisma.emitNotificationCreated({
      userId,
      title,
      body,
      data: { type: 'SECURITY_ALERT', notificationType: type },
    });
  }
}
