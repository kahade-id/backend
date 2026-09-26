import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import { randomUUID } from 'crypto';
import { PaymentStatus, PaymentPurpose, OrderStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { RedisService } from '../../../redis/redis.service';
import { cronJitter } from '../../../common/utils/cron-jitter.util';
import { alertMoneyCronSkippedRedisDown, ensureRedisAvailable } from '../../../common/utils/redis-health.util';
import { MidtransService } from '../../payment/midtrans.service';
import { OrderQrisPaymentService } from '../../payment/order-qris-payment.service';

/**
 * WF-022: sweep rekonsiliasi refund QRIS.
 *
 * Pelepasan escrow saat refund (`OrderQrisPaymentService.handleRefund`)
 * 100% bergantung pada webhook provider. Jika webhook refund tidak pernah
 * tiba (hilang/timeout), dana menggantung di escrow tanpa batas.
 *
 * Cron ini mencari payment ORDER_ESCROW yang klaim refund-nya
 * (`refundRequestedAt`) sudah lebih tua dari ambang batas dan statusnya
 * belum REFUNDED, lalu menanyakan status aktual ke Midtrans:
 * - provider menyatakan `refund` → panggil handleRefund() (idempoten:
 *   melepaskan escrow + menulis ledger ORDER_REFUND dalam $transaction).
 * - masih pending → alert log untuk review manual.
 *
 * Tidak pernah melepaskan escrow tanpa konfirmasi provider.
 */
@Injectable()
export class RefundReconciliationService {
  private readonly logger = new Logger(RefundReconciliationService.name);
  private readonly claimAgeHours: number;
  private readonly batchSize: number;

  constructor(
    private prisma: PrismaService,
    private redis: RedisService,
    private configService: ConfigService,
    private midtransService: MidtransService,
    private orderQrisPaymentService: OrderQrisPaymentService,
  ) {
    this.claimAgeHours = Math.max(
      1,
      this.configService.get<number>('app.refundReconciliationClaimAgeHours') ?? 24,
    );
    this.batchSize = Math.max(
      1,
      this.configService.get<number>('app.refundReconciliationBatchSize') ?? 50,
    );
  }

  // WF-022: jalan tiap jam di menit ke-35 (hindari tabrakan dengan cleanup lain).
  @Cron('35 * * * *', { name: 'refund-reconciliation' })
  async reconcileStaleRefunds(): Promise<void> {
    await cronJitter(20_000);
    if (!(await ensureRedisAvailable(this.redis, 'refund-reconciliation', {
        // CW-014: job kritis-uang — skip karena Redis down harus termonitor,
        // bukan senyap.
        onRedisDown: () => alertMoneyCronSkippedRedisDown('refund-reconciliation'),
      }))) return;

    const lockKey = 'cron_lock:refund_reconciliation';
    const lockTtl = 600;
    const lockToken = randomUUID();
    const acquired = await this.redis.setNx(lockKey, lockToken, lockTtl);
    if (!acquired) return;

    try {
      const cutoff = new Date(Date.now() - this.claimAgeHours * 3_600_000);
      const stale = await this.prisma.paymentTransaction.findMany({
        where: {
          purpose: PaymentPurpose.ORDER_ESCROW,
          status: { not: PaymentStatus.REFUNDED },
          refundRequestedAt: { not: null, lt: cutoff },
          // Review 1E: hanya order CANCELLED yang relevan — payment dari jalur
          // settlement-race (order EXPIRED, escrow tak pernah dikunci) tidak
          // perlu memicu REFUND_STALE_ALERT tiap jam.
          order: { status: OrderStatus.CANCELLED },
        },
        orderBy: { refundRequestedAt: 'asc' },
        take: this.batchSize,
        select: {
          id: true,
          midtransOrderId: true,
          status: true,
          refundRequestedAt: true,
          refundReference: true,
          orderId: true,
        },
      });

      if (stale.length === 0) return;

      this.logger.log(
        `Refund reconciliation: ${stale.length} klaim refund melewati ambang ${this.claimAgeHours} jam`,
      );

      for (const payment of stale) {
        try {
          const providerStatus = await this.midtransService.getTransactionStatus(
            payment.midtransOrderId,
          );
          const txStatus = String(providerStatus?.transaction_status ?? '').toLowerCase();
          if (txStatus === 'refund') {
            // Provider mengonfirmasi refund → lepaskan escrow + ledger
            // (handleRefund idempoten; aman bila webhook tiba belakangan).
            await this.orderQrisPaymentService.handleRefund(
              payment.midtransOrderId,
              payment.refundReference ?? `RFD-${payment.id}`,
            );
            this.logger.log(
              `Refund reconciliation: escrow dilepas untuk ${payment.midtransOrderId} ` +
              `(klaim sejak ${payment.refundRequestedAt?.toISOString()})`,
            );
          } else {
            this.logger.warn(
              `REFUND_STALE_ALERT: klaim refund ${payment.midtransOrderId} ` +
              `(order ${payment.orderId ?? '-'}) berumur > ${this.claimAgeHours} jam, ` +
              `status provider=${txStatus || 'unknown'} — perlu review manual`,
            );
          }
        } catch (err) {
          this.logger.error(
            `Refund reconciliation gagal untuk ${payment.midtransOrderId}: ` +
            (err instanceof Error ? err.message : String(err)),
          );
        }
      }
    } finally {
      await this.redis.releaseLock(lockKey, lockToken).catch(() => undefined);
    }
  }

  /*
   * Batch 1-money (WF-022, lengkapan): kasus di mana request refund TIDAK PERNAH
   * berhasil dibuat — `requestRefundForOrder` di admin-cancel bersifat fire-and-forget
   * (catch → log), dan `requestRefund` melepaskan klaim (`refundRequestedAt = NULL`)
   * saat provider call gagal. Sweep `reconcileStaleRefunds` di atas mensyaratkan
   * `refundRequestedAt NOT NULL`, sehingga payment ini tidak pernah tersentuh.
   *
   * Cari payment ORDER_ESCROW / SUCCESS untuk order CANCELLED dengan klaim NULL
   * (atau klaim basi < 1 jam yang belum masuk ambang sweep utama), lalu coba request
   * ulang. Klaim atomik di `requestRefund` (updateMany where refundRequestedAt: null)
   * membuat retry ini aman dari duplikasi — satu pemenang, sisanya no-op.
   * Dibatasi payment ≤ 7 hari untuk mencegah retry abadi atas kegagalan permanen.
   */
  @Cron('45 * * * *', { name: 'refund-request-retry' })
  async retryUnclaimedRefunds(): Promise<void> {
    await cronJitter(20_000);
    if (!(await ensureRedisAvailable(this.redis, 'refund-request-retry', {
        // CW-014: job kritis-uang — skip karena Redis down harus termonitor,
        // bukan senyap.
        onRedisDown: () => alertMoneyCronSkippedRedisDown('refund-request-retry'),
      }))) return;

    const lockKey = 'cron_lock:refund_request_retry';
    const lockToken = randomUUID();
    const acquired = await this.redis.setNx(lockKey, lockToken, 600);
    if (!acquired) return;

    try {
      const now = Date.now();
      const maxAgeCutoff = new Date(now - 7 * 24 * 3_600_000);
      const unclaimed = await this.prisma.paymentTransaction.findMany({
        where: {
          purpose: PaymentPurpose.ORDER_ESCROW,
          status: PaymentStatus.SUCCESS,
          refundRequestedAt: null,
          paidAt: { gte: maxAgeCutoff },
          order: { status: OrderStatus.CANCELLED, deletedAt: null },
        },
        orderBy: { paidAt: 'asc' },
        take: this.batchSize,
        select: { id: true, midtransOrderId: true, order: { select: { orderId: true } } },
      });

      if (unclaimed.length === 0) return;
      this.logger.log(`Refund request retry: ${unclaimed.length} payment tanpa klaim refund — mencoba ulang.`);

      for (const payment of unclaimed) {
        if (!payment.order) continue;
        try {
          await this.orderQrisPaymentService.requestRefundForOrder(
            payment.order.orderId,
            'Rekonsiliasi refund otomatis: percobaan ulang untuk order yang dibatalkan admin',
          );
          this.logger.log(
            `Refund request retry: refund diminta untuk ${payment.midtransOrderId} (order ${payment.order.orderId})`,
          );
        } catch (err) {
          this.logger.warn(
            `Refund request retry gagal untuk ${payment.midtransOrderId}: ` +
            (err instanceof Error ? err.message : String(err)),
          );
        }
      }
    } finally {
      await this.redis.releaseLock(lockKey, lockToken).catch(() => undefined);
    }
  }
}
