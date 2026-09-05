import { Logger } from '@nestjs/common';
import type { RedisService } from '../../redis/redis.service';

export interface LockRenewalHandle {
  readonly lost: () => boolean;
  stop(): void;
}

/**
 * Bounds an asynchronous probe without allowing a slow dependency to hold the
 * health/readiness request forever. The underlying operation is intentionally
 * not cancelled because Prisma/Bull/Redis do not share one cancellation API;
 * callers must still treat a timeout as a failed probe.
 */
export async function withTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  const boundedTimeoutMs = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 5_000;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${boundedTimeoutMs}ms`)), boundedTimeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Renews a Redis lock before half of its lease elapses and records lease loss.
 * The callback is deliberately invoked only after the token-aware renewal
 * fails; callers must stop before starting another unit of work.
 */
export function startLockRenewal(
  redis: RedisService,
  key: string,
  token: string,
  ttlSeconds: number,
  logger: Logger,
  onLost?: () => void,
): LockRenewalHandle {
  const safeTtl = Number.isInteger(ttlSeconds) && ttlSeconds > 1 ? ttlSeconds : 60;
  const intervalMs = Math.max(1_000, Math.floor((safeTtl * 1_000) / 3));
  let lockLost = false;
  let renewing = false;

  const renewal = setInterval(() => {
    if (renewing || lockLost) return;
    renewing = true;
    void redis.renewLock(key, token, safeTtl)
      .then((renewed) => {
        if (!renewed) {
          lockLost = true;
          logger.error(`Lost Redis lease for ${key}; aborting remaining work`);
          onLost?.();
        }
      })
      .catch((error: unknown) => {
        lockLost = true;
        logger.error(`Redis lease renewal failed for ${key}; aborting remaining work`, error instanceof Error ? error.stack : String(error));
        onLost?.();
      })
      .finally(() => {
        renewing = false;
      });
  }, intervalMs);
  renewal.unref?.();

  return {
    lost: () => lockLost,
    stop: () => clearInterval(renewal),
  };
}

export function safeErrorMessage(error: unknown, maxLength = 4_000): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, maxLength);
}

export function parseStrictInteger(raw: string | undefined, fallback: number, min: number, max: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  if (!/^[+-]?\d+$/.test(raw.trim())) return fallback;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= min && value <= max ? value : fallback;
}

export function parseStrictBoolean(raw: string | undefined, fallback = false): boolean {
  if (raw === undefined || raw.trim() === '') return fallback;
  return raw.trim().toLowerCase() === 'true' ? true : raw.trim().toLowerCase() === 'false' ? false : fallback;
}
