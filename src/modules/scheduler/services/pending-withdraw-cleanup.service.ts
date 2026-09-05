import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { randomUUID } from 'crypto';
import { WithdrawStatus, WalletTransactionStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { RedisService } from '../../../redis/redis.service';
import { cronJitter } from '../../../common/utils/cron-jitter.util';
import { ensureRedisAvailable } from '../../../common/utils/redis-health.util';
import { startOfDayWIB } from '../../../common/utils/date.util';

@Injectable()
export class PendingWithdrawCleanupService {
  private readonly logger = new Logger(PendingWithdrawCleanupService.name);

  constructor(
    private prisma: PrismaService,
    private redis: RedisService,
  ) {}

  // SCH-017: Runs every 5 minutes to refund expired user/admin workflow withdrawals.
  // PROCESSING is owned exclusively by WithdrawalReconciliationService, which checks Iris
  // before refunding; this job must never race a provider payout with an unconditional refund.
  @Cron('*/5 * * * *', { name: 'pending-withdraw-cleanup' })
  async cleanupExpiredWithdrawals(): Promise<void> {
    await cronJitter(15_000);
    if (!(await ensureRedisAvailable(this.redis, 'pending-withdraw-cleanup'))) return;

    const lockKey = 'cron_lock:pending_withdraw_cleanup';
    const lockTtl = 300;
    const lockToken = randomUUID();
    const acquired = await this.redis.setNx(lockKey, lockToken, lockTtl);
    if (!acquired) return;

    const lockRenewal = setInterval(async () => {
      const renewed = await this.redis.renewLock(lockKey, lockToken, lockTtl);
      if (!renewed) {
        clearInterval(lockRenewal);
        this.logger.warn('Pending withdrawal cleanup lock ownership was lost; stopping after the current batch.');
      }
    }, Math.floor(lockTtl * 0.6) * 1000);

    // 10 minutes = 2× the OTP TTL (5 min); give users the full OTP window + buffer
    const otpExpiryThreshold = new Date(Date.now() - 10 * 60 * 1000);

    // 24 hours — PENDING_PROCESS means admin approved but the payout call never
    // progressed to provider PROCESSING. This workflow can be refunded safely here.
    const processExpiryThreshold = new Date(Date.now() - 24 * 60 * 60 * 1000);

    try {
      const [expiredOtp, expiredProcess] = await Promise.all([
        this.prisma.walletTransaction.findMany({
          where: {
            withdrawStatus: WithdrawStatus.PENDING_OTP,
            updatedAt: { lt: otpExpiryThreshold },
          },
          take: 500,
        }),
        this.prisma.walletTransaction.findMany({
          where: {
            withdrawStatus: WithdrawStatus.PENDING_PROCESS,
            updatedAt: { lt: processExpiryThreshold },
          },
          take: 500,
        }),
      ]);

      const allExpired = [...expiredOtp, ...expiredProcess];
      if (allExpired.length === 0) return;

      this.logger.log(
        `Expired withdrawals: ${expiredOtp.length} PENDING_OTP, ${expiredProcess.length} stale PENDING_PROCESS — refunding. PROCESSING remains owned by Iris reconciliation.`,
      );

      const todayStart = startOfDayWIB();

      const processIdSet = new Set(expiredProcess.map(tx => tx.id));

      const walletGroups = new Map<string, typeof allExpired>();
      for (const tx of allExpired) {
        const group = walletGroups.get(tx.walletId) ?? [];
        group.push(tx);
        walletGroups.set(tx.walletId, group);
      }

      const MAX_OCC_RETRIES = 3;
      for (const [walletId, txs] of walletGroups) {
        let succeeded = false;
        for (let attempt = 1; attempt <= MAX_OCC_RETRIES && !succeeded; attempt++) {
          try {
          await this.prisma.$transaction(async (client) => {
            const wallet = await client.wallet.findUnique({ where: { id: walletId } });
            if (!wallet) {
              this.logger.warn(`PendingWithdrawCleanup: wallet ${walletId} not found, skipping refund`);
              return;
            }

            let availableRefund = BigInt(0);
            let totalRefund = BigInt(0);
            let todayTotal = BigInt(0);

            for (const tx of txs) {
              const isProcess = processIdSet.has(tx.id);
              const expectedStatus = isProcess ? WithdrawStatus.PENDING_PROCESS : WithdrawStatus.PENDING_OTP;
              const description = isProcess ? 'Auto-failed: stuck in PENDING_PROCESS for over 24 hours' : undefined;

              const updated = await client.walletTransaction.updateMany({
                where: { id: tx.id, withdrawStatus: expectedStatus },
                data: {
                  withdrawStatus: WithdrawStatus.FAILED,
                  status: WalletTransactionStatus.FAILED,
                  ...(description ? { description } : {}),
                },
              });

              if (updated.count > 0) {
                availableRefund += tx.amount;
                // Every withdrawal reservation now decrements both availableBalance
                // and totalBalance, including PENDING_OTP. Refund both on expiry.
                totalRefund += tx.amount;
                if (tx.createdAt >= todayStart) {
                  todayTotal += tx.amount;
                }

              }
            }

            if (availableRefund === BigInt(0)) return;

            const withdrawRollback = todayTotal > BigInt(0)
              ? (wallet.todayWithdrawAmount >= todayTotal
                  ? { decrement: todayTotal }
                  : { set: BigInt(0) })
              : undefined;

            const walletUpdated = await client.wallet.updateMany({
              where: { id: walletId, version: wallet.version },
              data: {
                availableBalance: { increment: availableRefund },
                ...(totalRefund > BigInt(0) ? { totalBalance: { increment: totalRefund } } : {}),
                ...(withdrawRollback !== undefined ? { todayWithdrawAmount: withdrawRollback } : {}),
                version: { increment: 1 },
              },
            });
            if (walletUpdated.count === 0) {
              throw new Error(`PendingWithdrawCleanup OCC conflict for wallet ${walletId}`);
            }
          }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
          succeeded = true;
          } catch (walletErr) {
            if (attempt === MAX_OCC_RETRIES) {
              this.logger.error(`PendingWithdrawCleanup: wallet ${walletId} refund failed after ${MAX_OCC_RETRIES} retries — will retry next tick: ${walletErr instanceof Error ? walletErr.message : String(walletErr)}`);
            } else {
              this.logger.warn(`PendingWithdrawCleanup: wallet ${walletId} OCC conflict, retry ${attempt}/${MAX_OCC_RETRIES}`);
              await new Promise(r => setTimeout(r, 150 * attempt));
            }
          }
        }
      }
    } catch (error) {
      this.logger.error('PendingWithdrawCleanup FAILED', error);
    } finally {
      clearInterval(lockRenewal);
      await this.redis.releaseLock(lockKey, lockToken).catch((err) => this.logger.warn(`silent-catch: ${err instanceof Error ? err.message : String(err)}`));
    }
  }
}
