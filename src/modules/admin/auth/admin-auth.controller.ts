import { Controller, Post, Get, Body, Req, Res, UseGuards, HttpCode, HttpStatus, UnauthorizedException } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiResponse, ApiBody } from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import { Request, Response } from 'express';
import { AdminAuthService } from './admin-auth.service';
import { AdminLoginDto } from './dto/admin-login.dto';
import { AdminVerify2faDto } from './dto/admin-verify-2fa.dto';
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
  ) {}

  private getRefreshCookiePath(): string {
    const prefix = this.configService.get<string>('app.apiPrefix') || 'v1';
    return `/${prefix}/admin/auth`;
  }

  private setRefreshCookie(res: Response, token: string): void {
    res.cookie(ADMIN_REFRESH_COOKIE, token, {
      httpOnly: true,
      secure: true,
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
    | { accessToken: string; admin: { id: string; adminId: string; fullName: string; email: string; role: string; isActive: boolean; isMfaEnabled: boolean; lastLoginAt: string | null } }
  > {
    const ip = req.ip || 'unknown';
    const result = await this.adminAuthService.login(dto.email, dto.password, dto.totpToken, ip);

    if ('requiresMfa' in result) return result;
    if ('requiresMfaSetup' in result) return result;

    this.setRefreshCookie(res, result.refreshToken);
    const { refreshToken: _rt, ...body } = result;
    return body;
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
    const result = await this.adminAuthService.verifyAdmin2fa(dto.tempToken, dto.totpToken, ip);

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
   * 03-#8: mulai enroll MFA admin. Body: { tempToken } dari login yang
   * mengembalikan requiresMfaSetup. Mengembalikan otpauthUrl + secret
   * untuk dipindai di aplikasi authenticator.
   */
  @Public()
  @Throttle({ default: { ttl: 300000, limit: 5 } })
  @Post('mfa/setup')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Admin MFA setup — get TOTP secret (requiresMfaSetup tempToken)' })
  @ApiResponse({ status: 200, description: 'otpauthUrl + secret returned.' })
  async mfaSetup(
    @Body() dto: { tempToken: string },
  ): Promise<{ otpauthUrl: string; secret: string }> {
    return this.adminAuthService.setupMfa(dto.tempToken);
  }

  /**
   * 03-#8: selesaikan enroll MFA. Body: { tempToken, totpToken }.
   * Mengembalikan sesi penuh (accessToken + refresh cookie).
   */
  @Public()
  @Throttle({ default: { ttl: 300000, limit: 5 } })
  @Post('mfa/enable')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Admin MFA enable — verify TOTP and activate MFA' })
  @ApiResponse({ status: 200, description: 'MFA enabled; session tokens returned.' })
  async mfaEnable(
    @Body() dto: { tempToken: string; totpToken: string },
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ accessToken: string; admin: { id: string; adminId: string; fullName: string; email: string; role: string; isActive: boolean; isMfaEnabled: boolean; lastLoginAt: string | null } }> {
    const ip = req.ip || 'unknown';
    const result = await this.adminAuthService.enableMfa(dto.tempToken, dto.totpToken, ip);

    this.setRefreshCookie(res, result.refreshToken);
    const { refreshToken: _rt, ...body } = result;
    return body;
  }
}
