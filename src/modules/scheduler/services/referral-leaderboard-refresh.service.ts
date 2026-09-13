import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { randomUUID } from 'crypto';
import { ReferralService } from '../../referral/referral.service';
import { RedisService } from '../../../redis/redis.service';
import { cronJitter } from '../../../common/utils/cron-jitter.util';
import { ensureRedisAvailable } from '../../../common/utils/redis-health.util';

@Injectable()
export class ReferralLeaderboardRefreshService {
  private readonly logger = new Logger(ReferralLeaderboardRefreshService.name);

  constructor(
    private redis: RedisService,
    private referralService: ReferralService,
  ) {}

  @Cron('*/15 * * * *', { name: 'referral-leaderboard-refresh' })
  async refresh(): Promise<void> {
    await cronJitter(10_000);
    if (!(await ensureRedisAvailable(this.redis, 'referral-leaderboard-refresh'))) return;

    const lockKey = 'cron_lock:referral_leaderboard_refresh';
    const lockToken = randomUUID();
    const acquired = await this.redis.setNx(lockKey, lockToken, 600);
    if (!acquired) return;

    try {
      await Promise.all([
        this.referralService.refreshLeaderboard(10),
        this.referralService.refreshLeaderboard(50),
        this.referralService.refreshLeaderboard(100),
      ]);
    } catch (error: unknown) {
      this.logger.error(`Referral leaderboard refresh failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      await this.redis.releaseLock(lockKey, lockToken).catch((err) => this.logger.warn(`silent-catch: ${err instanceof Error ? err.message : String(err)}`));
    }
  }
}
