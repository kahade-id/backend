import { Logger } from '@nestjs/common';
import { RedisService } from '../../redis/redis.service';

const logger = new Logger('ensureRedisAvailable');

export async function ensureRedisAvailable(redis: RedisService, jobName: string): Promise<boolean> {
  const healthy = await redis.isHealthy();
  if (!healthy) {
    logger.error(`Redis is unreachable — skipping cron job "${jobName}"`);
  }
  return healthy;
}
