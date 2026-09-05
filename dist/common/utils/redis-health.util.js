"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ensureRedisAvailable = ensureRedisAvailable;
const common_1 = require("@nestjs/common");
const logger = new common_1.Logger('ensureRedisAvailable');
async function ensureRedisAvailable(redis, jobName) {
    const healthy = await redis.isHealthy();
    if (!healthy) {
        logger.error(`Redis is unreachable — skipping cron job "${jobName}"`);
    }
    return healthy;
}
