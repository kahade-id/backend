import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'crypto';
import { PrismaService } from '../../../prisma/prisma.service';
import { RedisService } from '../../../redis/redis.service';
import { ensureRedisAvailable } from '../../../common/utils/redis-health.util';
import { formatWIBDate } from '../../../common/utils/date.util';

@Injectable()
export class WalletDailyResetService {
  private readonly logger = new Logger(WalletDailyResetService.name);

  constructor(
    private prisma: PrismaService,
    private redis: RedisService,
  ) {}

  // SCH-017/SCH-022: Runs at midnight WIB (17:00 UTC) — same WIB boundary as topup service
  @Cron('0 17 * * *', { name: 'wallet-daily-reset', timeZone: 'UTC' })
  async resetDailyLimits(): Promise<void> {
    if (!(await ensureRedisAvailable(this.redis, 'wallet-daily-reset'))) return;

    const today = formatWIBDate();
    const lockKey = `cron_lock:wallet_daily_reset:${today}`;
    const lockToken = randomUUID();
    const acquired = await this.redis.setNx(lockKey, lockToken, 3600);
    if (!acquired) {
      this.logger.log('Daily wallet reset skipped — another instance already executing.');
      return;
    }

    const startedAt = new Date();
    this.logger.log('Starting daily wallet limit reset...');

    try {
      const BATCH_SIZE = 5000;
      let totalUpdated = 0;
      let lastId: string | null = null;
      let batchCount: number;
      do {
        const whereClause: Record<string, unknown> = {
          OR: [
            { todayTopupAmount: { gt: BigInt(0) } },
            { todayWithdrawAmount: { gt: BigInt(0) } },
          ],
        };
        if (lastId) {
          whereClause.id = { gt: lastId };
        }
        const batch = await this.prisma.wallet.findMany({
          where: whereClause,
          select: { id: true, version: true },
          take: BATCH_SIZE,
          orderBy: { id: 'asc' },
        });
        batchCount = batch.length;
        if (batchCount > 0) {
          lastId = batch[batchCount - 1].id;
          // Bulk update with per-row version OCC via VALUES list — single round-trip per batch
          const valuesList = Prisma.join(
            batch.map((w) => Prisma.sql`(${w.id}::text, ${w.version}::int)`),
          );
          const updatedCount = await this.prisma.$executeRaw<number>(Prisma.sql`
            UPDATE "wallets" w
            SET
              "todayTopupAmount" = 0,
              "todayWithdrawAmount" = 0,
              "lastLimitResetAt" = NOW(),
              "version" = "version" + 1
            FROM (VALUES ${valuesList}) AS v(id, ver)
            WHERE w."id" = v.id AND w."version" = v.ver
          `);
          totalUpdated += Number(updatedCount);
          if (Number(updatedCount) === 0 && batchCount > 0) {
            this.logger.warn(`wallet-daily-reset: 0 rows updated for batch of ${batchCount} candidates — possible OCC version drift`);
          }
        }
      } while (batchCount === BATCH_SIZE);
      const result = { count: totalUpdated };

      const elapsedMs = Date.now() - startedAt.getTime();
      this.logger.log(`Daily wallet limit reset completed. Updated ${result.count} wallet(s) in ${elapsedMs}ms.`);

      // SCH-013: Write standardized heartbeat key for health check monitoring
      const heartbeatData = JSON.stringify({
        ranAt: new Date().toISOString(),
        updatedCount: result.count,
        elapsedMs,
      });
      await Promise.all([
        this.redis.setex(`cron_heartbeat:wallet_daily_reset`, 86400, heartbeatData),
        this.redis.setex(`cron_heartbeat:wallet_daily_reset:${today}`, 86400, heartbeatData),
      ]).catch((err) => this.logger.warn(`silent-catch: ${err instanceof Error ? err.message : String(err)}`));
    } catch (error) {
      this.logger.error('Daily wallet limit reset FAILED', error);
      const failureKey = `cron_failure:wallet_daily_reset:${today}`;
      try {
        await this.redis.setex(failureKey, 86400, JSON.stringify({
          failedAt: new Date().toISOString(),
          error: error instanceof Error ? error.message : String(error),
        }));
      } catch {
        this.logger.error('Could not store reset failure state in Redis');
      }
    } finally {
      await this.redis.releaseLock(lockKey, lockToken).catch((err) => this.logger.warn(`silent-catch: ${err instanceof Error ? err.message : String(err)}`));
    }
  }
}
