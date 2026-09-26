import { Controller, Post, Body, HttpCode, HttpStatus, Logger } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Public } from '../../common/decorators/public.decorator';
import { SubscriptionsService } from '../subscriptions/subscriptions.service';

/**
 * Webhook Flash Mobile (MNC) — QRIS payment notifications.
 *
 * URL didaftarkan di Flash Merchant Dashboard:
 *   https://api.kahade.id/v1/webhooks/flash/qris
 *
 * Flash melakukan POST JSON saat transaksi QRIS diproses. Kahade HARUS
 * membalas HTTP 200; Flash retry bila callback gagal.
 *
 * PENTING: dokumentasi Flash tidak menjelaskan signature webhook — keaslian
 * payload tidak bisa diverifikasi dari signature. SubscriptionsService
 * memverifikasi status aktual via Flash API sebelum aktivasi, dan hanya
 * mencocokkan transaction_id/external_id yang kita buat sendiri.
 */
@ApiTags('webhooks')
@Controller('webhooks/flash')
export class FlashWebhookController {
  private readonly logger = new Logger(FlashWebhookController.name);

  constructor(private readonly subscriptionsService: SubscriptionsService) {}

  @Public()
  @Throttle({ default: { ttl: 60000, limit: 200 } })
  @Post('qris')
  @HttpCode(HttpStatus.OK)
  async qrisWebhook(@Body() body: Record<string, unknown>): Promise<{ message: string }> {
    const data = (body?.data ?? body) as Record<string, unknown>;
    const transactionId = String(data?.transaction_id ?? data?.transactionId ?? '');
    const externalId = String(data?.external_id ?? data?.externalId ?? '');
    const status = String(data?.status ?? '').toUpperCase();

    this.logger.log(`Flash QRIS webhook: tx=${transactionId} ext=${externalId} status=${status}`);

    if (!transactionId && !externalId) {
      this.logger.warn('Flash QRIS webhook: payload tanpa transaction_id/external_id');
      return { message: 'ignored' };
    }

    // Hanya proses status final sukses; yang lain diabaikan (polling menangani).
    if (status === 'SUCCESS') {
      await this.subscriptionsService.activateQrisSubscription(transactionId, externalId);
    }

    // Selalu 200 agar Flash tidak retry tanpa henti.
    return { message: 'ok' };
  }
}
