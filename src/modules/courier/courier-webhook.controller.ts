/**
 * courier-webhook.controller.ts — webhook tracking provider (G235).
 *
 * URL didaftarkan di dashboard tiap provider:
 *   https://api.kahade.id/v1/webhooks/courier/:provider
 * Header yang diharapkan:
 *   X-Courier-Signature: sha256=<hex(hmac_sha256(rawBody, secret))>
 *   X-Courier-Idempotency-Key: <unik per event> (opsional, dianjurkan)
 *
 * FAIL-CLOSED: signature tidak valid / secret belum dikonfigurasi → 401/403,
 * event tidak diproses. Idempotency: event yang sama (kunci provider atau
 * hash payload) hanya diproses sekali (G237).
 */
import { Controller, HttpCode, HttpStatus, Param, Post, Req, Headers, Logger } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { RawBodyRequest } from '@nestjs/common/interfaces';
import { Request } from 'express';
import { Throttle } from '@nestjs/throttler';
import { Public } from '../../common/decorators/public.decorator';
import { CourierService } from './courier.service';

@ApiTags('webhooks')
@Controller('webhooks/courier')
export class CourierWebhookController {
  private readonly logger = new Logger(CourierWebhookController.name);

  constructor(private readonly courierService: CourierService) {}

  @Public()
  @Throttle({ default: { ttl: 60000, limit: 300 } })
  @Post(':provider')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Terima webhook tracking dari provider kurir' })
  async receive(
    @Param('provider') provider: string,
    @Req() req: RawBodyRequest<Request>,
    @Headers('x-courier-signature') signature?: string,
    @Headers('x-courier-idempotency-key') idempotencyKey?: string,
  ): Promise<{ message: string; outcome?: string }> {
    // rawBody tersedia karena NestFactory.create(..., { rawBody: true }).
    const rawBody: Buffer = req.rawBody ?? Buffer.from(JSON.stringify(req.body ?? {}));
    this.logger.log(`Webhook kurir diterima: provider=${provider} bytes=${rawBody.length}`);
    const result = await this.courierService.handleWebhook(provider, rawBody, signature, idempotencyKey);
    // Selalu 200 (kecuali signature invalid → exception 401/403) agar
    // provider tidak retry tanpa henti.
    return { message: 'ok', outcome: result.outcome };
  }
}
