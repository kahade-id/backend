import { Injectable, CanActivate, ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PrismaService } from '../../prisma/prisma.service';
import { RedisService } from '../../redis/redis.service';
import * as ErrorCodes from '../constants/error-codes';
import { PHONE_VERIFIED_GUARD } from '../constants/redis-keys';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';

const PHONE_CACHE_TTL = 300;

@Injectable()
export class PhoneVerifiedGuard implements CanActivate {
  constructor(
    private prisma: PrismaService,
    private redis: RedisService,
    private reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    // Batch 1A: hormati @Public() (mis. endpoint signed-download) — sama
    // seperti JwtAuthGuard global. Tanpa ini, route publik di controller yang
    // memakai guard ini di level class akan selalu 403.
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

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
