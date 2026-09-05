import { Injectable, NotFoundException, ForbiddenException, BadRequestException, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { RedisService } from '../../redis/redis.service';
import { SESSION_REVOKED_KEY } from '../../common/constants/redis-keys';
import * as ErrorCodes from '../../common/constants/error-codes';
import { parseJwtTtl } from '../../common/utils/jwt.util';

@Injectable()
export class SessionsService {
  private readonly logger = new Logger(SessionsService.name);
  // at 900s — if JWT_EXPIRES_IN was changed to e.g. '30m', the revocation key would
  // expire after 15m and allow revoked tokens to become valid again.
  private readonly accessTokenTtlSeconds: number;

  constructor(
    private prisma: PrismaService,
    private redis: RedisService,
    private configService: ConfigService,
  ) {
    this.accessTokenTtlSeconds = parseJwtTtl(
      this.configService.get<string>('jwt.expiresIn') ?? '15m',
    );
  }


  async getActiveSessions(userId: string, currentSessionId: string, page = 1, limit = 50): Promise<{ sessions: Array<Record<string, unknown>>; total: number; page: number; limit: number }> {
    const safePage = Number.isFinite(page) ? Math.max(1, Math.floor(page)) : 1;
    const safeLimit = Number.isFinite(limit) ? Math.min(Math.max(1, Math.floor(limit)), 50) : 50;
    const where = {
      userId,
      isRevoked: false,
      expiresAt: { gt: new Date() },
    };
    const [sessions, total] = await Promise.all([
      this.prisma.userSession.findMany({
        where,
        orderBy: { lastActiveAt: 'desc' },
        take: safeLimit,
        skip: (safePage - 1) * safeLimit,
        select: {
          id: true,
          deviceInfo: true,
          ipAddress: true,
          lastActiveAt: true,
          createdAt: true,
        },
      }),
      this.prisma.userSession.count({ where }),
    ]);

    return {
      sessions: sessions.map((session) => ({
        id: session.id,
        deviceInfo: session.deviceInfo,
        ipAddress: this.maskIpAddress(session.ipAddress),
        lastActiveAt: session.lastActiveAt,
        createdAt: session.createdAt,
        isCurrentSession: session.id === currentSessionId,
      })),
      total,
      page: safePage,
      limit: safeLimit,
    };
  }

  private maskIpAddress(ip: string | null): string | null {
    if (!ip) return null;
    if (ip.includes(':')) {
      const full = this.expandIPv6(ip);
      const groups = full.split(':');
      return groups.slice(0, 4).join(':') + ':****:****:****:****';
    }
    const parts = ip.split('.');
    if (parts.length === 4) {
      return `${parts[0]}.${parts[1]}.***.***`;
    }
    return '***';
  }

  private expandIPv6(ip: string): string {
    let addr = ip;
    if (addr.startsWith('::ffff:') && addr.includes('.')) {
      return '::ffff:***:***';
    }
    if (addr.includes('::')) {
      const [left, right] = addr.split('::');
      const leftGroups = left ? left.split(':') : [];
      const rightGroups = right ? right.split(':') : [];
      const missing = 8 - leftGroups.length - rightGroups.length;
      const middle = Array(missing).fill('0000');
      addr = [...leftGroups, ...middle, ...rightGroups].join(':');
    }
    return addr.split(':').map(g => g.padStart(4, '0')).join(':');
  }

  async revokeSession(userId: string, sessionId: string): Promise<{ message: string }> {
    const revokedId = await this.prisma.$transaction(async (tx) => {
      const session = await tx.userSession.findUnique({ where: { id: sessionId } });
      if (!session) {
        throw new NotFoundException({ code: ErrorCodes.SESSION_NOT_FOUND, message: 'Session not found' });
      }
      if (session.userId !== userId) {
        throw new ForbiddenException({ code: ErrorCodes.SESSION_NOT_OWNED, message: 'Session not owned by user' });
      }
      if (session.isRevoked) {
        throw new BadRequestException({ code: ErrorCodes.SESSION_ALREADY_REVOKED, message: 'Session already revoked' });
      }

      await tx.userSession.update({
        where: { id: sessionId },
        data: { isRevoked: true, revokedAt: new Date(), revokedReason: 'user_revoke' },
      });

      return sessionId;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });

    // PostgreSQL is the durable revocation boundary. A Redis outage can delay
    // propagation but must not make a successfully persisted user action appear
    // to have failed or encourage an unsafe retry.
    await this.redis.setex(SESSION_REVOKED_KEY(revokedId), this.accessTokenTtlSeconds, '1', { throwOnError: true })
      .catch((error: unknown) => {
        this.logger.warn(`[SECURITY] Session revocation persisted but Redis propagation is unavailable: ${error instanceof Error ? error.message : String(error)}`);
      });

    return { message: 'Session revoked' };
  }

  async revokeAllOtherSessions(userId: string, currentSessionId: string): Promise<{ count: number }> {
    // where a new session is created between the two queries and escapes revocation.
    const revokedIds = await this.prisma.$transaction(async (tx) => {
      const sessions = await tx.userSession.findMany({
        where: { userId, id: { not: currentSessionId }, isRevoked: false },
        select: { id: true },
      });

      if (sessions.length === 0) return [];

      await tx.userSession.updateMany({
        where: { userId, id: { not: currentSessionId }, isRevoked: false },
        data: { isRevoked: true, revokedAt: new Date(), revokedReason: 'revoke_all' },
      });

      return sessions.map((s) => s.id);
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });

    // Immediately invalidate active access tokens for all revoked sessions.
    if (revokedIds.length > 0) {
      await Promise.all(
        revokedIds.map((id) =>
          this.redis.setex(SESSION_REVOKED_KEY(id), this.accessTokenTtlSeconds, '1', { throwOnError: true }),
        ),
      ).catch((error: unknown) => {
        this.logger.warn(`[SECURITY] Other-session revocations persisted but Redis propagation is unavailable: ${error instanceof Error ? error.message : String(error)}`);
      });
    }

    return { count: revokedIds.length };
  }
}
