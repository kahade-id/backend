import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import { randomUUID } from 'crypto';
import { PaymentStatus, WalletTransactionStatus, WalletTransactionType, Prisma } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { RedisService } from '../../../redis/redis.service';
import { cronJitter } from '../../../common/utils/cron-jitter.util';
import { ensureRedisAvailable } from '../../../common/utils/redis-health.util';
import { startOfDayWIB } from '../../../common/utils/date.util';
import { MidtransService } from '../../payment/midtrans.service';
import { WalletService } from '../../wallet/wallet.service';

@Injectable()
export class PendingTopupCleanupService {
  private readonly logger = new Logger(PendingTopupCleanupService.name);
  private readonly topupExpiryHours: number;

  constructor(
    private prisma: PrismaService,
    private redis: RedisService,
    private configService: ConfigService,
    private midtransService: MidtransService,
    private walletService: WalletService,
  ) {
    this.topupExpiryHours = Math.max(1, this.configService.get<number>('app.topupExpiryHours') ?? 24);
  }

  // SCH-017: Runs every hour to cleanup stale PENDING topup transactions
  @Cron('0 * * * *', { name: 'pending-topup-cleanup' })
  async cleanupStaleTopups(): Promise<void> {
    await cronJitter(20_000);
    if (!(await ensureRedisAvailable(this.redis, 'pending-topup-cleanup'))) return;

    const lockKey = 'cron_lock:pending_topup_cleanup';
    const lockTtl = 600;
    const lockToken = randomUUID();
    const acquired = await this.redis.setNx(lockKey, lockToken, lockTtl);
    if (!acquired) return;

    let lockLost = false;
    const lockRenewal = setInterval(async () => {
      const renewed = await this.redis.renewLock(lockKey, lockToken, lockTtl);
      if (!renewed) {
        lockLost = true;
        clearInterval(lockRenewal);
        this.logger.warn('Pending top-up cleanup lock ownership was lost; stopping after the current batch.');
      }
    }, Math.floor(lockTtl * 0.6) * 1000);

    const bufferHours = Math.max(1, Math.ceil(this.topupExpiryHours * 0.25));
    const expiryMs = (this.topupExpiryHours + bufferHours) * 60 * 60 * 1000;
    const expiryThreshold = new Date(Date.now() - expiryMs);

    try {
      if (lockLost || await this.redis.get(lockKey) !== lockToken) {
        this.logger.warn('Pending top-up cleanup lock ownership was lost; aborting before candidate fetch.');
        return;
      }

      const staleTopups = await this.prisma.walletTransaction.findMany({
        where: {
          type: WalletTransactionType.TOP_UP,
          status: WalletTransactionStatus.PENDING,
          createdAt: { lt: expiryThreshold },
        },
        include: {
          paymentTx: true,
        },
        take: 500,
      });

      if (staleTopups.length === 0) return;

      this.logger.log(`Found ${staleTopups.length} stale PENDING topup transactions — reconciling before cleanup.`);

      // A stale local row is not proof that the provider charge failed. Re-check
      // Midtrans before releasing the daily limit: a missed settlement webhook or
      // a delayed provider response must not turn a paid top-up into FAILED.
      const providerConfirmedFailures: typeof staleTopups = [];
      const terminalFailureStatuses = new Set(['deny', 'expire', 'cancel', 'failure', 'refund', 'partial_refund', 'chargeback', 'partial_chargeback']);
      for (const tx of staleTopups) {
        if (lockLost) break;
        if (!tx.paymentTx) {
          // Legacy orphaned ledger row without a provider transaction cannot be
          // reconciled externally; retain the prior cleanup behavior for it.
          providerConfirmedFailures.push(tx);
          continue;
        }

        try {
          const providerTx = await this.midtransService.getTransactionStatus(tx.paymentTx.midtransOrderId);
          const providerStatus = typeof providerTx.transaction_status === 'string'
            ? providerTx.transaction_status.toLowerCase()
            : '';

          if (providerStatus === 'settlement') {
            const grossAmount = typeof providerTx.gross_amount === 'string' ? providerTx.gross_amount : undefined;
            await this.walletService.handleTopupSuccess(tx.paymentTx.midtransOrderId, grossAmount);
            this.logger.log(`Pending top-up ${tx.paymentTx.midtransOrderId} settled during provider reconciliation`);
            continue;
          }

          if (providerStatus === 'capture') {
            const fraudStatus = typeof providerTx.fraud_status === 'string'
              ? providerTx.fraud_status.toLowerCase()
              : '';
            if (fraudStatus === 'accept') {
              const grossAmount = typeof providerTx.gross_amount === 'string' ? providerTx.gross_amount : undefined;
              await this.walletService.handleTopupSuccess(tx.paymentTx.midtransOrderId, grossAmount);
              this.logger.log(`Pending top-up ${tx.paymentTx.midtransOrderId} capture+accept settled during provider reconciliation`);
              continue;
            }
            if (fraudStatus === 'deny') {
              providerConfirmedFailures.push(tx);
              this.logger.log(`Pending top-up ${tx.paymentTx.midtransOrderId} capture+deny failed during provider reconciliation`);
              continue;
            }

            const reviewSignal = fraudStatus === 'challenge'
              ? 'challenge'
              : `unknown:${fraudStatus.slice(0, 32) || 'missing'}`;
            await this.prisma.paymentTransaction.updateMany({
              where: { id: tx.paymentTx.id, status: PaymentStatus.PENDING },
              data: { fraudStatus: reviewSignal, webhookReceivedAt: new Date() },
            });
            this.logger.error(
              `Pending top-up ${tx.paymentTx.midtransOrderId} capture+${fraudStatus || 'missing'} requires manual fraud review`,
            );
            continue;
          }

          if (terminalFailureStatuses.has(providerStatus)) {
            providerConfirmedFailures.push(tx);
            continue;
          }

          this.logger.warn(
            `Pending top-up ${tx.paymentTx.midtransOrderId} retained: provider status=${providerStatus || 'unknown'} is not terminal`,
          );
        } catch (error) {
          this.logger.warn(
            `Pending top-up ${tx.paymentTx.midtransOrderId} retained because provider status is unavailable: ` +
            `${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }

      if (lockLost || await this.redis.get(lockKey) !== lockToken) {
        this.logger.warn('Pending top-up cleanup lock ownership was lost; aborting before wallet updates.');
        return;
      }
      if (providerConfirmedFailures.length === 0) return;

      const todayStart = startOfDayWIB();

      const walletGroups = new Map<string, typeof staleTopups>();
      for (const tx of providerConfirmedFailures) {
        const group = walletGroups.get(tx.walletId) ?? [];
        group.push(tx);
        walletGroups.set(tx.walletId, group);
      }

      const MAX_OCC_RETRIES = 3;
      for (const [walletId, txs] of walletGroups) {
        if (lockLost || await this.redis.get(lockKey) !== lockToken) {
          this.logger.warn('Pending top-up cleanup lock ownership was lost; aborting before the next wallet.');
          return;
        }
        let succeeded = false;
        for (let attempt = 1; attempt <= MAX_OCC_RETRIES && !succeeded; attempt++) {
          try {
            await this.prisma.$transaction(async (client) => {
              const wallet = await client.wallet.findUnique({ where: { id: walletId } });
              if (!wallet) {
                this.logger.warn(`PendingTopupCleanup: wallet ${walletId} not found, skipping`);
                return;
              }

              let todayTopupRollback = BigInt(0);

              for (const tx of txs) {
                const updated = await client.walletTransaction.updateMany({
                  where: { id: tx.id, status: WalletTransactionStatus.PENDING },
                  data: {
                    status: WalletTransactionStatus.FAILED,
                    description: 'Auto-failed: stale PENDING topup (no Midtrans charge completed)',
                  },
                });

                if (updated.count > 0) {
                  if (tx.paymentTx && tx.paymentTx.status === PaymentStatus.PENDING) {
                    await client.paymentTransaction.updateMany({
                      where: { id: tx.paymentTx.id, status: PaymentStatus.PENDING },
                      data: { status: PaymentStatus.FAILED, failedAt: new Date() },
                    });
                  }

                  if (tx.createdAt >= todayStart) {
                    todayTopupRollback += tx.amount;
                  }
                }
              }

              if (todayTopupRollback > BigInt(0)) {
                const rollbackData = wallet.todayTopupAmount >= todayTopupRollback
                  ? { todayTopupAmount: { decrement: todayTopupRollback } }
                  : { todayTopupAmount: { set: BigInt(0) } };

                const walletUpdated = await client.wallet.updateMany({
                  where: { id: walletId, version: wallet.version },
                  data: {
                    ...rollbackData,
                    version: { increment: 1 },
                  },
                });
                if (walletUpdated.count === 0) {
                  throw new Error(`PendingTopupCleanup OCC conflict for wallet ${walletId}`);
                }
              }
            }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
            succeeded = true;
          } catch (err) {
            if (attempt === MAX_OCC_RETRIES) {
              this.logger.error(
                `PendingTopupCleanup: wallet ${walletId} cleanup failed after ${MAX_OCC_RETRIES} retries — will retry next tick: ${err instanceof Error ? err.message : String(err)}`,
              );
            } else {
              this.logger.warn(`PendingTopupCleanup: wallet ${walletId} OCC conflict, retry ${attempt}/${MAX_OCC_RETRIES}`);
              await new Promise(r => setTimeout(r, 150 * attempt));
            }
          }
        }
      }
    } catch (error) {
      this.logger.error('PendingTopupCleanup FAILED', error);
    } finally {
      clearInterval(lockRenewal);
      await this.redis.releaseLock(lockKey, lockToken).catch((err) => this.logger.warn(`silent-catch: ${err instanceof Error ? err.message : String(err)}`));
    }
  }
}
