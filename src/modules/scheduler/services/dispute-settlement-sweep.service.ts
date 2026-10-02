import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { randomUUID } from 'crypto';
import { PrismaService } from '../../../prisma/prisma.service';
import { RedisService } from '../../../redis/redis.service';
import { cronJitter } from '../../../common/utils/cron-jitter.util';
import { alertMoneyCronSkippedRedisDown, ensureRedisAvailable } from '../../../common/utils/redis-health.util';
import { safeErrorMessage } from '../../../common/utils/background-reliability.util';
import { toIdr } from '../../../common/utils/currency.util';
import { alertAdminsOnMoneyAnomaly } from '../common/money-alert.util';
import { DisputeDanaSettlementService } from '../../no-wallet/dispute-dana-settlement.service';

/** Batas percobaan settlement per intent sebelum diserahkan ke review manual. */
const MAX_SETTLEMENT_ATTEMPTS = 10;

/** CLAIMED lebih tua dari ini dianggap yatim (crash antara klaim dan DONE/FAILED). */
const STALE_CLAIMED_MS = 30 * 60 * 1000;

/**
 * SEC-104 (audit 2026-10-03): sweep intent settlement sengketa no-wallet.
 *
 * `dispute_settlement_intents` dibuat DI DALAM tx putusan (mutual-resolution /
 * resolve admin) dengan status PENDING. Bila eksekusi finansial post-commit
 * gagal (atau proses mati sebelum intent sempat diklaim), baris durable ini
 * yang dikejar cron — bukan `.catch` yang menelan error jadi null.
 *
 * - Ambil intent PENDING/FAILED dengan attemptCount < 10, paling lama
 *   di-update dulu.
 * - Idempoten via klaim atomik PENDING/FAILED → CLAIMED di
 *   DisputeDanaSettlementService.claimAndSettleIntent — hanya satu eksekutor
 *   menang; DONE bila sukses, FAILED + lastError bila gagal (lalu retry jam
 *   berikutnya sampai batas).
 * - Intent tanpa dispute/decision yang bisa dibaca → dilewati dengan log
 *   error (butuh review manual), tidak di-retry membabi-buta.
 */
@Injectable()
export class DisputeSettlementSweepService {
  private readonly logger = new Logger(DisputeSettlementSweepService.name);

  constructor(
    private prisma: PrismaService,
    private redis: RedisService,
    private disputeDanaSettlement: DisputeDanaSettlementService,
  ) {}

  // Jalan tiap jam di menit ke-25 (hindari tabrakan: auto-complete :00,
  // refund-reconciliation :35, dana-refund-retry :50).
  @Cron('25 * * * *', { name: 'dispute-settlement-sweep' })
  async sweepStaleSettlementIntents(): Promise<void> {
    await cronJitter(20_000);
    if (!(await ensureRedisAvailable(this.redis, 'dispute-settlement-sweep', {
        // Job kritis-uang — skip karena Redis down harus termonitor, bukan senyap.
        onRedisDown: () => alertMoneyCronSkippedRedisDown('dispute-settlement-sweep'),
      }))) return;

    const lockKey = 'cron_lock:dispute_settlement_sweep';
    const lockTtl = 600;
    const lockToken = randomUUID();
    const acquired = await this.redis.setNx(lockKey, lockToken, lockTtl);
    if (!acquired) return;

    try {
      const intents = await this.prisma.disputeSettlementIntent.findMany({
        where: {
          status: { in: ['PENDING', 'FAILED'] },
          attemptCount: { lt: MAX_SETTLEMENT_ATTEMPTS },
        },
        include: {
          dispute: {
            select: {
              id: true,
              orderId: true,
              decision: { select: { decisionType: true } },
            },
          },
        },
        orderBy: { updatedAt: 'asc' },
        take: 50,
      });

      let done = 0;
      let failed = 0;
      let skipped = 0;
      for (const intent of intents) {
        const decisionType = intent.dispute?.decision?.decisionType;
        if (!intent.dispute || !decisionType) {
          this.logger.error(
            `dispute-settlement-sweep: intent ${intent.id} (dispute=${intent.disputeId}) tanpa dispute/decision — butuh review manual, dilewati`,
          );
          skipped++;
          continue;
        }
        try {
          const res = await this.disputeDanaSettlement.claimAndSettleIntent({
            disputeId: intent.disputeId,
            orderDbId: intent.dispute.orderId,
            decision: decisionType as 'FULL_BUYER' | 'FULL_SELLER' | 'SPLIT',
            buyerAmountSen: intent.buyerAmountSen,
            sellerAmountSen: intent.sellerAmountSen,
            reason: `Dispute settlement retry (cron) dispute=${intent.disputeId}`,
          });
          if (res) {
            done++;
          } else {
            // Kalah klaim dari eksekutor lain — bukan kegagalan.
            skipped++;
          }
        } catch (e) {
          failed++;
          this.logger.warn(
            `dispute-settlement-sweep: intent ${intent.id} gagal (attempt berikutnya jam depan): ${e instanceof Error ? e.message : String(e)}`,
          );
        }
      }
      if (intents.length > 0) {
        this.logger.log(
          `dispute-settlement-sweep: checked=${intents.length} done=${done} failed=${failed} skipped=${skipped}`,
        );
      }

      // SYS-B-302: pulihkan CLAIMED yang basi (crash antara klaim atomik dan
      // DONE/FAILED) → kembalikan ke PENDING agar diproses ulang.
      await this.recoverStaleClaimedIntents();
      // SYS-B-302: intent yang attempt-nya habis (>=10) selama ini di-skip
      // DIAM-DIAM — eskalasikan agar terlihat admin.
      await this.escalateExhaustedIntents();
    } finally {
      await this.redis.del(lockKey).catch(() => undefined);
    }
  }

  /**
   * SYS-B-302: CLAIMED basi (>30 mnt tanpa DONE/FAILED) → PENDING + alert.
   * Klaim ulang aman: claimAndSettleIntent memakai klaim atomik, dan
   * eksekusi finansial di bawahnya idempoten per dispute.
   */
  private async recoverStaleClaimedIntents(): Promise<void> {
    try {
      const staleBefore = new Date(Date.now() - STALE_CLAIMED_MS);
      const stale = await this.prisma.disputeSettlementIntent.findMany({
        where: { status: 'CLAIMED', updatedAt: { lt: staleBefore } },
        select: {
          id: true,
          disputeId: true,
          buyerAmountSen: true,
          sellerAmountSen: true,
          attemptCount: true,
          updatedAt: true,
        },
        orderBy: { updatedAt: 'asc' },
        take: 50,
      });

      let recovered = 0;
      for (const row of stale) {
        const reset = await this.prisma.disputeSettlementIntent.updateMany({
          where: { id: row.id, status: 'CLAIMED' },
          data: { status: 'PENDING', lastError: 'SYS-B-302: CLAIMED basi >30 mnt — dikembalikan ke PENDING' },
        });
        if (reset.count === 0) continue;
        recovered++;
        this.logger.error(
          `STALE_SETTLEMENT_CLAIM dipulihkan: intent=${row.id} dispute=${row.disputeId} ` +
            `macet CLAIMED sejak ${row.updatedAt.toISOString()} → PENDING`,
        );
        await alertAdminsOnMoneyAnomaly({
          prisma: this.prisma,
          redis: this.redis,
          logger: this.logger,
          title: `Stale settlement claim dipulihkan: dispute ${row.disputeId}`,
          body:
            `disputeSettlementIntent ${row.id} macet di CLAIMED sejak ${row.updatedAt.toISOString()} ` +
            `(kemungkinan crash antara klaim dan DONE/FAILED) → dikembalikan ke PENDING. ` +
            `buyer=${toIdr(row.buyerAmountSen)} seller=${toIdr(row.sellerAmountSen)} ` +
            `attempt=${row.attemptCount}. Pantau hingga DONE.`,
          targetType: 'DisputeSettlementIntent',
          targetId: row.id,
          redisAlertKey: 'stale_settlement_claim',
          dedupKey: `stale_settlement_claim_alerted:${row.id}`,
          dedupTtlSeconds: 86400,
        });
      }
      if (stale.length > 0) {
        this.logger.log(`dispute-settlement-sweep: stale CLAIMED=${stale.length} recovered=${recovered}`);
      }
    } catch (error) {
      this.logger.error(`recoverStaleClaimedIntents gagal: ${safeErrorMessage(error)}`);
    }
  }

  /**
   * SYS-B-302: intent PENDING/FAILED dengan attemptCount >= 10 → ESCALATED
   * + alert. Sebelumnya baris-baris ini di-skip diam-diam oleh sweep
   * (tak ada di antrean alert manapun) — putusan sengketa tak pernah
   * dieksekusi dan uang escrow menggantung tanpa batas.
   *
   * CATATAN dashboard: status ESCALATED didukung schema (dispute_
   * settlement_intents.status). Tindak lanjut: pastikan konsol admin
   * menampilkan filter/status ESCALATED agar antrean ini terlihat.
   */
  private async escalateExhaustedIntents(): Promise<void> {
    try {
      const exhausted = await this.prisma.disputeSettlementIntent.findMany({
        where: {
          status: { in: ['PENDING', 'FAILED'] },
          attemptCount: { gte: MAX_SETTLEMENT_ATTEMPTS },
        },
        select: {
          id: true,
          disputeId: true,
          buyerAmountSen: true,
          sellerAmountSen: true,
          attemptCount: true,
          lastError: true,
        },
        orderBy: { updatedAt: 'asc' },
        take: 50,
      });

      for (const row of exhausted) {
        const marked = await this.prisma.disputeSettlementIntent.updateMany({
          where: { id: row.id, status: { in: ['PENDING', 'FAILED'] } },
          data: { status: 'ESCALATED', lastError: `SYS-B-302: attempt habis (${row.attemptCount}x) — eskalasi manual` },
        });
        if (marked.count === 0) continue;
        this.logger.error(
          `SETTLEMENT_ESCALATED: intent=${row.id} dispute=${row.disputeId} ` +
            `attempt=${row.attemptCount} buyer=${toIdr(row.buyerAmountSen)} seller=${toIdr(row.sellerAmountSen)} ` +
            `lastError=${(row.lastError ?? '-').slice(0, 200)}`,
        );
        await alertAdminsOnMoneyAnomaly({
          prisma: this.prisma,
          redis: this.redis,
          logger: this.logger,
          title: `Settlement sengketa butuh intervensi manual: dispute ${row.disputeId}`,
          body:
            `disputeSettlementIntent ${row.id} gagal ${row.attemptCount}x → ESCALATED. ` +
            `Putusan sengketa BELUM dieksekusi: buyer=${toIdr(row.buyerAmountSen)} ` +
            `seller=${toIdr(row.sellerAmountSen)}. ` +
            `Error terakhir: ${(row.lastError ?? '-').slice(0, 300)}. ` +
            `Tindaklanjuti manual via jalur admin (retry/keputusan ulang) — jangan biarkan escrow menggantung.`,
          targetType: 'DisputeSettlementIntent',
          targetId: row.id,
          redisAlertKey: 'settlement_escalated',
          dedupKey: `settlement_escalated_alerted:${row.id}`,
          dedupTtlSeconds: 7 * 86400,
        });
      }
      if (exhausted.length > 0) {
        this.logger.log(`dispute-settlement-sweep: escalated=${exhausted.length}`);
      }
    } catch (error) {
      this.logger.error(`escalateExhaustedIntents gagal: ${safeErrorMessage(error)}`);
    }
  }
}
