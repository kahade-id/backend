import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { OrderStatus, WalletTransactionType, WalletTransactionStatus, ActorType, NotificationType, SubscriptionStatus, Prisma } from '@prisma/client';
import { randomUUID, randomInt } from 'crypto';
import { getCategoryForType } from '../../notifications/notification-category.map';
import { PrismaService } from '../../../prisma/prisma.service';
import { RedisService } from '../../../redis/redis.service';
import { WalletTxSerialService } from '../../../common/services/wallet-tx-serial.service';
import { ReferralService } from '../../referral/referral.service';
import { MembershipRankService } from '../../orders/membership-rank.service';
import { FeeCalculatorService } from '../../orders/fee-calculator.service';
import { generateWalletTxId, generateNotifId } from '../../../common/utils/id-generator.util';
import { ensureRedisAvailable } from '../../../common/utils/redis-health.util';
import { toIdr } from '../../../common/utils/currency.util';
import { AUTO_COMPLETE_GRACE_PERIOD_HOURS } from '../../../common/constants/app.constants';

/*
 * Thrown inside the tx to roll it back while telling the caller this order was deferred
 * rather than failed, so a deliberately frozen wallet does not burn the consecutive-failure
 * counter and raise a false CRITICAL alert. Same idiom as ScheduledWithdrawalService.
 */
const DEFER_PREFIX = 'DEFER_AUTO_COMPLETE:';

@Injectable()
export class AutoCompleteDeliveredOrdersService {
  private readonly logger = new Logger(AutoCompleteDeliveredOrdersService.name);

  constructor(
    private prisma: PrismaService,
    private redis: RedisService,
    private walletTxSerialService: WalletTxSerialService,
    private referralService: ReferralService,
    private membershipRankService: MembershipRankService,
    private feeCalculator: FeeCalculatorService,
  ) {}

  private runRealtimeBestEffort(task: () => void, label: string): void {
    try {
      task();
    } catch (error: unknown) {
      this.logger.warn(`${label} realtime side effect failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // SCH-017: Runs every hour to auto-complete delivered orders past deadline
  @Cron('0 * * * *', { name: 'auto-complete-orders' })
  async autoComplete(): Promise<void> {
    if (!(await ensureRedisAvailable(this.redis, 'auto-complete-orders'))) return;

    const lockKey = 'cron_lock:auto_complete_orders';
    const lockToken = randomUUID();
    const acquired = await this.redis.setNx(lockKey, lockToken, 3600);
    if (!acquired) return;

    let lockLost = false;
    const lockRenewalInterval = setInterval(async () => {
      const renewed = await this.redis.renewLock(lockKey, lockToken, 3600);
      if (!renewed) {
        lockLost = true;
        clearInterval(lockRenewalInterval);
        this.logger.warn('Auto-complete lock ownership was lost; stopping after the current order.');
      }
    }, 60_000);

    const now = new Date();
    try {
      let hasMore = true;
      while (hasMore) {
        if (lockLost || await this.redis.get(lockKey) !== lockToken) {
          this.logger.warn('Auto-complete lock ownership was lost; aborting before the next batch.');
          return;
        }
        const orders = await this.prisma.order.findMany({
        where: {
          status: OrderStatus.IN_DELIVERY,
          deliveryDeadlineAt: { lt: now },
          dispute: { is: null },
          deliveryProofs: {
            none: {
              status: 'SUBMITTED',
              reviewWindowEnd: { gt: now },
            },
          },
        },
        take: 50,
      });

      if (orders.length === 0) { hasMore = false; break; }
      hasMore = orders.length === 50;

      this.logger.log(`Found ${orders.length} orders past delivery deadline — auto-completing.`);

      for (const order of orders) {
        if (lockLost) break;
        try {
          /*
           * C-02: Redis takes no part in the Prisma transaction. The grace marker used to be
           * read *and written* inside the callback, so a rollback after the write left the
           * marker set while undoing the deadline extension — the next hourly run then read
           * "grace already granted" and auto-completed immediately, against a grace period
           * the buyer had never actually been given. Read before the tx, write only after it
           * commits.
           */
          const graceKey = `auto_complete_grace:${order.id}`;
          const alreadyExtended = await this.redis.get(graceKey);

          // Redis-backed serials are not rolled back with PostgreSQL. Memoize them per
          // candidate only after the fresh order/proof/wallet guards pass; skipped or deferred
          // candidates must not burn ledger numbers, and retries must reuse the same numbers.
          let releaseTxSerial: number | null = null;
          let receiveTxSerial: number | null = null;
          let feeTxSerial: number | null = null;

          const outcome = await this.withSerializableRetry(() => this.prisma.$transaction(async (tx) => {
            // Re-read the order after the transaction starts. The batch query is only a
            // candidate list; an extension or dispute may have changed the deadline/status
            // while this order waited in the batch.
            const freshOrder = await tx.order.findUnique({
              where: { id: order.id },
              select: { status: true, deliveryDeadlineAt: true, dispute: { select: { id: true } } },
            });
            if (!freshOrder || freshOrder.status !== OrderStatus.IN_DELIVERY || !freshOrder.deliveryDeadlineAt || freshOrder.deliveryDeadlineAt >= now || freshOrder.dispute) {
              return;
            }

            const acceptedProof = await tx.deliveryProof.findFirst({
              where: { orderId: order.id, status: 'ACCEPTED' },
              select: { id: true },
            });

            if (!acceptedProof) {
              const submittedProof = await tx.deliveryProof.findFirst({
                where: { orderId: order.id, status: 'SUBMITTED', reviewWindowEnd: { gt: now } },
                select: { id: true, status: true },
              });

              if (!submittedProof) {
                const rejectedProof = await tx.deliveryProof.findFirst({
                  where: { orderId: order.id, status: { in: ['REJECTED'] } },
                  select: { id: true },
                });

                if (!rejectedProof) {
                  this.logger.warn(`Skipping auto-complete for order ${order.orderId}: no delivery proof at all`);
                  return;
                }
              }

              if (!submittedProof) {
                this.logger.log(`Order ${order.orderId} has only rejected/expired proofs and no accepted proof — seller must resubmit. Skipping.`);
                return;
              }

              // C-02: the grace marker was read before the tx started (see above) — no Redis
              // access inside the transaction.
              if (alreadyExtended) {
                this.logger.log(`Grace period already granted for order ${order.orderId} — now auto-completing with SUBMITTED proof`);
              } else {
                const graceEnd = new Date(now.getTime() + AUTO_COMPLETE_GRACE_PERIOD_HOURS * 60 * 60 * 1000);
                const extensionGranted = await tx.order.updateMany({
                  where: { id: order.id, status: OrderStatus.IN_DELIVERY },
                  data: { deliveryDeadlineAt: graceEnd },
                });
                if (extensionGranted.count === 0) return;

                await tx.notification.create({
                  data: {
                    notifId: generateNotifId(),
                    userId: order.buyerId,
                    type: NotificationType.ORDER_DELIVERED,
                    category: getCategoryForType(NotificationType.ORDER_DELIVERED),
                    title: 'Segera Review Bukti Pengiriman',
                    body: `Deadline order "${order.title}" sudah lewat tapi Anda belum review bukti pengiriman. Anda punya waktu ${AUTO_COMPLETE_GRACE_PERIOD_HOURS} jam lagi sebelum order otomatis diselesaikan.`,
                    isRead: false,
                  },
                });

                // C-02 fix: marker committed only *after* tx succeeds. Deferred to outer scope.
                return { gracePeriodExtended: true as const };
              }
            }

            const updated = await tx.order.updateMany({
              where: { id: order.id, status: OrderStatus.IN_DELIVERY },
              data: { status: OrderStatus.COMPLETED, completedAt: new Date() },
            });
            if (updated.count === 0) return;

            const buyerWalletLookup = await tx.wallet.findUnique({ where: { userId: order.buyerId }, select: { id: true } });
            const sellerWalletLookup = await tx.wallet.findUnique({ where: { userId: order.sellerId }, select: { id: true } });
            if (!buyerWalletLookup) throw new Error(`Buyer wallet not found: ${order.buyerId}`);
            if (!sellerWalletLookup) throw new Error(`Seller wallet not found: ${order.sellerId}`);

            const [firstId, secondId] = [buyerWalletLookup.id, sellerWalletLookup.id].sort();
            await tx.$queryRaw`SELECT id FROM wallets WHERE id IN (${firstId}, ${secondId}) ORDER BY id FOR UPDATE`;

            const buyerWallet = await tx.wallet.findUnique({ where: { id: buyerWalletLookup.id } });
            const sellerWallet = await tx.wallet.findUnique({ where: { id: sellerWalletLookup.id } });
            if (!buyerWallet) throw new Error(`Buyer wallet not found after lock: ${order.buyerId}`);
            if (!sellerWallet) throw new Error(`Seller wallet not found after lock: ${order.sellerId}`);

            /*
             * C-01: a locked wallet must not be moved by the cron either. Both manual escrow
             * release paths refuse a locked wallet (OrderStateService.completeOrder and
             * MutualResolutionService), but this one only carried a `version` guard — so an
             * account frozen for fraud investigation still had its escrow released the moment
             * the delivery deadline passed, which is precisely what the freeze exists to stop.
             * Deferred rather than failed: the deadline stays passed, so the next run picks the
             * order up once the wallet is unlocked.
             */
            if (buyerWallet.isLocked) {
              throw new Error(`${DEFER_PREFIX}buyer wallet is locked — escrow release deferred`);
            }
            if (sellerWallet.isLocked) {
              throw new Error(`${DEFER_PREFIX}seller wallet is locked — escrow release deferred`);
            }

            const escrowLock = await tx.walletTransaction.findFirst({
              where: { orderId: order.id, type: WalletTransactionType.ORDER_LOCK, status: WalletTransactionStatus.SUCCESS },
              select: { amount: true },
            });
            if (!escrowLock || escrowLock.amount !== order.buyerPayAmount) {
              throw new Error(`ESCROW_LOCK_MISSING: auto-complete blocked for order ${order.orderId}`);
            }

            if (releaseTxSerial === null) releaseTxSerial = await this.walletTxSerialService.getNext();
            if (receiveTxSerial === null) receiveTxSerial = await this.walletTxSerialService.getNext();
            if (order.feeAmount > BigInt(0) && feeTxSerial === null) feeTxSerial = await this.walletTxSerialService.getNext();

            const buyerUpdated = await tx.wallet.updateMany({
              where: { id: buyerWallet.id, version: buyerWallet.version, escrowBalance: { gte: order.buyerPayAmount } },
              data: {
                escrowBalance: { decrement: order.buyerPayAmount },
                totalBalance: { decrement: order.buyerPayAmount },
                version: { increment: 1 },
              },
            });
            if (buyerUpdated.count === 0) throw new Error(`OCC conflict on buyer wallet for order ${order.orderId}`);

            const sellerUpdated = await tx.wallet.updateMany({
              where: { id: sellerWallet.id, version: sellerWallet.version },
              data: {
                availableBalance: { increment: order.sellerReceiveAmount },
                totalBalance: { increment: order.sellerReceiveAmount },
                version: { increment: 1 },
              },
            });
            if (sellerUpdated.count === 0) throw new Error(`OCC conflict on seller wallet for order ${order.orderId}`);

            const buyerBalanceBefore = buyerWallet.escrowBalance;
            const buyerBalanceAfter = buyerWallet.escrowBalance - order.buyerPayAmount;
            const sellerBalanceBefore = sellerWallet.availableBalance;
            const sellerBalanceAfter = sellerWallet.availableBalance + order.sellerReceiveAmount;

            const releaseTxId = generateWalletTxId(releaseTxSerial);
            const receiveTxId = generateWalletTxId(receiveTxSerial);

            await tx.walletTransaction.create({
              data: {
                txId: releaseTxId,
                walletId: buyerWallet.id,
                type: WalletTransactionType.ORDER_RELEASE,
                status: WalletTransactionStatus.SUCCESS,
                amount: order.buyerPayAmount,
                balanceBefore: buyerBalanceBefore,
                balanceAfter: buyerBalanceAfter,
                orderId: order.id,
                description: `Auto-completed order ${order.orderId} — escrow released from buyer`,
              },
            });

            await tx.walletTransaction.create({
              data: {
                txId: receiveTxId,
                walletId: sellerWallet.id,
                type: WalletTransactionType.ORDER_RELEASE,
                status: WalletTransactionStatus.SUCCESS,
                amount: order.sellerReceiveAmount,
                balanceBefore: sellerBalanceBefore,
                balanceAfter: sellerBalanceAfter,
                orderId: order.id,
                description: `Auto-completed order ${order.orderId} — funds received by seller`,
              },
            });

            if (order.feeAmount > BigInt(0) && feeTxSerial !== null) {
              const feeBalanceBefore = buyerWallet.totalBalance;
              const feeTxId = generateWalletTxId(feeTxSerial);
              await tx.walletTransaction.create({
                data: {
                  txId: feeTxId,
                  walletId: buyerWallet.id,
                  type: WalletTransactionType.FEE_DEDUCT,
                  status: WalletTransactionStatus.SUCCESS,
                  amount: order.feeAmount,
                  balanceBefore: feeBalanceBefore,
                  balanceAfter: feeBalanceBefore - order.feeAmount,
                  orderId: order.id,
                  description: `Platform fee for auto-completed order ${order.orderId}`,
                },
              });
            }

            await this.referralService.createReferralRewardIfEligible(order.buyerId, order.feeAmount, order.id, tx);
            await this.referralService.createReferralRewardIfEligible(order.sellerId, order.feeAmount, order.id, tx);

            if (order.isKahadePlus && order.feeAmount > BigInt(0)) {
              try {
                const activeSub = await tx.subscription.findFirst({
                  where: {
                    userId: order.buyerId,
                    status: { in: [SubscriptionStatus.ACTIVE, SubscriptionStatus.CANCELLED] },
                    currentPeriodEnd: { gt: new Date() },
                  },
                  select: { id: true, feeSavingsUsed: true, feeSavingsLimit: true },
                });
                if (activeSub && activeSub.feeSavingsUsed < activeSub.feeSavingsLimit) {
                  const feeConfig = await this.feeCalculator.getFeeConfig();
                  // Canonical helper — savings respect the [Rp 5.000, Rp
                  // 250.000] clamp on the standard fee that the buyer was
                  // actually charged under.
                  const savings = this.feeCalculator.getPlusSavingsSen(order.orderValue, feeConfig);
                  if (savings > BigInt(0)) {
                    await tx.$executeRaw`
                      UPDATE "subscriptions"
                      SET "feeSavingsUsed" = LEAST("feeSavingsUsed" + ${savings}::bigint, "feeSavingsLimit")
                      WHERE "id" = ${activeSub.id}
                        AND "feeSavingsUsed" < "feeSavingsLimit"
                    `;
                  }
                }
              } catch (err) {
                if (
                  err instanceof Prisma.PrismaClientKnownRequestError ||
                  err instanceof Prisma.PrismaClientUnknownRequestError ||
                  err instanceof Prisma.PrismaClientRustPanicError
                ) {
                  throw err;
                }
                this.logger.warn(`Failed to track fee savings for auto-completed order ${order.orderId}: ${err instanceof Error ? err.message : String(err)}`);
              }
            }

            await tx.orderStatusHistory.create({
              data: {
                orderId: order.id,
                fromStatus: OrderStatus.IN_DELIVERY,
                toStatus: OrderStatus.COMPLETED,
                changedBy: 'SYSTEM',
                changedByType: ActorType.SYSTEM,
                reason: 'Auto-completed: delivery deadline passed without dispute',
              },
            });

            await Promise.all([
              tx.user.update({
                where: { id: order.buyerId },
                data: {
                  totalOrdersCompleted: { increment: 1 },
                  totalOrdersAsBuyer: { increment: 1 },
                  totalTransactionValue: { increment: order.orderValue },
                },
              }),
              tx.user.update({
                where: { id: order.sellerId },
                data: {
                  totalOrdersCompleted: { increment: 1 },
                  totalOrdersAsSeller: { increment: 1 },
                  totalTransactionValue: { increment: order.orderValue },
                },
              }),
            ]);

            await this.membershipRankService.checkAndUpdateMembershipRank(tx, order.buyerId);
            await this.membershipRankService.checkAndUpdateMembershipRank(tx, order.sellerId);

            this.logger.log(`Auto-completed order ${order.orderId}`);

            return { completed: true as const };
          }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }), `AUTO_COMPLETE:${order.orderId}`);

          /*
           * C-03: these realtime pushes used to fire unconditionally after the tx, so every
           * early return above — no proof at all, only rejected proofs, grace period granted,
           * status changed under us — still told the buyer the order was auto-completed and
           * told the seller "Rp X has been credited to your wallet" when no money had moved
           * and the order was still IN_DELIVERY. Gated on the tx outcome now.
           */
          if (outcome && 'gracePeriodExtended' in outcome) {
            await this.redis
              .setex(graceKey, AUTO_COMPLETE_GRACE_PERIOD_HOURS * 3600 + 3600, '1')
              .catch((err) => this.logger.warn(`silent-catch: ${err instanceof Error ? err.message : String(err)}`));
            this.runRealtimeBestEffort(() => this.prisma.emitNotificationCreated({
              userId: order.buyerId,
              title: 'Segera Review Bukti Pengiriman',
              body: `Deadline order "${order.title}" diperpanjang ${AUTO_COMPLETE_GRACE_PERIOD_HOURS} jam — segera review bukti pengiriman.`,
              data: { type: 'ORDER_DELIVERED', orderId: order.orderId },
            }), `AUTO_COMPLETE_GRACE_NOTIFICATION orderId=${order.orderId}`);
            this.logger.log(`Extended deadline by ${AUTO_COMPLETE_GRACE_PERIOD_HOURS}h for order ${order.orderId}: proof is SUBMITTED but not reviewed`);
            continue;
          }

          if (!outcome?.completed) continue;

          const postAmountIdr = toIdr(order.sellerReceiveAmount).toLocaleString('id-ID');
          this.prisma.notification.create({
            data: {
              notifId: generateNotifId(),
              userId: order.buyerId,
              type: NotificationType.ORDER_COMPLETED,
              category: getCategoryForType(NotificationType.ORDER_COMPLETED),
              title: 'Order Auto-Completed',
              body: `Order "${order.title}" has been auto-completed because the delivery deadline has passed.`,
              isRead: false,
            },
          }).catch((notificationError: unknown) => this.logger.warn(`silent-catch: auto-complete buyer notification failed: ${notificationError instanceof Error ? notificationError.message : String(notificationError)}`));
          this.prisma.notification.create({
            data: {
              notifId: generateNotifId(),
              userId: order.sellerId,
              type: NotificationType.ORDER_PAYMENT_RECEIVED,
              category: getCategoryForType(NotificationType.ORDER_PAYMENT_RECEIVED),
              title: 'Funds Received',
              body: `Order "${order.title}" completed. Rp ${postAmountIdr} has been credited to your wallet.`,
              isRead: false,
            },
          }).catch((notificationError: unknown) => this.logger.warn(`silent-catch: auto-complete seller notification failed: ${notificationError instanceof Error ? notificationError.message : String(notificationError)}`));
          this.runRealtimeBestEffort(() => this.prisma.emitNotificationCreated({ userId: order.buyerId, title: 'Order Auto-Completed', body: `Order "${order.title}" has been auto-completed because the delivery deadline has passed.`, data: { type: 'ORDER_COMPLETED', orderId: order.orderId } }), `AUTO_COMPLETE_BUYER_NOTIFICATION orderId=${order.orderId}`);
          this.runRealtimeBestEffort(() => this.prisma.emitNotificationCreated({ userId: order.sellerId, title: 'Funds Received', body: `Order "${order.title}" completed. Rp ${postAmountIdr} has been credited to your wallet.`, data: { type: 'WALLET_FUNDS_RELEASED', orderId: order.orderId } }), `AUTO_COMPLETE_SELLER_NOTIFICATION orderId=${order.orderId}`);
          // Success: clear any previous failure counter
          await this.redis.del(`auto_complete_failures:${order.id}`).catch((err) => this.logger.warn(`silent-catch: ${err instanceof Error ? err.message : String(err)}`));
        } catch (err: unknown) {
          const errMsg = err instanceof Error ? err.message : String(err);

          // A deliberate deferral (locked wallet) is not a failure: log it and leave the
          // consecutive-failure counter alone so ops are not paged for a working freeze.
          if (errMsg.startsWith(DEFER_PREFIX)) {
            this.logger.warn(
              `Deferred auto-complete for order ${order.orderId}: ${errMsg.slice(DEFER_PREFIX.length)}`,
            );
            continue;
          }

          this.logger.error(`Failed to auto-complete order ${order.orderId}: ${errMsg}`);

          const failureKey = `auto_complete_failures:${order.id}`;
          const failCount = await this.redis.incr(failureKey).catch(() => 0);
          if (failCount === 1) {
            // Expire tracking key after 7 days to avoid unbounded Redis growth
            await this.redis.expire(failureKey, 7 * 24 * 3600).catch((err) => this.logger.warn(`silent-catch: ${err instanceof Error ? err.message : String(err)}`));
          }

          // After 3 consecutive failures, emit a CRITICAL-level alert so ops are notified
          const FAILURE_ALERT_THRESHOLD = 3;
          if (failCount >= FAILURE_ALERT_THRESHOLD) {
            this.logger.error(
              `CRITICAL: Order ${order.orderId} has failed auto-complete ${failCount} times. ` +
              `Manual intervention required. Error: ${errMsg}`,
            );
          }
        }
      }
      } // end while
    } catch (error) {
      this.logger.error('AutoCompleteDeliveredOrders FAILED', error);
    } finally {
      clearInterval(lockRenewalInterval);
      await this.redis.releaseLock(lockKey, lockToken).catch((err) => this.logger.warn(`silent-catch: ${err instanceof Error ? err.message : String(err)}`));
    }
  }

  private async withSerializableRetry<T>(operation: () => Promise<T>, label: string): Promise<T> {
    const maxRetries = 3;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        return await operation();
      } catch (error: unknown) {
        const retryable = error instanceof Prisma.PrismaClientKnownRequestError
          ? error.code === 'P2034'
          : error instanceof Prisma.PrismaClientUnknownRequestError
            && /40001|40p01|serialization|deadlock/i.test(error.message);
        if (!retryable || attempt === maxRetries) throw error;
        this.logger.warn(`${label}_RETRY attempt=${attempt}/${maxRetries}`);
        await new Promise((resolve) => setTimeout(resolve, 100 * Math.pow(2, attempt - 1) + randomInt(0, 50)));
      }
    }
    throw new Error(`${label} exhausted retry loop`);
  }
}
