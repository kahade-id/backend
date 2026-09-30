import { Controller, Post, Get, Body, Req, Res, UseGuards, HttpCode, HttpStatus, UnauthorizedException } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiResponse, ApiBody } from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import { Request, Response } from 'express';
import { AdminAuthService } from './admin-auth.service';
import { AdminLoginDto } from './dto/admin-login.dto';
import { AdminVerify2faDto } from './dto/admin-verify-2fa.dto';
import { AdminMfaSetupDto } from './dto/admin-mfa-setup.dto';
import { AdminMfaEnableDto } from './dto/admin-mfa-enable.dto';
import { AdminChangePasswordDto } from './dto/admin-change-password.dto';
import { AdminFirstPasswordChangeDto } from './dto/admin-first-password-change.dto';
import { CaptchaService } from '../../auth/captcha.service';
import { JwtAdminGuard } from '../../../common/guards/jwt-admin.guard';
import { CurrentAdmin } from '../../../common/decorators/current-admin.decorator';
import { Public, AdminRoute } from '../../../common/decorators/public.decorator';
import { AdminJwtPayload } from '../../../common/types/jwt-payload.types';
import * as ErrorCodes from '../../../common/constants/error-codes';
import { UserThrottleGuard } from '../../../common/guards/user-throttle.guard';

const ADMIN_REFRESH_COOKIE = 'kahade_admin_refresh';

@ApiTags('admin-auth')
@AdminRoute()
@Controller('admin/auth')
export class AdminAuthController {
  constructor(
    private readonly adminAuthService: AdminAuthService,
    private readonly configService: ConfigService,
    // AUT-003: tantangan captcha slider untuk endpoint publik generate.
    private readonly captchaService: CaptchaService,
  ) {}

  private getRefreshCookiePath(): string {
    const prefix = this.configService.get<string>('app.apiPrefix') || 'v1';
    return `/${prefix}/admin/auth`;
  }

  private setRefreshCookie(res: Response, token: string): void {
    // ADM-423: `secure` hanya di production — hardcoded `secure: true` merusak
    // alur refresh saat dev lokal via HTTP.
    const isProduction = this.configService.get<string>('app.nodeEnv') === 'production';
    res.cookie(ADMIN_REFRESH_COOKIE, token, {
      httpOnly: true,
      secure: isProduction,
      sameSite: 'strict',
      path: this.getRefreshCookiePath(),
      maxAge: 7 * 24 * 60 * 60 * 1000,
    });
  }

  private clearRefreshCookie(res: Response): void {
    res.clearCookie(ADMIN_REFRESH_COOKIE, { path: this.getRefreshCookiePath() });
  }

  @Public()
  @Throttle({ default: { ttl: 900000, limit: 5 } })
  @Post('login')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Admin login' })
  @ApiBody({ type: AdminLoginDto })
  @ApiResponse({ status: 200, description: 'Login successful, MFA required (requiresMfa: true + tempToken), or MFA setup required (requiresMfaSetup: true + tempToken).' })
  async login(
    @Body() dto: AdminLoginDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<
    | { requiresMfa: true; tempToken: string }
    | { requiresMfaSetup: true; tempToken: string }
    | { requiresPasswordChange: true; tempToken: string }
    | { accessToken: string; admin: { id: string; adminId: string; fullName: string; email: string; role: string; isActive: boolean; isMfaEnabled: boolean; lastLoginAt: string | null } }
  > {
    const ip = req.ip || 'unknown';
    const userAgent = req.headers['user-agent'];
    // AUT-001: deviceId diikat ke tempToken. AUT-003: captchaId/captchaAnswer
    // dicek di service (throttle adaptif, pola yang sama dengan mobile).
    const result = await this.adminAuthService.login(
      dto.email,
      dto.password,
      dto.totpToken,
      ip,
      userAgent,
      dto.deviceId,
      dto.captchaId,
      dto.captchaAnswer,
    );

    if ('requiresMfa' in result) return result;
    if ('requiresMfaSetup' in result) return result;
    if ('requiresPasswordChange' in result) return result;

    this.setRefreshCookie(res, result.refreshToken);
    const { refreshToken: _rt, ...body } = result;
    return body;
  }

  /**
   * AUT-003: hasilkan tantangan slider captcha (protokol yang sama dengan
   * mobile — GET challenge {challengeId, targetX} → slider 0–100 → kirim
   * captchaId + captchaAnswer ke /admin/auth/login).
   */
  @Public()
  @Throttle({ default: { ttl: 60000, limit: 10 } })
  @Post('captcha/generate')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Generate slider captcha challenge (required after repeated failed logins)' })
  @ApiResponse({ status: 200, description: 'Captcha challenge returned.' })
  async generateCaptcha(): Promise<{ challengeId: string; targetX: number }> {
    const challenge = await this.captchaService.generateChallenge();
    return { challengeId: challenge.challengeId, targetX: challenge.targetX };
  }

  @Public()
  @Throttle({ default: { ttl: 300000, limit: 5 } })
  @Post('2fa/verify')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Admin 2FA verify — exchange tempToken + TOTP for session tokens' })
  @ApiResponse({ status: 200, description: 'Login successful.' })
  @ApiResponse({ status: 401, description: 'TempToken expired or invalid 2FA code.' })
  async verify2fa(
    @Body() dto: AdminVerify2faDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ accessToken: string; admin: { id: string; adminId: string; fullName: string; email: string; role: string; isActive: boolean; isMfaEnabled: boolean; lastLoginAt: string | null } }> {
    const ip = req.ip || 'unknown';
    const userAgent = req.headers['user-agent'];
    // AUT-001: tempToken terikat deviceId — perangkat peminta harus sama.
    const result = await this.adminAuthService.verifyAdmin2fa(dto.tempToken, dto.totpToken, ip, userAgent, dto.deviceId);

    this.setRefreshCookie(res, result.refreshToken);
    const { refreshToken: _rt, ...body } = result;
    return body;
  }

  @Public()
  @Throttle({ default: { ttl: 900000, limit: 10 } })
  @Post('refresh')
  @ApiOperation({ summary: 'Refresh admin token' })
  @ApiResponse({ status: 200, description: 'New access token returned.' })
  @ApiResponse({ status: 401, description: 'Refresh token is invalid or expired.' })
  async refreshToken(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ accessToken: string }> {
    const refreshToken: string | undefined = req.cookies?.[ADMIN_REFRESH_COOKIE];
    if (!refreshToken) {
      this.clearRefreshCookie(res);
      throw new UnauthorizedException({ code: ErrorCodes.TOKEN_REQUIRED, message: 'Refresh token required' });
    }
    let result: { accessToken: string; refreshToken: string };
    try {
      result = await this.adminAuthService.refreshAdminToken(refreshToken);
    } catch (error) {
      // Prevent browsers from retrying with a revoked/expired HTTP-only cookie.
      this.clearRefreshCookie(res);
      throw error;
    }

    this.setRefreshCookie(res, result.refreshToken);
    return { accessToken: result.accessToken };
  }

  // Logout must be reachable by any authenticated admin regardless of role. This
  // controller declares no @AdminRoles, and AdminRolesGuard fails closed when no
  // roles are configured, so including it here returned 403 for every admin.
  @UseGuards(JwtAdminGuard, UserThrottleGuard)
  @ApiBearerAuth('access-token')
  @Post('logout')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Admin logout' })
  @ApiResponse({ status: 200, description: 'Logout successful.' })
  @ApiResponse({ status: 401, description: 'Invalid token.' })
  async logout(
    @CurrentAdmin() admin: AdminJwtPayload,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ message: string }> {
    const refreshToken: string | undefined = req.cookies?.[ADMIN_REFRESH_COOKIE];
    this.clearRefreshCookie(res);
    return this.adminAuthService.logout(admin.sub, admin.jti, req.ip || 'unknown', refreshToken);
  }

  // ADM-420: self-service "keluar dari semua perangkat". Bisa diakses semua role
  // (tanpa @AdminRoles — hanya JwtAdminGuard; AdminRolesGuard fail-closed bila
  // dipasang tanpa metadata). Mencabut SEMUA sesi milik sendiri termasuk sesi
  // saat ini — klien wajib redirect ke /login setelah 200.
  @UseGuards(JwtAdminGuard, UserThrottleGuard)
  @ApiBearerAuth('access-token')
  @Post('sessions/revoke-all')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Cabut semua sesi milik sendiri',
    description:
      'Self-service: mencabut seluruh sesi login admin pemanggil (semua perangkat), ' +
      'termasuk sesi yang dipakai memanggil endpoint ini. Token akses & refresh ikut mati. ' +
      'Klien wajib mengarahkan ke /login setelah respons 200.',
  })
  @ApiResponse({ status: 200, description: 'All own sessions revoked; re-login required.' })
  @ApiResponse({ status: 401, description: 'Invalid token.' })
  async revokeAllOwnSessions(
    @CurrentAdmin() admin: AdminJwtPayload,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ message: string; revokedCount: number }> {
    this.clearRefreshCookie(res);
    return this.adminAuthService.revokeAllOwnSessions(admin.sub, req.ip || 'unknown');
  }

  @UseGuards(JwtAdminGuard)
  @ApiBearerAuth('access-token')
  @Get('profile')
  @ApiOperation({ summary: 'Get admin profile' })
  @ApiResponse({ status: 200, description: 'Admin profile returned.' })
  @ApiResponse({ status: 401, description: 'Admin token is invalid or expired.' })
  async getProfile(
    @CurrentAdmin() admin: AdminJwtPayload,
  ): Promise<{ id: string; adminId: string; fullName: string; email: string; role: string; isActive: boolean; isMfaEnabled: boolean; lastLoginAt: Date | null; lastLoginIp: string | null }> {
    return this.adminAuthService.getProfile(admin.sub);
  }

  /**
   * 03-#8: mulai enroll MFA admin. Body: { tempToken, deviceId? } dari login yang
   * mengembalikan requiresMfaSetup. Mengembalikan otpauthUrl + secret
   * untuk dipindai di aplikasi authenticator.
   * AUT-001: tempToken terikat deviceId (seperti alur 2FA).
   */
  @Public()
  @Throttle({ default: { ttl: 300000, limit: 5 } })
  @Post('mfa/setup')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Admin MFA setup — get TOTP secret (requiresMfaSetup tempToken)' })
  @ApiResponse({ status: 200, description: 'otpauthUrl + secret returned.' })
  async mfaSetup(
    @Body() dto: AdminMfaSetupDto,
  ): Promise<{ otpauthUrl: string; secret: string }> {
    return this.adminAuthService.setupMfa(dto.tempToken, dto.deviceId);
  }

  /**
   * 03-#8: selesaikan enroll MFA. Body: { tempToken, totpToken, deviceId? }.
   * Mengembalikan sesi penuh (accessToken + refresh cookie).
   * AUT-001: tempToken terikat deviceId (seperti alur 2FA).
   */
  @Public()
  @Throttle({ default: { ttl: 300000, limit: 5 } })
  @Post('mfa/enable')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Admin MFA enable — verify TOTP and activate MFA' })
  @ApiResponse({ status: 200, description: 'MFA enabled; session tokens returned.' })
  async mfaEnable(
    @Body() dto: AdminMfaEnableDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ accessToken: string; admin: { id: string; adminId: string; fullName: string; email: string; role: string; isActive: boolean; isMfaEnabled: boolean; lastLoginAt: string | null } }> {
    const ip = req.ip || 'unknown';
    const userAgent = req.headers['user-agent'];
    const result = await this.adminAuthService.enableMfa(dto.tempToken, dto.totpToken, ip, userAgent, dto.deviceId);

    this.setRefreshCookie(res, result.refreshToken);
    const { refreshToken: _rt, ...body } = result;
    return body;
  }

  /**
   * AUT-002: ganti password sendiri (autentikasi ulang password lama).
   * Butuh JWT admin. Setelah ganti, semua sesi dicabut — klien wajib login
   * ulang dengan password baru.
   */
  @UseGuards(JwtAdminGuard, UserThrottleGuard)
  @ApiBearerAuth('access-token')
  @Post('change-password')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Change own admin password (requires current password)' })
  @ApiResponse({ status: 200, description: 'Password changed; all sessions revoked.' })
  @ApiResponse({ status: 401, description: 'Current password is incorrect.' })
  async changePassword(
    @Body() dto: AdminChangePasswordDto,
    @CurrentAdmin('sub') adminId: string,
    @Req() req: Request,
  ): Promise<{ message: string }> {
    return this.adminAuthService.changePassword(adminId, dto.currentPassword, dto.newPassword, req.ip || 'unknown');
  }

  /**
   * AUT-011: ganti password pertama untuk admin yang flag
   * mustChangePassword-nya true (dibuat baru / di-reset SUPER_ADMIN).
   * Public — otorisasi via tempToken scope admin_password_change (terikat
   * deviceId, AUT-001). Tidak menerbitkan sesi; klien login ulang.
   */
  @Public()
  @Throttle({ default: { ttl: 300000, limit: 5 } })
  @Post('first-password-change')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'First password change (requiresPasswordChange tempToken from login)' })
  @ApiResponse({ status: 200, description: 'Password changed; client must log in again.' })
  @ApiResponse({ status: 401, description: 'TempToken expired or not valid for this device.' })
  async firstPasswordChange(
    @Body() dto: AdminFirstPasswordChangeDto,
    @Req() req: Request,
  ): Promise<{ message: string }> {
    return this.adminAuthService.acceptFirstPasswordChange(dto.tempToken, dto.newPassword, req.ip || 'unknown', dto.deviceId);
  }
}
