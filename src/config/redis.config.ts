import { registerAs } from '@nestjs/config';

export const redisConfig = registerAs('redis', () => ({
  url: process.env.REDIS_URL || 'redis://localhost:6379',
  prefix: process.env.REDIS_PREFIX || 'kahade:',
  bullRedisUrl: process.env.BULL_REDIS_URL || 'redis://localhost:6379',
  bullEmailConcurrency: parseInt(process.env.BULL_EMAIL_CONCURRENCY || '5', 10),
  bullNotifConcurrency: parseInt(process.env.BULL_NOTIF_CONCURRENCY || '5', 10),
}));
