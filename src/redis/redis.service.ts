import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import Redis from 'ioredis';
import { withTimeout } from '../common/utils/background-reliability.util';

const MAX_RETRIES = 10;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 5_000;

function assertPositiveTtl(seconds: number, operation: string): void {
  if (!Number.isInteger(seconds) || seconds <= 0) {
    throw new Error(`Redis ${operation} TTL must be a positive integer; received ${String(seconds)}`);
  }
}
const DEL_PIPELINE_BATCH_SIZE = 1000;

@Injectable()
export class RedisService implements OnModuleDestroy {
  private client: Redis;
  private prefix: string;
  private isShuttingDown = false;
  private readonly logger = new Logger(RedisService.name);

  constructor(redisUrl: string, prefix: string) {
    const offline = process.env.OPENAPI_GENERATE === 'true';
    this.client = new Redis(redisUrl, {
      lazyConnect: offline,
      maxRetriesPerRequest: 3,
      retryStrategy(times: number) {
        if (times > MAX_RETRIES) {
          return null;
        }
        const baseDelay = 100;
        const delay = Math.min(baseDelay * Math.pow(2, times - 1), 5000);
        return delay;
      },
      connectTimeout: 10000,
      enableReadyCheck: true,
      reconnectOnError(err: Error) {
        const targetErrors = ['READONLY', 'ECONNRESET', 'ECONNREFUSED'];
        return targetErrors.some(e => err.message.includes(e));
      },
    });
    this.prefix = prefix || 'kahade:';

    this.client.on('connect', () => this.logger.log('Redis connecting...'));
    this.client.on('ready', () => this.logger.log('Redis connection ready'));
    this.client.on('error', (err) => this.logger.error('Redis connection error:', err.message));
    // `close` fires on graceful quit() too, so an ordinary restart used to emit
    // a warning that looked like an incident. Only an unexpected drop is worth
    // warning about.
    this.client.on('close', () => {
      if (this.isShuttingDown) {
        this.logger.log('Redis connection closed (shutdown)');
      } else {
        this.logger.warn('Redis connection closed unexpectedly');
      }
    });
    this.client.on('reconnecting', (ms: number) => this.logger.warn(`Redis reconnecting in ${ms}ms`));
  }

  private getKey(key: string): string {
    return `${this.prefix}${key}`;
  }

  async get(key: string, opts?: { throwOnError?: boolean }): Promise<string | null> {
    try {
      return await this.client.get(this.getKey(key));
    } catch (error) {
      this.logger.error(`Redis GET failed for key ${key}:`, error);
      if (opts?.throwOnError) throw error;
      return null;
    }
  }

  /** Atomically read and delete a value, preventing concurrent one-time token reuse. */
  async getAndDelete(key: string, opts?: { throwOnError?: boolean }): Promise<string | null> {
    const script = `
      local value = redis.call('get', KEYS[1])
      if value then redis.call('del', KEYS[1]) end
      return value
    `;
    try {
      return await this.client.eval(script, 1, this.getKey(key)) as string | null;
    } catch (error) {
      this.logger.error(`Redis GETDEL failed for key ${key}:`, error);
      if (opts?.throwOnError) throw error;
      return null;
    }
  }

  async set(key: string, value: string, ttlSeconds?: number, opts?: { throwOnError?: boolean }): Promise<void> {
    if (ttlSeconds !== undefined) assertPositiveTtl(ttlSeconds, 'SET');
    try {
      if (ttlSeconds !== undefined) {
        await this.client.setex(this.getKey(key), ttlSeconds, value);
      } else {
        if (process.env.NODE_ENV === 'production') {
          this.logger.warn(`Redis SET without TTL for key "${key}" — key will persist indefinitely`);
        }
        await this.client.set(this.getKey(key), value);
      }
    } catch (error) {
      this.logger.error(`Redis SET failed for key ${key}:`, error);
      if (opts?.throwOnError) throw error;
    }
  }

  async setex(key: string, seconds: number, value: string, opts?: { throwOnError?: boolean }): Promise<void> {
    assertPositiveTtl(seconds, 'SETEX');
    try {
      await this.client.setex(this.getKey(key), seconds, value);
    } catch (error) {
      this.logger.error(`Redis SETEX failed for key ${key}:`, error);
      if (opts?.throwOnError) throw error;
    }
  }

  async del(key: string, opts?: { throwOnError?: boolean }): Promise<void> {
    try {
      await this.client.del(this.getKey(key));
    } catch (error) {
      this.logger.error(`Redis DEL failed for key ${key}:`, error);
      if (opts?.throwOnError) throw error;
    }
  }

  async delPattern(pattern: string): Promise<void> {
    try {
      // A partial SCAN result is not safe for destructive invalidation: if Redis
      // disconnects halfway through, fail instead of deleting an incomplete set
      // and leaving a misleadingly "successful" cache state.
      const keys = await this.scanStrict(pattern);
      if (keys.length === 0) return;
      for (let i = 0; i < keys.length; i += DEL_PIPELINE_BATCH_SIZE) {
        const batch = keys.slice(i, i + DEL_PIPELINE_BATCH_SIZE);
        const pipeline = this.client.pipeline();
        for (const k of batch) {
          pipeline.del(k);
        }
        await pipeline.exec();
      }
    } catch (error) {
      this.logger.error(`Redis DEL pattern failed for pattern ${pattern}:`, error);
    }
  }

  async incr(key: string, opts?: { throwOnError?: boolean }): Promise<number> {
    try {
      return await this.client.incr(this.getKey(key));
    } catch (error) {
      this.logger.error(`Redis INCR failed for key ${key}:`, error);
      if (opts?.throwOnError !== false) throw error;
      return 0;
    }
  }

  async decr(key: string): Promise<number> {
    try {
      return await this.client.decr(this.getKey(key));
    } catch (error) {
      this.logger.error(`Redis DECR failed for key ${key}:`, error);
      throw error;
    }
  }

  async incrBy(key: string, increment: number): Promise<number> {
    try {
      return await this.client.incrby(this.getKey(key), increment);
    } catch (error) {
      this.logger.error(`Redis INCRBY failed for key ${key}:`, error);
      throw error;
    }
  }

  async decrBy(key: string, decrement: number): Promise<number> {
    try {
      return await this.client.decrby(this.getKey(key), decrement);
    } catch (error) {
      this.logger.error(`Redis DECRBY failed for key ${key}:`, error);
      throw error;
    }
  }

  async expire(key: string, seconds: number, opts?: { throwOnError?: boolean }): Promise<void> {
    assertPositiveTtl(seconds, 'EXPIRE');
    try {
      await this.client.expire(this.getKey(key), seconds);
    } catch (error) {
      this.logger.error(`Redis EXPIRE failed for key ${key}:`, error);
      if (opts?.throwOnError) throw error;
    }
  }

  /** Renew a lock only when the caller still owns its token. */
  async renewLock(key: string, token: string, ttlSeconds: number): Promise<boolean> {
    assertPositiveTtl(ttlSeconds, 'lock renewal');
    const script = `
      if redis.call('get', KEYS[1]) == ARGV[1] then
        return redis.call('expire', KEYS[1], ARGV[2])
      end
      return 0
    `;
    try {
      const result = await this.client.eval(script, 1, this.getKey(key), token, ttlSeconds) as number;
      return result === 1;
    } catch (error) {
      this.logger.warn(`Redis renewLock failed for key ${key}: ${(error as Error).message}`);
      return false;
    }
  }

  async hset(key: string, field: string, value: string): Promise<void> {
    try {
      await this.client.hset(this.getKey(key), field, value);
    } catch (error) {
      this.logger.error(`Redis HSET failed for key ${key}:`, error);
    }
  }

  async hlen(key: string): Promise<number> {
    try {
      return await this.client.hlen(this.getKey(key));
    } catch (error) {
      this.logger.error(`Redis HLEN failed for key ${key}:`, error);
      return 0;
    }
  }

  async hget(key: string, field: string): Promise<string | null> {
    try {
      return await this.client.hget(this.getKey(key), field);
    } catch (error) {
      this.logger.error(`Redis HGET failed for key ${key}:`, error);
      return null;
    }
  }

  async hgetall(key: string, opts?: { throwOnError?: boolean }): Promise<Record<string, string> | null> {
    try {
      const result = await this.client.hgetall(this.getKey(key));
      return Object.keys(result).length === 0 ? null : result;
    } catch (error) {
      this.logger.error(`Redis HGETALL failed for key ${key}:`, error);
      if (opts?.throwOnError) throw error;
      return null;
    }
  }

  async hdel(key: string, ...fields: string[]): Promise<number> {
    try {
      return await this.client.hdel(this.getKey(key), ...fields);
    } catch (error) {
      this.logger.error(`Redis HDEL failed for key ${key}:`, error);
      throw error;
    }
  }

  async scan(pattern: string): Promise<string[]> {
    try {
      return await this.scanStrict(pattern);
    } catch (error) {
      this.logger.error(`Redis SCAN failed for pattern ${pattern}:`, error);
      return [];
    }
  }

  async scanStrict(pattern: string): Promise<string[]> {
    const result: string[] = [];
    let cursor = '0';
    do {
      const [nextCursor, keys] = await this.client.scan(
        cursor,
        'MATCH',
        this.getKey(pattern),
        'COUNT',
        100,
      );
      cursor = nextCursor;
      result.push(...keys);
    } while (cursor !== '0');
    return result;
  }

  async ttl(key: string): Promise<number> {
    try {
      return await this.client.ttl(this.getKey(key));
    } catch (error) {
      this.logger.error(`Redis TTL failed for key ${key}:`, error);
      return -1;
    }
  }

  async exists(key: string): Promise<number> {
    try {
      return await this.client.exists(this.getKey(key));
    } catch (error) {
      this.logger.error(`Redis EXISTS failed for key ${key}:`, error);
      return 0;
    }
  }

  async ping(): Promise<boolean> {
    try {
      const result = await this.client.ping();
      return result === 'PONG';
    } catch (error) {
      this.logger.error('Redis PING failed:', error);
      return false;
    }
  }

  async isHealthy(): Promise<boolean> {
    return this.ping();
  }

  getClient(): Redis {
    return this.client;
  }

  getPrefix(): string {
    return this.prefix;
  }

  async onModuleDestroy(): Promise<void> {
    this.isShuttingDown = true;
    if (process.env.OPENAPI_GENERATE === 'true') {
      this.client.disconnect();
      return;
    }
    try {
      await withTimeout(this.client.quit(), DEFAULT_SHUTDOWN_TIMEOUT_MS, 'Redis shutdown');
    } catch (error) {
      this.logger.warn(`Redis graceful shutdown failed; disconnecting: ${error instanceof Error ? error.message : String(error)}`);
      this.client.disconnect();
    }
  }

  async zadd(key: string, score: number, member: string): Promise<number> {
    return this.client.zadd(this.getKey(key), score, member);
  }

  async zremrangebyscore(key: string, min: number | string, max: number | string): Promise<number> {
    return this.client.zremrangebyscore(this.getKey(key), min, max);
  }

  async zcard(key: string): Promise<number> {
    return this.client.zcard(this.getKey(key));
  }

  async evalSlidingWindow(key: string, windowMs: number, limit: number, nowMs: number): Promise<boolean> {
    const script = `
      local key = KEYS[1]
      local window = tonumber(ARGV[1])
      local limit = tonumber(ARGV[2])
      local now = tonumber(ARGV[3])
      redis.call('ZREMRANGEBYSCORE', key, '-inf', now - window)
      local count = redis.call('ZCARD', key)
      if count < limit then
        redis.call('ZADD', key, now, now .. ':' .. math.random(1000000))
        redis.call('EXPIRE', key, math.ceil(window / 1000) + 1)
        return 1
      end
      return 0
    `;
    const result = await this.client.eval(script, 1, this.getKey(key), windowMs, limit, nowMs) as number;
    return result === 1;
  }

  async setNx(key: string, value: string, ttlSeconds: number, opts?: { throwOnError?: boolean }): Promise<boolean> {
    assertPositiveTtl(ttlSeconds, 'SET NX');
    try {
      const result = await this.client.set(this.getKey(key), value, 'EX', ttlSeconds, 'NX');
      return result === 'OK';
    } catch (error) {
      this.logger.error(`Redis SET NX failed for key ${key}:`, error);
      if (opts?.throwOnError !== false) throw error;
      return false;
    }
  }

  async consumeOnce(key: string, opts?: { throwOnError?: boolean }): Promise<boolean> {
    const script = `
      if redis.call("get", KEYS[1]) then
        return redis.call("del", KEYS[1])
      end
      return 0
    `;
    try {
      const result = await this.client.eval(script, 1, this.getKey(key)) as number;
      return result === 1;
    } catch (error) {
      this.logger.error(`Redis CONSUME ONCE failed for key ${key}:`, error);
      if (opts?.throwOnError) throw error;
      return false;
    }
  }

  async releaseLock(key: string, token: string): Promise<boolean> {
    const script = `
      if redis.call("get", KEYS[1]) == ARGV[1] then
        return redis.call("del", KEYS[1])
      else
        return 0
      end
    `;
    try {
      const result = await this.client.eval(script, 1, this.getKey(key), token) as number;
      return result === 1;
    } catch (error) {
      this.logger.warn(`Redis releaseLock failed for key ${key}: ${(error as Error).message}`);
      return false;
    }
  }
}
