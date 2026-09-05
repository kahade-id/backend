"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.redisConfig = void 0;
const config_1 = require("@nestjs/config");
exports.redisConfig = (0, config_1.registerAs)('redis', () => ({
    url: process.env.REDIS_URL || 'redis://localhost:6379',
    prefix: process.env.REDIS_PREFIX || 'kahade:',
    bullRedisUrl: process.env.BULL_REDIS_URL || 'redis://localhost:6379',
    bullEmailConcurrency: parseInt(process.env.BULL_EMAIL_CONCURRENCY || '5', 10),
    bullNotifConcurrency: parseInt(process.env.BULL_NOTIF_CONCURRENCY || '5', 10),
}));
