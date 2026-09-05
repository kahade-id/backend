import { Controller, Get, Injectable, Logger, Module, NotFoundException, Optional, Req, ServiceUnavailableException } from '@nestjs/common';
import { TerminusModule } from '@nestjs/terminus';
import {
  HealthCheck, HealthCheckResult, HealthCheckService, PrismaHealthIndicator,
  HealthIndicator, HealthIndicatorResult,
} from '@nestjs/terminus';
import { ConfigService } from '@nestjs/config';
import { Public } from '../../common/decorators/public.decorator';
import { SkipThrottle, Throttle } from '@nestjs/throttler';
import { PrismaClient } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { RedisService } from '../../redis/redis.service';
import * as fs from 'fs';
import * as nodemailer from 'nodemailer';
import type { Request } from 'express';
import { isLoopbackInternalProbe } from './internal-readiness.util';
import { withTimeout } from '../../common/utils/background-reliability.util';
import { getCronRuntimeSnapshots } from '../../common/utils/cron-runtime.registry';
import { InjectQueue } from '@nestjs/bull';
import { Queue } from 'bull';
import { AUDIT_LOG_QUEUE } from '../../common/services/audit-log.service';
import { DEAD_LETTER_QUEUE } from '../queue/queue.constants';
import { EMAIL_QUEUE } from '../queue/processors/email.processor';
import { NOTIFICATION_QUEUE } from '../queue/processors/notification.processor';

@Injectable()
class RedisHealthIndicator extends HealthIndicator {
  constructor(private redis: RedisService) {
    super();
  }

  async isHealthy(key: string): Promise<HealthIndicatorResult> {
    try {
      const result = await withTimeout(this.redis.getClient().ping(), 2_000, `Redis health probe ${key}`);
      return this.getStatus(key, result === 'PONG');
    } catch {
      return this.getStatus(key, false);
    }
  }
}

@Injectable()
class DiskHealthIndicator extends HealthIndicator {
  async isHealthy(key: string): Promise<HealthIndicatorResult> {
    try {
      const stats = fs.statfsSync('/');
      const totalBytes = stats.bsize * stats.blocks;
      const freeBytes = stats.bsize * stats.bavail;
      const usedPercent = Math.round(((totalBytes - freeBytes) / totalBytes) * 100);
      const freeMb = Math.round(freeBytes / 1024 / 1024);
      const isHealthy = usedPercent < 90;
      return this.getStatus(key, isHealthy, { usedPercent, freeMb });
    } catch {
      // An unavailable disk probe is not evidence of a healthy disk. Returning
      // true here made a broken host appear ready to receive traffic/jobs.
      return this.getStatus(key, false, { message: 'disk check unavailable' });
    }
  }
}

@Injectable()
class CronHealthIndicator extends HealthIndicator {
  // This is the complete scheduler inventory, not just the three jobs that
  // previously wrote Redis heartbeats. New cron jobs must be added here and to
  // the scheduler smoke test before being considered operationally covered.
  private static readonly CRITICAL_CRONS = [
    'auto-complete-orders', 'auto-escalate-disputes', 'data-cleanup',
    'deadline-reminders', 'dlq-monitor', 'expire-dispute-calls',
    'expire-unconfirmed-orders', 'expire-unpaid-orders', 'fraud-challenge-escalation',
    'notification-archival', 'orphaned-upload-cleanup', 'pending-topup-cleanup',
    'pending-withdraw-cleanup', 'process-scheduled-withdrawals', 'proof-expiry',
    'redis-hash-cleanup', 'subscription-expiry', 'topup-counter-correction',
    'wallet-daily-reset', 'webhook-inbox-retry', 'daily-reconciliation',
    'withdrawal-reconciliation',
  ];

  constructor(private redis: RedisService) {
    super();
  }

  async isHealthy(key: string): Promise<HealthIndicatorResult> {
    try {
      const results: Record<string, { ranAt?: string; ageHours?: number; ok: boolean; state?: string }> = {};
      let allOk = true;

      const runtimeSnapshots = new Map(getCronRuntimeSnapshots().map(snapshot => [snapshot.name, snapshot]));
      for (const cronName of CronHealthIndicator.CRITICAL_CRONS) {
        const snapshot = runtimeSnapshots.get(cronName);
        const raw = await this.redis.get(`cron_heartbeat:${cronName}`);
        if (!raw && !snapshot) {
          // A newly deployed process may not have reached the first scheduled
          // tick. This is not proof of health, so keep the diagnostic explicit
          // and fail the cron-specific check until an invocation is observed.
          results[cronName] = { ok: false, state: 'awaiting-first-run' };
          allOk = false;
          continue;
        }
        if (snapshot && (snapshot.running || snapshot.consecutiveFailures > 0)) {
          results[cronName] = {
            ranAt: snapshot.startedAt,
            ageHours: snapshot.startedAt ? Math.max(0, (Date.now() - new Date(snapshot.startedAt).getTime()) / 3600_000) : undefined,
            ok: false,
            state: snapshot.running ? 'running' : 'failed',
          };
          allOk = false;
          continue;
        }
        if (!raw) {
          results[cronName] = { ranAt: snapshot?.completedAt, ok: true, state: 'in-process' };
          continue;
        }
        try {
          const data = JSON.parse(raw);
          const ageMs = Date.now() - new Date(data.ranAt).getTime();
          const ageHours = Math.round(ageMs / 3600_000 * 10) / 10;
          const state = typeof data.state === 'string' ? data.state : 'completed';
          const ok = Number.isFinite(ageMs) && state === 'completed' && ageHours < 36;
          results[cronName] = { ranAt: data.ranAt, ageHours, ok, state };
          if (!ok) allOk = false;
        } catch {
          results[cronName] = { ok: false };
          allOk = false;
        }
      }

      return this.getStatus(key, allOk, results);
    } catch {
      return this.getStatus(key, false, { message: 'cron health check unavailable' });
    }
  }
}

@Injectable()
class MidtransHealthIndicator extends HealthIndicator {
  constructor(private config: ConfigService) {
    super();
  }

  async isHealthy(key: string): Promise<HealthIndicatorResult> {
    const serverKey = this.config.get<string>('midtrans.serverKey');
    if (!serverKey) {
      return this.getStatus(key, false, { message: 'Midtrans server key not configured' });
    }

    const isProduction = this.config.get<boolean>('midtrans.isProduction') ?? false;
    const baseUrl = isProduction
      ? 'https://api.midtrans.com'
      : 'https://api.sandbox.midtrans.com';

    const abortController = new AbortController();
    const timeout = setTimeout(() => abortController.abort(), 5000);

    try {
      const auth = Buffer.from(`${serverKey}:`).toString('base64');
      const response = await fetch(`${baseUrl}/v2/charge`, {
        method: 'GET',
        headers: { Authorization: `Basic ${auth}` },
        signal: abortController.signal,
      });
      clearTimeout(timeout);
      const ok = response.status !== 401 && response.status !== 403 && response.status < 500;
      return this.getStatus(key, ok, { statusCode: response.status });
    } catch {
      clearTimeout(timeout);
      return this.getStatus(key, false, { message: 'Midtrans API unreachable' });
    }
  }
}

@Injectable()
class R2HealthIndicator extends HealthIndicator {
  private readonly logger = new Logger(R2HealthIndicator.name);

  constructor(private config: ConfigService) {
    super();
  }

  async isHealthy(key: string): Promise<HealthIndicatorResult> {
    const accountId = this.config.get<string>('r2.accountId');
    const accessKeyId = this.config.get<string>('r2.accessKeyId');
    const secretAccessKey = this.config.get<string>('r2.secretAccessKey');
    const bucketPublic = this.config.get<string>('r2.bucketPublic');

    if (!accountId || !accessKeyId || !secretAccessKey) {
      return this.getStatus(key, false, { message: 'R2 credentials not configured' });
    }

    if (!bucketPublic) {
      return this.getStatus(key, false, { message: 'R2 bucket not configured' });
    }

    const endpointUrl = `https://${accountId}.r2.cloudflarestorage.com`;
    const abortController = new AbortController();
    const timeout = setTimeout(() => abortController.abort(), 5000);

    try {
      const url = `${endpointUrl}/${bucketPublic}?list-type=2&max-keys=1`;
      const now = new Date();
      const dateStr = now.toISOString().replace(/[:-]/g, '').replace(/\.\d{3}/, '');
      const dateShort = dateStr.slice(0, 8);
      const region = 'auto';
      const service = 's3';

      const { createHmac, createHash } = await import('crypto');

      const canonicalHeaders = `host:${accountId}.r2.cloudflarestorage.com\nx-amz-content-sha256:UNSIGNED-PAYLOAD\nx-amz-date:${dateStr}\n`;
      const signedHeaders = 'host;x-amz-content-sha256;x-amz-date';
      const canonicalRequest = `GET\n/${bucketPublic}\nlist-type=2&max-keys=1\n${canonicalHeaders}\n${signedHeaders}\nUNSIGNED-PAYLOAD`;
      const scope = `${dateShort}/${region}/${service}/aws4_request`;
      const stringToSign = `AWS4-HMAC-SHA256\n${dateStr}\n${scope}\n${createHash('sha256').update(canonicalRequest).digest('hex')}`;

      const kDate = createHmac('sha256', `AWS4${secretAccessKey}`).update(dateShort).digest();
      const kRegion = createHmac('sha256', kDate).update(region).digest();
      const kService = createHmac('sha256', kRegion).update(service).digest();
      const kSigning = createHmac('sha256', kService).update('aws4_request').digest();
      const signature = createHmac('sha256', kSigning).update(stringToSign).digest('hex');

      const authHeader = `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

      const response = await fetch(url, {
        method: 'GET',
        headers: {
          Authorization: authHeader,
          'x-amz-date': dateStr,
          'x-amz-content-sha256': 'UNSIGNED-PAYLOAD',
          Host: `${accountId}.r2.cloudflarestorage.com`,
        },
        signal: abortController.signal,
      });
      clearTimeout(timeout);
      const ok = response.status === 200;
      // Do NOT echo `bucket: bucketPublic` — /health is @Public() and
      // unauthenticated, so that leaked the internal R2 bucket name to anyone
      // who curled it. Keep it in the log stream for on-call instead.
      if (!ok) {
        this.logger.warn(`R2 healthcheck non-200 for bucket=${bucketPublic}: status=${response.status}`);
      }
      return this.getStatus(key, ok, { statusCode: response.status });
    } catch {
      clearTimeout(timeout);
      return this.getStatus(key, false, { message: 'R2 storage unreachable' });
    }
  }
}

@Injectable()
class SmtpHealthIndicator extends HealthIndicator {
  private readonly logger = new Logger(SmtpHealthIndicator.name);

  constructor(private config: ConfigService) {
    super();
  }

  async isHealthy(key: string): Promise<HealthIndicatorResult> {
    const host = this.config.get<string>('smtp.host');
    if (!host) {
      return this.getStatus(key, false, { message: 'SMTP not configured' });
    }

    const transporter = nodemailer.createTransport({
        host,
        port: this.config.get<number>('smtp.port') || 587,
        secure: this.config.get<boolean>('smtp.secure') || false,
        auth: {
          user: this.config.get<string>('smtp.user'),
          pass: this.config.get<string>('smtp.pass'),
        },
        connectionTimeout: 5000,
        greetingTimeout: 5000,
        socketTimeout: 5000,
      });

    try {
      await transporter.verify();
      return this.getStatus(key, true);
    } catch (err) {
      // Do NOT leak `(err as Error).message` to the public /health endpoint —
      // nodemailer surfaces the SMTP host, port, and sometimes credentials in
      // its error string (e.g. `Connection refused on smtp.internal:25`). The
      // operator-facing detail must live in our log stream, not the
      // unauthenticated health surface. Log the original verbatim so on-call
      // debugging is unimpeded.
      this.logger.warn(`SMTP healthcheck failed: ${err instanceof Error ? err.stack : String(err)}`);
      const safeMessage = err instanceof Error && err.name ? `SMTP error (${err.name})` : 'SMTP unreachable';
      return this.getStatus(key, false, { message: safeMessage });
    } finally {
      transporter.close();
    }
  }
}

@Injectable()
class WebhookInboxHealthIndicator extends HealthIndicator {
  constructor(private prisma: PrismaService, private redis: RedisService) {
    super();
  }

  async isHealthy(key: string): Promise<HealthIndicatorResult> {
    try {
      const now = new Date();
      const [retryable, deadLettered, heartbeatRaw, failureAlert] = await Promise.all([
        this.prisma.webhookLog.count({
          where: {
            source: 'MIDTRANS',
            isProcessed: false,
            deadLetteredAt: null,
            OR: [{ nextRetryAt: null }, { nextRetryAt: { lte: now } }],
          },
        }),
        this.prisma.webhookLog.count({
          where: { source: 'MIDTRANS', isProcessed: false, deadLetteredAt: { not: null } },
        }),
        this.redis.get('cron_heartbeat:webhook_inbox_retry'),
        this.redis.get('cron_alert:webhook_inbox_retry_failed'),
      ]);

      let heartbeatAgeSeconds: number | null = null;
      if (heartbeatRaw) {
        try {
          const heartbeat = JSON.parse(heartbeatRaw) as { ranAt?: string };
          const ranAt = heartbeat.ranAt ? new Date(heartbeat.ranAt).getTime() : NaN;
          if (Number.isFinite(ranAt)) heartbeatAgeSeconds = Math.max(0, Math.round((Date.now() - ranAt) / 1000));
        } catch {
          heartbeatAgeSeconds = null;
        }
      }

      const heartbeatHealthy = heartbeatAgeSeconds !== null && heartbeatAgeSeconds < 600;
      const healthy = heartbeatHealthy && deadLettered === 0 && !failureAlert;
      return this.getStatus(key, healthy, { retryable, deadLettered, heartbeatAgeSeconds, failureAlert: Boolean(failureAlert) });
    } catch {
      return this.getStatus(key, false, { message: 'webhook inbox health check unavailable' });
    }
  }
}

@Public()
@Controller('health')
export class HealthController {
  private readonly logger = new Logger(HealthController.name);

  constructor(
    private health: HealthCheckService,
    private prismaIndicator: PrismaHealthIndicator,
    private redisIndicator: RedisHealthIndicator,
    private diskIndicator: DiskHealthIndicator,
    private cronIndicator: CronHealthIndicator,
    private midtransIndicator: MidtransHealthIndicator,
    private r2Indicator: R2HealthIndicator,
    private smtpIndicator: SmtpHealthIndicator,
    private webhookInboxIndicator: WebhookInboxHealthIndicator,
    private prisma: PrismaService,
    private config: ConfigService,
    private redis: RedisService,
    @Optional() @InjectQueue(EMAIL_QUEUE) private readonly emailQueue?: Queue,
    @Optional() @InjectQueue(NOTIFICATION_QUEUE) private readonly notificationQueue?: Queue,
    @Optional() @InjectQueue(AUDIT_LOG_QUEUE) private readonly auditLogQueue?: Queue,
    @Optional() @InjectQueue(DEAD_LETTER_QUEUE) private readonly deadLetterQueue?: Queue,
  ) {}

  @Get()
  @Throttle({ default: { ttl: 60000, limit: 10 } })
  @HealthCheck()
  async check(): Promise<any> {
    const maintenanceFlag = await this.redis.get('app:maintenance');
    if (maintenanceFlag) {
      let parsed: { enabled?: boolean; message?: string } = {};
      try { parsed = JSON.parse(maintenanceFlag); } catch {}
      if (parsed.enabled) {
        return {
          status: 'ok',
          maintenance: true,
          maintenanceMessage: parsed.message || 'Scheduled maintenance in progress.',
        };
      }
    }

    const envMaintenance = this.config.get<string>('MAINTENANCE_MODE');
    if (envMaintenance === 'true' || envMaintenance === '1') {
      return {
        status: 'ok',
        maintenance: true,
        maintenanceMessage: this.config.get<string>('MAINTENANCE_MESSAGE') || 'Scheduled maintenance in progress.',
      };
    }

    const result = await this.health.check([
      (): Promise<HealthIndicatorResult> => this.prismaIndicator.pingCheck('database', this.prisma as unknown as PrismaClient),
      (): Promise<HealthIndicatorResult> => this.redisIndicator.isHealthy('redis'),
      (): Promise<HealthIndicatorResult> => this.diskIndicator.isHealthy('disk'),
      (): Promise<HealthIndicatorResult> => this.midtransIndicator.isHealthy('midtrans'),
      (): Promise<HealthIndicatorResult> => this.r2Indicator.isHealthy('r2_storage'),
      (): Promise<HealthIndicatorResult> => this.smtpIndicator.isHealthy('smtp'),
      (): Promise<HealthIndicatorResult> => this.queueIndicator('queues'),
    ]);
    return { ...result, maintenance: false };
  }

  /**
   * A release gate for the process that owns the private API listener. Unlike
   * `/health`, this endpoint does not fan out to SMTP, R2, or payment providers
   * and it is never exposed through the reverse proxy: forwarded requests and
   * all non-loopback peers receive a generic 404.
   */
  @Get('internal-ready')
  @SkipThrottle()
  async internalReady(@Req() request: Request): Promise<{ status: 'ready' }> {
    if (!isLoopbackInternalProbe(request.socket.remoteAddress, {
      'x-forwarded-for': request.header('x-forwarded-for') ?? undefined,
    })) {
      throw new NotFoundException();
    }
    try {
      const [, redisResult] = await withTimeout(
        Promise.all([
          this.prisma.$queryRaw`SELECT 1`,
          this.redis.getClient().ping(),
        ]),
        2_000,
        'internal readiness dependency probe',
      );
      if (redisResult !== 'PONG') throw new Error('Redis did not return PONG');
      return { status: 'ready' };
    } catch {
      throw new ServiceUnavailableException('Dependencies are not ready');
    }
  }

  private async queueIndicator(key: string): Promise<HealthIndicatorResult> {
    try {
      const queues = [
        ['email', this.emailQueue],
        ['notification', this.notificationQueue],
        ['audit-log', this.auditLogQueue],
        ['dead-letter', this.deadLetterQueue],
      ] as const;
      if (queues.some(([, queue]) => !queue)) {
        // Read-only smoke intentionally excludes Bull and must not be marked
        // unhealthy merely because background workers are absent there.
        return this.healthIndicatorStatus(key, true, { mode: 'disabled' });
      }
      const runnableQueues = queues as unknown as readonly (readonly [string, Queue])[];
      const counts = await withTimeout(
        Promise.all(runnableQueues.map(async ([name, queue]) => [name, await queue.getJobCounts()] as const)),
        2_000,
        'Bull queue health probe',
      );
      const info = Object.fromEntries(counts.map(([name, value]) => [name, value]));
      const depth = (value: unknown): number => {
        if (!value || typeof value !== 'object') return Number.MAX_SAFE_INTEGER;
        return (Object.values(value as Record<string, unknown>) as unknown[])
          .reduce<number>((total, count) => total + (typeof count === 'number' ? count : 0), 0);
      };
      const deadLetter = info['dead-letter'];
      const healthy = Object.values(info).every(count => depth(count) < 10_000)
        && depth(deadLetter) === 0;
      this.logger.debug(`Bull queue health depths: ${JSON.stringify(Object.fromEntries(Object.entries(info).map(([name, value]) => [name, depth(value)])))}`);
      // /health is public; never expose queue names/depths to unauthenticated callers.
      return this.healthIndicatorStatus(key, healthy, {});
    } catch {
      return this.healthIndicatorStatus(key, false, { message: 'queue health check unavailable' });
    }
  }

  private healthIndicatorStatus(key: string, healthy: boolean, info: Record<string, unknown>): HealthIndicatorResult {
    return healthy ? { [key]: { status: 'up', ...info } } : { [key]: { status: 'down', ...info } };
  }

  @Get('webhooks')
  @Throttle({ default: { ttl: 60000, limit: 10 } })
  @HealthCheck()
  checkWebhooks(): Promise<HealthCheckResult> {
    return this.health.check([
      (): Promise<HealthIndicatorResult> => this.webhookInboxIndicator.isHealthy('webhooks'),
    ]);
  }

  @Get('crons')
  @Throttle({ default: { ttl: 60000, limit: 10 } })
  @HealthCheck()
  checkCrons(): Promise<HealthCheckResult> {
    return this.health.check([
      (): Promise<HealthIndicatorResult> => this.cronIndicator.isHealthy('crons'),
    ]);
  }
}

@Module({
  imports: [TerminusModule],
  controllers: [HealthController],
  providers: [
    RedisHealthIndicator,
    DiskHealthIndicator,
    CronHealthIndicator,
    MidtransHealthIndicator,
    R2HealthIndicator,
    SmtpHealthIndicator,
    WebhookInboxHealthIndicator,
  ],
})
export class HealthModule {}
