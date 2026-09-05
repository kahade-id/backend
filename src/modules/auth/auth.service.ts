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
import { OtpType, NotificationType, UserAuditAction, Gender, Prisma } from '@prisma/client';
import { getCategoryForType } from '../notifications/notification-category.map';
import { generateUserId, generateReferralCode, generateNotifId } from '../../common/utils/id-generator.util';
import { bcryptHash, bcryptCompare, sha256, encryptAES, decryptAES, getBcryptRounds, hmacPinDigest } from '../../common/utils/crypto.util';
import { hashPhoneNumber, encryptPii, decryptPiiSafe } from '../../common/utils/pii.util';
import { addMinutes } from '../../common/utils/date.util';
import { generateBackupCodes, hashOtp, verifyOtp } from '../../common/utils/otp.util';
import { TOKEN_BLACKLIST, TOTP_USED_CODE, SESSION_REVOKED_KEY, BACKUP_CODE_USED, PHONE_VERIFIED_GUARD } from '../../common/constants/redis-keys';
import * as ErrorCodes from '../../common/constants/error-codes';
import {
  RESERVED_USERNAMES,
  ACCOUNT_LOCK_MAX_ATTEMPTS,
  ACCOUNT_LOCK_DURATION_MINUTES,
  PASSWORD_MIN_LENGTH,
  MAX_REFERRALS,
  OTP_MAX_ATTEMPTS,
} from '../../common/constants/app.constants';
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
import { randomBytes as _cryptoRandomBytes, randomInt as _cryptoRandomInt } from 'crypto';
const TWO_FA_ATTEMPT_KEY = (userId: string): string => `2fa_attempts:${userId}`;

let _dummyHash: string | undefined;
const _dummyHashReady = bcryptHash(
  _cryptoRandomBytes(32).toString('hex'),
  getBcryptRounds(),
).then((h: string) => { _dummyHash = h; });

const TWO_FA_MAX_ATTEMPTS = 5;

function validatePasswordComplexity(password: string): void {
  if (password.length < PASSWORD_MIN_LENGTH) {
    throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: `Password must be at least ${PASSWORD_MIN_LENGTH} characters` });
  }
  if (!/[A-Z]/.test(password)) {
    throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Password must contain at least one uppercase letter' });
  }
  if (!/[a-z]/.test(password)) {
    throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Password must contain at least one lowercase letter' });
  }
  if (!/\d/.test(password)) {
    throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Password must contain at least one number' });
  }
  if (!/[^A-Za-z0-9]/.test(password)) {
    throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Password must contain at least one special character' });
  }
}

interface LoginUserPayload {
  id: string; userId: string; username: string | null; email: string;
  fullName: string; avatarUrl: string | null; bio: string | null;
  accountType: string; emailVerified: boolean; kycStatus: string;
  isKahadePlus: boolean; subscriptionExpiresAt: string | null;
  membershipRank: string;
  isMfaEnabled: boolean; phoneNumber: string | null; phoneVerified: boolean;
  dateOfBirth: string | null; gender: string | null; createdAt: string;
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
    @InjectQueue(EMAIL_QUEUE) private readonly emailQueue: Queue<EmailJobData>,
  ) {}

  // ─────────────────────────────────────────────────────────────────
  // REGISTER
  // ─────────────────────────────────────────────────────────────────
  /** @deprecated Use phoneRegister() for new phone-based registration */
  async register(dto: Record<string, any> & { fullName: string }, ipAddress?: string): Promise<{ message: string }> {
    if (dto.password && dto.confirmPassword !== dto.password) {
      throw new BadRequestException({
        code: ErrorCodes.PASSWORDS_DO_NOT_MATCH,
        message: 'Password and confirmation do not match',
      });
    }
    if (dto.password) {
      validatePasswordComplexity(dto.password);
    }

    if (dto.dateOfBirth) {
      const dob = new Date(dto.dateOfBirth + 'T00:00:00Z');
      if (isNaN(dob.getTime())) {
        throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Invalid date of birth format. Use ISO 8601 (YYYY-MM-DD)' });
      }
      const age = (Date.now() - dob.getTime()) / (365.25 * 24 * 60 * 60 * 1000);
      if (age < 13 || age > 120) {
        throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Date of birth must represent an age between 13 and 120 years' });
      }
    }

    if (dto.phoneNumber) {
      const cleaned = dto.phoneNumber.replace(/[\s\-.]/g, '');
      const STRICT_INDONESIAN_PHONE = /^(\+62|62|0)8[1-9][0-9]{7,10}$/;
      if (!STRICT_INDONESIAN_PHONE.test(cleaned)) {
        throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Only valid Indonesian mobile numbers are accepted (e.g. 08xx or +628xx)' });
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
        throw new BadRequestException({ code: ErrorCodes.USERNAME_RESERVED, message: 'Username is already taken' });
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

    let referralCodeRecord: { id: string; userId: string; isActive: boolean; totalReferrals: number } | null = null;
    if (dto.referralCode) {
      referralCodeRecord = await this.prisma.referralCode.findUnique({
        where: { code: dto.referralCode.toUpperCase() },
        select: { id: true, userId: true, isActive: true, totalReferrals: true },
      });
      if (!referralCodeRecord || !referralCodeRecord.isActive || referralCodeRecord.totalReferrals >= MAX_REFERRALS) {
        referralCodeRecord = null;
      }
    }

    const hashedPassword = dto.password ? await bcryptHash(dto.password, getBcryptRounds()) : null;
    const userId = generateUserId();
    const myReferralCode = generateReferralCode();

    let user: { id: string; userId: string; email: string | null };
    try {
      user = await this.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
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
            ...(dto.dateOfBirth    ? { dateOfBirth: new Date(dto.dateOfBirth + 'T00:00:00Z') } : {}),
            ...(dto.gender         ? { gender: dto.gender as Gender } : {}),
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
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    } catch (err: unknown) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        const target = (err.meta?.target as string[]) ?? [];
        if (target.includes('userId')) {
          throw new InternalServerErrorException({ code: 'TRANSIENT_CONFLICT', message: 'Registration failed due to a transient conflict. Please try again.' });
        }
        if (target.includes('username') || target.includes('email') || target.includes('phoneNumber')) {
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
   *  Returns null if the number is not a recognizable Indonesian format.
   */
  private normalizePhoneNumber(phone: string): string {
    const cleaned = phone.replace(/[\s\-.]/g, '');
    const strictIndonesianPhone = /^(\+62|62|0)8[1-9][0-9]{7,10}$/;
    if (!strictIndonesianPhone.test(cleaned)) {
      throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Only valid Indonesian mobile numbers are accepted (e.g. 08xx or +628xx)' });
    }
    if (cleaned.startsWith('0')) {
      // Local format: 08xxx → +628xxx
      return '+62' + cleaned.slice(1);
    }
    if (cleaned.startsWith('62') && !cleaned.startsWith('+62')) {
      // Without plus: 628xxx → +628xxx
      return '+' + cleaned;
    }
    if (cleaned.startsWith('+62')) {
      // Already E.164 Indonesia
      return cleaned;
    }
    throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Only Indonesian phone numbers (+62) are accepted' });
  }

  // ─────────────────────────────────────────────────────────────────
  // REQUEST PHONE OTP (e-wallet style)
  // ─────────────────────────────────────────────────────────────────
  async requestPhoneOtp(
    phoneNumber: string,
    method: 'SMS' | 'WHATSAPP',
    ipAddress?: string,
    deviceId?: string,
  ): Promise<{ message: string; debugCode?: string }> {
    const normalizedPhone = this.normalizePhoneNumber(phoneNumber);
    const phoneHash = hashPhoneNumber(normalizedPhone);

    // Capability check first — fail before generatePhoneOtp() can burn the
    // user's cooldown / rate-limit counters / DB row on a delivery channel
    // the configured provider can't fulfill (e.g. SMS while OTP_PROVIDER=fonnte).
    if (!this.otpGateway.supportsMethod(method)) {
      throw new BadRequestException({
        code: ErrorCodes.VALIDATION_ERROR,
        message:
          method === 'SMS'
            ? 'SMS delivery is not configured. Please use WhatsApp instead.'
            : 'WhatsApp delivery is not configured. Please use SMS instead.',
      });
    }

    const existingUser = await this.prisma.user.findFirst({
      where: { OR: [{ phoneNumberHash: phoneHash }, { phoneNumber: normalizedPhone }] },
      select: { id: true, isActive: true, isBanned: true, lockedUntil: true },
    });

    if (existingUser) {
      if (!existingUser.isActive || existingUser.isBanned) {
        return { message: 'If this number is valid, an OTP has been sent.' };
      }
      if (existingUser.lockedUntil && existingUser.lockedUntil > new Date()) {
        return { message: 'If this number is valid, an OTP has been sent.' };
      }
    }

    const otpMethod = method === 'WHATSAPP' ? 'WHATSAPP' as const : 'SMS' as const;
    const otp = await this.otpService.generatePhoneOtp(
      normalizedPhone,
      OtpType.PHONE_LOGIN,
      otpMethod,
      existingUser?.id,
      { purpose: 'phone_login', deviceId },
      ipAddress,
    );

    let delivery: { success: boolean; error?: string };
    try {
      delivery = await this.otpGateway.sendOtp(normalizedPhone, otp, method);
    } catch (error) {
      this.logger.error(
        `OTP delivery threw for phoneHash=${phoneHash.slice(0, 12)} via ${method}: ${error instanceof Error ? error.message : String(error)}`,
      );
      await this.otpService.invalidatePhoneOtps(normalizedPhone, OtpType.PHONE_LOGIN).catch((cleanupError) => {
        this.logger.error(`Failed to invalidate undelivered phone OTP: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`);
      });
      throw new ServiceUnavailableException({
        code: 'OTP_DELIVERY_FAILED',
        message: 'OTP delivery is temporarily unavailable. Please try again later.',
      });
    }

    if (!delivery.success) {
      this.logger.error(
        `OTP delivery failed for phoneHash=${phoneHash.slice(0, 12)} via ${method}: ${delivery.error ?? 'unknown'}`,
      );
      await this.otpService.invalidatePhoneOtps(normalizedPhone, OtpType.PHONE_LOGIN).catch((cleanupError) => {
        this.logger.error(`Failed to invalidate undelivered phone OTP: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`);
      });
      // Defensive: should be unreachable now that supportsMethod is checked
      // above, but keep the surface so a misconfigured provider still produces
      // a useful error instead of the generic message.
      if (delivery.error === 'OTP_DELIVERY_SMS_UNSUPPORTED') {
        throw new BadRequestException({
          code: ErrorCodes.VALIDATION_ERROR,
          message: 'SMS delivery is not configured. Please use WhatsApp instead.',
        });
      }
      throw new ServiceUnavailableException({
        code: 'OTP_DELIVERY_FAILED',
        message: 'OTP delivery is temporarily unavailable. Please try again later.',
      });
    }

    return {
      message: 'If this number is valid, an OTP has been sent.',
      ...(this.shouldExposeDebugOtp() ? { debugCode: otp } : {}),
    };
  }

  private shouldExposeDebugOtp(): boolean {
    const nodeEnv = (this.configService.get<string>('app.nodeEnv') ?? process.env.NODE_ENV ?? 'development').toLowerCase();
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
  ): Promise<
    | { status: 'new_user'; tempToken: string }
    | { status: 'existing_user'; requires2FA?: boolean; tempToken?: string; accessToken?: string; refreshToken?: string; user?: LoginUserPayload }
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
        throw new ForbiddenException({ code: ErrorCodes.ACCOUNT_INACTIVE, message: 'Account is inactive' });
      }
      if (existingUser.isBanned) {
        throw new ForbiddenException({ code: ErrorCodes.ACCOUNT_BANNED, message: 'Account has been banned' });
      }
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
    if (!verification.valid || !verification.otpId || metadata?.purpose !== 'phone_login' || metadata.deviceId !== deviceId) {
      throw new BadRequestException({ code: ErrorCodes.OTP_INVALID, message: 'Invalid or expired OTP' });
    }
    if (!await this.otpService.consumeVerifiedOtp(verification.otpId)) {
      throw new BadRequestException({ code: ErrorCodes.OTP_INVALID, message: 'Invalid or expired OTP' });
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
      throw new ForbiddenException({ code: ErrorCodes.ACCOUNT_INACTIVE, message: 'Account is inactive' });
    }
    if (existingUser.isBanned) {
      throw new ForbiddenException({ code: ErrorCodes.ACCOUNT_BANNED, message: 'Account has been banned' });
    }
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
      data: { phoneVerified: true },
    });
    await this.redis.del(PHONE_VERIFIED_GUARD(existingUser.id)).catch((err) =>
      this.logger.warn(`Failed to invalidate phone verification cache for ${existingUser.id}: ${err instanceof Error ? err.message : String(err)}`),
    );

    const twoFactorAuth = await this.prisma.twoFactorAuth.findUnique({ where: { userId: existingUser.id } });
    if (twoFactorAuth?.isEnabled) {
      let skipTwoFa = false;
      if (deviceId) {
        const trustedDevice = await this.prisma.userDevice.findFirst({
          where: { userId: existingUser.id, deviceId, isTrusted: true },
        });
        if (trustedDevice?.trustedAt) {
          const trustExpiryMs = (this.configService.get<number>('app.trustedDeviceDays') ?? 30) * 24 * 60 * 60 * 1000;
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
        const tempToken = this.tokenService.signTempToken({ sub: existingUser.id, scope: '2fa_verify', deviceId });
        return { status: 'existing_user', requires2FA: true, tempToken };
      }
    }

    const lockoutCycleKey = `lockout_cycles:${existingUser.id}`;
    await this.redis.del(lockoutCycleKey).catch((err) => this.logger.warn(`silent-catch: ${err instanceof Error ? err.message : String(err)}`));
    await this.prisma.user.update({
      where: { id: existingUser.id },
      data: { failedLoginAttempts: 0, lockedUntil: null, lastLoginAt: new Date(), lastLoginIp: ipAddress },
    });

    const refreshToken = this.tokenService.signRefreshToken({ sub: existingUser.id });
    const sessionId = await this.saveSession(existingUser.id, refreshToken, deviceId, deviceInfo, ipAddress);

    if (deviceId) {
      await this.trackDevice(existingUser.id, deviceId, deviceInfo, ipAddress)
        .catch(err => this.logger.error('trackDevice failed in verifyPhoneOtp()', err));
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
        subscriptionExpiresAt: existingUser.subscriptionExpiresAt ? existingUser.subscriptionExpiresAt.toISOString() : null,
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
    method: 'SMS' | 'WHATSAPP',
    mfaCode?: string,
    ipAddress?: string,
  ): Promise<{ message: string }> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, password: true, phoneNumberHash: true, isActive: true, isBanned: true },
    });
    if (!user || !user.isActive || user.isBanned || !user.password || !await bcryptCompare(currentPassword, user.password)) {
      throw new UnauthorizedException({ code: ErrorCodes.UNAUTHORIZED, message: 'Unable to process phone number change' });
    }

    const normalizedPhone = this.normalizePhoneNumber(newPhoneNumber);
    const phoneHash = hashPhoneNumber(normalizedPhone);
    if (phoneHash === user.phoneNumberHash) {
      throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'The new phone number must be different from your current number' });
    }
    const owner = await this.prisma.user.findFirst({
      where: { OR: [{ phoneNumberHash: phoneHash }, { phoneNumber: normalizedPhone }] },
      select: { id: true },
    });
    if (owner && owner.id !== userId) {
      throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'This phone number cannot be used' });
    }
    await this.verifySensitiveMfa(userId, mfaCode);
    if (!this.otpGateway.supportsMethod(method)) {
      throw new BadRequestException({
        code: ErrorCodes.VALIDATION_ERROR,
        message: method === 'SMS' ? 'SMS delivery is not configured. Please use WhatsApp instead.' : 'WhatsApp delivery is not configured. Please use SMS instead.',
      });
    }

    const otpMethod = method === 'WHATSAPP' ? 'WHATSAPP' as const : 'SMS' as const;
    const otp = await this.otpService.generatePhoneOtp(
      normalizedPhone,
      OtpType.SENSITIVE_ACTION,
      otpMethod,
      userId,
      { purpose: 'phone_change', userId, phoneHash },
      ipAddress,
    );
    let delivery: { success: boolean; error?: string };
    try {
      delivery = await this.otpGateway.sendOtp(normalizedPhone, otp, method);
    } catch {
      await this.otpService.invalidatePhoneOtps(normalizedPhone, OtpType.SENSITIVE_ACTION).catch(() => undefined);
      throw new ServiceUnavailableException({ code: 'OTP_DELIVERY_FAILED', message: 'OTP delivery is temporarily unavailable. Please try again later.' });
    }
    if (!delivery.success) {
      await this.otpService.invalidatePhoneOtps(normalizedPhone, OtpType.SENSITIVE_ACTION).catch(() => undefined);
      throw new ServiceUnavailableException({ code: 'OTP_DELIVERY_FAILED', message: 'OTP delivery is temporarily unavailable. Please try again later.' });
    }
    return { message: 'A verification code has been sent to the new phone number.' };
  }

  async confirmPhoneChange(userId: string, newPhoneNumber: string, code: string): Promise<{ message: string }> {
    const normalizedPhone = this.normalizePhoneNumber(newPhoneNumber);
    const phoneHash = hashPhoneNumber(normalizedPhone);
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, email: true, isActive: true, isBanned: true },
    });
    if (!user || !user.isActive || user.isBanned) {
      throw new UnauthorizedException({ code: ErrorCodes.UNAUTHORIZED, message: 'Unable to process phone number change' });
    }
    const verification = await this.otpService.verifyPhoneOtpWithMetadata(
      normalizedPhone,
      OtpType.SENSITIVE_ACTION,
      code,
      { consume: false },
    );
    const metadata = verification.metadata;
    if (!verification.valid || !verification.otpId || metadata?.purpose !== 'phone_change' || metadata.userId !== userId || metadata.phoneHash !== phoneHash) {
      throw new BadRequestException({ code: ErrorCodes.OTP_INVALID, message: 'Invalid or expired verification code' });
    }
    try {
      const revokedSessionIds = await this.prisma.$transaction(async (tx) => {
        const owner = await tx.user.findFirst({
          where: { OR: [{ phoneNumberHash: phoneHash }, { phoneNumber: normalizedPhone }] },
          select: { id: true },
        });
        if (owner && owner.id !== userId) {
          throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'This phone number cannot be used' });
        }
        const consumed = await tx.otpCode.updateMany({
          where: { id: verification.otpId, isUsed: false },
          data: { isUsed: true, usedAt: new Date() },
        });
        if (consumed.count !== 1) {
          throw new BadRequestException({ code: ErrorCodes.OTP_INVALID, message: 'Invalid or expired verification code' });
        }
        const sessions = await tx.userSession.findMany({ where: { userId, isRevoked: false }, select: { id: true } });
        await tx.user.update({
          where: { id: userId },
          data: { phoneNumber: await encryptPii(normalizedPhone), phoneNumberHash: phoneHash, phoneVerified: true },
        });
        await tx.userSession.updateMany({
          where: { userId, isRevoked: false },
          data: { isRevoked: true, revokedAt: new Date(), revokedReason: 'phone_changed' },
        });
        await tx.userDevice.updateMany({ where: { userId, isTrusted: true }, data: { isTrusted: false, trustedAt: null } });
        return sessions.map((session) => session.id);
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
      await this.revokeSessionsInRedis(revokedSessionIds);
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'This phone number cannot be used' });
      }
      throw error;
    }

    await this.redis.del(PHONE_VERIFIED_GUARD(userId)).catch(() => undefined);
    this.createSecurityNotification(userId, 'Phone Number Changed', 'Your phone number was changed. All active sessions and trusted devices were signed out. If this was not you, contact support immediately.').catch(() => undefined);
    if (user.email) {
      this.dispatchEmail({ to: user.email, subject: 'Security Alert: Phone Number Changed', templateName: 'phone-changed-notification', templateContext: {} }).catch(() => undefined);
    }
    return { message: 'Phone number updated. Please log in again on your devices.' };
  }

  private async verifySensitiveMfa(userId: string, code?: string): Promise<void> {
    const twoFactorAuth = await this.prisma.twoFactorAuth.findUnique({ where: { userId } });
    if (!twoFactorAuth?.isEnabled) return;
    if (!code) {
      throw new ForbiddenException({ code: 'TWO_FA_REQUIRED', message: 'Authenticator or backup code is required for this security change' });
    }

    const normalizedCode = code.trim().toUpperCase();
    let totpVerified = false;
    if (twoFactorAuth.secret) {
      try {
        const secret = await decryptAES(twoFactorAuth.secret);
        totpVerified = speakeasy.totp.verify({ secret, encoding: 'base32', token: normalizedCode, window: 1 });
      } catch {
        throw new BadRequestException({ code: ErrorCodes.TWO_FA_NOT_ENABLED, message: 'Unable to verify 2FA code. Please re-setup 2FA.' });
      }
    }

    if (!totpVerified) {
      const backupCodeAccepted = await this.checkAndConsumeBackupCode(twoFactorAuth, normalizedCode);
      if (!backupCodeAccepted) {
        throw new BadRequestException({ code: ErrorCodes.INVALID_2FA_CODE, message: 'Invalid 2FA code' });
      }
      this.notifyBackupCodeUsed(userId).catch(() => undefined);
      return;
    }

    const hmacSecret = this.configService.get<string>('crypto.hmacSecretKey') || this.configService.get<string>('jwt.secret') || '';
    const totpUsedKey = TOTP_USED_CODE(userId);
    const client = this.redis.getClient();
    const wasAdded = await client.sadd(`${this.redis.getPrefix()}${totpUsedKey}`, sha256(hmacSecret + ':totp:' + normalizedCode));
    if (wasAdded === 0) {
      throw new BadRequestException({ code: ErrorCodes.INVALID_2FA_CODE, message: 'TOTP code already used. Wait for the next code.' });
    }
    await client.expire(`${this.redis.getPrefix()}${totpUsedKey}`, 90);
  }

  // ─────────────────────────────────────────────────────────────────
  // PHONE REGISTER (e-wallet style — after OTP verification)
  // ─────────────────────────────────────────────────────────────────
  async phoneRegister(dto: {
    tempToken: string;
    fullName: string;
    username: string;
    dateOfBirth: string;
    gender: string;
    email: string;
    password: string;
    pin: string;
    address?: string;
    referralCode?: string;
  }, deviceId: string, deviceInfo: string | undefined, ipAddress: string): Promise<{
    accessToken: string;
    refreshToken: string;
    user: LoginUserPayload;
  }> {
    let payload: TempTokenPayload;
    try {
      payload = this.tokenService.verifyTempToken(dto.tempToken);
    } catch {
      throw new UnauthorizedException({ code: ErrorCodes.TEMP_TOKEN_EXPIRED, message: 'Registration token expired. Please verify your phone number again.' });
    }

    if (payload.scope !== 'phone_register') {
      throw new UnauthorizedException({ code: ErrorCodes.UNAUTHORIZED, message: 'Invalid token scope' });
    }
    if (!payload.jti) {
      throw new UnauthorizedException({ code: ErrorCodes.TEMP_TOKEN_EXPIRED, message: 'Invalid registration token. Please verify your phone number again.' });
    }
    if (!payload.deviceId || payload.deviceId !== deviceId) {
      throw new UnauthorizedException({ code: ErrorCodes.TEMP_TOKEN_EXPIRED, message: 'Registration token is not valid for this device. Please verify your phone number again.' });
    }

    const phoneNumber = payload.sub;

    if (dto.dateOfBirth) {
      const dob = new Date(dto.dateOfBirth + 'T00:00:00Z');
      if (isNaN(dob.getTime())) {
        throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Invalid date of birth format. Use ISO 8601 (YYYY-MM-DD)' });
      }
      const age = (Date.now() - dob.getTime()) / (365.25 * 24 * 60 * 60 * 1000);
      if (age < 13 || age > 120) {
        throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Date of birth must represent an age between 13 and 120 years' });
      }
    }

    const normalizedUsername = dto.username.toLowerCase();
    if (RESERVED_USERNAMES.includes(normalizedUsername)) {
      throw new BadRequestException({ code: ErrorCodes.USERNAME_RESERVED, message: 'Username is already taken' });
    }

    validatePasswordComplexity(dto.password);
    this.validatePinPolicy(dto.pin);

    const normalizedEmail = dto.email.toLowerCase().trim();
    const existingEmail = await this.prisma.user.findUnique({ where: { email: normalizedEmail } });
    if (existingEmail) {
      throw new ConflictException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Email already registered' });
    }

    const phoneHash = hashPhoneNumber(phoneNumber);
    const existingPhone = await this.prisma.user.findFirst({
      where: { OR: [{ phoneNumberHash: phoneHash }, { phoneNumber }] },
    });
    if (existingPhone) {
      throw new ConflictException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Phone number already registered' });
    }

    let referralCodeRecord: { id: string; userId: string; isActive: boolean; totalReferrals: number } | null = null;
    if (dto.referralCode) {
      referralCodeRecord = await this.prisma.referralCode.findUnique({
        where: { code: dto.referralCode.toUpperCase() },
        select: { id: true, userId: true, isActive: true, totalReferrals: true },
      });
      if (!referralCodeRecord || !referralCodeRecord.isActive || referralCodeRecord.totalReferrals >= MAX_REFERRALS) {
        referralCodeRecord = null;
      }
    }

    const userId = generateUserId();
    const myReferralCode = generateReferralCode();

    const encryptedPhone = await encryptPii(phoneNumber);
    const encryptedAddress = dto.address ? await encryptPii(dto.address) : undefined;

    const hashedPassword = await bcryptHash(dto.password, getBcryptRounds());
    const pinPepper = this.getWalletPinPepper();
    const pinDigest = hmacPinDigest(pinPepper, dto.pin);
    const hashedPin = await bcryptHash(pinDigest, getBcryptRounds());

    const registrationTokenKey = TOKEN_BLACKLIST(`phone_register:${payload.jti}`);
    const registrationTokenTtl = Math.max(
      ((payload as TempTokenPayload & { exp?: number }).exp ?? 0) - Math.floor(Date.now() / 1000),
      1,
    );
    const tokenClaimed = await this.redis.setNx(registrationTokenKey, '1', registrationTokenTtl, { throwOnError: true });
    if (!tokenClaimed) {
      throw new UnauthorizedException({ code: ErrorCodes.TEMP_TOKEN_EXPIRED, message: 'Registration token has already been used. Please verify your phone number again.' });
    }

    let user: { id: string; userId: string; phoneNumber: string; fullName: string; email: string | null };
    try {
      user = await this.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
        const newUser = await tx.user.create({
          data: {
            userId,
            phoneNumber: encryptedPhone,
            phoneNumberHash: phoneHash,
            phoneVerified: true,
            email: normalizedEmail,
            emailVerified: false,
            password: hashedPassword,
            passwordChangedAt: new Date(),
            fullName: dto.fullName,
            username: normalizedUsername,
            dateOfBirth: new Date(dto.dateOfBirth + 'T00:00:00Z'),
            gender: dto.gender as Gender,
            ...(encryptedAddress ? { address: encryptedAddress } : {}),
          },
        });

        await tx.wallet.create({ data: { userId: newUser.id, walletPinHash: hashedPin } });
        await tx.notificationPreference.create({ data: { userId: newUser.id } });
        await tx.referralCode.create({ data: { userId: newUser.id, code: myReferralCode } });

        if (referralCodeRecord) {
          const codeUpdated = await tx.referralCode.updateMany({
            where: { id: referralCodeRecord.id, isActive: true, totalReferrals: { lt: MAX_REFERRALS } },
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
      }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
    } catch (err: unknown) {
      // The token was claimed before the transaction to prevent concurrent replay.
      // Release it only when registration did not commit, so a transient or
      // duplicate input can be corrected without requesting another OTP.
      await this.redis.del(registrationTokenKey).catch((releaseErr) => {
        this.logger.warn(`Failed to release registration token claim: ${releaseErr instanceof Error ? releaseErr.message : String(releaseErr)}`);
      });
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        const target = (err.meta?.target as string[]) ?? [];
        if (target.includes('userId')) {
          throw new InternalServerErrorException({ code: 'TRANSIENT_CONFLICT', message: 'Registration failed due to a transient conflict. Please try again.' });
        }
        if (target.includes('username')) {
          throw new BadRequestException({ code: ErrorCodes.USERNAME_TAKEN, message: 'Username is already taken' });
        }
        if (target.includes('phoneNumber')) {
          throw new ConflictException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Phone number already registered' });
        }
        if (target.includes('email')) {
          throw new ConflictException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Email already registered' });
        }
      }
      throw err;
    }

    // Fire-and-forget: failures to enqueue the verification email must not fail
    // registration — the user can always resend via /auth/resend-verification.
    this.sendVerificationEmail(user.id, normalizedEmail, ipAddress).catch((err: unknown) => {
      this.logger.warn(`sendVerificationEmail failed for new user ${user.id}: ${err instanceof Error ? err.message : err}`);
    });

    const refreshToken = this.tokenService.signRefreshToken({ sub: user.id });
    const sessionId = await this.saveSession(user.id, refreshToken, deviceId, deviceInfo, ipAddress);

    if (deviceId) {
      await this.trackDevice(user.id, deviceId, deviceInfo, ipAddress)
        .catch(err => this.logger.error('trackDevice failed in phoneRegister()', err));
    }

    const accessToken = this.tokenService.signAccessToken({
      sub: user.id,
      userId: user.userId,
      email: normalizedEmail,
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

    return {
      accessToken,
      refreshToken,
      user: {
        id: user.id,
        userId: user.userId,
        username: normalizedUsername,
        email: normalizedEmail,
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
        phoneNumber: phoneNumber,
        phoneVerified: true,
        dateOfBirth: dto.dateOfBirth,
        gender: dto.gender,
        createdAt: new Date().toISOString(),
      },
    };
  }

  // ─────────────────────────────────────────────────────────────────
  // SET USERNAME
  // ─────────────────────────────────────────────────────────────────
  async setUsername(userId: string, username: string): Promise<{ user: Record<string, unknown> }> {
    const normalizedUsername = username.trim().toLowerCase();
    if (normalizedUsername.length < 3 || normalizedUsername.length > 30) {
      throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Username must be between 3 and 30 characters' });
    }
    if (!/^[a-z0-9][a-z0-9._-]*[a-z0-9]$/.test(normalizedUsername) && normalizedUsername.length > 2) {
      throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Username must start and end with a letter or number, and can only contain letters, numbers, dots, underscores, and hyphens' });
    }
    if (/[._-]{2,}/.test(normalizedUsername)) {
      throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Username cannot contain consecutive special characters' });
    }

    if (RESERVED_USERNAMES.includes(normalizedUsername)) {
      throw new BadRequestException({ code: ErrorCodes.USERNAME_RESERVED, message: 'Username is already taken' });
    }

    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      throw new NotFoundException({ code: ErrorCodes.USER_NOT_FOUND, message: 'User not found' });
    }

    if (user.username) {
      throw new BadRequestException({ code: ErrorCodes.USERNAME_ALREADY_SET, message: 'Username is already set and cannot be changed' });
    }

    try {
      const updated = await this.prisma.user.update({
        where: { id: userId },
        data: { username: normalizedUsername },
        select: {
          id: true, userId: true, username: true, email: true, fullName: true,
          bio: true, avatarUrl: true, accountType: true, emailVerified: true,
          kycStatus: true, isKahadePlus: true, subscriptionExpiresAt: true,
          membershipRank: true, isActive: true, isBanned: true, createdAt: true,
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
        throw new BadRequestException({ code: ErrorCodes.USERNAME_TAKEN, message: 'Username is already taken' });
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

    type VerifyResult = { ok: true } | { ok: false; reason: 'otp_invalid' | 'user_not_found' | 'account_inactive' };

    const result: VerifyResult = await this.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      const user = await tx.user.findUnique({
        where: { email: normalizedEmail },
        select: { id: true, isActive: true, isBanned: true },
      });
      if (!user) {
        throw new NotFoundException({ code: ErrorCodes.USER_NOT_FOUND, message: 'User not found' });
      }
      if (!user.isActive || user.isBanned) {
        throw new ForbiddenException({ code: ErrorCodes.ACCOUNT_INACTIVE, message: 'Account is inactive or banned' });
      }
      const record = await tx.otpCode.findFirst({
        where: { email: normalizedEmail, type: OtpType.EMAIL_VERIFICATION, isUsed: false, expiresAt: { gt: now }, attempts: { lt: OTP_MAX_ATTEMPTS } },
        orderBy: { createdAt: 'desc' },
      });

      if (!record) {
        return { ok: false, reason: 'otp_invalid' } as const;
      }

      const bump = await tx.otpCode.updateMany({
        where: { id: record.id, isUsed: false, expiresAt: { gt: now }, attempts: { lt: OTP_MAX_ATTEMPTS } },
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
        throw new ForbiddenException({ code: ErrorCodes.ACCOUNT_INACTIVE, message: 'Account is inactive or banned' });
      }

      return { ok: true } as const;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });

    if (!result.ok) {
      throw new BadRequestException({ code: ErrorCodes.OTP_INVALID, message: 'Invalid or expired verification code' });
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
  async correctEmail(userId: string, newEmail: string, password: string, mfaCode?: string, ipAddress?: string): Promise<{ message: string }> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException({ code: ErrorCodes.USER_NOT_FOUND, message: 'User not found' });

    if (user.emailVerified) {
      throw new BadRequestException({
        code: 'EMAIL_ALREADY_VERIFIED',
        message: 'Email is already verified and cannot be changed through this endpoint.',
      });
    }

    if (!user.password) {
      throw new BadRequestException({ code: ErrorCodes.PASSWORD_WRONG, message: 'Password login is not configured for this account' });
    }
    const isPasswordValid = await bcryptCompare(password, user.password);
    if (!isPasswordValid) {
      throw new BadRequestException({ code: ErrorCodes.PASSWORD_WRONG, message: 'Password is incorrect' });
    }

    const normalizedNew = newEmail.toLowerCase();

    const existing = await this.prisma.user.findUnique({ where: { email: normalizedNew }, select: { id: true } });
    if (existing && existing.id !== userId) {
      throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Unable to update email address' });
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
      }).catch((err) => {
        this.logger.error(`[SECURITY] Failed to notify old email about email change for user ${userId}: ${(err as Error).message}`);
        this.createSecurityNotification(
          userId,
          'Email Address Changed',
          `Your email address was changed to ${normalizedNew}. If you did not make this change, please contact support immediately.`,
        ).catch((notifErr) => {
          this.logger.error(`[SECURITY] Failed to create fallback notification for email change: ${(notifErr as Error).message}`);
        });
      });
    }

    const emailChangedSessionIds = await this.prisma.$transaction(async (tx) => {
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
      return sessions.map((s) => s.id);
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    await this.revokeSessionsInRedis(emailChangedSessionIds).catch((err: unknown) => {
      this.logger.warn(`[SECURITY] Email change persisted but Redis session propagation is unavailable: ${err instanceof Error ? err.message : String(err)}`);
    });

    await this.sendVerificationEmail(userId, normalizedNew, ipAddress);

    return { message: 'Email address updated. A verification code has been sent to the new address. Please log in again.' };
  }

  // ─────────────────────────────────────────────────────────────────
  // FORGOT PASSWORD
  // ─────────────────────────────────────────────────────────────────
  async forgotPassword(email: string, ipAddress?: string): Promise<{ message: string }> {
    const normalizedEmail = email.toLowerCase();

    if (ipAddress) {
      const ipRateLimitKey = `forgot_password_ip_rate:${ipAddress}`;
      const ipRequestCount = await this.redis.incr(ipRateLimitKey);
      if (ipRequestCount === 1) await this.redis.expire(ipRateLimitKey, 3600);
      if (ipRequestCount > 5) {
        return { message: 'If this email exists, a password reset code has been sent.' };
      }
    }

    const rateLimitKey = `forgot_password_rate:${normalizedEmail}`;
    const requestCount = await this.redis.incr(rateLimitKey);
    if (requestCount === 1) await this.redis.expire(rateLimitKey, 3600);
    if (requestCount > 3) {
      return { message: 'If this email exists, a password reset code has been sent.' };
    }

    const user = await this.prisma.user.findUnique({ where: { email: normalizedEmail } });

    if (user && user.isActive && !user.isBanned) {
      try {
        await this.otpService.invalidateOtps(normalizedEmail, OtpType.PASSWORD_RESET);
        const otp = await this.otpService.generateOtp(normalizedEmail, OtpType.PASSWORD_RESET, user.id, undefined, ipAddress);
        await this.sendPasswordResetEmail(normalizedEmail, otp);
      } catch (error) {
        this.logger.warn(`forgotPassword OTP generation suppressed: ${error instanceof Error ? error.message : error}`);
      }
    }

    return { message: 'If this email exists, a password reset code has been sent.' };
  }

  // ─────────────────────────────────────────────────────────────────
  // RESET PASSWORD
  // ─────────────────────────────────────────────────────────────────
  async resetPassword(email: string, otp: string, newPassword: string, confirmPassword: string): Promise<{ message: string }> {
    if (newPassword !== confirmPassword) {
      throw new BadRequestException({
        code: ErrorCodes.PASSWORDS_DO_NOT_MATCH,
        message: 'Passwords do not match',
      });
    }

    validatePasswordComplexity(newPassword);

    const normalizedEmail = email.toLowerCase();
    const user = await this.prisma.user.findUnique({ where: { email: normalizedEmail } });
    if (!user) {
      throw new NotFoundException({ code: ErrorCodes.USER_NOT_FOUND, message: 'User not found' });
    }

    if (!user.isActive) {
      throw new ForbiddenException({ code: ErrorCodes.ACCOUNT_INACTIVE, message: 'Account is inactive' });
    }
    if (user.isBanned) {
      throw new ForbiddenException({ code: ErrorCodes.ACCOUNT_BANNED, message: 'Account has been banned' });
    }

    const isSamePassword = user.password ? await bcryptCompare(newPassword, user.password) : false;
    if (isSamePassword) {
      throw new BadRequestException({ code: ErrorCodes.PASSWORD_SAME_AS_OLD, message: 'New password cannot be the same as your current password' });
    }

    const recentPasswords = await this.prisma.passwordHistory.findMany({
      where: { userId: user.id },
      orderBy: { createdAt: 'desc' },
      take: 5,
    });
    for (const historical of recentPasswords) {
      const isReused = await bcryptCompare(newPassword, historical.passwordHash);
      if (isReused) {
        throw new BadRequestException({
          code: ErrorCodes.PASSWORD_RECENTLY_USED,
          message: 'New password cannot be the same as one of your last 5 passwords',
        });
      }
    }

    // Do not consume the recovery factor until every deterministic account and
    // password-policy check has passed. A user who mistypes a disallowed new
    // password should be able to correct it without requesting another OTP.
    const isValid = await this.otpService.verifyOtp(normalizedEmail, OtpType.PASSWORD_RESET, otp);
    if (!isValid) {
      throw new BadRequestException({ code: ErrorCodes.OTP_INVALID, message: 'Invalid or expired reset code' });
    }

    const hashedPassword = await bcryptHash(newPassword, getBcryptRounds());

    const resetSessionIds = await this.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
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
      // turn a reset into a 500. Both current registration paths always set a
      // password, so this is unreachable today — but the same null case is already
      // guarded at the isSamePassword check above, and a future passwordless path
      // (social login) would otherwise land here. Skip history when there is no
      // previous password to record.
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
      return sessions.map((s) => s.id);
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });

    await this.revokeSessionsInRedis(resetSessionIds).catch((err: unknown) => {
      this.logger.warn(`[SECURITY] Password reset persisted but Redis session propagation is unavailable: ${err instanceof Error ? err.message : String(err)}`);
    });

    // Fire-and-forget: dispatchEmail already logs the error before rethrowing;
    // we swallow the rejection here because this is a post-action confirmation
    // and must not retroactively fail the password-reset flow.
    this.dispatchEmail({
      to: normalizedEmail,
      subject: 'Kahade - Your Password Has Been Reset',
      templateName: 'password-reset-confirm',
      templateContext: {},
    }).catch(() => undefined);
    this.createSecurityNotification(
      user.id,
      'Password Reset',
      'Your password was reset and every active session and trusted device was signed out. If this was not you, contact support immediately.',
    ).catch(() => undefined);

    this.auditLog.logUserAction({
      userId: user.id,
      action: UserAuditAction.PASSWORD_RESET,
      entityType: 'User',
      entityId: user.id,
      description: 'Password reset via email OTP',
    });

    return { message: 'Password reset successfully. Please log in again.' };
  }

  // ─────────────────────────────────────────────────────────────────
  // LOGIN
  // ─────────────────────────────────────────────────────────────────
  async login(
    dto: { email: string; password: string; deviceId: string; deviceInfo?: string },
    ipAddress: string,
  ): Promise<LoginResult> {
    const LOGIN_IP_KEY = `login_ip_rate:${ipAddress}`;
    const ipAttempts = await this.redis.incr(LOGIN_IP_KEY);
    if (ipAttempts === 1) await this.redis.expire(LOGIN_IP_KEY, 900);
    if (ipAttempts > 20) {
      throw new HttpException(
        { code: ErrorCodes.TOO_MANY_REQUESTS, message: 'Too many login attempts. Please try again later.' },
        429,
      );
    }

    const loginStart = Date.now();
    const normalizedEmail = dto.email.trim().toLowerCase();
    const user = await this.prisma.user.findUnique({ where: { email: normalizedEmail } });

    if (!user) {
      const fallbackHash = _dummyHash || '$2b$12$K4GH.2PFn0b3bVkYe3klq.ScFT2MXqHWMzIxB/yLc8A7EEpzlJxHy';
      await bcryptCompare(dto.password, fallbackHash);
      const elapsed = Date.now() - loginStart;
      const pad = Math.max(0, 250 - elapsed) + _cryptoRandomInt(50, 200);
      await new Promise(r => setTimeout(r, pad));
      throw new UnauthorizedException({ code: ErrorCodes.INVALID_CREDENTIALS, message: 'Invalid credentials' });
    }

    // Always run bcryptCompare before any status checks to prevent timing side-channels.
    // Without this, an attacker can distinguish "inactive account" (~1ms) from "wrong password" (~100ms)
    // revealing that the account exists and its status — even before a password is submitted.
    const isPasswordValid = user.password ? await bcryptCompare(dto.password, user.password) : false;

    if (!user.isActive || user.isBanned) {
      throw new UnauthorizedException({ code: ErrorCodes.INVALID_CREDENTIALS, message: 'Invalid credentials' });
    }

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
      const updated = await this.prisma.user.update({
        where: { id: user.id },
        data: { failedLoginAttempts: { increment: 1 } },
        select: { failedLoginAttempts: true },
      });
      if (updated.failedLoginAttempts >= ACCOUNT_LOCK_MAX_ATTEMPTS) {
        let cycleCount = 1;
        try {
          const lockoutCycleKey = `lockout_cycles:${user.id}`;
          cycleCount = await this.redis.incr(lockoutCycleKey);
          if (cycleCount === 1) {
            await this.redis.expire(lockoutCycleKey, 7 * 24 * 3600);
          }
        } catch (redisErr) {
          this.logger.warn(`[AUTH] Redis unavailable for lockout cycle tracking (user: ${user.id}), falling back to base lockout`, redisErr);
          cycleCount = 1;
        }
        const maxCycles = this.configService.get<number>('app.accountLockMaxCycles') ?? 5;
        if (cycleCount >= maxCycles) {
          await this.prisma.user.update({
            where: { id: user.id },
            data: { isActive: false, failedLoginAttempts: 0 },
          });
          const lockedSessionIds = await this.prisma.$transaction(async (tx) => {
            const sessions = await tx.userSession.findMany({
              where: { userId: user.id, isRevoked: false },
              select: { id: true },
            });
            await tx.userSession.updateMany({
              where: { userId: user.id, isRevoked: false },
              data: { isRevoked: true, revokedAt: new Date(), revokedReason: 'account_permanently_locked' },
            });
            return sessions.map((session) => session.id);
          }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
          await this.revokeSessionsInRedis(lockedSessionIds).catch((err) => {
            this.logger.error(`[AUTH] Failed to blacklist sessions after permanent lockout for user ${user.id}: ${err instanceof Error ? err.message : String(err)}`);
          });
          this.notifyAccountLocked(user.id, user.email ?? '', ipAddress).catch((err) => {
            this.logger.error('[AUTH] Failed to send permanent lockout notification', err);
          });
          throw new UnauthorizedException({ code: ErrorCodes.ACCOUNT_LOCKED, message: 'Account has been permanently locked due to repeated failed attempts. Contact support.' });
        }
        const baseDuration = ACCOUNT_LOCK_DURATION_MINUTES;
        const progressiveDuration = baseDuration * Math.pow(2, cycleCount - 1);
        await this.prisma.user.update({
          where: { id: user.id },
          data: { failedLoginAttempts: 0, lockedUntil: addMinutes(new Date(), progressiveDuration) },
        });
        this.notifyAccountLocked(user.id, user.email ?? '', ipAddress).catch((err) => {
          this.logger.error('[AUTH] Failed to send account lockout notification', err);
        });
      }
      throw new UnauthorizedException({ code: ErrorCodes.INVALID_CREDENTIALS, message: 'Invalid credentials' });
    }

    // Do not reset lockout counters here; verify2faLogin() re-checks and clears them
    // after the second factor succeeds so a tempToken cannot bypass a concurrent lockout.
    const twoFactorAuth = await this.prisma.twoFactorAuth.findUnique({ where: { userId: user.id } });
    if (twoFactorAuth?.isEnabled) {
      let skipTwoFa = false;
      if (dto.deviceId) {
        const trustedDevice = await this.prisma.userDevice.findFirst({
          where: { userId: user.id, deviceId: dto.deviceId, isTrusted: true },
        });
        if (trustedDevice?.trustedAt) {
          const trustExpiryMs = (this.configService.get<number>('app.trustedDeviceDays') ?? 30) * 24 * 60 * 60 * 1000;
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
        const tempToken = this.tokenService.signTempToken({ sub: user.id, scope: '2fa_verify', deviceId: dto.deviceId });
        return { requires2FA: true, tempToken };
      }
    }

    const lockoutCycleKey = `lockout_cycles:${user.id}`;
    await this.redis.del(lockoutCycleKey).catch((err) => this.logger.warn(`silent-catch: ${err instanceof Error ? err.message : String(err)}`));
    const updateData: Record<string, unknown> = { failedLoginAttempts: 0, lockedUntil: null, lastLoginAt: new Date(), lastLoginIp: ipAddress };

    const storedRounds = user.password ? this.extractBcryptRounds(user.password) : 0;
    if (storedRounds > 0 && storedRounds < getBcryptRounds()) {
      updateData.password = await bcryptHash(dto.password, getBcryptRounds());
      updateData.passwordChangedAt = new Date();
      this.logger.log(`[CRY-020] Upgraded password hash rounds from ${storedRounds} to ${getBcryptRounds()} for user ${user.id}`);
    }

    await this.prisma.user.update({
      where: { id: user.id },
      data: updateData,
    });

    const refreshToken = this.tokenService.signRefreshToken({ sub: user.id });
    const sessionId = await this.saveSession(user.id, refreshToken, dto.deviceId, dto.deviceInfo, ipAddress);

    if (dto.deviceId) {
      await this.trackDevice(user.id, dto.deviceId, dto.deviceInfo, ipAddress)
        .catch(err => this.logger.error('trackDevice failed in login()', err));
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

  // ─────────────────────────────────────────────────────────────────
  // VERIFY 2FA LOGIN
  // ─────────────────────────────────────────────────────────────────
  async verify2faLogin(tempToken: string, code: string, deviceId: string, deviceInfo: string, ipAddress: string): Promise<{ accessToken: string; refreshToken: string; user: LoginUserPayload }> {
    let payload: TempTokenPayload;
    try {
      payload = this.tokenService.verifyTempToken(tempToken);
    } catch {
      throw new UnauthorizedException({ code: ErrorCodes.TEMP_TOKEN_EXPIRED, message: 'Temp token expired' });
    }

    if (payload.scope !== '2fa_verify') {
      throw new UnauthorizedException({ code: ErrorCodes.UNAUTHORIZED, message: 'Invalid token scope' });
    }

    // Guard against temp-token replay: reject if the JTI has already been consumed
    // (blacklisted after a successful 2FA login). Without this check, an attacker
    // who intercepts a temp token could reuse it within the 5-minute expiry window
    // with a different TOTP code from the next 30-second period.
    if (!payload.jti) {
      throw new UnauthorizedException({ code: ErrorCodes.TEMP_TOKEN_EXPIRED, message: 'Invalid temp token — missing jti claim' });
    }
    if (!payload.deviceId || payload.deviceId !== deviceId) {
      throw new UnauthorizedException({ code: ErrorCodes.TEMP_TOKEN_EXPIRED, message: 'Temp token is not valid for this device. Please log in again.' });
    }
    const alreadyConsumed = await this.redis.get(TOKEN_BLACKLIST(payload.jti), { throwOnError: true });
    if (alreadyConsumed) {
      throw new UnauthorizedException({ code: ErrorCodes.TEMP_TOKEN_EXPIRED, message: 'Temp token has already been used. Please log in again.' });
    }

    const userId = payload.sub;

    const attemptKey = TWO_FA_ATTEMPT_KEY(userId);
    const attempts = await this.redis.incr(attemptKey);
    if (attempts === 1) {
      await this.redis.expire(attemptKey, 5 * 60);
    }
    if (attempts > TWO_FA_MAX_ATTEMPTS) {
      throw new ForbiddenException({ code: ErrorCodes.TOO_MANY_REQUESTS, message: 'Too many 2FA attempts. Please log in again.' });
    }

    // Enforce lockout before TOTP: account may have been locked after tempToken was issued.
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      throw new NotFoundException({ code: ErrorCodes.USER_NOT_FOUND, message: 'User not found' });
    }
    if (!user.isActive) {
      throw new ForbiddenException({ code: ErrorCodes.ACCOUNT_INACTIVE, message: 'Account is inactive' });
    }
    if (user.isBanned) {
      throw new ForbiddenException({ code: ErrorCodes.ACCOUNT_BANNED, message: 'Account has been banned' });
    }

    const twoFactorAuth = await this.prisma.twoFactorAuth.findUnique({ where: { userId } });

    if (!twoFactorAuth?.isEnabled) {
      throw new BadRequestException({ code: ErrorCodes.TWO_FA_NOT_ENABLED, message: '2FA not enabled' });
    }

    if (!twoFactorAuth.secret) {
      throw new BadRequestException({ code: ErrorCodes.TWO_FA_NOT_ENABLED, message: '2FA secret is missing, please re-setup 2FA' });
    }

    let decryptedSecret: string;
    try {
      decryptedSecret = await decryptAES(twoFactorAuth.secret);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      this.logger.error(`[2FA] Failed to decrypt TOTP secret for user ${userId}: ${errMsg}`);
      throw new InternalServerErrorException({ code: ErrorCodes.INTERNAL_SERVER_ERROR, message: 'Unable to verify 2FA code. Please try again or contact support.' });
    }
    // Always run TOTP verify regardless of lockout — constant-time path
    const totpVerified = speakeasy.totp.verify({ secret: decryptedSecret, encoding: 'base32', token: code, window: 1 });

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
        throw new BadRequestException({ code: ErrorCodes.INVALID_2FA_CODE, message: 'Invalid 2FA code' });
      }
      usedBackupCode = true;
    }

    if (usedBackupCode) {
      this.notifyBackupCodeUsed(userId).catch((err) => {
        this.logger.error('[2FA] Failed to send backup code usage notification', err);
      });
    } else {
      const hmacSecret = this.configService.get<string>('crypto.hmacSecretKey') || this.configService.get<string>('jwt.secret') || '';
      const codeHash = sha256(hmacSecret + ':totp:' + code);
      const totpUsedKey = TOTP_USED_CODE(userId);
      const client = this.redis.getClient();
      const redisKey = `${this.redis.getPrefix()}${totpUsedKey}`;
      const wasAdded = await client.sadd(redisKey, codeHash);
      if (wasAdded === 0) {
        throw new BadRequestException({ code: ErrorCodes.INVALID_2FA_CODE, message: 'TOTP code already used. Wait for the next code.' });
      }
      await client.expire(redisKey, 90);
    }

    // Clear the attempt counter on successful login
    await this.redis.del(attemptKey);

    const jwtExp = (payload as unknown as { exp?: number }).exp;
    const tempTtlSeconds = jwtExp ? Math.max(jwtExp - Math.floor(Date.now() / 1000), 0) + 60 : this.getTempTokenTtlSeconds() + 60;
    await this.redis.setex(TOKEN_BLACKLIST(payload.jti), tempTtlSeconds, '1', { throwOnError: true });

    const lockoutCycleKey2fa = `lockout_cycles:${user.id}`;
    await this.redis.del(lockoutCycleKey2fa).catch((err) => this.logger.warn(`silent-catch: ${err instanceof Error ? err.message : String(err)}`));
    await this.prisma.user.update({
      where: { id: user.id },
      data: { failedLoginAttempts: 0, lockedUntil: null, lastLoginAt: new Date(), lastLoginIp: ipAddress },
    });

    const refreshToken = this.tokenService.signRefreshToken({ sub: user.id });
    const sessionId = await this.saveSession(user.id, refreshToken, deviceId, deviceInfo, ipAddress);

    await this.trackDevice(user.id, deviceId, deviceInfo, ipAddress)
      .catch(err => this.logger.error('trackDevice failed in verify2faLogin()', err));

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
        subscriptionExpiresAt: user.subscriptionExpiresAt ? user.subscriptionExpiresAt.toISOString() : null,
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
  async refreshToken(refreshToken: string): Promise<{ accessToken: string; refreshToken: string }> {
    let payload: RefreshTokenPayload;
    try {
      payload = this.tokenService.verifyRefreshToken(refreshToken);
    } catch {
      throw new UnauthorizedException({ code: ErrorCodes.UNAUTHORIZED, message: 'Invalid or expired refresh token' });
    }

    const session = await this.prisma.userSession.findUnique({
      where: { jti: payload.jti },
    });

    if (!session || session.isRevoked || session.expiresAt < new Date()) {
      throw new UnauthorizedException({ code: ErrorCodes.SESSION_REVOKED, message: 'Session has been revoked' });
    }
    if (session.userId !== payload.sub) {
      this.logger.error(`[SECURITY] Refresh session owner mismatch for session ${session.id}`);
      throw new UnauthorizedException({ code: ErrorCodes.UNAUTHORIZED, message: 'Invalid refresh token' });
    }

    const incomingTokenHash = sha256(refreshToken);
    const isTokenValid = await bcryptCompare(incomingTokenHash, session.refreshToken);
    if (!isTokenValid) {
      const reuseSessionIds = await this.prisma.$transaction(async (tx) => {
        const sessions = await tx.userSession.findMany({
          where: { userId: session.userId, isRevoked: false },
          select: { id: true },
        });
        await tx.userSession.updateMany({
          where: { userId: session.userId, isRevoked: false },
          data: { isRevoked: true, revokedAt: new Date(), revokedReason: 'token_reuse_detected' },
        });
        return sessions.map((s) => s.id);
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
      await this.revokeSessionsInRedis(reuseSessionIds);
      this.logger.warn(`[SECURITY] Possible refresh token theft detected for session ${session.id}. All sessions revoked.`);
      this.notifyRefreshTokenReuse(session.userId).catch((err) => {
        this.logger.error('[SECURITY] Failed to notify user about refresh token reuse', err);
      });
      throw new UnauthorizedException({ code: ErrorCodes.UNAUTHORIZED, message: 'Invalid refresh token. All sessions revoked for security.' });
    }

    const user = await this.prisma.user.findUnique({ where: { id: payload.sub } });
    if (!user || !user.isActive || user.isBanned) {
      throw new UnauthorizedException({ code: ErrorCodes.UNAUTHORIZED, message: 'Invalid refresh token' });
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

    const tokenHash = sha256(newRefreshToken);
    const hashedRefreshToken = await bcryptHash(tokenHash, getBcryptRounds());

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
      throw new UnauthorizedException({ code: ErrorCodes.SESSION_REVOKED, message: 'Session already refreshed. Please retry.' });
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
  async logout(userId: string, sessionId: string, accessTokenJti: string, logoutAll: boolean): Promise<{ message: string }> {
    const jwtTtlSeconds = this.getAccessTokenTtlSeconds();
    let revokedSessionIds: string[] = [];

    if (logoutAll) {
      const logoutAllIds = await this.prisma.$transaction(async (tx) => {
        const sessions = await tx.userSession.findMany({
          where: { userId, isRevoked: false },
          select: { id: true },
        });
        await tx.userSession.updateMany({
          where: { userId, isRevoked: false },
          data: { isRevoked: true, revokedAt: new Date(), revokedReason: 'logout_all' },
        });
        return sessions.map((s) => s.id);
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
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
      redisRevocations.push(this.redis.setex(TOKEN_BLACKLIST(accessTokenJti), jwtTtlSeconds, '1', { throwOnError: true }));
    }
    if (revokedSessionIds.length) redisRevocations.push(this.revokeSessionsInRedis(revokedSessionIds));
    if (redisRevocations.length) {
      await Promise.all(redisRevocations).catch((err: unknown) => {
        this.logger.warn(`[SECURITY] Logout completed with Redis revocation propagation unavailable: ${err instanceof Error ? err.message : String(err)}`);
      });
    }

    return { message: 'Logout successful' };
  }

  // ─────────────────────────────────────────────────────────────────
  // VERIFY PASSWORD (for app lock / forgot-PIN flow)
  // ─────────────────────────────────────────────────────────────────
  async verifyPassword(userId: string, password: string): Promise<{ verified: boolean }> {
    const VERIFY_PW_KEY = `verify_pw_rate:${userId}`;
    const attempts = await this.redis.incr(VERIFY_PW_KEY);
    if (attempts === 1) await this.redis.expire(VERIFY_PW_KEY, 900);
    if (attempts > 10) {
      throw new HttpException(
        { code: ErrorCodes.TOO_MANY_REQUESTS, message: 'Too many password verification attempts. Please wait before trying again.' },
        429,
      );
    }

    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { password: true } });
    if (!user) {
      throw new NotFoundException({ code: ErrorCodes.USER_NOT_FOUND, message: 'User not found' });
    }
    if (!user.password) {
      throw new BadRequestException({ code: ErrorCodes.CURRENT_PASSWORD_WRONG, message: 'Password login is not configured for this account' });
    }
    const isValid = await bcryptCompare(password, user.password);
    if (!isValid) {
      throw new BadRequestException({ code: ErrorCodes.CURRENT_PASSWORD_WRONG, message: 'Password is incorrect' });
    }
    await this.redis.del(VERIFY_PW_KEY);
    return { verified: true };
  }

  // ─────────────────────────────────────────────────────────────────
  // CHANGE PASSWORD
  // ─────────────────────────────────────────────────────────────────
  async changePassword(userId: string, dto: ChangePasswordDto, currentAccessTokenJti?: string, _currentSessionId?: string): Promise<{ message: string }> {
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
      throw new BadRequestException({ code: ErrorCodes.CURRENT_PASSWORD_WRONG, message: 'Password login is not configured for this account' });
    }
    const isValidPw = await bcryptCompare(dto.currentPassword, user.password);
    if (!isValidPw) {
      throw new BadRequestException({ code: ErrorCodes.CURRENT_PASSWORD_WRONG, message: 'Current password is incorrect' });
    }
    validatePasswordComplexity(dto.newPassword);

    const isSamePassword = await bcryptCompare(dto.newPassword, user.password);
    if (isSamePassword) {
      throw new BadRequestException({ code: ErrorCodes.PASSWORD_SAME_AS_OLD, message: 'New password cannot be the same as old password' });
    }

    const recentPasswords = await this.prisma.passwordHistory.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: 5,
    });
    for (const historical of recentPasswords) {
      const isReused = await bcryptCompare(dto.newPassword, historical.passwordHash);
      if (isReused) {
        throw new BadRequestException({
          code: ErrorCodes.PASSWORD_RECENTLY_USED,
          message: 'New password cannot be the same as one of your last 5 passwords',
        });
      }
    }

    // Password changes can otherwise turn a stolen password into persistent account
    // takeover. Require the configured second factor only after all password policy
    // checks have passed, so rejected inputs never consume a valid recovery factor.
    await this.verifySensitiveMfa(userId, dto.mfaCode);

    const hashedPassword = await bcryptHash(dto.newPassword, getBcryptRounds());
    const allSessionIds = await this.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
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
      return sessions.map((session) => session.id);
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });

    const jwtTtlSeconds = this.getAccessTokenTtlSeconds();
    const redisRevocations: Promise<unknown>[] = [this.revokeSessionsInRedis(allSessionIds)];
    if (currentAccessTokenJti) {
      redisRevocations.push(this.redis.setex(TOKEN_BLACKLIST(currentAccessTokenJti), jwtTtlSeconds, '1', { throwOnError: true }));
    }
    await Promise.all(redisRevocations).catch((err: unknown) => {
      this.logger.warn(`[SECURITY] Password change persisted but Redis session propagation is unavailable: ${err instanceof Error ? err.message : String(err)}`);
    });

    this.auditLog.logUserAction({
      userId,
      action: UserAuditAction.PASSWORD_CHANGED,
      entityType: 'User',
      entityId: userId,
      description: 'Password changed by user',
    });

    this.createSecurityNotification(userId, 'Password Changed', 'Your password was changed and every active session was signed out. If this was not you, reset your password immediately.').catch(() => undefined);
    if (user.email) {
      this.dispatchEmail({ to: user.email, subject: 'Security Alert: Password Changed', templateName: 'password-changed-notification', templateContext: {} }).catch(() => undefined);
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
  async setup2fa(userId: string, password: string): Promise<{ secret: string; qrCodeUrl: string; otpauthUrl: string; backupCodes: string[] }> {
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
      throw new BadRequestException({ code: ErrorCodes.PASSWORD_WRONG, message: 'Password login is not configured for this account' });
    }
    const isValid = await bcryptCompare(password, user.password);
    if (!isValid) {
      throw new BadRequestException({ code: ErrorCodes.PASSWORD_WRONG, message: 'Password is incorrect' });
    }

    const existing2fa = await this.prisma.twoFactorAuth.findUnique({ where: { userId } });
    if (existing2fa?.isEnabled) {
      throw new BadRequestException({ code: ErrorCodes.TWO_FA_ALREADY_ENABLED, message: '2FA is already enabled' });
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
      throw new BadRequestException({ code: ErrorCodes.TWO_FA_NOT_ENABLED, message: '2FA not set up' });
    }
    if (twoFactorAuth.isEnabled) {
      throw new BadRequestException({ code: ErrorCodes.TWO_FA_ALREADY_ENABLED, message: '2FA is already enabled' });
    }
    if (!twoFactorAuth.secret) {
      throw new BadRequestException({ code: ErrorCodes.TWO_FA_NOT_ENABLED, message: '2FA not properly set up, please re-run setup' });
    }

    const decryptedSecret = await decryptAES(twoFactorAuth.secret);
    const verified = speakeasy.totp.verify({ secret: decryptedSecret, encoding: 'base32', token: code, window: 1 });

    if (!verified) {
      throw new BadRequestException({ code: ErrorCodes.INVALID_2FA_CODE, message: 'Invalid TOTP code' });
    }

    const hmacSecret = this.configService.get<string>('crypto.hmacSecretKey') || this.configService.get<string>('jwt.secret') || '';
    const codeHash = sha256(hmacSecret + ':totp:' + code);
    const totpUsedKey = TOTP_USED_CODE(userId);
    const client = this.redis.getClient();
    const redisKey = `${this.redis.getPrefix()}${totpUsedKey}`;
    const wasAdded = await client.sadd(redisKey, codeHash);
    if (wasAdded === 0) {
      throw new BadRequestException({ code: ErrorCodes.INVALID_2FA_CODE, message: 'TOTP code already used. Wait for the next code.' });
    }
    await client.expire(redisKey, 90);

    const enable2faSessionIds = await this.prisma.$transaction(async (tx) => {
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
      return sessions.map((session) => session.id);
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    await this.revokeSessionsInRedis(enable2faSessionIds).catch((err: unknown) => {
      this.logger.warn(`[SECURITY] 2FA enable persisted but Redis session propagation is unavailable: ${err instanceof Error ? err.message : String(err)}`);
    });

    this.auditLog.logUserAction({
      userId,
      action: UserAuditAction.TWO_FA_ENABLED,
      entityType: 'TwoFactorAuth',
      entityId: userId,
      description: '2FA enabled by user',
    });

    this.createSecurityNotification(userId, 'Two-Factor Authentication Enabled', 'Two-factor authentication was enabled and all active sessions were signed out.').catch(() => undefined);
    const securityUser = await this.prisma.user.findUnique({ where: { id: userId }, select: { email: true } });
    if (securityUser?.email) {
      this.dispatchEmail({ to: securityUser.email, subject: 'Security Alert: 2FA Enabled', templateName: 'two-fa-enabled-notification', templateContext: {} }).catch(() => undefined);
    }

    return { message: '2FA enabled successfully. All sessions have been revoked. Please log in again.' };
  }

  // ─────────────────────────────────────────────────────────────────
  // DISABLE 2FA
  // ─────────────────────────────────────────────────────────────────
  async disable2fa(userId: string, password: string, code: string, emailOtpCode: string): Promise<{ message: string }> {
    const disable2faRateKey = `disable_2fa_rate:${userId}`;
    const disable2faAttempts = await this.redis.incr(disable2faRateKey);
    if (disable2faAttempts === 1) await this.redis.expire(disable2faRateKey, 900);
    if (disable2faAttempts > 5) {
      throw new HttpException(
        { code: ErrorCodes.TOO_MANY_REQUESTS, message: 'Too many attempts. Please wait before trying again.' },
        429,
      );
    }

    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      throw new NotFoundException({ code: ErrorCodes.USER_NOT_FOUND, message: 'User not found' });
    }
    if (!user.isActive) {
      throw new ForbiddenException({ code: ErrorCodes.ACCOUNT_INACTIVE, message: 'Account is inactive' });
    }
    if (user.isBanned) {
      throw new ForbiddenException({ code: ErrorCodes.ACCOUNT_BANNED, message: 'Account has been banned' });
    }

    if (!user.password) {
      throw new BadRequestException({ code: ErrorCodes.CURRENT_PASSWORD_WRONG, message: 'Password login is not configured for this account' });
    }
    const isPasswordValid = user.password ? await bcryptCompare(password, user.password) : false;
    if (!isPasswordValid) {
      throw new BadRequestException({ code: ErrorCodes.CURRENT_PASSWORD_WRONG, message: 'Password is incorrect' });
    }

    const twoFactorAuth = await this.prisma.twoFactorAuth.findUnique({ where: { userId } });

    if (!twoFactorAuth?.isEnabled) {
      throw new BadRequestException({ code: ErrorCodes.TWO_FA_NOT_ENABLED, message: '2FA is not enabled' });
    }
    if (!twoFactorAuth.secret) {
      throw new BadRequestException({ code: ErrorCodes.TWO_FA_NOT_ENABLED, message: '2FA secret is missing, please re-setup 2FA' });
    }

    // Same nullable-email cross-account risk described in requestDisable2faOtp
    // (above). A phone-only account has no email; reject the second factor early
    // rather than checking against the shared '' OTP bucket.
    if (!user.email) {
      throw new BadRequestException({
        code: 'EMAIL_NOT_CONFIGURED',
        message: 'Your account has no email address to verify OTP against. Please add an email or contact support.',
      });
    }

    const isOtpValid = await this.otpService.verifyOtp(user.email, OtpType.TWO_FA_DISABLE, emailOtpCode);
    if (!isOtpValid) {
      throw new BadRequestException({ code: ErrorCodes.OTP_INVALID, message: 'Invalid email OTP' });
    }

    const normalizedCode = code.trim().toUpperCase();
    if (this.BACKUP_CODE_PATTERN.test(normalizedCode)) {
      // Recovery codes are a valid replacement for the authenticator, but are
      // consumed only after the separate email factor has been verified.
      const backupCodeValid = await this.checkAndConsumeBackupCode(twoFactorAuth, normalizedCode);
      if (!backupCodeValid) {
        throw new BadRequestException({ code: ErrorCodes.INVALID_2FA_CODE, message: 'Invalid or already used backup code' });
      }
    } else {
      if (!/^\d{6}$/.test(code)) {
        throw new BadRequestException({ code: ErrorCodes.INVALID_2FA_CODE, message: 'Authenticator code must contain exactly six digits' });
      }
      const decryptedSecret = await decryptAES(twoFactorAuth.secret);
      const verified = speakeasy.totp.verify({ secret: decryptedSecret, encoding: 'base32', token: code, window: 1 });
      if (!verified) {
        throw new BadRequestException({ code: ErrorCodes.INVALID_2FA_CODE, message: 'Invalid 2FA code' });
      }

      const hmacSecret = this.configService.get<string>('crypto.hmacSecretKey') || this.configService.get<string>('jwt.secret') || '';
      const codeHash = sha256(hmacSecret + ':totp:' + code);
      const totpUsedKey = TOTP_USED_CODE(userId);
      const client = this.redis.getClient();
      const redisKey = `${this.redis.getPrefix()}${totpUsedKey}`;
      const wasAdded = await client.sadd(redisKey, codeHash);
      if (wasAdded === 0) {
        throw new BadRequestException({ code: ErrorCodes.INVALID_2FA_CODE, message: 'TOTP code already used. Wait for the next code.' });
      }
      await client.expire(redisKey, 90);
    }

    const disable2faSessionIds = await this.prisma.$transaction(async (tx) => {
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
      return sessions.map((s) => s.id);
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    await this.revokeSessionsInRedis(disable2faSessionIds).catch((err: unknown) => {
      this.logger.warn(`[SECURITY] 2FA disable persisted but Redis session propagation is unavailable: ${err instanceof Error ? err.message : String(err)}`);
    });

    this.auditLog.logUserAction({
      userId,
      action: UserAuditAction.TWO_FA_DISABLED,
      entityType: 'TwoFactorAuth',
      entityId: userId,
      description: '2FA disabled by user',
    });

    this.createSecurityNotification(userId, 'Two-Factor Authentication Disabled', 'Two-factor authentication was disabled and all active sessions were signed out. If this was not you, change your password immediately.').catch(() => undefined);
    if (user.email) {
      this.dispatchEmail({ to: user.email, subject: 'Security Alert: 2FA Disabled', templateName: 'two-fa-disabled-notification', templateContext: {} }).catch(() => undefined);
    }

    return { message: '2FA disabled successfully. All sessions have been revoked. Please log in again.' };
  }

  // ─────────────────────────────────────────────────────────────────
  // REGENERATE BACKUP CODES
  // ─────────────────────────────────────────────────────────────────
  async regenerateBackupCodes(userId: string, password: string, code: string): Promise<{ backupCodes: string[] }> {
    const regenRateKey = `regen_backup_rate:${userId}`;
    const regenAttempts = await this.redis.incr(regenRateKey);
    if (regenAttempts === 1) await this.redis.expire(regenRateKey, 900);
    if (regenAttempts > 5) {
      throw new HttpException(
        { code: ErrorCodes.TOO_MANY_REQUESTS, message: 'Too many attempts. Please wait before trying again.' },
        429,
      );
    }

    const regenerationLockKey = `regen_backup_lock:${userId}`;
    const regenerationLockToken = _cryptoRandomBytes(16).toString('hex');
    const acquired = await this.redis.setNx(regenerationLockKey, regenerationLockToken, 30);
    if (!acquired) {
      throw new ConflictException({ code: ErrorCodes.OPTIMISTIC_LOCK_CONFLICT, message: 'Backup code regeneration is already in progress. Please try again.' });
    }

    try {
      const user = await this.prisma.user.findUnique({ where: { id: userId } });
      if (!user) {
        throw new NotFoundException({ code: ErrorCodes.USER_NOT_FOUND, message: 'User not found' });
      }
      if (!user.isActive) {
        throw new ForbiddenException({ code: ErrorCodes.ACCOUNT_INACTIVE, message: 'Account is inactive' });
      }
      if (user.isBanned) {
        throw new ForbiddenException({ code: ErrorCodes.ACCOUNT_BANNED, message: 'Account has been banned' });
      }
      if (!user.password) {
        throw new BadRequestException({ code: ErrorCodes.PASSWORD_WRONG, message: 'Password login is not configured for this account' });
      }
      const isValid = await bcryptCompare(password, user.password);
      if (!isValid) {
        throw new BadRequestException({ code: ErrorCodes.PASSWORD_WRONG, message: 'Password is incorrect' });
      }

      const twoFactorAuth = await this.prisma.twoFactorAuth.findUnique({ where: { userId } });
      if (!twoFactorAuth?.isEnabled || !twoFactorAuth.secret) {
        throw new BadRequestException({ code: ErrorCodes.TWO_FA_NOT_ENABLED, message: '2FA is not enabled or requires setup again' });
      }
      if (!/^\d{6}$/.test(code)) {
        throw new BadRequestException({ code: ErrorCodes.INVALID_2FA_CODE, message: 'Authenticator code must contain exactly six digits' });
      }

      const decryptedSecret = await decryptAES(twoFactorAuth.secret);
      const verified = speakeasy.totp.verify({ secret: decryptedSecret, encoding: 'base32', token: code, window: 1 });
      if (!verified) {
        throw new BadRequestException({ code: ErrorCodes.INVALID_2FA_CODE, message: 'Invalid 2FA code' });
      }

      const hmacSecret = this.configService.get<string>('crypto.hmacSecretKey') || this.configService.get<string>('jwt.secret') || '';
      const codeHash = sha256(hmacSecret + ':totp:' + code);
      const totpUsedKey = TOTP_USED_CODE(userId);
      const client = this.redis.getClient();
      const redisKey = `${this.redis.getPrefix()}${totpUsedKey}`;
      const wasAdded = await client.sadd(redisKey, codeHash);
      if (wasAdded === 0) {
        throw new BadRequestException({ code: ErrorCodes.INVALID_2FA_CODE, message: 'TOTP code already used. Wait for the next code.' });
      }
      await client.expire(redisKey, 90);

      const plainBackupCodes = generateBackupCodes(10, 16);
      const hashedBackupCodes = await Promise.all(plainBackupCodes.map(c => hashOtp(c)));
      await this.prisma.twoFactorAuth.update({
        where: { userId },
        data: { backupCodes: hashedBackupCodes, usedBackupCodes: [] },
      });

      this.createSecurityNotification(userId, 'Backup Codes Regenerated', 'Your 2FA backup codes were regenerated. Previous backup codes no longer work.').catch(() => undefined);
      if (user.email) {
        this.dispatchEmail({ to: user.email, subject: 'Security Alert: Backup Codes Regenerated', templateName: 'backup-codes-regenerated-notification', templateContext: {} }).catch(() => undefined);
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
    const requestCount = await this.redis.incr(rateLimitKey);
    if (requestCount === 1) await this.redis.expire(rateLimitKey, 300);
    if (requestCount > 3) {
      throw new BadRequestException({ code: 'RATE_LIMIT_EXCEEDED', message: 'Too many OTP requests. Please wait 5 minutes before trying again.' });
    }

    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      throw new NotFoundException({ code: ErrorCodes.USER_NOT_FOUND, message: 'User not found' });
    }

    const twoFactorAuth = await this.prisma.twoFactorAuth.findUnique({ where: { userId } });
    if (!twoFactorAuth?.isEnabled) {
      throw new BadRequestException({ code: ErrorCodes.TWO_FA_NOT_ENABLED, message: '2FA is not enabled' });
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
        message: 'Your account has no email address. Please add and verify an email before disabling 2FA, or contact support.',
      });
    }

    await this.otpService.invalidateOtps(user.email, OtpType.TWO_FA_DISABLE);
    const otp = await this.otpService.generateOtp(user.email, OtpType.TWO_FA_DISABLE, userId, undefined, ipAddress);

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

  private async sendVerificationEmail(userId: string, email: string, ipAddress?: string): Promise<void> {
    await this.otpService.invalidateOtps(email, OtpType.EMAIL_VERIFICATION);
    const otp = await this.otpService.generateOtp(email, OtpType.EMAIL_VERIFICATION, userId, undefined, ipAddress);
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
      throw new InternalServerErrorException({ code: ErrorCodes.INTERNAL_SERVER_ERROR, message: 'Wallet PIN pepper is not configured' });
    }
    return pepper;
  }

  private validatePinPolicy(pin: string): void {
    if (pin.length !== 6 || !/^\d{6}$/.test(pin)) {
      throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'PIN must be exactly 6 digits' });
    }
    if (/^(\d)\1{5}$/.test(pin)) {
      throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'PIN must not be all repeated digits' });
    }
    const WEAK_SEQUENCES = ['012345', '123456', '234567', '345678', '456789', '567890', '098765', '987654', '876543', '765432', '654321', '543210'];
    if (WEAK_SEQUENCES.includes(pin)) {
      throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'PIN must not be a sequential number' });
    }
    if (/^(\d)(\d)\1\2\1\2$/.test(pin)) {
      const [a, b] = pin;
      if (a !== b) {
        throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'PIN must not be a repeating two-digit pattern' });
      }
    }
    if (/^(\d)\1(\d)\2(\d)\3$/.test(pin)) {
      throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'PIN must not consist of paired digits' });
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
      await this.emailQueue.add('send', {
        to: options.to,
        subject: options.subject,
        ...(options.html ? { html: options.html } : {}),
        ...(options.text ? { text: options.text } : {}),
        ...(options.templateName ? { templateName: options.templateName } : {}),
        ...(options.templateContext ? { templateContext: options.templateContext } : {}),
      }, {
        attempts: 3,
        backoff: { type: 'exponential', delay: 5000 },
        removeOnComplete: 100,
        removeOnFail: 50,
      });
    } catch (err) {
      this.logger.error(`[EMAIL QUEUE] Failed to enqueue email notification: ${(err as Error).message}`);
      throw err;
    }
  }

  private readonly BACKUP_CODE_LENGTH = 16;
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
  private async checkAndConsumeBackupCode(twoFactorAuth: { id: string; backupCodes: string[]; usedBackupCodes: string[] }, code: string): Promise<boolean> {
    if (!code || !this.BACKUP_CODE_PATTERN.test(code.toUpperCase())) {
      return false;
    }

    const backupRateKey = `backup_code_rate:${twoFactorAuth.id}`;
    const backupAttempts = await this.redis.incr(backupRateKey);
    if (backupAttempts === 1) {
      await this.redis.expire(backupRateKey, 15 * 60);
    }
    if (backupAttempts > 5) {
      throw new HttpException(
        { code: ErrorCodes.TOO_MANY_REQUESTS, message: 'Too many backup code attempts. Please wait before trying again.' },
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
          this.logger.warn(`Failed to stamp consumed backup code in Redis (best-effort cache): ${err instanceof Error ? err.message : err}`);
        }
        return true;
      }
    }
    return false;
  }

  private async trackDevice(userId: string, deviceId: string, deviceInfo: string | undefined, ipAddress: string): Promise<void> {
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
      await this.notifyNewDeviceLogin(userId, deviceInfo ?? 'Unknown Device', ipAddress).catch((err) => {
        this.logger.error('[NEW_DEVICE_NOTIFY] Failed to send new device login notification', err);
      });
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
    const backupBody = 'A backup code was used to log in to your account. If this was you, please re-enable 2FA and regenerate your backup codes. If this was not you, change your password immediately.';
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
    this.prisma.emitNotificationCreated({ userId, title: backupTitle, body: backupBody, data: { type: 'SECURITY_BACKUP_CODE' } });

    if (user?.email) {
      await this.dispatchEmail({
        to: user.email,
        subject: 'Security Alert: Backup Code Used',
        templateName: 'backup-code-used',
        templateContext: {},
      });
    }
  }

  private async createSecurityNotification(userId: string, title: string, body: string): Promise<void> {
    await this.prisma.notification.create({
      data: {
        notifId: generateNotifId(),
        userId,
        type: NotificationType.SECURITY_NEW_LOGIN,
        category: getCategoryForType(NotificationType.SECURITY_NEW_LOGIN),
        title,
        body,
      },
    });
    this.prisma.emitNotificationCreated({ userId, title, body, data: { type: 'SECURITY_ALERT' } });
  }

  private async notifyAccountLocked(userId: string, email: string, ipAddress: string): Promise<void> {
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
    this.prisma.emitNotificationCreated({ userId, title: lockTitle, body: lockBody, data: { type: 'SECURITY_ACCOUNT_LOCKED' } });

    await this.dispatchEmail({
      to: email,
      subject: 'Kahade — Your Account Has Been Locked',
      templateName: 'account-locked',
      templateContext: { ipAddress },
    }).catch((err) => {
      this.logger.error(`[AUTH] Failed to queue account lockout email for user ${userId}: ${(err as Error).message}`);
    });
  }

  private async notifyNewDeviceLogin(userId: string, deviceInfo: string, ipAddress: string): Promise<void> {
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
    this.prisma.emitNotificationCreated({ userId, title: loginTitle, body: loginBody, data: { type: 'SECURITY_NEW_LOGIN' } });
    this.realtime.emitToUser(userId, 'new.device.login', { deviceInfo, ipAddress, timestamp: new Date().toISOString() });
  }

  private async notifyRefreshTokenReuse(userId: string): Promise<void> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { email: true },
    });
    const title = 'Refresh Token Reuse Detected';
    const body = 'A previously rotated session credential was used again. All active sessions were signed out as a precaution. If this was not you, change your password immediately.';

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

    const tokenHash = sha256(refreshToken);
    const hashedRefreshToken = await bcryptHash(tokenHash, getBcryptRounds());

    const MAX_SESSIONS_PER_USER = this.configService.get<number>('app.maxSessionsPerUser') ?? 5;
    const now = new Date();
    const { session, revokedIds } = await this.prisma.$transaction(async (tx) => {
      const evictedIds: string[] = [];
      if (deviceId) {
        const sameDeviceSessions = await tx.userSession.findMany({
          where: { userId, deviceId, isRevoked: false, expiresAt: { gt: now } },
          select: { id: true },
        });
        const sameDeviceIds = sameDeviceSessions.map((candidate) => candidate.id);
        if (sameDeviceIds.length) {
          await tx.userSession.updateMany({
            where: { id: { in: sameDeviceIds }, isRevoked: false },
            data: { isRevoked: true, revokedAt: new Date(), revokedReason: 'device_reauthenticated' },
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
          data: { isRevoked: true, revokedAt: new Date(), revokedReason: 'session_limit_exceeded' },
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
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });

    if (revokedIds.length > 0) {
      await this.revokeSessionsInRedis([...new Set(revokedIds)]).catch((err: unknown) => {
        this.logger.warn(`[SECURITY] Session revocation persisted but Redis propagation is unavailable: ${err instanceof Error ? err.message : String(err)}`);
      });
    }

    return session.id;
  }

  private getTempTokenTtlSeconds(): number {
    const expiresIn: string = this.configService.get<string>('jwt.tempExpiresIn') ?? '5m';
    const match = expiresIn.match(/^(\d+)([smhd])$/);
    if (!match) return 5 * 60;
    const value = parseInt(match[1], 10);
    const unit = match[2];
    const multipliers: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86400 };
    return value * (multipliers[unit] ?? 60);
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
    await Promise.all(sessionIds.map((id) => this.redis.setex(SESSION_REVOKED_KEY(id), ttl, '1', { throwOnError: true })));
  }
}
