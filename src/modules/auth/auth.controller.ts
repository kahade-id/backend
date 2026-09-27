import {
  Controller,
  Post,
  Get,
  Delete,
  Body,
  Param,
  Query,
  Req,
  Res,
  HttpCode,
  HttpStatus,
  GoneException,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import { Throttle } from '@nestjs/throttler';
import { Request, Response } from 'express';
import { AuthService, type SocialLoginResult, type SocialLoginPendingLink } from './auth.service';
import { CaptchaService } from './captcha.service';
import { AccountDeletionService } from '../users/account-deletion.service';
import { OtpGatewayService, OtpDeliveryMethod } from './otp-gateway.service';
import { CsrfService } from '../../common/services/csrf.service';
import { Public } from '../../common/decorators/public.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { UserThrottleGuard } from '../../common/guards/user-throttle.guard';
import { AllowResponseFields } from '../../common/decorators/allow-response-fields.decorator';
import * as ErrorCodes from '../../common/constants/error-codes';
import {
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
  VerifyPhoneOtpDto,
  PhoneRegisterDto,
  RequestPhoneChangeDto,
  ConfirmPhoneChangeDto,
  SocialLoginDto,
  LinkSocialProviderDto,
  ConfirmSocialLinkDto,
  UnlinkSocialProviderDto,
  RequestOtpTriggerDto,
  ConfirmPhoneMigrationDto,
  DeletionStatusRequestDto,
  DeletionStatusVerifyDto,
  DeletionCancelDto,
} from './dto';
import {
  OtpTriggerService,
  type TriggerPayload,
  type OtpTriggerStatus,
} from './otp-trigger.service';

/** Type guard G014: hasil social-login berupa permintaan konfirmasi taut. */
function isSocialLoginPendingLink(
  r: SocialLoginResult | SocialLoginPendingLink,
): r is SocialLoginPendingLink {
  return (r as SocialLoginPendingLink).requiresLink === true;
}

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(
    private authService: AuthService,
    private configService: ConfigService,
    private csrfService: CsrfService,
    private captchaService: CaptchaService,
    private otpGateway: OtpGatewayService,
    private otpTriggerService: OtpTriggerService,
    private accountDeletionService: AccountDeletionService,
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
    const nodeEnv =
      this.configService.get<string>('app.nodeEnv') ?? process.env.NODE_ENV ?? 'production';
    const appUrl = this.configService.get<string>('app.appUrl') ?? '';
    let isLocalHttpDevelopment = false;
    try {
      const parsedUrl = new URL(appUrl);
      isLocalHttpDevelopment =
        ['development', 'test'].includes(nodeEnv) &&
        parsedUrl.protocol === 'http:' &&
        ['localhost', '127.0.0.1'].includes(parsedUrl.hostname.toLowerCase());
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
  @HttpCode(HttpStatus.GONE)
  async register(): Promise<never> {
    throw new GoneException({
      code: 'AUTH_FLOW_DEPRECATED',
      message: 'Pendaftaran email sudah tidak tersedia. Daftar dengan nomor HP via OTP WhatsApp.',
    });
  }

  @Public()
  @Throttle({ default: { ttl: 60000, limit: 30 } })
  @Get('otp-methods')
  @HttpCode(HttpStatus.OK)
  async getOtpMethods(): Promise<{ methods: OtpDeliveryMethod[] }> {
    return { methods: this.otpGateway.getSupportedMethods() };
  }

  /**
   * GAP-A (G052): status penghapusan akun pra-login — langkah 1.
   * Body { phoneNumber } atau { email } → bila ada request aktif, kirim OTP
   * via WhatsApp ke nomor terdaftar. TIDAK membuat sesi login.
   */
  @Public()
  @Throttle({ default: { ttl: 3600000, limit: 5 } })
  @Post('deletion/status')
  @HttpCode(HttpStatus.OK)
  async requestDeletionStatus(
    @Body() dto: DeletionStatusRequestDto,
  ): Promise<{ requiresOtp: boolean; maskedPhone?: string }> {
    return this.accountDeletionService.requestStatusOtp({
      phoneNumber: dto.phoneNumber,
      email: dto.email,
    });
  }

  /**
   * GAP-A (G052/G064): status penghapusan akun pra-login — langkah 2.
   * Verifikasi OTP → status lengkap + deletionToken sekali-pakai
   * (scope 'deletion_cancel', TTL 15 menit). TIDAK membuat sesi login.
   */
  @Public()
  @Throttle({ default: { ttl: 3600000, limit: 10 } })
  @Post('deletion/status/verify')
  @HttpCode(HttpStatus.OK)
  async verifyDeletionStatus(@Body() dto: DeletionStatusVerifyDto): Promise<{
    referenceCode: string;
    status: string;
    requestedAt: Date;
    purgeAt: Date;
    daysRemaining: number;
    serverNow: Date;
    deletionToken: string;
    deletionTokenExpiresIn: number;
  }> {
    return this.accountDeletionService.verifyStatusOtp(
      { phoneNumber: dto.phoneNumber, email: dto.email },
      dto.otp,
    );
  }

  /**
   * GAP-A (G053): batalkan penghapusan akun pra-login.
   * Butuh deletionToken dari status/verify; reaktivasi transaksional;
   * sesi lama tetap revoked (user login ulang normal).
   */
  @Public()
  @Throttle({ default: { ttl: 3600000, limit: 10 } })
  @Post('deletion/cancel')
  @HttpCode(HttpStatus.OK)
  async cancelAccountDeletion(@Body() dto: DeletionCancelDto): Promise<{
    message: string;
    referenceCode: string;
    status: string;
    reactivatedAt: Date;
    serverNow: Date;
  }> {
    return this.accountDeletionService.cancelDeletion(dto.deletionToken, dto.cancelReason);
  }

  @Public()
  @Post('request-otp')
  @HttpCode(HttpStatus.GONE)
  async requestOtp(): Promise<never> {
    throw new GoneException({
      code: 'AUTH_FLOW_DEPRECATED',
      message:
        'Pengiriman OTP langsung sudah tidak tersedia. Minta kode via WhatsApp ke nomor resmi Kahade.',
    });
  }

  /**
   * Satu-satunya cara memperoleh OTP: user-initiated via WhatsApp.
   * Response berisi refCode + link wa.me; user mengirim "KAHADE <refCode>"
   * ke +6285786035715, lalu bot membalas OTP.
   */
  @Public()
  @Throttle({ default: { ttl: 60000, limit: 10 } })
  @Post('otp-trigger')
  @HttpCode(HttpStatus.OK)
  async otpTrigger(
    @Body() dto: RequestOtpTriggerDto,
    @Req() req: Request,
  ): Promise<TriggerPayload> {
    const ipAddress = req.ip || req.socket?.remoteAddress || 'unknown';
    return this.otpTriggerService.createTrigger(dto, ipAddress);
  }

  @Public()
  @Throttle({ default: { ttl: 60000, limit: 30 } })
  @Get('otp-trigger/status/:refCode')
  @HttpCode(HttpStatus.OK)
  async otpTriggerStatus(
    @Param('refCode') refCode: string,
  ): Promise<{ status: OtpTriggerStatus }> {
    const { status } = await this.otpTriggerService.getTriggerStatus(refCode);
    return { status };
  }

  /**
   * Webhook pesan masuk Fonnte. Diproteksi shared secret (bukan JWT user).
   * Secret dapat dikirim via header `x-fonnte-secret` (DISARANKAN), field body
   * `webhookSecret`, atau query param `?webhookSecret=` (cara Fonnte
   * menempelkan secret di URL webhook dashboard).
   *
   * SEC-003: query param DIDUKUNG untuk kompatibilitas, tapi TIDAK DISARANKAN —
   * full URL tercatat di nginx access log sehingga secret terekspos di log.
   * Pakai header `x-fonnte-secret` atau field body bila dashboard Fonnte
   * mendukungnya.
   *
   * Selalu 200 — Fonnte me-retry bila respons non-2xx.
   */
  @Public()
  @Post('webhooks/fonnte')
  @HttpCode(HttpStatus.OK)
  async fonnteWebhook(@Body() body: Record<string, unknown>, @Req() req: Request): Promise<{ ok: true }> {
    const q = req.query as Record<string, unknown> | undefined;
    const secret =
      (req.headers['x-fonnte-secret'] as string | undefined) ??
      (typeof body.webhookSecret === 'string' ? body.webhookSecret : undefined) ??
      (typeof q?.webhookSecret === 'string' ? (q.webhookSecret as string) : undefined) ??
      (typeof q?.secret === 'string' ? (q.secret as string) : undefined);
    if (!this.otpTriggerService.verifyWebhookSecret(secret)) {
      throw new UnauthorizedException({
        code: ErrorCodes.UNAUTHORIZED,
        message: 'Invalid webhook secret',
      });
    }
    await this.otpTriggerService.handleFonnteWebhook(body);
    return { ok: true };
  }

  /**
   * Konfirmasi migrasi nomor HP untuk akun lama. Menerbitkan sesi penuh
   * (atau requires2FA bila 2FA aktif).
   */
  @Public()
  @Throttle({ default: { ttl: 60000, limit: 10 } })
  @Post('migrate-phone/confirm')
  @HttpCode(HttpStatus.OK)
  @AllowResponseFields('refreshToken')
  async confirmPhoneMigration(
    @Body() dto: ConfirmPhoneMigrationDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<Record<string, unknown>> {
    const ipAddress = req.ip || req.socket?.remoteAddress || 'unknown';
    const deviceInfo = req.headers['user-agent'] || 'unknown';
    const result = await this.authService.confirmPhoneMigration(
      {
        tempToken: dto.tempToken,
        deviceId: dto.deviceId,
        deviceInfo,
        location: dto.location,
      },
      ipAddress,
    );
    if ('refreshToken' in result && result.refreshToken) {
      this.setRefreshTokenCookie(res, result.refreshToken);
      if ('accessToken' in result && result.accessToken) {
        this.setAccessTokenCookie(res, result.accessToken);
      }
    }
    return result as unknown as Record<string, unknown>;
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
    const result = await this.authService.verifyPhoneOtp(
      dto.phoneNumber,
      dto.code,
      dto.deviceId,
      dto.deviceInfo,
      ipAddress,
      dto.location,
    );

    if (result.status === 'existing_user' && 'refreshToken' in result && result.refreshToken) {
      this.setRefreshTokenCookie(res, result.refreshToken);
      if ('accessToken' in result && result.accessToken) {
        this.setAccessTokenCookie(res, result.accessToken);
      }
    }

    return result as unknown as Record<string, unknown>;
  }

  @Public()
  @Throttle({ default: { ttl: 60000, limit: 10 } })
  @Post('social-login')
  @HttpCode(HttpStatus.OK)
  @AllowResponseFields('refreshToken')
  async socialLogin(
    @Body() dto: SocialLoginDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<Record<string, unknown>> {
    const ipAddress = req.ip || req.socket?.remoteAddress || 'unknown';
    const deviceInfo = dto.deviceInfo || req.headers['user-agent'] || 'unknown';
    try {
      // G011: nonce diteruskan untuk verifikasi Apple (anti-replay).
      const result = await this.authService.socialLogin(
        dto.provider, dto.idToken, dto.deviceId, deviceInfo, ipAddress, dto.nonce,
      );
      if (isSocialLoginPendingLink(result)) {
        // G014: konflik email → aplikasi menampilkan layar konfirmasi taut
        // (re-auth akun lama wajib di /social/link/confirm).
        // Identitas baru (isNewIdentity) → aplikasi mengarahkan ke pendaftaran
        // nomor HP; linkToken (scope social_signup) ditautkan di phone-register.
        return result as unknown as Record<string, unknown>;
      }
      this.setRefreshTokenCookie(res, result.refreshToken);
      this.setAccessTokenCookie(res, result.accessToken);
      return result as unknown as Record<string, unknown>;
    } catch (error: any) {
      const response = error?.getResponse?.();
      if (response && typeof response === 'object' && (response as any).code === 'TWO_FA_REQUIRED') {
        return { requires2FA: true, tempToken: (response as any).tempToken };
      }
      throw error;
    }
  }

  /**
   * GAP-A (G003): kontrak kapabilitas provider login sosial.
   * Public, tanpa PII — aplikasi memakai ini untuk menampilkan/
   * menyembunyikan tombol Google & Apple (G002) tanpa menebak env.
   */
  @Public()
  @Get('social/providers')
  async getSocialProviders(): Promise<{
    providers: { provider: 'GOOGLE' | 'APPLE'; enabled: boolean; appId: string | null }[];
  }> {
    return this.authService.getSocialProviders();
  }

  /**
   * GAP-A (G018): daftar provider yang tertaut ke akun ini.
   * Menampilkan provider + email + waktu taut — tanpa token provider.
   */
  @Get('social')
  async listSocialProviders(@CurrentUser('sub') userId: string) {
    return { items: await this.authService.getLinkedSocialProviders(userId) };
  }

  /**
   * GAP-A (G013): tautkan Google/Apple dari akun yang sedang login.
   * Wajib re-auth (password/OTP + TOTP bila 2FA aktif); persetujuan
   * dicatat sebelum profil provider dipakai (G020).
   */
  @Throttle({ default: { ttl: 60000, limit: 10 } })
  @Post('social/link')
  @HttpCode(HttpStatus.OK)
  async linkSocialProvider(
    @CurrentUser('sub') userId: string,
    @Body() dto: LinkSocialProviderDto,
    @Req() req: Request,
  ) {
    const ipAddress = req.ip || req.socket?.remoteAddress || 'unknown';
    return this.authService.linkSocialProvider(
      userId, dto.provider, dto.idToken, dto.nonce,
      { password: dto.password, mfaCode: dto.mfaCode, otpCode: dto.otpCode },
      ipAddress,
    );
  }

  /**
   * GAP-A (G014): konfirmasi penautan setelah konflik email pada login sosial.
   * linkToken sekali-pakai dari respons { requiresLink: true }.
   */
  @Public()
  @Throttle({ default: { ttl: 60000, limit: 10 } })
  @Post('social/link/confirm')
  @HttpCode(HttpStatus.OK)
  @AllowResponseFields('refreshToken')
  async confirmSocialLink(
    @Body() dto: ConfirmSocialLinkDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<Record<string, unknown>> {
    const ipAddress = req.ip || req.socket?.remoteAddress || 'unknown';
    const deviceInfo = dto.deviceInfo || req.headers['user-agent'] || 'unknown';
    try {
      const result = await this.authService.confirmSocialLink(
        dto.linkToken,
        {
          password: dto.password,
          mfaCode: dto.mfaCode,
          otpCode: dto.otpCode,
          reauthToken: dto.reauthToken,
        },
        dto.deviceId,
        deviceInfo,
        ipAddress,
      );
      this.setRefreshTokenCookie(res, result.refreshToken);
      this.setAccessTokenCookie(res, result.accessToken);
      return result as unknown as Record<string, unknown>;
    } catch (error: any) {
      const response = error?.getResponse?.();
      if (response && typeof response === 'object' && (response as any).code === 'TWO_FA_REQUIRED') {
        return { requires2FA: true, tempToken: (response as any).tempToken };
      }
      throw error;
    }
  }

  /**
   * GAP-A (G019): lepas tautan provider. Wajib re-auth; menolak bila ini
   * satu-satunya metode login yang tersisa.
   */
  @Throttle({ default: { ttl: 60000, limit: 10 } })
  @Delete('social/:provider')
  async unlinkSocialProvider(
    @CurrentUser('sub') userId: string,
    @Param('provider') provider: string,
    @Body() dto: UnlinkSocialProviderDto,
    @Req() req: Request,
  ) {
    if (provider !== 'google' && provider !== 'apple') {
      throw new GoneException({ code: 'SOCIAL_PROVIDER_NOT_SUPPORTED', message: 'Provider tidak dikenal.' });
    }
    const ipAddress = req.ip || req.socket?.remoteAddress || 'unknown';
    return this.authService.unlinkSocialProvider(
      userId, provider, { password: dto.password, mfaCode: dto.mfaCode, otpCode: dto.otpCode }, ipAddress,
    );
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
    const deviceInfo = req.headers['user-agent'] || 'unknown';
    const result = await this.authService.phoneRegister(
      {
        tempToken: dto.tempToken,
        fullName: dto.fullName,
        username: dto.username,
        password: dto.password,
        deviceId: dto.deviceId,
        deviceInfo,
        location: dto.location,
        referralCode: dto.referralCode,
        socialLinkToken: dto.socialLinkToken,
      },
      ipAddress,
    );

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
    return this.authService.requestPhoneChange(
      userId,
      dto.newPhoneNumber,
      dto.currentPassword,
      dto.mfaCode,
      ipAddress,
    );
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
  async setUsername(
    @CurrentUser('sub') userId: string,
    @Body() dto: SetUsernameDto,
  ): Promise<{ user: Record<string, unknown> }> {
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
    const appStoreUrl = this.configService.get<string>('app.appStoreUrl') || 'https://apps.apple.com/app/kahade';
    const playStoreUrl = this.configService.get<string>('app.playStoreUrl') || 'https://play.google.com/store/apps/details?id=id.kahade.app';
    const webAppUrl = this.configService.get<string>('app.webAppUrl') || this.configService.get<string>('app.appUrl') || 'https://kahade.id';

    const htmlPage = (
      title: string,
      heading: string,
      message: string,
      success: boolean,
    ): string => `<!doctype html>
<html lang="id">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>${title}</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #f7f7f7; color: #111; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; padding: 24px; }
  .card { background: #fff; border-radius: 16px; padding: 32px; max-width: 440px; width: 100%; box-shadow: 0 4px 24px rgba(0,0,0,0.06); text-align: center; }
  .icon { width: 56px; height: 56px; border-radius: 28px; margin: 0 auto 16px; display: flex; align-items: center; justify-content: center; font-size: 28px; color: #fff; background: ${success ? '#0C9C5F' : '#C62828'}; }
  h1 { font-size: 20px; margin: 0 0 8px; }
  p { font-size: 14px; color: #444; margin: 0 0 16px; line-height: 1.6; }
  a.btn { display: inline-block; padding: 12px 24px; border-radius: 8px; background: #0C9C5F; color: #fff; text-decoration: none; font-weight: 600; margin: 4px; }
  a.btn.secondary { background: #f0f0f0; color: #333; }
  .store-links { margin-top: 20px; padding-top: 16px; border-top: 1px solid #eee; }
  .store-links p { font-size: 12px; color: #888; }
  .hidden { display: none; }
</style>
</head>
<body>
  <div class="card">
    <div class="icon">${success ? '✓' : '!'}</div>
    <h1>${heading}</h1>
    <p>${message}</p>
    ${success ? `
    <div id="actions">
      <a class="btn" id="openAppBtn" href="kahade://email-verified">Buka Aplikasi Kahade</a>
      <a class="btn secondary" href="${webAppUrl}">Buka di Browser</a>
    </div>
    <div class="store-links" id="storeFallback">
      <p>Belum punya aplikasi? Download sekarang:</p>
      <a class="btn secondary" href="${playStoreUrl}" target="_blank" rel="noopener">Google Play</a>
      <a class="btn secondary" href="${appStoreUrl}" target="_blank" rel="noopener">App Store</a>
    </div>
    <script>
      (function() {
        var openAppBtn = document.getElementById('openAppBtn');
        var storeFallback = document.getElementById('storeFallback');
        var appScheme = 'kahade://email-verified';
        var attempted = false;
        function tryOpenApp() {
          if (attempted) return;
          attempted = true;
          var start = Date.now();
          var iframe = document.createElement('iframe');
          iframe.style.display = 'none';
          iframe.src = appScheme;
          document.body.appendChild(iframe);
          setTimeout(function() {
            document.body.removeChild(iframe);
            if (Date.now() - start < 2500) {
              if (storeFallback) storeFallback.style.display = 'block';
            }
          }, 2000);
        }
        if (/Android|iPhone|iPad|iPod/i.test(navigator.userAgent)) {
          setTimeout(tryOpenApp, 500);
        }
        if (openAppBtn) {
          openAppBtn.addEventListener('click', function(e) {
            e.preventDefault();
            tryOpenApp();
            setTimeout(function() { window.location.href = appScheme; }, 100);
          });
        }
      })();
    </script>
    ` : `
    <div>
      <a class="btn secondary" href="${webAppUrl}">Ke Halaman Utama</a>
    </div>
    `}
  </div>
</body>
</html>`;

    if (!email || !token) {
      res
        .status(HttpStatus.BAD_REQUEST)
        .type('html')
        .send(
          htmlPage(
            'Verifikasi Email',
            'Tautan Tidak Valid',
            'Parameter email atau token hilang. Silakan minta ulang tautan verifikasi di aplikasi.',
            false,
          ),
        );
      return;
    }
    try {
      await this.authService.verifyEmail(email, token);
      res
        .status(HttpStatus.OK)
        .type('html')
        .send(
          htmlPage(
            'Email Terverifikasi',
            'Email Berhasil Diverifikasi',
            'Terima kasih! Alamat email Anda sudah terverifikasi. Anda bisa melanjutkan menggunakan aplikasi Kahade.',
            true,
          ),
        );
    } catch {
      const humanMessage =
        'Tautan verifikasi tidak valid atau sudah kedaluwarsa. Silakan minta tautan baru dari aplikasi Kahade.';
      res
        .status(HttpStatus.BAD_REQUEST)
        .type('html')
        .send(htmlPage('Verifikasi Gagal', 'Verifikasi Gagal', humanMessage, false));
    }
  }

  @Public()
  @Throttle({ default: { ttl: 60000, limit: 3 } })
  @Post('resend-verification')
  @HttpCode(HttpStatus.OK)
  async resendVerification(
    @Body() dto: ResendVerificationDto,
    @Req() req: Request,
  ): Promise<{ message: string }> {
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
    const ipAddress = req.ip || req.socket?.remoteAddress || 'unknown';
    const captchaRequired = await this.captchaService.shouldRequireLoginCaptcha(ipAddress);
    if (captchaRequired) {
      if (!dto.captchaId || dto.captchaAnswer === undefined) {
        throw new UnauthorizedException({
          code: ErrorCodes.CAPTCHA_REQUIRED,
          message: 'Captcha verification is required after repeated failed login attempts',
        });
      }
      await this.captchaService.verifyChallenge(dto.captchaId, dto.captchaAnswer);
    }

    let result: Awaited<ReturnType<AuthService['login']>>;
    try {
      result = await this.authService.login(
        {
          identifier: dto.identifier,
          password: dto.password,
          deviceId: dto.deviceId,
          deviceInfo: dto.deviceInfo,
          location: dto.location,
        },
        ipAddress,
      );
    } catch (error) {
      const response = error instanceof UnauthorizedException ? error.getResponse() : null;
      const code =
        typeof response === 'object' && response !== null && 'code' in response
          ? (response as { code?: unknown }).code
          : undefined;
      if (code === ErrorCodes.INVALID_CREDENTIALS) {
        await this.captchaService.recordLoginFailure(ipAddress);
      }
      throw error;
    }
    await this.captchaService.clearLoginFailures(ipAddress);

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
    const result = await this.authService.verify2faLogin(
      dto.tempToken,
      dto.code,
      dto.deviceId,
      deviceInfo,
      ipAddress,
    );

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
      throw new UnauthorizedException({
        code: ErrorCodes.UNAUTHORIZED,
        message: 'Refresh token required',
      });
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
  async forgotPassword(
    @Body() dto: ForgotPasswordDto,
    @Req() req: Request,
  ): Promise<TriggerPayload> {
    const ipAddress = req.ip || req.socket?.remoteAddress || 'unknown';
    return this.authService.forgotPassword(
      { identifier: dto.identifier, deviceId: dto.deviceId, location: dto.location },
      ipAddress,
    );
  }

  @Public()
  @Throttle({ default: { ttl: 60000, limit: 5 } })
  @Post('reset-password')
  @HttpCode(HttpStatus.OK)
  async resetPassword(
    @Body() dto: ResetPasswordDto,
    @Req() req: Request,
  ): Promise<{ message: string }> {
    const ipAddress = req.ip || req.socket?.remoteAddress || 'unknown';
    return this.authService.resetPassword(
      {
        tempToken: dto.tempToken,
        newPassword: dto.newPassword,
        confirmPassword: dto.confirmPassword,
        location: dto.location,
      },
      ipAddress,
    );
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
    @Req() req: Request,
  ): Promise<{ message: string }> {
    const ipAddress = req.ip || req.socket?.remoteAddress || 'unknown';
    return this.authService.changePassword(userId, dto, accessTokenJti, sessionId, ipAddress);
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
  async setup2fa(
    @CurrentUser('sub') userId: string,
    @Body() dto: Setup2faDto,
  ): Promise<{ secret: string; qrCodeUrl: string; otpauthUrl: string; backupCodes: string[] }> {
    return this.authService.setup2fa(userId, dto.password);
  }

  @Throttle({ default: { ttl: 3600000, limit: 5 } })
  @UseGuards(UserThrottleGuard)
  @Post('2fa/enable')
  @HttpCode(HttpStatus.OK)
  async enable2fa(
    @CurrentUser('sub') userId: string,
    @Body() dto: Enable2faDto,
  ): Promise<{ message: string }> {
    return this.authService.enable2fa(userId, dto.code);
  }

  @Throttle({ default: { ttl: 60000, limit: 3 } })
  @UseGuards(UserThrottleGuard)
  @Post('2fa/request-disable-otp')
  @HttpCode(HttpStatus.OK)
  async requestDisable2faOtp(
    @CurrentUser('sub') userId: string,
    @Req() req: Request,
  ): Promise<{ message: string }> {
    return this.authService.requestDisable2faOtp(userId, req.ip);
  }

  @Throttle({ default: { ttl: 60000, limit: 5 } })
  @UseGuards(UserThrottleGuard)
  @Post('2fa/disable')
  @HttpCode(HttpStatus.OK)
  async disable2fa(
    @CurrentUser('sub') userId: string,
    @Body() dto: Disable2faDto,
  ): Promise<{ message: string }> {
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
