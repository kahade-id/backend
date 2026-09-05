import { Injectable, CanActivate, ExecutionContext, Logger, HttpException, HttpStatus, ServiceUnavailableException } from '@nestjs/common';
import { RedisService } from '../../redis/redis.service';

const GLOBAL_IP_LIMIT = 1000;
const GLOBAL_IP_WINDOW_SECONDS = 60;

@Injectable()
export class GlobalThrottleGuard implements CanActivate {
  private readonly logger = new Logger(GlobalThrottleGuard.name);

  constructor(
    private readonly redis: RedisService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest();
    if (!req) return true;

    // Use express's req.ip which respects the `trust proxy` setting (configured in main.ts
    // via TRUSTED_PROXY_CIDR). Reading X-Forwarded-For directly would allow spoofing.
    const resolvedIp = (req.ip as string | undefined)
      || (req.socket as { remoteAddress?: string })?.remoteAddress
      || 'unknown';
    const key = `global_throttle:${resolvedIp}`;

    try {
      const count = await this.redis.incr(key);
      if (count === 1) {
        await this.redis.expire(key, GLOBAL_IP_WINDOW_SECONDS);
      }
      if (count > GLOBAL_IP_LIMIT) {
        throw new HttpException(
          { statusCode: HttpStatus.TOO_MANY_REQUESTS, message: 'Too many requests. Please try again later.' },
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }
      return true;
    } catch (error) {
      if (error instanceof HttpException) throw error;
      this.logger.error(`Global throttle check failed for ${resolvedIp}: ${(error as Error).message} — failing closed`);
      throw new ServiceUnavailableException('Service temporarily unavailable. Please try again later.');
    }
  }
}
