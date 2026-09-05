import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { randomUUID } from 'crypto';
import { PrismaService } from '../../../prisma/prisma.service';
import { RedisService } from '../../../redis/redis.service';
import { ScheduledWithdrawalService } from '../../withdrawals/scheduled-withdrawal.service';
import { ensureRedisAvailable } from '../../../common/utils/redis-health.util';
import { cronJitter } from '../../../common/utils/cron-jitter.util';

@Injectable()
export class ProcessScheduledWithdrawalsService {
  private readonly logger = new Logger(ProcessScheduledWithdrawalsService.name);

  constructor(
    private prisma: PrismaService,
    private redis: RedisService,
    private scheduledWithdrawalService: ScheduledWithdrawalService,
  ) {}

  // SCH-002: Runs at 06:00 WIB daily to process scheduled withdrawals
  @Cron('0 6 * * *', { name: 'process-scheduled-withdrawals', timeZone: 'Asia/Jakarta' })
  async processAll(): Promise<void> {
    await cronJitter(10_000);
    if (!(await ensureRedisAvailable(this.redis, 'process-scheduled-withdrawals'))) return;

    const lockKey = 'cron_lock:process_scheduled_withdrawals';
    const lockToken = randomUUID();
    const acquired = await this.redis.setNx(lockKey, lockToken, 3600);
    if (!acquired) return;

    let lockLost = false;
    const lockRenewalInterval = setInterval(async () => {
      const renewed = await this.redis.renewLock(lockKey, lockToken, 3600);
      if (!renewed) {
        lockLost = true;
        clearInterval(lockRenewalInterval);
        this.logger.warn('Scheduled withdrawal lock ownership was lost; stopping after the current schedule.');
      }
    }, 60_000);

    const startedAt = Date.now();
    try {
      // SCH-002: Use WIB day-of-week instead of UTC to match user-facing schedule
      const wibNow = new Date(Date.now() + 7 * 3600_000);
      const dayOfWeek = wibNow.getUTCDay();

      const schedules = await this.prisma.scheduledWithdrawal.findMany({
        where: { isActive: true, dayOfWeek },
      });

      this.logger.log(`Found ${schedules.length} active schedules for day ${dayOfWeek}`);

      let processed = 0;
      let skipped = 0;

      for (const schedule of schedules) {
        if (lockLost || await this.redis.get(lockKey) !== lockToken) {
          this.logger.warn('Scheduled withdrawal lock ownership was lost; aborting before the next schedule.');
          return;
        }
        try {
          const result = await this.scheduledWithdrawalService.processScheduledWithdrawal(schedule.id);
          if (result.skipped) {
            skipped++;
            this.logger.debug(`Skipped schedule ${schedule.id}: ${result.reason}`);
          } else {
            processed++;
            this.logger.log(`Processed schedule ${schedule.id} for user ${schedule.userId}`);
          }
        } catch (error) {
          this.logger.error(
            `Failed to process schedule ${schedule.id}: ${error instanceof Error ? error.message : error}`,
            error instanceof Error ? error.stack : undefined,
          );
        }
      }

      const durationMs = Date.now() - startedAt;
      this.logger.log(`Scheduled withdrawals complete: ${processed} processed, ${skipped} skipped (${durationMs}ms)`);

      await this.redis.setex(`cron_heartbeat:process_scheduled_withdrawals`, 86400, JSON.stringify({
        ranAt: new Date().toISOString(),
        processed,
        skipped,
        durationMs,
      })).catch((err) => this.logger.warn(`silent-catch: ${err instanceof Error ? err.message : String(err)}`));
    } catch (error) {
      this.logger.error(
        `Failed to run scheduled withdrawals cron: ${error instanceof Error ? error.message : error}`,
        error instanceof Error ? error.stack : undefined,
      );
    } finally {
      clearInterval(lockRenewalInterval);
      await this.redis.releaseLock(lockKey, lockToken).catch((err) => this.logger.warn(`silent-catch: ${err instanceof Error ? err.message : String(err)}`));
    }
  }
}
