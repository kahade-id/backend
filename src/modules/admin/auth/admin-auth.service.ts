import { Injectable, UnauthorizedException, ForbiddenException, Logger, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as speakeasy from 'speakeasy';
import { AuditAction, AdminRole } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { RedisService } from '../../../redis/redis.service';
import { AuditLogService } from '../../../common/services/audit-log.service';
import { bcryptCompare, bcryptHash, decryptAES, encryptAES, sha256 } from '../../../common/utils/crypto.util';
import { TokenService } from '../../auth/token.service';
import { ADMIN_SESSION_ABSOLUTE_TTL_SECONDS } from '../../auth/token.service';
// AUT-003: CaptchaService (protokol slider yang sama dengan mobile) —
// AuthModule @Global() dan mengekspornya, jadi tidak perlu import modul.
import { CaptchaService } from '../../auth/captcha.service';
// AUT-002/AUT-009: kebijakan password admin terpusat.
import { validateAdminPasswordPolicy } from '../admin-password-policy';
import { BCRYPT_ROUNDS_ADMIN } from '../../../common/constants/app.constants';
import { ADMIN_TOKEN_BLACKLIST, ADMIN_REFRESH_BLACKLIST, ADMIN_2FA_ATTEMPT_KEY, ADMIN_MFA_SETUP, TOTP_USED_CODE } from '../../../common/constants/redis-keys';
import * as ErrorCodes from '../../../common/constants/error-codes';

const ADMIN_LOCK_MAX_ATTEMPTS = 5;
const ADMIN_LOCK_DURATION_MINUTES = 30;
const ADMIN_2FA_MAX_ATTEMPTS = 5;

// Dummy hash for constant-time comparison when admin is not found
const DUMMY_HASH = '$2b$14$Kw0dKjm4DkJ5h8hfZKy6Ku8k1WdcM0X3PZ5kU5gRv5Y4Q3e5rN5uG';

@Injectable()
export class AdminAuthService {
  private readonly logger = new Logger(AdminAuthService.name);

  constructor(
    private prisma: PrismaService,
    private redis: RedisService,
    private configService: ConfigService,
    private auditLogService: AuditLogService,
    private tokenService: TokenService,
    // AUT-003: login admin kini mengenal captcha slider (throttle adaptif).
    private captchaService: CaptchaService,
  ) {}

  async login(
    email: string,
    password: string,
    totpToken?: string,
    ipAddress?: string,
    userAgent?: string,
    // AUT-001: identitas perangkat peminta — diikat ke TempToken 2FA/MFA
    // (pola yang sama dengan mobile) agar tempToken yang bocor tidak bisa
    // dipakai dari perangkat lain.
    deviceId?: string,
    // AUT-003: slider captcha (protokol yang sama dengan mobile): jawaban
    // adalah posisi X slider 0-100 (sama seperti CaptchaService.verifyChallenge).
    captchaId?: string,
    captchaAnswer?: number,
  ): Promise<
    | { requiresMfa: true; tempToken: string }
    | { requiresMfaSetup: true; tempToken: string }
    | { requiresPasswordChange: true; tempToken: string }
    | { accessToken: string; refreshToken: string; admin: { id: string; adminId: string; fullName: string; email: string; role: string; isActive: boolean; isMfaEnabled: boolean; lastLoginAt: string | null } }
  > {
    // AUT-003: throttle adaptif — setelah N login gagal dari IP ini,
    // peminta WAJIB menyelesaikan slider captcha sebelum kredensial dicek
    // (pola yang sama dengan login mobile).
    const ip = ipAddress || 'unknown';
    const captchaRequired = await this.captchaService.shouldRequireLoginCaptcha(ip);
    if (captchaRequired) {
      if (!captchaId || captchaAnswer === undefined) {
        throw new UnauthorizedException({
          code: ErrorCodes.CAPTCHA_REQUIRED,
          message: 'Captcha verification is required after repeated failed login attempts',
        });
      }
      await this.captchaService.verifyChallenge(captchaId, captchaAnswer);
    }

    let result: Awaited<ReturnType<AdminAuthService['loginInner']>>;
    try {
      result = await this.loginInner(email, password, totpToken, ipAddress, userAgent, deviceId);
    } catch (error) {
      const response = error instanceof UnauthorizedException ? error.getResponse() : null;
      const code =
        typeof response === 'object' && response !== null && 'code' in response
          ? (response as { code?: unknown }).code
          : undefined;
      if (code === ErrorCodes.INVALID_CREDENTIALS) {
        // AUT-003: hanya kegagalan kredensial yang dihitung (pola mobile).
        await this.captchaService.recordLoginFailure(ip);
      }
      throw error;
    }
    await this.captchaService.clearLoginFailures(ip);
    return result;
  }

  /**
   * Inti login admin — dipanggil login() setelah captcha dicek.
   */
  private async loginInner(
    email: string,
    password: string,
    totpToken?: string,
    ipAddress?: string,
    userAgent?: string,
    deviceId?: string,
  ): Promise<
    | { requiresMfa: true; tempToken: string }
    | { requiresMfaSetup: true; tempToken: string }
    | { requiresPasswordChange: true; tempToken: string }
    | { accessToken: string; refreshToken: string; admin: { id: string; adminId: string; fullName: string; email: string; role: string; isActive: boolean; isMfaEnabled: boolean; lastLoginAt: string | null } }
  > {
    const normalizedEmail = email.toLowerCase();
    const admin = await this.prisma.adminUser.findUnique({ where: { email: normalizedEmail } });

    // Constant-time comparison regardless of whether admin exists
    const hashToCompare = admin?.password ?? DUMMY_HASH;
    const isPasswordValid = await bcryptCompare(password, hashToCompare);

    if (!admin || !isPasswordValid) {
      if (admin) {
        if (!admin.isActive || admin.deletedAt) {
          throw new UnauthorizedException({ code: ErrorCodes.INVALID_CREDENTIALS, message: 'Invalid email or password' });
        }
        if (admin.lockedUntil && admin.lockedUntil > new Date()) {
          throw new UnauthorizedException({ code: ErrorCodes.INVALID_CREDENTIALS, message: 'Invalid email or password' });
        }
        const updated = await this.prisma.adminUser.update({
          where: { id: admin.id },
          data: { failedLoginAttempts: { increment: 1 } },
          select: { failedLoginAttempts: true },
        });
        if (updated.failedLoginAttempts >= ADMIN_LOCK_MAX_ATTEMPTS) {
          await this.prisma.adminUser.update({
            where: { id: admin.id },
            data: { lockedUntil: new Date(Date.now() + ADMIN_LOCK_DURATION_MINUTES * 60 * 1000) },
          });
        }
      }
      throw new UnauthorizedException({
        code: ErrorCodes.INVALID_CREDENTIALS,
        message: 'Invalid email or password',
      });
    }

    if (!admin.isActive || admin.deletedAt) {
      // B-14 (audit-fix): emit the same generic error code for both
      // wrong-password and inactive-account so an attacker cannot use the
      // distinct error code to enumerate valid admin emails. Kept the audit
      // log entry so operators still see the precise reason internally.
      this.logger.warn(`Admin login blocked (inactive/deleted) for ${normalizedEmail} from ${ipAddress}`);
      throw new UnauthorizedException({ code: ErrorCodes.INVALID_CREDENTIALS, message: 'Invalid email or password' });
    }

    if (admin.lockedUntil && admin.lockedUntil > new Date()) {
      // B-14 (audit-fix): same as above -- never tell the caller "locked"
      // when password was actually correct, because doing so confirms the
      // password is valid.
      this.logger.warn(`Admin login blocked (locked) for ${normalizedEmail} from ${ipAddress} until ${admin.lockedUntil.toISOString()}`);
      throw new UnauthorizedException({ code: ErrorCodes.INVALID_CREDENTIALS, message: 'Invalid email or password' });
    }

    // AUT-011: admin yang flag mustChangePassword-nya true (dibuat SUPER_ADMIN
    // / di-reset) WAJIB mengganti password sebelum mendapat sesi apa pun —
    // tempToken scope admin_password_change, terikat deviceId (AUT-001).
    if (admin.mustChangePassword) {
      const tempToken = this.tokenService.signTempToken({ sub: admin.id, scope: 'admin_password_change', deviceId });
      this.logger.warn(`Admin ${admin.email} must change password before login (first login / reset)`);
      return { requiresPasswordChange: true, tempToken };
    }

    const mfaRequired = await this.shouldEnforceAdminMfa();
    if (mfaRequired && !admin.isMfaEnabled) {
      // SEC-501: admin tanpa MFA (termasuk admin pertama) TIDAK mendapat
      // sesi penuh — diarahkan ke enrollment via tempToken (scope
      // admin_mfa_setup). Admin menyelesaikan setup di endpoint
      // POST /v1/admin/auth/mfa/setup + /mfa/enable (didukung admin web).
      // AUT-001: tempToken diikat ke deviceId.
      const tempToken = this.tokenService.signTempToken({ sub: admin.id, scope: 'admin_mfa_setup', deviceId });
      this.logger.warn(`Admin ${admin.email} logged in without MFA — MFA setup required (enrollment path)`);
      return { requiresMfaSetup: true, tempToken };
    }

    if (admin.isMfaEnabled) {
      if (!totpToken) {
        // AUT-001: tempToken 2FA diikat ke deviceId (seperti mobile).
        const tempToken = this.tokenService.signTempToken({ sub: admin.id, scope: 'admin_2fa_verify', deviceId });
        return { requiresMfa: true, tempToken };
      }
      if (!admin.mfaSecret) {
        throw new UnauthorizedException({
          code: ErrorCodes.MFA_NOT_CONFIGURED,
          message: '2FA is not configured for this account',
        });
      }

      const inlineAttemptKey = ADMIN_2FA_ATTEMPT_KEY(`admin:${admin.id}:inline`);
      const inlineAttempts = await this.redis.incrWithTtl(inlineAttemptKey, 15 * 60); // AUDIT-14
      if (inlineAttempts > ADMIN_2FA_MAX_ATTEMPTS) {
        throw new UnauthorizedException({
          code: ErrorCodes.TOO_MANY_REQUESTS,
          message: 'Too many 2FA attempts. Please wait.',
        });
      }

      const decryptedSecret = await decryptAES(admin.mfaSecret);
      const isValidTotp = speakeasy.totp.verify({
        secret: decryptedSecret,
        encoding: 'base32',
        token: totpToken,
        window: 1,
      });

      if (!isValidTotp) {
        throw new UnauthorizedException({
          code: ErrorCodes.INVALID_MFA,
          message: 'Invalid 2FA code',
        });
      }

      await this.claimTotpCode(admin.id, totpToken);

      await this.redis.del(inlineAttemptKey, { throwOnError: true });
    }

    await this.prisma.adminUser.update({
      where: { id: admin.id },
      data: {
        failedLoginAttempts: 0,
        lockedUntil: null,
        lastLoginAt: new Date(),
        lastLoginIp: ipAddress,
      },
    });

    const accessToken = this.tokenService.signAdminAccessToken({
      sub: admin.id,
      adminId: admin.adminId,
      email: admin.email,
      role: admin.role,
    });

    const refreshToken = this.tokenService.signAdminRefreshToken({
      sub: admin.id,
      // SEC-502: issuance awal menetapkan anchor umur absolut sesi.
      sessionStartedAt: Math.floor(Date.now() / 1000),
    });

    this.logger.log(`Admin login: ${admin.adminId} [${admin.role}] dari ${ipAddress}`);

    // GAP-E G393: catat sesi login admin (dapat di-revoke via management API).
    await this.recordAdminSession(admin.id, ipAddress, userAgent);

    this.auditLogService.logAdminAction({
      adminId: admin.id,
      action: AuditAction.ADMIN_LOGIN,
      targetType: 'AdminUser',
      targetId: admin.id,
      description: `Admin ${admin.adminId} logged in`,
      ipAddress: ipAddress ?? 'unknown',
    });

    return {
      accessToken,
      refreshToken,
      admin: {
        id: admin.id,
        adminId: admin.adminId,
        fullName: admin.fullName,
        email: admin.email,
        role: admin.role,
        isActive: admin.isActive,
        isMfaEnabled: admin.isMfaEnabled,
        lastLoginAt: admin.lastLoginAt ? admin.lastLoginAt.toISOString() : null,
      },
    };
  }

  /**
   * Verify admin 2FA using a tempToken issued by login().
   * No plaintext credentials needed — tempToken proves identity.
   * AUT-001: tempToken terikat ke deviceId (seperti mobile) — tolak bila
   * perangkat peminta berbeda (fail-closed).
   */
  async verifyAdmin2fa(
    tempToken: string,
    totpToken: string,
    ipAddress?: string,
    userAgent?: string,
    deviceId?: string,
  ): Promise<{ accessToken: string; refreshToken: string; admin: { id: string; adminId: string; fullName: string; email: string; role: string; isActive: boolean; isMfaEnabled: boolean; lastLoginAt: string | null } }> {
    let payload: import('../../auth/token.service').TempTokenPayload;
    try {
      payload = this.tokenService.verifyTempToken(tempToken);
    } catch {
      throw new UnauthorizedException({ code: ErrorCodes.TEMP_TOKEN_EXPIRED, message: '2FA session expired, please log in again' });
    }

    if (payload.scope !== 'admin_2fa_verify') {
      throw new UnauthorizedException({ code: ErrorCodes.UNAUTHORIZED, message: 'Invalid token scope' });
    }

    // AUT-001: binding perangkat — cerminan persis cek mobile
    // (auth.service.ts verify2faLogin). TempToken tanpa deviceId (terbit
    // sebelum AUT-001) maupun dari perangkat lain → tolak.
    if (!payload.deviceId || payload.deviceId !== deviceId) {
      throw new UnauthorizedException({ code: ErrorCodes.TEMP_TOKEN_EXPIRED, message: '2FA session is not valid for this device. Please log in again.' });
    }

    // Guard against temp-token replay: reject if the JTI has already been consumed
    // (blacklisted after a successful admin 2FA login). Without this check, an attacker
    // who intercepts a temp token could reuse it within the 5-minute expiry window.
    if (payload.jti) {
      const alreadyConsumed = await this.redis.get(ADMIN_TOKEN_BLACKLIST(payload.jti), { throwOnError: true });
      if (alreadyConsumed) {
        throw new UnauthorizedException({ code: ErrorCodes.TEMP_TOKEN_EXPIRED, message: '2FA session already used. Please log in again.' });
      }
    }

    const attemptKey = ADMIN_2FA_ATTEMPT_KEY(`admin:${payload.sub}:${payload.jti ?? 'no-jti'}`);
    const attempts = await this.redis.incrWithTtl(attemptKey, 15 * 60); // AUDIT-14
    if (attempts > ADMIN_2FA_MAX_ATTEMPTS) {
      // B-18 (audit-fix): when attempts exhaust, immediately blacklist the
      // temp-token JTI for the rest of its expiry window. Without this, a
      // Redis flush (eviction / process restart / cluster failover) clears the
      // attempt counter and lets the attacker keep brute-forcing the SAME
      // temp-token until its native JWT exp. Blacklisting the JTI ensures the
      // verifyTempToken-replay check above (line ~216) catches it on every
      // subsequent attempt regardless of attempt-counter state.
      if (payload.jti) {
        const ttl = Math.max(60, 5 * 60); // temp-token expiry is 5 min; blacklist for at least that long
        await this.redis.setex(ADMIN_TOKEN_BLACKLIST(payload.jti), ttl, '1', { throwOnError: false });
      }
      throw new UnauthorizedException({ code: ErrorCodes.TOO_MANY_REQUESTS, message: 'Too many 2FA attempts. Please log in again.' });
    }

    const admin = await this.prisma.adminUser.findUnique({ where: { id: payload.sub } });
    if (!admin || !admin.isActive || admin.deletedAt) {
      throw new ForbiddenException({ code: ErrorCodes.ACCOUNT_INACTIVE, message: 'Admin account is inactive' });
    }
    if (admin.lockedUntil && admin.lockedUntil > new Date()) {
      throw new ForbiddenException({ code: ErrorCodes.ACCOUNT_LOCKED, message: 'Admin account is locked' });
    }
    if (!admin.mfaSecret) {
      throw new UnauthorizedException({ code: ErrorCodes.MFA_NOT_CONFIGURED, message: '2FA is not configured' });
    }

    const decryptedSecret = await decryptAES(admin.mfaSecret);
    const isValidTotp = speakeasy.totp.verify({ secret: decryptedSecret, encoding: 'base32', token: totpToken, window: 1 });
    if (!isValidTotp) {
      throw new UnauthorizedException({ code: ErrorCodes.INVALID_MFA, message: 'Invalid 2FA code' });
    }

    await this.claimTotpCode(admin.id, totpToken);

    await this.redis.del(attemptKey, { throwOnError: true });

    if (payload.jti) {
      await this.redis.setex(ADMIN_TOKEN_BLACKLIST(payload.jti), 5 * 60, '1', { throwOnError: true });
    }

    await this.prisma.adminUser.update({
      where: { id: admin.id },
      data: { failedLoginAttempts: 0, lockedUntil: null, lastLoginAt: new Date(), lastLoginIp: ipAddress },
    });

    const accessToken = this.tokenService.signAdminAccessToken({
      sub: admin.id, adminId: admin.adminId, email: admin.email, role: admin.role,
    });
    const refreshToken = this.tokenService.signAdminRefreshToken({
      sub: admin.id,
      // SEC-502: issuance awal menetapkan anchor umur absolut sesi.
      sessionStartedAt: Math.floor(Date.now() / 1000),
    });
    this.logger.log(`Admin 2FA login: ${admin.adminId} [${admin.role}] dari ${ipAddress}`);

    // GAP-E G393: catat sesi login admin (dapat di-revoke via management API).
    await this.recordAdminSession(admin.id, ipAddress, userAgent);

    this.auditLogService.logAdminAction({
      adminId: admin.id,
      action: AuditAction.ADMIN_LOGIN,
      targetType: 'AdminUser',
      targetId: admin.id,
      description: `Admin ${admin.adminId} logged in via 2FA`,
      ipAddress: ipAddress ?? 'unknown',
    });

    return {
      accessToken,
      refreshToken,
      admin: {
        id: admin.id,
        adminId: admin.adminId,
        fullName: admin.fullName,
        email: admin.email,
        role: admin.role,
        isActive: admin.isActive,
        isMfaEnabled: admin.isMfaEnabled,
        lastLoginAt: admin.lastLoginAt ? admin.lastLoginAt.toISOString() : null,
      },
    };
  }

  /**
   * 03-#8: mulai enroll MFA admin. Dipanggil dengan tempToken scope
   * `admin_mfa_setup` (dari login yang mengembalikan requiresMfaSetup).
   * Mengembalikan otpauthUrl + secret untuk dipindai di aplikasi authenticator.
   * Secret disimpan terenkripsi di Redis (TTL 10 menit) hingga diverifikasi
   * di enableMfa — tidak langsung ditulis ke DB.
   */
  async setupMfa(tempToken: string, deviceId?: string): Promise<{ otpauthUrl: string; secret: string }> {
    const admin = await this.verifyMfaSetupToken(tempToken, deviceId);

    const secret = speakeasy.generateSecret({ length: 32, name: `Kahade Admin (${admin.email})` });
    const encrypted = await this.encryptMfaSecret(secret.base32);
    // SET NX agar setup yang sudah berjalan tidak tertimpa oleh request ganda.
    await this.redis.setNx(ADMIN_MFA_SETUP(admin.id), encrypted, 10 * 60, { throwOnError: true });

    this.auditLogService.logAdminAction({
      adminId: admin.id,
      action: AuditAction.ADMIN_ACTION,
      targetType: 'ADMIN_USER',
      targetId: admin.id,
      description: 'MFA setup initiated',
      ipAddress: 'unknown',
    });

    return { otpauthUrl: secret.otpauth_url!, secret: secret.base32 };
  }

  /**
   * 03-#8: selesaikan enroll MFA. Verifikasi TOTP terhadap secret yang
   * disimpan saat setupMfa, lalu simpan terenkripsi di DB + aktifkan MFA,
   * dan kembalikan sesi penuh (setara login sukses).
   */
  async enableMfa(
    tempToken: string,
    totpToken: string,
    ipAddress?: string,
    userAgent?: string,
    deviceId?: string,
  ): Promise<{ accessToken: string; refreshToken: string; admin: { id: string; adminId: string; fullName: string; email: string; role: string; isActive: boolean; isMfaEnabled: boolean; lastLoginAt: string | null } }> {
    const admin = await this.verifyMfaSetupToken(tempToken, deviceId);

    const stored = await this.redis.get(ADMIN_MFA_SETUP(admin.id), { throwOnError: true });
    if (!stored) {
      throw new BadRequestException({
        code: ErrorCodes.MFA_NOT_CONFIGURED,
        message: 'MFA setup session expired. Please start setup again.',
      });
    }
    const secret = await this.decryptMfaSecret(stored);

    const isValid = speakeasy.totp.verify({ secret, encoding: 'base32', token: totpToken, window: 1 });
    if (!isValid) {
      throw new UnauthorizedException({ code: ErrorCodes.INVALID_MFA, message: 'Invalid 2FA code' });
    }

    // Klaim kode TOTP agar tidak bisa dipakai ulang (pola sama seperti login).
    await this.claimTotpCode(admin.id, totpToken);

    await this.prisma.adminUser.update({
      where: { id: admin.id },
      data: { mfaSecret: stored, isMfaEnabled: true },
    });
    await this.redis.del(ADMIN_MFA_SETUP(admin.id), { throwOnError: true });

    this.auditLogService.logAdminAction({
      adminId: admin.id,
      action: AuditAction.ADMIN_ACTION,
      targetType: 'ADMIN_USER',
      targetId: admin.id,
      description: 'MFA enabled',
      ipAddress: ipAddress ?? 'unknown',
    });
    this.logger.log(`Admin MFA enabled for ${admin.email}`);

    // Kembalikan sesi penuh — setara login sukses setelah MFA.
    return this.issueAdminSession(admin, ipAddress, userAgent);
  }

  // AUT-001: token setup MFA juga terikat deviceId — ia bermuara ke sesi
  // penuh via enableMfa, jadi lubang yang sama harus ditutup.
  private async verifyMfaSetupToken(tempToken: string, deviceId?: string) {
    let payload: import('../../auth/token.service').TempTokenPayload;
    try {
      payload = this.tokenService.verifyTempToken(tempToken);
    } catch {
      throw new UnauthorizedException({ code: ErrorCodes.TEMP_TOKEN_EXPIRED, message: 'Setup session expired' });
    }
    if (payload.scope !== 'admin_mfa_setup') {
      throw new UnauthorizedException({ code: ErrorCodes.UNAUTHORIZED, message: 'Invalid token scope' });
    }
    if (!payload.deviceId || payload.deviceId !== deviceId) {
      throw new UnauthorizedException({ code: ErrorCodes.TEMP_TOKEN_EXPIRED, message: 'Setup session is not valid for this device. Please log in again.' });
    }
    const admin = await this.prisma.adminUser.findUnique({ where: { id: payload.sub } });
    if (!admin || !admin.isActive || admin.deletedAt) {
      throw new UnauthorizedException({ code: ErrorCodes.ADMIN_NOT_FOUND, message: 'Admin not found' });
    }
    return admin;
  }

  private async encryptMfaSecret(secret: string): Promise<string> {
    return encryptAES(secret);
  }

  private async decryptMfaSecret(encrypted: string): Promise<string> {
    return decryptAES(encrypted);
  }

  async refreshAdminToken(
    refreshToken: string,
  ): Promise<{ accessToken: string; refreshToken: string }> {
    try {
      const payload = this.tokenService.verifyAdminRefreshToken(refreshToken);

      // SEC-502: umur absolut sesi admin — 24 jam sejak sessionStartedAt,
      // tidak peduli berapa kali token dirotasi. Token lama (tanpa anchor),
      // anchor invalid, atau umur ≥ 24 jam → tolak; admin wajib login ulang.
      const anchor = payload.sessionStartedAt;
      const anchorValid = typeof anchor === 'number' && Number.isFinite(anchor) && anchor > 0;
      if (!anchorValid || Date.now() / 1000 - anchor >= ADMIN_SESSION_ABSOLUTE_TTL_SECONDS) {
        throw new UnauthorizedException({
          code: ErrorCodes.TOKEN_INVALID_OR_EXPIRED,
          message: 'Admin session exceeded maximum lifetime — please log in again',
        });
      }

      // Check if this refresh token JTI has been blacklisted (e.g. after logout)
      if (payload.jti) {
        const isBlacklisted = await this.redis.get(ADMIN_REFRESH_BLACKLIST(payload.jti), { throwOnError: true });
        if (isBlacklisted) {
          throw new UnauthorizedException({
            code: ErrorCodes.TOKEN_INVALID_OR_EXPIRED,
            message: 'Refresh token is no longer valid (logged out)',
          });
        }
      }

      // Redis SET NX with TTL (atomic): prevents concurrent rotation from multiple 401 retries.
      // TTL=15s is the lock expiry guard in case the process crashes mid-rotation
      // (prevents the lock from being held forever).
      const rotationLockKey = `admin_token_rotation:${payload.jti}`;
      const lockAcquired = await this.redis.setNx(rotationLockKey, '1', 15, { throwOnError: true });
      if (!lockAcquired) {
        throw new UnauthorizedException({
          code: ErrorCodes.TOKEN_INVALID_OR_EXPIRED,
          message: 'Token is being rotated. Please try again.',
        });
      }

      // released even when an error is thrown mid-rotation. Without this, a
      // failed DB lookup or signing error would leave the lock held for 15s,
      // blocking all concurrent refresh attempts for that JTI.
      try {
        const admin = await this.prisma.adminUser.findUnique({ where: { id: payload.sub } });

        if (!admin || !admin.isActive || admin.deletedAt) {
          throw new UnauthorizedException({
            code: ErrorCodes.INVALID_CREDENTIALS,
            message: 'Admin account not found or inactive',
          });
        }
        if (admin.lockedUntil && admin.lockedUntil > new Date()) {
          throw new UnauthorizedException({
            code: ErrorCodes.ACCOUNT_LOCKED,
            message: 'Admin account is locked',
          });
        }

        const revokedAtRaw = await this.redis.get(`admin_revoked:${admin.id}`, { throwOnError: true });
        if (revokedAtRaw) {
          const revokedAt = Number(revokedAtRaw);
          const issuedAt = typeof payload.iat === 'number' ? payload.iat : 0;
          const tokenRevoked = !Number.isFinite(revokedAt) || revokedAt <= 1 || issuedAt <= revokedAt;
          if (tokenRevoked) {
            throw new UnauthorizedException({
              code: ErrorCodes.TOKEN_INVALID_OR_EXPIRED,
              message: 'Admin refresh token has been revoked',
            });
          }
        }

        const newAccessToken = this.tokenService.signAdminAccessToken({
          sub: admin.id,
          adminId: admin.adminId,
          email: admin.email,
          role: admin.role,
        });

        // SEC-502: rotation meneruskan anchor umur absolut dari token lama —
        // umur sesi tidak pernah di-reset oleh rotation.
        const newRefreshToken = this.tokenService.signAdminRefreshToken({
          sub: admin.id,
          sessionStartedAt: payload.sessionStartedAt,
        });

        // Blacklist the OLD refresh token JTI so it cannot be reused (rotation).
        // This is done AFTER issuing the new token to prevent a window where
        // the old token is blacklisted but the new token isn't yet returned.
        if (payload.jti) {
          const refreshTtlSeconds = this.getAdminRefreshTokenTtlSeconds();
          await this.redis.setex(ADMIN_REFRESH_BLACKLIST(payload.jti), refreshTtlSeconds, '1', { throwOnError: true });
        }

        return { accessToken: newAccessToken, refreshToken: newRefreshToken };
      } finally {
        // Always release the lock, whether rotation succeeded or failed.
        await this.redis.del(rotationLockKey).catch((err) => this.logger.warn(`silent-catch: ${err instanceof Error ? err.message : String(err)}`));
      }
    } catch (err) {
      if (err instanceof UnauthorizedException) throw err;
      throw new UnauthorizedException({
        code: ErrorCodes.TOKEN_INVALID_OR_EXPIRED,
        message: 'Invalid or expired refresh token',
      });
    }
  }

  /**
   * Atomically claims one TOTP code hash. A get-then-set sequence allowed two
   * concurrent requests using the same valid code to pass before either write.
   * The code hash is part of the key so a subsequent valid TOTP is unaffected.
   */
  private async claimTotpCode(adminId: string, totpToken: string): Promise<void> {
    const codeHash = sha256(totpToken);
    const replayKey = `${TOTP_USED_CODE(`admin:${adminId}`)}:${codeHash}`;
    const claimed = await this.redis.setNx(replayKey, '1', 90, { throwOnError: true });
    if (!claimed) {
      throw new BadRequestException({
        code: ErrorCodes.INVALID_MFA,
        message: '2FA code already used. Wait for the next code.',
      });
    }
  }

  /**
   * Blacklist the current access token JTI so it cannot be reused until natural expiry.
   * Also blacklist the refresh token JTI to prevent re-login after logout.
   * This is server-side logout — client must also clear its local state.
   */
  async logout(adminId: string, accessTokenJti: string, ipAddress: string, refreshToken?: string): Promise<{ message: string }> {
    if (accessTokenJti) {
      const ttlSeconds = this.getAdminAccessTokenTtlSeconds();
      await this.redis.setex(ADMIN_TOKEN_BLACKLIST(accessTokenJti), ttlSeconds, '1', { throwOnError: true });
      this.logger.log(`Admin access token blacklisted: jti=${accessTokenJti}`);
    }

    if (refreshToken) {
      try {
        const payload = this.tokenService.verifyAdminRefreshToken(refreshToken);
        if (payload.jti) {
          const refreshTtlSeconds = this.getAdminRefreshTokenTtlSeconds();
          await this.redis.setex(ADMIN_REFRESH_BLACKLIST(payload.jti), refreshTtlSeconds, '1', { throwOnError: true });
          this.logger.log(`Admin refresh token blacklisted: jti=${payload.jti}`);
        }
      } catch {
        // Token already expired or invalid — no need to blacklist
        this.logger.debug('Admin refresh token already expired/invalid during logout');
      }
    }

    this.auditLogService.logAdminAction({
      adminId,
      action: AuditAction.ADMIN_LOGOUT,
      targetType: 'AdminUser',
      targetId: adminId,
      description: 'Admin logged out',
      ipAddress,
    });

    return { message: 'Logout successful' };
  }

  /**
   * ADM-420 — self-service "keluar dari semua perangkat" untuk admin.
   *
   * Mencabut SEMUA sesi milik admin pemanggil (termasuk sesi saat ini):
   *  - tandai semua baris AdminSession aktif sebagai revoked,
   *  - naikkan epoch `admin_revoked:<adminId>` di Redis → SELURUH access token
   *    DAN refresh token admin ini menjadi tidak valid (fail-closed),
   *  - catat audit ADMIN_SESSION_REVOKED.
   *
   * Catatan desain: token akses admin bersifat stateless tanpa tautan jti
   * per-sesi, sehingga "cabut sesi lain tapi pertahankan sesi ini" tidak bisa
   * ditegakkan untuk token yang sudah terbit — pilihannya hanya cabut-semua.
   * Klien WAJIB mengarahkan ke /login setelah memanggil endpoint ini karena
   * token yang dipakai untuk memanggil ikut mati.
   */
  async revokeAllOwnSessions(adminId: string, ipAddress: string): Promise<{ message: string; revokedCount: number }> {
    const { count } = await this.prisma.adminSession.updateMany({
      where: { adminId, revokedAt: null },
      data: { revokedAt: new Date(), revokedBy: adminId },
    });
    // Fail-safe: batalkan juga seluruh JWT (akses + refresh) yang beredar.
    // ADM-420: TTL marker = max(umur access token, umur absolut sesi 24 jam).
    // Refresh token dihormati sampai min(refresh TTL, 24 jam absolut / SEC-502);
    // marker yang kedaluwarsa lebih dulu membuka jendela fail-open di mana
    // refresh token curian menerbitkan access token baru. Lebih lama = lebih aman.
    const revokedMarkerTtlSeconds = Math.max(
      this.getAdminAccessTokenTtlSeconds(),
      ADMIN_SESSION_ABSOLUTE_TTL_SECONDS,
    );
    await this.redis.setex(`admin_revoked:${adminId}`, revokedMarkerTtlSeconds, String(Math.floor(Date.now() / 1000)), {
      throwOnError: true,
    });
    this.auditLogService.logAdminAction({
      adminId,
      action: AuditAction.ADMIN_SESSION_REVOKED,
      targetType: 'AdminUser',
      targetId: adminId,
      description: `Admin revoked all own sessions (self-service, ${count} session(s))`,
      after: { revokedCount: count, selfService: true },
      ipAddress,
    });
    return {
      message: 'Semua sesi Anda telah dicabut, termasuk sesi ini. Silakan login ulang.',
      revokedCount: count,
    };
  }

  async getProfile(
    adminId: string,
  ): Promise<{
    id: string;
    adminId: string;
    fullName: string;
    email: string;
    role: string;
    isActive: boolean;
    isMfaEnabled: boolean;
    lastLoginAt: Date | null;
    lastLoginIp: string | null;
  }> {
    const admin = await this.prisma.adminUser.findUnique({
      where: { id: adminId },
      select: {
        id: true, adminId: true, fullName: true, email: true, role: true,
        isActive: true, isMfaEnabled: true, lastLoginAt: true, lastLoginIp: true,
      },
    });
    if (!admin) throw new UnauthorizedException({ code: ErrorCodes.ADMIN_NOT_FOUND, message: 'Admin not found' });
    return admin;
  }

  /**
   * AUT-002: ganti password sendiri (autentikasi ulang password lama).
   * Fail-closed: password lama salah → 401; password baru lemah → 400.
   * Setelah ganti, SEMUA sesi dicabut (kecuali sesi aktif pemanggil tetap
   * valid? — tidak: fail-closed, semua sesi termasuk pemanggil dicabut via
   * marker; klien wajib login ulang).
   */
  async changePassword(
    adminId: string,
    currentPassword: string,
    newPassword: string,
    ipAddress?: string,
  ): Promise<{ message: string }> {
    const admin = await this.prisma.adminUser.findFirst({ where: { id: adminId, deletedAt: null } });
    if (!admin || !admin.isActive) {
      throw new UnauthorizedException({ code: ErrorCodes.ADMIN_NOT_FOUND, message: 'Admin not found' });
    }

    const matches = await bcryptCompare(currentPassword, admin.password);
    if (!matches) {
      this.logger.warn(`Admin password change rejected (wrong current password) for ${admin.email}`);
      throw new UnauthorizedException({ code: ErrorCodes.INVALID_CREDENTIALS, message: 'Current password is incorrect' });
    }

    if (currentPassword === newPassword) {
      throw new BadRequestException({ code: ErrorCodes.PASSWORD_TOO_WEAK, message: 'New password must differ from the current password' });
    }

    // AUT-009: kebijakan admin min 12 + kompleksitas (seperti createAdmin).
    validateAdminPasswordPolicy(newPassword);

    const hashedPassword = await bcryptHash(newPassword, BCRYPT_ROUNDS_ADMIN);
    await this.prisma.adminUser.update({
      where: { id: adminId },
      data: {
        password: hashedPassword,
        mustChangePassword: false,
        failedLoginAttempts: 0,
        lockedUntil: null,
      },
    });

    // Cabut semua sesi (termasuk yang sedang dipakai — klien login ulang).
    await this.redis.setex(
      `admin_revoked:${adminId}`,
      ADMIN_SESSION_ABSOLUTE_TTL_SECONDS,
      String(Math.floor(Date.now() / 1000)),
      { throwOnError: true },
    );

    this.auditLogService.logAdminAction({
      adminId,
      action: AuditAction.ADMIN_ACTION,
      targetType: 'AdminUser',
      targetId: admin.id,
      description: `Admin "${admin.fullName}" (${admin.adminId}) changed their own password`,
      ipAddress: ipAddress ?? 'unknown',
    });

    return { message: 'Password changed successfully. Please log in again.' };
  }

  /**
   * AUT-011: ganti password pertama untuk admin yang flag
   * `mustChangePassword`-nya true (dibuat baru / di-reset SUPER_ADMIN).
   * Token: scope `admin_password_change` dari login(), terikat deviceId
   * (AUT-001) — satu arah saja: tidak menerbitkan sesi, klien wajib login
   * ulang dengan password baru.
   */
  async acceptFirstPasswordChange(
    tempToken: string,
    newPassword: string,
    ipAddress?: string,
    deviceId?: string,
  ): Promise<{ message: string }> {
    let payload: import('../../auth/token.service').TempTokenPayload;
    try {
      payload = this.tokenService.verifyTempToken(tempToken);
    } catch {
      throw new UnauthorizedException({ code: ErrorCodes.TEMP_TOKEN_EXPIRED, message: 'Session expired, please log in again' });
    }
    if (payload.scope !== 'admin_password_change') {
      throw new UnauthorizedException({ code: ErrorCodes.UNAUTHORIZED, message: 'Invalid token scope' });
    }
    if (!payload.deviceId || payload.deviceId !== deviceId) {
      throw new UnauthorizedException({ code: ErrorCodes.TEMP_TOKEN_EXPIRED, message: 'Session is not valid for this device. Please log in again.' });
    }

    const admin = await this.prisma.adminUser.findFirst({ where: { id: payload.sub, deletedAt: null } });
    if (!admin || !admin.isActive) {
      throw new UnauthorizedException({ code: ErrorCodes.ADMIN_NOT_FOUND, message: 'Admin not found' });
    }
    if (!admin.mustChangePassword) {
      // Token valid tapi flag sudah clear (mis. tab ganda) — tidak ada yang
      // perlu dilakukan; jangan biarkan endpoint dipakai untuk ganti
      // password sewenang-wenang tanpa password lama.
      throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Password change is not required. Use change-password instead.' });
    }

    validateAdminPasswordPolicy(newPassword);
    const hashedPassword = await bcryptHash(newPassword, BCRYPT_ROUNDS_ADMIN);
    await this.prisma.adminUser.update({
      where: { id: admin.id },
      data: { password: hashedPassword, mustChangePassword: false, failedLoginAttempts: 0, lockedUntil: null },
    });

    // Klaim temp token satu-pakai + cabut sesi yang mungkin ada.
    if (payload.jti) {
      await this.redis.setNx(ADMIN_TOKEN_BLACKLIST(payload.jti), '1', 10 * 60, { throwOnError: false });
    }
    await this.redis.setex(
      `admin_revoked:${admin.id}`,
      ADMIN_SESSION_ABSOLUTE_TTL_SECONDS,
      String(Math.floor(Date.now() / 1000)),
      { throwOnError: true },
    );

    this.auditLogService.logAdminAction({
      adminId: admin.id,
      action: AuditAction.ADMIN_ACTION,
      targetType: 'AdminUser',
      targetId: admin.id,
      description: `Admin "${admin.fullName}" (${admin.adminId}) completed first password change`,
      ipAddress: ipAddress ?? 'unknown',
    });

    return { message: 'Password changed successfully. Please log in with your new password.' };
  }

  private getAdminAccessTokenTtlSeconds(): number {
    const expiresIn: string = this.configService.get<string>('jwt.adminExpiresIn') ?? '30m';
    const match = expiresIn.match(/^(\d+)([smhd])$/);
    if (!match) return 30 * 60;
    const value = parseInt(match[1], 10);
    const multipliers: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86400 };
    return value * (multipliers[match[2]] ?? 60);
  }

  private getAdminRefreshTokenTtlSeconds(): number {
    const expiresIn: string = this.configService.get<string>('jwt.adminRefreshExpiresIn') ?? '7d';
    const match = expiresIn.match(/^(\d+)([smhd])$/);
    if (!match) return 7 * 24 * 3600;
    const value = parseInt(match[1], 10);
    const multipliers: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86400 };
    return value * (multipliers[match[2]] ?? 60);
  }

  /**
   * Terbitkan sesi admin penuh (dipakai login sukses & selesai enroll MFA).
   */
  private async issueAdminSession(
    admin: { id: string; adminId: string; fullName: string; email: string; role: AdminRole; isActive: boolean; isMfaEnabled: boolean; lastLoginAt: Date | null },
    ipAddress?: string,
    userAgent?: string,
  ): Promise<{ accessToken: string; refreshToken: string; admin: { id: string; adminId: string; fullName: string; email: string; role: string; isActive: boolean; isMfaEnabled: boolean; lastLoginAt: string | null } }> {
    await this.prisma.adminUser.update({
      where: { id: admin.id },
      data: {
        failedLoginAttempts: 0,
        lockedUntil: null,
        lastLoginAt: new Date(),
        lastLoginIp: ipAddress,
      },
    });

    const accessToken = this.tokenService.signAdminAccessToken({
      sub: admin.id,
      adminId: admin.adminId,
      email: admin.email,
      role: admin.role,
    });
    const refreshToken = this.tokenService.signAdminRefreshToken({
      sub: admin.id,
      // SEC-502: issuance awal menetapkan anchor umur absolut sesi.
      sessionStartedAt: Math.floor(Date.now() / 1000),
    });

    this.auditLogService.logAdminAction({
      adminId: admin.id,
      action: AuditAction.ADMIN_LOGIN,
      targetType: 'AdminUser',
      targetId: admin.id,
      description: `Admin ${admin.adminId} logged in`,
      ipAddress: ipAddress ?? 'unknown',
    });

    // GAP-E G393: catat sesi login admin (dapat di-revoke via management API).
    await this.recordAdminSession(admin.id, ipAddress, userAgent);

    return {
      accessToken,
      refreshToken,
      admin: {
        id: admin.id,
        adminId: admin.adminId,
        fullName: admin.fullName,
        email: admin.email,
        role: admin.role,
        isActive: admin.isActive,
        isMfaEnabled: true,
        lastLoginAt: new Date().toISOString(),
      },
    };
  }

  /**
   * GAP-E G393: catat sesi login admin ke AdminSession sehingga terlihat di
   * GET /v1/admin/management/:id/sessions dan dapat dicabut.
   * Best-effort: kegagalan pencatatan tidak menggagalkan login.
   */
  /**
   * GAP-E G393: catat sesi admin + deteksi login dari perangkat/lokasi baru.
   * Bila admin belum pernah login dari kombinasi userAgent+IP ini, catat audit
   * ADMIN_NEW_DEVICE_LOGIN dan tulis alert `[ADMIN ALERT]` (pola yang sama
   * dengan SLA/dispute: belum ada kanal notifikasi in-app untuk admin).
   */
  private async recordAdminSession(adminId: string, ipAddress?: string, userAgent?: string): Promise<void> {
    try {
      const normalizedIp = ipAddress ?? 'unknown';
      const normalizedUa = userAgent ?? null;
      const prior = await this.prisma.adminSession.findFirst({
        where: {
          adminId,
          OR: [
            { userAgent: normalizedUa },
            { ipAddress: normalizedIp },
          ],
        },
        select: { id: true },
      });
      await this.prisma.adminSession.create({
        data: {
          adminId,
          ipAddress: normalizedIp,
          userAgent: normalizedUa,
        },
      });
      if (!prior && normalizedUa !== null) {
        this.logger.warn(
          `[ADMIN ALERT] Login admin dari perangkat/lokasi baru: adminId=${adminId} ip=${normalizedIp} ua=${String(normalizedUa).slice(0, 120)}`,
        );
        try {
          this.auditLogService.logAdminAction({
            adminId,
            action: AuditAction.ADMIN_NEW_DEVICE_LOGIN,
            targetType: 'AdminUser',
            targetId: adminId,
            description: `Login admin dari perangkat/lokasi baru (ip=${normalizedIp})`,
            after: { userAgent: String(normalizedUa).slice(0, 200) },
            ipAddress: normalizedIp,
            userAgent: String(normalizedUa).slice(0, 200),
          });
        } catch (err) {
          this.logger.error(`Failed to audit new-device admin login: ${String(err)}`);
        }
      }
    } catch (err) {
      this.logger.error(
        `Failed to record admin session for ${adminId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private async isAdminMfaRequired(): Promise<boolean> {
    try {
      const config = await this.prisma.systemConfig.findUnique({
        where: { key: 'admin_mfa_required' },
      });
      // 03-#8: default fail-closed — MFA wajib kecuali eksplisit dinonaktifkan.
      // Kunci di-seed 'true' di prisma/seed.ts.
      //
      // AUT-010 (audit trail, terverifikasi 2026-10-01): kunci ini dapat
      // diubah SUPER_ADMIN via PUT /v1/admin/system/configs/:key
      // (admin-system.service.ts:updateConfig), dan SETIAP perubahan
      // diaudit via auditLogService.logAdminAction aksi
      // SYSTEM_CONFIG_CHANGED dengan before/after
      // (admin-system.service.ts:~203-230) — BUKAN app_setting_audits
      // (tabel appSetting hanya untuk OpsSettingsModule). Jadi menonaktifkan
      // MFA wajib = tindakan tercatat (siapa, kapan, nilai lama/baru), tapi
      // tetap operasi single-actor (bukan konfigurasi finansial — tidak ada
      // persetujuan ganda).
      if (!config) return true;
      return config.value === 'true';
    } catch (err) {
      this.logger.error('Failed to check admin MFA requirement from DB — defaulting to required (fail-closed)', err);
      return true;
    }
  }

  /**
   * SEC-501: penegakan MFA admin selalu aktif bila `admin_mfa_required=true`
   * (default fail-closed). Bootstrap bypass DIHAPUS — admin pertama TANPA
   * MFA tidak lagi memperoleh sesi penuh, melainkan diarahkan ke jalur
   * enrollment aman (`requiresMfaSetup + tempToken` → POST
   * /v1/admin/auth/mfa/setup + /mfa/enable, didukung admin web). Dengan
   * demikian tidak ada jendela di mana sesi admin penuh bisa diperoleh
   * tanpa MFA.
   */
  private async shouldEnforceAdminMfa(): Promise<boolean> {
    return this.isAdminMfaRequired();
  }
}
