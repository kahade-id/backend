import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { NotificationType, Prisma } from '@prisma/client';
import { randomUUID } from 'crypto';
import { PrismaService } from '../../../prisma/prisma.service';
import { RedisService } from '../../../redis/redis.service';
import { cronJitter } from '../../../common/utils/cron-jitter.util';
import { MidtransService } from '../../payment/midtrans.service';
import { ensureRedisAvailable } from '../../../common/utils/redis-health.util';
import { startOfDayWIB } from '../../../common/utils/date.util';
import { NotificationQueueService } from '../../queue/notification-queue.service';

const PROCESSING_TIMEOUT_MS = 30 * 60 * 1000;

@Injectable()
export class WithdrawalReconciliationService {
  private readonly logger = new Logger(WithdrawalReconciliationService.name);

  private runNotificationBestEffort(data: { userId: string; type: NotificationType; title: string; body: string; actionUrl: string; pushData: Record<string, string> }, label: string): void {
    void this.notificationQueue.enqueue(data).catch((error: unknown) => this.logger.warn(`${label} notification side effect failed: ${error instanceof Error ? error.message : String(error)}`));
  }

  constructor(
    private prisma: PrismaService,
    private redis: RedisService,
    private midtransService: MidtransService,
    private notificationQueue: NotificationQueueService,
  ) {}

  // SCH-017: Runs every 5 minutes to reconcile PROCESSING withdrawals with Midtrans Iris
  @Cron('*/5 * * * *', { name: 'withdrawal-reconciliation', timeZone: 'Asia/Jakarta' })
  async reconcileProcessingWithdrawals(): Promise<void> {
    await cronJitter(15_000);
    if (!(await ensureRedisAvailable(this.redis, 'withdrawal-reconciliation'))) return;

    const lockKey = 'cron_lock:withdrawal_reconciliation';
    const lockToken = randomUUID();
    const acquired = await this.redis.setNx(lockKey, lockToken, 300);
    if (!acquired) return;

    try {
      const processingWithdrawals = await this.prisma.walletTransaction.findMany({
        where: {
          type: 'WITHDRAW',
          withdrawStatus: 'PROCESSING',
        },
        include: { wallet: true },
        orderBy: { updatedAt: 'asc' },
        take: 50,
      });

      if (processingWithdrawals.length === 0) return;

      this.logger.log(`Found ${processingWithdrawals.length} PROCESSING withdrawals to reconcile`);

      let resolved = 0;
      let timedOut = 0;

      for (const tx of processingWithdrawals) {
        try {
          const irisResult = await this.midtransService.getIrisPayoutStatus(tx.txId);

          if (['completed', 'processed'].includes(irisResult.status)) {
            const updated = await this.prisma.walletTransaction.updateMany({
              where: { id: tx.id, withdrawStatus: 'PROCESSING' },
              data: {
                withdrawStatus: 'SUCCESS',
                status: 'SUCCESS',
                description: tx.description
                  ? `${tx.description} — confirmed via reconciliation`
                  : 'Payout confirmed via reconciliation',
              },
            });
            if (updated.count > 0) {
              resolved++;
              this.runNotificationBestEffort({ userId: tx.wallet.userId, type: NotificationType.WALLET_WITHDRAW_SUCCESS, title: 'Penarikan berhasil', body: `Penarikan ${tx.txId} telah dikonfirmasi provider.`, actionUrl: `/wallet/transaction?id=${encodeURIComponent(tx.txId)}`, pushData: { transactionId: tx.txId } }, `WITHDRAWAL_SUCCESS ${tx.txId}`);
            }
            this.logger.log(`Withdrawal ${tx.txId} confirmed as ${irisResult.status}`);
          } else if (['failed', 'rejected'].includes(irisResult.status)) {
            const refunded = await this.refundFailedWithdrawal(tx);
            if (refunded) {
              resolved++;
              this.runNotificationBestEffort({ userId: tx.wallet.userId, type: NotificationType.WALLET_WITHDRAW_FAILED, title: 'Penarikan dikembalikan', body: `Penarikan ${tx.txId} gagal dan saldo telah dikembalikan.`, actionUrl: `/wallet/transaction?id=${encodeURIComponent(tx.txId)}`, pushData: { transactionId: tx.txId } }, `WITHDRAWAL_FAILED ${tx.txId}`);
              this.logger.warn(`Withdrawal ${tx.txId} failed (${irisResult.status}), refunded`);
            } else {
              this.logger.warn(`Withdrawal ${tx.txId} changed state before failed payout reconciliation; skipping refund side effects`);
            }
          } else if (irisResult.status === 'not_found') {
            const age = Date.now() - tx.updatedAt.getTime();
            if (age > PROCESSING_TIMEOUT_MS) {
              timedOut++;
              await this.redis.setex(`alert:withdrawal_payout_unknown:${tx.id}`, 86400, JSON.stringify({
                txId: tx.txId,
                walletId: tx.walletId,
                detectedAt: new Date().toISOString(),
                ageMs: age,
                providerStatus: irisResult.status,
              })).catch((error) => this.logger.warn(`Failed to store payout reconciliation alert for ${tx.txId}: ${error instanceof Error ? error.message : String(error)}`));
              this.logger.error(`Withdrawal ${tx.txId} remains PROCESSING because Iris returned not_found after ${Math.round(age / 60000)}min; manual reconciliation required`);
            }
          } else {
            const age = Date.now() - tx.updatedAt.getTime();
            if (age > PROCESSING_TIMEOUT_MS) {
              timedOut++;
              await this.redis.setex(`alert:withdrawal_payout_unknown:${tx.id}`, 86400, JSON.stringify({
                txId: tx.txId,
                walletId: tx.walletId,
                detectedAt: new Date().toISOString(),
                ageMs: age,
                providerStatus: irisResult.status,
              })).catch((error) => this.logger.warn(`Failed to store payout reconciliation alert for ${tx.txId}: ${error instanceof Error ? error.message : String(error)}`));
              this.logger.error(`Withdrawal ${tx.txId} remains PROCESSING after ${Math.round(age / 60000)}min with unknown Iris status=${irisResult.status}; manual reconciliation required`);
            }
          }
        } catch (err) {
          this.logger.error(
            `Failed to reconcile withdrawal ${tx.txId}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }

      this.logger.log(`Withdrawal reconciliation: ${resolved} resolved, ${timedOut} timed out`);
    } finally {
      await this.redis.releaseLock(lockKey, lockToken).catch((err) => this.logger.warn(`silent-catch: ${err instanceof Error ? err.message : String(err)}`));
    }
  }

  private async refundFailedWithdrawal(tx: {
    id: string;
    txId: string;
    walletId: string;
    amount: bigint;
    createdAt: Date;
  }): Promise<boolean> {
    return this.prisma.$transaction(async (ptx: Prisma.TransactionClient) => {
      const claimResult = await ptx.walletTransaction.updateMany({
        where: { id: tx.id, withdrawStatus: 'PROCESSING' },
        data: { withdrawStatus: 'FAILED', status: 'FAILED', description: 'Payout failed — auto-refunded via reconciliation' },
      });
      if (claimResult.count === 0) {
        this.logger.warn(`Withdrawal ${tx.txId} already transitioned from PROCESSING, skipping refund`);
        return false;
      }
      const currentWallet = await ptx.wallet.findUnique({ where: { id: tx.walletId } });
      if (!currentWallet) {
        throw new Error(`Wallet ${tx.walletId} not found while refunding withdrawal ${tx.txId}`);
      }
      if (currentWallet) {
        const todayStart = startOfDayWIB();
        const isToday = tx.createdAt >= todayStart;

        const withdrawRollback = isToday
          ? (currentWallet.todayWithdrawAmount >= tx.amount
              ? { decrement: tx.amount }
              : { set: BigInt(0) })
          : undefined;

        const walletUpdateResult = await ptx.wallet.updateMany({
          where: { id: tx.walletId, version: currentWallet.version },
          data: {
            availableBalance: { increment: tx.amount },
            totalBalance: { increment: tx.amount },
            ...(withdrawRollback !== undefined ? { todayWithdrawAmount: withdrawRollback } : {}),
            version: { increment: 1 },
          },
        });
        if (walletUpdateResult.count === 0) {
          throw new Error(`OCC conflict refunding withdrawal ${tx.txId} — will retry`);
        }
      }
      return true;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  }
}
