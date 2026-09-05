"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CacheTTL = void 0;
exports.getCached = getCached;
exports.invalidateCache = invalidateCache;
const common_1 = require("@nestjs/common");
const logger = new common_1.Logger('CacheUtil');
async function getCached(redis, key, ttlSeconds, fetcher) {
    try {
        const cached = await redis.get(key);
        if (cached !== null) {
            return JSON.parse(cached);
        }
    }
    catch (err) {
        logger.warn(`Cache GET failed for key="${key}": ${err.message}`);
    }
    const data = await fetcher();
    try {
        await redis.setex(key, ttlSeconds, JSON.stringify(data));
    }
    catch (err) {
        logger.warn(`Cache SET failed for key="${key}": ${err.message}`);
    }
    return data;
}
async function invalidateCache(redis, key) {
    try {
        await redis.del(key);
    }
    catch (err) {
        logger.warn(`Cache DEL failed for key="${key}": ${err.message}`);
    }
}
exports.CacheTTL = {
    PUBLIC_PROFILE: 300,
    ORDER_DETAIL: 30,
    USER_STATS: 120,
    WALLET_BALANCE: 10,
    VOUCHER_LIST: 600,
};
