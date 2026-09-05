import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { randomUUID } from 'crypto';
import { PrismaService } from '../../../prisma/prisma.service';
import { RedisService } from '../../../redis/redis.service';
import { WalletTransactionType, WalletTransactionStatus } from '@prisma/client';
import { ensureRedisAvailable } from '../../../common/utils/redis-health.util';
import { startOfDayWIB } from '../../../common/utils/date.util';

@Injectable()
export class TopupCounterCorrectionService {
  private readonly logger = new Logger(TopupCounterCorrectionService.name);

  constructor(
    private prisma: PrismaService,
    private redis: RedisService,
  ) {}

  @Cron('*/15 * * * *', { name: 'topup-counter-correction', timeZone: 'Asia/Jakarta' })
  async processCorrections(): Promise<void> {
    if (!(await ensureRedisAvailable(this.redis, 'topup-counter-correction'))) return;

    const lockKey = 'cron_lock:topup_counter_correction';
    const lockToken = randomUUID();
    const acquired = await this.redis.setNx(lockKey, lockToken, 300);
    if (!acquired) return;

    try {
      const client = this.redis.getClient();
      const listKey = this.redis.getPrefix() + 'topup_counter_corrections';
      let processed = 0;
      const maxItems = 50;

      for (let i = 0; i < maxItems; i++) {
        const raw = await client.lpop(listKey);
        if (!raw) break;

        let correction: {
          userId: string;
          amountInSen: string;
          paymentTxId: string;
          timestamp: number;
        };
        try {
          correction = JSON.parse(raw) as typeof correction;
        } catch (err) {
          // Malformed payloads cannot be recovered. Log and discard only this poison item.
          this.logger.error(
            `Discarding malformed topup counter correction: ${raw}`,
            err instanceof Error ? err.stack : String(err),
          );
          continue;
        }

        try {
          await this.correctUserCounter(correction.userId);
          processed++;
          this.logger.log(
            `Corrected topup counter for user=${correction.userId} paymentTx=${correction.paymentTxId}`,
          );
        } catch (err) {
          // LPOP is destructive. Put a valid correction back before stopping so a
          // transient database or Prisma failure cannot permanently lose the repair.
          try {
            await client.lpush(listKey, raw);
            this.logger.warn(
              `Requeued topup counter correction after processing failure for user=${correction.userId}`,
            );
          } catch (requeueErr) {
            this.logger.error(
              `Failed to requeue topup counter correction: ${raw}`,
              requeueErr instanceof Error ? requeueErr.stack : String(requeueErr),
            );
          }
          this.logger.error(
            `Failed to process topup counter correction: ${raw}`,
            err instanceof Error ? err.stack : String(err),
          );
          break;
        }
      }

      if (processed > 0) {
        this.logger.log(`Topup counter correction completed: ${processed} correction(s) processed`);
      }
    } finally {
      await this.redis
        .releaseLock(lockKey, lockToken)
        .catch(err =>
          this.logger.warn(`silent-catch: ${err instanceof Error ? err.message : String(err)}`),
        );
    }
  }

  private async correctUserCounter(userId: string): Promise<void> {
    const todayStartWib = startOfDayWIB();

    const wallet = await this.prisma.wallet.findUnique({
      where: { userId },
      select: { id: true, todayTopupAmount: true, version: true },
    });
    if (!wallet) return;

    const activeTopups = await this.prisma.walletTransaction.aggregate({
      where: {
        wallet: { userId },
        type: WalletTransactionType.TOP_UP,
        status: { in: [WalletTransactionStatus.SUCCESS, WalletTransactionStatus.PENDING] },
        createdAt: { gte: todayStartWib },
      },
      _sum: { amount: true },
    });

    const actualTotal = activeTopups._sum.amount ?? BigInt(0);
    if (actualTotal === wallet.todayTopupAmount) return;

    const updated = await this.prisma.wallet.updateMany({
      where: { id: wallet.id, version: wallet.version },
      data: {
        todayTopupAmount: actualTotal,
        version: { increment: 1 },
      },
    });

    if (updated.count > 0) {
      this.logger.log(
        `COUNTER_CORRECTED user=${userId} old=${wallet.todayTopupAmount} new=${actualTotal} delta=${Number(wallet.todayTopupAmount) - Number(actualTotal)} sen`,
      );
    }
  }
}
