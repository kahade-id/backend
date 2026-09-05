import { Controller, Post, Get, Body, Query, Req, Res, HttpCode, HttpStatus, UnauthorizedException, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import { Throttle } from '@nestjs/throttler';
import { Request, Response } from 'express';
import { AuthService } from './auth.service';
import { TokenService } from './token.service';
import { CaptchaService } from './captcha.service';
import { OtpGatewayService, OtpDeliveryMethod } from './otp-gateway.service';
import { CsrfService } from '../../common/services/csrf.service';
import { Public } from '../../common/decorators/public.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { UserThrottleGuard } from '../../common/guards/user-throttle.guard';
import { AllowResponseFields } from '../../common/decorators/allow-response-fields.decorator';
import * as ErrorCodes from '../../common/constants/error-codes';
import {
  RegisterDto,
  LoginDto,
  SetUsernameDto,
  VerifyEmailDto,
  ResendVerificationDto,
  Verify2faLoginDto,
  LogoutDto,
  ForgotPasswordDto,
  ResetPasswordDto,
  ChangePasswordDto,
  Setup2faDto,
  Enable2faDto,
  Disable2faDto,
  RegenerateBackupCodesDto,
  CorrectEmailDto,
  RefreshTokenDto,
  VerifyPasswordDto,
  RequestOtpDto,
  VerifyPhoneOtpDto,
  PhoneRegisterDto,
  RequestPhoneChangeDto,
  ConfirmPhoneChangeDto,
} from './dto';

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(
    private authService: AuthService,
    private tokenService: TokenService,
    private configService: ConfigService,
    private csrfService: CsrfService,
    private captchaService: CaptchaService,
    private otpGateway: OtpGatewayService,
  ) {}

  @Public()
  @Throttle({ default: { ttl: 60000, limit: 10 } })
  @Post('captcha/generate')
  @HttpCode(HttpStatus.OK)
  async generateCaptcha(): Promise<{ challengeId: string; targetX: number }> {
    return this.captchaService.generateChallenge();
  }

  /** Compute refresh cookie path at request time from live config. */
  private getRefreshCookiePath(): string {
    const prefix = this.configService.get<string>('app.apiPrefix') || 'v1';
    return `/${prefix}/auth/refresh`;
  }

  private useSecureAuthCookies(): boolean {
    const nodeEnv = this.configService.get<string>('app.nodeEnv') ?? process.env.NODE_ENV ?? 'production';
    const appUrl = this.configService.get<string>('app.appUrl') ?? '';
    let isLocalHttpDevelopment = false;
    try {
      const parsedUrl = new URL(appUrl);
      isLocalHttpDevelopment = ['development', 'test'].includes(nodeEnv)
        && parsedUrl.protocol === 'http:'
        && ['localhost', '127.0.0.1'].includes(parsedUrl.hostname.toLowerCase());
    } catch {
      // Invalid app URLs are rejected by startup validation; keep cookies secure here.
    }
    return !isLocalHttpDevelopment;
  }

  private setAccessTokenCookie(res: Response, accessToken: string): void {
    res.cookie('kahade_access_token', accessToken, {
      httpOnly: true,
      secure: this.useSecureAuthCookies(),
      sameSite: 'strict',
      path: '/',
      maxAge: 15 * 60 * 1000,
    });
  }

  private setRefreshTokenCookie(res: Response, refreshToken: string): void {
    res.cookie('kahade_refresh_token', refreshToken, {
      httpOnly: true,
      secure: this.useSecureAuthCookies(),
      sameSite: 'strict',
      path: this.getRefreshCookiePath(),
      maxAge: 7 * 24 * 60 * 60 * 1000,
    });
  }

  private clearAuthCookies(res: Response): void {
    res.clearCookie('kahade_access_token', { path: '/' });
    res.clearCookie('kahade_refresh_token', { path: this.getRefreshCookiePath() });
  }

  @UseGuards(UserThrottleGuard)
  @Get('csrf-token')
  @Throttle({ default: { ttl: 60000, limit: 10 } })
  @HttpCode(HttpStatus.OK)
  async getCsrfToken(
    @CurrentUser('sub') userId: string,
    @CurrentUser('jti') jti: string,
  ): Promise<{ csrfToken: string }> {
    const csrfToken = await this.csrfService.generateToken(userId, jti);
    return { csrfToken };
  }

  @Public()
  @Post('register')
  @Throttle({ default: { ttl: 3600000, limit: 5 } })
  @HttpCode(HttpStatus.CREATED)
  async register(@Body() dto: RegisterDto, @Req() req: Request): Promise<{ message: string }> {
    const emailAuthEnabled = this.configService.get<boolean>('app.emailAuthEnabled') ?? false;
    if (!emailAuthEnabled) {
      throw new UnauthorizedException({ code: 'EMAIL_AUTH_DISABLED', message: 'Email/password registration is not available. Please use phone number registration.' });
    }
    if (!dto.captchaId || dto.captchaAnswer === undefined) {
      throw new UnauthorizedException({ code: ErrorCodes.CAPTCHA_REQUIRED, message: 'Captcha verification is required' });
    }
    await this.captchaService.verifyChallenge(dto.captchaId, dto.captchaAnswer);
    return this.authService.register(dto, req.ip);
  }

  @Public()
  @Throttle({ default: { ttl: 60000, limit: 30 } })
  @Get('otp-methods')
  @HttpCode(HttpStatus.OK)
  async getOtpMethods(): Promise<{ methods: OtpDeliveryMethod[] }> {
    return { methods: this.otpGateway.getSupportedMethods() };
  }

  @Public()
  @Throttle({ default: { ttl: 60000, limit: 10 } })
  @Post('request-otp')
  @HttpCode(HttpStatus.OK)
  async requestOtp(
    @Body() dto: RequestOtpDto,
    @Req() req: Request,
  ): Promise<{ message: string; debugCode?: string }> {
    const ipAddress = req.ip || req.socket?.remoteAddress || 'unknown';
    return this.authService.requestPhoneOtp(dto.phoneNumber, dto.method, ipAddress, dto.deviceId);
  }

  @Public()
  @Throttle({ default: { ttl: 60000, limit: 10 } })
  @Post('verify-otp')
  @HttpCode(HttpStatus.OK)
  @AllowResponseFields('refreshToken')
  async verifyOtp(
    @Body() dto: VerifyPhoneOtpDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<Record<string, unknown>> {
    const ipAddress = req.ip || req.socket?.remoteAddress || 'unknown';
    const result = await this.authService.verifyPhoneOtp(dto.phoneNumber, dto.code, dto.deviceId, dto.deviceInfo, ipAddress);

    if (result.status === 'existing_user' && 'refreshToken' in result && result.refreshToken) {
      this.setRefreshTokenCookie(res, result.refreshToken);
      if ('accessToken' in result && result.accessToken) {
        this.setAccessTokenCookie(res, result.accessToken);
      }
    }

    return result as unknown as Record<string, unknown>;
  }

  @Public()
  @Throttle({ default: { ttl: 3600000, limit: 20 } })
  @Post('phone-register')
  @HttpCode(HttpStatus.CREATED)
  @AllowResponseFields('refreshToken')
  async phoneRegister(
    @Body() dto: PhoneRegisterDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<Record<string, unknown>> {
    const ipAddress = req.ip || req.socket?.remoteAddress || 'unknown';
    const deviceId = dto.deviceId;
    const deviceInfo = req.headers['user-agent'] || 'unknown';
    const result = await this.authService.phoneRegister(dto, deviceId, deviceInfo, ipAddress);

    this.setRefreshTokenCookie(res, result.refreshToken);
    this.setAccessTokenCookie(res, result.accessToken);

    return result as unknown as Record<string, unknown>;
  }

  @Throttle({ default: { ttl: 900000, limit: 5 } })
  @UseGuards(UserThrottleGuard)
  @Post('phone-change/request')
  @HttpCode(HttpStatus.OK)
  async requestPhoneChange(
    @CurrentUser('sub') userId: string,
    @Body() dto: RequestPhoneChangeDto,
    @Req() req: Request,
  ): Promise<{ message: string }> {
    const ipAddress = req.ip || req.socket?.remoteAddress || 'unknown';
    return this.authService.requestPhoneChange(userId, dto.newPhoneNumber, dto.currentPassword, dto.method, dto.mfaCode, ipAddress);
  }

  @Throttle({ default: { ttl: 60000, limit: 5 } })
  @UseGuards(UserThrottleGuard)
  @Post('phone-change/confirm')
  @HttpCode(HttpStatus.OK)
  async confirmPhoneChange(
    @CurrentUser('sub') userId: string,
    @Body() dto: ConfirmPhoneChangeDto,
  ): Promise<{ message: string }> {
    return this.authService.confirmPhoneChange(userId, dto.newPhoneNumber, dto.code);
  }

  @Throttle({ default: { ttl: 3600000, limit: 5 } })
  @UseGuards(UserThrottleGuard)
  @Post('set-username')
  @HttpCode(HttpStatus.OK)
  async setUsername(@CurrentUser('sub') userId: string, @Body() dto: SetUsernameDto): Promise<{ user: Record<string, unknown> }> {
    return this.authService.setUsername(userId, dto.username);
  }

  @Public()
  @Throttle({ default: { ttl: 60000, limit: 5 } })
  @Post('verify-email')
  @HttpCode(HttpStatus.OK)
  async verifyEmail(@Body() dto: VerifyEmailDto): Promise<{ message: string }> {
    return this.authService.verifyEmail(dto.email, dto.otp);
  }

  @Public()
  @Throttle({ default: { ttl: 60000, limit: 10 } })
  @Get('verify-email')
  async verifyEmailLink(
    @Query('email') email: string,
    @Query('token') token: string,
    @Res() res: Response,
  ): Promise<void> {
    const htmlPage = (title: string, heading: string, message: string, success: boolean): string => `<!doctype html>
<html lang="id">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>${title}</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #f7f7f7; color: #111; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; padding: 24px; }
  .card { background: #fff; border-radius: 16px; padding: 32px; max-width: 420px; width: 100%; box-shadow: 0 4px 24px rgba(0,0,0,0.06); text-align: center; }
  .icon { width: 56px; height: 56px; border-radius: 28px; margin: 0 auto 16px; display: flex; align-items: center; justify-content: center; font-size: 28px; color: #fff; background: ${success ? '#0C9C5F' : '#C62828'}; }
  h1 { font-size: 20px; margin: 0 0 8px; }
  p { font-size: 14px; color: #444; margin: 0 0 16px; line-height: 1.5; }
  a.btn { display: inline-block; padding: 10px 20px; border-radius: 8px; background: #0C9C5F; color: #fff; text-decoration: none; font-weight: 600; }
</style>
</head>
<body>
  <div class="card">
    <div class="icon">${success ? '✓' : '!'}</div>
    <h1>${heading}</h1>
    <p>${message}</p>
    <a class="btn" href="kahade://email-verified">Buka Aplikasi Kahade</a>
  </div>
</body>
</html>`;

    if (!email || !token) {
      res.status(HttpStatus.BAD_REQUEST).type('html').send(
        htmlPage('Verifikasi Email', 'Tautan Tidak Valid', 'Parameter email atau token hilang. Silakan minta ulang tautan verifikasi di aplikasi.', false),
      );
      return;
    }
    try {
      await this.authService.verifyEmail(email, token);
      res.status(HttpStatus.OK).type('html').send(
        htmlPage('Email Terverifikasi', 'Email Berhasil Diverifikasi', 'Terima kasih! Alamat email Anda sudah terverifikasi. Anda bisa melanjutkan menggunakan aplikasi Kahade.', true),
      );
    } catch {
      const humanMessage = 'Tautan verifikasi tidak valid atau sudah kedaluwarsa. Silakan minta tautan baru dari aplikasi Kahade.';
      res.status(HttpStatus.BAD_REQUEST).type('html').send(
        htmlPage('Verifikasi Gagal', 'Verifikasi Gagal', humanMessage, false),
      );
    }
  }

  @Public()
  @Throttle({ default: { ttl: 60000, limit: 3 } })
  @Post('resend-verification')
  @HttpCode(HttpStatus.OK)
  async resendVerification(@Body() dto: ResendVerificationDto, @Req() req: Request): Promise<{ message: string }> {
    return this.authService.resendVerification(dto.email, req.ip);
  }

  @Throttle({ default: { ttl: 60000, limit: 3 } })
  @UseGuards(UserThrottleGuard)
  @Post('correct-email')
  @HttpCode(HttpStatus.OK)
  async correctEmail(
    @CurrentUser('sub') userId: string,
    @Body() dto: CorrectEmailDto,
    @Req() req: Request,
  ): Promise<{ message: string }> {
    return this.authService.correctEmail(userId, dto.newEmail, dto.password, dto.mfaCode, req.ip);
  }

  @Public()
  @Throttle({ default: { ttl: 60000, limit: 5 } })
  @Post('login')
  @HttpCode(HttpStatus.OK)
  @AllowResponseFields('refreshToken')
  async login(
    @Body() dto: LoginDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<Record<string, unknown>> {
    const emailAuthEnabled = this.configService.get<boolean>('app.emailAuthEnabled') ?? false;
    if (!emailAuthEnabled) {
      throw new UnauthorizedException({ code: 'EMAIL_AUTH_DISABLED', message: 'Email/password login is not available. Please use phone number login.' });
    }
    if (!dto.captchaId || dto.captchaAnswer === undefined) {
      throw new UnauthorizedException({ code: ErrorCodes.CAPTCHA_REQUIRED, message: 'Captcha verification is required' });
    }
    await this.captchaService.verifyChallenge(dto.captchaId, dto.captchaAnswer);
    const ipAddress = req.ip || req.socket?.remoteAddress || 'unknown';
    const result = await this.authService.login(dto, ipAddress);

    if ('refreshToken' in result) {
      this.setRefreshTokenCookie(res, result.refreshToken);
      if ('accessToken' in result) {
        this.setAccessTokenCookie(res, result.accessToken);
      }
      return result;
    }

    return result;
  }

  @Public()
  @Post('2fa/verify-login')
  @Throttle({ default: { ttl: 60000, limit: 5 } })
  @HttpCode(HttpStatus.OK)
  @AllowResponseFields('refreshToken')
  async verify2faLogin(
    @Body() dto: Verify2faLoginDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<Record<string, unknown>> {
    const ipAddress = req.ip || req.socket?.remoteAddress || 'unknown';
    const deviceInfo = dto.deviceInfo || req.headers['user-agent'] || 'unknown';
    const result = await this.authService.verify2faLogin(dto.tempToken, dto.code, dto.deviceId, deviceInfo, ipAddress);

    this.setRefreshTokenCookie(res, result.refreshToken);
    this.setAccessTokenCookie(res, result.accessToken);
    return result;
  }

  @Public()
  @Throttle({ default: { ttl: 60000, limit: 10 } })
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @AllowResponseFields('refreshToken')
  async refreshToken(
    @Req() req: Request,
    @Body() body: RefreshTokenDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ accessToken: string; refreshToken?: string }> {
    const refreshToken = req.cookies?.kahade_refresh_token || body?.refreshToken;
    if (!refreshToken) {
      this.clearAuthCookies(res);
      throw new UnauthorizedException({ code: ErrorCodes.UNAUTHORIZED, message: 'Refresh token required' });
    }
    let result: { accessToken: string; refreshToken?: string };
    try {
      result = await this.authService.refreshToken(refreshToken);
    } catch (error) {
      // A rejected refresh must not leave a browser repeatedly sending an invalid,
      // expired, or revoked HTTP-only token cookie on each subsequent request.
      this.clearAuthCookies(res);
      throw error;
    }

    if (result['refreshToken']) {
      this.setRefreshTokenCookie(res, result['refreshToken'] as string);
    }

    if (result['accessToken']) {
      this.setAccessTokenCookie(res, result['accessToken'] as string);
    }

    return result;
  }

  @Throttle({ default: { ttl: 60000, limit: 10 } })
  @UseGuards(UserThrottleGuard)
  @Post('logout')
  @HttpCode(200)
  async logout(
    @CurrentUser('sub') userId: string,
    @CurrentUser('jti') accessTokenJti: string,
    @CurrentUser('sessionId') sessionId: string,
    @Body() dto: LogoutDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ message: string }> {
    this.clearAuthCookies(res);
    return this.authService.logout(userId, sessionId, accessTokenJti, dto.logoutAll ?? false);
  }

  @Public()
  @Throttle({ default: { ttl: 3600000, limit: 3 } })
  @Post('forgot-password')
  @HttpCode(HttpStatus.OK)
  async forgotPassword(@Body() dto: ForgotPasswordDto, @Req() req: Request): Promise<{ message: string }> {
    if (!dto.captchaId || dto.captchaAnswer === undefined) {
      throw new UnauthorizedException({ code: ErrorCodes.CAPTCHA_REQUIRED, message: 'Captcha verification is required' });
    }
    await this.captchaService.verifyChallenge(dto.captchaId, dto.captchaAnswer);
    const ipAddress = req.ip || req.socket?.remoteAddress || 'unknown';
    return this.authService.forgotPassword(dto.email, ipAddress);
  }

  @Public()
  @Throttle({ default: { ttl: 60000, limit: 5 } })
  @Post('reset-password')
  @HttpCode(HttpStatus.OK)
  async resetPassword(@Body() dto: ResetPasswordDto): Promise<{ message: string }> {
    return this.authService.resetPassword(dto.email, dto.otp, dto.newPassword, dto.confirmPassword);
  }

  @Throttle({ default: { ttl: 60000, limit: 5 } })
  @UseGuards(UserThrottleGuard)
  @Post('verify-password')
  @HttpCode(HttpStatus.OK)
  async verifyPassword(
    @CurrentUser('sub') userId: string,
    @Body() dto: VerifyPasswordDto,
  ): Promise<{ verified: boolean }> {
    return this.authService.verifyPassword(userId, dto.password);
  }

  @Throttle({ default: { ttl: 3600000, limit: 5 } })
  @UseGuards(UserThrottleGuard)
  @Post('change-password')
  @HttpCode(HttpStatus.OK)
  async changePassword(
    @CurrentUser('sub') userId: string,
    @CurrentUser('jti') accessTokenJti: string,
    @CurrentUser('sessionId') sessionId: string,
    @Body() dto: ChangePasswordDto,
  ): Promise<{ message: string }> {
    return this.authService.changePassword(userId, dto, accessTokenJti, sessionId);
  }

  @Throttle({ default: { ttl: 60000, limit: 10 } })
  @Get('2fa/status')
  @HttpCode(HttpStatus.OK)
  async get2faStatus(@CurrentUser('sub') userId: string): Promise<{ enabled: boolean }> {
    return this.authService.get2faStatus(userId);
  }

  @Throttle({ default: { ttl: 3600000, limit: 5 } })
  @UseGuards(UserThrottleGuard)
  @Post('2fa/setup')
  @HttpCode(HttpStatus.OK)
  @AllowResponseFields('secret', 'backupCodes')
  async setup2fa(@CurrentUser('sub') userId: string, @Body() dto: Setup2faDto): Promise<{ secret: string; qrCodeUrl: string; otpauthUrl: string; backupCodes: string[] }> {
    return this.authService.setup2fa(userId, dto.password);
  }

  @Throttle({ default: { ttl: 3600000, limit: 5 } })
  @UseGuards(UserThrottleGuard)
  @Post('2fa/enable')
  @HttpCode(HttpStatus.OK)
  async enable2fa(@CurrentUser('sub') userId: string, @Body() dto: Enable2faDto): Promise<{ message: string }> {
    return this.authService.enable2fa(userId, dto.code);
  }

  @Throttle({ default: { ttl: 60000, limit: 3 } })
  @UseGuards(UserThrottleGuard)
  @Post('2fa/request-disable-otp')
  @HttpCode(HttpStatus.OK)
  async requestDisable2faOtp(@CurrentUser('sub') userId: string, @Req() req: Request): Promise<{ message: string }> {
    return this.authService.requestDisable2faOtp(userId, req.ip);
  }

  @Throttle({ default: { ttl: 60000, limit: 5 } })
  @UseGuards(UserThrottleGuard)
  @Post('2fa/disable')
  @HttpCode(HttpStatus.OK)
  async disable2fa(@CurrentUser('sub') userId: string, @Body() dto: Disable2faDto): Promise<{ message: string }> {
    return this.authService.disable2fa(userId, dto.password, dto.code, dto.emailOtpCode);
  }

  @Throttle({ default: { ttl: 3600000, limit: 3 } })
  @UseGuards(UserThrottleGuard)
  @Post('2fa/backup-codes/regenerate')
  @HttpCode(HttpStatus.OK)
  @AllowResponseFields('backupCodes')
  async regenerateBackupCodes(
    @CurrentUser('sub') userId: string,
    @Body() dto: RegenerateBackupCodesDto,
  ): Promise<{ backupCodes: string[] }> {
    return this.authService.regenerateBackupCodes(userId, dto.password, dto.code);
  }
}
