import { Injectable, CanActivate, ExecutionContext, Logger, HttpException, HttpStatus, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RedisService } from '../../redis/redis.service';

@Injectable()
export class UserThrottleGuard implements CanActivate {
  private readonly logger = new Logger(UserThrottleGuard.name);

  constructor(
    private readonly redis: RedisService,
    private readonly configService: ConfigService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest();

    const user = req.user as { sub?: string } | undefined;
    const admin = req.admin as { sub?: string } | undefined;
    let tracker: string;

    // Admin routes pass through the global JwtAuthGuard first, which stores
    // the verified admin payload on req.user for the AdminRoute branch. The
    // route-level JwtAdminGuard then stores the same identity on req.admin.
    // Prefer req.admin so admin traffic cannot be mislabeled as a regular user
    // tracker when both properties are present.
    if (admin?.sub) {
      tracker = `admin:${admin.sub}`;
    } else if (user?.sub) {
      tracker = `user:${user.sub}`;
    } else {
      // Use express's req.ip which respects the `trust proxy` setting (configured in main.ts
      // via TRUSTED_PROXY_CIDR). Reading X-Forwarded-For directly would allow spoofing.
      const resolvedIp = (req.ip as string | undefined)
        || (req.socket as { remoteAddress?: string } | undefined)?.remoteAddress
        || 'unknown';
      tracker = `ip:${resolvedIp}`;
    }

    const windowMs = this.configService.get<number>('app.throttleGlobalTtlMs') ?? 60000;
    const limit = this.configService.get<number>('app.throttleGlobalLimit') ?? 100;
    const key = `throttle:sliding:${tracker}`;

    try {
      const allowed = await this.redis.evalSlidingWindow(key, windowMs, limit, Date.now());
      if (!allowed) {
        throw new HttpException(
          { statusCode: HttpStatus.TOO_MANY_REQUESTS, message: 'Too many requests. Please try again later.' },
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }
    } catch (error) {
      if (error instanceof HttpException) throw error;
      this.logger.error(`Sliding window throttle check failed for ${tracker}: ${(error as Error).message} — failing closed`);
      throw new ServiceUnavailableException('Service temporarily unavailable. Please try again later.');
    }

    return true;
  }
}
