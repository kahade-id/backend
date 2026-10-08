import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { SetMetadata } from '@nestjs/common';
import { RedisService } from '../../redis/redis.service';

const STORY_RATE_LIMIT_KEY = 'storyRateLimit';
interface StoryRateLimit {
  bucket: string;
  limit: number;
  windowMs: number;
}

export const StoryThrottle = (bucket: string, limit: number, windowMs: number) =>
  SetMetadata(STORY_RATE_LIMIT_KEY, { bucket, limit, windowMs } satisfies StoryRateLimit);

@Injectable()
export class StoryThrottleGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly redis: RedisService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const policy = this.reflector.getAllAndOverride<StoryRateLimit>(STORY_RATE_LIMIT_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!policy) return true;

    const request = context.switchToHttp().getRequest();
    const userId = (request.user as { sub?: string } | undefined)?.sub;
    if (!userId) {
      throw new UnauthorizedException({ code: 'UNAUTHORIZED', message: 'Bearer token required' });
    }

    let allowed: boolean;
    try {
      allowed = await this.redis.evalSlidingWindow(
        `throttle:stories:${policy.bucket}:user:${userId}`,
        policy.windowMs,
        policy.limit,
        Date.now(),
      );
    } catch {
      // Story mutations must not bypass their per-user limits during a Redis outage.
      throw new ServiceUnavailableException({
        code: 'SERVICE_UNAVAILABLE',
        message: 'Layanan sementara tidak tersedia. Coba lagi nanti.',
      });
    }

    if (!allowed) {
      throw new HttpException(
        {
          code: 'RATE_LIMITED',
          message: 'Terlalu banyak permintaan. Coba lagi nanti.',
          retryAfter: Math.ceil(policy.windowMs / 1000),
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    return true;
  }
}
