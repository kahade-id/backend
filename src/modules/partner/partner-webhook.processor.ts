// GAP-F (G464/G466/G470): Bull processor for outbound webhook delivery.
// - Signs payload: HMAC-SHA256(secret, `${timestamp}.${eventId}.${body}`)
// - Headers: X-Kahade-Signature, X-Kahade-Timestamp, X-Kahade-Event-Id
// - fetch with redirect:'manual' → any 3xx is treated as failure (no redirect follow)
// - On failure: exponential retry (1m/5m/15m/1h/6h), then DLQ after 6 attempts.

import { Processor, Process } from '@nestjs/bull';
import { Injectable, Logger } from '@nestjs/common';
import { Job } from 'bull';
import { PARTNER_WEBHOOK_MAX_ATTEMPTS, PARTNER_WEBHOOK_QUEUE } from './partner.constants';
import { signWebhookPayload } from './webhook-signer.util';
import { PartnerWebhookService, WebhookDeliveryJobData } from './partner-webhook.service';

const FETCH_TIMEOUT_MS = 15_000;

@Processor(PARTNER_WEBHOOK_QUEUE)
@Injectable()
export class PartnerWebhookProcessor {
  private readonly logger = new Logger(PartnerWebhookProcessor.name);

  constructor(private readonly webhooks: PartnerWebhookService) {}

  @Process({ name: 'deliver', concurrency: 10 })
  async handleDeliver(job: Job<WebhookDeliveryJobData>): Promise<void> {
    const { deliveryId, endpointId, eventId, eventType, attempt } = job.data;
    const ctx = await this.webhooks.getDeliveryContext(deliveryId);
    if (!ctx) {
      this.logger.warn(`Delivery ${deliveryId} not found — dropping job`);
      return;
    }
    const { endpoint, secret, delivery } = ctx;

    if (!secret) {
      await this.webhooks.recordAttemptResult(deliveryId, endpointId, false, null, 'secret unavailable (fail-closed)', attempt);
      await this.failOrRetry(job, deliveryId, 'secret unavailable');
      return;
    }

    const payload = delivery['payload'] as Record<string, unknown>;
    const body = JSON.stringify(payload);
    const timestamp = Date.now().toString();
    const signature = signWebhookPayload(secret, timestamp, eventId, body);

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
      let res: Response;
      try {
        res = await fetch(endpoint.url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-kahade-signature': signature,
            'x-kahade-timestamp': timestamp,
            'x-kahade-event-id': eventId,
            'user-agent': 'Kahade-Webhooks/1.0',
          },
          body,
          redirect: 'manual', // G470: never follow redirects
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }

      if (res.status >= 300 && res.status < 400) {
        throw new Error(`redirect ditolak (HTTP ${res.status}) — tidak mengikuti redirect`);
      }
      // Drain body without storing it (lastError is redacted).
      await res.arrayBuffer().catch(() => undefined);

      if (res.status >= 200 && res.status < 300) {
        await this.webhooks.recordAttemptResult(deliveryId, endpointId, true, res.status, null, attempt);
        this.logger.log(`Webhook ${eventType} delivered to ${endpointId} (attempt ${attempt})`);
        return;
      }
      throw new Error(`HTTP ${res.status}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.webhooks.recordAttemptResult(deliveryId, endpointId, false, null, message, attempt);
      await this.failOrRetry(job, deliveryId, message);
    }
  }

  private async failOrRetry(job: Job<WebhookDeliveryJobData>, deliveryId: string, message: string): Promise<void> {
    const attempt = job.data.attempt;
    if (attempt >= PARTNER_WEBHOOK_MAX_ATTEMPTS) {
      await this.webhooks.markDead(deliveryId, message);
      return;
    }
    await this.webhooks.enqueueRetry(job.data);
  }
}
