import { Injectable, Logger, Optional, Inject } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import {
  OrderStatus,
  WalletTransactionType,
  WalletTransactionStatus,
  ActorType,
  NotificationType,
  SubscriptionStatus,
  EscrowDisbursementScope,
  EscrowDisbursementStatus,
  Prisma,
} from '@prisma/client';
import { randomUUID, randomInt } from 'crypto';
import { getCategoryForType } from '../../notifications/notification-category.map';
import { PrismaService } from '../../../prisma/prisma.service';
import { RedisService } from '../../../redis/redis.service';
// P2-R1: kirim pesan sistem "order selesai" ke ruang chat transaksi saat
// auto-complete — sama seperti alur manual (order-state.service.ts:299).
import { ChatOrderHooks } from '../../chat/chat-order-hooks';
import { WalletTxSerialService } from '../../../common/services/wallet-tx-serial.service';
import { ReferralService } from '../../referral/referral.service';
import { MembershipRankService } from '../../orders/membership-rank.service';
import { FeeCalculatorService } from '../../orders/fee-calculator.service';
import { generateWalletTxId, generateNotifId } from '../../../common/utils/id-generator.util';
import { rollbackOrderVoucherUsage } from '../../../common/utils/voucher-rollback.util';
import { creditCashbackIfEligible, planDanaCashback, executeDanaCashback, CashbackCreditResult } from '../../../common/utils/cashback-credit.util';
import { WalletModeService } from '../../wallet-mode/wallet-mode.service';
import { EscrowDisbursementService } from '../../no-wallet/escrow-disbursement.service';
import { deriveDanaRefundNo } from '../../no-wallet/dana-direct-refund.service';
import { alertMoneyCronSkippedRedisDown, ensureRedisAvailable } from '../../../common/utils/redis-health.util';
import { toIdr, formatSen } from '../../../common/utils/currency.util';
import { AUTO_COMPLETE_GRACE_PERIOD_HOURS, DELIVERY_REVIEW_WINDOW_DAYS } from '../../../common/constants/app.constants';

/*
 * Thrown inside the tx to roll it back while telling the caller this order was deferred
 * rather than failed, so a deliberately frozen wallet does not burn the consecutive-failure
 * counter and raise a false CRITICAL alert. Same idiom as ScheduledWithdrawalService.
 */
const DEFER_PREFIX = 'DEFER_AUTO_COMPLETE:';

/*
 * P1-2 FIX: Batas waktu seller-abandoned. Order IN_DELIVERY tanpa proof sama
 * sekali yang deadline-nya sudah lewat lebih dari 2x review window dianggap
 * ditinggalkan seller → auto-cancel + auto-refund ke buyer agar dana tidak
 * terkunci selamanya.
 */
const SELLER_ABANDONED_MULTIPLIER = 2;

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
    // M4 no-wallet: payout cashback via disbursement DANA bila wallet mati.
    // @Inject EKSPLISIT (bukan hanya mengandalkan design:paramtypes):
    // TypeScript meng-emit `Object` untuk tipe union `X | null`, sehingga
    // tanpa @Inject kedua param @Optional ini SELALU undefined di runtime
    // (Nest gagal resolve token Object dan @Optional menelannya diam-diam).
    // Akibatnya cabang no-wallet tidak pernah jalan di production.
    @Optional() @Inject(WalletModeService) private walletMode: WalletModeService | null,
    @Optional() @Inject(EscrowDisbursementService) private disbursement: EscrowDisbursementService | null,
  ) {}

  private runRealtimeBestEffort(task: () => void, label: string): void {
    try {
      task();
    } catch (error: unknown) {
      this.logger.warn(
        `${label} realtime side effect failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  // SCH-017: Runs every hour to auto-complete delivered orders past deadline
  @Cron('0 * * * *', { name: 'auto-complete-orders' })
  async autoComplete(): Promise<void> {
    if (!(await ensureRedisAvailable(this.redis, 'auto-complete-orders', {
        // CW-014: job kritis-uang — skip karena Redis down harus termonitor,
        // bukan senyap.
        onRedisDown: () => alertMoneyCronSkippedRedisDown('auto-complete-orders'),
      }))) return;

    const lockKey = 'cron_lock:auto_complete_orders';
    const lockToken = randomUUID();
    const acquired = await this.redis.setNx(lockKey, lockToken, 3600);
    if (!acquired) return;

    let lockLost = false;
    const lockRenewalInterval = setInterval(() => {
      // AUDIT: keep the interval callback synchronous — an async callback
      // risks overlapping ticks and unhandled rejections when renewLock throws.
      void (async () => {
        const renewed = await this.redis.renewLock(lockKey, lockToken, 3600);
        if (!renewed) {
          lockLost = true;
          clearInterval(lockRenewalInterval);
          this.logger.warn(
            'Auto-complete lock ownership was lost; stopping after the current order.',
          );
        }
      })().catch((err: unknown) => {
        this.logger.error(`Lock renewal check failed: ${(err as Error).message}`);
      });
    }, 60_000);

    const now = new Date();
    try {
      let hasMore = true;
      while (hasMore) {
        if (lockLost || (await this.redis.get(lockKey)) !== lockToken) {
          this.logger.warn(
            'Auto-complete lock ownership was lost; aborting before the next batch.',
          );
          return;
        }
        const orders = await this.prisma.order.findMany({
          where: {
            status: OrderStatus.IN_DELIVERY,
            deliveryDeadlineAt: { lt: now },
            deletedAt: null,
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

        if (orders.length === 0) {
          hasMore = false;
          break;
        }
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

            const outcome = await this.withSerializableRetry(
              () =>
                this.prisma.$transaction(
                  async tx => {
                    // Re-read the order after the transaction starts. The batch query is only a
                    // candidate list; an extension or dispute may have changed the deadline/status
                    // while this order waited in the batch.
                    const freshOrder = await tx.order.findUnique({
                      where: { id: order.id },
                      select: {
                        status: true,
                        deliveryDeadlineAt: true,
                        deletedAt: true,
                        dispute: { select: { id: true } },
                      },
                    });
                    if (
                      !freshOrder ||
                      freshOrder.status !== OrderStatus.IN_DELIVERY ||
                      !freshOrder.deliveryDeadlineAt ||
                      freshOrder.deliveryDeadlineAt >= now ||
                      freshOrder.dispute ||
                      freshOrder.deletedAt
                    ) {
                      return;
                    }

                    const acceptedProof = await tx.deliveryProof.findFirst({
                      where: { orderId: order.id, status: 'ACCEPTED' },
                      select: { id: true },
                    });

                    // TX-AUDIT2 (P1-D): flag auto-confirm via resi — di-set di
                    // cabang "tanpa proof sama sekali" bila seller punya
                    // trackingNumber. Bila true, lewati logika proof/grace
                    // dan langsung ke jalur release (cair ke seller).
                    let autoConfirmByShipmentEvidence = false;

                    if (!acceptedProof) {
                      const submittedProof = await tx.deliveryProof.findFirst({
                        where: {
                          orderId: order.id,
                          status: 'SUBMITTED',
                          reviewWindowEnd: { gt: now },
                        },
                        select: { id: true, status: true },
                      });

                      if (!submittedProof) {
                        const rejectedProof = await tx.deliveryProof.findFirst({
                          where: { orderId: order.id, status: { in: ['REJECTED'] } },
                          select: { id: true },
                        });

                        if (!rejectedProof) {
                          /*
                           * TX-AUDIT2 (P1-D): keputusan produk "100% adil, jangan ada fraud".
                           * Order IN_DELIVERY tanpa deliveryProof sama sekali:
                           * - Seller PUNYA bukti kirim (resi/trackingNumber — wajib untuk
                           *   fisik saat processOrder) + buyer diam 2x review window →
                           *   auto-confirm: dana CAIR ke seller (diam = menerima).
                           * - Seller TANPA bukti kirim sama sekali → seller-abandoned →
                           *   auto-cancel + auto-refund ke buyer.
                           * Tanpa cabang ini (P1-2 lama), buyer yang diam mendapat
                           * barang + refund penuh = vektor fraud double-dip.
                           */
                          const abandonThreshold = new Date(
                            now.getTime() -
                              SELLER_ABANDONED_MULTIPLIER *
                                DELIVERY_REVIEW_WINDOW_DAYS *
                                24 *
                                60 *
                                60 *
                                1000,
                          );
                          const deadline = freshOrder.deliveryDeadlineAt;
                          if (deadline && deadline < abandonThreshold) {
                            const shipmentEvidence = await tx.order.findUnique({
                              where: { id: order.id },
                              select: { trackingNumber: true },
                            });
                            if (shipmentEvidence?.trackingNumber) {
                              this.logger.log(
                                `AUTO-CONFIRM: Order ${order.orderId} IN_DELIVERY tanpa proof ` +
                                  `tapi seller punya resi, buyer diam setelah ` +
                                  `${SELLER_ABANDONED_MULTIPLIER}x review window. Dana cair ke seller.`,
                              );
                              autoConfirmByShipmentEvidence = true;
                            } else {
                              this.logger.error(
                                `SELLER-ABANDONED: Order ${order.orderId} IN_DELIVERY tanpa proof ` +
                                  `sama sekali dan tanpa resi, deadline ${deadline.toISOString()} sudah lewat ` +
                                  `${SELLER_ABANDONED_MULTIPLIER}x review window. Auto-cancel + auto-refund ke buyer.`,
                              );
                              return await this.cancelAbandonedOrder(tx, order, now);
                            }
                          } else {
                            // Belum lewat threshold — tetap skip tapi dengan alert yang jelas
                            // (bukan warn biasa) agar terpantau di monitoring.
                            this.logger.error(
                              `ALERT: Order ${order.orderId} IN_DELIVERY tanpa proof sama sekali ` +
                                `(deadline: ${deadline?.toISOString() ?? 'null'}). ` +
                                `Akan auto-confirm (bila ada resi) atau auto-refund (tanpa resi) ` +
                                `jika buyer tetap diam hingga ${abandonThreshold.toISOString()}.`,
                            );
                            return;
                          }
                        }
                      }

                      // TX-AUDIT2 (P1-D): bila auto-confirm via resi, lewati cabang
                      // "hanya rejected proof" — langsung ke release.
                      if (!submittedProof && !autoConfirmByShipmentEvidence) {
                        this.logger.log(
                          `Order ${order.orderId} has only rejected/expired proofs and no accepted proof — seller must resubmit. Skipping.`,
                        );
                        return;
                      }

                      // TX-AUDIT2 (P1-D): auto-confirm via resi tidak perlu grace
                      // period tambahan — buyer sudah diam 2x review window penuh.
                      // Langsung ke jalur release (cair ke seller) di bawah.
                      if (!autoConfirmByShipmentEvidence) {
                      // C-02: the grace marker was read before the tx started (see above) — no Redis
                      // access inside the transaction.
                      if (alreadyExtended) {
                        this.logger.log(
                          `Grace period already granted for order ${order.orderId} — now auto-completing with SUBMITTED proof`,
                        );
                      } else {
                        const graceEnd = new Date(
                          now.getTime() + AUTO_COMPLETE_GRACE_PERIOD_HOURS * 60 * 60 * 1000,
                        );
                        const extensionGranted = await tx.order.updateMany({
                          where: { id: order.id, status: OrderStatus.IN_DELIVERY, deletedAt: null },
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
                      } // end TX-AUDIT2 (P1-D): skip grace period bila auto-confirm via resi
                    }

                    const updated = await tx.order.updateMany({
                      where: { id: order.id, status: OrderStatus.IN_DELIVERY, deletedAt: null },
                      data: { status: OrderStatus.COMPLETED, completedAt: new Date() },
                    });
                    if (updated.count === 0) return;

                    // SEC-101: cabang no-wallet vs wallet diputuskan SEKALI di sini.
                    const walletEnabled = this.walletMode?.isWalletEnabled() ?? true;
                    let danaCashback: {
                      params: { orderDbId: string; orderPublicId: string; source: string };
                      intent: { userId: string; amountSen: bigint; voucherCode: string | null; usageId: string };
                    } | null = null;
                    let cashbackResult: CashbackCreditResult | null = null;
                    // SEC-101: no-wallet → baris escrowDisbursement PENDING dibuat di
                    // dalam tx; releaseForOrder dieksekusi post-commit (di bawah).
                    let danaEscrowRelease: { orderDbId: string; orderPublicId: string } | null = null;

                    if (walletEnabled) {
                    const buyerWalletLookup = await tx.wallet.findUnique({
                      where: { userId: order.buyerId },
                      select: { id: true },
                    });
                    const sellerWalletLookup = await tx.wallet.findUnique({
                      where: { userId: order.sellerId },
                      select: { id: true },
                    });
                    if (!buyerWalletLookup)
                      throw new Error(`Buyer wallet not found: ${order.buyerId}`);
                    if (!sellerWalletLookup)
                      throw new Error(`Seller wallet not found: ${order.sellerId}`);

                    const [firstId, secondId] = [
                      buyerWalletLookup.id,
                      sellerWalletLookup.id,
                    ].sort();
                    await tx.$queryRaw`SELECT id FROM wallets WHERE id IN (${firstId}, ${secondId}) ORDER BY id FOR UPDATE`;

                    const buyerWallet = await tx.wallet.findUnique({
                      where: { id: buyerWalletLookup.id },
                    });
                    const sellerWallet = await tx.wallet.findUnique({
                      where: { id: sellerWalletLookup.id },
                    });
                    if (!buyerWallet)
                      throw new Error(`Buyer wallet not found after lock: ${order.buyerId}`);
                    if (!sellerWallet)
                      throw new Error(`Seller wallet not found after lock: ${order.sellerId}`);

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
                      throw new Error(
                        `${DEFER_PREFIX}buyer wallet is locked — escrow release deferred`,
                      );
                    }
                    if (sellerWallet.isLocked) {
                      throw new Error(
                        `${DEFER_PREFIX}seller wallet is locked — escrow release deferred`,
                      );
                    }

                    const escrowLock = await tx.walletTransaction.findFirst({
                      where: {
                        orderId: order.id,
                        type: WalletTransactionType.ORDER_LOCK,
                        status: WalletTransactionStatus.SUCCESS,
                      },
                      select: { amount: true },
                    });
                    if (!escrowLock || escrowLock.amount !== order.buyerPayAmount) {
                      throw new Error(
                        `ESCROW_LOCK_MISSING: auto-complete blocked for order ${order.orderId}`,
                      );
                    }

                    if (releaseTxSerial === null)
                      releaseTxSerial = await this.walletTxSerialService.getNext();
                    if (receiveTxSerial === null)
                      receiveTxSerial = await this.walletTxSerialService.getNext();
                    if (order.feeAmount > BigInt(0) && feeTxSerial === null)
                      feeTxSerial = await this.walletTxSerialService.getNext();

                    const buyerUpdated = await tx.wallet.updateMany({
                      where: {
                        id: buyerWallet.id,
                        version: buyerWallet.version,
                        escrowBalance: { gte: order.buyerPayAmount },
                      },
                      data: {
                        escrowBalance: { decrement: order.buyerPayAmount },
                        totalBalance: { decrement: order.buyerPayAmount },
                        version: { increment: 1 },
                      },
                    });
                    if (buyerUpdated.count === 0)
                      throw new Error(`OCC conflict on buyer wallet for order ${order.orderId}`);

                    const sellerUpdated = await tx.wallet.updateMany({
                      where: { id: sellerWallet.id, version: sellerWallet.version },
                      data: {
                        availableBalance: { increment: order.sellerReceiveAmount },
                        totalBalance: { increment: order.sellerReceiveAmount },
                        version: { increment: 1 },
                      },
                    });
                    if (sellerUpdated.count === 0)
                      throw new Error(`OCC conflict on seller wallet for order ${order.orderId}`);

                    const buyerBalanceBefore = buyerWallet.escrowBalance;
                    const buyerBalanceAfter = buyerWallet.escrowBalance - order.buyerPayAmount;
                    const sellerBalanceBefore = sellerWallet.availableBalance;
                    const sellerBalanceAfter =
                      sellerWallet.availableBalance + order.sellerReceiveAmount;

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

                    // Batch 1-money (EO-005): cashback voucher juga dikredit pada
                    // auto-complete — sebelumnya hangus diam-diam.
                    cashbackResult = await creditCashbackIfEligible(
                      tx,
                      () => this.walletTxSerialService.getNext(),
                      {
                        orderDbId: order.id,
                        orderPublicId: order.orderId,
                        source: 'auto-complete',
                      },
                    );

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
                    } else {
                      // SEC-101 (P1): cabang no-wallet — escrow DANA-direct TIDAK
                      // punya baris ORDER_LOCK / escrowBalance; seluruh blok
                      // ledger wallet di atas dilewati. Sebagai gantinya buat
                      // baris escrowDisbursement PENDING di dalam tx yang sama
                      // (durable), lalu eksekusi releaseForOrder post-commit —
                      // pola yang sama dengan handleCompleteOrder
                      // (order-state.service.ts).
                      if (order.sellerReceiveAmount == null || order.sellerReceiveAmount <= BigInt(0)) {
                        throw new Error(
                          `ORDER_NOT_RELEASE_ELIGIBLE: auto-complete blocked for order ${order.orderId}`,
                        );
                      }
                      const disbKey = `ORDER:${order.id}`;
                      const existingDisb = await tx.escrowDisbursement.findUnique({
                        where: { idempotencyKey: disbKey },
                        select: { id: true },
                      });
                      if (!existingDisb) {
                        await tx.escrowDisbursement.create({
                          data: {
                            idempotencyKey: disbKey,
                            scope: EscrowDisbursementScope.ORDER_ESCROW,
                            orderId: order.id,
                            sellerId: order.sellerId,
                            amountSen: order.sellerReceiveAmount,
                            status: EscrowDisbursementStatus.PENDING,
                          },
                        });
                      }
                      // M4 no-wallet: rencanakan payout cashback DANA (eksekusi post-tx).
                      const params = {
                        orderDbId: order.id,
                        orderPublicId: order.orderId,
                        source: 'auto-complete',
                      };
                      const intent = await planDanaCashback(tx, params);
                      danaCashback = intent ? { params, intent } : null;
                      danaEscrowRelease = { orderDbId: order.id, orderPublicId: order.orderId };
                    }

                    const buyerRewardCredited = await this.referralService.createReferralRewardIfEligible(
                      order.buyerId,
                      order.feeAmount,
                      order.id,
                      tx,
                    );
                    const sellerRewardCredited = await this.referralService.createReferralRewardIfEligible(
                      order.sellerId,
                      order.feeAmount,
                      order.id,
                      tx,
                    );
                    const referralRewardCredited = buyerRewardCredited || sellerRewardCredited;

                    if (order.isKahadePlus && order.feeAmount > BigInt(0)) {
                      try {
                        const activeSub = await tx.subscription.findFirst({
                          where: {
                            userId: order.buyerId,
                            status: {
                              in: [SubscriptionStatus.ACTIVE, SubscriptionStatus.CANCELLED],
                            },
                            currentPeriodEnd: { gt: new Date() },
                          },
                          select: { id: true, feeSavingsUsed: true, feeSavingsLimit: true },
                        });
                        if (activeSub && activeSub.feeSavingsUsed < activeSub.feeSavingsLimit) {
                          const feeConfig = await this.feeCalculator.getFeeConfig();
                          // Canonical helper — savings respect the [Rp 2.500, Rp
                          // 250.000] clamp on the standard fee that the buyer was
                          // actually charged under.
                          const savings = this.feeCalculator.getPlusSavingsSen(
                            order.orderValue,
                            feeConfig,
                          );
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
                        this.logger.warn(
                          `Failed to track fee savings for auto-completed order ${order.orderId}: ${err instanceof Error ? err.message : String(err)}`,
                        );
                      }
                    }

                    await tx.orderStatusHistory.create({
                      data: {
                        orderId: order.id,
                        fromStatus: OrderStatus.IN_DELIVERY,
                        toStatus: OrderStatus.COMPLETED,
                        changedBy: 'SYSTEM',
                        changedByType: ActorType.SYSTEM,
                        // TX-AUDIT2 (P1-D): bedakan alasan auto-confirm via resi.
                        reason: autoConfirmByShipmentEvidence
                          ? 'Auto-confirm: seller punya bukti kirim (resi), buyer diam 2x review window — dana cair ke seller'
                          : 'Auto-completed: delivery deadline passed without dispute',
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

                    await this.membershipRankService.checkAndUpdateMembershipRank(
                      tx,
                      order.buyerId,
                    );
                    await this.membershipRankService.checkAndUpdateMembershipRank(
                      tx,
                      order.sellerId,
                    );

                    this.logger.log(`Auto-completed order ${order.orderId}`);

                    return { completed: true as const, cashback: cashbackResult, danaCashback, danaEscrowRelease, referralRewardCredited };
                  },
                  { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
                ),
              `AUTO_COMPLETE:${order.orderId}`,
            );

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
                .catch(err =>
                  this.logger.warn(
                    `silent-catch: ${err instanceof Error ? err.message : String(err)}`,
                  ),
                );
              this.runRealtimeBestEffort(
                () =>
                  this.prisma.emitNotificationCreated({
                    userId: order.buyerId,
                    title: 'Segera Review Bukti Pengiriman',
                    body: `Deadline order "${order.title}" diperpanjang ${AUTO_COMPLETE_GRACE_PERIOD_HOURS} jam — segera review bukti pengiriman.`,
                    data: { type: 'ORDER_DELIVERED', orderId: order.orderId },
                  }),
                `AUTO_COMPLETE_GRACE_NOTIFICATION orderId=${order.orderId}`,
              );
              this.logger.log(
                `Extended deadline by ${AUTO_COMPLETE_GRACE_PERIOD_HOURS}h for order ${order.orderId}: proof is SUBMITTED but not reviewed`,
              );
              continue;
            }

            if (outcome && 'abandonedRefunded' in outcome) {
              // P1-2: notifikasi untuk seller-abandoned auto-refund.
              const refundAmountIdr = formatSen(order.buyerPayAmount);
              this.prisma.notification
                .create({
                  data: {
                    notifId: generateNotifId(),
                    userId: order.buyerId,
                    type: NotificationType.ORDER_CANCELLED,
                    category: getCategoryForType(NotificationType.ORDER_CANCELLED),
                    title: 'Dana Dikembalikan',
                    body: `Order "${order.title}" dibatalkan otomatis karena penjual tidak mengirim bukti pengiriman. ${refundAmountIdr} telah dikembalikan ke saldo Anda.`,
                    isRead: false,
                  },
                })
                .catch((notificationError: unknown) =>
                  this.logger.warn(
                    `silent-catch: abandoned-refund buyer notification failed: ${notificationError instanceof Error ? notificationError.message : String(notificationError)}`,
                  ),
                );
              this.prisma.notification
                .create({
                  data: {
                    notifId: generateNotifId(),
                    userId: order.sellerId,
                    type: NotificationType.ORDER_CANCELLED,
                    category: getCategoryForType(NotificationType.ORDER_CANCELLED),
                    title: 'Order Dibatalkan Otomatis',
                    body: `Order "${order.title}" dibatalkan otomatis karena Anda tidak mengirim bukti pengiriman dalam batas waktu.`,
                    isRead: false,
                  },
                })
                .catch((notificationError: unknown) =>
                  this.logger.warn(
                    `silent-catch: abandoned-refund seller notification failed: ${notificationError instanceof Error ? notificationError.message : String(notificationError)}`,
                  ),
                );
              this.runRealtimeBestEffort(
                () =>
                  this.prisma.emitNotificationCreated({
                    userId: order.buyerId,
                    title: 'Dana Dikembalikan',
                    body: `Order "${order.title}" dibatalkan otomatis — ${refundAmountIdr} dikembalikan.`,
                    data: { type: 'ORDER_CANCELLED', orderId: order.orderId },
                  }),
                `ABANDONED_REFUND_BUYER_NOTIFICATION orderId=${order.orderId}`,
              );
              // TX-AUDIT2 (P1-D): seller juga dapat push realtime, bukan cuma inbox.
              this.runRealtimeBestEffort(
                () =>
                  this.prisma.emitNotificationCreated({
                    userId: order.sellerId,
                    title: 'Order Dibatalkan Otomatis',
                    body: `Order "${order.title}" dibatalkan otomatis karena tidak ada bukti pengiriman.`,
                    data: { type: 'ORDER_CANCELLED', orderId: order.orderId },
                  }),
                `ABANDONED_REFUND_SELLER_NOTIFICATION orderId=${order.orderId}`,
              );
              // Clear failure counter — ini hasil yang diharapkan, bukan error.
              await this.redis
                .del(`auto_complete_failures:${order.id}`)
                .catch(err =>
                  this.logger.warn(
                    `silent-catch: ${err instanceof Error ? err.message : String(err)}`,
                  ),
                );
              continue;
            }

            if (!outcome?.completed) continue;

            // SEC-101: eksekusi release escrow DANA post-commit untuk order
            // no-wallet (idempoten, key ORDER:<orderDbId>). Baris PENDING sudah
            // durable di dalam tx → bila post-commit ini gagal (atau proses
            // mati), scheduler retryDue() mengambil alih. Gagal di sini TIDAK
            // melempar (order sudah COMPLETED; jangan bakar failure counter).
            if (outcome.danaEscrowRelease && this.disbursement) {
              const { orderDbId, orderPublicId } = outcome.danaEscrowRelease;
              try {
                const danaRes = await this.disbursement.releaseForOrder(orderDbId);
                if (danaRes.outcome === 'HELD_NO_BANK') {
                  this.logger.warn(
                    `auto-complete escrow-release-dana ${orderPublicId}: HELD_NO_BANK — menunggu rekening bank seller`,
                  );
                }
              } catch (err) {
                this.logger.warn(
                  `auto-complete escrow-release-dana gagal untuk order ${orderPublicId} — retry via retryDue: ${err instanceof Error ? err.message : String(err)}`,
                );
              }
            }

            // SP-047: reward referral mengubah totalRewardEarned — invalidasi
            // leaderboard cache setelah tx commit.
            if (outcome.referralRewardCredited) {
              await this.referralService.invalidateLeaderboardCache();
              // B13: beri tahu penerima reward (post-commit, best-effort).
              await this.referralService.notifyRewardsForOrder(order.orderId);
            }

            // M4 no-wallet: eksekusi payout cashback DANA post-tx (idempoten).
            if (outcome.danaCashback && this.disbursement) {
              const { params, intent } = outcome.danaCashback;
              try {
                const danaRes = await executeDanaCashback(this.disbursement, params, intent);
                if (danaRes.outcome === 'RELEASED') {
                  const cashbackIdr = formatSen(intent.amountSen);
                  await this.prisma.notification
                    .create({
                      data: {
                        notifId: generateNotifId(),
                        userId: intent.userId,
                        type: NotificationType.CAMPAIGN_CASHBACK_CREDITED,
                        category: getCategoryForType(NotificationType.CAMPAIGN_CASHBACK_CREDITED),
                        title: 'Cashback Terkirim',
                        body: `Cashback ${cashbackIdr} dari order "${order.title}" telah dikirim ke rekening bank Anda.`,
                        isRead: false,
                      },
                    })
                    .catch((notificationError: unknown) =>
                      this.logger.warn(
                        `silent-catch: auto-complete DANA cashback notification failed: ${notificationError instanceof Error ? notificationError.message : String(notificationError)}`,
                      ),
                    );
                }
              } catch (err) {
                // Idempoten — scheduler retryDue() akan mencoba lagi.
                this.logger.warn(
                  `auto-complete DANA cashback gagal untuk order ${order.orderId}: ${err instanceof Error ? err.message : String(err)}`,
                );
              }
            }

            // Batch 1-money (EO-005): notifikasi cashback bila dikredit oleh helper.
            if (outcome.cashback?.credited && outcome.cashback.userId) {
              const cashbackIdr = formatSen(outcome.cashback.amount);
              this.prisma.notification
                .create({
                  data: {
                    notifId: generateNotifId(),
                    userId: outcome.cashback.userId,
                    type: NotificationType.CAMPAIGN_CASHBACK_CREDITED,
                    category: getCategoryForType(NotificationType.CAMPAIGN_CASHBACK_CREDITED),
                    title: 'Cashback Credited',
                    body: `Cashback ${cashbackIdr} from order "${order.title}" has been credited to your wallet.`,
                    isRead: false,
                  },
                })
                .catch((notificationError: unknown) =>
                  this.logger.warn(
                    `silent-catch: auto-complete cashback notification failed: ${notificationError instanceof Error ? notificationError.message : String(notificationError)}`,
                  ),
                );
            }

            const postAmountIdr = formatSen(order.sellerReceiveAmount);
            this.prisma.notification
              .create({
                data: {
                  notifId: generateNotifId(),
                  userId: order.buyerId,
                  type: NotificationType.ORDER_COMPLETED,
                  category: getCategoryForType(NotificationType.ORDER_COMPLETED),
                  title: 'Order Auto-Completed',
                  body: `Order "${order.title}" has been auto-completed because the delivery deadline has passed.`,
                  isRead: false,
                },
              })
              .catch((notificationError: unknown) =>
                this.logger.warn(
                  `silent-catch: auto-complete buyer notification failed: ${notificationError instanceof Error ? notificationError.message : String(notificationError)}`,
                ),
              );
            this.prisma.notification
              .create({
                data: {
                  notifId: generateNotifId(),
                  userId: order.sellerId,
                  type: NotificationType.ORDER_PAYMENT_RECEIVED,
                  category: getCategoryForType(NotificationType.ORDER_PAYMENT_RECEIVED),
                  title: 'Funds Received',
                  body: `Order "${order.title}" completed. ${postAmountIdr} has been credited to your wallet.`,
                  isRead: false,
                },
              })
              .catch((notificationError: unknown) =>
                this.logger.warn(
                  `silent-catch: auto-complete seller notification failed: ${notificationError instanceof Error ? notificationError.message : String(notificationError)}`,
                ),
              );
            this.runRealtimeBestEffort(
              () =>
                this.prisma.emitNotificationCreated({
                  userId: order.buyerId,
                  title: 'Order Auto-Completed',
                  body: `Order "${order.title}" has been auto-completed because the delivery deadline has passed.`,
                  data: { type: 'ORDER_COMPLETED', orderId: order.orderId },
                }),
              `AUTO_COMPLETE_BUYER_NOTIFICATION orderId=${order.orderId}`,
            );
            this.runRealtimeBestEffort(
              () =>
                this.prisma.emitNotificationCreated({
                  userId: order.sellerId,
                  title: 'Funds Received',
                  body: `Order "${order.title}" completed. ${postAmountIdr} has been credited to your wallet.`,
                  data: { type: 'WALLET_FUNDS_RELEASED', orderId: order.orderId },
                }),
              `AUTO_COMPLETE_SELLER_NOTIFICATION orderId=${order.orderId}`,
            );
            // P2-R1: pesan sistem "dana dicairkan" ke ruang chat transaksi —
            // pola yang sama dengan alur manual (ORDER_COMPLETED).
            this.runRealtimeBestEffort(
              () => ChatOrderHooks.emit(order.id, 'ORDER_COMPLETED'),
              `AUTO_COMPLETE_CHAT_SYSTEM_MSG orderId=${order.orderId}`,
            );
            // Success: clear any previous failure counter
            await this.redis
              .del(`auto_complete_failures:${order.id}`)
              .catch(err =>
                this.logger.warn(
                  `silent-catch: ${err instanceof Error ? err.message : String(err)}`,
                ),
              );
            // R2-B (audit): the completion above can consume the buyer's Plus fee-savings
            // quota; drop the cached `subscription_status:<userId>` snapshot (300 s TTL,
            // read by orders.service when quoting fees) like the interactive completeOrder does.
            if (order.isKahadePlus) {
              await this.redis
                .del(`subscription_status:${order.buyerId}`)
                .catch(err =>
                  this.logger.warn(
                    `silent-catch: subscription status cache invalidation failed: ${err instanceof Error ? err.message : String(err)}`,
                  ),
                );
            }
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
            // AUDIT-14: atomic INCR+EXPIRE — the separate expire could be lost, leaving
            // a TTL-less failure counter that grows unbounded and mis-alerts forever.
            const failCount = await this.redis.incrWithTtl(failureKey, 7 * 24 * 3600, {
              throwOnError: false,
            });

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
      await this.redis
        .releaseLock(lockKey, lockToken)
        .catch(err =>
          this.logger.warn(`silent-catch: ${err instanceof Error ? err.message : String(err)}`),
        );
    }
  }

  /*
   * P1-2 FIX: Batalkan order yang ditinggalkan seller (IN_DELIVERY tanpa proof
   * sama sekali setelah 2x review window) + refund escrow ke buyer.
   *
   * Dipanggil dari dalam transaksi serializable auto-complete. Mengembalikan
   * marker agar outer scope bisa kirim notifikasi.
   */
  private async cancelAbandonedOrder(
    tx: any,
    order: {
      id: string;
      orderId: string;
      buyerId: string;
      sellerId: string;
      buyerPayAmount: bigint;
      title: string;
      voucherId: string | null;
    },
    now: Date,
  ): Promise<{ abandonedRefunded: boolean }> {
    // Update status dengan guard optimistik — hanya dari IN_DELIVERY.
    const updated = await tx.order.updateMany({
      where: { id: order.id, status: OrderStatus.IN_DELIVERY, deletedAt: null },
      data: {
        status: OrderStatus.CANCELLED,
        cancelledAt: now,
        cancelReason: 'SELLER_ABANDONED',
        cancelNote:
          'Auto-cancel sistem: seller tidak mengirim bukti pengiriman sama sekali ' +
          `setelah ${SELLER_ABANDONED_MULTIPLIER}x review window dari deadline. Dana dikembalikan ke buyer.`,
      },
    });
    if (updated.count === 0) return { abandonedRefunded: true };

    await tx.orderStatusHistory.create({
      data: {
        orderId: order.id,
        fromStatus: OrderStatus.IN_DELIVERY,
        toStatus: OrderStatus.CANCELLED,
        changedBy: 'SYSTEM',
        changedByType: ActorType.SYSTEM,
        reason: 'Seller-abandoned: no delivery proof after 2x review window — auto-refund to buyer',
      },
    });

    // TX-AUDIT2 (P2): kembalikan pemakaian voucher — buyer tidak boleh
    // kehilangan voucher karena kesalahan seller. Idempoten (helper SP-034).
    if (order.voucherId) {
      await rollbackOrderVoucherUsage(tx, order.id, order.voucherId);
    }

    const walletEnabled = this.walletMode?.isWalletEnabled() ?? true;

    if (walletEnabled) {
      // Verifikasi escrow lock — pola yang sama dengan auto-complete release.
      const escrowLock = await tx.walletTransaction.findFirst({
        where: {
          orderId: order.id,
          type: WalletTransactionType.ORDER_LOCK,
          status: WalletTransactionStatus.SUCCESS,
        },
        select: { amount: true },
      });
      if (!escrowLock || escrowLock.amount !== order.buyerPayAmount) {
        throw new Error(
          `ESCROW_LOCK_MISSING: abandoned-refund blocked for order ${order.orderId}`,
        );
      }

      const walletLookup = await tx.wallet.findUnique({
        where: { userId: order.buyerId },
        select: { id: true },
      });
      if (!walletLookup) {
        throw new Error(`Buyer wallet not found for abandoned refund: ${order.buyerId}`);
      }

      // Row lock sebelum baca saldo — pola C-05 dari adminCancelOrder.
      await tx.$queryRaw`SELECT id FROM wallets WHERE id = ${walletLookup.id} FOR UPDATE`;

      const buyerWallet = await tx.wallet.findUnique({ where: { id: walletLookup.id } });
      if (!buyerWallet) {
        throw new Error(`Buyer wallet not found after lock: ${order.buyerId}`);
      }

      const refundTxSerial = await this.walletTxSerialService.getNext();

      const refunded = await tx.wallet.updateMany({
        where: {
          id: buyerWallet.id,
          version: buyerWallet.version,
          escrowBalance: { gte: order.buyerPayAmount },
        },
        data: {
          escrowBalance: { decrement: order.buyerPayAmount },
          availableBalance: { increment: order.buyerPayAmount },
          version: { increment: 1 },
        },
      });
      if (refunded.count === 0) {
        throw new Error(`OCC conflict on buyer wallet for abandoned refund ${order.orderId}`);
      }

      const refundTxId = generateWalletTxId(refundTxSerial);
      await tx.walletTransaction.create({
        data: {
          txId: refundTxId,
          walletId: buyerWallet.id,
          type: WalletTransactionType.ORDER_REFUND,
          status: WalletTransactionStatus.SUCCESS,
          amount: order.buyerPayAmount,
          balanceBefore: buyerWallet.availableBalance,
          balanceAfter: buyerWallet.availableBalance + order.buyerPayAmount,
          orderId: order.id,
          description: `Auto-refund for seller-abandoned order ${order.orderId} (no delivery proof)`,
        },
      });
    } else {
      // No-wallet mode: buat baris durable untuk DANA refund — pola SYS-B-205
      // dari adminCancelOrder. Sweep dana-refund-retry akan mengeksekusi.
      const danaPayment = await tx.paymentTransaction.findFirst({
        where: { orderId: order.id, provider: 'DANA', status: 'SUCCESS' },
        select: { id: true },
      });
      if (danaPayment) {
        const attemptKey = `ORDER:${order.id}:ABANDONED`;
        await tx.danaRefundAttempt.create({
          data: {
            idempotencyKey: attemptKey,
            paymentTransactionId: danaPayment.id,
            amountSen: order.buyerPayAmount,
            partnerRefundNo: deriveDanaRefundNo(attemptKey),
            reason: 'Seller-abandoned: no delivery proof after 2x review window',
            status: 'PENDING',
          },
        });
      }
      // Jika tidak ada DANA payment record, order tetap CANCELLED;
      // tidak ada dana yang perlu di-refund via DANA (edge case tercatat di log).
      this.logger.warn(
        `Abandoned order ${order.orderId} cancelled in no-wallet mode` +
          (danaPayment ? ' — DANA refund queued.' : ' — no DANA payment found, nothing to refund via DANA.'),
      );
    }

    this.logger.log(
      `Seller-abandoned order ${order.orderId} auto-cancelled + refunded to buyer`,
    );
    return { abandonedRefunded: true };
  }

  private async withSerializableRetry<T>(operation: () => Promise<T>, label: string): Promise<T> {
    const maxRetries = 3;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        return await operation();
      } catch (error: unknown) {
        const retryable =
          error instanceof Prisma.PrismaClientKnownRequestError
            ? error.code === 'P2034'
            : error instanceof Prisma.PrismaClientUnknownRequestError &&
              /40001|40p01|serialization|deadlock/i.test(error.message);
        if (!retryable || attempt === maxRetries) throw error;
        this.logger.warn(`${label}_RETRY attempt=${attempt}/${maxRetries}`);
        await new Promise(resolve =>
          setTimeout(resolve, 100 * Math.pow(2, attempt - 1) + randomInt(0, 50)),
        );
      }
    }
    throw new Error(`${label} exhausted retry loop`);
  }
}
