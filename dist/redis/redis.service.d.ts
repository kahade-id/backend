import { OnModuleDestroy } from '@nestjs/common';
import Redis from 'ioredis';
export declare class RedisService implements OnModuleDestroy {
    private client;
    private prefix;
    private isShuttingDown;
    private readonly logger;
    constructor(redisUrl: string, prefix: string);
    private getKey;
    get(key: string, opts?: {
        throwOnError?: boolean;
    }): Promise<string | null>;
    getAndDelete(key: string, opts?: {
        throwOnError?: boolean;
    }): Promise<string | null>;
    set(key: string, value: string, ttlSeconds?: number, opts?: {
        throwOnError?: boolean;
    }): Promise<void>;
    setex(key: string, seconds: number, value: string, opts?: {
        throwOnError?: boolean;
    }): Promise<void>;
    del(key: string, opts?: {
        throwOnError?: boolean;
    }): Promise<void>;
    delPattern(pattern: string): Promise<void>;
    incr(key: string, opts?: {
        throwOnError?: boolean;
    }): Promise<number>;
    decr(key: string): Promise<number>;
    incrBy(key: string, increment: number): Promise<number>;
    decrBy(key: string, decrement: number): Promise<number>;
    expire(key: string, seconds: number, opts?: {
        throwOnError?: boolean;
    }): Promise<void>;
    renewLock(key: string, token: string, ttlSeconds: number): Promise<boolean>;
    hset(key: string, field: string, value: string): Promise<void>;
    hlen(key: string): Promise<number>;
    hget(key: string, field: string): Promise<string | null>;
    hgetall(key: string, opts?: {
        throwOnError?: boolean;
    }): Promise<Record<string, string> | null>;
    hdel(key: string, ...fields: string[]): Promise<number>;
    scan(pattern: string): Promise<string[]>;
    scanStrict(pattern: string): Promise<string[]>;
    ttl(key: string): Promise<number>;
    exists(key: string): Promise<number>;
    ping(): Promise<boolean>;
    isHealthy(): Promise<boolean>;
    getClient(): Redis;
    getPrefix(): string;
    onModuleDestroy(): Promise<void>;
    zadd(key: string, score: number, member: string): Promise<number>;
    zremrangebyscore(key: string, min: number | string, max: number | string): Promise<number>;
    zcard(key: string): Promise<number>;
    evalSlidingWindow(key: string, windowMs: number, limit: number, nowMs: number): Promise<boolean>;
    setNx(key: string, value: string, ttlSeconds: number, opts?: {
        throwOnError?: boolean;
    }): Promise<boolean>;
    consumeOnce(key: string, opts?: {
        throwOnError?: boolean;
    }): Promise<boolean>;
    releaseLock(key: string, token: string): Promise<boolean>;
}
