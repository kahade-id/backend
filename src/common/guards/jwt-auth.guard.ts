import {
  Injectable, CanActivate, ExecutionContext, UnauthorizedException, ServiceUnavailableException, Logger, Inject, Optional,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { Request } from 'express';
import { IS_PUBLIC_KEY, IS_ADMIN_ROUTE_KEY } from '../decorators/public.decorator';
import { RedisService } from '../../redis/redis.service';
import { PrismaService } from '../../prisma/prisma.service';
import { TOKEN_BLACKLIST, ADMIN_TOKEN_BLACKLIST, SESSION_REVOKED_KEY } from '../constants/redis-keys';
import * as ErrorCodes from '../constants/error-codes';
import { TOKEN_ISSUER, USER_TOKEN_AUDIENCE, ADMIN_TOKEN_AUDIENCE } from '../../modules/auth/token.service';

export const ADMIN_JWT_SERVICE = 'ADMIN_JWT_SERVICE';

const CIRCUIT_BREAKER_THRESHOLD = 5;
const CIRCUIT_BREAKER_RESET_MS = 30_000;
const CIRCUIT_BREAKER_KEY = 'jwt_guard:circuit:failures';
const CIRCUIT_BREAKER_TS_KEY = 'jwt_guard:circuit:last_failure';


@Injectable()
export class JwtAuthGuard implements CanActivate {
  private readonly logger = new Logger(JwtAuthGuard.name);
  // SEC-005: Local circuit breaker is per-instance only. In multi-instance deployments,
  // each instance tracks its own failure count independently. Redis-based tracking
  // (CIRCUIT_BREAKER_KEY) is the primary mechanism; the local counter is a fallback
  // when Redis itself is unreachable. This means a single instance may open its local
  // circuit while others remain closed, and vice versa.
  private localCircuitFailureCount = 0;
  private localCircuitLastFailure = 0;

  private adminJwtService: JwtService;

  constructor(
    private reflector: Reflector,
    private jwtService: JwtService,
    @Optional() @Inject(ADMIN_JWT_SERVICE) adminJwtService: JwtService | null,
    private redisService: RedisService,
    private configService: ConfigService,
    private prismaService: PrismaService,
  ) {
    if (adminJwtService) {
      this.adminJwtService = adminJwtService;
    } else {
      const secret = this.configService.get<string>('jwt.adminSecret');
      this.adminJwtService = new JwtService({ secret });
    }
  }

  private async isCircuitOpen(): Promise<boolean> {
    try {
      const client = this.redisService.getClient();
      const prefix = this.redisService.getPrefix();
      const [countStr, tsStr] = await Promise.all([
        client.get(`${prefix}${CIRCUIT_BREAKER_KEY}`),
        client.get(`${prefix}${CIRCUIT_BREAKER_TS_KEY}`),
      ]);
      const count = parseInt(countStr ?? '0', 10);
      const lastFailure = parseInt(tsStr ?? '0', 10);
      if (Date.now() - lastFailure > CIRCUIT_BREAKER_RESET_MS) return false;
      return count >= CIRCUIT_BREAKER_THRESHOLD;
    } catch {
      if (Date.now() - this.localCircuitLastFailure > CIRCUIT_BREAKER_RESET_MS) {
        this.localCircuitFailureCount = 0;
        return false;
      }
      return this.localCircuitFailureCount >= CIRCUIT_BREAKER_THRESHOLD;
    }
  }

  private async recordRedisFailure(): Promise<void> {
    this.localCircuitFailureCount++;
    this.localCircuitLastFailure = Date.now();
    try {
      const client = this.redisService.getClient();
      const prefix = this.redisService.getPrefix();
      const pipeline = client.pipeline();
      pipeline.incr(`${prefix}${CIRCUIT_BREAKER_KEY}`);
      pipeline.set(`${prefix}${CIRCUIT_BREAKER_TS_KEY}`, Date.now().toString());
      pipeline.expire(`${prefix}${CIRCUIT_BREAKER_KEY}`, Math.ceil(CIRCUIT_BREAKER_RESET_MS / 1000) + 5);
      pipeline.expire(`${prefix}${CIRCUIT_BREAKER_TS_KEY}`, Math.ceil(CIRCUIT_BREAKER_RESET_MS / 1000) + 5);
      await pipeline.exec();
    } catch (err) {
      this.logger.warn(`Failed to record Redis circuit breaker failure: ${(err as Error).message}`);
    }
    if (this.localCircuitFailureCount === CIRCUIT_BREAKER_THRESHOLD) {
      this.logger.error(
        `Redis circuit breaker OPEN after ${CIRCUIT_BREAKER_THRESHOLD} consecutive failures — ` +
        `financial endpoints will reject requests for ${CIRCUIT_BREAKER_RESET_MS / 1000}s`,
      );
    }
  }

  private async recordRedisSuccess(): Promise<void> {
    if (this.localCircuitFailureCount === 0) return;
    this.localCircuitFailureCount = 0;
    try {
      const client = this.redisService.getClient();
      const prefix = this.redisService.getPrefix();
      await client.del(`${prefix}${CIRCUIT_BREAKER_KEY}`);
    } catch (err) {
      this.logger.warn(`Failed to record Redis circuit breaker success: ${(err as Error).message}`);
    }
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(), context.getClass(),
    ]);
    if (isPublic) return true;

    const isAdminRoute = this.reflector.getAllAndOverride<boolean>(IS_ADMIN_ROUTE_KEY, [
      context.getHandler(), context.getClass(),
    ]);
    if (isAdminRoute) {
      const request = context.switchToHttp().getRequest();
      const token = this.extractTokenFromHeader(request);

      if (!token) {
        throw new UnauthorizedException({ code: ErrorCodes.UNAUTHORIZED, message: 'Admin access token required' });
      }

      try {
        const payload = await this.adminJwtService.verifyAsync(token, {
          audience: ADMIN_TOKEN_AUDIENCE,
          issuer: TOKEN_ISSUER,
          algorithms: ['HS256'],
        });

        if (!payload.jti) {
          throw new UnauthorizedException({ code: ErrorCodes.UNAUTHORIZED, message: 'Admin token missing jti claim' });
        }

        try {
          const isBlacklisted = await this.redisService.get(ADMIN_TOKEN_BLACKLIST(payload.jti), { throwOnError: true });
          if (isBlacklisted) {
            throw new UnauthorizedException({ code: ErrorCodes.UNAUTHORIZED, message: 'Token has been revoked' });
          }
        } catch (redisErr) {
          if (redisErr instanceof UnauthorizedException) throw redisErr;
          this.logger.warn('Redis unavailable during admin token blacklist check — rejecting request (fail-closed)');
          throw new ServiceUnavailableException('Service temporarily unavailable. Please try again later.');
        }

        request.user = payload;
        return true;
      } catch (error) {
        if (error instanceof UnauthorizedException) throw error;
        if (error instanceof ServiceUnavailableException) throw error;
        if ((error as Error)?.name === 'JsonWebTokenError' || (error as Error)?.name === 'TokenExpiredError') {
          throw new UnauthorizedException({ code: ErrorCodes.UNAUTHORIZED, message: 'Invalid or expired admin token' });
        }
        this.logger.warn('Unexpected error during admin token verification — rejecting request (fail-closed)');
        throw new ServiceUnavailableException('Service temporarily unavailable. Please try again later.');
      }
    }

    const request = context.switchToHttp().getRequest();
    const token = this.extractTokenFromHeader(request) || this.extractTokenFromCookie(request);

    if (!token) {
      throw new UnauthorizedException({ code: ErrorCodes.UNAUTHORIZED, message: 'Access token required' });
    }

    try {
      const secret = this.configService.get<string>('jwt.secret');

      const payload = await this.jwtService.verifyAsync(token, {
        secret,
        audience: USER_TOKEN_AUDIENCE,
        issuer: TOKEN_ISSUER,
        algorithms: ['HS256'],
      });

      if (!payload.jti || !payload.sessionId) {
        throw new UnauthorizedException({ code: ErrorCodes.UNAUTHORIZED, message: 'Token missing required session claims' });
      }

      const blacklistCheckResult = await this.checkBlacklist(payload);
      if (blacklistCheckResult === 'unavailable') {
        throw new ServiceUnavailableException('Service temporarily unavailable. Please try again later.');
      }
      if (blacklistCheckResult === 'revoked') {
        throw new UnauthorizedException({ code: ErrorCodes.UNAUTHORIZED, message: 'Token has been revoked' });
      }
      if (blacklistCheckResult === 'session_revoked') {
        throw new UnauthorizedException({ code: ErrorCodes.SESSION_REVOKED, message: 'Session has been revoked' });
      }

      const databaseAuthResult = await this.checkDatabaseAuthorization(payload);
      if (databaseAuthResult === 'unavailable') {
        throw new ServiceUnavailableException('Service temporarily unavailable. Please try again later.');
      }
      if (databaseAuthResult === 'revoked') {
        throw new UnauthorizedException({ code: ErrorCodes.SESSION_REVOKED, message: 'Session has been revoked' });
      }
      if (databaseAuthResult === 'account_disabled') {
        throw new UnauthorizedException({ code: ErrorCodes.UNAUTHORIZED, message: 'Invalid or expired token' });
      }

      request.user = payload;
      return true;
    } catch (error) {
      if (error instanceof UnauthorizedException) throw error;
      if (error instanceof ServiceUnavailableException) throw error;
      throw new UnauthorizedException({ code: ErrorCodes.UNAUTHORIZED, message: 'Invalid or expired token' });
    }
  }

  private isFailOpenEnabled(): boolean {
    return this.configService.get<boolean>('app.redisAuthFailOpen') === true;
  }

  private async checkBlacklist(
    payload: { jti?: string; sessionId?: string },
  ): Promise<'ok' | 'revoked' | 'session_revoked' | 'unavailable'> {
    if (await this.isCircuitOpen()) {
      if (this.isFailOpenEnabled()) {
        this.logger.warn('Redis circuit open — allowing cryptographically valid token (fail-open mode)');
        return 'ok';
      }
      this.logger.warn('Redis circuit open — rejecting request (fail-closed)');
      return 'unavailable';
    }

    try {
      if (payload.jti) {
        const isBlacklisted = await this.redisService.get(TOKEN_BLACKLIST(payload.jti), { throwOnError: true });
        if (isBlacklisted) {
          await this.recordRedisSuccess();
          return 'revoked';
        }
      }

      if (payload.sessionId) {
        const sessionRevoked = await this.redisService.get(SESSION_REVOKED_KEY(payload.sessionId), { throwOnError: true });
        if (sessionRevoked) {
          await this.recordRedisSuccess();
          return 'session_revoked';
        }
      }

      await this.recordRedisSuccess();
      return 'ok';
    } catch {
      await this.recordRedisFailure();
      if (this.isFailOpenEnabled()) {
        this.logger.warn('Redis unavailable — allowing cryptographically valid token (fail-open mode)');
        return 'ok';
      }
      this.logger.warn('Redis unavailable — rejecting request (fail-closed)');
      return 'unavailable';
    }
  }

  private async checkDatabaseAuthorization(
    payload: { sub?: string; sessionId?: string },
  ): Promise<'ok' | 'revoked' | 'account_disabled' | 'unavailable'> {
    if (!payload.sub) return 'revoked';

    try {
      if (payload.sessionId) {
        const session = await this.prismaService.userSession.findUnique({
          where: { id: payload.sessionId },
          select: {
            userId: true,
            isRevoked: true,
            expiresAt: true,
            user: { select: { isActive: true, isBanned: true, deletedAt: true } },
          },
        });

        if (!session || session.userId !== payload.sub || session.isRevoked || session.expiresAt <= new Date()) {
          return 'revoked';
        }
        if (!session.user.isActive || session.user.isBanned || session.user.deletedAt) {
          return 'account_disabled';
        }
        return 'ok';
      }

      const user = await this.prismaService.user.findUnique({
        where: { id: payload.sub },
        select: { isActive: true, isBanned: true, deletedAt: true },
      });
      if (!user) return 'revoked';
      if (!user.isActive || user.isBanned || user.deletedAt) return 'account_disabled';
      return 'ok';
    } catch (error) {
      this.logger.error(`Database authorization check failed: ${(error as Error).message}`);
      return 'unavailable';
    }
  }

  private extractTokenFromHeader(request: Request): string | undefined {
    const match = /^Bearer\s+(\S+)$/i.exec(request.headers.authorization ?? '');
    return match?.[1];
  }

  private extractTokenFromCookie(request: Request): string | undefined {
    return (request as Request & { cookies?: Record<string, string> }).cookies?.kahade_access_token;
  }
}
