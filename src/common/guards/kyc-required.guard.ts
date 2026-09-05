import { Injectable, CanActivate, ExecutionContext, ForbiddenException, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { RedisService } from '../../redis/redis.service';
import { KycStatus } from '@prisma/client';
import * as ErrorCodes from '../constants/error-codes';

const KYC_CACHE_TTL = 300;
const KYC_CACHE_KEY = (userId: string) => `guard:kyc:${userId}`;

@Injectable()
export class KycRequiredGuard implements CanActivate {
  private readonly logger = new Logger(KycRequiredGuard.name);
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

    const cacheKey = KYC_CACHE_KEY(userId);
    const cached = await this.redis.get(cacheKey);
    if (cached === KycStatus.APPROVED) {
      return true;
    }
    if (cached !== null) {
      throw new ForbiddenException({
        code: ErrorCodes.KYC_REQUIRED,
        message: 'KYC verification required for this action',
      });
    }

    const dbUser = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { kycStatus: true },
    });

    if (dbUser) {
      await this.redis.set(cacheKey, dbUser.kycStatus, KYC_CACHE_TTL);
    }

    if (!dbUser || dbUser.kycStatus !== KycStatus.APPROVED) {
      throw new ForbiddenException({
        code: ErrorCodes.KYC_REQUIRED,
        message: 'KYC verification required for this action',
      });
    }

    return true;
  }
}
