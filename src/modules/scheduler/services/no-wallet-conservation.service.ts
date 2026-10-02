import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import { randomUUID } from 'crypto';
import { PaymentProvider, PaymentPurpose, PaymentStatus } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { RedisService } from '../../../redis/redis.service';
import { cronJitter } from '../../../common/utils/cron-jitter.util';
import { alertMoneyCronSkippedRedisDown, ensureRedisAvailable } from '../../../common/utils/redis-health.util';
import { toIdr } from '../../../common/utils/currency.util';
import { alertAdminsOnMoneyAnomaly } from '../common/money-alert.util';

/**
 * SYS-B-101 (audit sistemik ronde 3): invariant konservasi uang untuk jalur
 * no-wallet (DANA-direct) — jalur uang yang LIVE.
 *
 * Seluruh mesin rekonsiliasi otomatis sebelumnya hanya memverifikasi jalur
 * wallet (yang justru nonaktif). Cron ini memeriksa `masuk = keluar + ditahan`
 * untuk pot escrow DANA-direct, dengan `PaymentTransaction` sebagai buku kas:
 *
 *   INFLOW   = Σ grossAmount payment DANA/ORDER_ESCROW/SUCCESS(+REFUNDED)
 *   RESIDUAL = INFLOW − DISBURSED(SUCCESS) − REFUNDED − DANA_FEE − INFLIGHT
 *   EXPECTED = Σ per-order (inflow − refunded − fee − disbursed − inflight)
 *              − payout non-order (REFERRAL/CASHBACK/dsb, didanai dari fee
 *                platform yang tertahan)
 *
 * diff = RESIDUAL − EXPECTED harus ≈ 0. Selisih di luar toleransi →
 * adminAuditLog + Redis alert key + log error.
 *
 * Semantik nominal (sen, BigInt):
 * - grossAmount = escrowAmount + paymentFee (lih. dana-direct-payment
 *   initiate(): `grossAmount = escrowAmount + providerFee`).
 * - Per-order expected_held mencakup SEMUA scope disbursement yang terikat
 *   orderId (ORDER_ESCROW, MILESTONE, DISPUTE_RELEASE) karena inflow
 *   payment ORDER_ESCROW mendanai seluruh order, bukan hanya satu tahap.
 * - Payout non-order (orderId NULL — REFERRAL, CASHBACK, LEGACY_WALLET_PAYOUT)
 *   didanai dari fee platform yang tertahan di saldo merchant, sehingga
 *   dikurangkan dari EXPECTED (bukan dari RESIDUAL — ia sudah mengurangi
 *   RESIDUAL via DISBURSED).
 */
@Injectable()
export class NoWalletConservationService {
  private readonly logger = new Logger(NoWalletConservationService.name);
  /** Toleransi selisih (sen). Default Rp1.000 — noise pembulatan sen↔rupiah. */
  private readonly toleranceSen: bigint;

  constructor(
    private prisma: PrismaService,
    private redis: RedisService,
    private configService: ConfigService,
  ) {
    const configured = this.configService.get<number>('app.noWalletConservationToleranceSen');
    const parsed = Math.trunc(Number(configured));
    this.toleranceSen = BigInt(Number.isFinite(parsed) && parsed > 0 ? parsed : 100_000);
  }

  // Jalan harian 04:30 WIB — setelah daily-reconciliation (03:30), data-cleanup
  // (03:00), showcase-hard-delete (03:45); job berat DB dipisah bebannya.
  @Cron('30 4 * * *', { name: 'no-wallet-conservation', timeZone: 'Asia/Jakarta' })
  async runNoWalletConservation(): Promise<void> {
    await cronJitter(20_000);
    if (!(await ensureRedisAvailable(this.redis, 'no-wallet-conservation', {
        onRedisDown: () => alertMoneyCronSkippedRedisDown('no-wallet-conservation'),
      }))) return;

    const lockKey = 'cron_lock:no_wallet_conservation';
    const lockToken = randomUUID();
    if (!(await this.redis.setNx(lockKey, lockToken, 1800))) {
      this.logger.log('no-wallet-conservation skipped — another instance already executing.');
      return;
    }

    const startedAt = Date.now();
    try {
      const r = await this.checkConservation();
      const durationMs = Date.now() - startedAt;

      await this.redis
        .setex(
          'cron_heartbeat:no_wallet_conservation',
          86400,
          JSON.stringify({
            ranAt: new Date().toISOString(),
            durationMs,
            inflowSen: r.inflow.toString(),
            residualSen: r.residual.toString(),
            expectedSen: r.expected.toString(),
            diffSen: r.diff.toString(),
            clean: r.clean,
            orderCount: r.orderCount,
          }),
        )
        .catch(() => undefined);

      // Simpan deret residual untuk pemantauan tren (7 hari).
      await this.redis
        .setex('conservation:residual_sen', 7 * 86400, r.residual.toString())
        .catch(() => undefined);

      if (!r.clean) {
        await alertAdminsOnMoneyAnomaly({
          prisma: this.prisma,
          redis: this.redis,
          logger: this.logger,
          title: `No-Wallet Conservation MISMATCH: selisih ${toIdr(r.diff)}`,
          body:
            `Invariant konservasi escrow DANA-direct rusak: inflow=${toIdr(r.inflow)} ` +
            `residual=${toIdr(r.residual)} expected=${toIdr(r.expected)} ` +
            `diff=${toIdr(r.diff)} (toleransi=${toIdr(this.toleranceSen)}), ` +
            `${r.orderCount} order diagregat. ` +
            (r.worstOrders.length > 0
              ? `Order paling janggal: ${r.worstOrders.map(w => `${w.orderId}(exp=${toIdr(w.expectedHeld)})`).join(', ')}. `
              : '') +
            `Kemungkinan: disbursement tercatat SUCCESS tapi transfer tak terkirim, ` +
            `over-refund konkuren (SEC-103), atau refund tak tercatat. Investigasi segera.`,
          targetType: 'Reconciliation',
          targetId: 'no-wallet-conservation',
          redisAlertKey: 'no_wallet_conservation_mismatch',
        });
      } else {
        this.logger.log(
          `no-wallet-conservation bersih: inflow=${toIdr(r.inflow)} residual=${toIdr(r.residual)} ` +
            `expected=${toIdr(r.expected)} diff=${toIdr(r.diff)} (${r.orderCount} order, ${durationMs}ms)`,
        );
        await this.redis.del('cron_alert:no_wallet_conservation_mismatch').catch(() => undefined);
      }
    } catch (error) {
      this.logger.error(
        `no-wallet-conservation gagal: ${error instanceof Error ? error.message : String(error)}`,
        error instanceof Error ? error.stack : undefined,
      );
    } finally {
      await this.redis.releaseLock(lockKey, lockToken).catch(() => undefined);
    }
  }

  async checkConservation(): Promise<{
    inflow: bigint;
    residual: bigint;
    expected: bigint;
    diff: bigint;
    clean: boolean;
    orderCount: number;
    worstOrders: Array<{ orderId: string; expectedHeld: bigint }>;
  }> {
    const paymentWhere = {
      provider: PaymentProvider.DANA,
      purpose: PaymentPurpose.ORDER_ESCROW,
      status: { in: [PaymentStatus.SUCCESS, PaymentStatus.REFUNDED] },
    };

    const [payGroups, disbGroups, nullOrderPay] = await Promise.all([
      this.prisma.paymentTransaction.groupBy({
        by: ['orderId'],
        where: { ...paymentWhere, orderId: { not: null } },
        _sum: { grossAmount: true, refundedAmount: true, paymentFee: true },
        _count: { _all: true },
      }),
      this.prisma.escrowDisbursement.groupBy({
        by: ['orderId', 'status'],
        _sum: { amountSen: true },
      }),
      this.prisma.paymentTransaction.aggregate({
        where: { ...paymentWhere, orderId: null },
        _sum: { grossAmount: true },
        _count: { _all: true },
      }),
    ]);

    const nullOrderCount = nullOrderPay._count._all ?? 0;
    if (nullOrderCount > 0) {
      // Anomali data: payment ORDER_ESCROW tanpa order — laporkan terpisah,
      // jangan cemari agregat (uangnya masuk tapi tak bisa dipertanggungjawabkan).
      this.logger.error(
        `no-wallet-conservation: ${nullOrderCount} payment DANA ORDER_ESCROW tanpa orderId ` +
          `(gross=${toIdr(nullOrderPay._sum.grossAmount ?? BigInt(0))}) — anomali data`,
      );
    }

    const SUCCESS = 'SUCCESS';
    const INFLIGHT = new Set(['PENDING', 'PROCESSING', 'HELD_NO_BANK', 'NEEDS_REVIEW']);

    let inflow = BigInt(0);
    let refunded = BigInt(0);
    let danaFee = BigInt(0);
    const perOrder = new Map<string, { inflow: bigint; refunded: bigint; fee: bigint; disbursed: bigint; inflight: bigint }>();
    for (const g of payGroups) {
      const orderId = g.orderId as string;
      const gi = g._sum.grossAmount ?? BigInt(0);
      const gr = g._sum.refundedAmount ?? BigInt(0);
      const gf = g._sum.paymentFee ?? BigInt(0);
      inflow += gi;
      refunded += gr;
      danaFee += gf;
      perOrder.set(orderId, { inflow: gi, refunded: gr, fee: gf, disbursed: BigInt(0), inflight: BigInt(0) });
    }

    let disbursedAll = BigInt(0);
    let inflightAll = BigInt(0);
    let nonOrderOutflow = BigInt(0); // payout non-order (SUCCESS + INFLIGHT, orderId NULL)
    for (const g of disbGroups) {
      const amt = g._sum.amountSen ?? BigInt(0);
      const status = g.status as string;
      if (status === SUCCESS) disbursedAll += amt;
      else if (INFLIGHT.has(status)) inflightAll += amt;
      // FAILED/CANCELLED: uang tak pernah keluar — bukan outflow.
      if (g.orderId) {
        const entry = perOrder.get(g.orderId as string);
        if (entry) {
          if (status === SUCCESS) entry.disbursed += amt;
          else if (INFLIGHT.has(status)) entry.inflight += amt;
        }
        // Disbursement terikat order TANPA payment DANA di agregat (mis. order
        // wallet-mode lama / data anomali): tidak mengurangi expected — ia
        // mengurangi RESIDUAL via disbursedAll, sehingga muncul sebagai diff
        // negatif dan ter-alert. Itu disengaja (fail-closed: anomali terlihat).
      } else {
        if (status === SUCCESS || INFLIGHT.has(status)) nonOrderOutflow += amt;
      }
    }

    const residual = inflow - disbursedAll - refunded - danaFee - inflightAll;

    let expected = BigInt(0);
    const negatives: Array<{ orderId: string; expectedHeld: bigint }> = [];
    for (const [orderId, e] of perOrder) {
      const held = e.inflow - e.refunded - e.fee - e.disbursed - e.inflight;
      expected += held;
      if (held < BigInt(0)) negatives.push({ orderId, expectedHeld: held });
    }
    expected -= nonOrderOutflow;

    const diff = residual - expected;
    const clean = diff >= -this.toleranceSen && diff <= this.toleranceSen;

    // Order dengan expected_held negatif = uang keluar > uang masuk untuk
    // order itu (kandidat over-refund / disbursement ganda) — sorot.
    negatives.sort((a, b) => (a.expectedHeld < b.expectedHeld ? -1 : 1));
    const worstOrders = negatives.slice(0, 10);
    for (const w of worstOrders) {
      this.logger.warn(
        `no-wallet-conservation: order ${w.orderId} expected_held NEGATIF ${toIdr(w.expectedHeld)} — outflow melebihi inflow`,
      );
    }

    return { inflow, residual, expected, diff, clean, orderCount: perOrder.size, worstOrders };
  }
}
