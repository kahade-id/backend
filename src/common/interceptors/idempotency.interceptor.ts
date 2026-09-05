import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
  BadRequestException,
  ServiceUnavailableException,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'crypto';
import { Prisma, IdempotencyRecordStatus } from '@prisma/client';
import { Observable, of, switchMap, catchError, throwError } from 'rxjs';
import { Reflector } from '@nestjs/core';
import { RedisService } from '../../redis/redis.service';
import { PrismaService } from '../../prisma/prisma.service';
import { IDEMPOTENCY_KEY } from '../decorators/idempotency.decorator';
import { IDEMPOTENCY_CACHE_KEY } from '../constants/redis-keys';
import { IDEMPOTENCY_TTL } from '../constants/app.constants';
import * as ErrorCodes from '../constants/error-codes';

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, child]) => [key, canonicalize(child)]),
    );
  }
  return value;
}

function requestFingerprint(body: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(canonicalize(body ?? null)))
    .digest('hex');
}

function isMoneyMovementPath(path: string): boolean {
  return (
    path.includes('/wallet/') ||
    path === '/wallet' ||
    path.startsWith('/bank-accounts') ||
    path.startsWith('/withdrawals/schedules') ||
    path.startsWith('/admin/finance')
  );
}

function makeInFlightSentinel(): string {
  return JSON.stringify({ status: 'in_flight', ts: Date.now() });
}

function isInFlightSentinel(value: string): boolean {
  try {
    const parsed = JSON.parse(value);
    return parsed && parsed.status === 'in_flight';
  } catch {
    return false;
  }
}

type LedgerClaim =
  | { acquired: true; recordId: string }
  | { acquired: false; responseBody: unknown }
  | { acquired: false; inFlight: true };

@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  private readonly logger = new Logger(IdempotencyInterceptor.name);

  constructor(
    private reflector: Reflector,
    private redisService: RedisService,
    private configService: ConfigService,
    private prismaService: PrismaService,
  ) {}

  private get ttl(): number {
    return this.configService.get<number>('app.idempotencyTtlSeconds') ?? IDEMPOTENCY_TTL;
  }

  async intercept(context: ExecutionContext, next: CallHandler): Promise<Observable<unknown>> {
    const isIdempotencyRequired = this.reflector.getAllAndOverride<boolean>(IDEMPOTENCY_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (!isIdempotencyRequired) {
      return next.handle();
    }

    const request = context.switchToHttp().getRequest();
    const idempotencyKey = request.headers['idempotency-key'];

    if (!idempotencyKey) {
      throw new BadRequestException({
        code: ErrorCodes.IDEMPOTENCY_KEY_REQUIRED,
        message: 'Idempotency-Key header (UUID v4) is required',
      });
    }

    const UUID_V4_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    if (!UUID_V4_REGEX.test(idempotencyKey)) {
      throw new BadRequestException({
        code: ErrorCodes.INVALID_IDEMPOTENCY_KEY,
        message:
          'Idempotency-Key must be a valid UUID v4 (e.g. xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx)',
      });
    }

    const payload = (request.admin ?? request.user) as { sub?: string; userId?: string } | undefined;
    const scopeId = payload?.sub ?? payload?.userId;
    const requestPath = String(request.originalUrl ?? request.url ?? 'unknown').split('?')[0];
    const fingerprint = requestFingerprint(request.body);
    const scopeKey = `${scopeId ?? 'anonymous'}:${String(request.method ?? 'POST').toUpperCase()}:${requestPath}:${idempotencyKey}`;
    const cacheKey = IDEMPOTENCY_CACHE_KEY(scopeKey);

    let claim: LedgerClaim;
    let durableRecord = true;
    try {
      claim = await this.claimDurably(scopeKey, idempotencyKey, scopeId, fingerprint);
    } catch (error) {
      if (error instanceof BadRequestException) {
        throw error;
      }
      if (isMoneyMovementPath(requestPath)) {
        this.logger.error(
          `[IdempotencyInterceptor] Durable ledger unavailable for Money Movement route: ${(error as Error).message}`,
        );
        throw new ServiceUnavailableException({
          code: ErrorCodes.IDEMPOTENCY_SERVICE_UNAVAILABLE,
          message:
            'Financial mutation safety service unavailable. Please retry after a short delay.',
        });
      }
      durableRecord = false;
      this.logger.error(
        `[IdempotencyInterceptor] PostgreSQL ledger unavailable; using Redis fallback: ${(error as Error).message}`,
      );
      claim = await this.claimWithRedis(cacheKey, idempotencyKey);
    }

    if (!claim.acquired) {
      if ('responseBody' in claim) {
        return of(claim.responseBody);
      }
      throw new BadRequestException({
        code: ErrorCodes.IDEMPOTENCY_KEY_IN_USE,
        message:
          'A request with this Idempotency-Key is already being processed. Please retry shortly.',
      });
    }

    const MAX_IDEMPOTENCY_RESPONSE_SIZE = 512 * 1024;
    const recordId = durableRecord ? claim.recordId : undefined;

    // Redis is an acceleration layer only. A stale Redis sentinel must never
    // override the PostgreSQL claim, which is the durable source of truth.
    await this.redisService
      .setNx(cacheKey, makeInFlightSentinel(), this.ttl)
      .catch((error: Error) => {
        this.logger.warn(
          `[IdempotencyInterceptor] Redis sentinel unavailable; PostgreSQL ledger remains authoritative: ${error.message}`,
        );
      });

    return next.handle().pipe(
      switchMap(async (response: unknown) => {
        const serialized = JSON.stringify(response) ?? 'null';
        if (recordId) {
          try {
            await this.prismaService.idempotencyRecord.update({
              where: { id: recordId },
              data: {
                status: IdempotencyRecordStatus.COMPLETED,
                responseBody: JSON.parse(serialized) as Prisma.InputJsonValue,
                statusCode: 200,
                completedAt: new Date(),
                expiresAt: new Date(Date.now() + this.ttl * 1000),
                errorMessage: null,
              },
            });
          } catch (error) {
            // The mutation already committed. Keep the IN_FLIGHT ledger row so
            // a retry cannot execute the same financial operation again.
            this.logger.error(
              `[IdempotencyInterceptor] Ledger completion failed; keeping claim for key ${scopeKey}: ${(error as Error).message}`,
            );
          }
        }

        if (serialized.length <= MAX_IDEMPOTENCY_RESPONSE_SIZE) {
          try {
            await this.redisService.setex(cacheKey, this.ttl, serialized, { throwOnError: true });
          } catch (error) {
            this.logger.error(
              `[IdempotencyInterceptor] Response cache failed after mutation success for key ${cacheKey}: ${(error as Error).message}`,
            );
          }
        } else {
          this.logger.warn(
            `[IdempotencyInterceptor] Response too large (${serialized.length} bytes) for key ${cacheKey}; durable ledger remains authoritative`,
          );
        }
        return response;
      }),
      catchError((err: unknown) => {
        if (recordId) {
          this.prismaService.idempotencyRecord
            .delete({ where: { id: recordId } })
            .catch((error: Error) => {
              this.logger.error(
                `[IdempotencyInterceptor] Failed to remove failed ledger claim for key ${scopeKey}: ${error.message}`,
              );
            });
        }
        this.redisService.del(cacheKey).catch((error: Error) => {
          this.logger.error(
            `[IdempotencyInterceptor] Failed to clean up Redis sentinel for key ${cacheKey}: ${error.message}`,
          );
        });
        return throwError(() => err);
      }),
    );
  }

  private async claimDurably(
    scopeKey: string,
    key: string,
    userId: string | undefined,
    requestHash: string,
  ): Promise<LedgerClaim> {
    const now = new Date();
    const expiresAt = new Date(now.getTime() + this.ttl * 1000);

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const existing = await this.prismaService.idempotencyRecord.findUnique({
        where: { scopeKey },
      });

      if (!existing) {
        try {
          const created = await this.prismaService.idempotencyRecord.create({
            data: {
              scopeKey,
              key,
              userId,
              requestHash,
              status: IdempotencyRecordStatus.IN_FLIGHT,
              expiresAt,
            },
            select: { id: true },
          });
          return { acquired: true, recordId: created.id };
        } catch (error) {
          // A concurrent request may have won the unique scopeKey insert.
          if ((error as { code?: string }).code === 'P2002') continue;
          throw error;
        }
      }

      if (existing.expiresAt > now) {
        if (existing.requestHash && existing.requestHash !== requestHash) {
          throw new BadRequestException({
            code: ErrorCodes.IDEMPOTENCY_KEY_REUSE,
            message: 'Idempotency-Key was already used with a different request payload.',
          });
        }
        if (existing.status === IdempotencyRecordStatus.COMPLETED) {
          return { acquired: false, responseBody: existing.responseBody };
        }
        return { acquired: false, inFlight: true };
      }

      const reclaimed = await this.prismaService.idempotencyRecord.updateMany({
        where: { id: existing.id, expiresAt: { lte: now } },
        data: {
          key,
          userId,
          requestHash,
          status: IdempotencyRecordStatus.IN_FLIGHT,
          responseBody: Prisma.JsonNull,
          statusCode: 200,
          errorMessage: null,
          completedAt: null,
          expiresAt,
        },
      });
      if (reclaimed.count === 1) return { acquired: true, recordId: existing.id };
    }

    return { acquired: false, inFlight: true };
  }

  private async claimWithRedis(cacheKey: string, idempotencyKey: string): Promise<LedgerClaim> {
    let acquired: boolean;
    try {
      acquired = await this.redisService.setNx(cacheKey, makeInFlightSentinel(), this.ttl);
    } catch {
      const failOpen = this.configService.get<boolean>('app.idempotencyFailOpen') === true;
      if (failOpen) {
        this.logger.warn(
          `[IdempotencyInterceptor] Redis unavailable (fail-open) — bypassing idempotency for key: ${idempotencyKey}`,
        );
        return { acquired: true, recordId: '' };
      }
      throw new ServiceUnavailableException({
        code: ErrorCodes.IDEMPOTENCY_SERVICE_UNAVAILABLE,
        message: 'Idempotency service unavailable. Please retry after a short delay.',
      });
    }

    if (acquired) return { acquired: true, recordId: '' };

    let cachedResponse: string | null = null;
    try {
      cachedResponse = await this.redisService.get(cacheKey);
    } catch {
      throw new ServiceUnavailableException({
        code: ErrorCodes.IDEMPOTENCY_SERVICE_UNAVAILABLE,
        message: 'Idempotency check failed. Please retry after a short delay.',
      });
    }

    if (cachedResponse && !isInFlightSentinel(cachedResponse)) {
      try {
        return { acquired: false, responseBody: JSON.parse(cachedResponse) };
      } catch {
        await this.redisService.del(cacheKey).catch(() => undefined);
        return { acquired: true, recordId: '' };
      }
    }

    throw new BadRequestException({
      code: ErrorCodes.IDEMPOTENCY_KEY_IN_USE,
      message:
        'A request with this Idempotency-Key is already being processed. Please retry shortly.',
    });
  }
}
