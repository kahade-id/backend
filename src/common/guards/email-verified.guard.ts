import { Injectable, CanActivate, ExecutionContext, ForbiddenException, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { RedisService } from '../../redis/redis.service';
import * as ErrorCodes from '../constants/error-codes';

const EMAIL_CACHE_TTL = 300;
const EMAIL_CACHE_KEY = (userId: string) => `guard:email_verified:${userId}`;

@Injectable()
export class EmailVerifiedGuard implements CanActivate {
  private readonly logger = new Logger(EmailVerifiedGuard.name);
  constructor(private prisma: PrismaService, private redis: RedisService) {}

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

    if (user.emailVerified === true) {
      return true;
    }

    const cacheKey = EMAIL_CACHE_KEY(userId);
    const cached = await this.redis.get(cacheKey);
    if (cached === '1') {
      return true;
    }
    if (cached === '0') {
      throw new ForbiddenException({
        code: ErrorCodes.EMAIL_NOT_VERIFIED,
        message: 'Email verification required for this action',
      });
    }

    const dbUser = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { emailVerified: true },
    });

    if (dbUser) {
      await this.redis.set(cacheKey, dbUser.emailVerified ? '1' : '0', EMAIL_CACHE_TTL);
    }

    if (!dbUser || !dbUser.emailVerified) {
      throw new ForbiddenException({
        code: ErrorCodes.EMAIL_NOT_VERIFIED,
        message: 'Email verification required for this action',
      });
    }

    return true;
  }
}
