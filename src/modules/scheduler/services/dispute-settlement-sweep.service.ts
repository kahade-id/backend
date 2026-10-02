import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { randomUUID } from 'crypto';
import { PrismaService } from '../../../prisma/prisma.service';
import { RedisService } from '../../../redis/redis.service';
import { cronJitter } from '../../../common/utils/cron-jitter.util';
import { alertMoneyCronSkippedRedisDown, ensureRedisAvailable } from '../../../common/utils/redis-health.util';
import { DisputeDanaSettlementService } from '../../no-wallet/dispute-dana-settlement.service';

/** Batas percobaan settlement per intent sebelum diserahkan ke review manual. */
const MAX_SETTLEMENT_ATTEMPTS = 10;

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
    } finally {
      await this.redis.del(lockKey).catch(() => undefined);
    }
  }
}
