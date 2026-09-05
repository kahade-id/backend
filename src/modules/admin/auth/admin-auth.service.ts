import { Injectable, UnauthorizedException, ForbiddenException, Logger, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as speakeasy from 'speakeasy';
import { AuditAction } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { RedisService } from '../../../redis/redis.service';
import { AuditLogService } from '../../../common/services/audit-log.service';
import { bcryptCompare, decryptAES, sha256 } from '../../../common/utils/crypto.util';
import { TokenService } from '../../auth/token.service';
import { ADMIN_TOKEN_BLACKLIST, ADMIN_REFRESH_BLACKLIST, ADMIN_2FA_ATTEMPT_KEY, TOTP_USED_CODE } from '../../../common/constants/redis-keys';
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
  ) {}

  async login(
    email: string,
    password: string,
    totpToken?: string,
    ipAddress?: string,
  ): Promise<
    | { requiresMfa: true; tempToken: string }
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

    const mfaRequired = await this.isAdminMfaRequired();
    if (mfaRequired && !admin.isMfaEnabled) {
      throw new ForbiddenException({
        code: ErrorCodes.MFA_NOT_CONFIGURED,
        message: '2FA is required for all admin accounts. Please contact a super admin to set up 2FA.',
      });
    }

    if (admin.isMfaEnabled) {
      if (!totpToken) {
        const tempToken = this.tokenService.signTempToken({ sub: admin.id, scope: 'admin_2fa_verify' });
        return { requiresMfa: true, tempToken };
      }
      if (!admin.mfaSecret) {
        throw new UnauthorizedException({
          code: ErrorCodes.MFA_NOT_CONFIGURED,
          message: '2FA is not configured for this account',
        });
      }

      const inlineAttemptKey = ADMIN_2FA_ATTEMPT_KEY(`admin:${admin.id}:inline`);
      const inlineAttempts = await this.redis.incr(inlineAttemptKey);
      if (inlineAttempts === 1) {
        await this.redis.expire(inlineAttemptKey, 15 * 60);
      }
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

    const refreshToken = this.tokenService.signAdminRefreshToken({ sub: admin.id });

    this.logger.log(`Admin login: ${admin.adminId} [${admin.role}] dari ${ipAddress}`);

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
   */
  async verifyAdmin2fa(
    tempToken: string,
    totpToken: string,
    ipAddress?: string,
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
    const attempts = await this.redis.incr(attemptKey);
    if (attempts === 1) {
      await this.redis.expire(attemptKey, 15 * 60);
    }
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
    const refreshToken = this.tokenService.signAdminRefreshToken({ sub: admin.id });
    this.logger.log(`Admin 2FA login: ${admin.adminId} [${admin.role}] dari ${ipAddress}`);

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

  async refreshAdminToken(
    refreshToken: string,
  ): Promise<{ accessToken: string; refreshToken: string }> {
    try {
      const payload = this.tokenService.verifyAdminRefreshToken(refreshToken);

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

        const newRefreshToken = this.tokenService.signAdminRefreshToken({ sub: admin.id });

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

  private async isAdminMfaRequired(): Promise<boolean> {
    try {
      const config = await this.prisma.systemConfig.findUnique({
        where: { key: 'admin_mfa_required' },
      });
      return config?.value === 'true';
    } catch (err) {
      this.logger.error('Failed to check admin MFA requirement from DB — defaulting to required (fail-closed)', err);
      return true;
    }
  }
}
