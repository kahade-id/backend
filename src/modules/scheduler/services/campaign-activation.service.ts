import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { randomUUID } from 'crypto';
import { CampaignService } from '../../admin/campaign.service';
import { RedisService } from '../../../redis/redis.service';
import { cronJitter } from '../../../common/utils/cron-jitter.util';
import { ensureRedisAvailable } from '../../../common/utils/redis-health.util';

@Injectable()
export class CampaignActivationService {
  private readonly logger = new Logger(CampaignActivationService.name);

  constructor(
    private redis: RedisService,
    private campaignService: CampaignService,
  ) {}

  // Runs every 10 minutes: starts due campaigns, ends expired campaigns, and tops up issuance for ACTIVE campaigns.
  @Cron('*/10 * * * *', { name: 'campaign-activation' })
  async handleCampaignActivation(): Promise<void> {
    await cronJitter(15_000);
    if (!(await ensureRedisAvailable(this.redis, 'campaign-activation'))) return;

    const lockKey = 'cron_lock:campaign_activation';
    const lockToken = randomUUID();
    const acquired = await this.redis.setNx(lockKey, lockToken, 600);
    if (!acquired) return;

    try {
      const result = await this.campaignService.activateDueCampaigns();
      if (result.activated > 0 || result.ended > 0 || result.issued > 0) {
        this.logger.log(`Campaign activation: activated=${result.activated} ended=${result.ended} issued=${result.issued}`);
      }
    } catch (error: unknown) {
      this.logger.error(`CampaignActivation FAILED: ${error instanceof Error ? error.message : String(error)}`, error instanceof Error ? error.stack : undefined);
    } finally {
      await this.redis.releaseLock(lockKey, lockToken).catch((err) => this.logger.warn(`silent-catch: ${err instanceof Error ? err.message : String(err)}`));
    }
  }
}
