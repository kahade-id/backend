import { Logger } from '@nestjs/common';

const logger = new Logger('CacheUtil');

export async function getCached<T>(
  redis: { get: (key: string) => Promise<string | null>; setex: (key: string, ttl: number, value: string) => Promise<unknown> },
  key: string,
  ttlSeconds: number,
  fetcher: () => Promise<T>,
): Promise<T> {
  try {
    const cached = await redis.get(key);
    if (cached !== null) {
      return JSON.parse(cached) as T;
    }
  } catch (err) {
    // Redis failure should not block the request — log and fall through to DB
    logger.warn(`Cache GET failed for key="${key}": ${(err as Error).message}`);
  }

  const data = await fetcher();

  try {
    await redis.setex(key, ttlSeconds, JSON.stringify(data));
  } catch (err) {
    // Cache write failure is non-fatal
    logger.warn(`Cache SET failed for key="${key}": ${(err as Error).message}`);
  }

  return data;
}

/**
 * Invalidate a cache key (e.g., after profile update or order status change).
 */
export async function invalidateCache(
  redis: { del: (key: string) => Promise<unknown> },
  key: string,
): Promise<void> {
  try {
    await redis.del(key);
  } catch (err) {
    logger.warn(`Cache DEL failed for key="${key}": ${(err as Error).message}`);
  }
}

/**
 * Standard TTL constants for consistent cache behavior across services.
 */
export const CacheTTL = {
  PUBLIC_PROFILE: 300,   // 5 minutes — public user profiles
  ORDER_DETAIL: 30,      // 30 seconds — order status can change frequently
  USER_STATS: 120,       // 2 minutes — stats aggregates
  WALLET_BALANCE: 10,    // 10 seconds — balance is critical, short TTL
  VOUCHER_LIST: 600,     // 10 minutes — vouchers change infrequently
} as const;
