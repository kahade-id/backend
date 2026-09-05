import {
  Injectable,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { RedisService } from '../../redis/redis.service';
import * as ErrorCodes from '../constants/error-codes';
import { PHONE_VERIFIED_GUARD } from '../constants/redis-keys';

const PHONE_CACHE_TTL = 300;

@Injectable()
export class PhoneVerifiedGuard implements CanActivate {
  private readonly logger = new Logger(PhoneVerifiedGuard.name);

  constructor(
    private prisma: PrismaService,
    private redis: RedisService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const user = request.user;
    const userId = user?.sub;

    if (!userId) {
      throw new ForbiddenException({
        code: ErrorCodes.UNAUTHORIZED,
        message: 'Authentication required',
      });
    }

    const cacheKey = PHONE_VERIFIED_GUARD(userId);
    const cached = await this.redis.get(cacheKey);
    if (cached === '1') {
      return true;
    }
    if (cached === '0') {
      throw new ForbiddenException({
        code: ErrorCodes.PHONE_NOT_VERIFIED,
        message: 'Phone verification required for this action',
      });
    }

    const dbUser = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { phoneVerified: true },
    });

    if (dbUser) {
      await this.redis.set(cacheKey, dbUser.phoneVerified ? '1' : '0', PHONE_CACHE_TTL);
    }

    if (!dbUser || !dbUser.phoneVerified) {
      throw new ForbiddenException({
        code: ErrorCodes.PHONE_NOT_VERIFIED,
        message: 'Phone verification required for this action',
      });
    }

    return true;
  }
}
