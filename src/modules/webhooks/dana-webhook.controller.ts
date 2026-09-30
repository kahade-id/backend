import { Body, Controller, Headers, HttpCode, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { RawBodyRequest } from '@nestjs/common';
import { Public } from '../../common/decorators/public.decorator';
import { Throttle } from '@nestjs/throttler';
import { DanaWebhookSettlementService, DanaWebhookOutcome } from './dana-webhook-settlement.service';
import { DanaWebhookDisbursementService } from './dana-webhook-disbursement.service';

/**
 * DANA finish-notify webhook.
 *
 * URL: POST /v1/webhooks/dana/payment
 * (didaftarkan di DANA dashboard sebagai NOTIFICATION url)
 *
 * Selalu balas 200 + {responseCode: '2005600'} untuk outcome bisnis
 * (diproses / duplikat / diabaikan) agar DANA tidak retry tanpa henti
 * dan skenario notify mandatory terverifikasi. Signature invalid → 403.
 * Body mentah (rawBody) WAJIB diverifikasi sebelum JSON di-parse.
 *
 * Disbursement notify:
 * URL: POST /v1/webhooks/dana/disbursement
 * (didaftarkan di DANA dashboard sebagai Disbursement Notify URL)
 * Balas 200 + {responseCode: '2004300'} untuk outcome bisnis.
 */
@Controller('webhooks/dana')
export class DanaWebhookController {
  constructor(
    private readonly settlement: DanaWebhookSettlementService,
    private readonly disbursement: DanaWebhookDisbursementService,
  ) {}

  @Post('payment')
  @Public()
  @Throttle({ default: { ttl: 60000, limit: 120 } })
  @HttpCode(200)
  async finishNotify(
    @Req() req: RawBodyRequest<Request>,
    @Headers() headers: Record<string, string | string[] | undefined>,
    @Body() _body: unknown,
  ): Promise<DanaWebhookOutcome> {
    // main.ts sudah mengaktifkan rawBody: true.
    const rawBody = (req.rawBody as Buffer | undefined)?.toString('utf8') ?? '';
    return this.settlement.handleFinishNotify(rawBody, headers, req.path);
  }

  @Post('disbursement')
  @Public()
  @Throttle({ default: { ttl: 60000, limit: 120 } })
  @HttpCode(200)
  async disbursNotify(
    @Req() req: RawBodyRequest<Request>,
    @Headers() headers: Record<string, string | string[] | undefined>,
    @Body() _body: unknown,
  ): Promise<DanaWebhookOutcome> {
    const rawBody = (req.rawBody as Buffer | undefined)?.toString('utf8') ?? '';
    return this.disbursement.handleDisbursNotify(rawBody, headers, req.path);
  }
}
