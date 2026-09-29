import { Body, Controller, Headers, HttpCode, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { RawBodyRequest } from '@nestjs/common';
import { Public } from '../../common/decorators/public.decorator';
import { Throttle } from '@nestjs/throttler';
import { DanaWebhookSettlementService } from './dana-webhook-settlement.service';

/**
 * DANA finish-notify webhook.
 *
 * URL: POST /v1/webhooks/dana/payment
 * (didaftarkan di DANA dashboard sebagai NOTIFICATION url)
 *
 * Selalu balas 200 untuk outcome bisnis (diproses / duplikat / diabaikan)
 * agar DANA tidak retry tanpa henti. Signature invalid → 403.
 * Body mentah (rawBody) WAJIB diverifikasi sebelum JSON di-parse.
 */
@Controller('webhooks/dana')
export class DanaWebhookController {
  constructor(private readonly settlement: DanaWebhookSettlementService) {}

  @Post('payment')
  @Public()
  @Throttle({ default: { ttl: 60000, limit: 120 } })
  @HttpCode(200)
  async finishNotify(
    @Req() req: RawBodyRequest<Request>,
    @Headers() headers: Record<string, string | string[] | undefined>,
    @Body() _body: unknown,
  ): Promise<{ message: string }> {
    // main.ts sudah mengaktifkan rawBody: true.
    const rawBody = (req.rawBody as Buffer | undefined)?.toString('utf8') ?? '';
    return this.settlement.handleFinishNotify(rawBody, headers, req.path);
  }
}
