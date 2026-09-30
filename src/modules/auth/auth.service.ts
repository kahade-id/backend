import {
  Injectable,
  BadRequestException,
  UnauthorizedException,
  ForbiddenException,
  ConflictException,
  NotFoundException,
  InternalServerErrorException,
  ServiceUnavailableException,
  HttpException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service';
import { RedisService } from '../../redis/redis.service';
import { TokenService } from './token.service';
import type { RefreshTokenPayload, TempTokenPayload, DecodedTokenPayload } from './token.service';
import { OtpService } from './otp.service';
import { OtpTriggerService, type TriggerPayload } from './otp-trigger.service';
import { OtpTriggerPurpose } from './dto/otp-trigger.dto';
import { AuthLocationService } from './auth-location.service';
import { AppleAuthService } from './apple-auth.service';
import type { LocationDto } from './dto/location.dto';
import { OtpType, NotificationType, UserAuditAction, Gender, Prisma, User, SocialProvider } from '@prisma/client';
import { getCategoryForType } from '../notifications/notification-category.map';
import {
  generateUserId,
  generateReferralCode,
  generateNotifId,
} from '../../common/utils/id-generator.util';
import {
  bcryptHash,
  bcryptCompare,
  sha256,
  encryptAES,
  decryptAES,
  getBcryptRounds,
  hmacPinDigest,
} from '../../common/utils/crypto.util';
import { hashPhoneNumber, encryptPii, decryptPiiSafe } from '../../common/utils/pii.util';
import { normalizeIndonesianPhone } from '../../common/utils/phone.util';
import { addMinutes } from '../../common/utils/date.util';
import { generateBackupCodes, hashOtp, verifyOtp } from '../../common/utils/otp.util';
import {
  TOKEN_BLACKLIST,
  TEMP_TOKEN_USED,
  TOTP_USED_CODE,
  SESSION_REVOKED_KEY,
  BACKUP_CODE_USED,
  PHONE_VERIFIED_GUARD,
  USER_SUSPENDED_KEY,
} from '../../common/constants/redis-keys';
import * as ErrorCodes from '../../common/constants/error-codes';
import {
  RESERVED_USERNAMES,
  ACCOUNT_LOCK_MAX_ATTEMPTS,
  ACCOUNT_LOCK_DURATION_MINUTES,
  MAX_REFERRALS,
  OTP_MAX_ATTEMPTS,
} from '../../common/constants/app.constants';
import { validatePasswordPolicy } from './password-policy';
import { ChangePasswordDto } from './dto/change-password.dto';
import * as speakeasy from 'speakeasy';
import { Logger } from '@nestjs/common';
import * as QRCode from 'qrcode';
import { InjectQueue } from '@nestjs/bull';
import { Queue } from 'bull';
import { EMAIL_QUEUE, EmailJobData } from '../queue/processors/email.processor';
import { AuditLogService } from '../../common/services/audit-log.service';
import { RealtimeService } from '../realtime/realtime.service';
import { OtpGatewayService } from './otp-gateway.service';
import {
  randomBytes as _cryptoRandomBytes,
  randomInt as _cryptoRandomInt,
  timingSafeEqual as _timingSafeEqual,
} from 'crypto';
import { OAuth2Client } from 'google-auth-library';
const TWO_FA_ATTEMPT_KEY = (userId: string): string => `2fa_attempts:${userId}`;

let _dummyHash: string | undefined;
// Module-load prewarm so the dummy-compare (timing-attack mitigation) is ready
// without paying bcrypt cost on the first failed login.
void bcryptHash(_cryptoRandomBytes(32).toString('hex'), getBcryptRounds()).then((h: string) => {
  _dummyHash = h;
});
// Fallback bila prewarm belum selesai — hash bcrypt valid agar timing sebanding.
const DUMMY_BCRYPT_HASH_FALLBACK = '$2b$12$K4GH.2PFn0b3bVkYe3klq.ScFT2MXqHWMzIxB/yLc8A7EEpzlJxHy';

const TWO_FA_MAX_ATTEMPTS = 5;


interface LoginUserPayload {
  id: string;
  userId: string;
  username: string | null;
  email: string | null;
  fullName: string;
  avatarUrl: string | null;
  bio: string | null;
  accountType: string;
  emailVerified: boolean;
  kycStatus: string;
  isKahadePlus: boolean;
  subscriptionExpiresAt: string | null;
  membershipRank: string;
  isMfaEnabled: boolean;
  phoneNumber: string | null;
  phoneVerified: boolean;
  dateOfBirth: string | null;
  gender: string | null;
  createdAt: string;
}

type LoginResult =
  | { requires2FA: true; tempToken: string }
  | { accessToken: string; refreshToken: string; user: LoginUserPayload };

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);
  constructor(
    private prisma: PrismaService,
    private redis: RedisService,
    private tokenService: TokenService,
    private otpService: OtpService,
    private otpGateway: OtpGatewayService,
    private configService: ConfigService,
    private auditLog: AuditLogService,
    private realtime: RealtimeService,
    private locationService: AuthLocationService,
    private otpTriggerService: OtpTriggerService,
    @InjectQueue(EMAIL_QUEUE) private readonly emailQueue: Queue<EmailJobData>,
    // GAP-A (G009): verifikasi token Apple; tetap nonaktif kecuali dikonfigurasi.
    private readonly appleAuth: AppleAuthService,
  ) {}

  /**
   * 03-#4: Klaim atomik token sekali-pakai (SET NX) SEBELUM mutasi.
   * Pola check-then-set sebelumnya (cek via get sebelum transaksi, tulis
   * best-effort setelah commit) punya race TOCTOU: dua request konkuren
   * bisa sama-sama lolos cek awal. Klaim di sini fail-closed: bila klaim
   * gagal, token dianggap sudah dipakai.
   */
  private async claimTempTokenOnce(
    jti: string | undefined,
    expSeconds: number | undefined,
    errorCode: string,
    message: string,
  ): Promise<void> {
    if (!jti) {
      throw new UnauthorizedException({ code: errorCode, message });
    }
    const ttl = Math.max(60, Math.min(15 * 60, Math.floor(expSeconds ?? 600)));
    const claimed = await this.redis.setNx(TEMP_TOKEN_USED(jti), '1', ttl, { throwOnError: true });
    if (!claimed) {
      throw new UnauthorizedException({ code: errorCode, message });
    }
  }

  private getTempTokenTtlFromPayload(payload: TempTokenPayload): number | undefined {
    const exp = (payload as TempTokenPayload & { exp?: number }).exp;
    if (!exp) return undefined;
    return Math.max(0, exp - Math.floor(Date.now() / 1000));
  }

  // ─────────────────────────────────────────────────────────────────
  // REGISTER
  // ─────────────────────────────────────────────────────────────────
  /** @deprecated Use phoneRegister() for new phone-based registration */
  async register(
    dto: Record<string, any> & { fullName: string },
    ipAddress?: string,
  ): Promise<{ message: string }> {
    if (dto.password && dto.confirmPassword !== dto.password) {
      throw new BadRequestException({
        code: ErrorCodes.PASSWORDS_DO_NOT_MATCH,
        message: 'Password and confirmation do not match',
      });
    }
    if (dto.password) {
      validatePasswordPolicy(dto.password);
    }

    if (dto.dateOfBirth) {
      const dob = new Date(dto.dateOfBirth + 'T00:00:00Z');
      if (isNaN(dob.getTime())) {
        throw new BadRequestException({
          code: ErrorCodes.VALIDATION_ERROR,
          message: 'Invalid date of birth format. Use ISO 8601 (YYYY-MM-DD)',
        });
      }
      const age = (Date.now() - dob.getTime()) / (365.25 * 24 * 60 * 60 * 1000);
      if (age < 13 || age > 120) {
        throw new BadRequestException({
          code: ErrorCodes.VALIDATION_ERROR,
          message: 'Date of birth must represent an age between 13 and 120 years',
        });
      }
    }

    if (dto.phoneNumber) {
      const cleaned = dto.phoneNumber.replace(/[\s\-.]/g, '');
      const STRICT_INDONESIAN_PHONE = /^(\+62|62|0)8[1-9][0-9]{7,10}$/;
      if (!STRICT_INDONESIAN_PHONE.test(cleaned)) {
        throw new BadRequestException({
          code: ErrorCodes.VALIDATION_ERROR,
          message: 'Only valid Indonesian mobile numbers are accepted (e.g. 08xx or +628xx)',
        });
      }
    }

    const normalizedEmail = (dto.email ?? '').toLowerCase();

    // Email enumeration protection — always return the same message regardless
    const existingUser = await this.prisma.user.findUnique({
      where: { email: normalizedEmail },
    });
    if (existingUser) {
      return { message: 'If this is a new email, a verification link has been sent.' };
    }

    // Validate username uniqueness up-front (before transaction) for better UX.
    // The DB unique constraint is the authoritative guard inside the transaction.
    if (dto.username) {
      const normalizedUsername = dto.username.toLowerCase();
      if (RESERVED_USERNAMES.includes(normalizedUsername)) {
        throw new BadRequestException({
          code: ErrorCodes.USERNAME_RESERVED,
          message: 'Username is already taken',
        });
      }
    }

    if (dto.phoneNumber) {
      const normalizedPhone = this.normalizePhoneNumber(dto.phoneNumber);
      const phoneHash = hashPhoneNumber(normalizedPhone);
      const existingPhone = await this.prisma.user.findFirst({
        where: { OR: [{ phoneNumberHash: phoneHash }, { phoneNumber: normalizedPhone }] },
      });
      if (existingPhone) {
        return { message: 'If this is a new email, a verification link has been sent.' };
      }
    }

    let referralCodeRecord: {
      id: string;
      userId: string;
      isActive: boolean;
      totalReferrals: number;
    } | null = null;
    if (dto.referralCode) {
      referralCodeRecord = await this.prisma.referralCode.findUnique({
        where: { code: dto.referralCode.toUpperCase() },
        select: { id: true, userId: true, isActive: true, totalReferrals: true },
      });
      if (
        !referralCodeRecord ||
        !referralCodeRecord.isActive ||
        referralCodeRecord.totalReferrals >= MAX_REFERRALS
      ) {
        referralCodeRecord = null;
      }
    }

    const hashedPassword = dto.password ? await bcryptHash(dto.password, getBcryptRounds()) : null;
    const userId = generateUserId();
    const myReferralCode = generateReferralCode();

    let user: { id: string; userId: string; email: string | null };
    try {
      user = await this.prisma.$transaction(
        async (tx: Prisma.TransactionClient) => {
          const normalizedPhone = dto.phoneNumber ? this.normalizePhoneNumber(dto.phoneNumber) : '';
          const normalizedUsername = dto.username ? dto.username.toLowerCase() : undefined;
          const encryptedPhone = normalizedPhone ? await encryptPii(normalizedPhone) : '';
          const phoneHash = normalizedPhone ? hashPhoneNumber(normalizedPhone) : undefined;

          const newUser = await tx.user.create({
            data: {
              userId,
              email: normalizedEmail || null,
              password: hashedPassword,
              fullName: dto.fullName,
              phoneNumber: encryptedPhone,
              phoneNumberHash: phoneHash,
              ...(normalizedUsername ? { username: normalizedUsername } : {}),
              ...(dto.dateOfBirth ? { dateOfBirth: new Date(dto.dateOfBirth + 'T00:00:00Z') } : {}),
              ...(dto.gender ? { gender: dto.gender as Gender } : {}),
            },
          });

          await tx.wallet.create({ data: { userId: newUser.id } });
          await tx.notificationPreference.create({ data: { userId: newUser.id } });
          await tx.referralCode.create({ data: { userId: newUser.id, code: myReferralCode } });

          if (referralCodeRecord) {
            const codeUpdated = await tx.referralCode.updateMany({
              where: {
                id: referralCodeRecord.id,
                isActive: true,
                totalReferrals: { lt: MAX_REFERRALS },
              },
              data: { totalReferrals: { increment: 1 } },
            });
            if (codeUpdated.count > 0) {
              await tx.referralRelation.create({
                data: {
                  referralCodeId: referralCodeRecord.id,
                  referrerId: referralCodeRecord.userId,
                  refereeId: newUser.id,
                },
              });
            }
          }

          return newUser;
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      );
    } catch (err: unknown) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        const target = (err.meta?.target as string[]) ?? [];
        if (target.includes('userId')) {
          throw new InternalServerErrorException({
            code: 'TRANSIENT_CONFLICT',
            message: 'Registration failed due to a transient conflict. Please try again.',
          });
        }
        if (
          target.includes('username') ||
          target.includes('email') ||
          target.includes('phoneNumber')
        ) {
          return { message: 'If this is a new email, a verification link has been sent.' };
        }
      }
      throw err;
    }

    if (user.email) {
      await this.sendVerificationEmail(user.id, user.email, ipAddress);
    }
    return { message: 'If this is a new email, a verification link has been sent.' };
  }

  /** Normalize phone to E.164 Indonesia format: 08xx → +628xx
   *  Delegates to shared util (also used by OtpTriggerService).
   */
  private normalizePhoneNumber(phone: string): string {
    return normalizeIndonesianPhone(phone);
  }

  /**
   * Resolusi identifier login: email (mengandung @) → nomor HP Indonesia
   * → username (disimpan lowercase). Dipakai oleh login().
   */
  private async findUserByIdentifier(identifier: string) {
    const trimmed = identifier.trim();
    if (trimmed.includes('@')) {
      return this.prisma.user.findUnique({ where: { email: trimmed.toLowerCase() } });
    }
    const digits = trimmed.replace(/[\s\-.]/g, '');
    if (/^(\+62|62|0)8[1-9][0-9]{7,10}$/.test(digits)) {
      const normalized = normalizeIndonesianPhone(trimmed);
      const phoneHash = hashPhoneNumber(normalized);
      return this.prisma.user.findFirst({
        where: { OR: [{ phoneNumberHash: phoneHash }, { phoneNumber: normalized }] },
      });
    }
    return this.prisma.user.findUnique({ where: { username: trimmed.toLowerCase() } });
  }


  private shouldExposeDebugOtp(): boolean {
    const nodeEnv = (
      this.configService.get<string>('app.nodeEnv') ??
      process.env.NODE_ENV ??
      'development'
    ).toLowerCase();
    if (!['development', 'test'].includes(nodeEnv)) return false;
    const flag = (process.env.OTP_DEBUG_RETURN_CODE ?? '').toLowerCase();
    return flag === 'true' || flag === '1' || flag === 'yes';
  }

  // ─────────────────────────────────────────────────────────────────
  // VERIFY PHONE OTP (e-wallet style login/register check)
  // ─────────────────────────────────────────────────────────────────
  async verifyPhoneOtp(
    phoneNumber: string,
    code: string,
    deviceId: string,
    deviceInfo: string | undefined,
    ipAddress: string,
    location?: LocationDto,
  ): Promise<
    | { status: 'new_user'; tempToken: string }
    | { status: 'password_reset'; tempToken: string }
    | { status: 'migration_verified'; tempToken: string }
    | {
        status: 'existing_user';
        requires2FA?: boolean;
        tempToken?: string;
        accessToken?: string;
        refreshToken?: string;
        user?: LoginUserPayload;
      }
  > {
    const normalizedPhone = this.normalizePhoneNumber(phoneNumber);
    const phoneHash = hashPhoneNumber(normalizedPhone);

    // Resolve account state before consuming the one-time credential. If a
    // deployment/schema failure occurs here, the user can retry the same code
    // after recovery instead of receiving a misleading OTP_INVALID response.
    const existingUser = await this.prisma.user.findFirst({
      where: { OR: [{ phoneNumberHash: phoneHash }, { phoneNumber: normalizedPhone }] },
    });

    // Do not consume a one-time login code for an account that cannot complete
    // login. The state is checked again after verification to cover a concurrent
    // administrative change between this preflight and OTP consumption.
    if (existingUser) {
      if (!existingUser.isActive) {
        throw new ForbiddenException({
          code: ErrorCodes.ACCOUNT_INACTIVE,
          message: 'Account is inactive',
        });
      }
      if (existingUser.isBanned) {
        throw new ForbiddenException({
          code: ErrorCodes.ACCOUNT_BANNED,
          message: 'Account has been banned',
        });
      }
      // BAI-074: suspend ringan ikut diblokir di jalur OTP.
      await this.assertNotSuspended(existingUser.id);
      if (existingUser.lockedUntil && existingUser.lockedUntil > new Date()) {
        const remainingMs = existingUser.lockedUntil.getTime() - Date.now();
        const remainingSeconds = Math.ceil(remainingMs / 1000);
        throw new UnauthorizedException({
          code: ErrorCodes.ACCOUNT_LOCKED,
          message: 'Account is temporarily locked due to too many failed attempts',
          lockoutRemainingSeconds: remainingSeconds,
        });
      }
    }

    const verification = await this.otpService.verifyPhoneOtpWithMetadata(
      normalizedPhone,
      OtpType.PHONE_LOGIN,
      code,
      { consume: false },
    );
    const metadata = verification.metadata;
    if (
      !verification.valid ||
      !verification.otpId ||
      metadata?.purpose !== 'phone_login' ||
      metadata.deviceId !== deviceId
    ) {
      throw new BadRequestException({
        code: ErrorCodes.OTP_INVALID,
        message: 'Invalid or expired OTP',
      });
    }
    if (!(await this.otpService.consumeVerifiedOtp(verification.otpId))) {
      throw new BadRequestException({
        code: ErrorCodes.OTP_INVALID,
        message: 'Invalid or expired OTP',
      });
    }

    // Percabangan berdasarkan purpose trigger WhatsApp (disimpan di metadata
    // OTP oleh webhook). Tanpa triggerPurpose → perilaku lama (login/register).
    const triggerPurpose = typeof metadata?.triggerPurpose === 'string' ? metadata.triggerPurpose : undefined;

    if (triggerPurpose === 'forgot_password') {
      if (!existingUser) {
        throw new NotFoundException({
          code: ErrorCodes.NOT_FOUND,
          message: 'Nomor HP tidak terdaftar di Kahade.',
        });
      }
      const tempToken = this.tokenService.signTempToken({
        sub: existingUser.id,
        scope: 'password_reset',
        deviceId,
      });
      await this.locationService.logEvent({
        userId: existingUser.id,
        event: 'forgot_password',
        location: location ?? null,
        ipAddress,
        deviceId,
      });
      return { status: 'password_reset', tempToken };
    }

    if (triggerPurpose === 'migrate_phone') {
      const boundUserId = typeof metadata?.userId === 'string' ? metadata.userId : undefined;
      const migratingUser = boundUserId
        ? await this.prisma.user.findUnique({ where: { id: boundUserId } })
        : null;
      if (!migratingUser) {
        throw new UnauthorizedException({
          code: ErrorCodes.UNAUTHORIZED,
          message: 'Sesi migrasi tidak valid. Silakan masuk ulang.',
        });
      }
      if (!migratingUser.isActive || migratingUser.isBanned) {
        throw new ForbiddenException({
          code: ErrorCodes.ACCOUNT_INACTIVE,
          message: 'Account is inactive',
        });
      }
      if (migratingUser.lockedUntil && migratingUser.lockedUntil > new Date()) {
        throw new UnauthorizedException({
          code: ErrorCodes.ACCOUNT_LOCKED,
          message: 'Account is temporarily locked due to too many failed attempts',
        });
      }
      const tempToken = this.tokenService.signTempToken({
        sub: migratingUser.id,
        scope: 'phone_migration',
        deviceId,
        extra: { phone: normalizedPhone },
      });
      return { status: 'migration_verified', tempToken };
    }

    if (!existingUser) {
      const tempToken = this.tokenService.signTempToken({
        sub: normalizedPhone,
        scope: 'phone_register',
        deviceId,
      });
      return { status: 'new_user', tempToken };
    }

    if (!existingUser.isActive) {
      throw new ForbiddenException({
        code: ErrorCodes.ACCOUNT_INACTIVE,
        message: 'Account is inactive',
      });
    }
    if (existingUser.isBanned) {
      throw new ForbiddenException({
        code: ErrorCodes.ACCOUNT_BANNED,
        message: 'Account has been banned',
      });
    }
    // BAI-074: cek ulang suspend pasca-verifikasi (perubahan admin konkuren).
    await this.assertNotSuspended(existingUser.id);
    if (existingUser.lockedUntil && existingUser.lockedUntil > new Date()) {
      const remainingMs = existingUser.lockedUntil.getTime() - Date.now();
      const remainingSeconds = Math.ceil(remainingMs / 1000);
      throw new UnauthorizedException({
        code: ErrorCodes.ACCOUNT_LOCKED,
        message: 'Account is temporarily locked due to too many failed attempts',
        lockoutRemainingSeconds: remainingSeconds,
      });
    }

    await this.prisma.user.update({
      where: { id: existingUser.id },
      // Section 1: phoneVerifiedAt dibuat simetris dengan emailVerifiedAt supaya
      // badge CONTACT_VERIFIED (kombinasi email+phone) punya tanggal "didapat".
      data: { phoneVerified: true, phoneVerifiedAt: existingUser.phoneVerifiedAt ?? new Date() },
    });
    await this.redis
      .del(PHONE_VERIFIED_GUARD(existingUser.id))
      .catch(err =>
        this.logger.warn(
          `Failed to invalidate phone verification cache for ${existingUser.id}: ${err instanceof Error ? err.message : String(err)}`,
        ),
      );

    const twoFactorAuth = await this.prisma.twoFactorAuth.findUnique({
      where: { userId: existingUser.id },
    });
    if (twoFactorAuth?.isEnabled) {
      let skipTwoFa = false;
      if (deviceId) {
        const trustedDevice = await this.prisma.userDevice.findFirst({
          where: { userId: existingUser.id, deviceId, isTrusted: true },
        });
        if (trustedDevice?.trustedAt) {
          const trustExpiryMs =
            (this.configService.get<number>('app.trustedDeviceDays') ?? 30) * 24 * 60 * 60 * 1000;
          const isExpired = Date.now() - trustedDevice.trustedAt.getTime() >= trustExpiryMs;
          if (isExpired) {
            await this.prisma.userDevice.update({
              where: { id: trustedDevice.id },
              data: { isTrusted: false, trustedAt: null },
            });
          } else {
            skipTwoFa = true;
          }
        }
      }
      if (!skipTwoFa) {
        const tempToken = this.tokenService.signTempToken({
          sub: existingUser.id,
          scope: '2fa_verify',
          deviceId,
        });
        return { status: 'existing_user', requires2FA: true, tempToken };
      }
    }

    const lockoutCycleKey = `lockout_cycles:${existingUser.id}`;
    await this.redis
      .del(lockoutCycleKey)
      .catch(err =>
        this.logger.warn(`silent-catch: ${err instanceof Error ? err.message : String(err)}`),
      );
    await this.prisma.user.update({
      where: { id: existingUser.id },
      data: {
        failedLoginAttempts: 0,
        lockedUntil: null,
        lastLoginAt: new Date(),
        lastLoginIp: ipAddress,
      },
    });

    const refreshToken = this.tokenService.signRefreshToken({ sub: existingUser.id });
    const sessionId = await this.saveSession(
      existingUser.id,
      refreshToken,
      deviceId,
      deviceInfo,
      ipAddress,
    );

    if (deviceId) {
      await this.trackDevice(existingUser.id, deviceId, deviceInfo, ipAddress).catch(err =>
        this.logger.error('trackDevice failed in verifyPhoneOtp()', err),
      );
    }

    const accessToken = this.tokenService.signAccessToken({
      sub: existingUser.id,
      userId: existingUser.userId,
      email: existingUser.email ?? '',
      username: existingUser.username ?? '',
      sessionId,
      kycStatus: existingUser.kycStatus,
      emailVerified: existingUser.emailVerified,
    });

    this.auditLog.logUserAction({
      userId: existingUser.id,
      action: UserAuditAction.LOGIN,
      entityType: 'User',
      entityId: existingUser.id,
      description: `User logged in via phone OTP from ${ipAddress}`,
      ipAddress,
    });

    return {
      status: 'existing_user',
      accessToken,
      refreshToken,
      user: {
        id: existingUser.id,
        userId: existingUser.userId,
        username: existingUser.username,
        email: existingUser.email ?? '',
        fullName: existingUser.fullName,
        avatarUrl: existingUser.avatarUrl ?? null,
        bio: existingUser.bio ?? null,
        accountType: existingUser.accountType,
        emailVerified: existingUser.emailVerified,
        kycStatus: existingUser.kycStatus,
        isKahadePlus: existingUser.isKahadePlus,
        subscriptionExpiresAt: existingUser.subscriptionExpiresAt
          ? existingUser.subscriptionExpiresAt.toISOString()
          : null,
        membershipRank: existingUser.membershipRank,
        isMfaEnabled: twoFactorAuth?.isEnabled ?? false,
        phoneNumber: normalizedPhone,
        phoneVerified: true,
        dateOfBirth: existingUser.dateOfBirth ? existingUser.dateOfBirth.toISOString() : null,
        gender: existingUser.gender ?? null,
        createdAt: existingUser.createdAt.toISOString(),
      },
    };
  }

  async requestPhoneChange(
    userId: string,
    newPhoneNumber: string,
    currentPassword: string,
    mfaCode?: string,
    ipAddress?: string,
  ): Promise<{ message: string }> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, password: true, phoneNumberHash: true, isActive: true, isBanned: true },
    });
    if (
      !user ||
      !user.isActive ||
      user.isBanned ||
      !user.password ||
      !(await bcryptCompare(currentPassword, user.password))
    ) {
      throw new UnauthorizedException({
        code: ErrorCodes.UNAUTHORIZED,
        message: 'Unable to process phone number change',
      });
    }

    const normalizedPhone = this.normalizePhoneNumber(newPhoneNumber);
    const phoneHash = hashPhoneNumber(normalizedPhone);
    if (phoneHash === user.phoneNumberHash) {
      throw new BadRequestException({
        code: ErrorCodes.VALIDATION_ERROR,
        message: 'The new phone number must be different from your current number',
      });
    }
    const owner = await this.prisma.user.findFirst({
      where: { OR: [{ phoneNumberHash: phoneHash }, { phoneNumber: normalizedPhone }] },
      select: { id: true },
    });
    if (owner && owner.id !== userId) {
      throw new BadRequestException({
        code: ErrorCodes.VALIDATION_ERROR,
        message: 'This phone number cannot be used',
      });
    }
    await this.verifySensitiveMfa(userId, mfaCode);
    // OTP hanya via WhatsApp (kebijakan produk) — Fonnte tidak mendukung SMS.
    if (!this.otpGateway.supportsMethod('WHATSAPP')) {
      throw new ServiceUnavailableException({
        code: 'OTP_DELIVERY_FAILED',
        message: 'OTP delivery is temporarily unavailable. Please try again later.',
      });
    }

    const otp = await this.otpService.generatePhoneOtp(
      normalizedPhone,
      OtpType.SENSITIVE_ACTION,
      'WHATSAPP',
      userId,
      { purpose: 'phone_change', userId, phoneHash },
      ipAddress,
    );
    let delivery: { success: boolean; error?: string };
    try {
      delivery = await this.otpGateway.sendOtp(normalizedPhone, otp, 'WHATSAPP');
    } catch {
      await this.otpService
        .invalidatePhoneOtps(normalizedPhone, OtpType.SENSITIVE_ACTION)
        .catch(() => undefined);
      throw new ServiceUnavailableException({
        code: 'OTP_DELIVERY_FAILED',
        message: 'OTP delivery is temporarily unavailable. Please try again later.',
      });
    }
    if (!delivery.success) {
      await this.otpService
        .invalidatePhoneOtps(normalizedPhone, OtpType.SENSITIVE_ACTION)
        .catch(() => undefined);
      throw new ServiceUnavailableException({
        code: 'OTP_DELIVERY_FAILED',
        message: 'OTP delivery is temporarily unavailable. Please try again later.',
      });
    }
    return { message: 'A verification code has been sent to the new phone number.' };
  }

  async confirmPhoneChange(
    userId: string,
    newPhoneNumber: string,
    code: string,
    opts?: { location?: LocationDto | null; ipAddress?: string; deviceId?: string },
  ): Promise<{ message: string }> {
    const normalizedPhone = this.normalizePhoneNumber(newPhoneNumber);
    const phoneHash = hashPhoneNumber(normalizedPhone);
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, email: true, isActive: true, isBanned: true },
    });
    if (!user || !user.isActive || user.isBanned) {
      throw new UnauthorizedException({
        code: ErrorCodes.UNAUTHORIZED,
        message: 'Unable to process phone number change',
      });
    }
    const verification = await this.otpService.verifyPhoneOtpWithMetadata(
      normalizedPhone,
      OtpType.SENSITIVE_ACTION,
      code,
      { consume: false },
    );
    const metadata = verification.metadata;
    if (
      !verification.valid ||
      !verification.otpId ||
      metadata?.purpose !== 'phone_change' ||
      metadata.userId !== userId ||
      metadata.phoneHash !== phoneHash
    ) {
      throw new BadRequestException({
        code: ErrorCodes.OTP_INVALID,
        message: 'Invalid or expired verification code',
      });
    }
    try {
      const revokedSessionIds = await this.prisma.$transaction(
        async tx => {
          const owner = await tx.user.findFirst({
            where: { OR: [{ phoneNumberHash: phoneHash }, { phoneNumber: normalizedPhone }] },
            select: { id: true },
          });
          if (owner && owner.id !== userId) {
            throw new BadRequestException({
              code: ErrorCodes.VALIDATION_ERROR,
              message: 'This phone number cannot be used',
            });
          }
          const consumed = await tx.otpCode.updateMany({
            where: { id: verification.otpId, isUsed: false },
            data: { isUsed: true, usedAt: new Date() },
          });
          if (consumed.count !== 1) {
            throw new BadRequestException({
              code: ErrorCodes.OTP_INVALID,
              message: 'Invalid or expired verification code',
            });
          }
          const sessions = await tx.userSession.findMany({
            where: { userId, isRevoked: false },
            select: { id: true },
          });
          await tx.user.update({
            where: { id: userId },
            // Nomor baru baru sah setelah OTP-nya benar, jadi timestamp verifikasinya
            // ikut di-reset ke sekarang (bukan mempertahankan tanggal nomor lama).
            data: {
              phoneNumber: await encryptPii(normalizedPhone),
              phoneNumberHash: phoneHash,
              phoneVerified: true,
              phoneVerifiedAt: new Date(),
            },
          });
          await tx.userSession.updateMany({
            where: { userId, isRevoked: false },
            data: { isRevoked: true, revokedAt: new Date(), revokedReason: 'phone_changed' },
          });
          await tx.userDevice.updateMany({
            where: { userId, isTrusted: true },
            data: { isTrusted: false, trustedAt: null },
          });
          return sessions.map(session => session.id);
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      );
      await this.revokeSessionsInRedis(revokedSessionIds);
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new BadRequestException({
          code: ErrorCodes.VALIDATION_ERROR,
          message: 'This phone number cannot be used',
        });
      }
      throw error;
    }

    await this.redis.del(PHONE_VERIFIED_GUARD(userId)).catch(() => undefined);
    this.createSecurityNotification(
      userId,
      'Phone Number Changed',
      'Your phone number was changed. All active sessions and trusted devices were signed out. If this was not you, contact support immediately.',
    ).catch(() => undefined);
    if (user.email) {
      this.dispatchEmail({
        to: user.email,
        subject: 'Security Alert: Phone Number Changed',
        templateName: 'phone-changed-notification',
        templateContext: {},
      }).catch(() => undefined);
    }

    // Lokasi presisi: event 'phone_change' sudah didefinisikan di
    // AuthLocationService namun belum pernah dicatat — catat di sini
    // (tidak double: tidak ada di ActionLocationType).
    await this.locationService.logEvent({
      userId,
      event: 'phone_change',
      location: opts?.location ?? null,
      ipAddress: opts?.ipAddress ?? undefined,
      deviceId: opts?.deviceId,
    });

    return { message: 'Phone number updated. Please log in again on your devices.' };
  }

  private async verifySensitiveMfa(userId: string, code?: string): Promise<void> {
    const twoFactorAuth = await this.prisma.twoFactorAuth.findUnique({ where: { userId } });
    if (!twoFactorAuth?.isEnabled) return;
    if (!code) {
      throw new ForbiddenException({
        code: 'TWO_FA_REQUIRED',
        message: 'Authenticator or backup code is required for this security change',
      });
    }

    const normalizedCode = code.trim().toUpperCase();
    let totpVerified = false;
    if (twoFactorAuth.secret) {
      try {
        const secret = await decryptAES(twoFactorAuth.secret);
        totpVerified = speakeasy.totp.verify({
          secret,
          encoding: 'base32',
          token: normalizedCode,
          window: 1,
        });
      } catch {
        throw new BadRequestException({
          code: ErrorCodes.TWO_FA_NOT_ENABLED,
          message: 'Unable to verify 2FA code. Please re-setup 2FA.',
        });
      }
    }

    if (!totpVerified) {
      const backupCodeAccepted = await this.checkAndConsumeBackupCode(
        twoFactorAuth,
        normalizedCode,
      );
      if (!backupCodeAccepted) {
        throw new BadRequestException({
          code: ErrorCodes.INVALID_2FA_CODE,
          message: 'Invalid 2FA code',
        });
      }
      this.notifyBackupCodeUsed(userId).catch(() => undefined);
      return;
    }

    const hmacSecret =
      this.configService.get<string>('crypto.hmacSecretKey') ||
      this.configService.get<string>('jwt.secret') ||
      '';
    const totpUsedKey = TOTP_USED_CODE(userId);
    const client = this.redis.getClient();
    const wasAdded = await client.sadd(
      `${this.redis.getPrefix()}${totpUsedKey}`,
      sha256(hmacSecret + ':totp:' + normalizedCode),
    );
    if (wasAdded === 0) {
      throw new BadRequestException({
        code: ErrorCodes.INVALID_2FA_CODE,
        message: 'TOTP code already used. Wait for the next code.',
      });
    }
    await client.expire(`${this.redis.getPrefix()}${totpUsedKey}`, 90);
  }

  // ─────────────────────────────────────────────────────────────────
  // GAP-A: passkey / WebAuthn (G027–G050) — dipakai oleh PasskeyService
  // ─────────────────────────────────────────────────────────────────
  /**
   * Re-auth untuk operasi sensitif passkey (G027, G036, G037, G039).
   *
   * Kebijakan berlapis:
   *  1. `reauthToken` (scope `passkey_reauth`, sekali pakai, dari alur
   *     recover/verify) → langsung lolos.
   *  2. Bila user punya password: password WAJIB benar; bila 2FA aktif,
   *     `mfaCode` (TOTP/backup) juga WAJIB via verifySensitiveMfa.
   *  3. Bila tanpa password (akun social-only): `otpCode` WhatsApp
   *     (OtpType.SENSITIVE_ACTION) WAJIB; bila 2FA aktif, `mfaCode` juga WAJIB.
   */
  async assertPasskeyReauthenticated(
    userId: string,
    dto: { password?: string; mfaCode?: string; otpCode?: string; reauthToken?: string },
  ): Promise<void> {
    if (dto.reauthToken) {
      let payload: TempTokenPayload;
      try {
        payload = this.tokenService.verifyTempToken(dto.reauthToken);
      } catch {
        throw new UnauthorizedException({
          code: ErrorCodes.INVALID_TOKEN,
          message: 'Token re-autentikasi tidak valid atau kedaluwarsa. Minta kode OTP baru.',
        });
      }
      if (payload.scope !== 'passkey_reauth' || payload.sub !== userId) {
        throw new UnauthorizedException({
          code: ErrorCodes.INVALID_TOKEN,
          message: 'Token re-autentikasi tidak valid.',
        });
      }
      await this.claimTempTokenOnce(
        payload.jti,
        this.getTempTokenTtlFromPayload(payload),
        'REAUTH_TOKEN_USED',
        'Token re-autentikasi sudah dipakai. Minta kode OTP baru.',
      );
      return;
    }

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, password: true, isActive: true, isBanned: true, phoneNumber: true },
    });
    if (!user || !user.isActive || user.isBanned) {
      throw new UnauthorizedException({
        code: ErrorCodes.INVALID_CREDENTIALS,
        message: 'Kredensial tidak valid.',
      });
    }
    if (user.password) {
      if (!dto.password || !(await bcryptCompare(dto.password, user.password))) {
        throw new UnauthorizedException({
          code: ErrorCodes.INVALID_CREDENTIALS,
          message: 'Kata sandi salah. Masukkan kata sandi Anda untuk melanjutkan.',
        });
      }
    } else {
      // Akun tanpa password (social-only): re-auth via OTP WhatsApp.
      const otpOk =
        !!dto.otpCode &&
        (await this.otpService.verifyPhoneOtp(user.phoneNumber, OtpType.SENSITIVE_ACTION, dto.otpCode));
      if (!otpOk) {
        throw new UnauthorizedException({
          code: 'INVALID_OTP',
          message: 'Kode OTP WhatsApp salah atau kedaluwarsa.',
        });
      }
    }
    await this.verifySensitiveMfa(userId, dto.mfaCode);
  }

  /**
   * Menerbitkan sesi setelah assertion passkey terverifikasi (G030).
   *
   * Alur pasca-kredensial disamakan dengan login(): cek status akun,
   * migrasi nomor HP, lalu 2FA. Keputusan produk: passkey dihitung sebagai
   * faktor kuat, tetapi bila 2FA aktif user tetap diminta TOTP
   * (passkey + TOTP) — kecuali perangkat sudah dipercaya (trusted device),
   * mengikuti kebijakan yang sama dengan login password.
   */
  async loginWithPasskey(
    userId: string,
    ipAddress: string,
    opts: { deviceId: string; deviceInfo?: string; location?: LocationDto },
  ): Promise<
    | LoginResult
    | { requiresPhoneMigration: true; migrationToken: string }
  > {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user || !user.isActive || user.isBanned) {
      throw new UnauthorizedException({
        code: ErrorCodes.INVALID_CREDENTIALS,
        message: 'Invalid credentials',
      });
    }
    // BAI-074: suspend ringan ikut diblokir di jalur passkey.
    await this.assertNotSuspended(user.id);
    if (user.lockedUntil && user.lockedUntil > new Date()) {
      const remainingSeconds = Math.ceil((user.lockedUntil.getTime() - Date.now()) / 1000);
      throw new UnauthorizedException({
        code: ErrorCodes.ACCOUNT_LOCKED,
        message: 'Account is temporarily locked due to too many failed attempts',
        lockoutRemainingSeconds: remainingSeconds,
      });
    }

    // Migrasi wajib nomor HP — sama seperti login password.
    if (!user.phoneVerified) {
      const migrationToken = this.tokenService.signTempToken({
        sub: user.id,
        scope: 'phone_migration',
        deviceId: opts.deviceId,
      });
      await this.locationService.logEvent({
        userId: user.id,
        event: 'login',
        location: opts.location ?? null,
        ipAddress,
        deviceId: opts.deviceId,
      });
      return { requiresPhoneMigration: true as const, migrationToken };
    }

    const twoFactorAuth = await this.prisma.twoFactorAuth.findUnique({
      where: { userId: user.id },
    });
    if (twoFactorAuth?.isEnabled) {
      let skipTwoFa = false;
      if (opts.deviceId) {
        const trustedDevice = await this.prisma.userDevice.findFirst({
          where: { userId: user.id, deviceId: opts.deviceId, isTrusted: true },
        });
        if (trustedDevice?.trustedAt) {
          const trustExpiryMs =
            (this.configService.get<number>('app.trustedDeviceDays') ?? 30) * 24 * 60 * 60 * 1000;
          if (Date.now() - trustedDevice.trustedAt.getTime() >= trustExpiryMs) {
            await this.prisma.userDevice.update({
              where: { id: trustedDevice.id },
              data: { isTrusted: false, trustedAt: null },
            });
          } else {
            skipTwoFa = true;
          }
        }
      }
      if (!skipTwoFa) {
        const tempToken = this.tokenService.signTempToken({
          sub: user.id,
          scope: '2fa_verify',
          deviceId: opts.deviceId,
        });
        return { requires2FA: true, tempToken };
      }
    }

    return this.issueLoginSession(user, ipAddress, {
      deviceId: opts.deviceId,
      deviceInfo: opts.deviceInfo,
      isMfaEnabled: twoFactorAuth?.isEnabled ?? false,
      location: opts.location,
    });
  }

  // ─────────────────────────────────────────────────────────────────
  // PHONE REGISTER (e-wallet style — after OTP verification)
  // ─────────────────────────────────────────────────────────────────
  // ─────────────────────────────────────────────────────────────────
  // PHONE REGISTER (pendaftaran via nomor HP — disederhanakan)
  // ─────────────────────────────────────────────────────────────────
  /**
   * Registrasi akun baru via nomor HP yang sudah diverifikasi OTP WhatsApp.
   * Hanya butuh: nama lengkap, password (min 8, tanpa complexity), dan
   * username opsional (dibuat otomatis bila kosong). Email, tanggal lahir,
   * gender, alamat, dan PIN wallet diisi belakangan lewat pengaturan profil.
   */
  async phoneRegister(
    dto: {
      tempToken: string;
      fullName: string;
      username?: string;
      password: string;
      deviceId: string;
      deviceInfo?: string;
      location?: LocationDto;
      referralCode?: string;
      /**
       * Token signup sosial (scope 'social_signup', sub='pending') dari
       * /v1/auth/social/login untuk identitas baru. Setelah user dibuat
       * (nomor HP terverifikasi via OTP WhatsApp), akun sosial ditautkan.
       * Gagal menautkan TIDAK menggagalkan registrasi — frontend diberi tahu
       * via socialLinked=false agar user bisa menautkan dari Pengaturan.
       */
      socialLinkToken?: string;
    },
    ipAddress: string,
  ): Promise<{
    accessToken: string;
    refreshToken: string;
    user: LoginUserPayload;
    socialLinked: boolean;
  }> {
    let payload: TempTokenPayload;
    try {
      payload = this.tokenService.verifyTempToken(dto.tempToken);
    } catch {
      throw new UnauthorizedException({
        code: ErrorCodes.TEMP_TOKEN_EXPIRED,
        message: 'Registration token expired. Please verify your phone number again.',
      });
    }

    if (payload.scope !== 'phone_register') {
      throw new UnauthorizedException({
        code: ErrorCodes.UNAUTHORIZED,
        message: 'Invalid token scope',
      });
    }
    if (!payload.jti) {
      throw new UnauthorizedException({
        code: ErrorCodes.TEMP_TOKEN_EXPIRED,
        message: 'Invalid registration token. Please verify your phone number again.',
      });
    }
    if (!payload.deviceId || payload.deviceId !== dto.deviceId) {
      throw new UnauthorizedException({
        code: ErrorCodes.TEMP_TOKEN_EXPIRED,
        message:
          'Registration token is not valid for this device. Please verify your phone number again.',
      });
    }

    const phoneNumber = payload.sub;

    validatePasswordPolicy(dto.password);

    // Username: pakai yang diberikan, atau buat otomatis dari nama.
    let normalizedUsername: string;
    if (dto.username && dto.username.trim()) {
      normalizedUsername = dto.username.trim().toLowerCase();
      if (normalizedUsername.length < 3 || normalizedUsername.length > 30) {
        throw new BadRequestException({
          code: ErrorCodes.VALIDATION_ERROR,
          message: 'Username must be between 3 and 30 characters',
        });
      }
      if (!/^[a-z0-9][a-z0-9._-]*[a-z0-9]$/.test(normalizedUsername)) {
        throw new BadRequestException({
          code: ErrorCodes.VALIDATION_ERROR,
          message:
            'Username may only contain lowercase letters, numbers, dots, dashes and underscores',
        });
      }
      if (RESERVED_USERNAMES.includes(normalizedUsername)) {
        throw new BadRequestException({
          code: ErrorCodes.USERNAME_RESERVED,
          message: 'Username is already taken',
        });
      }
      const taken = await this.prisma.user.findUnique({ where: { username: normalizedUsername } });
      if (taken) {
        throw new BadRequestException({
          code: ErrorCodes.USERNAME_TAKEN,
          message: 'Username is already taken',
        });
      }
    } else {
      normalizedUsername = await this.generateUniqueUsernameFromName(dto.fullName);
    }

    const phoneHash = hashPhoneNumber(phoneNumber);
    const existingPhone = await this.prisma.user.findFirst({
      where: { OR: [{ phoneNumberHash: phoneHash }, { phoneNumber }] },
    });
    if (existingPhone) {
      throw new ConflictException({
        code: ErrorCodes.VALIDATION_ERROR,
        message: 'Phone number already registered',
      });
    }

    // Referral opsional — diabaikan diam-diam bila tidak valid (perilaku lama).
    let referralCodeRecord: {
      id: string;
      userId: string;
      isActive: boolean;
      totalReferrals: number;
    } | null = null;
    if (dto.referralCode) {
      referralCodeRecord = await this.prisma.referralCode.findUnique({
        where: { code: dto.referralCode.toUpperCase() },
        select: { id: true, userId: true, isActive: true, totalReferrals: true },
      });
      if (
        !referralCodeRecord ||
        !referralCodeRecord.isActive ||
        referralCodeRecord.totalReferrals >= MAX_REFERRALS
      ) {
        referralCodeRecord = null;
      }
    }

    const userId = generateUserId();
    const myReferralCode = generateReferralCode();

    const encryptedPhone = await encryptPii(phoneNumber);
    const hashedPassword = await bcryptHash(dto.password, getBcryptRounds());

    const registrationTokenKey = TOKEN_BLACKLIST(`phone_register:${payload.jti}`);
    const registrationTokenTtl = Math.max(
      ((payload as TempTokenPayload & { exp?: number }).exp ?? 0) - Math.floor(Date.now() / 1000),
      1,
    );
    const tokenClaimed = await this.redis.setNx(registrationTokenKey, '1', registrationTokenTtl, {
      throwOnError: true,
    });
    if (!tokenClaimed) {
      throw new UnauthorizedException({
        code: ErrorCodes.TEMP_TOKEN_EXPIRED,
        message: 'Registration token has already been used. Please verify your phone number again.',
      });
    }

    let user: {
      id: string;
      userId: string;
      phoneNumber: string;
      fullName: string;
    };
    try {
      user = await this.prisma.$transaction(
        async (tx: Prisma.TransactionClient) => {
          const newUser = await tx.user.create({
            data: {
              userId,
              phoneNumber: encryptedPhone,
              phoneNumberHash: phoneHash,
              phoneVerified: true,
              // OTP registration memverifikasi nomor HP di titik ini — catat waktunya.
              phoneVerifiedAt: new Date(),
              email: null,
              emailVerified: false,
              password: hashedPassword,
              passwordChangedAt: new Date(),
              fullName: dto.fullName,
              username: normalizedUsername,
            },
          });

          await tx.wallet.create({ data: { userId: newUser.id } });
          await tx.notificationPreference.create({ data: { userId: newUser.id } });
          await tx.referralCode.create({ data: { userId: newUser.id, code: myReferralCode } });

          if (referralCodeRecord) {
            const codeUpdated = await tx.referralCode.updateMany({
              where: {
                id: referralCodeRecord.id,
                isActive: true,
                totalReferrals: { lt: MAX_REFERRALS },
              },
              data: { totalReferrals: { increment: 1 } },
            });
            if (codeUpdated.count > 0) {
              await tx.referralRelation.create({
                data: {
                  referralCodeId: referralCodeRecord.id,
                  referrerId: referralCodeRecord.userId,
                  refereeId: newUser.id,
                },
              });
            }
          }

          return newUser;
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted },
      );
    } catch (err: unknown) {
      // The token was claimed before the transaction to prevent concurrent replay.
      // Release it only when registration did not commit, so a transient or
      // duplicate input can be corrected without requesting another OTP.
      await this.redis.del(registrationTokenKey).catch(releaseErr => {
        this.logger.warn(
          `Failed to release registration token claim: ${releaseErr instanceof Error ? releaseErr.message : String(releaseErr)}`,
        );
      });
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        const target = (err.meta?.target as string[]) ?? [];
        if (target.includes('userId')) {
          throw new InternalServerErrorException({
            code: 'TRANSIENT_CONFLICT',
            message: 'Registration failed due to a transient conflict. Please try again.',
          });
        }
        if (target.includes('username')) {
          throw new BadRequestException({
            code: ErrorCodes.USERNAME_TAKEN,
            message: 'Username is already taken',
          });
        }
        if (target.includes('phoneNumber')) {
          throw new ConflictException({
            code: ErrorCodes.VALIDATION_ERROR,
            message: 'Phone number already registered',
          });
        }
      }
      throw err;
    }

    const refreshToken = this.tokenService.signRefreshToken({ sub: user.id });

    // Penautan akun sosial pasca-registrasi (identitas baru dari social login).
    // Nomor HP sudah terverifikasi di titik ini — penautan aman dilakukan.
    let socialLinked = false;
    if (dto.socialLinkToken) {
      socialLinked = await this.linkSocialSignupToken(dto.socialLinkToken, user.id, ipAddress).catch(
        (err) => {
          this.logger.warn(
            `social signup link failed for user ${user.id}: ${err instanceof Error ? err.message : String(err)}`,
          );
          return false;
        },
      );
    }

    const sessionId = await this.saveSession(
      user.id,
      refreshToken,
      dto.deviceId,
      dto.deviceInfo,
      ipAddress,
    );

    if (dto.deviceId) {
      await this.trackDevice(user.id, dto.deviceId, dto.deviceInfo, ipAddress).catch(err =>
        this.logger.error('trackDevice failed in phoneRegister()', err),
      );
    }

    const accessToken = this.tokenService.signAccessToken({
      sub: user.id,
      userId: user.userId,
      email: null,
      username: normalizedUsername,
      sessionId,
      kycStatus: 'UNVERIFIED',
      emailVerified: false,
    });

    this.auditLog.logUserAction({
      userId: user.id,
      action: UserAuditAction.REGISTER,
      entityType: 'User',
      entityId: user.id,
      description: `User registered via phone OTP from ${ipAddress}`,
      ipAddress,
    });

    await this.locationService.logEvent({
      userId: user.id,
      event: 'register',
      location: dto.location ?? null,
      ipAddress,
      deviceId: dto.deviceId,
    });

    return {
      accessToken,
      refreshToken,
      user: {
        id: user.id,
        userId: user.userId,
        username: normalizedUsername,
        email: null,
        fullName: user.fullName,
        avatarUrl: null,
        bio: null,
        accountType: 'PERSONAL',
        emailVerified: false,
        kycStatus: 'UNVERIFIED',
        isKahadePlus: false,
        subscriptionExpiresAt: null,
        membershipRank: 'BRONZE',
        isMfaEnabled: false,
        phoneNumber,
        phoneVerified: true,
        dateOfBirth: null,
        gender: null,
        createdAt: new Date().toISOString(),
      },
      socialLinked,
    };
  }

  /**
   * Tautkan identitas sosial ke user yang baru registrasi (scope 'social_signup').
   * Dipanggil SETELAH nomor HP terverifikasi di phoneRegister. Token sekali-pakai
   * diklaim SETELAH SocialAccount berhasil dibuat — kegagalan sebelum klaim
   * membiarkan token tetap valid untuk percobaan ulang dari Pengaturan.
   * Melempar Error bila token tidak valid (pemanggil memutuskan: registrasi
   * tetap sukses, socialLinked=false).
   */
  private async linkSocialSignupToken(
    socialLinkToken: string,
    userId: string,
    ipAddress: string,
  ): Promise<boolean> {
    let payload: TempTokenPayload;
    try {
      payload = this.tokenService.verifyTempToken(socialLinkToken);
    } catch {
      throw new Error('Token penautan sosial kedaluwarsa. Tautkan dari Pengaturan → Keamanan.');
    }
    const extra = payload as TempTokenPayload & {
      provider?: SocialProvider;
      providerSub?: string;
      email?: string | null;
    };
    if (
      payload.scope !== 'social_signup' ||
      payload.sub !== 'pending' ||
      !extra.provider ||
      !extra.providerSub
    ) {
      throw new Error('Token penautan sosial tidak valid.');
    }
    const providerLabel = extra.provider === 'GOOGLE' ? 'Google' : 'Apple';
    const taken = await this.prisma.socialAccount.findUnique({
      where: { provider_providerSub: { provider: extra.provider, providerSub: extra.providerSub } },
      select: { id: true, userId: true },
    });
    if (taken) {
      if (taken.userId === userId) return true; // idempoten
      throw new Error(`Akun ${providerLabel} ini sudah tertaut ke akun Kahade lain.`);
    }
    const now = new Date();
    try {
      await this.prisma.socialAccount.create({
        data: {
          userId,
          provider: extra.provider,
          providerSub: extra.providerSub,
          email: extra.email ?? null,
          lastUsedAt: now,
          consentAt: now,
          consentTextVersion: AuthService.SOCIAL_CONSENT_VERSION,
        },
      });
    } catch (err) {
      // Balapan dua percobaan dengan token yang sama: satu menang di unique
      // constraint. Perlakukan sebagai idempoten bila pemiliknya user ini.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        const raced = await this.prisma.socialAccount.findUnique({
          where: { provider_providerSub: { provider: extra.provider, providerSub: extra.providerSub } },
          select: { userId: true },
        });
        if (raced && raced.userId === userId) {
          // Lanjut ke klaim token di bawah.
        } else {
          throw new Error(`Akun ${providerLabel} ini sudah tertaut ke akun Kahade lain.`);
        }
      } else {
        throw err;
      }
    }
    await this.claimTempTokenOnce(
      payload.jti,
      this.getTempTokenTtlFromPayload(payload),
      'SOCIAL_SIGNUP_TOKEN_USED',
      'Token penautan sosial sudah dipakai.',
    );
    this.auditLog.logUserAction({
      userId,
      action: UserAuditAction.SOCIAL_PROVIDER_LINKED,
      entityType: 'SocialAccount',
      entityId: `${extra.provider}:${extra.providerSub}`,
      description: `${providerLabel} ditautkan saat registrasi nomor HP (identitas sosial baru)`,
      ipAddress,
    });
    await this.sendSocialSecurityNotification(
      userId,
      `Masuk dengan ${providerLabel} diaktifkan`,
      `Akun ${providerLabel} Anda telah ditautkan sebagai metode masuk. Jika ini bukan Anda, segera lepaskan dari menu Keamanan.`,
      ipAddress,
    ).catch(() => undefined);
    this.logger.log(`social_login_step provider=${extra.provider.toLowerCase()} step=signup_linked`);
    return true;
  }

  /** Buat username unik dari nama lengkap: nama + 4 digit acak. */
  private async generateUniqueUsernameFromName(fullName: string): Promise<string> {
    const base = fullName.toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 16) || 'kahade';
    for (let i = 0; i < 10; i++) {
      const candidate = `${base}${_cryptoRandomInt(1000, 10000)}`.slice(0, 30);
      if (RESERVED_USERNAMES.includes(candidate)) continue;
      const taken = await this.prisma.user.findUnique({ where: { username: candidate } });
      if (!taken) return candidate;
    }
    const fallback = `${base}${_cryptoRandomBytes(3).toString('hex')}`.slice(0, 30);
    return fallback;
  }

  // ─────────────────────────────────────────────────────────────────
  // SET USERNAME
  // ─────────────────────────────────────────────────────────────────
  async setUsername(userId: string, username: string): Promise<{ user: Record<string, unknown> }> {
    const normalizedUsername = username.trim().toLowerCase();
    if (normalizedUsername.length < 3 || normalizedUsername.length > 30) {
      throw new BadRequestException({
        code: ErrorCodes.VALIDATION_ERROR,
        message: 'Username must be between 3 and 30 characters',
      });
    }
    if (
      !/^[a-z0-9][a-z0-9._-]*[a-z0-9]$/.test(normalizedUsername) &&
      normalizedUsername.length > 2
    ) {
      throw new BadRequestException({
        code: ErrorCodes.VALIDATION_ERROR,
        message:
          'Username must start and end with a letter or number, and can only contain letters, numbers, dots, underscores, and hyphens',
      });
    }
    if (/[._-]{2,}/.test(normalizedUsername)) {
      throw new BadRequestException({
        code: ErrorCodes.VALIDATION_ERROR,
        message: 'Username cannot contain consecutive special characters',
      });
    }

    if (RESERVED_USERNAMES.includes(normalizedUsername)) {
      throw new BadRequestException({
        code: ErrorCodes.USERNAME_RESERVED,
        message: 'Username is already taken',
      });
    }

    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      throw new NotFoundException({ code: ErrorCodes.USER_NOT_FOUND, message: 'User not found' });
    }

    if (user.username) {
      throw new BadRequestException({
        code: ErrorCodes.USERNAME_ALREADY_SET,
        message: 'Username is already set and cannot be changed',
      });
    }

    try {
      const updated = await this.prisma.user.update({
        where: { id: userId },
        data: { username: normalizedUsername },
        select: {
          id: true,
          userId: true,
          username: true,
          email: true,
          fullName: true,
          bio: true,
          avatarUrl: true,
          accountType: true,
          emailVerified: true,
          kycStatus: true,
          isKahadePlus: true,
          subscriptionExpiresAt: true,
          membershipRank: true,
          isActive: true,
          isBanned: true,
          createdAt: true,
        },
      });

      const twoFactorAuth = await this.prisma.twoFactorAuth.findUnique({
        where: { userId },
        select: { isEnabled: true },
      });

      return {
        user: {
          ...updated,
          isMfaEnabled: twoFactorAuth?.isEnabled ?? false,
        },
      };
    } catch (err: unknown) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new BadRequestException({
          code: ErrorCodes.USERNAME_TAKEN,
          message: 'Username is already taken',
        });
      }
      throw err;
    }
  }

  // ─────────────────────────────────────────────────────────────────
  // VERIFY EMAIL
  // ─────────────────────────────────────────────────────────────────
  async verifyEmail(email: string, otp: string): Promise<{ message: string }> {
    const normalizedEmail = email.toLowerCase();
    const now = new Date();

    type VerifyResult =
      { ok: true } | { ok: false; reason: 'otp_invalid' | 'user_not_found' | 'account_inactive' };

    const result: VerifyResult = await this.prisma.$transaction(
      async (tx: Prisma.TransactionClient) => {
        // AUDIT-7: this endpoint is public; distinct 404/403 responses would turn it into an
        // account-enumeration and status oracle even though register/forgot-password/GET-link
        // all collapse to one message. Inactive/banned accounts simply cannot verify via OTP.
        const user = await tx.user.findUnique({
          where: { email: normalizedEmail },
          select: { id: true, isActive: true, isBanned: true },
        });
        if (!user) {
          return { ok: false, reason: 'otp_invalid' } as const;
        }
        if (!user.isActive || user.isBanned) {
          return { ok: false, reason: 'otp_invalid' } as const;
        }
        const record = await tx.otpCode.findFirst({
          where: {
            email: normalizedEmail,
            type: OtpType.EMAIL_VERIFICATION,
            isUsed: false,
            expiresAt: { gt: now },
            attempts: { lt: OTP_MAX_ATTEMPTS },
          },
          orderBy: { createdAt: 'desc' },
        });

        if (!record) {
          return { ok: false, reason: 'otp_invalid' } as const;
        }

        const bump = await tx.otpCode.updateMany({
          where: {
            id: record.id,
            isUsed: false,
            expiresAt: { gt: now },
            attempts: { lt: OTP_MAX_ATTEMPTS },
          },
          data: { attempts: { increment: 1 } },
        });
        if (bump.count === 0) return { ok: false, reason: 'otp_invalid' } as const;

        const isOtpValid = await verifyOtp(otp, record.code);
        if (!isOtpValid) return { ok: false, reason: 'otp_invalid' } as const;

        const otpUsed = await tx.otpCode.updateMany({
          where: { id: record.id, isUsed: false },
          data: { isUsed: true, usedAt: new Date() },
        });
        if (otpUsed.count === 0) return { ok: false, reason: 'otp_invalid' } as const;

        const userUpdate = await tx.user.updateMany({
          where: { email: normalizedEmail, isActive: true, isBanned: false },
          data: { emailVerified: true, emailVerifiedAt: new Date() },
        });

        if (userUpdate.count === 0) {
          return { ok: false, reason: 'otp_invalid' } as const;
        }

        return { ok: true } as const;
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );

    if (!result.ok) {
      throw new BadRequestException({
        code: ErrorCodes.OTP_INVALID,
        message: 'Invalid or expired verification code',
      });
    }

    return { message: 'Email verified successfully' };
  }

  // ─────────────────────────────────────────────────────────────────
  // RESEND VERIFICATION
  // ─────────────────────────────────────────────────────────────────
  async resendVerification(email: string, ipAddress?: string): Promise<{ message: string }> {
    const normalizedEmail = email.toLowerCase();
    const user = await this.prisma.user.findUnique({ where: { email: normalizedEmail } });

    if (!user || user.emailVerified || !user.isActive || user.isBanned) {
      return { message: 'If this email exists and is unverified, a new code has been sent.' };
    }

    await this.sendVerificationEmail(user.id, normalizedEmail, ipAddress);
    return { message: 'If this email exists and is unverified, a new code has been sent.' };
  }

  // ─────────────────────────────────────────────────────────────────
  // CORRECT EMAIL
  // ─────────────────────────────────────────────────────────────────
  async correctEmail(
    userId: string,
    newEmail: string,
    password: string,
    mfaCode?: string,
    ipAddress?: string,
  ): Promise<{ message: string }> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user)
      throw new NotFoundException({ code: ErrorCodes.USER_NOT_FOUND, message: 'User not found' });

    if (user.emailVerified) {
      throw new BadRequestException({
        code: 'EMAIL_ALREADY_VERIFIED',
        message: 'Email is already verified and cannot be changed through this endpoint.',
      });
    }

    if (!user.password) {
      throw new BadRequestException({
        code: ErrorCodes.PASSWORD_WRONG,
        message: 'Password login is not configured for this account',
      });
    }
    const isPasswordValid = await bcryptCompare(password, user.password);
    if (!isPasswordValid) {
      throw new BadRequestException({
        code: ErrorCodes.PASSWORD_WRONG,
        message: 'Password is incorrect',
      });
    }

    const normalizedNew = newEmail.toLowerCase();

    const existing = await this.prisma.user.findUnique({
      where: { email: normalizedNew },
      select: { id: true },
    });
    if (existing && existing.id !== userId) {
      throw new BadRequestException({
        code: ErrorCodes.VALIDATION_ERROR,
        message: 'Unable to update email address',
      });
    }

    // An email change transfers the primary recovery channel. Password compromise
    // alone must not be sufficient to replace it when the account has enabled 2FA.
    // Validate after non-sensitive input checks so an invalid target does not consume
    // a time-based authenticator code or a single-use backup code.
    await this.verifySensitiveMfa(userId, mfaCode);

    if (user.email) {
      await this.otpService.invalidateOtps(user.email, OtpType.EMAIL_VERIFICATION);
      await this.otpService.invalidateOtps(user.email, OtpType.WITHDRAW_CONFIRMATION);
      await this.otpService.invalidateOtps(user.email, OtpType.PASSWORD_RESET);
    }

    const oldEmail = user.email;

    if (oldEmail) {
      this.dispatchEmail({
        to: oldEmail,
        subject: 'Kahade - Email Address Changed',
        templateName: 'email-changed-notification',
        templateContext: { newEmail: normalizedNew },
      }).catch(err => {
        this.logger.error(
          `[SECURITY] Failed to notify old email about email change for user ${userId}: ${(err as Error).message}`,
        );
        this.createSecurityNotification(
          userId,
          'Email Address Changed',
          `Your email address was changed to ${normalizedNew}. If you did not make this change, please contact support immediately.`,
        ).catch(notifErr => {
          this.logger.error(
            `[SECURITY] Failed to create fallback notification for email change: ${(notifErr as Error).message}`,
          );
        });
      });
    }

    const emailChangedSessionIds = await this.prisma.$transaction(
      async tx => {
        await tx.user.update({
          where: { id: userId },
          data: { email: normalizedNew },
        });
        const sessions = await tx.userSession.findMany({
          where: { userId, isRevoked: false },
          select: { id: true },
        });
        await tx.userSession.updateMany({
          where: { userId, isRevoked: false },
          data: { isRevoked: true, revokedAt: new Date(), revokedReason: 'email_changed' },
        });
        await tx.userDevice.updateMany({
          where: { userId, isTrusted: true },
          data: { isTrusted: false, trustedAt: null },
        });
        return sessions.map(s => s.id);
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
    await this.revokeSessionsInRedis(emailChangedSessionIds).catch((err: unknown) => {
      this.logger.warn(
        `[SECURITY] Email change persisted but Redis session propagation is unavailable: ${err instanceof Error ? err.message : String(err)}`,
      );
    });

    await this.sendVerificationEmail(userId, normalizedNew, ipAddress);

    return {
      message:
        'Email address updated. A verification code has been sent to the new address. Please log in again.',
    };
  }

  // ─────────────────────────────────────────────────────────────────
  // FORGOT PASSWORD (via OTP WhatsApp user-initiated)
  // ─────────────────────────────────────────────────────────────────
  /**
   * Lupa password: identifier HARUS nomor HP. Membuat challenge trigger
   * WhatsApp (purpose=forgot_password); user mengirim refCode ke nomor
   * resmi Kahade, menerima OTP, lalu verifikasi → tempToken password_reset.
   */
  async forgotPassword(
    dto: { identifier: string; deviceId?: string; location?: LocationDto },
    ipAddress: string,
  ): Promise<TriggerPayload> {
    const phoneNumber = normalizeIndonesianPhone(dto.identifier);
    return this.otpTriggerService.createTrigger(
      {
        phoneNumber,
        deviceId: dto.deviceId,
        purpose: OtpTriggerPurpose.FORGOT_PASSWORD,
        location: dto.location,
      },
      ipAddress,
    );
  }

  // ─────────────────────────────────────────────────────────────────
  // RESET PASSWORD (via tempToken password_reset)
  // ─────────────────────────────────────────────────────────────────
  async resetPassword(
    dto: {
      tempToken: string;
      deviceId: string;
      newPassword: string;
      confirmPassword?: string;
      location?: LocationDto;
    },
    ipAddress: string,
  ): Promise<{ message: string }> {
    if (dto.confirmPassword !== undefined && dto.newPassword !== dto.confirmPassword) {
      throw new BadRequestException({
        code: ErrorCodes.PASSWORDS_DO_NOT_MATCH,
        message: 'Passwords do not match',
      });
    }

    validatePasswordPolicy(dto.newPassword);

    let payload: TempTokenPayload;
    try {
      payload = this.tokenService.verifyTempToken(dto.tempToken);
    } catch {
      throw new UnauthorizedException({
        code: ErrorCodes.TEMP_TOKEN_EXPIRED,
        message: 'Reset token expired. Please request a new OTP.',
      });
    }
    if (payload.scope !== 'password_reset') {
      throw new UnauthorizedException({
        code: ErrorCodes.UNAUTHORIZED,
        message: 'Invalid token scope',
      });
    }

    // SEC (round-2): temp token terikat ke deviceId saat OTP diverifikasi —
    // tolak bila device berbeda. Cek SEBELUM claimTempTokenOnce agar token
    // valid tidak terbakar oleh request dari device yang salah.
    if (!payload.deviceId || payload.deviceId !== dto.deviceId) {
      this.logger.warn(
        `[SECURITY] resetPassword ditolak: deviceId tidak cocok (token untuk device terikat, request dari device lain).`,
      );
      throw new UnauthorizedException({
        code: ErrorCodes.TEMP_TOKEN_EXPIRED,
        message: 'Reset token is not valid for this device. Please verify your phone number again.',
      });
    }

    // Temp token sekali pakai: klaim atomik (SET NX) SEBELUM mutasi.
    // 03-#4: pola check-then-set sebelumnya punya race TOCTOU — dua request
    // konkuren bisa sama-sama lolos cek awal. Bila transaksi di bawah gagal
    // setelah klaim, token tetap dianggap terpakai (fail-closed, konsisten
    // dengan phoneRegister).
    await this.claimTempTokenOnce(
      payload.jti,
      this.getTempTokenTtlFromPayload(payload),
      ErrorCodes.TEMP_TOKEN_EXPIRED,
      'Reset token has already been used. Please request a new OTP.',
    );

    const user = await this.prisma.user.findUnique({ where: { id: payload.sub } });
    if (!user || !user.isActive || user.isBanned) {
      throw new BadRequestException({
        code: ErrorCodes.OTP_INVALID,
        message: 'Invalid or expired reset token',
      });
    }
    if (user.lockedUntil && user.lockedUntil > new Date()) {
      throw new UnauthorizedException({
        code: ErrorCodes.ACCOUNT_LOCKED,
        message: 'Account is temporarily locked due to too many failed attempts',
      });
    }

    const isSamePassword = user.password ? await bcryptCompare(dto.newPassword, user.password) : false;
    if (isSamePassword) {
      throw new BadRequestException({
        code: ErrorCodes.PASSWORD_SAME_AS_OLD,
        message: 'New password cannot be the same as your current password',
      });
    }

    const recentPasswords = await this.prisma.passwordHistory.findMany({
      where: { userId: user.id },
      orderBy: { createdAt: 'desc' },
      take: 5,
    });
    // B1-003 (perf): compare history diparalel (bcrypt async, aman) — semantik
    // identik: tolak bila SALAH SATU cocok. Rounds & perilaku tidak berubah.
    const reuseChecks = await Promise.all(
      recentPasswords.map((historical) => bcryptCompare(dto.newPassword, historical.passwordHash)),
    );
    if (reuseChecks.some(Boolean)) {
      throw new BadRequestException({
        code: ErrorCodes.PASSWORD_RECENTLY_USED,
        message: 'New password cannot be the same as one of your last 5 passwords',
      });
    }

    const hashedPassword = await bcryptHash(dto.newPassword, getBcryptRounds());

    const resetSessionIds = await this.prisma.$transaction(
      async (tx: Prisma.TransactionClient) => {
        const sessions = await tx.userSession.findMany({
          where: { userId: user.id, isRevoked: false },
          select: { id: true },
        });
        await tx.user.update({
          where: { id: user.id },
          data: { password: hashedPassword, passwordChangedAt: new Date() },
        });
        // User.password is nullable in the schema while PasswordHistory.passwordHash
        // is required, so a null password would make Prisma reject this write and
        // turn a reset into a 500. Skip history when there is no previous password.
        if (user.password) {
          await tx.passwordHistory.create({
            data: { userId: user.id, passwordHash: user.password },
          });
        }
        const oldEntries = await tx.passwordHistory.findMany({
          where: { userId: user.id },
          orderBy: { createdAt: 'desc' },
          skip: 5,
          select: { id: true },
        });
        if (oldEntries.length > 0) {
          await tx.passwordHistory.deleteMany({
            where: { id: { in: oldEntries.map(e => e.id) } },
          });
        }
        await tx.userSession.updateMany({
          where: { userId: user.id, isRevoked: false },
          data: { isRevoked: true, revokedAt: new Date(), revokedReason: 'password_reset' },
        });
        await tx.userDevice.updateMany({
          where: { userId: user.id, isTrusted: true },
          data: { isTrusted: false, trustedAt: null },
        });
        return sessions.map(s => s.id);
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );

    await this.revokeSessionsInRedis(resetSessionIds).catch((err: unknown) => {
      this.logger.warn(
        `[SECURITY] Password reset persisted but Redis session propagation is unavailable: ${err instanceof Error ? err.message : String(err)}`,
      );
    });

    // Tandai temp token sudah dipakai agar tidak bisa di-replay selama sisa
    // masa berlakunya (5 menit). Best-effort: reset yang sudah tersimpan di
    // 03-#4: token sudah diklaim atomik (SET NX) sebelum transaksi — tidak
    // perlu tulis best-effort setelah commit; menulis setelah commit justru
    // membuka race TOCTOU yang ingin ditutup.

    // Konfirmasi email hanya bila user punya email (registrasi baru tanpa email).
    if (user.email) {
      this.dispatchEmail({
        to: user.email,
        subject: 'Kahade - Your Password Has Been Reset',
        templateName: 'password-reset-confirm',
        templateContext: {},
      }).catch(() => undefined);
    }
    this.createSecurityNotification(
      user.id,
      'Password Reset',
      'Your password was reset and every active session and trusted device was signed out. If this was not you, contact support immediately.',
      NotificationType.SECURITY_PASSWORD_CHANGED,
    ).catch(() => undefined);

    this.auditLog.logUserAction({
      userId: user.id,
      action: UserAuditAction.PASSWORD_RESET,
      entityType: 'User',
      entityId: user.id,
      description: 'Password reset via WhatsApp OTP',
      ipAddress,
    });

    await this.locationService.logEvent({
      userId: user.id,
      event: 'password_reset',
      location: dto.location ?? null,
      ipAddress,
      deviceId: payload.deviceId,
    });

    return { message: 'Password reset successfully. Please log in again.' };
  }

  // ─────────────────────────────────────────────────────────────────
  // CONFIRM PHONE MIGRATION (akun lama → tambah & verifikasi nomor HP)
  // ─────────────────────────────────────────────────────────────────
  /**
   * Konfirmasi migrasi: tempToken scope=phone_migration (diterbitkan setelah
   * password valid di login() atau setelah OTP terverifikasi dengan purpose
   * migrate_phone) + nomor HP yang sudah diverifikasi via WhatsApp.
   * Menerbitkan sesi penuh; hormati 2FA bila aktif.
   */
  async confirmPhoneMigration(
    dto: {
      tempToken: string;
      deviceId: string;
      deviceInfo?: string;
      location?: LocationDto;
    },
    ipAddress: string,
  ): Promise<LoginResult> {
    let payload: TempTokenPayload;
    try {
      payload = this.tokenService.verifyTempToken(dto.tempToken);
    } catch {
      throw new UnauthorizedException({
        code: ErrorCodes.TEMP_TOKEN_EXPIRED,
        message: 'Sesi migrasi kedaluwarsa. Silakan masuk ulang.',
      });
    }
    if (payload.scope !== 'phone_migration') {
      throw new UnauthorizedException({
        code: ErrorCodes.UNAUTHORIZED,
        message: 'Token tidak valid untuk migrasi',
      });
    }
    if (!payload.deviceId || payload.deviceId !== dto.deviceId) {
      throw new UnauthorizedException({
        code: ErrorCodes.UNAUTHORIZED,
        message: 'Token migrasi tidak berlaku untuk perangkat ini',
      });
    }
    if (!payload.phone) {
      throw new UnauthorizedException({
        code: ErrorCodes.UNAUTHORIZED,
        message: 'Nomor HP belum diverifikasi. Selesaikan verifikasi WhatsApp dulu.',
      });
    }

    // Temp token sekali pakai: klaim atomik (SET NX) SEBELUM mutasi.
    // 03-#4: pola check-then-set sebelumnya punya race TOCTOU.
    await this.claimTempTokenOnce(
      payload.jti,
      this.getTempTokenTtlFromPayload(payload),
      ErrorCodes.TEMP_TOKEN_EXPIRED,
      'Token migrasi sudah dipakai. Silakan masuk ulang.',
    );

    const phoneNumber = normalizeIndonesianPhone(payload.phone);
    const phoneHash = hashPhoneNumber(phoneNumber);

    const user = await this.prisma.user.findUnique({ where: { id: payload.sub } });
    if (!user || !user.isActive || user.isBanned) {
      throw new UnauthorizedException({
        code: ErrorCodes.UNAUTHORIZED,
        message: 'Akun tidak valid',
      });
    }
    if (user.lockedUntil && user.lockedUntil > new Date()) {
      throw new UnauthorizedException({
        code: ErrorCodes.ACCOUNT_LOCKED,
        message: 'Account is temporarily locked due to too many failed attempts',
      });
    }

    const owner = await this.prisma.user.findFirst({
      where: {
        OR: [{ phoneNumberHash: phoneHash }, { phoneNumber }],
        NOT: { id: user.id },
      },
      select: { id: true },
    });
    if (owner) {
      throw new ConflictException({
        code: ErrorCodes.VALIDATION_ERROR,
        message: 'Nomor HP sudah dipakai akun lain.',
      });
    }

    const encryptedPhone = await encryptPii(phoneNumber);
    const updatedUser = await this.prisma.user.update({
      where: { id: user.id },
      data: {
        phoneNumber: encryptedPhone,
        phoneNumberHash: phoneHash,
        phoneVerified: true,
        phoneVerifiedAt: new Date(),
      },
    });

    // 03-#4: token sudah diklaim atomik sebelum mutasi — tidak perlu tulis
    // best-effort setelah commit.

    this.auditLog.logUserAction({
      userId: user.id,
      action: UserAuditAction.PROFILE_UPDATED,
      entityType: 'User',
      entityId: user.id,
      description: `Phone migration completed from ${ipAddress}`,
      ipAddress,
    });

    await this.locationService.logEvent({
      userId: user.id,
      event: 'phone_migration',
      location: dto.location ?? null,
      ipAddress,
      deviceId: dto.deviceId,
    });

    const twoFactorAuth = await this.prisma.twoFactorAuth.findUnique({
      where: { userId: user.id },
    });
    if (twoFactorAuth?.isEnabled) {
      let skipTwoFa = false;
      if (dto.deviceId) {
        const trusted = await this.prisma.userDevice.findFirst({
          where: { userId: user.id, deviceId: dto.deviceId, isTrusted: true },
        });
        skipTwoFa = !!trusted;
      }
      if (!skipTwoFa) {
        const tempToken = this.tokenService.signTempToken({
          sub: user.id,
          scope: '2fa_verify',
          deviceId: dto.deviceId,
        });
        return { requires2FA: true, tempToken };
      }
    }

    return this.issueLoginSession(updatedUser, ipAddress, {
      deviceId: dto.deviceId,
      deviceInfo: dto.deviceInfo,
      isMfaEnabled: twoFactorAuth?.isEnabled ?? false,
      location: dto.location,
    });
  }

  // ─────────────────────────────────────────────────────────────────
  // LOGIN
  // ─────────────────────────────────────────────────────────────────
  async login(
    dto: {
      identifier: string;
      password: string;
      deviceId: string;
      deviceInfo?: string;
      location?: LocationDto;
    },
    ipAddress: string,
  ): Promise<LoginResult | { requiresPhoneMigration: true; migrationToken: string }> {
    const LOGIN_IP_KEY = `login_ip_rate:${ipAddress}`;
    const ipAttempts = await this.redis.incrWithTtl(LOGIN_IP_KEY, 900);
    if (ipAttempts > 20) {
      throw new HttpException(
        {
          code: ErrorCodes.TOO_MANY_REQUESTS,
          message: 'Too many login attempts. Please try again later.',
        },
        429,
      );
    }

    const loginStart = Date.now();
    const user = await this.findUserByIdentifier(dto.identifier.trim());

    if (!user) {
      const fallbackHash = _dummyHash || DUMMY_BCRYPT_HASH_FALLBACK;
      await bcryptCompare(dto.password, fallbackHash);
      const elapsed = Date.now() - loginStart;
      const pad = Math.max(0, 250 - elapsed) + _cryptoRandomInt(50, 200);
      await new Promise(r => setTimeout(r, pad));
      throw new UnauthorizedException({
        code: ErrorCodes.INVALID_CREDENTIALS,
        message: 'Invalid credentials',
      });
    }

    // Always run bcryptCompare before any status checks to prevent timing side-channels.
    // Without this, an attacker can distinguish "inactive account" (~1ms) from "wrong password" (~100ms)
    // revealing that the account exists and its status — even before a password is submitted.
    // SEC (round-2): akun passwordless (user.password null — cth. hanya login
    // sosial/OTP) tetap menjalani dummy bcrypt agar timing-nya identik dengan
    // password salah (anti-enumeration); hasilnya selalu false.
    let isPasswordValid: boolean;
    if (user.password) {
      isPasswordValid = await bcryptCompare(dto.password, user.password);
    } else {
      await bcryptCompare(dto.password, _dummyHash || DUMMY_BCRYPT_HASH_FALLBACK);
      isPasswordValid = false;
    }

    if (!user.isActive || user.isBanned) {
      throw new UnauthorizedException({
        code: ErrorCodes.INVALID_CREDENTIALS,
        message: 'Invalid credentials',
      });
    }
    // BAI-074: suspend ringan ikut diblokir di jalur login password.
    await this.assertNotSuspended(user.id);

    if (user.lockedUntil && user.lockedUntil > new Date()) {
      const remainingMs = user.lockedUntil!.getTime() - Date.now();
      const remainingSeconds = Math.ceil(remainingMs / 1000);
      throw new UnauthorizedException({
        code: ErrorCodes.ACCOUNT_LOCKED,
        message: 'Account is temporarily locked due to too many failed attempts',
        lockoutRemainingSeconds: remainingSeconds,
      });
    }

    if (!isPasswordValid) {
      // SEC (round-2): akun TANPA password tidak boleh menaikkan
      // failedLoginAttempts / lockout permanen — tidak ada password yang bisa
      // di-brute-force, dan lockout permanen (isActive=false) akan menjadi DoS
      // terhadap pemilik akun yang sah. Tetap tolak dengan error generik.
      if (!user.password) {
        throw new UnauthorizedException({
          code: ErrorCodes.INVALID_CREDENTIALS,
          message: 'Invalid credentials',
        });
      }
      const updated = await this.prisma.user.update({
        where: { id: user.id },
        data: { failedLoginAttempts: { increment: 1 } },
        select: { failedLoginAttempts: true },
      });
      if (updated.failedLoginAttempts >= ACCOUNT_LOCK_MAX_ATTEMPTS) {
        let cycleCount = 1;
        try {
          const lockoutCycleKey = `lockout_cycles:${user.id}`;
          cycleCount = await this.redis.incrWithTtl(lockoutCycleKey, 7 * 24 * 3600);
        } catch (redisErr) {
          this.logger.warn(
            `[AUTH] Redis unavailable for lockout cycle tracking (user: ${user.id}), falling back to base lockout`,
            redisErr,
          );
          cycleCount = 1;
        }
        const maxCycles = this.configService.get<number>('app.accountLockMaxCycles') ?? 5;
        if (cycleCount >= maxCycles) {
          await this.prisma.user.update({
            where: { id: user.id },
            data: { isActive: false, failedLoginAttempts: 0 },
          });
          const lockedSessionIds = await this.prisma.$transaction(
            async tx => {
              const sessions = await tx.userSession.findMany({
                where: { userId: user.id, isRevoked: false },
                select: { id: true },
              });
              await tx.userSession.updateMany({
                where: { userId: user.id, isRevoked: false },
                data: {
                  isRevoked: true,
                  revokedAt: new Date(),
                  revokedReason: 'account_permanently_locked',
                },
              });
              return sessions.map(session => session.id);
            },
            { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
          );
          await this.revokeSessionsInRedis(lockedSessionIds).catch(err => {
            this.logger.error(
              `[AUTH] Failed to blacklist sessions after permanent lockout for user ${user.id}: ${err instanceof Error ? err.message : String(err)}`,
            );
          });
          this.notifyAccountLocked(user.id, user.email ?? '', ipAddress).catch(err => {
            this.logger.error('[AUTH] Failed to send permanent lockout notification', err);
          });
          throw new UnauthorizedException({
            code: ErrorCodes.ACCOUNT_LOCKED,
            message:
              'Account has been permanently locked due to repeated failed attempts. Contact support.',
          });
        }
        const baseDuration = ACCOUNT_LOCK_DURATION_MINUTES;
        const progressiveDuration = baseDuration * Math.pow(2, cycleCount - 1);
        await this.prisma.user.update({
          where: { id: user.id },
          data: {
            failedLoginAttempts: 0,
            lockedUntil: addMinutes(new Date(), progressiveDuration),
          },
        });
        this.notifyAccountLocked(user.id, user.email ?? '', ipAddress).catch(err => {
          this.logger.error('[AUTH] Failed to send account lockout notification', err);
        });
      }
      throw new UnauthorizedException({
        code: ErrorCodes.INVALID_CREDENTIALS,
        message: 'Invalid credentials',
      });
    }

    // AUDIT-6: a successful password check refunds *this* attempt to the shared per-IP
    // budget — legitimate users on carrier-grade NAT IPs (several households per address)
    // must not exhaust the 20/15min allowance with successes alone. Failure counts from
    // other actors on the same IP are untouched because we decrement by one.
    if (isPasswordValid) {
      const remaining = await this.redis.decr(LOGIN_IP_KEY).catch(() => undefined);
      if (typeof remaining === 'number' && remaining < 0) {
        await this.redis.del(LOGIN_IP_KEY).catch(() => undefined);
      }
    }

    // Migrasi wajib: akun lama yang nomor HP-nya belum terverifikasi harus
    // verifikasi via WhatsApp dulu sebelum sesi diterbitkan.
    if (isPasswordValid && !user.phoneVerified) {
      const migrationToken = this.tokenService.signTempToken({
        sub: user.id,
        scope: 'phone_migration',
        deviceId: dto.deviceId,
      });
      await this.locationService.logEvent({
        userId: user.id,
        event: 'login',
        location: dto.location ?? null,
        ipAddress,
        deviceId: dto.deviceId,
      });
      return { requiresPhoneMigration: true as const, migrationToken };
    }

    // Do not reset lockout counters here; verify2faLogin() re-checks and clears them
    // after the second factor succeeds so a tempToken cannot bypass a concurrent lockout.
    const twoFactorAuth = await this.prisma.twoFactorAuth.findUnique({
      where: { userId: user.id },
    });
    if (twoFactorAuth?.isEnabled) {
      let skipTwoFa = false;
      if (dto.deviceId) {
        const trustedDevice = await this.prisma.userDevice.findFirst({
          where: { userId: user.id, deviceId: dto.deviceId, isTrusted: true },
        });
        if (trustedDevice?.trustedAt) {
          const trustExpiryMs =
            (this.configService.get<number>('app.trustedDeviceDays') ?? 30) * 24 * 60 * 60 * 1000;
          const isExpired = Date.now() - trustedDevice.trustedAt.getTime() >= trustExpiryMs;
          if (isExpired) {
            await this.prisma.userDevice.update({
              where: { id: trustedDevice.id },
              data: { isTrusted: false, trustedAt: null },
            });
            this.logger.log(`Trusted device ${dto.deviceId} expired for user ${user.id}`);
          } else {
            skipTwoFa = true;
            this.logger.log(`Skipping 2FA for trusted device ${dto.deviceId} (user ${user.id})`);
          }
        }
      }
      if (!skipTwoFa) {
        const tempToken = this.tokenService.signTempToken({
          sub: user.id,
          scope: '2fa_verify',
          deviceId: dto.deviceId,
        });
        return { requires2FA: true, tempToken };
      }
    }

    return this.issueLoginSession(user, ipAddress, {
      deviceId: dto.deviceId,
      deviceInfo: dto.deviceInfo,
      password: dto.password,
      isMfaEnabled: twoFactorAuth?.isEnabled ?? false,
      location: dto.location,
    });
  }

  /**
   * Menerbitkan sesi login penuh: reset lockout, upgrade bcrypt bila perlu,
   * simpan sesi + device, terbitkan token, catat audit.
   * Dipakai oleh login() dan confirmPhoneMigration().
   */
  private async issueLoginSession(
    user: User,
    ipAddress: string,
    opts: {
      deviceId: string;
      deviceInfo?: string;
      password?: string;
      isMfaEnabled?: boolean;
      location?: LocationDto;
    },
  ): Promise<LoginResult> {
    const lockoutCycleKey = `lockout_cycles:${user.id}`;
    await this.redis
      .del(lockoutCycleKey)
      .catch(err =>
        this.logger.warn(`silent-catch: ${err instanceof Error ? err.message : String(err)}`),
      );
    const updateData: Record<string, unknown> = {
      failedLoginAttempts: 0,
      lockedUntil: null,
      lastLoginAt: new Date(),
      lastLoginIp: ipAddress,
    };

    const storedRounds = user.password && opts.password ? this.extractBcryptRounds(user.password) : 0;
    if (storedRounds > 0 && storedRounds < getBcryptRounds()) {
      // AUDIT-9: do NOT stamp passwordChangedAt here. The field means "the user rotated
      // their password" (surfaced by GET /users/me and usable for iat-based session
      // invalidation); a transparent server-side cost-factor upgrade is not a password
      // change and previously rewrote that security signal on login.
      updateData.password = await bcryptHash(opts.password as string, getBcryptRounds());
      this.logger.log(
        `[CRY-020] Upgraded password hash rounds from ${storedRounds} to ${getBcryptRounds()} for user ${user.id}`,
      );
    }

    await this.prisma.user.update({
      where: { id: user.id },
      data: updateData,
    });

    const refreshToken = this.tokenService.signRefreshToken({ sub: user.id });
    const sessionId = await this.saveSession(
      user.id,
      refreshToken,
      opts.deviceId,
      opts.deviceInfo,
      ipAddress,
    );

    if (opts.deviceId) {
      await this.trackDevice(user.id, opts.deviceId, opts.deviceInfo, ipAddress).catch(err =>
        this.logger.error('trackDevice failed in issueLoginSession()', err),
      );
    }

    const accessToken = this.tokenService.signAccessToken({
      sub: user.id,
      userId: user.userId,
      email: user.email ?? '',
      username: user.username ?? '',
      sessionId,
      kycStatus: user.kycStatus,
      emailVerified: user.emailVerified,
    });

    this.auditLog.logUserAction({
      userId: user.id,
      action: UserAuditAction.LOGIN,
      entityType: 'User',
      entityId: user.id,
      description: `User logged in from ${ipAddress}`,
      ipAddress,
    });

    await this.locationService.logEvent({
      userId: user.id,
      event: 'login',
      location: opts.location ?? null,
      ipAddress,
      deviceId: opts.deviceId,
    });

    return {
      accessToken,
      refreshToken,
      user: {
        id: user.id,
        userId: user.userId,
        username: user.username,
        email: user.email ?? '',
        fullName: user.fullName,
        avatarUrl: user.avatarUrl ?? null,
        bio: user.bio ?? null,
        accountType: user.accountType,
        emailVerified: user.emailVerified,
        kycStatus: user.kycStatus,
        isKahadePlus: user.isKahadePlus,
        subscriptionExpiresAt: user.subscriptionExpiresAt
          ? user.subscriptionExpiresAt.toISOString()
          : null,
        membershipRank: user.membershipRank,
        isMfaEnabled: opts.isMfaEnabled ?? false,
        phoneNumber: await decryptPiiSafe(user.phoneNumber),
        phoneVerified: user.phoneVerified ?? false,
        dateOfBirth: user.dateOfBirth ? user.dateOfBirth.toISOString() : null,
        gender: user.gender ?? null,
        createdAt: user.createdAt.toISOString(),
      },
    };
  }

  // ─────────────────────────────────────────────────────────────────
  // VERIFY 2FA LOGIN
  // ─────────────────────────────────────────────────────────────────
  async verify2faLogin(
    tempToken: string,
    code: string,
    deviceId: string,
    deviceInfo: string,
    ipAddress: string,
  ): Promise<{ accessToken: string; refreshToken: string; user: LoginUserPayload }> {
    let payload: TempTokenPayload;
    try {
      payload = this.tokenService.verifyTempToken(tempToken);
    } catch {
      throw new UnauthorizedException({
        code: ErrorCodes.TEMP_TOKEN_EXPIRED,
        message: 'Temp token expired',
      });
    }

    if (payload.scope !== '2fa_verify') {
      throw new UnauthorizedException({
        code: ErrorCodes.UNAUTHORIZED,
        message: 'Invalid token scope',
      });
    }

    // 03-#4: temp token diklaim atomik (SET NX) SETELAH TOTP valid, sebelum
    // sesi dibuat — menutup race TOCTOU pada jalur sukses sambil tetap
    // mengizinkan retry kode TOTP yang salah ketik. Klaim di awal akan
    // membakar token hanya karena salah ketik (UX buruk); klaim di sini
    // tetap fail-closed untuk dua request konkuren dengan TOTP valid.
    // (Pengecekan di bawah dihapus — digantikan klaim atomik.)
    if (!payload.deviceId || payload.deviceId !== deviceId) {
      throw new UnauthorizedException({
        code: ErrorCodes.TEMP_TOKEN_EXPIRED,
        message: 'Temp token is not valid for this device. Please log in again.',
      });
    }
    // 03-#4: pre-check check-then-set dihapus — digantikan klaim atomik
    // setelah TOTP valid (di bawah). Tanpa pre-check pun aman: dua request
    // konkuren dengan TOTP valid akan berebut klaim SET NX.

    const userId = payload.sub;

    const attemptKey = TWO_FA_ATTEMPT_KEY(userId);
    const attempts = await this.redis.incrWithTtl(attemptKey, 5 * 60);
    if (attempts > TWO_FA_MAX_ATTEMPTS) {
      throw new ForbiddenException({
        code: ErrorCodes.TOO_MANY_REQUESTS,
        message: 'Too many 2FA attempts. Please log in again.',
      });
    }

    // Enforce lockout before TOTP: account may have been locked after tempToken was issued.
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      throw new NotFoundException({ code: ErrorCodes.USER_NOT_FOUND, message: 'User not found' });
    }
    if (!user.isActive) {
      throw new ForbiddenException({
        code: ErrorCodes.ACCOUNT_INACTIVE,
        message: 'Account is inactive',
      });
    }
    if (user.isBanned) {
      throw new ForbiddenException({
        code: ErrorCodes.ACCOUNT_BANNED,
        message: 'Account has been banned',
      });
    }

    const twoFactorAuth = await this.prisma.twoFactorAuth.findUnique({ where: { userId } });

    if (!twoFactorAuth?.isEnabled) {
      throw new BadRequestException({
        code: ErrorCodes.TWO_FA_NOT_ENABLED,
        message: '2FA not enabled',
      });
    }

    if (!twoFactorAuth.secret) {
      throw new BadRequestException({
        code: ErrorCodes.TWO_FA_NOT_ENABLED,
        message: '2FA secret is missing, please re-setup 2FA',
      });
    }

    let decryptedSecret: string;
    try {
      decryptedSecret = await decryptAES(twoFactorAuth.secret);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      this.logger.error(`[2FA] Failed to decrypt TOTP secret for user ${userId}: ${errMsg}`);
      throw new InternalServerErrorException({
        code: ErrorCodes.INTERNAL_SERVER_ERROR,
        message: 'Unable to verify 2FA code. Please try again or contact support.',
      });
    }
    // Always run TOTP verify regardless of lockout — constant-time path
    const totpVerified = speakeasy.totp.verify({
      secret: decryptedSecret,
      encoding: 'base32',
      token: code,
      window: 1,
    });

    // Now enforce lockout — after the constant-time TOTP work is done.
    // Only consider attempt-based lockout if the time lock is still active.
    // When lockedUntil has expired, the user should be allowed to attempt login again
    // (the counter resets on successful 2FA at line 733-735).
    const isTimeLocked = user.lockedUntil && user.lockedUntil > new Date();
    if (isTimeLocked) {
      const remainingMs = user.lockedUntil!.getTime() - Date.now();
      const remainingSeconds = Math.ceil(remainingMs / 1000);
      throw new UnauthorizedException({
        code: ErrorCodes.ACCOUNT_LOCKED,
        message: 'Account is temporarily locked due to too many failed attempts',
        lockoutRemainingSeconds: remainingSeconds,
      });
    }

    let usedBackupCode = false;
    if (!totpVerified) {
      const backupCodeMatch = await this.checkAndConsumeBackupCode(twoFactorAuth, code);
      if (!backupCodeMatch) {
        throw new BadRequestException({
          code: ErrorCodes.INVALID_2FA_CODE,
          message: 'Invalid 2FA code',
        });
      }
      usedBackupCode = true;
    }

    if (usedBackupCode) {
      this.notifyBackupCodeUsed(userId).catch(err => {
        this.logger.error('[2FA] Failed to send backup code usage notification', err);
      });
    } else {
      const hmacSecret =
        this.configService.get<string>('crypto.hmacSecretKey') ||
        this.configService.get<string>('jwt.secret') ||
        '';
      const codeHash = sha256(hmacSecret + ':totp:' + code);
      const totpUsedKey = TOTP_USED_CODE(userId);
      const client = this.redis.getClient();
      const redisKey = `${this.redis.getPrefix()}${totpUsedKey}`;
      const wasAdded = await client.sadd(redisKey, codeHash);
      if (wasAdded === 0) {
        throw new BadRequestException({
          code: ErrorCodes.INVALID_2FA_CODE,
          message: 'TOTP code already used. Wait for the next code.',
        });
      }
      await client.expire(redisKey, 90);
    }

    // 03-#4: klaim atomik temp token SETELAH TOTP valid, SEBELUM sesi dibuat.
    // Dua request konkuren dengan TOTP valid: hanya satu yang memenangkan
    // klaim; yang kalah ditolak. Fail-closed bila Redis tidak tersedia.
    await this.claimTempTokenOnce(
      payload.jti,
      this.getTempTokenTtlFromPayload(payload),
      ErrorCodes.TEMP_TOKEN_EXPIRED,
      'Temp token has already been used. Please log in again.',
    );

    // Clear the attempt counter on successful login
    await this.redis.del(attemptKey);

    const lockoutCycleKey2fa = `lockout_cycles:${user.id}`;
    await this.redis
      .del(lockoutCycleKey2fa)
      .catch(err =>
        this.logger.warn(`silent-catch: ${err instanceof Error ? err.message : String(err)}`),
      );
    await this.prisma.user.update({
      where: { id: user.id },
      data: {
        failedLoginAttempts: 0,
        lockedUntil: null,
        lastLoginAt: new Date(),
        lastLoginIp: ipAddress,
      },
    });

    const refreshToken = this.tokenService.signRefreshToken({ sub: user.id });
    const sessionId = await this.saveSession(
      user.id,
      refreshToken,
      deviceId,
      deviceInfo,
      ipAddress,
    );

    await this.trackDevice(user.id, deviceId, deviceInfo, ipAddress).catch(err =>
      this.logger.error('trackDevice failed in verify2faLogin()', err),
    );

    const accessToken = this.tokenService.signAccessToken({
      sub: user.id,
      userId: user.userId,
      email: user.email ?? '',
      username: user.username ?? '',
      sessionId,
      kycStatus: user.kycStatus,
      emailVerified: user.emailVerified,
    });

    return {
      accessToken,
      refreshToken,
      user: {
        id: user.id,
        userId: user.userId,
        username: user.username,
        email: user.email ?? '',
        fullName: user.fullName,
        avatarUrl: user.avatarUrl ?? null,
        bio: user.bio ?? null,
        accountType: user.accountType,
        emailVerified: user.emailVerified,
        kycStatus: user.kycStatus,
        isKahadePlus: user.isKahadePlus,
        subscriptionExpiresAt: user.subscriptionExpiresAt
          ? user.subscriptionExpiresAt.toISOString()
          : null,
        membershipRank: user.membershipRank,
        isMfaEnabled: true,
        phoneNumber: await decryptPiiSafe(user.phoneNumber),
        phoneVerified: user.phoneVerified ?? false,
        dateOfBirth: user.dateOfBirth ? user.dateOfBirth.toISOString() : null,
        gender: user.gender ?? null,
        createdAt: user.createdAt.toISOString(),
      },
    };
  }

  // ─────────────────────────────────────────────────────────────────
  // REFRESH TOKEN
  // ─────────────────────────────────────────────────────────────────
  /**
   * AUDIT-10: constant-time comparison for sha256-hashed session tokens; legacy rows
   * stored before the fix keep bcrypt("$2…" prefix) verification until they are rotated.
   */
  private async verifyStoredRefreshToken(
    incomingTokenHash: string,
    session: { refreshToken: string | null },
  ): Promise<boolean> {
    const stored = session.refreshToken;
    if (!stored) return false;
    if (stored.startsWith('$2')) {
      return bcryptCompare(incomingTokenHash, stored);
    }
    const a = Buffer.from(stored, 'utf8');
    const b = Buffer.from(incomingTokenHash, 'utf8');
    if (a.length !== b.length) return false;
    return _timingSafeEqual(a, b);
  }

  async refreshToken(refreshToken: string): Promise<{ accessToken: string; refreshToken: string }> {
    let payload: RefreshTokenPayload;
    try {
      payload = this.tokenService.verifyRefreshToken(refreshToken);
    } catch {
      throw new UnauthorizedException({
        code: ErrorCodes.UNAUTHORIZED,
        message: 'Invalid or expired refresh token',
      });
    }

    const session = await this.prisma.userSession.findUnique({
      where: { jti: payload.jti },
    });

    // SEC (round-2): JWT refresh VALID (signature lolos) tetapi jti tidak ada
    // di DB — sesi mungkin terhapus (eviiksi/cleanup) ATAU token hasil
    // kompromi. Bedakan dari revoked/expired: catat security event TANPA
    // token mentah, kirim notifikasi dugaan pencurian ke pemilik akun, dan
    // tetap tolak (fail-closed).
    if (!session) {
      this.logger.warn(
        `[SECURITY] Refresh token bersignature valid tetapi jti tidak dikenal di DB ` +
          `(userId=${payload.sub}, jti=${payload.jti}). Dugaan pencurian/penyalahgunaan token — request ditolak.`,
      );
      this.notifyUnknownRefreshSession(payload.sub).catch(err => {
        this.logger.error('[SECURITY] Failed to notify user about unknown refresh session', err);
      });
      throw new UnauthorizedException({
        code: ErrorCodes.SESSION_REVOKED,
        message: 'Session has been revoked',
      });
    }

    if (session.isRevoked || session.expiresAt < new Date()) {
      throw new UnauthorizedException({
        code: ErrorCodes.SESSION_REVOKED,
        message: 'Session has been revoked',
      });
    }
    if (session.userId !== payload.sub) {
      this.logger.error(`[SECURITY] Refresh session owner mismatch for session ${session.id}`);
      throw new UnauthorizedException({
        code: ErrorCodes.UNAUTHORIZED,
        message: 'Invalid refresh token',
      });
    }

    const incomingTokenHash = sha256(refreshToken);
    const isTokenValid = await this.verifyStoredRefreshToken(incomingTokenHash, session);
    if (!isTokenValid) {
      const reuseSessionIds = await this.prisma.$transaction(
        async tx => {
          const sessions = await tx.userSession.findMany({
            where: { userId: session.userId, isRevoked: false },
            select: { id: true },
          });
          await tx.userSession.updateMany({
            where: { userId: session.userId, isRevoked: false },
            data: { isRevoked: true, revokedAt: new Date(), revokedReason: 'token_reuse_detected' },
          });
          return sessions.map(s => s.id);
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      );
      await this.revokeSessionsInRedis(reuseSessionIds);
      this.logger.warn(
        `[SECURITY] Possible refresh token theft detected for session ${session.id}. All sessions revoked.`,
      );
      this.notifyRefreshTokenReuse(session.userId).catch(err => {
        this.logger.error('[SECURITY] Failed to notify user about refresh token reuse', err);
      });
      throw new UnauthorizedException({
        code: ErrorCodes.UNAUTHORIZED,
        message: 'Invalid refresh token. All sessions revoked for security.',
      });
    }

    const user = await this.prisma.user.findUnique({ where: { id: payload.sub } });
    if (!user || !user.isActive || user.isBanned) {
      throw new UnauthorizedException({
        code: ErrorCodes.UNAUTHORIZED,
        message: 'Invalid refresh token',
      });
    }

    const oldJti = payload.jti;

    const newRefreshToken = this.tokenService.signRefreshToken({ sub: user.id });
    const newPayload: DecodedTokenPayload | null = this.tokenService.decodeToken(newRefreshToken);
    const newJti = newPayload?.jti;

    if (!newJti) {
      throw new InternalServerErrorException({
        code: ErrorCodes.INTERNAL_SERVER_ERROR,
        message: 'Failed to extract JTI from new refresh token',
      });
    }

    // AUDIT-10: see saveSession — sha256 is the correct primitive for high-entropy
    // opaque-equivalent tokens; removes ~2x bcrypt cost from the hottest auth call.
    const hashedRefreshToken = sha256(newRefreshToken);

    const refreshTtlSeconds = this.getRefreshTokenTtlSeconds();
    await this.redis.setex(TOKEN_BLACKLIST(oldJti), refreshTtlSeconds, '1', { throwOnError: true });

    const updated = await this.prisma.userSession.updateMany({
      where: { jti: oldJti, isRevoked: false },
      data: {
        jti: newJti,
        refreshToken: hashedRefreshToken,
        lastActiveAt: new Date(),
        expiresAt: this.getRefreshTokenExpiryDate(),
      },
    });

    if (updated.count === 0) {
      // Concurrent refresh: another request rotated this jti before us. Do
      // NOT `redis.del(TOKEN_BLACKLIST(oldJti))` here — the previous code did,
      // which was a defence-in-depth regression: if the winning request also
      // raced with us setting the blacklist, our `del` could undo their
      // protection and leave the old jti silently usable. The blacklist key
      // already has TTL=refreshTtlSeconds, so leaving it in place is harmless
      // and strictly safer.
      throw new UnauthorizedException({
        code: ErrorCodes.SESSION_REVOKED,
        message: 'Session already refreshed. Please retry.',
      });
    }

    const accessToken = this.tokenService.signAccessToken({
      sub: user.id,
      userId: user.userId,
      email: user.email ?? '',
      username: user.username ?? '',
      sessionId: session.id,
      kycStatus: user.kycStatus,
      emailVerified: user.emailVerified,
    });

    return { accessToken, refreshToken: newRefreshToken };
  }

  // ─────────────────────────────────────────────────────────────────
  // LOGOUT
  // ─────────────────────────────────────────────────────────────────
  async logout(
    userId: string,
    sessionId: string,
    accessTokenJti: string,
    logoutAll: boolean,
  ): Promise<{ message: string }> {
    const jwtTtlSeconds = this.getAccessTokenTtlSeconds();
    let revokedSessionIds: string[] = [];

    if (logoutAll) {
      const logoutAllIds = await this.prisma.$transaction(
        async tx => {
          const sessions = await tx.userSession.findMany({
            where: { userId, isRevoked: false },
            select: { id: true },
          });
          await tx.userSession.updateMany({
            where: { userId, isRevoked: false },
            data: { isRevoked: true, revokedAt: new Date(), revokedReason: 'logout_all' },
          });
          return sessions.map(s => s.id);
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      );
      revokedSessionIds = logoutAllIds;
    } else {
      if (sessionId) {
        await this.prisma.userSession.updateMany({
          where: { id: sessionId, userId, isRevoked: false },
          data: { isRevoked: true, revokedAt: new Date(), revokedReason: 'logout' },
        });
        revokedSessionIds = [sessionId];
      }
    }

    // Session revocation in PostgreSQL is the durable security boundary. Redis
    // shortens propagation latency, but an outage must never prevent logout
    // from completing or leave a server-side session active.
    const redisRevocations: Promise<unknown>[] = [];
    if (accessTokenJti) {
      redisRevocations.push(
        this.redis.setex(TOKEN_BLACKLIST(accessTokenJti), jwtTtlSeconds, '1', {
          throwOnError: true,
        }),
      );
    }
    if (revokedSessionIds.length)
      redisRevocations.push(this.revokeSessionsInRedis(revokedSessionIds));
    if (redisRevocations.length) {
      await Promise.all(redisRevocations).catch((err: unknown) => {
        this.logger.warn(
          `[SECURITY] Logout completed with Redis revocation propagation unavailable: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
    }

    return { message: 'Logout successful' };
  }

  // ─────────────────────────────────────────────────────────────────
  // VERIFY PASSWORD (for app lock / forgot-PIN flow)
  // ─────────────────────────────────────────────────────────────────
  async verifyPassword(userId: string, password: string): Promise<{ verified: boolean }> {
    const VERIFY_PW_KEY = `verify_pw_rate:${userId}`;
    const attempts = await this.redis.incrWithTtl(VERIFY_PW_KEY, 900);
    if (attempts > 10) {
      throw new HttpException(
        {
          code: ErrorCodes.TOO_MANY_REQUESTS,
          message: 'Too many password verification attempts. Please wait before trying again.',
        },
        429,
      );
    }

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { password: true },
    });
    if (!user) {
      throw new NotFoundException({ code: ErrorCodes.USER_NOT_FOUND, message: 'User not found' });
    }
    if (!user.password) {
      throw new BadRequestException({
        code: ErrorCodes.CURRENT_PASSWORD_WRONG,
        message: 'Password login is not configured for this account',
      });
    }
    const isValid = await bcryptCompare(password, user.password);
    if (!isValid) {
      throw new BadRequestException({
        code: ErrorCodes.CURRENT_PASSWORD_WRONG,
        message: 'Password is incorrect',
      });
    }
    await this.redis.del(VERIFY_PW_KEY);
    return { verified: true };
  }

  // ─────────────────────────────────────────────────────────────────
  // CHANGE PASSWORD
  // ─────────────────────────────────────────────────────────────────
  async changePassword(
    userId: string,
    dto: ChangePasswordDto,
    currentAccessTokenJti?: string,
    _currentSessionId?: string,
    ipAddress?: string,
  ): Promise<{ message: string }> {
    if (dto.newPassword !== dto.confirmPassword) {
      throw new BadRequestException({
        code: ErrorCodes.PASSWORDS_DO_NOT_MATCH,
        message: 'New password and confirmation do not match',
      });
    }

    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      throw new NotFoundException({ code: ErrorCodes.USER_NOT_FOUND, message: 'User not found' });
    }

    if (!user.password) {
      throw new BadRequestException({
        code: ErrorCodes.CURRENT_PASSWORD_WRONG,
        message: 'Password login is not configured for this account',
      });
    }
    const isValidPw = await bcryptCompare(dto.currentPassword, user.password);
    if (!isValidPw) {
      throw new BadRequestException({
        code: ErrorCodes.CURRENT_PASSWORD_WRONG,
        message: 'Current password is incorrect',
      });
    }
    validatePasswordPolicy(dto.newPassword);

    const isSamePassword = await bcryptCompare(dto.newPassword, user.password);
    if (isSamePassword) {
      throw new BadRequestException({
        code: ErrorCodes.PASSWORD_SAME_AS_OLD,
        message: 'New password cannot be the same as old password',
      });
    }

    const recentPasswords = await this.prisma.passwordHistory.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: 5,
    });
    // B1-003 (perf): compare history diparalel (bcrypt async, aman) — semantik
    // identik: tolak bila SALAH SATU cocok. Rounds & perilaku tidak berubah.
    const reuseChecks = await Promise.all(
      recentPasswords.map((historical) => bcryptCompare(dto.newPassword, historical.passwordHash)),
    );
    if (reuseChecks.some(Boolean)) {
      throw new BadRequestException({
        code: ErrorCodes.PASSWORD_RECENTLY_USED,
        message: 'New password cannot be the same as one of your last 5 passwords',
      });
    }

    // Password changes can otherwise turn a stolen password into persistent account
    // takeover. Require the configured second factor only after all password policy
    // checks have passed, so rejected inputs never consume a valid recovery factor.
    await this.verifySensitiveMfa(userId, dto.mfaCode);

    const hashedPassword = await bcryptHash(dto.newPassword, getBcryptRounds());
    const allSessionIds = await this.prisma.$transaction(
      async (tx: Prisma.TransactionClient) => {
        await tx.user.update({
          where: { id: userId },
          data: { password: hashedPassword, passwordChangedAt: new Date() },
        });
        await tx.passwordHistory.create({
          data: { userId, passwordHash: user.password! },
        });

        const oldEntries = await tx.passwordHistory.findMany({
          where: { userId },
          orderBy: { createdAt: 'desc' },
          skip: 5,
          select: { id: true },
        });
        if (oldEntries.length > 0) {
          await tx.passwordHistory.deleteMany({
            where: { id: { in: oldEntries.map(e => e.id) } },
          });
        }
        const where: Prisma.UserSessionWhereInput = { userId, isRevoked: false };
        const sessions = await tx.userSession.findMany({
          where,
          select: { id: true },
        });
        await tx.userSession.updateMany({
          where,
          data: { isRevoked: true, revokedAt: new Date(), revokedReason: 'password_change' },
        });
        await tx.userDevice.updateMany({
          where: { userId, isTrusted: true },
          data: { isTrusted: false, trustedAt: null },
        });
        return sessions.map(session => session.id);
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );

    const jwtTtlSeconds = this.getAccessTokenTtlSeconds();
    const redisRevocations: Promise<unknown>[] = [this.revokeSessionsInRedis(allSessionIds)];
    if (currentAccessTokenJti) {
      redisRevocations.push(
        this.redis.setex(TOKEN_BLACKLIST(currentAccessTokenJti), jwtTtlSeconds, '1', {
          throwOnError: true,
        }),
      );
    }
    await Promise.all(redisRevocations).catch((err: unknown) => {
      this.logger.warn(
        `[SECURITY] Password change persisted but Redis session propagation is unavailable: ${err instanceof Error ? err.message : String(err)}`,
      );
    });

    this.auditLog.logUserAction({
      userId,
      action: UserAuditAction.PASSWORD_CHANGED,
      entityType: 'User',
      entityId: userId,
      description: 'Password changed by user',
    });

    await this.locationService.logEvent({
      userId,
      event: 'password_change',
      location: dto.location ?? null,
      ipAddress: ipAddress ?? undefined,
      deviceId: undefined,
    });

    this.createSecurityNotification(
      userId,
      'Password Changed',
      'Your password was changed and every active session was signed out. If this was not you, reset your password immediately.',
      NotificationType.SECURITY_PASSWORD_CHANGED,
    ).catch(() => undefined);
    if (user.email) {
      this.dispatchEmail({
        to: user.email,
        subject: 'Security Alert: Password Changed',
        templateName: 'password-changed-notification',
        templateContext: {},
      }).catch(() => undefined);
    }

    return { message: 'Password changed. Please sign in again on your devices.' };
  }

  // ─────────────────────────────────────────────────────────────────
  async get2faStatus(userId: string): Promise<{ enabled: boolean }> {
    const twoFa = await this.prisma.twoFactorAuth.findUnique({ where: { userId } });
    return { enabled: twoFa?.isEnabled ?? false };
  }

  // SETUP 2FA
  // ─────────────────────────────────────────────────────────────────
  async setup2fa(
    userId: string,
    password: string,
  ): Promise<{ secret: string; qrCodeUrl: string; otpauthUrl: string; backupCodes: string[] }> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      throw new NotFoundException({ code: ErrorCodes.USER_NOT_FOUND, message: 'User not found' });
    }

    if (!user.phoneVerified) {
      throw new BadRequestException({
        code: ErrorCodes.PHONE_NOT_VERIFIED,
        message: 'Phone number must be verified before enabling 2FA',
      });
    }

    if (!user.password) {
      throw new BadRequestException({
        code: ErrorCodes.PASSWORD_WRONG,
        message: 'Password login is not configured for this account',
      });
    }
    const isValid = await bcryptCompare(password, user.password);
    if (!isValid) {
      throw new BadRequestException({
        code: ErrorCodes.PASSWORD_WRONG,
        message: 'Password is incorrect',
      });
    }

    const existing2fa = await this.prisma.twoFactorAuth.findUnique({ where: { userId } });
    if (existing2fa?.isEnabled) {
      throw new BadRequestException({
        code: ErrorCodes.TWO_FA_ALREADY_ENABLED,
        message: '2FA is already enabled',
      });
    }

    const secret = speakeasy.generateSecret({ name: `Kahade:${user.email}` });
    const encryptedSecret = await encryptAES(secret.base32);
    const plainBackupCodes = generateBackupCodes(10, 16);
    const hashedBackupCodes = await Promise.all(plainBackupCodes.map(c => hashOtp(c)));

    await this.prisma.twoFactorAuth.upsert({
      where: { userId },
      create: {
        userId,
        secret: encryptedSecret,
        backupCodes: hashedBackupCodes,
      },
      update: {
        secret: encryptedSecret,
        backupCodes: hashedBackupCodes,
        isEnabled: false,
        usedBackupCodes: [],
      },
    });

    const qrCodeUrl = await QRCode.toDataURL(secret.otpauth_url ?? '');

    return {
      secret: secret.base32,
      qrCodeUrl,
      otpauthUrl: secret.otpauth_url ?? '',
      backupCodes: plainBackupCodes,
    };
  }

  // ─────────────────────────────────────────────────────────────────
  // ENABLE 2FA
  // ─────────────────────────────────────────────────────────────────
  async enable2fa(userId: string, code: string): Promise<{ message: string }> {
    const twoFactorAuth = await this.prisma.twoFactorAuth.findUnique({ where: { userId } });

    if (!twoFactorAuth) {
      throw new BadRequestException({
        code: ErrorCodes.TWO_FA_NOT_ENABLED,
        message: '2FA not set up',
      });
    }
    if (twoFactorAuth.isEnabled) {
      throw new BadRequestException({
        code: ErrorCodes.TWO_FA_ALREADY_ENABLED,
        message: '2FA is already enabled',
      });
    }
    if (!twoFactorAuth.secret) {
      throw new BadRequestException({
        code: ErrorCodes.TWO_FA_NOT_ENABLED,
        message: '2FA not properly set up, please re-run setup',
      });
    }

    const decryptedSecret = await decryptAES(twoFactorAuth.secret);
    const verified = speakeasy.totp.verify({
      secret: decryptedSecret,
      encoding: 'base32',
      token: code,
      window: 1,
    });

    if (!verified) {
      throw new BadRequestException({
        code: ErrorCodes.INVALID_2FA_CODE,
        message: 'Invalid TOTP code',
      });
    }

    const hmacSecret =
      this.configService.get<string>('crypto.hmacSecretKey') ||
      this.configService.get<string>('jwt.secret') ||
      '';
    const codeHash = sha256(hmacSecret + ':totp:' + code);
    const totpUsedKey = TOTP_USED_CODE(userId);
    const client = this.redis.getClient();
    const redisKey = `${this.redis.getPrefix()}${totpUsedKey}`;
    const wasAdded = await client.sadd(redisKey, codeHash);
    if (wasAdded === 0) {
      throw new BadRequestException({
        code: ErrorCodes.INVALID_2FA_CODE,
        message: 'TOTP code already used. Wait for the next code.',
      });
    }
    await client.expire(redisKey, 90);

    const enable2faSessionIds = await this.prisma.$transaction(
      async tx => {
        await tx.twoFactorAuth.update({
          where: { userId },
          data: { isEnabled: true, enabledAt: new Date() },
        });
        const sessions = await tx.userSession.findMany({
          where: { userId, isRevoked: false },
          select: { id: true },
        });
        await tx.userSession.updateMany({
          where: { userId, isRevoked: false },
          data: { isRevoked: true, revokedAt: new Date(), revokedReason: 'two_fa_enabled' },
        });
        await tx.userDevice.updateMany({
          where: { userId, isTrusted: true },
          data: { isTrusted: false, trustedAt: null },
        });
        return sessions.map(session => session.id);
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
    await this.revokeSessionsInRedis(enable2faSessionIds).catch((err: unknown) => {
      this.logger.warn(
        `[SECURITY] 2FA enable persisted but Redis session propagation is unavailable: ${err instanceof Error ? err.message : String(err)}`,
      );
    });

    this.auditLog.logUserAction({
      userId,
      action: UserAuditAction.TWO_FA_ENABLED,
      entityType: 'TwoFactorAuth',
      entityId: userId,
      description: '2FA enabled by user',
    });

    this.createSecurityNotification(
      userId,
      'Two-Factor Authentication Enabled',
      'Two-factor authentication was enabled and all active sessions were signed out.',
      NotificationType.SECURITY_2FA_ENABLED,
    ).catch(() => undefined);
    const securityUser = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { email: true },
    });
    if (securityUser?.email) {
      this.dispatchEmail({
        to: securityUser.email,
        subject: 'Security Alert: 2FA Enabled',
        templateName: 'two-fa-enabled-notification',
        templateContext: {},
      }).catch(() => undefined);
    }

    return {
      message: '2FA enabled successfully. All sessions have been revoked. Please log in again.',
    };
  }

  // ─────────────────────────────────────────────────────────────────
  // DISABLE 2FA
  // ─────────────────────────────────────────────────────────────────
  async disable2fa(
    userId: string,
    password: string,
    code: string,
    emailOtpCode: string,
  ): Promise<{ message: string }> {
    const disable2faRateKey = `disable_2fa_rate:${userId}`;
    const disable2faAttempts = await this.redis.incrWithTtl(disable2faRateKey, 900);
    if (disable2faAttempts > 5) {
      throw new HttpException(
        {
          code: ErrorCodes.TOO_MANY_REQUESTS,
          message: 'Too many attempts. Please wait before trying again.',
        },
        429,
      );
    }

    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      throw new NotFoundException({ code: ErrorCodes.USER_NOT_FOUND, message: 'User not found' });
    }
    if (!user.isActive) {
      throw new ForbiddenException({
        code: ErrorCodes.ACCOUNT_INACTIVE,
        message: 'Account is inactive',
      });
    }
    if (user.isBanned) {
      throw new ForbiddenException({
        code: ErrorCodes.ACCOUNT_BANNED,
        message: 'Account has been banned',
      });
    }

    if (!user.password) {
      throw new BadRequestException({
        code: ErrorCodes.CURRENT_PASSWORD_WRONG,
        message: 'Password login is not configured for this account',
      });
    }
    const isPasswordValid = user.password ? await bcryptCompare(password, user.password) : false;
    if (!isPasswordValid) {
      throw new BadRequestException({
        code: ErrorCodes.CURRENT_PASSWORD_WRONG,
        message: 'Password is incorrect',
      });
    }

    const twoFactorAuth = await this.prisma.twoFactorAuth.findUnique({ where: { userId } });

    if (!twoFactorAuth?.isEnabled) {
      throw new BadRequestException({
        code: ErrorCodes.TWO_FA_NOT_ENABLED,
        message: '2FA is not enabled',
      });
    }
    if (!twoFactorAuth.secret) {
      throw new BadRequestException({
        code: ErrorCodes.TWO_FA_NOT_ENABLED,
        message: '2FA secret is missing, please re-setup 2FA',
      });
    }

    // Same nullable-email cross-account risk described in requestDisable2faOtp
    // (above). A phone-only account has no email; reject the second factor early
    // rather than checking against the shared '' OTP bucket.
    if (!user.email) {
      throw new BadRequestException({
        code: 'EMAIL_NOT_CONFIGURED',
        message:
          'Your account has no email address to verify OTP against. Please add an email or contact support.',
      });
    }

    const isOtpValid = await this.otpService.verifyOtp(
      user.email,
      OtpType.TWO_FA_DISABLE,
      emailOtpCode,
    );
    if (!isOtpValid) {
      throw new BadRequestException({ code: ErrorCodes.OTP_INVALID, message: 'Invalid email OTP' });
    }

    const normalizedCode = code.trim().toUpperCase();
    if (this.BACKUP_CODE_PATTERN.test(normalizedCode)) {
      // Recovery codes are a valid replacement for the authenticator, but are
      // consumed only after the separate email factor has been verified.
      const backupCodeValid = await this.checkAndConsumeBackupCode(twoFactorAuth, normalizedCode);
      if (!backupCodeValid) {
        throw new BadRequestException({
          code: ErrorCodes.INVALID_2FA_CODE,
          message: 'Invalid or already used backup code',
        });
      }
    } else {
      if (!/^\d{6}$/.test(code)) {
        throw new BadRequestException({
          code: ErrorCodes.INVALID_2FA_CODE,
          message: 'Authenticator code must contain exactly six digits',
        });
      }
      const decryptedSecret = await decryptAES(twoFactorAuth.secret);
      const verified = speakeasy.totp.verify({
        secret: decryptedSecret,
        encoding: 'base32',
        token: code,
        window: 1,
      });
      if (!verified) {
        throw new BadRequestException({
          code: ErrorCodes.INVALID_2FA_CODE,
          message: 'Invalid 2FA code',
        });
      }

      const hmacSecret =
        this.configService.get<string>('crypto.hmacSecretKey') ||
        this.configService.get<string>('jwt.secret') ||
        '';
      const codeHash = sha256(hmacSecret + ':totp:' + code);
      const totpUsedKey = TOTP_USED_CODE(userId);
      const client = this.redis.getClient();
      const redisKey = `${this.redis.getPrefix()}${totpUsedKey}`;
      const wasAdded = await client.sadd(redisKey, codeHash);
      if (wasAdded === 0) {
        throw new BadRequestException({
          code: ErrorCodes.INVALID_2FA_CODE,
          message: 'TOTP code already used. Wait for the next code.',
        });
      }
      await client.expire(redisKey, 90);
    }

    const disable2faSessionIds = await this.prisma.$transaction(
      async tx => {
        await tx.twoFactorAuth.update({
          where: { userId },
          data: {
            isEnabled: false,
            disabledAt: new Date(),
            secret: null,
            backupCodes: [],
            usedBackupCodes: [],
          },
        });
        const sessions = await tx.userSession.findMany({
          where: { userId, isRevoked: false },
          select: { id: true },
        });
        await tx.userSession.updateMany({
          where: { userId, isRevoked: false },
          data: { isRevoked: true, revokedAt: new Date(), revokedReason: 'two_fa_disabled' },
        });
        await tx.userDevice.updateMany({
          where: { userId, isTrusted: true },
          data: { isTrusted: false, trustedAt: null },
        });
        return sessions.map(s => s.id);
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
    await this.revokeSessionsInRedis(disable2faSessionIds).catch((err: unknown) => {
      this.logger.warn(
        `[SECURITY] 2FA disable persisted but Redis session propagation is unavailable: ${err instanceof Error ? err.message : String(err)}`,
      );
    });

    this.auditLog.logUserAction({
      userId,
      action: UserAuditAction.TWO_FA_DISABLED,
      entityType: 'TwoFactorAuth',
      entityId: userId,
      description: '2FA disabled by user',
    });

    this.createSecurityNotification(
      userId,
      'Two-Factor Authentication Disabled',
      'Two-factor authentication was disabled and all active sessions were signed out. If this was not you, change your password immediately.',
      NotificationType.SECURITY_2FA_DISABLED,
    ).catch(() => undefined);
    if (user.email) {
      this.dispatchEmail({
        to: user.email,
        subject: 'Security Alert: 2FA Disabled',
        templateName: 'two-fa-disabled-notification',
        templateContext: {},
      }).catch(() => undefined);
    }

    return {
      message: '2FA disabled successfully. All sessions have been revoked. Please log in again.',
    };
  }

  // ─────────────────────────────────────────────────────────────────
  // REGENERATE BACKUP CODES
  // ─────────────────────────────────────────────────────────────────
  async regenerateBackupCodes(
    userId: string,
    password: string,
    code: string,
  ): Promise<{ backupCodes: string[] }> {
    const regenRateKey = `regen_backup_rate:${userId}`;
    const regenAttempts = await this.redis.incrWithTtl(regenRateKey, 900);
    if (regenAttempts > 5) {
      throw new HttpException(
        {
          code: ErrorCodes.TOO_MANY_REQUESTS,
          message: 'Too many attempts. Please wait before trying again.',
        },
        429,
      );
    }

    const regenerationLockKey = `regen_backup_lock:${userId}`;
    const regenerationLockToken = _cryptoRandomBytes(16).toString('hex');
    const acquired = await this.redis.setNx(regenerationLockKey, regenerationLockToken, 30);
    if (!acquired) {
      throw new ConflictException({
        code: ErrorCodes.OPTIMISTIC_LOCK_CONFLICT,
        message: 'Backup code regeneration is already in progress. Please try again.',
      });
    }

    try {
      const user = await this.prisma.user.findUnique({ where: { id: userId } });
      if (!user) {
        throw new NotFoundException({ code: ErrorCodes.USER_NOT_FOUND, message: 'User not found' });
      }
      if (!user.isActive) {
        throw new ForbiddenException({
          code: ErrorCodes.ACCOUNT_INACTIVE,
          message: 'Account is inactive',
        });
      }
      if (user.isBanned) {
        throw new ForbiddenException({
          code: ErrorCodes.ACCOUNT_BANNED,
          message: 'Account has been banned',
        });
      }
      if (!user.password) {
        throw new BadRequestException({
          code: ErrorCodes.PASSWORD_WRONG,
          message: 'Password login is not configured for this account',
        });
      }
      const isValid = await bcryptCompare(password, user.password);
      if (!isValid) {
        throw new BadRequestException({
          code: ErrorCodes.PASSWORD_WRONG,
          message: 'Password is incorrect',
        });
      }

      const twoFactorAuth = await this.prisma.twoFactorAuth.findUnique({ where: { userId } });
      if (!twoFactorAuth?.isEnabled || !twoFactorAuth.secret) {
        throw new BadRequestException({
          code: ErrorCodes.TWO_FA_NOT_ENABLED,
          message: '2FA is not enabled or requires setup again',
        });
      }
      if (!/^\d{6}$/.test(code)) {
        throw new BadRequestException({
          code: ErrorCodes.INVALID_2FA_CODE,
          message: 'Authenticator code must contain exactly six digits',
        });
      }

      const decryptedSecret = await decryptAES(twoFactorAuth.secret);
      const verified = speakeasy.totp.verify({
        secret: decryptedSecret,
        encoding: 'base32',
        token: code,
        window: 1,
      });
      if (!verified) {
        throw new BadRequestException({
          code: ErrorCodes.INVALID_2FA_CODE,
          message: 'Invalid 2FA code',
        });
      }

      const hmacSecret =
        this.configService.get<string>('crypto.hmacSecretKey') ||
        this.configService.get<string>('jwt.secret') ||
        '';
      const codeHash = sha256(hmacSecret + ':totp:' + code);
      const totpUsedKey = TOTP_USED_CODE(userId);
      const client = this.redis.getClient();
      const redisKey = `${this.redis.getPrefix()}${totpUsedKey}`;
      const wasAdded = await client.sadd(redisKey, codeHash);
      if (wasAdded === 0) {
        throw new BadRequestException({
          code: ErrorCodes.INVALID_2FA_CODE,
          message: 'TOTP code already used. Wait for the next code.',
        });
      }
      await client.expire(redisKey, 90);

      const plainBackupCodes = generateBackupCodes(10, 16);
      const hashedBackupCodes = await Promise.all(plainBackupCodes.map(c => hashOtp(c)));
      await this.prisma.twoFactorAuth.update({
        where: { userId },
        data: { backupCodes: hashedBackupCodes, usedBackupCodes: [] },
      });

      this.createSecurityNotification(
        userId,
        'Backup Codes Regenerated',
        'Your 2FA backup codes were regenerated. Previous backup codes no longer work.',
      ).catch(() => undefined);
      if (user.email) {
        this.dispatchEmail({
          to: user.email,
          subject: 'Security Alert: Backup Codes Regenerated',
          templateName: 'backup-codes-regenerated-notification',
          templateContext: {},
        }).catch(() => undefined);
      }
      return { backupCodes: plainBackupCodes };
    } finally {
      await this.redis.releaseLock(regenerationLockKey, regenerationLockToken);
    }
  }

  // ─────────────────────────────────────────────────────────────────
  // REQUEST 2FA DISABLE OTP
  // ─────────────────────────────────────────────────────────────────
  async requestDisable2faOtp(userId: string, ipAddress?: string): Promise<{ message: string }> {
    const rateLimitKey = `disable_2fa_otp_rate:${userId}`;
    const requestCount = await this.redis.incrWithTtl(rateLimitKey, 300);
    if (requestCount > 3) {
      throw new BadRequestException({
        code: 'RATE_LIMIT_EXCEEDED',
        message: 'Too many OTP requests. Please wait 5 minutes before trying again.',
      });
    }

    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      throw new NotFoundException({ code: ErrorCodes.USER_NOT_FOUND, message: 'User not found' });
    }

    const twoFactorAuth = await this.prisma.twoFactorAuth.findUnique({ where: { userId } });
    if (!twoFactorAuth?.isEnabled) {
      throw new BadRequestException({
        code: ErrorCodes.TWO_FA_NOT_ENABLED,
        message: '2FA is not enabled',
      });
    }

    // `user.email` is nullable — phone-only registration (phoneRegister) never sets it.
    // The old `user.email ?? ''` fallback made every emailless account share one OTP
    // identity: generateOtp keyed its cooldown, per-identifier rate limit and
    // MAX_ACTIVE_OTPS count on the literal '', so three pending requests anywhere
    // blocked all of them, and verifyOtp('') in disable2fa below matched the newest
    // ''-row regardless of which user it belonged to — one user's code could satisfy
    // another's email second factor. The mail also went to '' so nobody ever received
    // it, making this a silent dead end. Fail explicitly instead. Delivering this OTP
    // over SMS/WhatsApp is a product decision, not a bug fix.
    if (!user.email) {
      throw new BadRequestException({
        code: 'EMAIL_NOT_CONFIGURED',
        message:
          'Your account has no email address. Please add and verify an email before disabling 2FA, or contact support.',
      });
    }

    await this.otpService.invalidateOtps(user.email, OtpType.TWO_FA_DISABLE);
    const otp = await this.otpService.generateOtp(
      user.email,
      OtpType.TWO_FA_DISABLE,
      userId,
      undefined,
      ipAddress,
    );

    // Await so the user does not receive a misleading "code sent" response if
    // the queue enqueue fails (the OTP is the entire purpose of this call).
    await this.dispatchEmail({
      to: user.email,
      subject: 'Kahade - Disable 2FA Verification Code',
      templateName: '2fa-disable',
      templateContext: { otp },
    });

    return { message: 'A verification code has been sent to your registered email address.' };
  }

  // ─────────────────────────────────────────────────────────────────
  // PRIVATE HELPERS
  // ─────────────────────────────────────────────────────────────────

  private async sendVerificationEmail(
    userId: string,
    email: string,
    ipAddress?: string,
  ): Promise<void> {
    await this.otpService.invalidateOtps(email, OtpType.EMAIL_VERIFICATION);
    const otp = await this.otpService.generateOtp(
      email,
      OtpType.EMAIL_VERIFICATION,
      userId,
      undefined,
      ipAddress,
    );
    await this.dispatchEmail({
      to: email,
      subject: 'Kahade - Verify Your Email',
      templateName: 'verify-email',
      templateContext: { otp },
    });
  }

  private getWalletPinPepper(): string {
    const pepper =
      this.configService.get<string>('app.walletPinPepper') ??
      this.configService.get<string>('WALLET_PIN_PEPPER');
    if (!pepper) {
      throw new InternalServerErrorException({
        code: ErrorCodes.INTERNAL_SERVER_ERROR,
        message: 'Wallet PIN pepper is not configured',
      });
    }
    return pepper;
  }

  private validatePinPolicy(pin: string): void {
    if (pin.length !== 6 || !/^\d{6}$/.test(pin)) {
      throw new BadRequestException({
        code: ErrorCodes.VALIDATION_ERROR,
        message: 'PIN must be exactly 6 digits',
      });
    }
    if (/^(\d)\1{5}$/.test(pin)) {
      throw new BadRequestException({
        code: ErrorCodes.VALIDATION_ERROR,
        message: 'PIN must not be all repeated digits',
      });
    }
    const WEAK_SEQUENCES = [
      '012345',
      '123456',
      '234567',
      '345678',
      '456789',
      '567890',
      '098765',
      '987654',
      '876543',
      '765432',
      '654321',
      '543210',
    ];
    if (WEAK_SEQUENCES.includes(pin)) {
      throw new BadRequestException({
        code: ErrorCodes.VALIDATION_ERROR,
        message: 'PIN must not be a sequential number',
      });
    }
    if (/^(\d)(\d)\1\2\1\2$/.test(pin)) {
      const [a, b] = pin;
      if (a !== b) {
        throw new BadRequestException({
          code: ErrorCodes.VALIDATION_ERROR,
          message: 'PIN must not be a repeating two-digit pattern',
        });
      }
    }
    if (/^(\d)\1(\d)\2(\d)\3$/.test(pin)) {
      throw new BadRequestException({
        code: ErrorCodes.VALIDATION_ERROR,
        message: 'PIN must not consist of paired digits',
      });
    }
  }

  private async sendPasswordResetEmail(email: string, otp: string): Promise<void> {
    await this.dispatchEmail({
      to: email,
      subject: 'Kahade - Password Reset Code',
      templateName: 'password-reset',
      templateContext: { otp },
    });
  }

  private async dispatchEmail(options: {
    to: string;
    subject: string;
    text?: string;
    html?: string;
    templateName?: string;
    templateContext?: Record<string, unknown>;
  }): Promise<void> {
    try {
      await this.emailQueue.add(
        'send',
        {
          to: options.to,
          subject: options.subject,
          ...(options.html ? { html: options.html } : {}),
          ...(options.text ? { text: options.text } : {}),
          ...(options.templateName ? { templateName: options.templateName } : {}),
          ...(options.templateContext ? { templateContext: options.templateContext } : {}),
        },
        {
          attempts: 3,
          backoff: { type: 'exponential', delay: 5000 },
          removeOnComplete: 100,
          removeOnFail: 50,
        },
      );
    } catch (err) {
      this.logger.error(
        `[EMAIL QUEUE] Failed to enqueue email notification: ${(err as Error).message}`,
      );
      throw err;
    }
  }

  private readonly BACKUP_CODE_PATTERN = /^[A-Z0-9]{10,16}$/;

  /**
   * Verifies and atomically consumes a backup code.
   *
   * Single-use is guaranteed by Layer 2 (authoritative DB). Layer 1 is an optional fast-path
   * optimisation that avoids bcrypt work on codes already known to be consumed.
   *
   * Layer 1 — Redis best-effort read cache (fast path optimisation):
   *   Before the expensive bcrypt verify, GET a Redis key derived from sha256(storedCodeHash).
   *   If present, skip this code without DB work. After a successful DB claim, stamp this key
   *   with SET NX EX (7 days) so future attempts hit this fast path. The stamp is non-blocking:
   *   if Redis is unavailable the stamp is skipped with a warn log; the login still succeeds
   *   and the DB layer remains authoritative.
   *
   * Layer 2 — Prisma updateMany with NOT condition (authoritative, atomic):
   *   Gated on `NOT { usedBackupCodes: { has: codeHash } }`. Concurrent requests that both
   *   pass Layer 1 race here: only one gets count=1; the other gets count=0 and returns false.
   *   This is the sole correctness guarantee — Layer 1 is purely a performance optimisation.
   */
  private async checkAndConsumeBackupCode(
    twoFactorAuth: { id: string; backupCodes: string[]; usedBackupCodes: string[] },
    code: string,
  ): Promise<boolean> {
    if (!code || !this.BACKUP_CODE_PATTERN.test(code.toUpperCase())) {
      return false;
    }

    const backupRateKey = `backup_code_rate:${twoFactorAuth.id}`;
    const backupAttempts = await this.redis.incrWithTtl(backupRateKey, 15 * 60);
    if (backupAttempts > 5) {
      throw new HttpException(
        {
          code: ErrorCodes.TOO_MANY_REQUESTS,
          message: 'Too many backup code attempts. Please wait before trying again.',
        },
        429,
      );
    }

    const normalizedCode = code.toUpperCase();

    const backupCodes: string[] = twoFactorAuth.backupCodes || [];
    const usedBackupCodes: string[] = twoFactorAuth.usedBackupCodes || [];

    const BACKUP_CODE_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 days

    for (let i = 0; i < backupCodes.length; i++) {
      const isUsed = usedBackupCodes.includes(backupCodes[i]);
      if (isUsed) continue;

      // Layer 1 (fast path read): check Redis before the expensive bcrypt hash comparison.
      // sha256 of the stored bcrypt hash is used as the Redis key discriminator so that
      // the raw stored hash is never persisted to Redis in any form.
      const redisKey = BACKUP_CODE_USED(twoFactorAuth.id, sha256(backupCodes[i]));
      const alreadyConsumedInRedis = await this.redis.get(redisKey);
      if (alreadyConsumedInRedis) continue;

      const isMatch = await verifyOtp(normalizedCode, backupCodes[i]);
      if (isMatch) {
        // Layer 2 (authoritative): atomically claim the code in the DB — succeeds only
        // if the code hash is still in backupCodes AND not yet in usedBackupCodes.
        const claimed = await this.prisma.twoFactorAuth.updateMany({
          where: {
            id: twoFactorAuth.id,
            backupCodes: { has: backupCodes[i] },
            NOT: { usedBackupCodes: { has: backupCodes[i] } },
          },
          data: { usedBackupCodes: { push: backupCodes[i] } },
        });
        if (claimed.count === 0) {
          // Race condition: another concurrent session already consumed this code at the DB level.
          return false;
        }
        // Stamp the Redis key with SET NX EX so future attempts are rejected at the fast path.
        // This is intentionally best-effort: if Redis is unavailable, we log and continue.
        // The DB claim above is the authoritative single-use record — a missing Redis stamp
        // only means a future attempt must go through bcrypt+DB instead of being fast-path
        // rejected. It does NOT affect whether the current login succeeds.
        try {
          await this.redis.setNx(redisKey, '1', BACKUP_CODE_TTL_SECONDS);
        } catch (err) {
          this.logger.warn(
            `Failed to stamp consumed backup code in Redis (best-effort cache): ${err instanceof Error ? err.message : err}`,
          );
        }
        return true;
      }
    }
    return false;
  }

  private async trackDevice(
    userId: string,
    deviceId: string,
    deviceInfo: string | undefined,
    ipAddress: string,
  ): Promise<void> {
    const existingDevice = await this.prisma.userDevice.findUnique({
      where: { userId_deviceId: { userId, deviceId } },
    });

    if (existingDevice) {
      await this.prisma.userDevice.update({
        where: { id: existingDevice.id },
        data: { lastLoginAt: new Date(), loginCount: { increment: 1 }, ipAddress },
      });
    } else {
      await this.prisma.userDevice.create({
        data: { userId, deviceId, deviceName: deviceInfo ?? 'Unknown Device', ipAddress },
      });
      // Full async notification via queue is the production path; the inline
      // implementation below covers the case when the queue module is not yet live.
      await this.notifyNewDeviceLogin(userId, deviceInfo ?? 'Unknown Device', ipAddress).catch(
        err => {
          this.logger.error(
            '[NEW_DEVICE_NOTIFY] Failed to send new device login notification',
            err,
          );
        },
      );
    }
  }

  // Backup code use is a security event — user should be prompted to re-enable 2FA
  // and regenerate remaining codes.
  private async notifyBackupCodeUsed(userId: string): Promise<void> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { email: true },
    });

    const backupTitle = 'Backup Code Used for Login';
    const backupBody =
      'A backup code was used to log in to your account. If this was you, please re-enable 2FA and regenerate your backup codes. If this was not you, change your password immediately.';
    await this.prisma.notification.create({
      data: {
        notifId: generateNotifId(),
        userId,
        type: NotificationType.SECURITY_BACKUP_CODE_USED,
        category: getCategoryForType(NotificationType.SECURITY_BACKUP_CODE_USED),
        title: backupTitle,
        body: backupBody,
      },
    });
    this.prisma.emitNotificationCreated({
      userId,
      title: backupTitle,
      body: backupBody,
      data: { type: 'SECURITY_BACKUP_CODE' },
    });

    if (user?.email) {
      await this.dispatchEmail({
        to: user.email,
        subject: 'Security Alert: Backup Code Used',
        templateName: 'backup-code-used',
        templateContext: {},
      });
    }
  }

  private async createSecurityNotification(
    userId: string,
    title: string,
    body: string,
    type: NotificationType = NotificationType.SECURITY_NEW_LOGIN,
  ): Promise<void> {
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
    this.prisma.emitNotificationCreated({ userId, title, body, data: { type: 'SECURITY_ALERT', notificationType: type } });
  }

  private async notifyAccountLocked(
    userId: string,
    email: string,
    ipAddress: string,
  ): Promise<void> {
    const maskedIp = ipAddress.includes(':')
      ? ipAddress.replace(/:[\da-fA-F]+:[\da-fA-F]+:[\da-fA-F]+$/, ':***:***:***')
      : ipAddress.replace(/\.\d+\.\d+$/, '.***.***');
    const lockTitle = 'Account Locked — Too Many Failed Attempts';
    const lockBody = `Your account has been temporarily locked due to too many failed login attempts from IP ${maskedIp}. If this was not you, change your password immediately after the lockout expires.`;
    await this.prisma.notification.create({
      data: {
        notifId: generateNotifId(),
        userId,
        type: NotificationType.SECURITY_ACCOUNT_LOCKED,
        category: getCategoryForType(NotificationType.SECURITY_ACCOUNT_LOCKED),
        title: lockTitle,
        body: lockBody,
      },
    });
    this.prisma.emitNotificationCreated({
      userId,
      title: lockTitle,
      body: lockBody,
      data: { type: 'SECURITY_ACCOUNT_LOCKED' },
    });

    await this.dispatchEmail({
      to: email,
      subject: 'Kahade — Your Account Has Been Locked',
      templateName: 'account-locked',
      templateContext: { ipAddress },
    }).catch(err => {
      this.logger.error(
        `[AUTH] Failed to queue account lockout email for user ${userId}: ${(err as Error).message}`,
      );
    });
  }

  private async notifyNewDeviceLogin(
    userId: string,
    deviceInfo: string,
    ipAddress: string,
  ): Promise<void> {
    const loginTitle = 'New Device Login';
    const loginBody = `Your account was accessed from a new device: ${deviceInfo} (IP: ${ipAddress}). If this was not you, change your password immediately.`;
    await this.prisma.notification.create({
      data: {
        notifId: generateNotifId(),
        userId,
        type: NotificationType.SECURITY_NEW_LOGIN,
        category: getCategoryForType(NotificationType.SECURITY_NEW_LOGIN),
        title: loginTitle,
        body: loginBody,
      },
    });
    this.prisma.emitNotificationCreated({
      userId,
      title: loginTitle,
      body: loginBody,
      data: { type: 'SECURITY_NEW_LOGIN' },
    });
    this.realtime.emitToUser(userId, 'new.device.login', {
      deviceInfo,
      ipAddress,
      timestamp: new Date().toISOString(),
    });
  }

  private async notifyRefreshTokenReuse(userId: string): Promise<void> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { email: true },
    });
    const title = 'Refresh Token Reuse Detected';
    const body =
      'A previously rotated session credential was used again. All active sessions were signed out as a precaution. If this was not you, change your password immediately.';

    await this.createSecurityNotification(userId, title, body);
    if (user?.email) {
      await this.dispatchEmail({
        to: user.email,
        subject: 'Security Alert: Session Credential Reuse Detected',
        templateName: 'refresh-token-reuse-detected',
        templateContext: {},
      });
    }
  }

  /**
   * SEC (round-2): notifikasi dugaan pencurian saat JWT refresh valid tetapi
   * jti tidak dikenal DB. TIDAK mencabut semua sesi (kemungkinan besar sesi
   * terhapus oleh eviksi/cleanup) — hanya menolak request + memberi tahu user.
   */
  private async notifyUnknownRefreshSession(userId: string): Promise<void> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { email: true },
    });
    const title = 'Aktivitas sesi mencurigakan terdeteksi';
    const body =
      'Ada upaya memakai kredensial sesi yang tidak kami kenali pada akun Anda. ' +
      'Permintaan tersebut ditolak dan sesi aktif Anda tidak terpengaruh. ' +
      'Jika ini bukan Anda, segera ganti kata sandi dan periksa perangkat tertaut.';
    await this.createSecurityNotification(userId, title, body);
    if (user?.email) {
      await this.dispatchEmail({
        to: user.email,
        subject: 'Security Alert: Unrecognized Session Credential',
        templateName: 'refresh-session-unknown',
        templateContext: {},
      });
    }
  }

  private async saveSession(
    userId: string,
    refreshToken: string,
    deviceId: string | undefined,
    deviceInfo: string | undefined,
    ipAddress: string,
  ): Promise<string> {
    const payload: DecodedTokenPayload | null = this.tokenService.decodeToken(refreshToken);
    if (!payload?.jti) {
      throw new InternalServerErrorException({
        code: ErrorCodes.INTERNAL_SERVER_ERROR,
        message: 'Failed to decode refresh token — token may be malformed',
      });
    }
    const jti = payload.jti;

    // AUDIT-10: store a plain SHA-256 of the refresh token instead of bcrypt-hashing it.
    // The refresh token is a signed HS256 JWT with full entropy, so bcrypt's anti-GPU
    // properties are not needed (OWASP: strong hashing is for low-entropy secrets), while
    // the cost-12 hash put ~250 ms of CPU on every login AND every refresh (`refreshToken`
    // compares with bcryptCompare and rotation re-hashed). Legacy bcrypt rows still verify
    // via `verifyStoredRefreshToken` and are upgraded to sha256 on the next rotation.
    const hashedRefreshToken = sha256(refreshToken);

    const MAX_SESSIONS_PER_USER = this.configService.get<number>('app.maxSessionsPerUser') ?? 5;
    const now = new Date();
    const { session, revokedIds } = await this.prisma.$transaction(
      async tx => {
        const evictedIds: string[] = [];
        if (deviceId) {
          const sameDeviceSessions = await tx.userSession.findMany({
            where: { userId, deviceId, isRevoked: false, expiresAt: { gt: now } },
            select: { id: true },
          });
          const sameDeviceIds = sameDeviceSessions.map(candidate => candidate.id);
          if (sameDeviceIds.length) {
            await tx.userSession.updateMany({
              where: { id: { in: sameDeviceIds }, isRevoked: false },
              data: {
                isRevoked: true,
                revokedAt: new Date(),
                revokedReason: 'device_reauthenticated',
              },
            });
            evictedIds.push(...sameDeviceIds);
          }
        }
        const activeSessions = await tx.userSession.count({
          where: { userId, isRevoked: false, expiresAt: { gt: now } },
        });
        if (activeSessions >= MAX_SESSIONS_PER_USER) {
          const oldest = await tx.userSession.findMany({
            where: { userId, isRevoked: false, expiresAt: { gt: now } },
            orderBy: { createdAt: 'asc' },
            take: activeSessions - MAX_SESSIONS_PER_USER + 1,
            select: { id: true },
          });
          const oldestIds = oldest.map(s => s.id);
          await tx.userSession.updateMany({
            where: { id: { in: oldestIds } },
            data: {
              isRevoked: true,
              revokedAt: new Date(),
              revokedReason: 'session_limit_exceeded',
            },
          });
          evictedIds.push(...oldestIds);
        }

        const newSession = await tx.userSession.create({
          data: {
            userId,
            jti,
            refreshToken: hashedRefreshToken,
            deviceId: deviceId || null,
            deviceInfo,
            ipAddress,
            expiresAt: this.getRefreshTokenExpiryDate(),
          },
        });

        return { session: newSession, revokedIds: evictedIds };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );

    if (revokedIds.length > 0) {
      await this.revokeSessionsInRedis([...new Set(revokedIds)]).catch((err: unknown) => {
        this.logger.warn(
          `[SECURITY] Session revocation persisted but Redis propagation is unavailable: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
    }

    return session.id;
  }

  private getAccessTokenTtlSeconds(): number {
    const expiresIn: string = this.configService.get<string>('jwt.expiresIn') ?? '15m';
    const match = expiresIn.match(/^(\d+)([smhd])$/);
    if (!match) return 15 * 60;
    const value = parseInt(match[1], 10);
    const unit = match[2];
    const multipliers: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86400 };
    return value * (multipliers[unit] ?? 60);
  }

  private getRefreshTokenTtlSeconds(): number {
    const expiresIn: string = this.configService.get<string>('jwt.refreshExpiresIn') ?? '7d';
    const match = expiresIn.match(/^(\d+)([smhd])$/);
    if (!match) return 7 * 24 * 60 * 60;
    const value = parseInt(match[1], 10);
    const unit = match[2];
    const multipliers: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86400 };
    return value * (multipliers[unit] ?? 60);
  }

  private getRefreshTokenExpiryDate(): Date {
    const ttl = this.getRefreshTokenTtlSeconds();
    return new Date(Date.now() + ttl * 1000);
  }

  private extractBcryptRounds(hash: string): number {
    const match = hash.match(/^\$2[aby]?\$(\d+)\$/);
    return match ? parseInt(match[1], 10) : 0;
  }

  private async revokeSessionsInRedis(sessionIds: string[]): Promise<void> {
    if (!sessionIds.length) return;
    const ttl = this.getAccessTokenTtlSeconds();
    await Promise.all(
      sessionIds.map(id =>
        this.redis.setex(SESSION_REVOKED_KEY(id), ttl, '1', { throwOnError: true }),
      ),
    );
  }

  // ─────────────────────────────────────────────────────────────────
  // SOCIAL LOGIN (Google, Apple) — GAP-A G001–G025
  // ─────────────────────────────────────────────────────────────────

  /**
   * G020: versi teks persetujuan yang ditampilkan ke pengguna sebelum profil
   * dasar provider dikirim ke Kahade. Disimpan di social_accounts
   * (consentAt + consentTextVersion) sebagai bukti persetujuan.
   */
  static readonly SOCIAL_CONSENT_VERSION = 'social-consent-v1';

  /**
   * G003: kontrak kapabilitas provider agar aplikasi tidak menebak konfigurasi
   * environment. Public, tanpa PII.
   */
  /**
   * G002/G003: kapabilitas provider login sosial. Publik, tanpa PII —
   * aplikasi memakai ini untuk menampilkan/menyembunyikan tombol Google &
   * Apple tanpa menebak env. `appId` adalah OAuth client ID (publik by
   * design) yang dipakai aplikasi untuk memulai alur OAuth.
   */
  getSocialProviders(): {
    providers: { provider: 'GOOGLE' | 'APPLE'; enabled: boolean; appId: string | null }[];
  } {
    const googleClientId =
      this.configService.get<string>('app.googleClientId') || process.env.GOOGLE_CLIENT_ID;
    const appleClientId = this.appleAuth.getClientId();
    return {
      providers: [
        { provider: 'GOOGLE', enabled: !!googleClientId, appId: googleClientId ?? null },
        { provider: 'APPLE', enabled: !!appleClientId, appId: appleClientId ?? null },
      ],
    };
  }

  /**
   * G004: entry point POST /v1/auth/social-login.
   *
   * Mengembalikan sesi penuh, ATAU `{ requiresLink: true, ... }`:
   * - email provider dipakai akun lain → konflik; TIDAK PERNAH di-auto-link/
   *   di-auto-create (G014). Aplikasi menampilkan layar konfirmasi + re-auth
   *   akun lama, lalu POST /v1/auth/social/link/confirm.
   * - identitas baru (isNewIdentity) → aplikasi mengarahkan ke pendaftaran
   *   nomor HP (OTP WhatsApp); linkToken scope social_signup ditautkan di
   *   POST /v1/auth/phone-register setelah nomor terverifikasi.
   */
  async socialLogin(
    provider: 'google' | 'apple',
    idToken: string,
    deviceId: string | undefined,
    deviceInfo: string | undefined,
    ipAddress: string,
    nonce?: string,
  ): Promise<SocialLoginResult | SocialLoginPendingLink> {
    if (provider === 'google') {
      const identity = await this.verifyGoogleIdentity(idToken);
      return this.loginWithSocialIdentity('GOOGLE', identity, deviceId, deviceInfo, ipAddress);
    }
    // G009–G011: Apple aktif hanya bila dikonfigurasi (G002); selain itu tetap
    // melempar SOCIAL_PROVIDER_NOT_SUPPORTED yang terstruktur (G005).
    if (!this.appleAuth.isConfigured()) {
      throw new BadRequestException({
        code: 'SOCIAL_PROVIDER_NOT_SUPPORTED',
        message: `Social provider ${provider} is not yet configured. Please use phone OTP login.`,
      });
    }
    // SEC (round-2): nonce Apple wajib diterbitkan server — konsumsi sekali
    // pakai dari Redis SEBELUM verifikasi token (tolak nonce buatan klien).
    const serverNonce = await this.consumeAppleNonce(nonce, deviceId);
    const identity = await this.verifyAppleIdentity(idToken, serverNonce);
    return this.loginWithSocialIdentity('APPLE', identity, deviceId, deviceInfo, ipAddress);
  }

  /** Identitas terverifikasi dari provider (tanpa token mentah). */
  private async verifyGoogleIdentity(idToken: string): Promise<SocialIdentity> {
    // G005: belum dikonfigurasi → 503 terstruktur, bukan alur gagal misterius.
    const googleClientId =
      this.configService.get<string>('app.googleClientId') || process.env.GOOGLE_CLIENT_ID;
    if (!googleClientId) {
      throw new ServiceUnavailableException({
        code: 'SOCIAL_LOGIN_NOT_CONFIGURED',
        message: 'Google login is not configured on this server.',
      });
    }
    const client = new OAuth2Client(googleClientId);
    try {
      const ticket = await client.verifyIdToken({ idToken, audience: googleClientId });
      const p = ticket.getPayload();
      if (!p || !p.sub || !p.email) throw new Error('No subject/email in token');
      // G024: metrik funnel anonim — provider + tahap saja.
      this.logger.log('social_login_step provider=google step=token_verified');
      return {
        sub: p.sub,
        email: p.email,
        emailVerified: p.email_verified ?? false,
        name: p.name,
      };
    } catch (e) {
      this.logger.warn(`Google ID token verification failed: ${e instanceof Error ? e.message : String(e)}`);
      throw new BadRequestException({ code: 'INVALID_SOCIAL_TOKEN', message: 'Invalid Google ID token' });
    }
  }

  /** G009–G011: verifikasi identityToken Apple (JWKS + nonce anti-replay). */
  private async verifyAppleIdentity(
    identityToken: string,
    nonce: string | undefined,
  ): Promise<SocialIdentity> {
    try {
      const identity = await this.appleAuth.verifyIdentityToken(identityToken, nonce);
      // G024: metrik funnel anonim — provider + tahap saja, tanpa token/email mentah.
      this.logger.log('social_login_step provider=apple step=token_verified');
      return {
        sub: identity.sub,
        email: identity.email,
        emailVerified: identity.emailVerified ?? false,
      };
    } catch (e) {
      this.logger.warn(`Apple identity token verification failed: ${e instanceof Error ? e.message : String(e)}`);
      throw new BadRequestException({ code: 'INVALID_SOCIAL_TOKEN', message: 'Invalid Apple identity token' });
    }
  }

  /**
   * SEC (round-2): nonce Apple DITERBITKAN SERVER, bukan dibuat klien.
   *
   * Alur: aplikasi panggil POST /v1/auth/apple/nonce → pakai nilai nonce di
   * Apple authorization request → kirim nonce yang sama di social-login /
   * social-link. Backend mengonsumsi nonce dari Redis (sekali pakai, TTL
   * pendek) SEBELUM verifikasi token — nonce buatan klien / replay ditolak.
   */
  private static readonly APPLE_NONCE_TTL_SECONDS = 600; // 10 menit
  private static readonly APPLE_NONCE_KEY_PREFIX = 'apple:nonce:';

  /** Terbitkan nonce Apple sekali-pakai (disimpan di Redis, TTL pendek). */
  async issueAppleNonce(deviceId?: string): Promise<{ nonce: string; expiresIn: number }> {
    if (!this.appleAuth.isConfigured()) {
      throw new BadRequestException({
        code: 'SOCIAL_PROVIDER_NOT_SUPPORTED',
        message: 'Apple login is not yet configured. Please use phone OTP login.',
      });
    }
    const nonce = _cryptoRandomBytes(32).toString('hex');
    const payload = JSON.stringify({
      issuedAt: Date.now(),
      deviceId: deviceId ?? null,
    });
    await this.redis.set(
      `${AuthService.APPLE_NONCE_KEY_PREFIX}${nonce}`,
      payload,
      AuthService.APPLE_NONCE_TTL_SECONDS,
      { throwOnError: true },
    );
    // G024: jangan log nilai nonce (secret sekali-pakai).
    this.logger.log('social_login_step provider=apple step=nonce_issued');
    return { nonce, expiresIn: AuthService.APPLE_NONCE_TTL_SECONDS };
  }

  /**
   * Konsumsi nonce Apple secara atomik (getAndDelete → sekali pakai).
   * Melempar BadRequestException bila nonce tidak dikenal / kedaluwarsa /
   * sudah dipakai / deviceId tidak cocok.
   * Mengembalikan nonce yang sama untuk dicocokkan ke klaim token Apple.
   */
  private async consumeAppleNonce(
    nonce: string | undefined,
    deviceId: string | undefined,
  ): Promise<string> {
    if (!nonce || typeof nonce !== 'string' || nonce.length === 0) {
      throw new BadRequestException({
        code: 'APPLE_NONCE_REQUIRED',
        message: 'Nonce Apple wajib diterbitkan server via POST /v1/auth/apple/nonce.',
      });
    }
    const raw = await this.redis.getAndDelete(`${AuthService.APPLE_NONCE_KEY_PREFIX}${nonce}`, {
      throwOnError: true,
    });
    if (!raw) {
      // Nonce tidak dikenal / kedaluwarsa / sudah dipakai (replay).
      this.logger.warn('social_login_step provider=apple step=nonce_rejected reason=unknown_or_reused');
      throw new BadRequestException({
        code: 'APPLE_NONCE_INVALID',
        message: 'Nonce Apple tidak valid, kedaluwarsa, atau sudah dipakai. Minta nonce baru.',
      });
    }
    let parsed: { issuedAt?: number; deviceId?: string | null };
    try {
      parsed = JSON.parse(raw) as { issuedAt?: number; deviceId?: string | null };
    } catch {
      throw new BadRequestException({
        code: 'APPLE_NONCE_INVALID',
        message: 'Nonce Apple tidak valid, kedaluwarsa, atau sudah dipakai. Minta nonce baru.',
      });
    }
    // Defense in depth: Redis TTL sudah menangani kedaluwarsa; cek umur juga.
    const ageMs = Date.now() - (parsed.issuedAt ?? 0);
    if (!parsed.issuedAt || ageMs > AuthService.APPLE_NONCE_TTL_SECONDS * 1000) {
      throw new BadRequestException({
        code: 'APPLE_NONCE_INVALID',
        message: 'Nonce Apple tidak valid, kedaluwarsa, atau sudah dipakai. Minta nonce baru.',
      });
    }
    // Ikat nonce ke device penerbit bila keduanya tersedia.
    if (parsed.deviceId && deviceId && parsed.deviceId !== deviceId) {
      this.logger.warn('social_login_step provider=apple step=nonce_rejected reason=device_mismatch');
      throw new BadRequestException({
        code: 'APPLE_NONCE_DEVICE_MISMATCH',
        message: 'Nonce Apple diterbitkan untuk perangkat lain. Minta nonce baru.',
      });
    }
    return nonce;
  }

  /**
   * Inti login sosial — dipakai login Google & Apple (G012–G016, G020–G024).
   *
   *  1. (provider, providerSub) sudah tertaut → login langsung (G012).
   *  2. Email dipakai akun lain → requiresLink + linkToken TANPA user id
   *     (G014). Penautan hanya setelah re-auth akun lama di /social/link/confirm.
   *  3. Identitas baru → requiresLink + signup token (isNewIdentity). TIDAK
   *     ada pembuatan akun diam-diam: registrasi tetap nomor HP + OTP
   *     WhatsApp; penautan terjadi di phone-register setelah verifikasi.
   *  4. 2FA aktif → TWO_FA_REQUIRED (G016), sama seperti login password.
   */
  private async loginWithSocialIdentity(
    provider: SocialProvider,
    identity: SocialIdentity,
    deviceId: string | undefined,
    deviceInfo: string | undefined,
    ipAddress: string,
  ): Promise<SocialLoginResult | SocialLoginPendingLink> {
    const providerSlug = provider === 'GOOGLE' ? 'google' : 'apple';
    const providerLabel = provider === 'GOOGLE' ? 'Google' : 'Apple';

    // 1. Relasi stabil provider-subject (G012) — email BUKAN identitas utama.
    const linked = await this.prisma.socialAccount.findUnique({
      where: { provider_providerSub: { provider, providerSub: identity.sub } },
      include: { user: true },
    });
    if (linked?.user) {
      const user = linked.user;
      await this.assertSocialAccountUsable(user, providerLabel);
      await this.prisma.socialAccount.update({
        where: { id: linked.id },
        data: { lastUsedAt: new Date() },
      });
      this.logger.log(`social_login_step provider=${providerSlug} step=linked_login`);
      return this.issueSocialSession(user, deviceId, deviceInfo, ipAddress, false, providerLabel);
    }

    // 2. Konflik email (G014): email provider sudah dipakai akun lain
    // (password/OTP). Jangan buat akun duplikat, jangan auto-link.
    // linkToken TIDAK mengikat ke user id — hanya { provider, providerSub,
    // email } (sub='pending'). Frontend meminta user membuktikan kepemilikan
    // akun Kahade lama (password/2FA/OTP WhatsApp) di /social/link/confirm
    // SEBELUM penautan terjadi. Tanpa re-auth, token ini tidak berguna.
    const normalizedEmail = identity.email?.trim().toLowerCase();
    if (normalizedEmail) {
      const existing = await this.prisma.user.findUnique({ where: { email: normalizedEmail } });
      if (existing) {
        const linkToken = this.tokenService.signTempToken({
          sub: 'pending',
          scope: 'social_link_confirm',
          deviceId,
          extra: { provider, providerSub: identity.sub, email: normalizedEmail },
        });
        this.logger.log(`social_login_step provider=${providerSlug} step=email_conflict`);
        return {
          requiresLink: true as const,
          linkToken,
          maskedEmail: maskEmail(normalizedEmail),
          provider: providerSlug,
        };
      }
    }

    // 3. Identitas sosial baru — BUKAN dibuatkan akun diam-diam.
    // Keputusan produk: registrasi tetap nomor HP + OTP WhatsApp. Social login
    // adalah metode masuk tambahan, bukan jalur registrasi alternatif.
    // Kembalikan signup token (scope 'social_signup', sub='pending') agar
    // frontend mengarahkan user ke pendaftaran nomor HP; penautan terjadi
    // di phone-register SETELAH nomor terverifikasi.
    const signupToken = this.tokenService.signTempToken({
      sub: 'pending',
      scope: 'social_signup',
      deviceId,
      extra: { provider, providerSub: identity.sub, email: normalizedEmail ?? null },
    });
    this.logger.log(`social_login_step provider=${providerSlug} step=new_identity_link_required`);
    return {
      requiresLink: true as const,
      linkToken: signupToken,
      provider: providerSlug,
      isNewIdentity: true,
    };
  }

  /**
   * BAI-074: blokir login selama suspend ringan berbatas waktu.
   * State suspend disimpan di Redis dengan TTL (= auto-unsuspend);
   * `redis.exists` fail-open (0 saat Redis error) mengikuti pola service.
   */
  private async assertNotSuspended(userId: string): Promise<void> {
    const suspended = await this.redis.exists(USER_SUSPENDED_KEY(userId));
    if (suspended) {
      throw new ForbiddenException({
        code: ErrorCodes.ACCOUNT_SUSPENDED,
        message: 'Akun ditangguhkan sementara. Silakan coba lagi nanti.',
      });
    }
  }

  /** G023: pesan seragam untuk akun nonaktif/dibatasi/dikunci. */
  private async assertSocialAccountUsable(
    user: { id: string; isActive: boolean; isBanned: boolean; lockedUntil: Date | null },
    providerLabel: string,
  ): Promise<void> {
    if (!user.isActive || user.isBanned) {
      throw new ForbiddenException({
        code: ErrorCodes.ACCOUNT_INACTIVE,
        message: 'Akun ini nonaktif atau dibatasi. Hubungi support Kahade.',
      });
    }
    // BAI-074: suspend ringan ikut diblokir di jalur login sosial.
    await this.assertNotSuspended(user.id);
    if (!user.isActive || user.isBanned) {
      throw new ForbiddenException({
        code: ErrorCodes.ACCOUNT_INACTIVE,
        message: 'Akun ini nonaktif atau dibatasi. Hubungi support Kahade.',
      });
    }
    if (user.lockedUntil && user.lockedUntil > new Date()) {
      const remaining = Math.ceil((user.lockedUntil.getTime() - Date.now()) / 1000);
      throw new UnauthorizedException({
        code: ErrorCodes.ACCOUNT_LOCKED,
        message: 'Akun dikunci sementara karena terlalu banyak percobaan gagal.',
        lockoutRemainingSeconds: remaining,
      });
    }
  }

  /**
   * Terbitkan sesi setelah identitas sosial terverifikasi (G016).
   * 2FA aktif → TWO_FA_REQUIRED (controller memetakan ke layar kode),
   * sama seperti login password — login sosial TIDAK melemahkan 2FA.
   */
  private async issueSocialSession(
    user: {
      id: string; userId: string; username: string | null; email: string | null;
      fullName: string; avatarUrl: string | null; bio: string | null; accountType: string;
      emailVerified: boolean; kycStatus: string; isKahadePlus: boolean;
      subscriptionExpiresAt: Date | null; membershipRank: string;
      phoneNumber: string; phoneVerified: boolean; dateOfBirth: Date | null;
      gender: string | null; createdAt: Date;
    },
    deviceId: string | undefined,
    deviceInfo: string | undefined,
    ipAddress: string,
    isNewUser: boolean,
    providerLabel: string,
  ): Promise<SocialLoginResult> {
    const twoFactorAuth = await this.prisma.twoFactorAuth.findUnique({ where: { userId: user.id } });
    if (twoFactorAuth?.isEnabled) {
      const tempToken = this.tokenService.signTempToken({
        sub: user.id,
        scope: '2fa_verify',
        deviceId: deviceId || 'social',
      });
      throw new BadRequestException({
        code: 'TWO_FA_REQUIRED',
        message: 'Verifikasi 2FA diperlukan.',
        tempToken,
      });
    }

    await this.prisma.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date(), lastLoginIp: ipAddress, failedLoginAttempts: 0, lockedUntil: null },
    });

    const refreshToken = this.tokenService.signRefreshToken({ sub: user.id });
    const sessionId = await this.saveSession(user.id, refreshToken, deviceId, deviceInfo, ipAddress);
    if (deviceId) {
      await this.trackDevice(user.id, deviceId, deviceInfo, ipAddress).catch(() => undefined);
    }
    const accessToken = this.tokenService.signAccessToken({
      sub: user.id,
      userId: user.userId,
      email: user.email ?? '',
      username: user.username ?? '',
      sessionId,
      kycStatus: user.kycStatus,
      emailVerified: user.emailVerified,
    });

    this.auditLog.logUserAction({
      userId: user.id,
      action: UserAuditAction.LOGIN,
      entityType: 'User',
      entityId: user.id,
      description: `User logged in via ${providerLabel} social login from ${ipAddress}`,
      ipAddress,
    });

    return {
      accessToken,
      refreshToken,
      isNewUser,
      user: {
        id: user.id,
        userId: user.userId,
        username: user.username,
        email: user.email ?? '',
        fullName: user.fullName,
        avatarUrl: user.avatarUrl ?? null,
        bio: user.bio ?? null,
        accountType: user.accountType,
        emailVerified: user.emailVerified,
        kycStatus: user.kycStatus,
        isKahadePlus: user.isKahadePlus,
        subscriptionExpiresAt: user.subscriptionExpiresAt ? user.subscriptionExpiresAt.toISOString() : null,
        membershipRank: user.membershipRank,
        isMfaEnabled: twoFactorAuth?.isEnabled ?? false,
        phoneNumber: await decryptPiiSafe(user.phoneNumber),
        phoneVerified: user.phoneVerified ?? false,
        dateOfBirth: user.dateOfBirth ? user.dateOfBirth.toISOString() : null,
        gender: user.gender ?? null,
        createdAt: user.createdAt.toISOString(),
      },
    };
  }

  /**
   * G014: konfirmasi penautan setelah konflik email. linkToken sekali-pakai
   * (scope social_link_confirm, sub='pending', TTL 5 menit) hanya membawa
   * { provider, providerSub, email } — TIDAK membawa user id.
   *
   * Anti account-takeover: user WAJIB membuktikan kepemilikan akun Kahade
   * lama via `reauth` (password / OTP WhatsApp / reauthToken + TOTP bila 2FA
   * aktif, pola sama dengan assertPasskeyReauthenticated). Tanpa re-auth yang
   * valid, penautan DITOLAK — penguasaan email di provider saja tidak cukup.
   */
  async confirmSocialLink(
    linkToken: string,
    reauth: { password?: string; mfaCode?: string; otpCode?: string; reauthToken?: string },
    deviceId: string | undefined,
    deviceInfo: string | undefined,
    ipAddress: string,
  ): Promise<SocialLoginResult> {
    let payload: TempTokenPayload;
    try {
      payload = this.tokenService.verifyTempToken(linkToken);
    } catch {
      throw new UnauthorizedException({
        code: ErrorCodes.INVALID_TOKEN,
        message: 'Tautan konfirmasi kedaluwarsa. Ulangi login sosial Anda.',
      });
    }
    const extra = payload as TempTokenPayload & {
      provider?: SocialProvider;
      providerSub?: string;
      email?: string;
    };
    if (
      payload.scope !== 'social_link_confirm' ||
      payload.sub !== 'pending' ||
      !extra.provider ||
      !extra.providerSub ||
      !extra.email
    ) {
      throw new UnauthorizedException({
        code: ErrorCodes.INVALID_TOKEN,
        message: 'Tautan konfirmasi tidak valid.',
      });
    }

    // Akun pemilik email — dicari dari email, bukan dari token.
    const normalizedEmail = extra.email.trim().toLowerCase();
    const user = await this.prisma.user.findUnique({ where: { email: normalizedEmail } });
    if (!user) {
      throw new NotFoundException({
        code: ErrorCodes.USER_NOT_FOUND,
        message: 'Akun dengan email ini tidak ditemukan. Mungkin sudah dihapus.',
      });
    }
    const providerLabel = extra.provider === 'GOOGLE' ? 'Google' : 'Apple';
    await this.assertSocialAccountUsable(user, providerLabel);

    // Re-auth akun lama WAJIB sebelum penautan (anti take-over).
    await this.assertPasskeyReauthenticated(user.id, reauth);

    // Klaim token sekali-pakai SETELAH re-auth lolos — percobaan gagal tidak
    // membakar token (user bisa memperbaiki password/OTP).
    await this.claimTempTokenOnce(
      payload.jti,
      this.getTempTokenTtlFromPayload(payload),
      'LINK_TOKEN_USED',
      'Tautan konfirmasi sudah dipakai. Ulangi login sosial Anda.',
    );

    const taken = await this.prisma.socialAccount.findUnique({
      where: { provider_providerSub: { provider: extra.provider, providerSub: extra.providerSub } },
      select: { id: true, userId: true },
    });
    if (taken) {
      if (taken.userId === user.id) {
        // Sudah tertaut (mis. double-submit) → langsung login.
        this.logger.log(`social_login_step provider=${extra.provider.toLowerCase()} step=link_confirmed_idempotent`);
        return this.issueSocialSession(user, deviceId, deviceInfo, ipAddress, false, providerLabel);
      }
      throw new ConflictException({
        code: 'SOCIAL_ACCOUNT_TAKEN',
        message: `Akun ${providerLabel} ini sudah tertaut ke akun Kahade lain.`,
      });
    }

    const now = new Date();
    await this.prisma.socialAccount.create({
      data: {
        userId: user.id,
        provider: extra.provider,
        providerSub: extra.providerSub,
        email: extra.email ?? null,
        lastUsedAt: now,
        consentAt: now,
        consentTextVersion: AuthService.SOCIAL_CONSENT_VERSION,
      },
    });
    this.auditLog.logUserAction({
      userId: user.id,
      action: UserAuditAction.SOCIAL_PROVIDER_LINKED,
      entityType: 'SocialAccount',
      entityId: `${extra.provider}:${extra.providerSub}`,
      description: `${providerLabel} ditautkan via konfirmasi konflik email (re-auth terverifikasi)`,
      ipAddress,
    });
    await this.sendSocialSecurityNotification(
      user.id,
      `${providerLabel} ditautkan ke akun Anda`,
      `Akun ${providerLabel} baru saja ditautkan ke akun Kahade Anda setelah konfirmasi. Jika ini bukan Anda, segera lepaskan dari menu Keamanan.`,
      ipAddress,
    ).catch(() => undefined);

    this.logger.log(`social_login_step provider=${extra.provider.toLowerCase()} step=link_confirmed`);
    return this.issueSocialSession(user, deviceId, deviceInfo, ipAddress, false, providerLabel);
  }

  /**
   * G013: tautkan Google/Apple dari akun yang sedang login.
   * Wajib re-auth (password/OTP + TOTP bila 2FA aktif) sebelum menautkan.
   */
  async linkSocialProvider(
    userId: string,
    provider: 'google' | 'apple',
    idToken: string,
    nonce: string | undefined,
    reauth: { password?: string; mfaCode?: string; otpCode?: string },
    ipAddress: string,
  ): Promise<{ message: string; linked: LinkedSocialProvider[] }> {
    await this.assertPasskeyReauthenticated(userId, reauth);

    const identity =
      provider === 'google'
        ? await this.verifyGoogleIdentity(idToken)
        : await this.verifyAppleIdentity(
            idToken,
            // SEC (round-2): nonce Apple wajib diterbitkan server (sekali pakai).
            await this.consumeAppleNonce(nonce, undefined),
          );
    const providerEnum: SocialProvider = provider === 'google' ? 'GOOGLE' : 'APPLE';
    const providerLabel = provider === 'google' ? 'Google' : 'Apple';

    const taken = await this.prisma.socialAccount.findUnique({
      where: { provider_providerSub: { provider: providerEnum, providerSub: identity.sub } },
      select: { id: true, userId: true },
    });
    if (taken) {
      if (taken.userId === userId) {
        return { message: `Akun ${providerLabel} sudah tertaut ke akun ini.`, linked: await this.getLinkedSocialProviders(userId) };
      }
      throw new ConflictException({
        code: 'SOCIAL_ACCOUNT_TAKEN',
        message: `Akun ${providerLabel} ini sudah tertaut ke akun Kahade lain.`,
      });
    }

    // Email provider tidak boleh milik akun lain (G014).
    const normalizedEmail = identity.email?.trim().toLowerCase();
    if (normalizedEmail) {
      const owner = await this.prisma.user.findUnique({ where: { email: normalizedEmail }, select: { id: true } });
      if (owner && owner.id !== userId) {
        throw new ConflictException({
          code: 'SOCIAL_EMAIL_CONFLICT',
          message: `Email ${providerLabel} ini dipakai akun Kahade lain. Lepaskan dulu dari akun tersebut.`,
        });
      }
    }

    const now = new Date();
    await this.prisma.socialAccount.create({
      data: {
        userId,
        provider: providerEnum,
        providerSub: identity.sub,
        email: normalizedEmail ?? null,
        lastUsedAt: now,
        // G020: persetujuan dicatat sebelum profil provider dipakai.
        consentAt: now,
        consentTextVersion: AuthService.SOCIAL_CONSENT_VERSION,
      },
    });
    this.auditLog.logUserAction({
      userId,
      action: UserAuditAction.SOCIAL_PROVIDER_LINKED,
      entityType: 'SocialAccount',
      entityId: `${providerEnum}:${identity.sub}`,
      description: `${providerLabel} ditautkan dari menu keamanan`,
      ipAddress,
    });
    await this.sendSocialSecurityNotification(
      userId,
      `${providerLabel} ditautkan ke akun Anda`,
      `Akun ${providerLabel} baru saja ditautkan sebagai metode masuk. Jika ini bukan Anda, segera lepaskan dari menu Keamanan dan amankan akun Anda.`,
      ipAddress,
    ).catch(() => undefined);

    this.logger.log(`social_login_step provider=${provider} step=linked_from_settings`);
    return { message: `Akun ${providerLabel} berhasil ditautkan.`, linked: await this.getLinkedSocialProviders(userId) };
  }

  /**
   * G019: lepas tautan provider. Wajib re-auth; menolak bila ini
   * satu-satunya metode login yang tersisa.
   */
  async unlinkSocialProvider(
    userId: string,
    provider: 'google' | 'apple',
    reauth: { password?: string; mfaCode?: string; otpCode?: string },
    ipAddress: string,
  ): Promise<{ message: string; linked: LinkedSocialProvider[] }> {
    await this.assertPasskeyReauthenticated(userId, reauth);

    const providerEnum: SocialProvider = provider === 'google' ? 'GOOGLE' : 'APPLE';
    const providerLabel = provider === 'google' ? 'Google' : 'Apple';
    const link = await this.prisma.socialAccount.findFirst({
      where: { userId, provider: providerEnum },
      select: { id: true },
    });
    if (!link) {
      throw new NotFoundException({
        code: 'SOCIAL_PROVIDER_NOT_LINKED',
        message: `Akun ${providerLabel} belum tertaut ke akun ini.`,
      });
    }

    // G019: jangan kunci pengguna keluar dari akunnya sendiri.
    // Metode masuk yang dihitung: password, login OTP WhatsApp (phoneVerified),
    // provider sosial lain, dan passkey aktif.
    const [user, otherSocials, activePasskeys] = await Promise.all([
      this.prisma.user.findUnique({
        where: { id: userId },
        select: { password: true, phoneVerified: true },
      }),
      this.prisma.socialAccount.count({ where: { userId, id: { not: link.id } } }),
      this.prisma.passkeyCredential.count({ where: { userId, revokedAt: null } }),
    ]);
    const hasPassword = !!user?.password;
    // Nomor HP terverifikasi = selalu bisa masuk via OTP WhatsApp.
    const hasPhoneLogin = user?.phoneVerified === true;
    if (!hasPassword && !hasPhoneLogin && otherSocials === 0 && activePasskeys === 0) {
      throw new BadRequestException({
        code: 'SOCIAL_LAST_METHOD',
        message:
          'Ini satu-satunya metode masuk Anda. Tambahkan kata sandi, verifikasi nomor HP, atau metode lain dulu sebelum melepas tautan ini.',
      });
    }

    await this.prisma.socialAccount.delete({ where: { id: link.id } });
    this.auditLog.logUserAction({
      userId,
      action: UserAuditAction.SOCIAL_PROVIDER_UNLINKED,
      entityType: 'SocialAccount',
      entityId: link.id,
      description: `${providerLabel} dilepas dari akun`,
      ipAddress,
    });
    await this.sendSocialSecurityNotification(
      userId,
      `${providerLabel} dilepas dari akun Anda`,
      `Tautan ${providerLabel} sebagai metode masuk telah dilepas. Jika ini bukan Anda, segera amankan akun Anda.`,
      ipAddress,
    ).catch(() => undefined);

    return { message: `Tautan ${providerLabel} berhasil dilepas.`, linked: await this.getLinkedSocialProviders(userId) };
  }

  /**
   * G018: provider mana yang tertaut — tanpa membuka token provider.
   * Email ditampilkan apa adanya ke pemilik akun (miliknya sendiri).
   */
  async getLinkedSocialProviders(userId: string): Promise<LinkedSocialProvider[]> {
    const rows = await this.prisma.socialAccount.findMany({
      where: { userId },
      orderBy: { linkedAt: 'asc' },
      select: { provider: true, email: true, linkedAt: true, lastUsedAt: true },
    });
    return rows.map((r) => ({
      provider: (r.provider === 'GOOGLE' ? 'google' : 'apple') as 'google' | 'apple',
      email: r.email,
      linkedAt: r.linkedAt,
      lastUsedAt: r.lastUsedAt,
    }));
  }

  /**
   * G015: tolak aksi sensitif bila nomor HP masih sintetis (akun sosial
   * yang belum mengganti nomor). Dipakai withdraw, rekening bank, dsb.
   */
  async assertRealPhoneForSensitive(userId: string): Promise<void> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { requiresPhoneVerification: true },
    });
    if (user?.requiresPhoneVerification) {
      throw new ForbiddenException({
        code: 'PHONE_VERIFICATION_REQUIRED',
        message:
          'Verifikasi nomor HP Anda terlebih dahulu via WhatsApp sebelum memakai fitur ini. Buka Profil → Verifikasi nomor HP.',
      });
    }
  }

  /** G021: notifikasi keamanan in-app saat provider ditautkan/dilepas. */
  private async sendSocialSecurityNotification(
    userId: string,
    title: string,
    body: string,
    ipAddress?: string,
  ): Promise<void> {
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
      data: { type: 'SECURITY_ALERT', notificationType: type, ipAddress: ipAddress ?? 'unknown' },
    });
  }
}

/**
 * G012: identitas sosial terverifikasi — sub (stabil) sebagai kunci,
 * email hanya atribut pelengkap.
 */
export interface SocialIdentity {
  sub: string;
  email?: string;
  emailVerified: boolean;
  name?: string;
}

export interface SocialLoginResult {
  accessToken: string;
  refreshToken: string;
  user: LoginUserPayload;
  isNewUser: boolean;
}

/** G014: email provider bentrok dengan akun lain — butuh konfirmasi taut. */
export interface SocialLoginPendingLink {
  requiresLink: true;
  linkToken: string;
  /** Ada hanya untuk konflik email (akun lama). Identitas baru tidak membawa email termask. */
  maskedEmail?: string;
  provider: 'google' | 'apple';
  /**
   * true bila identitas sosial belum punya akun Kahade sama sekali.
   * Frontend WAJIB mengarahkan ke pendaftaran nomor HP (OTP WhatsApp);
   * linkToken (scope 'social_signup') dipakai untuk menautkan SETELAH
   * nomor HP terverifikasi — bukan untuk membuat akun diam-diam.
   */
  isNewIdentity?: boolean;
}

/** G018: ringkasan provider tertaut (tanpa token). */
export interface LinkedSocialProvider {
  provider: 'google' | 'apple';
  email: string | null;
  linkedAt: Date;
  lastUsedAt: Date | null;
}

/** Masking email untuk layar konfirmasi konflik (G014). */
function maskEmail(email: string): string {
  const [local, domain] = email.split('@');
  if (!domain) return '••••••';
  const head = local.slice(0, 1);
  return `${head}••••••@${domain}`;
}
