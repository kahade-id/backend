// GAP-F (G460/G461): per-key + per-endpoint rate limit (sliding window, Redis)
// plus daily quota enforcement. Responds 429 with Retry-After on breach.

import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RedisService } from '../../redis/redis.service';
import { PARTNER_AUTH_KEY, PartnerRequestIdentity } from './partner.decorators';
import { PARTNER_DEFAULT_RATE_LIMIT_PER_MINUTE, PARTNER_RATE_LIMIT_WINDOW_MS } from './partner.constants';

@Injectable()
export class PartnerRateLimitGuard implements CanActivate {
  private readonly logger = new Logger(PartnerRateLimitGuard.name);

  constructor(
    private readonly reflector: Reflector,
    private readonly redis: RedisService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const required = this.reflector.getAllAndOverride<boolean>(PARTNER_AUTH_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required) return true;

    const req = context.switchToHttp().getRequest();
    const partner = req.partner as PartnerRequestIdentity | undefined;
    if (!partner) return true; // PartnerApiKeyGuard handles auth failures.

    const endpoint = `${req.method}:${req.route?.path ?? req.path}`;
    const limit = partner.rateLimitPerMinute || PARTNER_DEFAULT_RATE_LIMIT_PER_MINUTE;

    try {
      const rlKey = `partner:rl:${partner.keyId}:${Buffer.from(endpoint).toString('base64url')}`;
      const allowed = await this.redis.evalSlidingWindow(rlKey, PARTNER_RATE_LIMIT_WINDOW_MS, limit, Date.now());
      if (!allowed) {
        this.deny(context, 60, 'PARTNER_RATE_LIMITED', `Batas ${limit} request/menit terlampaui untuk endpoint ini`);
      }

      // Daily quota (G461).
      if (partner.quotaPerDay > 0) {
        const day = new Date().toISOString().slice(0, 10);
        const qKey = `partner:quota:${partner.clientId}:${day}`;
        const used = await this.redis.getClient().incr(this.prefixed(qKey));
        await this.redis.getClient().expire(this.prefixed(qKey), 90000);
        if (used > partner.quotaPerDay) {
          this.deny(context, this.secondsUntilMidnight(), 'PARTNER_QUOTA_EXCEEDED', 'Kuota harian terlampaui');
        }
      }
      return true;
    } catch (err) {
      if (err instanceof HttpException) throw err;
      // Fail-open on Redis outage would allow unbounded traffic; fail-closed instead.
      this.logger.error(`Rate-limit check failed (fail-closed): ${(err as Error).message}`);
      throw new HttpException(
        { code: 'PARTNER_RATE_LIMIT_UNAVAILABLE', message: 'Pemeriksaan batas request tidak tersedia' },
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
  }

  private prefixed(key: string): string {
    return `${this.redis.getPrefix()}${key}`;
  }

  private deny(context: ExecutionContext, retryAfterSeconds: number, code: string, message: string): never {
    const res = context.switchToHttp().getResponse();
    res.setHeader('Retry-After', String(retryAfterSeconds));
    throw new HttpException(
      { code, message, statusCode: HttpStatus.TOO_MANY_REQUESTS, retryAfter: retryAfterSeconds },
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }

  private secondsUntilMidnight(): number {
    const now = new Date();
    const end = new Date(now);
    end.setHours(24, 0, 0, 0);
    return Math.max(1, Math.ceil((end.getTime() - now.getTime()) / 1000));
  }
}
