import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  Req,
  Res,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { Throttle, SkipThrottle } from '@nestjs/throttler';
import { ConfigService } from '@nestjs/config';
import type { Request, Response } from 'express';
import { PasskeyService } from './passkey.service';
import {
  PasskeyRegisterOptionsDto,
  PasskeyRegisterVerifyDto,
  PasskeyAuthOptionsDto,
  PasskeyAuthVerifyDto,
  PasskeyRenameDto,
  PasskeyRevokeDto,
  PasskeyRecoverDto,
} from './dto/passkey.dto';
import { Public } from '../../common/decorators/public.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { AllowResponseFields } from '../../common/decorators/allow-response-fields.decorator';

/**
 * Passkey / WebAuthn (GAP-A: G026–G050).
 *
 * Rute:
 *   POST /v1/auth/passkey/register/options  (auth + re-auth) — G027
 *   POST /v1/auth/passkey/register/verify   (auth)           — G028
 *   POST /v1/auth/passkey/auth/options      (publik)         — G029
 *   POST /v1/auth/passkey/auth/verify       (publik)         — G030
 *   GET  /v1/auth/passkey                    (auth)           — G035
 *   PATCH /v1/auth/passkey/:id              (auth + re-auth) — G036
 *   DELETE /v1/auth/passkey/:id             (auth + re-auth) — G037
 *   POST /v1/auth/passkey/recover           (auth)           — G039
 *
 * Catatan: re-auth untuk PATCH/DELETE dikirim di body (PasskeyRenameDto /
 * PasskeyRevokeDto membawa field password/mfaCode/otpCode/reauthToken).
 * Private key tidak pernah dikirim ke server — klien hanya mengirim
 * attestation/assertion hasil navigator.credentials (G041).
 */
@ApiTags('auth-passkey')
@Controller('auth/passkey')
export class PasskeyController {
  constructor(private readonly passkeyService: PasskeyService) {}

  private clientIp(req: Request): string {
    return req.ip || req.socket?.remoteAddress || 'unknown';
  }

  // ── Registrasi ────────────────────────────────────────────────────

  @Throttle({ default: { ttl: 60000, limit: 10 } })
  @Post('register/options')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Minta opsi registrasi passkey (perlu re-auth)' })
  async registerOptions(
    @CurrentUser('sub') userId: string,
    @Body() dto: PasskeyRegisterOptionsDto,
    @Req() req: Request,
  ) {
    return this.passkeyService.getRegistrationOptions(userId, dto, this.clientIp(req));
  }

  @Throttle({ default: { ttl: 60000, limit: 5 } })
  @Post('register/verify')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Verifikasi attestation & simpan passkey' })
  async registerVerify(
    @CurrentUser('sub') userId: string,
    @Body() dto: PasskeyRegisterVerifyDto,
    @Req() req: Request,
  ) {
    return this.passkeyService.verifyRegistration(userId, dto, this.clientIp(req));
  }

  // ── Login ─────────────────────────────────────────────────────────

  @Public()
  @Throttle({ default: { ttl: 60000, limit: 10 } })
  @Post('auth/options')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Minta opsi autentikasi passkey (publik)' })
  async authOptions(@Body() dto: PasskeyAuthOptionsDto) {
    return this.passkeyService.getAuthenticationOptions(dto);
  }

  @Public()
  @Throttle({ default: { ttl: 60000, limit: 5 } })
  @Post('auth/verify')
  @HttpCode(HttpStatus.OK)
  @AllowResponseFields('refreshToken')
  @ApiOperation({ summary: 'Verifikasi assertion & terbitkan sesi (publik)' })
  async authVerify(
    @Body() dto: PasskeyAuthVerifyDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.passkeyService.verifyAuthentication(dto, this.clientIp(req));
    // BFI-034: samakan dengan endpoint penerbit token lain di auth.controller
    // (login/verify-otp/social): refreshToken lolos interceptor + cookie
    // httpOnly untuk web. Tanpa ini sesi passkey mati tiap 15 menit.
    const rec = result as unknown as Record<string, unknown> | null;
    if (rec && typeof rec.refreshToken === 'string' && rec.refreshToken) {
      this.setRefreshTokenCookie(res, rec.refreshToken);
      if (typeof rec.accessToken === 'string' && rec.accessToken) {
        this.setAccessTokenCookie(res, rec.accessToken);
      }
    }
    return result;
  }

  // ── Manajemen ─────────────────────────────────────────────────────

  @Get()
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Daftar passkey milik akun (tanpa public key mentah)' })
  async list(@CurrentUser('sub') userId: string) {
    const items = await this.passkeyService.listCredentials(userId);
    return { items };
  }

  @Throttle({ default: { ttl: 60000, limit: 10 } })
  @Patch(':id')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Ganti nama passkey (perlu re-auth)' })
  async rename(
    @CurrentUser('sub') userId: string,
    @Param('id') id: string,
    @Body() dto: PasskeyRenameDto,
  ) {
    return this.passkeyService.renameCredential(userId, id, dto);
  }

  @Throttle({ default: { ttl: 60000, limit: 10 } })
  @Delete(':id')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Hapus (revoke) passkey — soft delete (perlu re-auth)' })
  async revoke(
    @CurrentUser('sub') userId: string,
    @Param('id') id: string,
    @Body() dto: PasskeyRevokeDto,
    @Req() req: Request,
  ) {
    return this.passkeyService.revokeCredential(userId, id, dto, this.clientIp(req));
  }

  // ── Recovery (G039) ───────────────────────────────────────────────

  @Throttle({ default: { ttl: 60000, limit: 5 } })
  @Post('recover')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Pemulihan passkey via OTP WhatsApp (2 langkah: request → verify)',
  })
  async recover(
    @CurrentUser('sub') userId: string,
    @Body() dto: PasskeyRecoverDto,
    @Req() req: Request,
  ) {
    return this.passkeyService.recover(userId, dto, this.clientIp(req));
  }

  // ── Kebijakan (G044) ──────────────────────────────────────────────

  @SkipThrottle()
  @Get('policy/required-for')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Daftar aksi berisiko yang mewajibkan passkey/re-auth (PASSKEY_REQUIRED_FOR)' })
  async policy() {
    return { requiredFor: this.passkeyService.getRequiredForActions() };
  }
}
