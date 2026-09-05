import { Logger } from '@nestjs/common';
import type { RedisService } from '../../redis/redis.service';
export interface LockRenewalHandle {
    readonly lost: () => boolean;
    stop(): void;
}
export declare function withTimeout<T>(operation: Promise<T>, timeoutMs: number, label: string): Promise<T>;
export declare function startLockRenewal(redis: RedisService, key: string, token: string, ttlSeconds: number, logger: Logger, onLost?: () => void): LockRenewalHandle;
export declare function safeErrorMessage(error: unknown, maxLength?: number): string;
export declare function parseStrictInteger(raw: string | undefined, fallback: number, min: number, max: number): number;
export declare function parseStrictBoolean(raw: string | undefined, fallback?: boolean): boolean;
