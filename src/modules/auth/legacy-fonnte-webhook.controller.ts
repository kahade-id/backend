import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';
import { Public } from '../../common/decorators/public.decorator';
import * as ErrorCodes from '../../common/constants/error-codes';
import { OtpTriggerService } from './otp-trigger.service';

/**
 * Alias kompatibilitas untuk webhook Fonnte lama.
 *
 * Dashboard Fonnte masih mengarah ke `POST /v1/webhooks/whatsapp`
 * (path sebelum auth-rework). Route ini meneruskan ke handler yang sama
 * dengan `/v1/auth/webhooks/fonnte` agar pesan masuk tetap diproses
 * tanpa harus mengubah konfigurasi dashboard terlebih dahulu.
 */
@Controller('webhooks')
export class LegacyFonnteWebhookController {
  constructor(private readonly otpTriggerService: OtpTriggerService) {}

  @Public()
  @Post('whatsapp')
  @HttpCode(HttpStatus.OK)
  async whatsappWebhook(
    @Body() body: Record<string, unknown>,
    @Req() req: Request,
  ): Promise<{ ok: true }> {
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
}
