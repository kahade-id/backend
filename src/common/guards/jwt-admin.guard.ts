import {
  Injectable,
  CanActivate,
  ExecutionContext,
  UnauthorizedException,
  ForbiddenException,
  ServiceUnavailableException,
  Logger,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { Request } from 'express';
import { RedisService } from '../../redis/redis.service';
import { PrismaService } from '../../prisma/prisma.service';
import { ADMIN_TOKEN_BLACKLIST } from '../constants/redis-keys';
import * as ErrorCodes from '../constants/error-codes';

// All admin tokens are signed with aud:'kahade-admin-api' and iss:'kahade-auth'.
// Validating both fields prevents user access tokens (aud:'kahade-api') from being
// accepted by admin endpoints even if JWT_SECRET == JWT_ADMIN_SECRET.
const TOKEN_ISSUER = 'kahade-auth';
const ADMIN_TOKEN_AUDIENCE = 'kahade-admin-api';

@Injectable()
export class JwtAdminGuard implements CanActivate {
  private readonly logger = new Logger(JwtAdminGuard.name);

  constructor(
    private jwtService: JwtService,
    private redisService: RedisService,
    private configService: ConfigService,
    private prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const token = this.extractTokenFromHeader(request);

    if (!token) {
      throw new UnauthorizedException({
        code: ErrorCodes.UNAUTHORIZED,
        message: 'Admin access token required',
      });
    }

    try {
      const secret = this.configService.get<string>('jwt.adminSecret');

      const payload = await this.jwtService.verifyAsync(token, {
        secret,
        audience: ADMIN_TOKEN_AUDIENCE,
        issuer: TOKEN_ISSUER,
        algorithms: ['HS256'],
      });

      if (!payload.sub || !payload.jti) {
        throw new UnauthorizedException({
          code: ErrorCodes.UNAUTHORIZED,
          message: 'Admin token missing required claims',
        });
      }

      const isBlacklisted = await this.redisService.get(ADMIN_TOKEN_BLACKLIST(payload.jti), { throwOnError: true });
      if (isBlacklisted) {
        throw new UnauthorizedException({
          code: ErrorCodes.UNAUTHORIZED,
          message: 'Token has been revoked',
        });
      }

      const revokedAtRaw = await this.redisService.get(`admin_revoked:${payload.sub}`, { throwOnError: true });
      if (revokedAtRaw) {
        const revokedAt = Number(revokedAtRaw);
        const issuedAt = typeof payload.iat === 'number' ? payload.iat : 0;
        // Legacy boolean markers are treated as revoked until their TTL expires.
        // Numeric markers revoke tokens issued at or before the epoch timestamp.
        const tokenRevoked = !Number.isFinite(revokedAt) || revokedAt <= 1 || issuedAt <= revokedAt;
        if (tokenRevoked) {
          throw new UnauthorizedException({
            code: ErrorCodes.UNAUTHORIZED,
            message: 'Admin token has been revoked',
          });
        }
      }

      const admin = await this.prisma.adminUser.findUnique({
        where: { id: payload.sub },
        select: { isActive: true, deletedAt: true, lockedUntil: true },
      });
      if (!admin || !admin.isActive || admin.deletedAt) {
        throw new UnauthorizedException({
          code: ErrorCodes.UNAUTHORIZED,
          message: 'Admin account has been deactivated',
        });
      }
      if (admin.lockedUntil && admin.lockedUntil > new Date()) {
        throw new UnauthorizedException({
          code: ErrorCodes.ACCOUNT_LOCKED,
          message: 'Admin account is locked',
        });
      }

      if (payload.scope) {
        const allowedPaths = this.getAllowedPathsForScope(payload.scope);
        const rawPath = (request.originalUrl || request.url || '').split('?')[0].replace(/\/+$/, '');
        const apiPrefix = '/v1';
        const normalizedPath = rawPath.startsWith(apiPrefix) ? rawPath.slice(apiPrefix.length) : rawPath;
        const isAllowed = allowedPaths.some(path => normalizedPath === path);
        if (!isAllowed) {
          throw new ForbiddenException({
            code: ErrorCodes.INSUFFICIENT_TOKEN_SCOPE,
            message: 'Token scope insufficient for this endpoint',
          });
        }
      }

      request.admin = payload;
      return true;
    } catch (error) {
      if (error instanceof ForbiddenException || error instanceof UnauthorizedException) throw error;
      if (error instanceof ServiceUnavailableException) throw error;
      if ((error as Error)?.name === 'JsonWebTokenError' || (error as Error)?.name === 'TokenExpiredError') {
        throw new UnauthorizedException({
          code: ErrorCodes.UNAUTHORIZED,
          message: 'Invalid or expired admin token',
        });
      }
      this.logger.warn('Unexpected error during admin token verification — rejecting request (fail-closed)');
      throw new ServiceUnavailableException('Service temporarily unavailable. Please try again later.');
    }
  }

  private getAllowedPathsForScope(scope: string): string[] {
    const scopePaths: Record<string, string[]> = {
      mfa_setup: ['/admin/auth/2fa/setup'],
      mfa_confirm: ['/admin/auth/2fa/confirm'],
      change_password_required: ['/admin/auth/change-password'],
      admin_2fa_verify: ['/admin/auth/2fa/verify'],
      '2fa_verify': ['/admin/auth/2fa/verify'],
    };
    return scopePaths[scope] || [];
  }

  private extractTokenFromHeader(request: Request): string | undefined {
    const [type, token] = request.headers.authorization?.split(' ') ?? [];
    return type === 'Bearer' ? token : undefined;
  }
}
