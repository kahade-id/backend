// GAP-F (G463/G466/G467/G468/G469): outbound webhook endpoint management +
// dispatch (Bull queue with exponential retry + DLQ). Secrets are AES-encrypted
// with the existing PII pattern and NEVER returned via API.

import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bull';
import { Queue, Job } from 'bull';
import { randomBytes, randomUUID } from 'crypto';
import { PrismaService } from '../../prisma/prisma.service';
import { encryptPii, decryptPiiSafe } from '../../common/utils/pii.util';
import {
  PARTNER_WEBHOOK_EVENTS,
  PARTNER_WEBHOOK_MAX_ATTEMPTS,
  PARTNER_WEBHOOK_PAYLOAD_VERSION,
  PARTNER_WEBHOOK_QUEUE,
  PARTNER_WEBHOOK_RETRY_DELAYS_MS,
} from './partner.constants';
import { validateWebhookUrl, WebhookUrlValidationError } from './ssrf.util';
import { signWebhookPayload } from './webhook-signer.util';
import { PartnerRequestIdentity } from './partner.decorators';
import {
  CreateWebhookEndpointDto,
  UpdateWebhookEndpointDto,
} from './dto/partner.dto';

export interface WebhookEndpointRecord {
  id: string;
  clientId: string;
  url: string;
  events: string[];
  secretEnc: string;
  isActive: boolean;
  verifiedAt: Date | null;
  challengeToken: string | null;
  challengeIssuedAt: Date | null;
  lastDeliveryAt: Date | null;
  lastDeliveryStatus: string | null;
  createdAt: Date;
}

export interface WebhookDeliveryJobData {
  deliveryId: string;
  endpointId: string;
  eventId: string;
  eventType: string;
  attempt: number; // 1-based
}

interface WebhookPrisma {
  partnerWebhookEndpoint: {
    create(args: unknown): Promise<WebhookEndpointRecord>;
    findMany(args?: unknown): Promise<WebhookEndpointRecord[]>;
    findUnique(args: unknown): Promise<WebhookEndpointRecord | null>;
    update(args: unknown): Promise<WebhookEndpointRecord>;
    delete(args: unknown): Promise<unknown>;
  };
  partnerWebhookDelivery: {
    create(args: unknown): Promise<Record<string, unknown>>;
    findMany(args?: unknown): Promise<Array<Record<string, unknown>>>;
    findUnique(args: unknown): Promise<Record<string, unknown> | null>;
    update(args: unknown): Promise<Record<string, unknown>>;
    count(args?: unknown): Promise<number>;
  };
  apiClient: {
    findUnique(args: unknown): Promise<{ id: string; isSandbox: boolean; status: string } | null>;
  };
}

/** Compute retry delay for the given attempt (1-based). Exported for tests. */
export function retryDelayForAttempt(attempt: number): number | null {
  if (attempt < 1 || attempt > PARTNER_WEBHOOK_MAX_ATTEMPTS) return null;
  if (attempt === PARTNER_WEBHOOK_MAX_ATTEMPTS) return null; // last attempt → DLQ
  return PARTNER_WEBHOOK_RETRY_DELAYS_MS[attempt - 1];
}

@Injectable()
export class PartnerWebhookService {
  private readonly logger = new Logger(PartnerWebhookService.name);

  constructor(
    private readonly prisma: PrismaService,
    @InjectQueue(PARTNER_WEBHOOK_QUEUE) private readonly queue: Queue<WebhookDeliveryJobData>,
  ) {}

  private get p(): WebhookPrisma {
    return this.prisma as unknown as WebhookPrisma;
  }

  // ---------- Endpoint CRUD (admin) ----------

  async createEndpoint(
    clientId: string,
    dto: CreateWebhookEndpointDto,
    adminId: string,
    ip: string,
  ): Promise<{ endpoint: Record<string, unknown>; secret: string }> {
    const client = await this.p.apiClient.findUnique({ where: { id: clientId } });
    if (!client) throw new NotFoundException({ code: 'PARTNER_CLIENT_NOT_FOUND', message: 'Client tidak ditemukan' });

    let url: string;
    try {
      url = await validateWebhookUrl(dto.url);
    } catch (err) {
      if (err instanceof WebhookUrlValidationError) {
        throw new BadRequestException({ code: 'PARTNER_WEBHOOK_URL_REJECTED', message: err.message });
      }
      throw err;
    }

    const secret = randomBytes(32).toString('base64url');
    const endpoint = await this.p.partnerWebhookEndpoint.create({
      data: {
        clientId,
        url,
        events: dto.events,
        secretEnc: await encryptPii(secret),
        isActive: false, // activated only after ownership verification (G463)
      },
    });
    this.logger.log(`Webhook endpoint ${endpoint.id} registered for client ${clientId} (pending verification)`);
    return { endpoint: this.redactEndpoint(endpoint), secret };
  }

  async listEndpoints(clientId: string): Promise<unknown[]> {
    const rows = await this.p.partnerWebhookEndpoint.findMany({
      where: { clientId },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map((e) => this.redactEndpoint(e));
  }

  async updateEndpoint(clientId: string, endpointId: string, dto: UpdateWebhookEndpointDto): Promise<unknown> {
    const endpoint = await this.mustOwn(clientId, endpointId);
    const data: Record<string, unknown> = {};
    if (dto.url !== undefined) {
      try {
        data['url'] = await validateWebhookUrl(dto.url);
      } catch (err) {
        if (err instanceof WebhookUrlValidationError) {
          throw new BadRequestException({ code: 'PARTNER_WEBHOOK_URL_REJECTED', message: err.message });
        }
        throw err;
      }
      // URL changed → require re-verification.
      data['isActive'] = false;
      data['verifiedAt'] = null;
    }
    if (dto.events !== undefined) data['events'] = dto.events;
    if (dto.isActive !== undefined) {
      if (dto.isActive && !endpoint.verifiedAt) {
        throw new BadRequestException({
          code: 'PARTNER_WEBHOOK_UNVERIFIED',
          message: 'Endpoint belum terverifikasi kepemilikannya — selesaikan verifikasi challenge dulu',
        });
      }
      data['isActive'] = dto.isActive;
    }
    const updated = await this.p.partnerWebhookEndpoint.update({ where: { id: endpointId }, data });
    return this.redactEndpoint(updated);
  }

  async deleteEndpoint(clientId: string, endpointId: string): Promise<void> {
    await this.mustOwn(clientId, endpointId);
    await this.p.partnerWebhookEndpoint.delete({ where: { id: endpointId } });
  }

  // ---------- Ownership verification (G463) ----------

  /**
   * Step 1: POST a challenge payload to the partner URL. The partner must echo
   * the challenge token via POST /v1/partner/webhooks/verify-challenge.
   * Alternative: DNS TXT verification performed out-of-band by admin.
   */
  async issueChallenge(clientId: string, endpointId: string): Promise<{ challengeSent: boolean }> {
    const endpoint = await this.mustOwn(clientId, endpointId);
    const challenge = randomBytes(16).toString('hex');
    await this.p.partnerWebhookEndpoint.update({
      where: { id: endpointId },
      data: { challengeToken: challenge, challengeIssuedAt: new Date() },
    });
    const secret = await decryptPiiSafe(endpoint.secretEnc);
    if (!secret) {
      throw new BadRequestException({ code: 'PARTNER_WEBHOOK_SECRET_UNAVAILABLE', message: 'Secret endpoint tidak tersedia' });
    }
    const eventId = randomUUID();
    const timestamp = Date.now().toString();
    const body = JSON.stringify({
      version: PARTNER_WEBHOOK_PAYLOAD_VERSION,
      eventId,
      eventType: 'webhook.challenge',
      timestamp: new Date().toISOString(),
      data: { challenge },
    });
    const signature = signWebhookPayload(secret, timestamp, eventId, body);
    try {
      const res = await fetch(endpoint.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-kahade-signature': signature,
          'x-kahade-timestamp': timestamp,
          'x-kahade-event-id': eventId,
        },
        body,
        redirect: 'manual', // never follow redirects on challenge
      });
      if (res.status >= 300 && res.status < 400) {
        throw new Error(`redirect ditolak (${res.status})`);
      }
      await res.arrayBuffer().catch(() => undefined);
    } catch (err) {
      this.logger.warn(`Challenge delivery to ${endpoint.id} failed (non-fatal): ${(err as Error).message}`);
    }
    return { challengeSent: true };
  }

  /** Step 2: partner echoes the challenge token → verified + active. */
  async verifyChallenge(partner: PartnerRequestIdentity, endpointId: string, challenge: string): Promise<unknown> {
    const endpoint = await this.p.partnerWebhookEndpoint.findUnique({ where: { id: endpointId } });
    if (!endpoint || endpoint.clientId !== partner.clientId) {
      throw new NotFoundException({ code: 'PARTNER_ENDPOINT_NOT_FOUND', message: 'Endpoint tidak ditemukan' });
    }
    if (!endpoint.challengeToken || endpoint.challengeToken !== challenge) {
      throw new BadRequestException({ code: 'PARTNER_CHALLENGE_INVALID', message: 'Challenge tidak valid' });
    }
    const issuedAt = endpoint.challengeIssuedAt?.getTime() ?? 0;
    if (Date.now() - issuedAt > 15 * 60_000) {
      throw new BadRequestException({ code: 'PARTNER_CHALLENGE_EXPIRED', message: 'Challenge kedaluwarsa (15 menit)' });
    }
    const updated = await this.p.partnerWebhookEndpoint.update({
      where: { id: endpointId },
      data: { verifiedAt: new Date(), isActive: true, challengeToken: null, challengeIssuedAt: null },
    });
    this.logger.log(`Webhook endpoint ${endpointId} verified for client ${partner.clientId}`);
    return this.redactEndpoint(updated);
  }

  // ---------- Dispatch (G466) ----------

  /**
   * Emit a business event to all active, verified endpoints subscribed to it.
   * Payload is the whitelisted business payload; PII policy per G451.
   */
  async emit(eventType: string, data: Record<string, unknown>, opts?: { sandbox?: boolean }): Promise<number> {
    if (!(PARTNER_WEBHOOK_EVENTS as readonly string[]).includes(eventType)) {
      this.logger.warn(`Refusing to emit non-whitelisted webhook event: ${eventType}`);
      return 0;
    }
    const endpoints = await this.p.partnerWebhookEndpoint.findMany({
      where: { isActive: true, verifiedAt: { not: null }, events: { has: eventType } },
    });
    let enqueued = 0;
    for (const endpoint of endpoints) {
      const client = await this.p.apiClient.findUnique({ where: { id: endpoint.clientId } });
      if (!client || client.status !== 'ACTIVE') continue;
      if ((opts?.sandbox ?? false) !== client.isSandbox) continue; // sandbox/prod separation

      const eventId = randomUUID();
      const payload = {
        version: PARTNER_WEBHOOK_PAYLOAD_VERSION,
        eventId,
        eventType,
        timestamp: new Date().toISOString(),
        data,
      };
      const delivery = (await this.p.partnerWebhookDelivery.create({
        data: {
          endpointId: endpoint.id,
          eventId,
          eventType,
          payload,
          attempt: 0,
          status: 'PENDING',
          nextRetryAt: new Date(),
        },
      })) as Record<string, unknown>;

      await this.queue.add(
        'deliver',
        { deliveryId: delivery['id'] as string, endpointId: endpoint.id, eventId, eventType, attempt: 1 },
        { jobId: `wh:${delivery['id'] as string}:a1`, removeOnComplete: 100, removeOnFail: 50 },
      );
      enqueued++;
    }
    return enqueued;
  }

  /** Schedule the next attempt after a failure, or move to DLQ. Exported for tests. */
  computeNextStep(attempt: number): { status: 'PENDING' | 'DLQ'; nextRetryAt: Date | null } {
    if (attempt >= PARTNER_WEBHOOK_MAX_ATTEMPTS) {
      return { status: 'DLQ', nextRetryAt: null };
    }
    const delay = retryDelayForAttempt(attempt);
    return { status: 'PENDING', nextRetryAt: new Date(Date.now() + (delay ?? 0)) };
  }

  /** Enqueue attempt N (used by processor after a failure). */
  async enqueueRetry(jobData: WebhookDeliveryJobData): Promise<void> {
    const { status, nextRetryAt } = this.computeNextStep(jobData.attempt);
    if (status === 'DLQ') return;
    await this.p.partnerWebhookDelivery.update({
      where: { id: jobData.deliveryId },
      data: { attempt: jobData.attempt, status: 'PENDING', nextRetryAt },
    });
    const delay = retryDelayForAttempt(jobData.attempt) ?? 0;
    await this.queue.add('deliver', { ...jobData, attempt: jobData.attempt + 1 }, {
      jobId: `wh:${jobData.deliveryId}:a${jobData.attempt + 1}`,
      delay,
      removeOnComplete: 100,
      removeOnFail: 50,
    });
  }

  async markDead(deliveryId: string, lastError: string): Promise<void> {
    await this.p.partnerWebhookDelivery.update({
      where: { id: deliveryId },
      data: { status: 'DLQ', nextRetryAt: null, lastError: lastError.slice(0, 500), completedAt: new Date() },
    });
    this.logger.error(`Webhook delivery ${deliveryId} moved to DLQ: ${lastError.slice(0, 200)}`);
  }

  // ---------- Admin: test, log, replay (G467/G468/G469) ----------

  /** Send a synthetic "webhook.test" event (G467). */
  async sendTest(clientId: string, endpointId: string): Promise<{ eventId: string }> {
    const endpoint = await this.mustOwn(clientId, endpointId);
    const eventId = randomUUID();
    const payload = {
      version: PARTNER_WEBHOOK_PAYLOAD_VERSION,
      eventId,
      eventType: 'webhook.test',
      timestamp: new Date().toISOString(),
      data: { note: 'Event sintetis untuk pengujian endpoint webhook.', endpointId },
    };
    const delivery = (await this.p.partnerWebhookDelivery.create({
      data: {
        endpointId: endpoint.id,
        eventId,
        eventType: 'webhook.test',
        payload,
        attempt: 0,
        status: 'PENDING',
        nextRetryAt: new Date(),
      },
    })) as Record<string, unknown>;
    await this.queue.add(
      'deliver',
      { deliveryId: delivery['id'] as string, endpointId: endpoint.id, eventId, eventType: 'webhook.test', attempt: 1 },
      { jobId: `wh:${delivery['id'] as string}:a1`, removeOnComplete: 100, removeOnFail: 50 },
    );
    return { eventId };
  }

  /** Redacted delivery log (G468): no secrets, no PII payloads. */
  async deliveryLog(
    clientId: string,
    opts: { endpointId?: string; status?: string; page?: number; limit?: number },
  ): Promise<{ items: unknown[]; total: number }> {
    const endpoints = await this.p.partnerWebhookEndpoint.findMany({ where: { clientId } });
    const endpointIds = endpoints.map((e) => e.id);
    const where: Record<string, unknown> = { endpointId: { in: endpointIds } };
    if (opts.endpointId) {
      if (!endpointIds.includes(opts.endpointId)) {
        throw new NotFoundException({ code: 'PARTNER_ENDPOINT_NOT_FOUND', message: 'Endpoint tidak ditemukan' });
      }
      where['endpointId'] = opts.endpointId;
    }
    if (opts.status) where['status'] = opts.status;
    const page = Math.max(1, opts.page ?? 1);
    const limit = Math.min(100, Math.max(1, opts.limit ?? 20));
    const [rows, total] = await Promise.all([
      this.p.partnerWebhookDelivery.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.p.partnerWebhookDelivery.count({ where }),
    ]);
    return {
      items: rows.map((r) => ({
        id: r['id'],
        endpointId: r['endpointId'],
        eventId: r['eventId'],
        eventType: r['eventType'],
        attempt: r['attempt'],
        status: r['status'],
        nextRetryAt: r['nextRetryAt'],
        lastError: r['lastError'],
        responseCode: r['responseCode'],
        createdAt: r['createdAt'],
        completedAt: r['completedAt'],
        // payload omitted: may contain business data; admin views it via support tooling, not here.
      })),
      total,
    };
  }

  /**
   * Manual replay (G469): re-enqueue the SAME eventId. Idempotent for compliant
   * receivers (eventId unchanged → dedupe on their side).
   */
  async replay(clientId: string, deliveryId: string): Promise<{ eventId: string }> {
    const delivery = await this.p.partnerWebhookDelivery.findUnique({ where: { id: deliveryId } });
    if (!delivery) throw new NotFoundException({ code: 'PARTNER_DELIVERY_NOT_FOUND', message: 'Delivery tidak ditemukan' });
    const endpoint = await this.p.partnerWebhookEndpoint.findUnique({ where: { id: delivery['endpointId'] as string } });
    if (!endpoint || endpoint.clientId !== clientId) {
      throw new NotFoundException({ code: 'PARTNER_DELIVERY_NOT_FOUND', message: 'Delivery tidak ditemukan' });
    }
    if (delivery['status'] === 'PENDING') {
      throw new BadRequestException({ code: 'PARTNER_DELIVERY_PENDING', message: 'Delivery masih dalam antrean — tidak perlu replay' });
    }
    await this.p.partnerWebhookDelivery.update({
      where: { id: deliveryId },
      data: { status: 'PENDING', attempt: 0, nextRetryAt: new Date(), lastError: null },
    });
    await this.queue.add(
      'deliver',
      {
        deliveryId,
        endpointId: endpoint.id,
        eventId: delivery['eventId'] as string,
        eventType: delivery['eventType'] as string,
        attempt: 1,
      },
      { jobId: `wh:${deliveryId}:replay:${Date.now()}`, removeOnComplete: 100, removeOnFail: 50 },
    );
    this.logger.log(`Manual replay of delivery ${deliveryId} (eventId kept: ${delivery['eventId']})`);
    return { eventId: delivery['eventId'] as string };
  }

  // ---------- Helpers ----------

  private async mustOwn(clientId: string, endpointId: string): Promise<WebhookEndpointRecord> {
    const endpoint = await this.p.partnerWebhookEndpoint.findUnique({ where: { id: endpointId } });
    if (!endpoint || endpoint.clientId !== clientId) {
      throw new NotFoundException({ code: 'PARTNER_ENDPOINT_NOT_FOUND', message: 'Endpoint tidak ditemukan' });
    }
    return endpoint;
  }

  private redactEndpoint(e: WebhookEndpointRecord): Record<string, unknown> {
    const { secretEnc: _s, challengeToken: _c, ...rest } = e;
    void _s;
    void _c;
    // ADM-310: turunkan status eksplisit untuk admin UI:
    // DISABLED bila nonaktif (belum terverifikasi atau sengaja dinonaktifkan),
    // ACTIVE bila terverifikasi & aktif, CHALLENGED bila tantangan terkirim.
    const status = !e.isActive ? 'DISABLED' : e.verifiedAt ? 'ACTIVE' : e.challengeIssuedAt ? 'CHALLENGED' : 'DISABLED';
    return { ...rest, status };
  }

  /** Used by the processor: fetch endpoint + decrypted secret. */
  async getDeliveryContext(deliveryId: string): Promise<{
    endpoint: WebhookEndpointRecord;
    secret: string | null;
    delivery: Record<string, unknown>;
  } | null> {
    const delivery = await this.p.partnerWebhookDelivery.findUnique({ where: { id: deliveryId } });
    if (!delivery) return null;
    const endpoint = await this.p.partnerWebhookEndpoint.findUnique({
      where: { id: delivery['endpointId'] as string },
    });
    if (!endpoint) return null;
    const secret = await decryptPiiSafe(endpoint.secretEnc);
    return { endpoint, secret, delivery };
  }

  async recordAttemptResult(
    deliveryId: string,
    endpointId: string,
    ok: boolean,
    responseCode: number | null,
    error: string | null,
    attempt: number,
  ): Promise<void> {
    if (ok) {
      await this.p.partnerWebhookDelivery.update({
        where: { id: deliveryId },
        data: { attempt, status: 'SENT', responseCode, lastError: null, completedAt: new Date(), nextRetryAt: null },
      });
      await this.p.partnerWebhookEndpoint.update({
        where: { id: endpointId },
        data: { lastDeliveryAt: new Date(), lastDeliveryStatus: 'SENT' },
      });
    } else {
      await this.p.partnerWebhookDelivery.update({
        where: { id: deliveryId },
        data: {
          attempt,
          responseCode,
          lastError: (error ?? 'unknown').slice(0, 500), // redacted: never store response bodies
        },
      });
      await this.p.partnerWebhookEndpoint.update({
        where: { id: endpointId },
        data: { lastDeliveryAt: new Date(), lastDeliveryStatus: 'FAILED' },
      });
    }
  }
}
