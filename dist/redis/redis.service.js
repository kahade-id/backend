"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
var RedisService_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.RedisService = void 0;
const common_1 = require("@nestjs/common");
const ioredis_1 = __importDefault(require("ioredis"));
const background_reliability_util_1 = require("../common/utils/background-reliability.util");
const MAX_RETRIES = 10;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 5_000;
function assertPositiveTtl(seconds, operation) {
    if (!Number.isInteger(seconds) || seconds <= 0) {
        throw new Error(`Redis ${operation} TTL must be a positive integer; received ${String(seconds)}`);
    }
}
const DEL_PIPELINE_BATCH_SIZE = 1000;
let RedisService = RedisService_1 = class RedisService {
    constructor(redisUrl, prefix) {
        this.isShuttingDown = false;
        this.logger = new common_1.Logger(RedisService_1.name);
        const offline = process.env.OPENAPI_GENERATE === 'true';
        this.client = new ioredis_1.default(redisUrl, {
            lazyConnect: offline,
            maxRetriesPerRequest: 3,
            retryStrategy(times) {
                if (times > MAX_RETRIES) {
                    return null;
                }
                const baseDelay = 100;
                const delay = Math.min(baseDelay * Math.pow(2, times - 1), 5000);
                return delay;
            },
            connectTimeout: 10000,
            enableReadyCheck: true,
            reconnectOnError(err) {
                const targetErrors = ['READONLY', 'ECONNRESET', 'ECONNREFUSED'];
                return targetErrors.some(e => err.message.includes(e));
            },
        });
        this.prefix = prefix || 'kahade:';
        this.client.on('connect', () => this.logger.log('Redis connecting...'));
        this.client.on('ready', () => this.logger.log('Redis connection ready'));
        this.client.on('error', (err) => this.logger.error('Redis connection error:', err.message));
        this.client.on('close', () => {
            if (this.isShuttingDown) {
                this.logger.log('Redis connection closed (shutdown)');
            }
            else {
                this.logger.warn('Redis connection closed unexpectedly');
            }
        });
        this.client.on('reconnecting', (ms) => this.logger.warn(`Redis reconnecting in ${ms}ms`));
    }
    getKey(key) {
        return `${this.prefix}${key}`;
    }
    async get(key, opts) {
        try {
            return await this.client.get(this.getKey(key));
        }
        catch (error) {
            this.logger.error(`Redis GET failed for key ${key}:`, error);
            if (opts?.throwOnError)
                throw error;
            return null;
        }
    }
    async getAndDelete(key, opts) {
        const script = `
      local value = redis.call('get', KEYS[1])
      if value then redis.call('del', KEYS[1]) end
      return value
    `;
        try {
            return await this.client.eval(script, 1, this.getKey(key));
        }
        catch (error) {
            this.logger.error(`Redis GETDEL failed for key ${key}:`, error);
            if (opts?.throwOnError)
                throw error;
            return null;
        }
    }
    async set(key, value, ttlSeconds, opts) {
        if (ttlSeconds !== undefined)
            assertPositiveTtl(ttlSeconds, 'SET');
        try {
            if (ttlSeconds !== undefined) {
                await this.client.setex(this.getKey(key), ttlSeconds, value);
            }
            else {
                if (process.env.NODE_ENV === 'production') {
                    this.logger.warn(`Redis SET without TTL for key "${key}" — key will persist indefinitely`);
                }
                await this.client.set(this.getKey(key), value);
            }
        }
        catch (error) {
            this.logger.error(`Redis SET failed for key ${key}:`, error);
            if (opts?.throwOnError)
                throw error;
        }
    }
    async setex(key, seconds, value, opts) {
        assertPositiveTtl(seconds, 'SETEX');
        try {
            await this.client.setex(this.getKey(key), seconds, value);
        }
        catch (error) {
            this.logger.error(`Redis SETEX failed for key ${key}:`, error);
            if (opts?.throwOnError)
                throw error;
        }
    }
    async del(key, opts) {
        try {
            await this.client.del(this.getKey(key));
        }
        catch (error) {
            this.logger.error(`Redis DEL failed for key ${key}:`, error);
            if (opts?.throwOnError)
                throw error;
        }
    }
    async delPattern(pattern) {
        try {
            const keys = await this.scanStrict(pattern);
            if (keys.length === 0)
                return;
            for (let i = 0; i < keys.length; i += DEL_PIPELINE_BATCH_SIZE) {
                const batch = keys.slice(i, i + DEL_PIPELINE_BATCH_SIZE);
                const pipeline = this.client.pipeline();
                for (const k of batch) {
                    pipeline.del(k);
                }
                await pipeline.exec();
            }
        }
        catch (error) {
            this.logger.error(`Redis DEL pattern failed for pattern ${pattern}:`, error);
        }
    }
    async incr(key, opts) {
        try {
            return await this.client.incr(this.getKey(key));
        }
        catch (error) {
            this.logger.error(`Redis INCR failed for key ${key}:`, error);
            if (opts?.throwOnError !== false)
                throw error;
            return 0;
        }
    }
    async decr(key) {
        try {
            return await this.client.decr(this.getKey(key));
        }
        catch (error) {
            this.logger.error(`Redis DECR failed for key ${key}:`, error);
            throw error;
        }
    }
    async incrBy(key, increment) {
        try {
            return await this.client.incrby(this.getKey(key), increment);
        }
        catch (error) {
            this.logger.error(`Redis INCRBY failed for key ${key}:`, error);
            throw error;
        }
    }
    async decrBy(key, decrement) {
        try {
            return await this.client.decrby(this.getKey(key), decrement);
        }
        catch (error) {
            this.logger.error(`Redis DECRBY failed for key ${key}:`, error);
            throw error;
        }
    }
    async expire(key, seconds, opts) {
        assertPositiveTtl(seconds, 'EXPIRE');
        try {
            await this.client.expire(this.getKey(key), seconds);
        }
        catch (error) {
            this.logger.error(`Redis EXPIRE failed for key ${key}:`, error);
            if (opts?.throwOnError)
                throw error;
        }
    }
    async renewLock(key, token, ttlSeconds) {
        assertPositiveTtl(ttlSeconds, 'lock renewal');
        const script = `
      if redis.call('get', KEYS[1]) == ARGV[1] then
        return redis.call('expire', KEYS[1], ARGV[2])
      end
      return 0
    `;
        try {
            const result = await this.client.eval(script, 1, this.getKey(key), token, ttlSeconds);
            return result === 1;
        }
        catch (error) {
            this.logger.warn(`Redis renewLock failed for key ${key}: ${error.message}`);
            return false;
        }
    }
    async hset(key, field, value) {
        try {
            await this.client.hset(this.getKey(key), field, value);
        }
        catch (error) {
            this.logger.error(`Redis HSET failed for key ${key}:`, error);
        }
    }
    async hlen(key) {
        try {
            return await this.client.hlen(this.getKey(key));
        }
        catch (error) {
            this.logger.error(`Redis HLEN failed for key ${key}:`, error);
            return 0;
        }
    }
    async hget(key, field) {
        try {
            return await this.client.hget(this.getKey(key), field);
        }
        catch (error) {
            this.logger.error(`Redis HGET failed for key ${key}:`, error);
            return null;
        }
    }
    async hgetall(key, opts) {
        try {
            const result = await this.client.hgetall(this.getKey(key));
            return Object.keys(result).length === 0 ? null : result;
        }
        catch (error) {
            this.logger.error(`Redis HGETALL failed for key ${key}:`, error);
            if (opts?.throwOnError)
                throw error;
            return null;
        }
    }
    async hdel(key, ...fields) {
        try {
            return await this.client.hdel(this.getKey(key), ...fields);
        }
        catch (error) {
            this.logger.error(`Redis HDEL failed for key ${key}:`, error);
            throw error;
        }
    }
    async scan(pattern) {
        try {
            return await this.scanStrict(pattern);
        }
        catch (error) {
            this.logger.error(`Redis SCAN failed for pattern ${pattern}:`, error);
            return [];
        }
    }
    async scanStrict(pattern) {
        const result = [];
        let cursor = '0';
        do {
            const [nextCursor, keys] = await this.client.scan(cursor, 'MATCH', this.getKey(pattern), 'COUNT', 100);
            cursor = nextCursor;
            result.push(...keys);
        } while (cursor !== '0');
        return result;
    }
    async ttl(key) {
        try {
            return await this.client.ttl(this.getKey(key));
        }
        catch (error) {
            this.logger.error(`Redis TTL failed for key ${key}:`, error);
            return -1;
        }
    }
    async exists(key) {
        try {
            return await this.client.exists(this.getKey(key));
        }
        catch (error) {
            this.logger.error(`Redis EXISTS failed for key ${key}:`, error);
            return 0;
        }
    }
    async ping() {
        try {
            const result = await this.client.ping();
            return result === 'PONG';
        }
        catch (error) {
            this.logger.error('Redis PING failed:', error);
            return false;
        }
    }
    async isHealthy() {
        return this.ping();
    }
    getClient() {
        return this.client;
    }
    getPrefix() {
        return this.prefix;
    }
    async onModuleDestroy() {
        this.isShuttingDown = true;
        if (process.env.OPENAPI_GENERATE === 'true') {
            this.client.disconnect();
            return;
        }
        try {
            await (0, background_reliability_util_1.withTimeout)(this.client.quit(), DEFAULT_SHUTDOWN_TIMEOUT_MS, 'Redis shutdown');
        }
        catch (error) {
            this.logger.warn(`Redis graceful shutdown failed; disconnecting: ${error instanceof Error ? error.message : String(error)}`);
            this.client.disconnect();
        }
    }
    async zadd(key, score, member) {
        return this.client.zadd(this.getKey(key), score, member);
    }
    async zremrangebyscore(key, min, max) {
        return this.client.zremrangebyscore(this.getKey(key), min, max);
    }
    async zcard(key) {
        return this.client.zcard(this.getKey(key));
    }
    async evalSlidingWindow(key, windowMs, limit, nowMs) {
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
        const result = await this.client.eval(script, 1, this.getKey(key), windowMs, limit, nowMs);
        return result === 1;
    }
    async setNx(key, value, ttlSeconds, opts) {
        assertPositiveTtl(ttlSeconds, 'SET NX');
        try {
            const result = await this.client.set(this.getKey(key), value, 'EX', ttlSeconds, 'NX');
            return result === 'OK';
        }
        catch (error) {
            this.logger.error(`Redis SET NX failed for key ${key}:`, error);
            if (opts?.throwOnError !== false)
                throw error;
            return false;
        }
    }
    async consumeOnce(key, opts) {
        const script = `
      if redis.call("get", KEYS[1]) then
        return redis.call("del", KEYS[1])
      end
      return 0
    `;
        try {
            const result = await this.client.eval(script, 1, this.getKey(key));
            return result === 1;
        }
        catch (error) {
            this.logger.error(`Redis CONSUME ONCE failed for key ${key}:`, error);
            if (opts?.throwOnError)
                throw error;
            return false;
        }
    }
    async releaseLock(key, token) {
        const script = `
      if redis.call("get", KEYS[1]) == ARGV[1] then
        return redis.call("del", KEYS[1])
      else
        return 0
      end
    `;
        try {
            const result = await this.client.eval(script, 1, this.getKey(key), token);
            return result === 1;
        }
        catch (error) {
            this.logger.warn(`Redis releaseLock failed for key ${key}: ${error.message}`);
            return false;
        }
    }
};
exports.RedisService = RedisService;
exports.RedisService = RedisService = RedisService_1 = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [String, String])
], RedisService);
